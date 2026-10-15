"""Routes Distancier enrichi / Enriched distance matrix API routes."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.base_logistics import BaseLogistics
from app.models.distance_matrix import DistanceMatrix
from app.models.pdv import PDV
from app.models.user import User
from app.schemas.distance_matrix import DistanceMatrixCreate, DistanceMatrixRead, DistanceMatrixUpdate
from app.api.deps import require_permission

router = APIRouter()


async def _build_label_caches(db: AsyncSession) -> tuple[dict[int, str], dict[int, str]]:
    """Construire caches de labels / Build label caches for BASE and PDV."""
    base_result = await db.execute(select(BaseLogistics.id, BaseLogistics.code, BaseLogistics.name))
    base_labels = {row[0]: f"{row[1]} — {row[2]}" for row in base_result.all()}

    pdv_result = await db.execute(select(PDV.id, PDV.code, PDV.name))
    pdv_labels = {row[0]: f"{row[1]} — {row[2]}" for row in pdv_result.all()}

    return base_labels, pdv_labels


def _resolve_label(entry_type: str, entry_id: int, base_labels: dict, pdv_labels: dict) -> str | None:
    """Résoudre un label depuis le type et l'ID / Resolve a label from type and ID."""
    if entry_type == "BASE":
        return base_labels.get(entry_id)
    elif entry_type == "PDV":
        return pdv_labels.get(entry_id)
    return None


@router.get("/", response_model=list[DistanceMatrixRead])
async def list_distances(
    origin_type: str | None = None,
    origin_id: int | None = None,
    destination_type: str | None = None,
    destination_id: int | None = None,
    search: str | None = None,
    limit: int = Query(default=500, le=5000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("distances", "read")),
):
    query = select(DistanceMatrix)
    if origin_type is not None:
        query = query.where(DistanceMatrix.origin_type == origin_type)
    if origin_id is not None:
        query = query.where(DistanceMatrix.origin_id == origin_id)
    if destination_type is not None:
        query = query.where(DistanceMatrix.destination_type == destination_type)
    if destination_id is not None:
        query = query.where(DistanceMatrix.destination_id == destination_id)

    # Recherche par label (origin ou destination) / Search by label
    if search:
        base_labels, pdv_labels = await _build_label_caches(db)
        search_lower = search.lower()
        matching_ids: list[tuple[str, int]] = []
        for bid, label in base_labels.items():
            if search_lower in label.lower():
                matching_ids.append(("BASE", bid))
        for pid, label in pdv_labels.items():
            if search_lower in label.lower():
                matching_ids.append(("PDV", pid))
        if matching_ids:
            conditions = []
            for etype, eid in matching_ids:
                conditions.append(
                    (DistanceMatrix.origin_type == etype) & (DistanceMatrix.origin_id == eid)
                )
                conditions.append(
                    (DistanceMatrix.destination_type == etype) & (DistanceMatrix.destination_id == eid)
                )
            query = query.where(or_(*conditions))
        else:
            return []  # Pas de match / No match

    query = query.order_by(DistanceMatrix.id).offset(offset).limit(limit)
    result = await db.execute(query)
    entries = result.scalars().all()

    if not search:
        base_labels, pdv_labels = await _build_label_caches(db)
    enriched = []
    for e in entries:
        data = DistanceMatrixRead.model_validate(e)
        data.origin_label = _resolve_label(e.origin_type, e.origin_id, base_labels, pdv_labels)
        data.destination_label = _resolve_label(e.destination_type, e.destination_id, base_labels, pdv_labels)
        enriched.append(data)

    return enriched


@router.get("/count")
async def count_distances(
    origin_type: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("distances", "read")),
):
    """Nombre total d'entrees / Total count of entries."""
    from sqlalchemy import func
    query = select(func.count(DistanceMatrix.id))
    if origin_type is not None:
        query = query.where(DistanceMatrix.origin_type == origin_type)
    result = await db.execute(query)
    return {"count": result.scalar()}


@router.get("/lookup")
async def lookup_distance(
    origin_type: str,
    origin_id: int,
    destination_type: str,
    destination_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("distances", "read")),
):
    """Chercher la distance entre deux points / Look up distance between two points."""
    result = await db.execute(
        select(DistanceMatrix).where(
            DistanceMatrix.origin_type == origin_type,
            DistanceMatrix.origin_id == origin_id,
            DistanceMatrix.destination_type == destination_type,
            DistanceMatrix.destination_id == destination_id,
        )
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Distance entry not found")
    return entry


@router.post("/", response_model=DistanceMatrixRead, status_code=201)
async def create_distance(
    data: DistanceMatrixCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("distances", "create")),
):
    entry = DistanceMatrix(**data.model_dump())
    db.add(entry)
    await db.flush()
    await db.refresh(entry)
    return entry


