"""Routes affectation telephone/chauffeur/tour / Device assignment routes."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.audit import AuditLog
from app.models.device_assignment import DeviceAssignment
from app.models.mobile_device import MobileDevice
from app.models.tour import Tour
from app.models.user import User
from app.schemas.mobile import DeviceAssignmentCreate, DeviceAssignmentRead
from app.api.deps import require_permission
from app.api.ws_tracking import manager

router = APIRouter()


@router.post("/", response_model=DeviceAssignmentRead, status_code=201)
async def create_assignment(
    data: DeviceAssignmentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("devices", "create")),
):
    """Creer affectation -> auto-set tour.driver_user_id / Create assignment."""
    # Verifier que le device existe et est actif
    device = await db.get(MobileDevice, data.device_id)
    if not device or not device.is_active:
        raise HTTPException(status_code=404, detail="Device not found or inactive")

    # Verifier que le tour existe
    tour = await db.get(Tour, data.tour_id)
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    assignment = DeviceAssignment(
        device_id=data.device_id,
        tour_id=data.tour_id,
        date=data.date,
        driver_name=data.driver_name,
        assigned_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    db.add(assignment)
    await db.flush()

    # Auto-set sur le tour / Auto-set on tour
    tour.device_assignment_id = assignment.id
    if data.driver_name:
        tour.driver_name = data.driver_name

    # Audit log
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.add(AuditLog(
        entity_type="device_assignment", entity_id=assignment.id, action="CREATE",
        changes=f'{{"device_id":{data.device_id},"tour_id":{data.tour_id},"driver_name":"{data.driver_name or ""}","tour_code":"{tour.code}"}}',
        user=user.username, timestamp=now,
    ))

    await db.flush()

    # Broadcast WebSocket — le telephone recevra via polling
    await manager.broadcast(tenant_id=tour.tenant_id, message={
        "type": "tour_assigned",
        "device_id": data.device_id,
        "tour_id": data.tour_id,
        "tour_code": tour.code,
        "driver_name": data.driver_name or "",
    })

    return assignment


@router.get("/", response_model=list[DeviceAssignmentRead])
async def list_assignments(
    date: str | None = None,
    base_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("devices", "read")),
):
    """Lister les affectations (filtre date, base_id) / List assignments."""
    query = select(DeviceAssignment)
    if date is not None:
        query = query.where(DeviceAssignment.date == date)
    if base_id is not None:
        query = query.join(MobileDevice, DeviceAssignment.device_id == MobileDevice.id).where(
            MobileDevice.base_id == base_id
        )
    result = await db.execute(query)
    return result.scalars().all()


@router.put("/{assignment_id}/return", response_model=DeviceAssignmentRead)
async def return_device(
    assignment_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("devices", "update")),
):
    """Telephone rendu (returned_at) / Device returned."""
    assignment = await db.get(DeviceAssignment, assignment_id)
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    assignment.returned_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    await db.flush()
    return assignment


@router.delete("/{assignment_id}", status_code=204)
async def delete_assignment(
    assignment_id: int,
    db: AsyncSession = Depends(get_db),
    # Reprendre un téléphone n'est pas supprimer l'appareil : `devices:update`
    # au lieu de `devices:delete`, sans quoi le postier pouvait affecter un
    # téléphone (devices:create) mais jamais le libérer (#107).
    user: User = Depends(require_permission("devices", "update")),
):
    """Annuler affectation / Cancel assignment."""
    assignment = await db.get(DeviceAssignment, assignment_id)
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    # Nettoyer le tour / Clean up tour
    tour = await db.get(Tour, assignment.tour_id)
    if tour and tour.device_assignment_id == assignment.id:
        tour.device_assignment_id = None
        tour.driver_user_id = None

    await db.delete(assignment)
    await db.flush()
