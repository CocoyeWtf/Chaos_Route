"""Routes Chauffeurs Base / Base Driver API routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.base_driver import BaseDriver, DriverStatus
from app.models.user import User
from app.schemas.base_driver import BaseDriverCreate, BaseDriverRead, BaseDriverUpdate
from app.api.deps import require_permission, require_any_permission

router = APIRouter()


@router.get("/", response_model=list[BaseDriverRead])
async def list_base_drivers(
    base_id: int | None = None,
    status: str | None = None,
    db: AsyncSession = Depends(get_db),
    # Le postier choisit un chauffeur base en changeant de moyen (#115). /
    # The postier picks a base driver when reassigning a tour.
    user: User = Depends(require_any_permission(("base-drivers", "read"), ("operations", "read"))),
):
    """Lister les chauffeurs base / List base drivers."""
    query = select(BaseDriver).order_by(BaseDriver.last_name, BaseDriver.first_name)
    if base_id is not None:
        query = query.where(BaseDriver.base_id == base_id)
    if status is not None:
        query = query.where(BaseDriver.status == DriverStatus(status))
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/{driver_id}", response_model=BaseDriverRead)
async def get_base_driver(
    driver_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("base-drivers", "read")),
):
    """Voir un chauffeur base / Get base driver detail."""
    driver = await db.get(BaseDriver, driver_id)
    if not driver:
        raise HTTPException(status_code=404, detail="Base driver not found")
    return driver


@router.post("/", response_model=BaseDriverRead, status_code=201)
async def create_base_driver(
    data: BaseDriverCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("base-drivers", "create")),
):
    """Creer un chauffeur base / Create base driver."""
    dump = data.model_dump()
    dump["status"] = DriverStatus(dump.get("status") or "ACTIVE")
    driver = BaseDriver(**dump)
    db.add(driver)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"Le code Infolog '{data.code_infolog}' existe déjà")
    await db.refresh(driver)
    return driver


@router.put("/{driver_id}", response_model=BaseDriverRead)
async def update_base_driver(
    driver_id: int,
    data: BaseDriverUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("base-drivers", "update")),
):
    """Modifier un chauffeur base / Update base driver."""
    driver = await db.get(BaseDriver, driver_id)
    if not driver:
        raise HTTPException(status_code=404, detail="Base driver not found")

    updates = data.model_dump(exclude_unset=True)
    if "status" in updates and updates["status"] is not None:
        updates["status"] = DriverStatus(updates["status"])

    for key, value in updates.items():
        setattr(driver, key, value)

    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"Le code Infolog '{data.code_infolog}' existe déjà")
    await db.refresh(driver)
    return driver


@router.delete("/{driver_id}", status_code=204)
async def delete_base_driver(
    driver_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("base-drivers", "delete")),
):
    """Supprimer un chauffeur base / Delete base driver."""
    driver = await db.get(BaseDriver, driver_id)
    if not driver:
        raise HTTPException(status_code=404, detail="Base driver not found")
    await db.delete(driver)