@router.post("/bulk", response_model=list[DistanceMatrixRead], status_code=201)
async def create_distances_bulk(
    data: list[DistanceMatrixCreate],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("distances", "create")),
):
    """Import en masse du distancier / Bulk import distance matrix entries."""
    entries = []
    for item in data:
        entry = DistanceMatrix(**item.model_dump())
        db.add(entry)
        entries.append(entry)
    await db.flush()
    for entry in entries:
        await db.refresh(entry)
    return entries


@router.delete("/{entry_id}", status_code=204)
async def delete_distance(
    entry_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("distances", "delete")),
):
    entry = await db.get(DistanceMatrix, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Distance entry not found")
    await db.delete(entry)


# ─────────────────────────────────────────────────────────────────────────────
# Trous du distancier (#96)
#
# Gaetan : « les distanciers temps et km ne fonctionnent pas. Depart de
# Gosselies = 132 km pour 03h10 (OK). Par contre a Trazegnies = 0 km pour 46 min ».
# Le distancier n'a aucune ligne pour Trazegnies, Gosselies MEA ni Heppignies :
# seules Villers (164 PDV) et Gosselies SEC (158) sont couvertes. Et une paire
# absente vaut `None` dans `_get_distance`, donc 0 km et 0 minute dans le calcul
# — les 46 minutes vues par Gaetan ne sont que le temps de quai et de
# dechargement. Toute tournee partant d'une de ces trois bases sort donc avec un
# kilometrage, un carburant et une taxe km nuls.
#
# Deux facons de combler, dans cet ordre :
#  1. Une base jumelle aux MEMES coordonnees a deja la ligne — c'est le cas de
#     « 092 MEA », au meme endroit que « 092 Gosselies SEC ». On la recopie :
#     ce n'est pas une estimation, c'est le meme trajet.
#  2. Sinon, estimation routiere (vol d'oiseau x coefficient), marquee comme
#     telle pour etre remplacee sans hesiter des que la vraie valeur arrive.
# ─────────────────────────────────────────────────────────────────────────────

_VITESSE_MOYENNE_KMH = 50.0  # vitesse de rabattement pour estimer la duree


def _memes_coordonnees(a: BaseLogistics, b: BaseLogistics) -> bool:
    """Deux bases au meme endroit (a ~10 m pres) / Same place, within ~10 m."""
    if None in (a.latitude, a.longitude, b.latitude, b.longitude):
        return False
    return (abs(float(a.latitude) - float(b.latitude)) < 1e-4
            and abs(float(a.longitude) - float(b.longitude)) < 1e-4)


async def _etat_distancier(db: AsyncSession) -> list[dict]:
    """Couverture base par base / Per-base coverage of the matrix."""
    bases = (await db.execute(select(BaseLogistics).order_by(BaseLogistics.code))).scalars().all()
    nb_pdv = len((await db.execute(select(PDV.id))).scalars().all())
    entries = (await db.execute(
        select(DistanceMatrix).where(
            or_(DistanceMatrix.origin_type == "BASE", DistanceMatrix.destination_type == "BASE")
        )
    )).scalars().all()

    couverture: dict[int, set[int]] = {b.id: set() for b in bases}
    estimees: dict[int, int] = {b.id: 0 for b in bases}
    for e in entries:
        if e.origin_type == "BASE" and e.destination_type == "PDV" and e.origin_id in couverture:
            couverture[e.origin_id].add(e.destination_id)
            if e.is_estimated:
                estimees[e.origin_id] += 1
        elif e.destination_type == "BASE" and e.origin_type == "PDV" and e.destination_id in couverture:
            couverture[e.destination_id].add(e.origin_id)
            if e.is_estimated:
                estimees[e.destination_id] += 1

    return [
        {
            "base_id": b.id,
            "base_code": b.code,
            "base_name": b.name,
            "has_coordinates": b.latitude is not None and b.longitude is not None,
            "pdv_total": nb_pdv,
            "pdv_covered": len(couverture[b.id]),
            "pdv_missing": nb_pdv - len(couverture[b.id]),
            "estimated_rows": estimees[b.id],
        }
        for b in bases
    ]


@router.get("/coverage")
async def distance_coverage(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("distances", "read")),
):
    """Combien de points de vente chaque base sait-elle joindre ? (#96)

    Sans cet ecran, un trou de distancier ne se voit qu'au moment ou une tournee
    sort a 0 km — c'est-a-dire trop tard.
    """
    return await _etat_distancier(db)


