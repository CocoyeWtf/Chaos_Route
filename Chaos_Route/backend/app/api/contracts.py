"""Routes Contrats (fusionné véhicule) / Contract API routes (merged with vehicle)."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.base_logistics import BaseLogistics
from app.models.contract import Contract, TrailerSupply
from app.models.contract_schedule import ContractSchedule
from app.models.user import User
from app.schemas.contract import (
    ContractCreate,
    ContractRead,
    ContractScheduleBase,
    ContractUpdate,
)
from app.api.deps import require_permission, get_user_region_ids

router = APIRouter()


@router.get("/", response_model=list[ContractRead])
async def list_contracts(
    region_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("contracts", "read")),
):
    query = select(Contract).options(selectinload(Contract.schedules), selectinload(Contract.carrier))
    if region_id is not None:
        query = query.where(Contract.region_id == region_id)
    user_region_ids = get_user_region_ids(user)
    if user_region_ids is not None:
        query = query.where(Contract.region_id.in_(user_region_ids))
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/available", response_model=list[ContractRead])
async def available_contracts(
    date: str = Query(...),
    base_id: int = Query(...),
    temperature_type: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("contracts", "read")),
):
    """Contrats disponibles pour une date et base / Available contracts for a date and base."""
    base = await db.get(BaseLogistics, base_id)
    if not base:
        raise HTTPException(status_code=404, detail="Base not found")

    query = (
        select(Contract)
        .options(selectinload(Contract.schedules), selectinload(Contract.carrier))
        .where(Contract.region_id == base.region_id)
    )

    query = query.where(
        (Contract.start_date.is_(None)) | (Contract.start_date <= date)
    ).where(
        (Contract.end_date.is_(None)) | (Contract.end_date >= date)
    )

    if temperature_type:
        from app.models.contract import TemperatureType
        compatible = {temperature_type}
        compatible.add("BI_TEMP")
        compatible.add("TRI_TEMP")
        query = query.where(
            (Contract.temperature_type.is_(None))
            | (Contract.temperature_type.in_([TemperatureType(t) for t in compatible if t in TemperatureType.__members__]))
        )

    result = await db.execute(query)
    contracts = result.scalars().all()

    available = []
    for c in contracts:
        is_unavailable = any(
            s.date == date and not s.is_available for s in c.schedules
        )
        if not is_unavailable:
            available.append(c)

    return available


@router.get("/{contract_id}", response_model=ContractRead)
async def get_contract(
    contract_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("contracts", "read")),
):
    result = await db.execute(
        select(Contract).where(Contract.id == contract_id).options(selectinload(Contract.schedules), selectinload(Contract.carrier))
    )
    contract = result.scalar_one_or_none()
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")
    return contract


def _sync_provides_trailer(contract) -> None:
    """Garder l'ancien booléen cohérent avec trailer_supply (#41).

    `provides_trailer` reste lu par l'export/import et les clients non migrés :
    on le maintient aligné, BOTH comptant comme « amène sa remorque ». /
    Keep the legacy boolean aligned with trailer_supply; BOTH counts as
    "brings its own trailer" for legacy readers.
    """
    supply = contract.trailer_supply
    if supply is None:
        return
    contract.provides_trailer = supply is not TrailerSupply.CMRO


@router.post("/", response_model=ContractRead, status_code=201)
async def create_contract(
    data: ContractCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("contracts", "create")),
):
    schedules_data = data.schedules
    contract_data = data.model_dump(exclude={"schedules"})
    contract = Contract(**contract_data)
    _sync_provides_trailer(contract)
    db.add(contract)
    await db.flush()

    for s in schedules_data:
        schedule = ContractSchedule(contract_id=contract.id, **s.model_dump())
        db.add(schedule)

    await db.flush()
    result = await db.execute(
        select(Contract).where(Contract.id == contract.id).options(selectinload(Contract.schedules), selectinload(Contract.carrier))
    )
    return result.scalar_one()


@router.put("/{contract_id}", response_model=ContractRead)
async def update_contract(
    contract_id: int,
    data: ContractUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("contracts", "update")),
):
    result = await db.execute(
        select(Contract).where(Contract.id == contract_id).options(selectinload(Contract.schedules), selectinload(Contract.carrier))
    )
    contract = result.scalar_one_or_none()
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(contract, key, value)
    _sync_provides_trailer(contract)
    await db.flush()
    result = await db.execute(
        select(Contract).where(Contract.id == contract.id).options(selectinload(Contract.schedules), selectinload(Contract.carrier))
    )
    return result.scalar_one()


@router.put("/{contract_id}/schedule", response_model=ContractRead)
async def update_schedule(
    contract_id: int,
    schedules: list[ContractScheduleBase],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("contracts", "update")),
):
    """Mise à jour planning date-par-date / Update date-based schedule."""
    result = await db.execute(
        select(Contract).where(Contract.id == contract_id).options(selectinload(Contract.schedules), selectinload(Contract.carrier))
    )
    contract = result.scalar_one_or_none()
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")

    existing_by_date = {s.date: s for s in contract.schedules}

    for s in schedules:
        if s.is_available:
            if s.date in existing_by_date:
                await db.delete(existing_by_date[s.date])
        else:
            if s.date in existing_by_date:
                existing_by_date[s.date].is_available = False
            else:
                db.add(ContractSchedule(
                    contract_id=contract.id, date=s.date, is_available=False
                ))

    await db.flush()
    result = await db.execute(
        select(Contract).where(Contract.id == contract.id).options(selectinload(Contract.schedules), selectinload(Contract.carrier))
    )
    return result.scalar_one()


@router.delete("/{contract_id}", status_code=204)
async def delete_contract(
    contract_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("contracts", "delete")),
):
    contract = await db.get(Contract, contract_id)
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")
    await db.delete(contract)
