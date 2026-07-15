"""Routes CRUD appareils mobiles / Mobile device CRUD routes."""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.config import settings
from app.rate_limit import limiter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.audit import AuditLog
from app.models.delivery_alert import DeliveryAlert
from app.models.device_assignment import DeviceAssignment
from app.models.driver_declaration import DriverDeclaration
from app.models.gps_position import GPSPosition
from app.models.mobile_device import DEVICE_PROFILES, MobileDevice
from app.models.pickup_request import PickupLabel
from app.models.stop_event import StopEvent
from app.models.support_scan import SupportScan
from app.models.tour import Tour, TourStatus
from app.models.user import User
from app.models.vehicle_inspection import VehicleInspection
from app.schemas.mobile import MobileDeviceCreate, MobileDeviceRead, MobileDeviceUpdate, DeviceRegistration
from app.api.deps import require_permission, get_authenticated_device

router = APIRouter()


@router.post("/", response_model=MobileDeviceRead, status_code=201)
async def create_device(
    data: MobileDeviceCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("devices", "create")),
):
    """Creer un appareil (auto-genere registration_code UUID) / Create a device.
    device_identifier laisse vide — sera rempli par le telephone lors de l'enregistrement QR.
    """
    profile = data.profile or "DRIVER"
    device = MobileDevice(
        device_identifier=None,  # Rempli par le telephone / Filled by phone on registration
        friendly_name=data.friendly_name,
        base_id=data.base_id,
        pdv_id=data.pdv_id,
        registration_code=str(uuid.uuid4())[:8].upper(),
        is_active=True,
        registered_at=None,  # Sera set lors de l'enregistrement QR
        profile=profile,
        allowed_features=DEVICE_PROFILES.get(profile, DEVICE_PROFILES["DRIVER"]),
    )
    db.add(device)
    await db.flush()
    return device


