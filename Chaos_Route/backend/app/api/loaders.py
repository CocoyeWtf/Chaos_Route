"""Routes Chargeurs / Loader API routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.loader import Loader
from app.models.user import User
from app.schemas.loader import LoaderCreate, LoaderRead, LoaderUpdate
from app.api.deps import require_permission

router = APIRouter()


@router.get("/", response_model=list[LoaderRead])
async def list_loaders(
    base_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loaders", "read")),
):
    """Liste des chargeurs, filtrable par base / List loaders, filterable by base."""
    query = select(Loader)
    if base_id is not None:
        # Le chargeur ressort sur sa base principale ET sur sa base secondaire
        # (#63) : sans cela, le rattachement double ne servirait à rien. /
        # A loader shows up under both of its bases.
        query = query.where(
            (Loader.base_id == base_id) | (Loader.secondary_base_id == base_id)
        )
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/by-code/{code}", response_model=LoaderRead)
async def get_loader_by_code(
    code: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loaders", "read")),
):
    """Lookup chargeur par code (auto-complétion) / Loader lookup by code (auto-complete)."""
    result = await db.execute(select(Loader).where(Loader.code == code))
    loader = result.scalar_one_or_none()
    if not loader:
        raise HTTPException(status_code=404, detail="Loader not found")
    return loader


@router.post("/", response_model=LoaderRead, status_code=201)
async def create_loader(
    data: LoaderCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loaders", "create")),
):
    loader = Loader(**data.model_dump())
    db.add(loader)
    await db.flush()
    await db.refresh(loader)
    return loader


@router.put("/{loader_id}", response_model=LoaderRead)
async def update_loader(
    loader_id: int,
    data: LoaderUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loaders", "update")),
):
    loader = await db.get(Loader, loader_id)
    if not loader:
        raise HTTPException(status_code=404, detail="Loader not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(loader, key, value)
    await db.flush()
    await db.refresh(loader)
    return loader


@router.delete("/{loader_id}", status_code=204)
async def delete_loader(
    loader_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loaders", "delete")),
):
    loader = await db.get(Loader, loader_id)
    if not loader:
        raise HTTPException(status_code=404, detail="Loader not found")
    await db.delete(loader)