@router.post("/fill-missing")
async def fill_missing_distances(
    base_id: int | None = Query(default=None, description="Limiter a une base"),
    dry_run: bool = Query(default=True, description="Simuler sans ecrire"),
    factor: float = Query(default=1.3, ge=1.0, le=2.0,
                          description="Coefficient vol d'oiseau vers route"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("distances", "create")),
):
    """Combler les paires base <-> PDV absentes du distancier (#96).

    `dry_run` par defaut : on annonce ce qui serait ecrit avant de l'ecrire. Les
    lignes existantes ne sont JAMAIS modifiees — on ne remplace pas une distance
    mesuree par une estimation.
    """
    from app.services.distance_service import DistanceService

    bases = (await db.execute(select(BaseLogistics).order_by(BaseLogistics.code))).scalars().all()
    if base_id is not None:
        bases = [b for b in bases if b.id == base_id]
        if not bases:
            raise HTTPException(status_code=404, detail="Base introuvable")

    pdvs = (await db.execute(select(PDV).order_by(PDV.code))).scalars().all()
    toutes_bases = (await db.execute(select(BaseLogistics))).scalars().all()

    entries = (await db.execute(
        select(DistanceMatrix).where(
            or_(DistanceMatrix.origin_type == "BASE", DistanceMatrix.destination_type == "BASE")
        )
    )).scalars().all()
    connues: dict[tuple[int, int], DistanceMatrix] = {}
    for e in entries:
        if e.origin_type == "BASE" and e.destination_type == "PDV":
            connues.setdefault((e.origin_id, e.destination_id), e)
        elif e.destination_type == "BASE" and e.origin_type == "PDV":
            connues.setdefault((e.destination_id, e.origin_id), e)

    copiees = 0
    estimees = 0
    impossibles: list[str] = []
    detail_par_base: dict[str, dict] = {}

    for base in bases:
        jumelles = [b for b in toutes_bases if b.id != base.id and _memes_coordonnees(base, b)]
        stats = {"copiees": 0, "estimees": 0, "impossibles": 0, "deja_connues": 0}

        for pdv in pdvs:
            if (base.id, pdv.id) in connues:
                stats["deja_connues"] += 1
                continue

            # 1. Base jumelle au meme endroit : on recopie la vraie valeur.
            source = None
            for jumelle in jumelles:
                source = connues.get((jumelle.id, pdv.id))
                if source is not None:
                    break

            if source is not None:
                ligne = DistanceMatrix(
                    origin_type="BASE", origin_id=base.id,
                    destination_type="PDV", destination_id=pdv.id,
                    distance_km=source.distance_km,
                    duration_minutes=source.duration_minutes,
                    is_estimated=source.is_estimated,
                )
                stats["copiees"] += 1
                copiees += 1
            else:
                # 2. Estimation routiere, a condition d'avoir les coordonnees.
                if None in (base.latitude, base.longitude, pdv.latitude, pdv.longitude):
                    stats["impossibles"] += 1
                    if len(impossibles) < 20:
                        impossibles.append(f"{base.code} / {pdv.code} (coordonnees manquantes)")
                    continue
                vol = DistanceService.haversine_km(
                    float(base.latitude), float(base.longitude),
                    float(pdv.latitude), float(pdv.longitude),
                )
                km = DistanceService.estimate_road_distance(vol, factor)
                ligne = DistanceMatrix(
                    origin_type="BASE", origin_id=base.id,
                    destination_type="PDV", destination_id=pdv.id,
                    distance_km=km,
                    duration_minutes=max(1, round(km / _VITESSE_MOYENNE_KMH * 60)),
                    is_estimated=True,
                )
                stats["estimees"] += 1
                estimees += 1

            if not dry_run:
                db.add(ligne)
            connues[(base.id, pdv.id)] = ligne

        detail_par_base[base.code] = stats

    if not dry_run:
        await db.flush()

    return {
        "dry_run": dry_run,
        "factor": factor,
        "copiees_depuis_base_jumelle": copiees,
        "estimees": estimees,
        "impossibles": len(impossibles),
        "exemples_impossibles": impossibles,
        "detail_par_base": detail_par_base,
    }