@router.get("/", response_model=list[MobileDeviceRead])
async def list_devices(
    base_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("devices", "read")),
):
    """Lister les appareils (filtre base_id) / List devices."""
    query = select(MobileDevice)
    if base_id is not None:
        query = query.where(MobileDevice.base_id == base_id)
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/{device_id}", response_model=MobileDeviceRead)
async def get_device(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("devices", "read")),
):
    device = await db.get(MobileDevice, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.put("/{device_id}", response_model=MobileDeviceRead)
async def update_device(
    device_id: int,
    data: MobileDeviceUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("devices", "update")),
):
    device = await db.get(MobileDevice, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    changes = data.model_dump(exclude_unset=True)
    # Si le profil change, recalculer allowed_features / If profile changes, recompute features
    if "profile" in changes and changes["profile"] in DEVICE_PROFILES:
        changes["allowed_features"] = DEVICE_PROFILES[changes["profile"]]
    for key, value in changes.items():
        setattr(device, key, value)
    await db.flush()
    return device


@router.delete("/{device_id}", status_code=204)
async def delete_device(
    device_id: int,
    hard: bool = Query(False, description="Suppression definitive si True"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("devices", "delete")),
):
    """Desactiver ou supprimer un appareil / Deactivate or delete a device."""
    device = await db.get(MobileDevice, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    # Verifier qu'aucun tour n'est en cours / Check no active tour
    active_assignment = (await db.execute(
        select(DeviceAssignment)
        .join(Tour, Tour.id == DeviceAssignment.tour_id)
        .where(
            DeviceAssignment.device_id == device_id,
            Tour.status.in_([TourStatus.IN_PROGRESS, TourStatus.RETURNING]),
        )
        .limit(1)
    )).scalar_one_or_none()

    if active_assignment and hard:
        raise HTTPException(status_code=422, detail="Impossible de supprimer : un tour est en cours sur cet appareil")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if hard:
        # Nullifier les FK optionnelles / Nullify optional FKs
        for label in (await db.execute(
            select(PickupLabel).where(PickupLabel.picked_up_device_id == device_id)
        )).scalars().all():
            label.picked_up_device_id = None

        # Supprimer les donnees liees / Delete linked data
        for model in (GPSPosition, StopEvent, SupportScan, DeliveryAlert, DriverDeclaration, VehicleInspection):
            for row in (await db.execute(
                select(model).where(model.device_id == device_id)
            )).scalars().all():
                await db.delete(row)

        # Delier les tours des assignments / Unlink tours from assignments
        assignment_ids = [a.id for a in (await db.execute(
            select(DeviceAssignment).where(DeviceAssignment.device_id == device_id)
        )).scalars().all()]
        if assignment_ids:
            for tour in (await db.execute(
                select(Tour).where(Tour.device_assignment_id.in_(assignment_ids))
            )).scalars().all():
                tour.device_assignment_id = None

        # Supprimer les assignments / Delete assignments
        for a in (await db.execute(
            select(DeviceAssignment).where(DeviceAssignment.device_id == device_id)
        )).scalars().all():
            await db.delete(a)

        db.add(AuditLog(
            entity_type="device", entity_id=device_id, action="HARD_DELETE",
            changes=f'{{"friendly_name":"{device.friendly_name or ""}","registration_code":"{device.registration_code}"}}',
            user=user.username, timestamp=now,
        ))
        await db.delete(device)
    else:
        device.is_active = False
        db.add(AuditLog(
            entity_type="device", entity_id=device_id, action="SOFT_DELETE",
            changes=f'{{"friendly_name":"{device.friendly_name or ""}"}}',
            user=user.username, timestamp=now,
        ))

    await db.flush()


@router.post("/{device_id}/reset-identity", response_model=MobileDeviceRead)
async def reset_device_identity(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("devices", "update")),
):
    """Reinitialiser l'identite physique d'un appareil / Reset device physical identity.
    Permet a un nouveau telephone de s'enregistrer avec ce registration_code.
    """
    device = await db.get(MobileDevice, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.add(AuditLog(
        entity_type="device", entity_id=device_id, action="RESET_IDENTITY",
        changes=f'{{"old_identifier":"{device.device_identifier or ""}"}}',
        user=user.username, timestamp=now,
    ))

    device.device_identifier = None
    device.registered_at = None
    device.is_active = True
    await db.flush()
    return device


@router.get("/me", response_model=MobileDeviceRead)
async def get_my_device(device: MobileDevice = Depends(get_authenticated_device)):
    """Infos de l'appareil courant (auth X-Device-ID) : profil, base, pdv_id…

    Permet à l'app de savoir si la tablette est rattachée à un PDV (mode magasin
    sans login) et de scoper son flux en conséquence.
    """
    return device


@router.post("/register", response_model=MobileDeviceRead)
@limiter.limit(settings.RATE_LIMIT_REGISTER)
async def register_device(
    request: Request,
    data: DeviceRegistration,
    db: AsyncSession = Depends(get_db),
):
    """Enregistrement mobile (registration_code + device_identifier) / Mobile registration.
    Public endpoint — le telephone presente son QR pour s'enregistrer.
    """
    result = await db.execute(
        select(MobileDevice).where(MobileDevice.registration_code == data.registration_code)
    )
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Invalid registration code")
    if not device.is_active:
        raise HTTPException(status_code=400, detail="Device is deactivated")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # Garde anti-usurpation (ticket #13) : un code d'enregistrement est lie a UN seul
    # appareil physique. S'il est deja utilise par un autre appareil, on refuse au lieu
    # d'ecraser silencieusement l'identite (ce qui permettait a n'importe quel telephone
    # possedant le code de se faire passer pour la tablette d'un PDV). Pour re-enregistrer
    # un nouveau telephone, un admin doit d'abord reinitialiser l'appareil (reset-identity).
    #
    # Anti-impersonation guard: a registration code binds to a SINGLE physical device.
    # If already bound to another device, reject instead of silently overwriting. Re-binding
    # a new phone requires an admin reset-identity first.
    if device.device_identifier and device.device_identifier != data.device_identifier:
        db.add(AuditLog(
            entity_type="device", entity_id=device.id, action="REGISTER_REJECTED",
            changes=f'{{"reason":"code_deja_utilise","registration_code":"{device.registration_code}"}}',
            user="public:register", timestamp=now,
        ))
        await db.flush()
        raise HTTPException(
            status_code=409,
            detail="Ce code d'enregistrement est deja utilise par un autre appareil. "
                   "Demandez a un administrateur de reinitialiser l'appareil.",
        )

    is_new_binding = device.device_identifier != data.device_identifier
    # Mettre a jour l'identifiant physique / Update the physical identifier
    device.device_identifier = data.device_identifier
    if is_new_binding:
        device.registered_at = now
        db.add(AuditLog(
            entity_type="device", entity_id=device.id, action="REGISTERED",
            changes=f'{{"pdv_id":{device.pdv_id if device.pdv_id is not None else "null"},'
                    f'"registration_code":"{device.registration_code}"}}',
            user="public:register", timestamp=now,
        ))
    await db.flush()
    return device
