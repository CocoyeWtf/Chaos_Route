"""Routes Volumes / Volume API routes."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.pdv import PDV
from app.models.volume import Volume
from app.models.user import User
from app.schemas.volume import VolumeCreate, VolumeRead, VolumeSplit, VolumeUpdate
from app.api.deps import require_permission, get_user_region_ids

router = APIRouter()


@router.get("/", response_model=list[VolumeRead])
async def list_volumes(
    pdv_id: int | None = None,
    region_id: int | None = None,
    date: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    dispatch_date: str | None = None,
    base_origin_id: int | None = None,
    limit: int = Query(default=500, le=5000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("volumes", "read")),
):
    """Lister les volumes, avec filtres optionnels / List volumes with optional filters."""
    query = select(Volume)
    if pdv_id is not None:
        query = query.where(Volume.pdv_id == pdv_id)
    if date is not None:
        query = query.where(Volume.date == date)
    if date_from is not None:
        query = query.where(Volume.date >= date_from)
    if date_to is not None:
        query = query.where(Volume.date <= date_to)
    # `date` et `dispatch_date` sont DEUX colonnes distinctes : `date` = date du
    # volume, `dispatch_date` = date de répartition, celle sur laquelle les vues
    # de planification travaillent. Sans ce filtre, le front chargeait tout
    # l'historique pour n'en garder qu'une journée (#27 suivi / #83 lenteur). /
    # `date` and `dispatch_date` are two distinct columns; planning views work on
    # dispatch_date. Without this filter the front loaded the whole history.
    if dispatch_date is not None:
        query = query.where(Volume.dispatch_date == dispatch_date)
    if base_origin_id is not None:
        query = query.where(Volume.base_origin_id == base_origin_id)
    # Scope région via PDV : filtre explicite (sélecteur UI) + périmètre régional de
    # l'utilisateur. DOIT rester cohérent avec l'endpoint /pdvs (qui honore region_id),
    # sinon le front charge des volumes dont le PDV n'est pas dans la liste filtrée ->
    # libellés de repli "PDV #<id>" et points absents de la carte. /
    # Region scope via PDV join — must mirror /pdvs (which honors region_id).
    user_region_ids = get_user_region_ids(user)
    if region_id is not None or user_region_ids is not None:
        query = query.join(PDV, Volume.pdv_id == PDV.id)
        if region_id is not None:
            query = query.where(PDV.region_id == region_id)
        if user_region_ids is not None:
            query = query.where(PDV.region_id.in_(user_region_ids))
    # Charger le PDV (eager) pour exposer pdv_code/pdv_name sans lazy-load /
    # Eager-load PDV so pdv_code/pdv_name resolve without lazy-load
    query = query.options(selectinload(Volume.pdv))
    query = query.order_by(Volume.id.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/{volume_id}", response_model=VolumeRead)
async def get_volume(
    volume_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("volumes", "read")),
):
    volume = await db.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    return volume


@router.post("/", response_model=VolumeRead, status_code=201)
async def create_volume(
    data: VolumeCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("volumes", "create")),
):
    volume = Volume(**data.model_dump())
    db.add(volume)
    await db.flush()
    await db.refresh(volume)
    return volume


@router.put("/{volume_id}", response_model=VolumeRead)
async def update_volume(
    volume_id: int,
    data: VolumeUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("volumes", "update")),
):
    volume = await db.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(volume, key, value)
    await db.flush()
    await db.refresh(volume)
    return volume


@router.post("/{volume_id}/split", response_model=list[VolumeRead])
async def split_volume(
    volume_id: int,
    data: VolumeSplit,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("volumes", "update")),
):
    """Scinder un volume en deux / Split a volume into two parts."""
    volume = await db.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    vol_eqp = float(volume.eqp_count)
    if data.eqp_count <= 0 or data.eqp_count >= vol_eqp:
        raise HTTPException(status_code=400, detail="eqp_count must be between 1 and volume.eqp_count - 1")

    remainder = vol_eqp - data.eqp_count
    original_weight = float(volume.weight_kg) if volume.weight_kg else 0
    original_colis = volume.nb_colis or 0
    ratio = data.eqp_count / vol_eqp

    # Groupe de split — tous les fragments partagent le même ID / Split group tracking
    group_id = volume.split_group_id or volume.id
    volume.split_group_id = group_id

    volume.eqp_count = data.eqp_count
    volume.weight_kg = round(original_weight * ratio, 2) if original_weight else None
    volume.nb_colis = round(original_colis * ratio) if original_colis else None

    new_vol = Volume(
        pdv_id=volume.pdv_id,
        date=volume.date,
        nb_colis=round(original_colis * (1 - ratio)) if original_colis else None,
        eqp_count=remainder,
        weight_kg=round(original_weight * (1 - ratio), 2) if original_weight else None,
        temperature_class=volume.temperature_class,
        base_origin_id=volume.base_origin_id,
        preparation_start=volume.preparation_start,
        preparation_end=volume.preparation_end,
        dispatch_date=volume.dispatch_date,
        dispatch_time=volume.dispatch_time,
        tour_id=None,
        split_group_id=group_id,
    )
    db.add(new_vol)
    await db.flush()
    await db.refresh(volume)
    await db.refresh(new_vol)
    return [volume, new_vol]


@router.delete("/bulk", status_code=204)
async def bulk_delete_volumes(
    ids: list[int] = Query(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("volumes", "delete")),
):
    """Suppression en masse de volumes / Bulk delete volumes by IDs."""
    if not ids:
        return
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(Volume).where(Volume.id.in_(ids), Volume.tour_id.is_(None)))


@router.delete("/{volume_id}", status_code=204)
async def delete_volume(
    volume_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("volumes", "delete")),
):
    volume = await db.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    await db.delete(volume)
