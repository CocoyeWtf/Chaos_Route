"""Routes Prix du gasoil / Fuel price API routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.fuel_price import FuelPrice
from app.models.user import User
from app.schemas.fuel_price import FuelPriceCreate, FuelPriceRead, FuelPriceUpdate
from app.api.deps import require_permission

router = APIRouter()


@router.get("/", response_model=list[FuelPriceRead])
async def list_fuel_prices(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("fuel-prices", "read")),
):
    """Lister les prix du gasoil triés par date début DESC / List fuel prices sorted by start_date DESC."""
    result = await db.execute(select(FuelPrice).order_by(FuelPrice.start_date.desc()))
    return result.scalars().all()


@router.post("/", response_model=FuelPriceRead, status_code=201)
async def create_fuel_price(
    data: FuelPriceCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("fuel-prices", "create")),
):
    """Créer un prix du gasoil / Create a fuel price entry."""
    entry = FuelPrice(**data.model_dump())
    db.add(entry)
    await db.flush()
    await db.refresh(entry)
    return entry


@router.put("/{entry_id}", response_model=FuelPriceRead)
async def update_fuel_price(
    entry_id: int,
    data: FuelPriceUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("fuel-prices", "update")),
):
    """Modifier un prix du gasoil / Update a fuel price entry."""
    entry = await db.get(FuelPrice, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Fuel price entry not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(entry, key, value)
    await db.flush()
    await db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=204)
async def delete_fuel_price(
    entry_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("fuel-prices", "delete")),
):
    """Supprimer un prix du gasoil / Delete a fuel price entry."""
    entry = await db.get(FuelPrice, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Fuel price entry not found")
    await db.delete(entry)
