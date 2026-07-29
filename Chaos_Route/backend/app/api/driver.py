"""Endpoints mobile chauffeur / Mobile driver endpoints.

Auth par appareil (X-Device-ID header) — pas de JWT pour le chauffeur.
"""

import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile

from app.config import settings
from app.rate_limit import limiter
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.audit import AuditLog
from app.models.delivery_alert import AlertSeverity, AlertType, DeliveryAlert
from app.models.device_assignment import DeviceAssignment
from app.models.gps_position import GPSPosition
from app.models.mobile_device import MobileDevice
from app.models.pdv import PDV
from app.models.stop_event import StopEvent, StopEventType
from app.models.support_scan import SupportScan
from app.models.tour import Tour, TourStatus
from app.models.tour_stop import TourStop
from app.models.tour_manifest_line import TourManifestLine
from app.models.base_logistics import BaseLogistics
from app.models.contract import Contract
from app.models.pickup_request import PickupLabel, PickupRequest, PickupMovement, LabelStatus, PickupType, MovementType, PickupStatus
from app.models.combi_scan import CombiScan, ScanContext
from app.models.control_evidence import ControlEvidence, ControlContext
from app.models.base_support_rule import BaseSupportRule
from app.models.parameter import Parameter
from app.models.support_type import SupportType
from app.models.temperature_check import TemperatureCheck, TempCheckpoint
from app.schemas.mobile import (
    AvailableTourRead,
    DriverTourRead,
    DriverTourStopRead,
    GPSBatchCreate,
    ManifestCheckResponse,
    PickupRefusalCreate,
    PickupSummaryItem,
    ReturnToBaseCreate,
    SelfAssignCreate,
    StopClosureCreate,
    StopEventCreate,
    SupportScanCreate,
    SupportScanRead,
)
from app.schemas.pickup import PickupLabelRead
from app.schemas.combi_scan import (
    CombiScanCreate, CombiScanRead, CombiReceiveCreate,
    PickupLabelArrivalRead, CombiPickupCloseRead,
)
from app.schemas.inventory import InventorySubmit
from app.utils.support_rules import is_return_support_code, pickup_type_for_support_code
from app.api.deps import get_authenticated_device, require_device_tour_access
from app.api.ws_tracking import manager

router = APIRouter()

ALL_DEVICE_FEATURES = ["tours", "pickups", "base_reception", "inventory", "declarations", "inspections"]


def _check_device_feature(device: MobileDevice, feature: str) -> None:
    """Verifier qu'un appareil a acces a une fonctionnalite / Check device has feature access."""
    allowed = (device.allowed_features or ",".join(ALL_DEVICE_FEATURES)).split(",")
    if feature not in allowed:
        raise HTTPException(status_code=403, detail=f"Feature '{feature}' not allowed on this device")


def _enforce_device_pdv_scope(device: MobileDevice, pdv: PDV) -> None:
    """Empêcher une tablette verrouillée sur un PDV d'agir sur un AUTRE PDV (ticket #14).

    Vecteur d'usurpation signalé : une tablette rattachée au PDV A pouvait accéder
    au profil/données du PDV B en saisissant simplement son numéro (code). On refuse
    donc dès qu'un appareil PORTE un pdv_id et que le PDV visé n'est pas le sien.

    Les appareils chauffeur (pdv_id absent) ne sont PAS contraints : ils visitent
    légitimement plusieurs PDV sur leur tournée. La garde ne mord donc que sur les
    tablettes magasin, exactement comme le contrôle déjà en place à /driver/inventory.
    / Lock a PDV-bound tablet to its own PDV; drivers (no pdv_id) are unaffected."""
    if device.pdv_id and pdv is not None and device.pdv_id != pdv.id:
        raise HTTPException(status_code=403, detail="Accès non autorisé à ce PDV depuis cette tablette")


async def _check_base_support_allowed(
    device: MobileDevice,
    support_type_id: int | None,
    db: AsyncSession,
    tour_id: int | None = None,
) -> None:
    """Verifier si le type de support est autorise pour la base du device / Check if support type is allowed for device base.
    Pas de regle = autorise par defaut. Bypass si tour flagge.
    """
    if not device.base_id or not support_type_id:
        return

    # Verifier bypass tour
    if tour_id:
        tour = await db.get(Tour, tour_id)
        if tour and tour.bypass_support_rules:
            return

    result = await db.execute(
        select(BaseSupportRule).where(
            BaseSupportRule.base_id == device.base_id,
            BaseSupportRule.support_type_id == support_type_id,
        )
    )
    rule = result.scalar_one_or_none()

    # Pas de regle = autorise par defaut
    if rule is None:
        return

    if not rule.allowed:
        st = await db.get(SupportType, support_type_id)
        st_name = st.name if st else f"#{support_type_id}"
        base = await db.get(BaseLogistics, device.base_id)
        base_name = base.name if base else f"#{device.base_id}"
        raise HTTPException(
            status_code=403,
            detail=f"Le support '{st_name}' n'est pas repris sur la base '{base_name}'. Contactez votre responsable.",
        )


async def _check_base_combi_allowed(
    device: MobileDevice,
    db: AsyncSession,
) -> None:
    """Verifier si la base du device accepte les combis / Check if device base accepts combis.
    Bloque si au moins un support type CO est explicitement bloque pour cette base.
    """
    if not device.base_id:
        return

    # Chercher les support types CO bloques pour cette base
    result = await db.execute(
        select(BaseSupportRule)
        .join(SupportType, BaseSupportRule.support_type_id == SupportType.id)
        .where(
            BaseSupportRule.base_id == device.base_id,
            SupportType.code.startswith("CO"),
            BaseSupportRule.allowed == False,
        )
    )
    blocked = result.first()

    if blocked:
        base = await db.get(BaseLogistics, device.base_id)
        base_name = base.name if base else f"#{device.base_id}"
        raise HTTPException(
            status_code=403,
            detail=f"Les combis ne sont pas repris sur la base '{base_name}'. Contactez votre responsable.",
        )


@router.get("/device-info")
async def get_device_info(
    device: MobileDevice = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
):
    """Infos appareil pour affichage mobile / Device info for mobile display."""
    base_name: str | None = None
    if device.base_id:
        base = await db.get(BaseLogistics, device.base_id)
        base_name = base.name if base else None
    allowed = (device.allowed_features or ",".join(ALL_DEVICE_FEATURES)).split(",")

    control_mode = await _resolve_control_mode(device, db)

    return {
        "friendly_name": device.friendly_name,
        "base_name": base_name,
        "registration_code": device.registration_code,
        "allowed_features": allowed,
        "control_mode": control_mode,
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _build_tour_stops(
    stops: list, pdv_map: dict[int, "PDV"],
    support_counts: dict[int, int] | None = None,
    pickup_label_counts: dict[int, int] | None = None,
    pickup_summary_map: dict[int, list[PickupSummaryItem]] | None = None,
) -> list[DriverTourStopRead]:
    """Construire la liste de stops pour le chauffeur / Build driver stop list."""
    counts = support_counts or {}
    plcounts = pickup_label_counts or {}
    ps_map = pickup_summary_map or {}
    result = []
    for s in sorted(stops, key=lambda x: x.sequence_order):
        pdv = pdv_map.get(s.pdv_id)
        result.append(DriverTourStopRead(
            id=s.id,
            sequence_order=s.sequence_order,
            eqp_count=s.eqp_count,
            pdv_code=pdv.code if pdv else None,
            pdv_name=pdv.name if pdv else None,
            pdv_address=pdv.address if pdv else None,
            pdv_city=pdv.city if pdv else None,
            pdv_latitude=pdv.latitude if pdv else None,
            pdv_longitude=pdv.longitude if pdv else None,
            delivery_status=s.delivery_status or "PENDING",
            arrival_time=s.arrival_time,
            departure_time=s.departure_time,
            actual_arrival_time=s.actual_arrival_time,
            actual_departure_time=s.actual_departure_time,
            pickup_cardboard=s.pickup_cardboard,
            pickup_containers=s.pickup_containers,
            pickup_returns=s.pickup_returns,
            pickup_consignment=getattr(s, "pickup_consignment", False),
            scanned_supports_count=counts.get(s.id, 0),
            pending_pickup_labels_count=plcounts.get(s.id, 0),
            pickup_summary=ps_map.get(s.id, []),
        ))
    return result


async def _build_tour_read(tour: Tour, db: AsyncSession) -> DriverTourRead:
    """Construire la vue tour complete / Build full tour read view."""
    from collections import defaultdict
    from app.models.support_type import SupportType

    base = await db.get(BaseLogistics, tour.base_id)
    contract = await db.get(Contract, tour.contract_id) if tour.contract_id else None

    pdv_ids = [s.pdv_id for s in tour.stops]
    pdv_map: dict[int, PDV] = {}
    if pdv_ids:
        pdv_result = await db.execute(select(PDV).where(PDV.id.in_(pdv_ids)))
        pdv_map = {p.id: p for p in pdv_result.scalars().all()}

    # Compter les supports scannes par stop / Count scanned supports per stop
    stop_ids = [s.id for s in tour.stops]
    support_counts: dict[int, int] = {}
    pickup_label_counts: dict[int, int] = {}
    pickup_summary_map: dict[int, list[PickupSummaryItem]] = {}
    if stop_ids:
        from sqlalchemy import func, case
        count_result = await db.execute(
            select(SupportScan.tour_stop_id, func.count(SupportScan.id))
            .where(SupportScan.tour_stop_id.in_(stop_ids))
            .group_by(SupportScan.tour_stop_id)
        )
        support_counts = dict(count_result.all())

        # Compter les etiquettes de reprise par stop / Count pickup labels per stop
        pl_result = await db.execute(
            select(PickupLabel.tour_stop_id, func.count(PickupLabel.id))
            .where(
                PickupLabel.tour_stop_id.in_(stop_ids),
                PickupLabel.status.in_([LabelStatus.PLANNED, LabelStatus.PENDING]),
            )
            .group_by(PickupLabel.tour_stop_id)
        )
        pickup_label_counts = dict(pl_result.all())

        # Resume reprises par (stop, type support) / Pickup summary per (stop, support type)
        summary_result = await db.execute(
            select(
                PickupLabel.tour_stop_id,
                SupportType.code,
                SupportType.name,
                func.count(PickupLabel.id).label("total"),
                func.sum(case(
                    (PickupLabel.status.in_([LabelStatus.PLANNED, LabelStatus.PENDING]), 1),
                    else_=0,
                )).label("pending"),
            )
            .join(PickupRequest, PickupLabel.pickup_request_id == PickupRequest.id)
            .join(SupportType, PickupRequest.support_type_id == SupportType.id)
            .where(PickupLabel.tour_stop_id.in_(stop_ids))
            .group_by(PickupLabel.tour_stop_id, SupportType.code, SupportType.name)
        )
        summary_raw: dict[int, list[PickupSummaryItem]] = defaultdict(list)
        for row in summary_result.all():
            summary_raw[row[0]].append(PickupSummaryItem(
                support_type_code=row[1],
                support_type_name=row[2],
                total_labels=row[3],
                pending_labels=row[4],
            ))
        pickup_summary_map = dict(summary_raw)

    status_val = tour.status.value if hasattr(tour.status, "value") else tour.status
    return DriverTourRead(
        id=tour.id,
        code=tour.code,
        date=tour.date,
        delivery_date=tour.delivery_date,
        departure_time=tour.departure_time,
        return_time=tour.return_time,
        total_eqp=tour.total_eqp,
        status=status_val,
        base_code=base.code if base else None,
        base_name=base.name if base else None,
        vehicle_code=contract.vehicle_code if contract else None,
        vehicle_name=contract.vehicle_name if contract else None,
        driver_name=tour.driver_name,
        temperature_type=tour.temperature_type,
        stops=_build_tour_stops(tour.stops, pdv_map, support_counts, pickup_label_counts, pickup_summary_map),
    )


@router.get("/my-tours", response_model=list[DriverTourRead])
async def my_tours(
    date: str | None = None,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Tours assignes a cet appareil / Tours assigned to this device."""
    target_date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Chercher via DeviceAssignment + filtre par date du TOUR (pas de l'assignment)
    # pour cohérence avec available-tours qui cherche par Tour.delivery_date/date
    assignment_result = await db.execute(
        select(DeviceAssignment.tour_id)
        .join(Tour, Tour.id == DeviceAssignment.tour_id)
        .where(
            DeviceAssignment.device_id == device.id,
            or_(Tour.delivery_date == target_date, Tour.date == target_date),
        )
    )
    tour_ids = [row[0] for row in assignment_result.all()]

    if not tour_ids:
        return []

    result = await db.execute(
        select(Tour)
        .where(Tour.id.in_(tour_ids))
        .options(selectinload(Tour.stops))
    )
    tours = result.scalars().all()

    return [await _build_tour_read(tour, db) for tour in tours]


@router.get("/available-tours", response_model=list[AvailableTourRead])
async def available_tours(
    date: str | None = None,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Tours disponibles pour affectation / Available tours for assignment.

    Retourne les tours VALIDATED de la meme base que l'appareil, non encore affectes.
    """
    target_date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Tours deja affectes (filtre par date du TOUR, coherent avec my-tours)
    assigned_result = await db.execute(
        select(DeviceAssignment.tour_id)
        .join(Tour, Tour.id == DeviceAssignment.tour_id)
        .where(or_(Tour.delivery_date == target_date, Tour.date == target_date))
    )
    assigned_tour_ids = {row[0] for row in assigned_result.all()}

    # Tours DRAFT ou VALIDATED pour cette date et cette base / DRAFT or VALIDATED tours for this date and base
    # Chercher par delivery_date OU date (fallback si delivery_date NULL)
    query = select(Tour).where(
        or_(Tour.delivery_date == target_date, Tour.date == target_date),
        Tour.status.in_([TourStatus.DRAFT, TourStatus.VALIDATED]),
    )
    if device.base_id:
        query = query.where(Tour.base_id == device.base_id)

    result = await db.execute(query.options(selectinload(Tour.stops)))
    tours = result.scalars().all()

    available = []
    for tour in tours:
        if tour.id in assigned_tour_ids:
            continue
        contract = await db.get(Contract, tour.contract_id) if tour.contract_id else None
        available.append(AvailableTourRead(
            id=tour.id,
            code=tour.code,
            delivery_date=tour.delivery_date,
            departure_time=tour.departure_time,
            total_eqp=tour.total_eqp,
            stops_count=len(tour.stops),
            driver_name=tour.driver_name,
            vehicle_code=contract.vehicle_code if contract else None,
        ))
    return available


@router.post("/assign-tour", response_model=DriverTourRead)
async def assign_tour(
    data: SelfAssignCreate,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Affecter un tour a cet appareil / Assign a tour to this device."""
    tour = await db.get(Tour, data.tour_id, options=[selectinload(Tour.stops)])
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    if tour.status not in (TourStatus.DRAFT, TourStatus.VALIDATED):
        raise HTTPException(status_code=422, detail="Tour already in progress or completed")

    # Verifier que le tour appartient a la base de l'appareil / Verify tour belongs to device's base
    if device.base_id and tour.base_id != device.base_id:
        raise HTTPException(status_code=403, detail="Tour does not belong to this device's base")

    # Auto-valider si DRAFT / Auto-validate if DRAFT
    if tour.status == TourStatus.DRAFT:
        tour.status = TourStatus.VALIDATED

    target_date = tour.delivery_date or tour.date

    # Verifier pas deja affecte / Check not already assigned
    existing = await db.execute(
        select(DeviceAssignment).where(
            DeviceAssignment.tour_id == data.tour_id,
            DeviceAssignment.date == target_date,
        ).limit(1)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Tour already assigned to a device")

    # Utiliser le nom chauffeur du tour si pas fourni / Use tour driver_name if not provided
    driver = data.driver_name or tour.driver_name

    assignment = DeviceAssignment(
        device_id=device.id,
        tour_id=data.tour_id,
        date=target_date,
        driver_name=driver,
        assigned_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    db.add(assignment)
    await db.flush()

    tour.device_assignment_id = assignment.id

    # 5A. Audit log — self-assign tour
    db.add(AuditLog(
        entity_type="tour", entity_id=tour.id, action="SELF_ASSIGN",
        changes=f'{{"device_id":{device.id},"device_name":"{device.friendly_name or ""}","driver":"{driver or ""}","tour_code":"{tour.code}"}}',
        user=f"device:{device.id}",
        timestamp=_now_iso(),
    ))

    await db.flush()

    return await _build_tour_read(tour, db)


@router.get("/tour/{tour_id}", response_model=DriverTourRead)
async def get_driver_tour(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Detail tour + stops + PDV / Tour detail for driver."""
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    return await _build_tour_read(tour, db)


@router.post("/tour/{tour_id}/temp-check")
async def driver_temp_check(
    tour_id: int,
    data: dict,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Controle temperature chauffeur / Driver temperature check (departure + each stop).

    Body: { checkpoint: "DEPARTURE_CHECK"|"STOP_CHECK", tour_stop_id?: int,
            cooling_unit_ok: bool, setpoint_ok: bool, setpoint_temperature: float }
    """
    checkpoint_str = data.get("checkpoint", "STOP_CHECK")
    try:
        checkpoint = TempCheckpoint(checkpoint_str)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Checkpoint invalide: {checkpoint_str}")

    cooling_ok = data.get("cooling_unit_ok", False)
    setpoint_ok = data.get("setpoint_ok", False)
    setpoint_temp = data.get("setpoint_temperature", 0.0)
    tour_stop_id = data.get("tour_stop_id")

    # Temperature = setpoint si chauffeur confirme OK, sinon 999 pour marquer NOK
    temperature = float(setpoint_temp) if (cooling_ok and setpoint_ok) else 999.0
    notes = "OK" if (cooling_ok and setpoint_ok) else "NOK — chauffeur a signale un probleme"

    check = TemperatureCheck(
        tour_id=tour_id,
        tour_stop_id=tour_stop_id,
        checkpoint=checkpoint,
        temperature=temperature,
        setpoint_temperature=float(setpoint_temp),
        cooling_unit_ok=bool(cooling_ok and setpoint_ok),
        device_id=device.id,
        timestamp=_now_iso(),
        notes=notes,
    )
    db.add(check)
    await db.flush()

    return {"id": check.id, "ok": bool(cooling_ok and setpoint_ok)}


@router.post("/switch-driver")
async def switch_driver(
    data: dict,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Changer le nom du chauffeur sur l'assignment actif / Switch driver name on active assignment."""
    new_name = data.get("driver_name", "").strip()
    if not new_name:
        raise HTTPException(status_code=422, detail="Nom du chauffeur requis")

    # Trouver l'assignment actif du jour / Find today's active assignment
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    result = await db.execute(
        select(DeviceAssignment)
        .join(Tour, Tour.id == DeviceAssignment.tour_id)
        .where(
            DeviceAssignment.device_id == device.id,
            or_(Tour.delivery_date == today, Tour.date == today),
            DeviceAssignment.returned_at.is_(None),
        )
        .order_by(DeviceAssignment.assigned_at.desc())
        .limit(1)
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Aucun tour actif aujourd'hui")

    old_name = assignment.driver_name
    assignment.driver_name = new_name

    db.add(AuditLog(
        entity_type="device_assignment", entity_id=assignment.id, action="SWITCH_DRIVER",
        changes=f'{{"old_driver":"{old_name or ""}","new_driver":"{new_name}","device_id":{device.id}}}',
        user=f"device:{device.id}",
        timestamp=_now_iso(),
    ))
    await db.flush()

    return {"status": "ok", "old_driver": old_name, "new_driver": new_name}


@router.post("/gps")
@limiter.limit(settings.RATE_LIMIT_GPS)
async def submit_gps_batch(
    request: Request,
    data: GPSBatchCreate,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Batch GPS positions / Batch insert GPS positions."""
    # Verifier que l'appareil est assigne a ce tour / Verify device is assigned to this tour
    assignment_result = await db.execute(
        select(DeviceAssignment).where(
            DeviceAssignment.tour_id == data.tour_id,
            DeviceAssignment.device_id == device.id,
        ).limit(1)
    )
    if not assignment_result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Device not assigned to this tour")

    # Opt-out geolocalisation (RGPD, STIME A7) : si le chauffeur a refuse le
    # suivi, les positions sont ignorees cote serveur (defense en profondeur,
    # meme si l'app cesse d'emettre) / GPS opt-out: drop positions server-side.
    from app.services.consent import GPS_TRACKING, get_latest_consent
    consent = await get_latest_consent(db, GPS_TRACKING, device_id=device.id)
    if consent is not None and not consent.granted:
        return {"inserted": 0, "detail": "Suivi GPS refuse par le chauffeur (opt-out)"}

    positions = []
    for pos in data.positions:
        gps = GPSPosition(
            device_id=device.id,
            tour_id=data.tour_id,
            latitude=pos.latitude,
            longitude=pos.longitude,
            accuracy=pos.accuracy,
            speed=pos.speed,
            timestamp=pos.timestamp,
        )
        db.add(gps)
        positions.append({
            "latitude": pos.latitude,
            "longitude": pos.longitude,
            "speed": pos.speed,
            "accuracy": pos.accuracy,
            "timestamp": pos.timestamp,
        })
    await db.flush()

    # Broadcast WebSocket
    tour = await db.get(Tour, data.tour_id)
    if positions:
        last = positions[-1]
        await manager.broadcast(tenant_id=device.tenant_id, message={
            "type": "gps_update",
            "tour_id": data.tour_id,
            "tour_code": tour.code if tour else "",
            "driver_name": tour.driver_name if tour else "",
            "latitude": last["latitude"],
            "longitude": last["longitude"],
            "speed": last["speed"],
            "timestamp": last["timestamp"],
        })

    return {"inserted": len(data.positions)}


@router.post("/tour/{tour_id}/stops/{stop_id}/scan-pdv")
async def scan_pdv(
    tour_id: int,
    stop_id: int,
    data: StopEventCreate,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Scan QR PDV -> valide code vs attendu / Scan PDV QR code -> validate against expected."""
    stop = await db.get(TourStop, stop_id)
    if not stop or stop.tour_id != tour_id:
        raise HTTPException(status_code=404, detail="Stop not found")

    pdv = await db.get(PDV, stop.pdv_id)
    if not pdv:
        raise HTTPException(status_code=404, detail="PDV not found")

    # Comparer le code scanne vs attendu / Compare scanned vs expected code
    if data.scanned_pdv_code != pdv.code:
        alert = DeliveryAlert(
            tour_id=tour_id,
            tour_stop_id=stop_id,
            alert_type=AlertType.WRONG_PDV,
            severity=AlertSeverity.WARNING,
            message=f"Code scanne: {data.scanned_pdv_code}, attendu: {pdv.code}",
            created_at=_now_iso(),
            device_id=device.id,
        )
        db.add(alert)
        await db.flush()

        await manager.broadcast(tenant_id=device.tenant_id, message={
            "type": "alert",
            "alert_type": "WRONG_PDV",
            "tour_id": tour_id,
            "stop_id": stop_id,
            "message": alert.message,
        })

        raise HTTPException(
            status_code=422,
            detail=f"PDV mismatch: scanned {data.scanned_pdv_code}, expected {pdv.code}",
        )

    # Code correct -> creer event ARRIVAL
    event = StopEvent(
        tour_stop_id=stop_id,
        event_type=StopEventType.ARRIVAL,
        scanned_pdv_code=data.scanned_pdv_code,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy=data.accuracy,
        timestamp=data.timestamp,
        notes=data.notes,
        device_id=device.id,
    )
    db.add(event)

    stop.delivery_status = "ARRIVED"
    stop.actual_arrival_time = data.timestamp

    tour = await db.get(Tour, tour_id)
    if tour and tour.status in (TourStatus.DRAFT, TourStatus.VALIDATED):
        tour.status = TourStatus.IN_PROGRESS

    await db.flush()

    await manager.broadcast(tenant_id=device.tenant_id, message={
        "type": "stop_event",
        "event": "ARRIVAL",
        "tour_id": tour_id,
        "stop_id": stop_id,
        "pdv_code": pdv.code,
        "timestamp": data.timestamp,
    })

    return {"status": "ok", "delivery_status": "ARRIVED"}


@router.post("/tour/{tour_id}/stops/{stop_id}/close")
async def close_stop(
    tour_id: int,
    stop_id: int,
    data: StopClosureCreate,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Cloture stop (force possible) / Close stop (force possible)."""
    stop = await db.get(TourStop, stop_id)
    if not stop or stop.tour_id != tour_id:
        raise HTTPException(status_code=404, detail="Stop not found")

    # Verifier reprises en attente / Check pending pickups
    if not data.force:
        from sqlalchemy import func
        pending_result = await db.execute(
            select(func.count(PickupLabel.id))
            .where(
                PickupLabel.tour_stop_id == stop_id,
                PickupLabel.status.in_([LabelStatus.PLANNED, LabelStatus.PENDING]),
            )
        )
        pending_count = pending_result.scalar() or 0
        if pending_count > 0:
            raise HTTPException(
                status_code=422,
                detail=f"Reprises en attente ({pending_count}) — scannez ou refusez avant de fermer",
            )

    forced = data.force
    if forced:
        alert = DeliveryAlert(
            tour_id=tour_id,
            tour_stop_id=stop_id,
            alert_type=AlertType.FORCED_CLOSURE,
            severity=AlertSeverity.WARNING,
            message="Cloture forcee par le chauffeur",
            created_at=_now_iso(),
            device_id=device.id,
        )
        db.add(alert)
        stop.forced_closure = True

        await manager.broadcast(tenant_id=device.tenant_id, message={
            "type": "alert",
            "alert_type": "FORCED_CLOSURE",
            "tour_id": tour_id,
            "stop_id": stop_id,
            "message": alert.message,
        })

    # Verifier supports manquants au manifeste / Check missing supports from manifest
    pdv = await db.get(PDV, stop.pdv_id)
    if pdv:
        manifest_result = await db.execute(
            select(TourManifestLine).where(
                TourManifestLine.tour_id == tour_id,
                TourManifestLine.pdv_code == pdv.code,
                TourManifestLine.scanned == False,
            )
        )
        missing_lines = manifest_result.scalars().all()
        if missing_lines:
            missing_barcodes = [l.support_number for l in missing_lines]
            missing_alert = DeliveryAlert(
                tour_id=tour_id,
                tour_stop_id=stop_id,
                alert_type=AlertType.MISSING_SUPPORTS,
                severity=AlertSeverity.WARNING,
                message=f"{len(missing_barcodes)} support(s) non scanné(s) : {', '.join(missing_barcodes[:10])}",
                created_at=_now_iso(),
                device_id=device.id,
            )
            db.add(missing_alert)
            stop.missing_supports_count = len(missing_barcodes)

            await manager.broadcast(tenant_id=device.tenant_id, message={
                "type": "alert",
                "alert_type": "MISSING_SUPPORTS",
                "tour_id": tour_id,
                "stop_id": stop_id,
                "message": missing_alert.message,
            })

    event = StopEvent(
        tour_stop_id=stop_id,
        event_type=StopEventType.CLOSURE,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy=data.accuracy,
        timestamp=data.timestamp,
        notes=data.notes,
        forced=forced,
        device_id=device.id,
    )
    db.add(event)

    stop.delivery_status = "DELIVERED"
    stop.actual_departure_time = data.timestamp
    stop.delivery_notes = data.notes

    await db.flush()

    await manager.broadcast(tenant_id=device.tenant_id, message={
        "type": "stop_event",
        "event": "CLOSURE",
        "tour_id": tour_id,
        "stop_id": stop_id,
        "timestamp": data.timestamp,
        "forced": forced,
    })

    return {"status": "ok", "delivery_status": "DELIVERED"}


@router.post("/tour/{tour_id}/stops/{stop_id}/reopen")
async def reopen_stop(
    tour_id: int,
    stop_id: int,
    data: dict,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Reouvrir un stop DELIVERED pour re-livraison / Reopen a DELIVERED stop for re-delivery."""
    stop = await db.get(TourStop, stop_id)
    if not stop or stop.tour_id != tour_id:
        raise HTTPException(status_code=404, detail="Stop not found")

    if stop.delivery_status != "DELIVERED":
        raise HTTPException(status_code=422, detail="Le stop n'est pas en statut DELIVERED")

    timestamp = data.get("timestamp", _now_iso())

    # Reouvrir le stop / Reopen the stop
    stop.delivery_status = "ARRIVED"
    stop.actual_departure_time = None
    stop.forced_closure = False

    # Creer evenement REOPEN / Create REOPEN event
    event = StopEvent(
        tour_stop_id=stop_id,
        event_type=StopEventType.REOPEN,
        timestamp=timestamp,
        notes=data.get("reason", "Re-livraison"),
        device_id=device.id,
    )
    db.add(event)

    # Alerte STOP_REOPENED / STOP_REOPENED alert
    alert = DeliveryAlert(
        tour_id=tour_id,
        tour_stop_id=stop_id,
        alert_type=AlertType.STOP_REOPENED,
        severity=AlertSeverity.INFO,
        message=f"Stop rouvert pour re-livraison",
        created_at=timestamp,
        device_id=device.id,
    )
    db.add(alert)

    # Remettre le tour en IN_PROGRESS si RETURNING / Set tour back to IN_PROGRESS if RETURNING
    tour = await db.get(Tour, tour_id)
    if tour and tour.status == TourStatus.RETURNING:
        tour.status = TourStatus.IN_PROGRESS
        tour.actual_return_time = None

    db.add(AuditLog(
        entity_type="tour_stop", entity_id=stop_id, action="REOPEN",
        changes=f'{{"tour_id":{tour_id},"device_id":{device.id},"reason":"{data.get("reason", "Re-livraison")}"}}',
        user=f"device:{device.id}",
        timestamp=timestamp,
    ))

    await db.flush()

    await manager.broadcast(tenant_id=device.tenant_id, message={
        "type": "stop_event",
        "event": "REOPEN",
        "tour_id": tour_id,
        "stop_id": stop_id,
        "timestamp": timestamp,
    })

    return {"status": "ok", "delivery_status": "ARRIVED"}


@router.post("/tour/{tour_id}/return")
async def return_to_base(
    tour_id: int,
    data: ReturnToBaseCreate,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Retour base / Return to base."""
    tour = await db.get(Tour, tour_id)
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    tour.status = TourStatus.RETURNING
    tour.actual_return_time = data.timestamp

    # 5A. Audit log — return to base
    db.add(AuditLog(
        entity_type="tour", entity_id=tour_id, action="RETURN_BASE",
        changes=f'{{"device_id":{device.id},"tour_code":"{tour.code}","timestamp":"{data.timestamp}"}}',
        user=f"device:{device.id}",
        timestamp=_now_iso(),
    ))

    await db.flush()

    await manager.broadcast(tenant_id=device.tenant_id, message={
        "type": "tour_status",
        "tour_id": tour_id,
        "tour_code": tour.code,
        "status": "RETURNING",
        "actual_return_time": data.timestamp,
    })

    return {"status": "ok", "tour_status": "RETURNING"}


@router.post("/tour/{tour_id}/stops/{stop_id}/scan-support", response_model=SupportScanRead)
async def scan_support(
    tour_id: int,
    stop_id: int,
    data: SupportScanCreate,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Scan code barre support (1D) / Scan support barcode."""
    stop = await db.get(TourStop, stop_id)
    if not stop or stop.tour_id != tour_id:
        raise HTTPException(status_code=404, detail="Stop not found")

    # Verifier doublon (meme barcode pour ce stop) / Check duplicate
    existing = await db.execute(
        select(SupportScan).where(
            SupportScan.tour_stop_id == stop_id,
            SupportScan.barcode == data.barcode,
        ).limit(1)
    )
    if existing.scalar_one_or_none():
        # Retourner l'existant sans creer de doublon / Return existing without duplicate
        dup = (await db.execute(
            select(SupportScan).where(
                SupportScan.tour_stop_id == stop_id,
                SupportScan.barcode == data.barcode,
            )
        )).scalar_one()
        # Chercher le pdv_code attendu dans le manifeste / Lookup expected pdv from manifest
        dup_manifest = (await db.execute(
            select(TourManifestLine).where(
                TourManifestLine.tour_id == tour_id,
                TourManifestLine.support_number == data.barcode,
            )
        )).scalar_one_or_none()
        dup_result = SupportScanRead.model_validate(dup)
        dup_result.expected_pdv_code = dup_manifest.pdv_code if dup_manifest else None
        return dup_result

    # Vérifier le manifeste WMS / Check WMS manifest
    manifest_line = (await db.execute(
        select(TourManifestLine).where(
            TourManifestLine.tour_id == tour_id,
            TourManifestLine.support_number == data.barcode,
        )
    )).scalar_one_or_none()

    expected = True  # Par défaut si pas de manifeste / Default if no manifest
    if manifest_line:
        # Le support existe dans le manifeste — vérifier s'il est pour ce stop
        stop_pdv_code = (await db.execute(
            select(PDV.code).where(PDV.id == stop.pdv_id)
        )).scalar_one()
        expected = (manifest_line.pdv_code.strip() == str(stop_pdv_code).strip())
        # Marquer le support comme scanné / Mark support as scanned
        manifest_line.scanned = True
        manifest_line.scanned_at_stop_id = stop_id
        manifest_line.scanned_at = data.timestamp
        if not expected:
            alert = DeliveryAlert(
                tour_id=tour_id, tour_stop_id=stop_id,
                alert_type=AlertType.WRONG_PDV,
                severity=AlertSeverity.WARNING,
                message=f"Support {data.barcode} attendu au PDV {manifest_line.pdv_code}, scanné au PDV {stop_pdv_code}",
                created_at=data.timestamp, device_id=device.id,
            )
            db.add(alert)
            await manager.broadcast(tenant_id=device.tenant_id, message={
                "type": "wrong_pdv_scan",
                "tour_id": tour_id, "stop_id": stop_id,
                "barcode": data.barcode,
                "expected_pdv": manifest_line.pdv_code,
                "scanned_pdv": str(stop_pdv_code),
            })
    else:
        # Support pas dans le manifeste — vérifier s'il y a un manifeste chargé
        has_manifest = (await db.execute(
            select(TourManifestLine.id).where(TourManifestLine.tour_id == tour_id).limit(1)
        )).scalar_one_or_none()
        if has_manifest:
            expected = False  # Support inconnu alors qu'un manifeste existe

    scan = SupportScan(
        tour_stop_id=stop_id,
        device_id=device.id,
        barcode=data.barcode,
        latitude=data.latitude,
        longitude=data.longitude,
        timestamp=data.timestamp,
        expected_at_stop=expected,
    )
    db.add(scan)
    await db.flush()
    await db.refresh(scan)

    await manager.broadcast(tenant_id=device.tenant_id, message={
        "type": "support_scan",
        "tour_id": tour_id,
        "stop_id": stop_id,
        "barcode": data.barcode,
        "timestamp": data.timestamp,
        "expected_at_stop": expected,
    })

    # Ajouter le pdv_code attendu pour la réponse mobile / Add expected pdv code for mobile response
    expected_pdv = manifest_line.pdv_code if manifest_line else None
    result = SupportScanRead.model_validate(scan)
    result.expected_pdv_code = expected_pdv
    return result


@router.get("/tour/{tour_id}/stops/{stop_id}/supports", response_model=list[SupportScanRead])
async def list_stop_supports(
    tour_id: int,
    stop_id: int,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Lister les supports scannes pour un stop / List scanned supports for a stop."""
    stop = await db.get(TourStop, stop_id)
    if not stop or stop.tour_id != tour_id:
        raise HTTPException(status_code=404, detail="Stop not found")

    result = await db.execute(
        select(SupportScan)
        .where(SupportScan.tour_stop_id == stop_id)
        .order_by(SupportScan.id)
    )
    scans = result.scalars().all()

    # Charger les manifest lines pour enrichir expected_pdv_code / Load manifest lines for expected pdv
    manifest_result = await db.execute(
        select(TourManifestLine).where(TourManifestLine.tour_id == tour_id)
    )
    manifest_map = {m.support_number: m.pdv_code for m in manifest_result.scalars().all()}

    enriched = []
    for s in scans:
        r = SupportScanRead.model_validate(s)
        r.expected_pdv_code = manifest_map.get(s.barcode)
        enriched.append(r)
    return enriched


@router.get("/tour/{tour_id}/stops/{stop_id}/manifest-check", response_model=ManifestCheckResponse)
async def manifest_check(
    tour_id: int,
    stop_id: int,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Verifier le manifeste avant cloture / Check manifest before closure."""
    stop = await db.get(TourStop, stop_id)
    if not stop or stop.tour_id != tour_id:
        raise HTTPException(status_code=404, detail="Stop not found")

    pdv = await db.get(PDV, stop.pdv_id)
    if not pdv:
        return ManifestCheckResponse()

    # Lignes manifeste pour ce PDV dans ce tour / Manifest lines for this PDV in this tour
    manifest_result = await db.execute(
        select(TourManifestLine).where(
            TourManifestLine.tour_id == tour_id,
            TourManifestLine.pdv_code == pdv.code,
        )
    )
    lines = manifest_result.scalars().all()
    if not lines:
        return ManifestCheckResponse()

    total = len(lines)
    scanned = sum(1 for l in lines if l.scanned)
    missing = [l.support_number for l in lines if not l.scanned]

    return ManifestCheckResponse(
        total_expected=total,
        scanned=scanned,
        missing_barcodes=missing,
    )


@router.get("/tour/{tour_id}/pickups", response_model=list[PickupLabelRead])
async def list_tour_pickups(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Etiquettes de reprise pour les stops du tour / Pickup labels for tour stops."""
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    stop_ids = [
        s.id for s in tour.stops
        if s.pickup_containers or s.pickup_cardboard or s.pickup_returns or getattr(s, "pickup_consignment", False)
    ]
    if not stop_ids:
        return []

    label_result = await db.execute(
        select(PickupLabel)
        .where(PickupLabel.tour_stop_id.in_(stop_ids))
        .order_by(PickupLabel.id)
    )
    return label_result.scalars().all()


_PICKUP_LABEL_CODE_RE = re.compile(r"^RET-[A-Za-z0-9]+-[A-Za-z0-9]+-\d{8}-\d{3}$")


def _pdv_codes_match(scanned: str | None, actual: str) -> bool:
    """Comparaison tolérante entre le code PDV scanné et le code réel du PDV de l'étiquette.

    Ticket #11 : empêche le chauffeur de scanner l'étiquette d'un autre PDV après avoir
    scanné le QR d'un premier PDV. `scanned` None/absent = pas de contrôle (rétro-compat).
    Tolère le zero-padding (ex: "2805" ≡ "02805").
    """
    if not scanned:
        return True
    s = scanned.strip().upper()
    a = (actual or "").strip().upper()
    if s == a:
        return True
    s_stripped, a_stripped = s.lstrip("0"), a.lstrip("0")
    return bool(s_stripped) and s_stripped == a_stripped


@router.post("/pickup-labels/{label_code}/scan-arrival", response_model=PickupLabelArrivalRead)
async def scan_pickup_label_arrival(
    label_code: str,
    pdv_code: str | None = Query(None, description="Code PDV scanné (contrôle d'appartenance, ticket #11)"),
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Scan QR etiquette de declaration combi par le chauffeur a son arrivee /
    Scan combi declaration label QR by driver on arrival at PDV.

    Workflow combi :
    1. Chauffeur scanne le code PDV (existant)
    2. Chauffeur scanne ce QR d'etiquette de declaration -> identifie la demande
    3. Chauffeur scanne chaque combi (RM-xxxxxx) avec pickup_label_id retourne ici
    4. Chauffeur cloture -> actual_picked_quantity = nb scans
    """
    _check_device_feature(device, "pickups")

    # Validation format / Format validation
    if not _PICKUP_LABEL_CODE_RE.match(label_code):
        raise HTTPException(status_code=400, detail="Format de code etiquette invalide")

    result = await db.execute(
        select(PickupLabel)
        .where(PickupLabel.label_code == label_code)
        .options(
            selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.support_type),
            selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.pdv),
            selectinload(PickupLabel.combi_scans),
        )
    )
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Etiquette inconnue")

    pickup_req = label.pickup_request
    if not pickup_req or not pickup_req.support_type or not pickup_req.support_type.is_combi:
        raise HTTPException(
            status_code=400,
            detail="Cette etiquette n'est pas une etiquette de declaration combi",
        )

    # Ticket #11 : l'étiquette doit appartenir au PDV scanné / Label must belong to scanned PDV
    if pickup_req.pdv and not _pdv_codes_match(pdv_code, pickup_req.pdv.code):
        raise HTTPException(
            status_code=409,
            detail=f"Cette etiquette appartient au PDV {pickup_req.pdv.code} — {pickup_req.pdv.name}, "
                   f"pas au PDV scanne ({pdv_code}). Scannez le bon PDV.",
        )

    if label.status == LabelStatus.CANCELLED:
        raise HTTPException(
            status_code=400,
            detail="Etiquette annulee — le PDV a remplace cette declaration. Demandez la nouvelle etiquette.",
        )
    if label.status in (LabelStatus.PICKED_UP, LabelStatus.RECEIVED):
        raise HTTPException(
            status_code=409,
            detail="Cette declaration a deja ete cloturee",
        )

    # Verifier que la base accepte les combis / Check base accepts combis
    await _check_base_combi_allowed(device, db)

    # Si le label est lie a un stop, verifier l'acces device / If label has stop, check device access
    if label.tour_stop_id:
        stop_obj = await db.get(TourStop, label.tour_stop_id)
        if stop_obj:
            assign_check = await db.execute(
                select(DeviceAssignment).where(
                    DeviceAssignment.tour_id == stop_obj.tour_id,
                    DeviceAssignment.device_id == device.id,
                ).limit(1)
            )
            if not assign_check.scalar_one_or_none():
                raise HTTPException(status_code=403, detail="Device not assigned to this tour")

    # Marquer PLANNED si PENDING (idempotent si deja PLANNED) /
    # Mark PLANNED if PENDING (idempotent if already PLANNED)
    if label.status == LabelStatus.PENDING:
        label.status = LabelStatus.PLANNED
        db.add(PickupMovement(
            pickup_label_id=label.id,
            movement_type=MovementType.PLANNED,
            timestamp=_now_iso(),
            device_id=device.id,
            notes="Scan QR d'arrivee chauffeur",
        ))
        await db.flush()

    pdv = pickup_req.pdv
    already_scanned = sum(
        1 for s in label.combi_scans if s.scan_context == ScanContext.PICKUP
    )

    return PickupLabelArrivalRead(
        label_id=label.id,
        label_code=label.label_code,
        pickup_request_id=pickup_req.id,
        pdv_id=pdv.id,
        pdv_code=pdv.code,
        pdv_name=pdv.name,
        declared_quantity=pickup_req.quantity,
        already_scanned_count=already_scanned,
    )


@router.post("/pickup-labels/{label_code}/scan", response_model=PickupLabelRead)
async def scan_pickup_label(
    label_code: str,
    stop_id: int | None = Query(None),
    pdv_code: str | None = Query(None, description="Code PDV scanné (contrôle d'appartenance, ticket #11)"),
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Scan etiquette reprise → PICKED_UP / Scan pickup label → PICKED_UP.
    stop_id optionnel : lie automatiquement un label hors-planning au stop.
    Pour les combis : utilise /pickup-labels/{code}/scan-arrival a la place.
    """
    result = await db.execute(
        select(PickupLabel)
        .where(PickupLabel.label_code == label_code)
        .options(
            selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.labels),
            selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.support_type),
            selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.pdv),
        )
    )
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")

    # Ticket #11 : l'étiquette doit appartenir au PDV scanné / Label must belong to scanned PDV
    if label.pickup_request and label.pickup_request.pdv and not _pdv_codes_match(pdv_code, label.pickup_request.pdv.code):
        raise HTTPException(
            status_code=409,
            detail=f"Cette etiquette appartient au PDV {label.pickup_request.pdv.code} — "
                   f"{label.pickup_request.pdv.name}, pas au PDV scanne ({pdv_code}). Scannez le bon PDV.",
        )

    # Bloquer le scan PICKED_UP direct sur etiquette combi /
    # Block direct PICKED_UP scan on combi label
    if label.pickup_request and label.pickup_request.support_type and label.pickup_request.support_type.is_combi:
        raise HTTPException(
            status_code=400,
            detail="Etiquette combi : utilisez le scan d'arrivee puis scannez chaque combi individuellement",
        )

    if label.status == LabelStatus.CANCELLED:
        raise HTTPException(status_code=400, detail="Etiquette annulee — la demande a ete modifiee. Detruisez cette etiquette.")

    # Verifier regle support/base (avec bypass tour) / Check base support rule (with tour bypass)
    tour_id_for_bypass: int | None = None
    if stop_id:
        stop_obj = await db.get(TourStop, stop_id)
        if stop_obj:
            tour_id_for_bypass = stop_obj.tour_id
    elif label.tour_stop_id:
        stop_obj = await db.get(TourStop, label.tour_stop_id)
        if stop_obj:
            tour_id_for_bypass = stop_obj.tour_id
    if label.pickup_request:
        await _check_base_support_allowed(device, label.pickup_request.support_type_id, db, tour_id=tour_id_for_bypass)

    # Label non-assigne + stop_id fourni → auto-lier au stop / Unassigned label + stop_id → auto-link
    if not label.tour_stop_id and stop_id:
        stop = await db.get(TourStop, stop_id)
        if not stop:
            raise HTTPException(status_code=404, detail="Stop not found")
        assign_check = await db.execute(
            select(DeviceAssignment).where(
                DeviceAssignment.tour_id == stop.tour_id,
                DeviceAssignment.device_id == device.id,
            ).limit(1)
        )
        if not assign_check.scalar_one_or_none():
            raise HTTPException(status_code=403, detail="Device not assigned to this tour")
        label.tour_stop_id = stop_id
        # Activer le flag reprise correspondant sur le stop / Activate matching pickup flag on stop
        _PICKUP_TYPE_FLAG = {
            PickupType.CONTAINER: "pickup_containers",
            PickupType.CARDBOARD: "pickup_cardboard",
            PickupType.MERCHANDISE: "pickup_returns",
            PickupType.CONSIGNMENT: "pickup_consignment",
        }
        flag = _PICKUP_TYPE_FLAG.get(label.pickup_request.pickup_type)
        if flag and not getattr(stop, flag, False):
            setattr(stop, flag, True)

    # Verifier que l'appareil a acces via label → stop → tour → DeviceAssignment
    elif label.tour_stop_id:
        stop = await db.get(TourStop, label.tour_stop_id)
        if stop:
            assign_check = await db.execute(
                select(DeviceAssignment).where(
                    DeviceAssignment.tour_id == stop.tour_id,
                    DeviceAssignment.device_id == device.id,
                ).limit(1)
            )
            if not assign_check.scalar_one_or_none():
                raise HTTPException(status_code=403, detail="Device not assigned to this tour")

    if label.status == LabelStatus.PICKED_UP:
        return label  # deja scanne / already scanned
    if label.status == LabelStatus.RECEIVED:
        raise HTTPException(status_code=400, detail="Label already received")

    label.status = LabelStatus.PICKED_UP
    label.picked_up_at = _now_iso()
    label.picked_up_device_id = device.id

    # Mouvement traçabilité + décrémentation stock PDV / Movement traceability + PDV stock decrement
    # Stock en unites individuelles (palettes, bacs) — 1 etiquette = unit_quantity unites
    unit_qty = label.pickup_request.support_type.unit_quantity if label.pickup_request.support_type else 1
    db.add(PickupMovement(
        pickup_label_id=label.id, movement_type=MovementType.PICKED_UP,
        timestamp=_now_iso(), device_id=device.id,
    ))
    from app.api.pickup_requests import _update_pdv_stock_on_pickup
    await _update_pdv_stock_on_pickup(db, label.pickup_request.pdv_id, label.pickup_request.support_type_id, delta=-unit_qty)

    # Auto-progression demande parent / Auto-progress parent request
    from app.api.pickup_requests import _auto_progress_request
    _auto_progress_request(label.pickup_request)

    await db.flush()
    await db.refresh(label)
    return label


@router.post("/tour/{tour_id}/stops/{stop_id}/refuse-pickup")
async def refuse_pickup(
    tour_id: int,
    stop_id: int,
    data: PickupRefusalCreate,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(require_device_tour_access),
):
    """Refuser les reprises pour un stop / Refuse pickups for a stop."""
    stop = await db.get(TourStop, stop_id)
    if not stop or stop.tour_id != tour_id:
        raise HTTPException(status_code=404, detail="Stop not found")

    # Chercher les etiquettes PENDING/PLANNED liees au stop
    label_result = await db.execute(
        select(PickupLabel)
        .where(
            PickupLabel.tour_stop_id == stop_id,
            PickupLabel.status.in_([LabelStatus.PLANNED, LabelStatus.PENDING]),
        )
        .options(selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.labels))
    )
    labels = label_result.scalars().all()

    if not labels:
        return {"status": "ok", "refused": 0}

    # Creer alerte PICKUP_REFUSED / Create PICKUP_REFUSED alert
    alert = DeliveryAlert(
        tour_id=tour_id,
        tour_stop_id=stop_id,
        alert_type=AlertType.PICKUP_REFUSED,
        severity=AlertSeverity.WARNING,
        message=data.reason,
        created_at=_now_iso(),
        device_id=device.id,
    )
    db.add(alert)

    # Delier les etiquettes : retour pool non-assigne / Unlink labels: return to unassigned pool
    from app.api.pickup_requests import _auto_progress_request
    requests_seen: set[int] = set()
    for label in labels:
        label.tour_stop_id = None
        label.status = LabelStatus.PENDING
        requests_seen.add(label.pickup_request_id)
        # Mouvement traçabilité refus / Refusal traceability movement
        db.add(PickupMovement(
            pickup_label_id=label.id, movement_type=MovementType.REFUSED,
            timestamp=_now_iso(), device_id=device.id, notes=data.reason,
        ))

    # Auto-progression demandes parentes / Auto-progress parent requests
    for label in labels:
        if label.pickup_request_id in requests_seen:
            _auto_progress_request(label.pickup_request)
            requests_seen.discard(label.pickup_request_id)

    await db.flush()

    # Broadcast WebSocket alert
    await manager.broadcast(tenant_id=device.tenant_id, message={
        "type": "alert",
        "alert_type": "PICKUP_REFUSED",
        "tour_id": tour_id,
        "stop_id": stop_id,
        "message": data.reason,
    })

    return {"status": "ok", "refused": len(labels)}


# ─── Scan reprise autonome (hors tour) / Standalone pickup scanning (no tour) ───


@router.post("/standalone-pickup/{label_code}", response_model=PickupLabelRead)
async def standalone_pickup_scan(
    label_code: str,
    pdv_code: str | None = Query(None, description="Code PDV scanné (contrôle d'appartenance, ticket #11)"),
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Scan reprise autonome sans tour / Standalone pickup scan without tour.
    Permet au chauffeur de scanner une etiquette hors planning tour.
    """
    _check_device_feature(device, "pickups")
    result = await db.execute(
        select(PickupLabel)
        .where(PickupLabel.label_code == label_code)
        .options(
            selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.labels),
            selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.support_type),
            selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.pdv),
        )
    )
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")

    # Ticket #11 : l'étiquette doit appartenir au PDV scanné / Label must belong to scanned PDV
    if label.pickup_request and label.pickup_request.pdv and not _pdv_codes_match(pdv_code, label.pickup_request.pdv.code):
        raise HTTPException(
            status_code=409,
            detail=f"Cette etiquette appartient au PDV {label.pickup_request.pdv.code} — "
                   f"{label.pickup_request.pdv.name}, pas au PDV scanne ({pdv_code}). Scannez le bon PDV.",
        )

    if label.status == LabelStatus.CANCELLED:
        raise HTTPException(status_code=400, detail="Etiquette annulee — la demande a ete modifiee. Detruisez cette etiquette.")

    # Verifier regle support/base / Check base support rule
    if label.pickup_request:
        await _check_base_support_allowed(device, label.pickup_request.support_type_id, db)

    # Idempotent si deja PICKED_UP / Idempotent if already PICKED_UP
    if label.status == LabelStatus.PICKED_UP:
        return label

    if label.status == LabelStatus.RECEIVED:
        raise HTTPException(status_code=400, detail="Label already received")

    label.status = LabelStatus.PICKED_UP
    label.picked_up_at = _now_iso()
    label.picked_up_device_id = device.id

    # Mouvement traçabilité + décrémentation stock PDV / Movement traceability + PDV stock decrement
    # Stock en unites individuelles (palettes, bacs) — 1 etiquette = unit_quantity unites
    unit_qty = label.pickup_request.support_type.unit_quantity if label.pickup_request.support_type else 1
    db.add(PickupMovement(
        pickup_label_id=label.id, movement_type=MovementType.PICKED_UP,
        timestamp=_now_iso(), device_id=device.id,
    ))
    from app.api.pickup_requests import _update_pdv_stock_on_pickup
    await _update_pdv_stock_on_pickup(db, label.pickup_request.pdv_id, label.pickup_request.support_type_id, delta=-unit_qty)

    # Auto-progression demande parent / Auto-progress parent request
    from app.api.pickup_requests import _auto_progress_request
    _auto_progress_request(label.pickup_request)

    # Audit log
    db.add(AuditLog(
        entity_type="pickup_label", entity_id=label.id, action="STANDALONE_PICKUP",
        changes=f'{{"label_code":"{label_code}","device_id":{device.id}}}',
        user=f"device:{device.id}",
        timestamp=_now_iso(),
    ))

    await db.flush()
    await db.refresh(label)
    return label


@router.get("/standalone-pickups")
async def list_standalone_pickups(
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Reprises autonomes du jour / Today's standalone pickups for this device."""
    _check_device_feature(device, "pickups")
    from app.models.support_type import SupportType

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    result = await db.execute(
        select(
            PickupLabel.label_code,
            PickupLabel.status,
            PickupLabel.picked_up_at,
            PDV.code.label("pdv_code"),
            PDV.name.label("pdv_name"),
            SupportType.code.label("support_type_code"),
            SupportType.name.label("support_type_name"),
            PickupRequest.pickup_type,
            PickupRequest.with_content,
            PickupRequest.declared_unit_value,
            PickupRequest.quantity,
        )
        .join(PickupRequest, PickupLabel.pickup_request_id == PickupRequest.id)
        .join(PDV, PickupRequest.pdv_id == PDV.id)
        .join(SupportType, PickupRequest.support_type_id == SupportType.id)
        .where(
            PickupLabel.picked_up_device_id == device.id,
            PickupLabel.picked_up_at.like(f"{today}%"),
        )
        .order_by(PickupLabel.picked_up_at.desc())
    )
    rows = result.all()

    return [
        {
            "label_code": row.label_code,
            "status": row.status.value if hasattr(row.status, "value") else row.status,
            "picked_up_at": row.picked_up_at,
            "pdv_code": row.pdv_code,
            "pdv_name": row.pdv_name,
            "support_type_code": row.support_type_code,
            "support_type_name": row.support_type_name,
            "pickup_type": row.pickup_type.value if hasattr(row.pickup_type, "value") else row.pickup_type,
            "with_content": row.with_content,
            "declared_unit_value": float(row.declared_unit_value) if row.declared_unit_value is not None else None,
            "quantity": row.quantity,
        }
        for row in rows
    ]


# ─── Reception base / Base reception ───


@router.post("/base-receive/{label_code}", response_model=PickupLabelRead)
async def base_receive_scan(
    label_code: str,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Scan reception base via mobile / Base reception scan via mobile device.
    Passe l'etiquette en RECEIVED avec horodatage.
    """
    _check_device_feature(device, "base_reception")
    result = await db.execute(
        select(PickupLabel)
        .where(PickupLabel.label_code == label_code)
        .options(selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.labels))
    )
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")

    if label.status == LabelStatus.CANCELLED:
        raise HTTPException(status_code=400, detail="Etiquette annulee — la demande a ete modifiee. Detruisez cette etiquette.")

    # Idempotent si deja RECEIVED / Idempotent if already RECEIVED
    if label.status == LabelStatus.RECEIVED:
        return label

    label.status = LabelStatus.RECEIVED
    label.received_at = _now_iso()
    label.received_device_id = device.id

    # Mouvement traçabilité / Traceability movement
    db.add(PickupMovement(
        pickup_label_id=label.id, movement_type=MovementType.RECEIVED,
        timestamp=_now_iso(), device_id=device.id,
    ))

    # Auto-progression demande parent / Auto-progress parent request
    from app.api.pickup_requests import _auto_progress_request
    _auto_progress_request(label.pickup_request)

    # Increment stock base sur reception / Increment base stock on reception
    if device.base_id and label.pickup_request:
        req = label.pickup_request
        # Charger support_type si pas deja charge / Load support_type if not loaded
        from app.models.support_type import SupportType as ST
        st_result = await db.execute(select(ST).where(ST.id == req.support_type_id))
        st = st_result.scalar_one_or_none()
        unit_qty = st.unit_quantity if st else 1
        from app.api.base_container_stock import increment_base_stock_on_receive
        await increment_base_stock_on_receive(
            db, device.base_id, req.support_type_id, unit_qty,
            label_code, device_id=device.id,
        )

    # Audit log
    db.add(AuditLog(
        entity_type="pickup_label", entity_id=label.id, action="BASE_RECEIVE",
        changes=f'{{"label_code":"{label_code}","device_id":{device.id}}}',
        user=f"device:{device.id}",
        timestamp=_now_iso(),
    ))

    await db.flush()
    await db.refresh(label)
    return label


@router.get("/base-receives")
async def list_base_receives(
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Receptions base du jour / Today's base receives for this device."""
    _check_device_feature(device, "base_reception")
    from app.models.support_type import SupportType

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    result = await db.execute(
        select(
            PickupLabel.label_code,
            PickupLabel.status,
            PickupLabel.received_at,
            PDV.code.label("pdv_code"),
            PDV.name.label("pdv_name"),
            SupportType.code.label("support_type_code"),
            SupportType.name.label("support_type_name"),
            PickupRequest.pickup_type,
            PickupRequest.with_content,
            PickupRequest.declared_unit_value,
            PickupRequest.quantity,
        )
        .join(PickupRequest, PickupLabel.pickup_request_id == PickupRequest.id)
        .join(PDV, PickupRequest.pdv_id == PDV.id)
        .join(SupportType, PickupRequest.support_type_id == SupportType.id)
        .where(
            PickupLabel.status == LabelStatus.RECEIVED,
            PickupLabel.received_at.like(f"{today}%"),
        )
        .order_by(PickupLabel.received_at.desc())
    )
    rows = result.all()

    return [
        {
            "label_code": row.label_code,
            "status": row.status.value if hasattr(row.status, "value") else row.status,
            "received_at": row.received_at,
            "pdv_code": row.pdv_code,
            "pdv_name": row.pdv_name,
            "support_type_code": row.support_type_code,
            "support_type_name": row.support_type_name,
            "pickup_type": row.pickup_type.value if hasattr(row.pickup_type, "value") else row.pickup_type,
            "with_content": row.with_content,
            "declared_unit_value": float(row.declared_unit_value) if row.declared_unit_value is not None else None,
            "quantity": row.quantity,
        }
        for row in rows
    ]


# ─── Inventaire PDV / PDV Inventory ───


@router.post("/inventory-lookup")
async def inventory_lookup(
    data: dict,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Rechercher un PDV par code + lister les types de support actifs / Lookup PDV by code + list active support types."""
    _check_device_feature(device, "inventory")
    from app.models.support_type import SupportType

    pdv_code = (data.get("pdv_code") or "").strip()
    if not pdv_code:
        raise HTTPException(status_code=422, detail="pdv_code requis")

    result = await db.execute(select(PDV).where(PDV.code == pdv_code))
    pdv = result.scalar_one_or_none()
    if not pdv:
        raise HTTPException(status_code=404, detail="PDV non trouvé")
    # Ticket #14 : une tablette magasin ne peut interroger que SON PDV.
    _enforce_device_pdv_scope(device, pdv)

    st_result = await db.execute(
        select(SupportType).where(SupportType.is_active == True).order_by(SupportType.code)
    )
    # Restreindre aux supports de retour autorisés (ticket #8) : CO/PA/PL/RE + SF 40040/40104/40204.
    # Exclut notamment les casiers à bière (SF 3xxxx) qui relèvent du flux consignes dédié.
    support_types = [st for st in st_result.scalars().all() if is_return_support_code(st.code)]

    return {
        "pdv": {"id": pdv.id, "code": pdv.code, "name": pdv.name},
        "support_types": [
            {
                "id": st.id, "code": st.code, "name": st.name,
                "unit_quantity": st.unit_quantity, "unit_label": st.unit_label,
                "is_combi": st.is_combi,
            }
            for st in support_types
        ],
    }


@router.post("/inventory")
async def submit_inventory(
    data: InventorySubmit,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Soumettre un inventaire PDV depuis la tablette / Submit PDV inventory from tablet.

    Ticket #8 : refuse les supports hors périmètre retour (seuls CO/PA/PL/RE + SF 40040/40104/40204).
    Ticket #10 : si `create_requests`, crée en plus une demande de reprise CMRO par ligne
    (quantité > 0) et renvoie les étiquettes générées pour impression (#7).
    """
    _check_device_feature(device, "inventory")
    from app.models.pdv_inventory import PdvInventory, PdvStock

    pdv = await db.get(PDV, data.pdv_id)
    if not pdv:
        raise HTTPException(status_code=404, detail="PDV not found")

    # Valider que tous les supports encodés sont autorisés (ticket #8) /
    # Validate every encoded support is allowed for returns (ticket #8)
    st_ids = {line.support_type_id for line in data.lines}
    st_map: dict[int, SupportType] = {}
    if st_ids:
        st_rows = (await db.execute(
            select(SupportType).where(SupportType.id.in_(st_ids))
        )).scalars().all()
        st_map = {st.id: st for st in st_rows}
    for line in data.lines:
        st = st_map.get(line.support_type_id)
        if st is None:
            raise HTTPException(status_code=404, detail=f"Type de support {line.support_type_id} introuvable")
        if not is_return_support_code(st.code):
            raise HTTPException(
                status_code=400,
                detail=f"Support non autorisé à l'encodage de retours : {st.name}",
            )

    now = _now_iso()
    driver_name = data.inventoried_by or ""

    for line in data.lines:
        # Créer l'enregistrement d'inventaire / Create inventory record
        inv = PdvInventory(
            pdv_id=data.pdv_id,
            support_type_id=line.support_type_id,
            quantity=line.quantity,
            inventoried_at=now,
            device_id=device.id,
            inventoried_by=driver_name,
        )
        db.add(inv)

        # Mettre à jour le stock courant / Update current stock
        stock_result = await db.execute(
            select(PdvStock).where(
                PdvStock.pdv_id == data.pdv_id,
                PdvStock.support_type_id == line.support_type_id,
            )
        )
        stock = stock_result.scalar_one_or_none()
        if stock:
            stock.current_stock = line.quantity
            stock.last_inventory_at = now
            stock.last_inventory_device_id = device.id
            stock.last_inventoried_by = driver_name
        else:
            stock = PdvStock(
                pdv_id=data.pdv_id,
                support_type_id=line.support_type_id,
                current_stock=line.quantity,
                last_inventory_at=now,
                last_inventory_device_id=device.id,
                last_inventoried_by=driver_name,
            )
            db.add(stock)

    # Audit log
    db.add(AuditLog(
        entity_type="pdv_inventory", entity_id=data.pdv_id, action="INVENTORY_SUBMITTED",
        changes=f'{{"pdv_id":{data.pdv_id},"lines":{len(data.lines)},"device_id":{device.id},"by":"{driver_name}"}}',
        user=f"device:{device.id}",
        timestamp=now,
    ))

    await db.flush()

    # Ticket #10 : créer les demandes de reprise CMRO à la validation /
    # Create CMRO pickup requests on validation
    created_requests: list[dict] = []
    if data.create_requests:
        if not device.pdv_id:
            raise HTTPException(status_code=403, detail="Appareil non rattaché à un PDV")
        if device.pdv_id != data.pdv_id:
            raise HTTPException(status_code=403, detail="Le PDV inventorié ne correspond pas à la tablette")

        from app.api.pickup_requests import _do_create_pickup_request
        from app.schemas.pickup import PickupRequestCreate

        # Palette support par défaut pour les balles (ticket #12 : Pal Loc 80*120 PA 22020) /
        # Default pallet support for bales
        balle_pallet = (await db.execute(
            select(SupportType).where(SupportType.code.in_(["PA 22020", "PA22020"]))
        )).scalars().first()

        avail_date = data.availability_date or (
            (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")
        )
        for line in data.lines:
            if line.quantity <= 0:
                continue
            st = st_map[line.support_type_id]
            pickup_type = pickup_type_for_support_code(st.code)
            pallet_id = balle_pallet.id if (pickup_type == "CARDBOARD" and balle_pallet) else None
            req = await _do_create_pickup_request(
                db,
                PickupRequestCreate(
                    pdv_id=data.pdv_id,
                    support_type_id=line.support_type_id,
                    quantity=line.quantity,
                    availability_date=avail_date,
                    pickup_type=pickup_type,
                    pallet_support_type_id=pallet_id,
                    notes=f"Créé depuis l'inventaire PDV ({driver_name})" if driver_name else "Créé depuis l'inventaire PDV",
                ),
                device_id=device.id,
            )
            created_requests.append({
                "id": req.id,
                "support_type_id": req.support_type_id,
                "support_type_name": st.name,
                "quantity": req.quantity,
                "pickup_type": req.pickup_type.value if hasattr(req.pickup_type, "value") else req.pickup_type,
                "labels": [
                    {"label_id": lb.id, "label_code": lb.label_code, "sequence_number": lb.sequence_number}
                    for lb in sorted(req.labels or [], key=lambda x: x.sequence_number)
                ],
            })

    return {
        "status": "ok",
        "pdv_id": data.pdv_id,
        "pdv_code": pdv.code,
        "pdv_name": pdv.name,
        "lines": len(data.lines),
        "requests_created": len(created_requests),
        "requests": created_requests,
    }


# ─── Inventaire base mobile / Mobile base inventory ───

@router.post("/base-inventory-setup")
async def base_inventory_setup(
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Charger infos base + zones + types de support / Load base info + zones + support types."""
    _check_device_feature(device, "inventory")
    from app.models.support_type import SupportType
    from app.models.base_zone import BaseZone

    if not device.base_id:
        raise HTTPException(status_code=400, detail="Appareil non rattache a une base")

    base = await db.get(BaseLogistics, device.base_id)
    if not base:
        raise HTTPException(status_code=404, detail="Base non trouvee")

    zones = (await db.execute(
        select(BaseZone).where(BaseZone.base_id == base.id, BaseZone.is_active == True).order_by(BaseZone.code)
    )).scalars().all()

    support_types = (await db.execute(
        select(SupportType).where(SupportType.is_active == True).order_by(SupportType.code)
    )).scalars().all()

    return {
        "base": {"id": base.id, "code": base.code, "name": base.name},
        "zones": [{"id": z.id, "code": z.code, "name": z.name} for z in zones],
        "support_types": [
            {
                "id": st.id, "code": st.code, "name": st.name,
                "unit_quantity": st.unit_quantity, "unit_label": st.unit_label,
                "supplier_plant": st.supplier_plant,
            }
            for st in support_types
        ],
    }


@router.post("/base-inventory")
async def submit_base_inventory(
    data: dict,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Soumettre un inventaire base / Submit base inventory from mobile."""
    _check_device_feature(device, "inventory")
    from app.models.base_container_stock import BaseContainerStock, BaseContainerMovement, BaseMovementType

    if not device.base_id:
        raise HTTPException(status_code=400, detail="Appareil non rattache a une base")

    zone_id = data.get("zone_id")  # nullable
    inventory_type = data.get("inventory_type", "COMPLEMENT")
    lines = data.get("lines", [])
    inventoried_by = data.get("inventoried_by", "")

    if not lines:
        raise HTTPException(status_code=422, detail="Aucune ligne d'inventaire")

    now = _now_iso()
    updated = 0

    for line in lines:
        st_id = line.get("support_type_id")
        qty = line.get("quantity", 0)
        if st_id is None:
            continue

        # Trouver ou creer le stock par base × zone × support / Find or create
        result = await db.execute(
            select(BaseContainerStock).where(
                BaseContainerStock.base_id == device.base_id,
                BaseContainerStock.support_type_id == st_id,
                BaseContainerStock.zone_id == zone_id,
            )
        )
        stock = result.scalar_one_or_none()
        old_qty = stock.current_stock if stock else 0

        if stock:
            stock.current_stock = qty
            stock.last_updated_at = now
        else:
            stock = BaseContainerStock(
                base_id=device.base_id,
                zone_id=zone_id,
                support_type_id=st_id,
                current_stock=qty,
                last_updated_at=now,
            )
            db.add(stock)

        # Mouvement / Movement
        delta = qty - old_qty
        if delta != 0:
            db.add(BaseContainerMovement(
                base_id=device.base_id,
                zone_id=zone_id,
                support_type_id=st_id,
                movement_type=BaseMovementType.BASE_INVENTORY,
                inventory_type=inventory_type,
                quantity=delta,
                reference=f"Inventaire {inventory_type} ({old_qty} -> {qty})",
                timestamp=now,
                device_id=device.id,
                notes=f"Par: {inventoried_by}" if inventoried_by else None,
            ))
        updated += 1

    # Audit log
    db.add(AuditLog(
        entity_type="base_inventory", entity_id=device.base_id, action="BASE_INVENTORY_SUBMITTED",
        changes=f'{{"base_id":{device.base_id},"zone_id":{zone_id},"type":"{inventory_type}","lines":{len(lines)},"device_id":{device.id}}}',
        user=f"device:{device.id}",
        timestamp=now,
    ))

    await db.flush()
    return {"status": "ok", "base_id": device.base_id, "zone_id": zone_id, "lines": updated}


# ─── Mode kiosque / Kiosk mode ───

# Mot de passe kiosque depuis env / Kiosk password from environment
KIOSK_PASSWORD = os.environ.get("KIOSK_PASSWORD", "cmro2026")


@router.post("/verify-kiosk-password")
async def verify_kiosk_password(
    data: dict,
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Verifier mot de passe kiosque / Verify kiosk password."""
    password = data.get("password", "")
    return {"valid": password == KIOSK_PASSWORD}


# ═══════════════════════════════════════════════════════════════════
# Scans combis / Combi scans
# ═══════════════════════════════════════════════════════════════════


@router.post("/combi-scan/", response_model=CombiScanRead)
async def scan_combi_at_pdv(
    data: CombiScanCreate,
    device: MobileDevice = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
):
    """Scan d'un combi au PDV par le chauffeur / Scan a combi at PDV by driver.
    Le chauffeur a prealablement scanne le code-barres PDV pour identifier le point de vente.

    Workflow combi : pickup_label_id obligatoire (obtenu via /pickup-labels/{code}/scan-arrival).
    Le scan est lie a l'etiquette de declaration active. Idempotent : meme barcode rescanne
    sur la meme etiquette retourne le scan existant.
    """
    _check_device_feature(device, "pickups")

    # Verifier si la base accepte les combis / Check if base accepts combis
    await _check_base_combi_allowed(device, db)

    # Resoudre le PDV depuis le code scanne (essayer tel quel + zero-padded)
    pdv_code = data.pdv_code_scanned.strip()
    result = await db.execute(select(PDV).where(PDV.code == pdv_code))
    pdv = result.scalar_one_or_none()
    if not pdv:
        # Essayer avec zero-padding (ex: "2805" -> "02805")
        padded = pdv_code.zfill(5)
        result = await db.execute(select(PDV).where(PDV.code == padded))
        pdv = result.scalar_one_or_none()
    if not pdv:
        raise HTTPException(status_code=404, detail=f"PDV inconnu: {pdv_code}")
    # Ticket #14 : une tablette rattachée à un PDV ne scanne que pour son PDV
    # (les chauffeurs, sans pdv_id, restent libres de scanner sur toute leur tournée).
    _enforce_device_pdv_scope(device, pdv)

    # Validation pickup_label_id obligatoire / pickup_label_id is required
    if data.pickup_label_id is None:
        raise HTTPException(
            status_code=400,
            detail="Scannez d'abord l'etiquette de declaration combi (QR) avant les combis",
        )

    label_result = await db.execute(
        select(PickupLabel)
        .where(PickupLabel.id == data.pickup_label_id)
        .options(selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.support_type))
    )
    label = label_result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Etiquette de declaration introuvable")
    if not label.pickup_request or not label.pickup_request.support_type or not label.pickup_request.support_type.is_combi:
        raise HTTPException(status_code=400, detail="L'etiquette fournie n'est pas une etiquette combi")
    if label.pickup_request.pdv_id != pdv.id:
        raise HTTPException(
            status_code=400,
            detail="L'etiquette ne correspond pas au PDV scanne",
        )
    if label.status not in (LabelStatus.PENDING, LabelStatus.PLANNED):
        raise HTTPException(
            status_code=409,
            detail="La declaration n'est plus active (deja cloturee ou annulee)",
        )

    barcode = data.barcode.strip().upper()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Idempotence : si meme barcode deja scanne sur cette etiquette, retourner le scan existant /
    # Idempotency: same barcode already scanned on this label -> return existing
    existing_result = await db.execute(
        select(CombiScan).where(
            CombiScan.barcode == barcode,
            CombiScan.pickup_label_id == label.id,
            CombiScan.scan_context == ScanContext.PICKUP,
        ).limit(1)
    )
    existing = existing_result.scalar_one_or_none()
    if existing:
        return CombiScanRead(
            id=existing.id,
            barcode=existing.barcode,
            scan_context=existing.scan_context.value,
            pdv_id=existing.pdv_id,
            pdv_code_scanned=existing.pdv_code_scanned,
            pdv_name=pdv.name,
            device_id=existing.device_id,
            timestamp=existing.timestamp,
            latitude=existing.latitude,
            longitude=existing.longitude,
            accuracy=existing.accuracy,
            scan_date=existing.scan_date,
            pickup_label_id=existing.pickup_label_id,
        )

    scan = CombiScan(
        barcode=barcode,
        scan_context=ScanContext.PICKUP,
        pdv_id=pdv.id,
        pdv_code_scanned=pdv.code,
        device_id=device.id,
        timestamp=data.timestamp,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy=data.accuracy,
        scan_date=today,
        pickup_label_id=label.id,
    )
    db.add(scan)
    await db.flush()

    return CombiScanRead(
        id=scan.id,
        barcode=scan.barcode,
        scan_context=scan.scan_context.value,
        pdv_id=scan.pdv_id,
        pdv_code_scanned=scan.pdv_code_scanned,
        pdv_name=pdv.name,
        device_id=scan.device_id,
        timestamp=scan.timestamp,
        latitude=scan.latitude,
        longitude=scan.longitude,
        accuracy=scan.accuracy,
        scan_date=scan.scan_date,
        pickup_label_id=scan.pickup_label_id,
    )


@router.post("/pickup-labels/{label_code}/close-combi-pickup", response_model=CombiPickupCloseRead)
async def close_combi_pickup(
    label_code: str,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Cloturer la reprise combi a un PDV / Close combi pickup at PDV.

    Le chauffeur a fini de scanner les combis. Cet endpoint :
    - Compte les CombiScan PICKUP lies a cette etiquette
    - Fixe PickupRequest.actual_picked_quantity = ce nombre
    - Marque PickupLabel.status = PICKED_UP, PickupRequest.status = PICKED_UP
    - Decremente le stock PDV de actual_picked_quantity
    - Trace le mouvement
    Idempotent : si deja cloture (PICKED_UP), retourne le recap sans rien changer.
    """
    _check_device_feature(device, "pickups")

    if not _PICKUP_LABEL_CODE_RE.match(label_code):
        raise HTTPException(status_code=400, detail="Format de code etiquette invalide")

    result = await db.execute(
        select(PickupLabel)
        .where(PickupLabel.label_code == label_code)
        .options(
            selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.support_type),
            selectinload(PickupLabel.combi_scans),
        )
    )
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Etiquette inconnue")

    pickup_req = label.pickup_request
    if not pickup_req or not pickup_req.support_type or not pickup_req.support_type.is_combi:
        raise HTTPException(status_code=400, detail="Cette etiquette n'est pas une etiquette de declaration combi")

    if label.status == LabelStatus.CANCELLED:
        raise HTTPException(status_code=400, detail="Etiquette annulee")

    # Compter les scans PICKUP lies / Count PICKUP scans linked
    actual_picked = sum(
        1 for s in label.combi_scans if s.scan_context == ScanContext.PICKUP
    )

    # Idempotence : deja cloture / Idempotency: already closed
    if label.status in (LabelStatus.PICKED_UP, LabelStatus.RECEIVED):
        return CombiPickupCloseRead(
            pickup_request_id=pickup_req.id,
            label_id=label.id,
            label_code=label.label_code,
            declared_quantity=pickup_req.quantity,
            actual_picked_quantity=pickup_req.actual_picked_quantity or actual_picked,
            pickup_ratio=(
                (pickup_req.actual_picked_quantity or actual_picked) / pickup_req.quantity
                if pickup_req.quantity > 0 else 0.0
            ),
        )

    # Cloture / Closure
    label.status = LabelStatus.PICKED_UP
    label.picked_up_at = _now_iso()
    label.picked_up_device_id = device.id
    pickup_req.actual_picked_quantity = actual_picked
    pickup_req.status = PickupStatus.PICKED_UP

    db.add(PickupMovement(
        pickup_label_id=label.id,
        movement_type=MovementType.PICKED_UP,
        timestamp=_now_iso(),
        device_id=device.id,
        notes=f"Cloture reprise combi : {actual_picked}/{pickup_req.quantity} scannes",
    ))

    # Decrementer stock PDV / Decrement PDV stock
    if actual_picked > 0:
        from app.api.pickup_requests import _update_pdv_stock_on_pickup
        await _update_pdv_stock_on_pickup(
            db, pickup_req.pdv_id, pickup_req.support_type_id, delta=-actual_picked,
        )

    await db.flush()

    ratio = actual_picked / pickup_req.quantity if pickup_req.quantity > 0 else 0.0
    return CombiPickupCloseRead(
        pickup_request_id=pickup_req.id,
        label_id=label.id,
        label_code=label.label_code,
        declared_quantity=pickup_req.quantity,
        actual_picked_quantity=actual_picked,
        pickup_ratio=round(ratio, 4),
    )


@router.get("/combi-scans/", response_model=list[CombiScanRead])
async def list_combi_scans_today(
    device: MobileDevice = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
):
    """Liste des scans combi du jour pour cet appareil / Today's combi scans for this device."""
    _check_device_feature(device, "pickups")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    result = await db.execute(
        select(CombiScan)
        .where(
            CombiScan.device_id == device.id,
            CombiScan.scan_date == today,
            CombiScan.scan_context == ScanContext.PICKUP,
        )
        .order_by(CombiScan.id.desc())
    )
    scans = result.scalars().all()

    # Charger les noms PDV
    pdv_ids = {s.pdv_id for s in scans if s.pdv_id}
    pdv_names: dict[int, str] = {}
    if pdv_ids:
        pdv_result = await db.execute(select(PDV.id, PDV.name).where(PDV.id.in_(pdv_ids)))
        pdv_names = {row[0]: row[1] for row in pdv_result.all()}

    return [
        CombiScanRead(
            id=s.id,
            barcode=s.barcode,
            scan_context=s.scan_context.value,
            pdv_id=s.pdv_id,
            pdv_code_scanned=s.pdv_code_scanned,
            pdv_name=pdv_names.get(s.pdv_id) if s.pdv_id else None,
            device_id=s.device_id,
            timestamp=s.timestamp,
            latitude=s.latitude,
            longitude=s.longitude,
            accuracy=s.accuracy,
            scan_date=s.scan_date,
            pickup_label_id=s.pickup_label_id,
        )
        for s in scans
    ]


@router.post("/combi-receive/", response_model=CombiScanRead)
async def receive_combi_at_base(
    data: CombiReceiveCreate,
    device: MobileDevice = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
):
    """Re-scan d'un combi a la base / Combi re-scan at base reception."""
    _check_device_feature(device, "base_reception")

    barcode = data.barcode.strip().upper()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Trouver le scan chauffeur correspondant (meme barcode, contexte PICKUP)
    pickup_result = await db.execute(
        select(CombiScan)
        .where(
            CombiScan.barcode == barcode,
            CombiScan.scan_context == ScanContext.PICKUP,
        )
        .order_by(CombiScan.id.desc())
        .limit(1)
    )
    pickup_scan = pickup_result.scalar_one_or_none()

    scan = CombiScan(
        barcode=barcode,
        scan_context=ScanContext.RECEPTION,
        pdv_id=pickup_scan.pdv_id if pickup_scan else None,
        pdv_code_scanned=pickup_scan.pdv_code_scanned if pickup_scan else None,
        device_id=device.id,
        timestamp=data.timestamp,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy=data.accuracy,
        scan_date=today,
        # Tracer le lien declaration combi original (si scan PICKUP existait) /
        # Trace original combi declaration link (if PICKUP scan existed)
        pickup_label_id=pickup_scan.pickup_label_id if pickup_scan else None,
    )
    db.add(scan)
    await db.flush()

    pdv_name = None
    if scan.pdv_id:
        pdv_r = await db.execute(select(PDV.name).where(PDV.id == scan.pdv_id))
        pdv_name = pdv_r.scalar_one_or_none()

    return CombiScanRead(
        id=scan.id,
        barcode=scan.barcode,
        scan_context=scan.scan_context.value,
        pdv_id=scan.pdv_id,
        pdv_code_scanned=scan.pdv_code_scanned,
        pdv_name=pdv_name,
        device_id=scan.device_id,
        timestamp=scan.timestamp,
        latitude=scan.latitude,
        longitude=scan.longitude,
        accuracy=scan.accuracy,
        scan_date=scan.scan_date,
        pickup_label_id=scan.pickup_label_id,
    )


@router.get("/combi-receives/", response_model=list[CombiScanRead])
async def list_combi_receives_today(
    device: MobileDevice = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
):
    """Liste des receptions combi du jour / Today's combi receptions at base."""
    _check_device_feature(device, "base_reception")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    result = await db.execute(
        select(CombiScan)
        .where(
            CombiScan.device_id == device.id,
            CombiScan.scan_date == today,
            CombiScan.scan_context == ScanContext.RECEPTION,
        )
        .order_by(CombiScan.id.desc())
    )
    scans = result.scalars().all()

    pdv_ids = {s.pdv_id for s in scans if s.pdv_id}
    pdv_names: dict[int, str] = {}
    if pdv_ids:
        pdv_r = await db.execute(select(PDV.id, PDV.name).where(PDV.id.in_(pdv_ids)))
        pdv_names = {row[0]: row[1] for row in pdv_r.all()}

    return [
        CombiScanRead(
            id=s.id,
            barcode=s.barcode,
            scan_context=s.scan_context.value,
            pdv_id=s.pdv_id,
            pdv_code_scanned=s.pdv_code_scanned,
            pdv_name=pdv_names.get(s.pdv_id) if s.pdv_id else None,
            device_id=s.device_id,
            timestamp=s.timestamp,
            latitude=s.latitude,
            longitude=s.longitude,
            accuracy=s.accuracy,
            scan_date=s.scan_date,
            pickup_label_id=s.pickup_label_id,
        )
        for s in scans
    ]


@router.get("/validate-pdv/{code}")
async def validate_pdv_code(
    code: str,
    device: MobileDevice = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
):
    """Valider un code PDV scanne / Validate a scanned PDV code.
    Pas besoin de permission pdvs:read - accessible par tout appareil enregistre.
    """
    pdv_code = code.strip()
    result = await db.execute(select(PDV).where(PDV.code == pdv_code))
    pdv = result.scalar_one_or_none()
    if not pdv:
        padded = pdv_code.zfill(5)
        result = await db.execute(select(PDV).where(PDV.code == padded))
        pdv = result.scalar_one_or_none()
    if not pdv:
        raise HTTPException(status_code=404, detail=f"PDV inconnu: {pdv_code}")
    # Ticket #14 : une tablette magasin ne valide que son propre code PDV
    # (empêche l'énumération/usurpation d'un autre PDV par simple saisie du numéro).
    _enforce_device_pdv_scope(device, pdv)
    return {"id": pdv.id, "code": pdv.code, "name": pdv.name, "city": pdv.city}


# ── Control mode ──────────────────────────────────────────────────────────────

CONTROL_PHOTOS_DIR = Path("data/photos/control")
MAX_CONTROL_PHOTO_SIZE = 5 * 1024 * 1024  # 5 MB


async def _resolve_control_mode(device: MobileDevice, db: AsyncSession) -> bool:
    """Resoudre le mode controle pour un appareil / Resolve control mode for a device.
    Priorite : per-device override > parametre regional > parametre global > false.
    """
    # 1. Override explicite par appareil
    if device.control_mode is not None:
        return device.control_mode

    # 2. Parametre regional (si appareil rattache a une base avec region)
    if device.base_id:
        base = await db.get(BaseLogistics, device.base_id)
        if base and base.region_id:
            result = await db.execute(
                select(Parameter).where(
                    Parameter.key == "control_mode_enabled",
                    Parameter.region_id == base.region_id,
                )
            )
            param = result.scalar_one_or_none()
            if param:
                return param.value.lower() == "true"

    # 3. Parametre global
    result = await db.execute(
        select(Parameter).where(
            Parameter.key == "control_mode_enabled",
            Parameter.region_id.is_(None),
        )
    )
    param = result.scalar_one_or_none()
    if param:
        return param.value.lower() == "true"

    return False


@router.post("/control-evidence", status_code=201)
async def upload_control_evidence(
    file: UploadFile = File(...),
    control_context: str = Form(...),
    pdv_code_scanned: str | None = Form(None),
    label_code: str | None = Form(None),
    combi_barcode: str | None = Form(None),
    latitude: float | None = Form(None),
    longitude: float | None = Form(None),
    accuracy: float | None = Form(None),
    timestamp: str = Form(...),
    device: MobileDevice = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
):
    """Upload preuve photographique de controle / Upload control photographic evidence."""
    # Valider le contexte
    try:
        ctx = ControlContext(control_context)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Contexte invalide: {control_context}")

    # Lire et valider la photo
    content = await file.read()
    if len(content) > MAX_CONTROL_PHOTO_SIZE:
        raise HTTPException(status_code=400, detail="Photo trop volumineuse (max 5 MB)")

    mime = file.content_type or "image/jpeg"
    if not mime.startswith("image/"):
        raise HTTPException(status_code=400, detail="Seules les images sont acceptees")

    # Resoudre le PDV si code fourni
    pdv_id: int | None = None
    if pdv_code_scanned:
        result = await db.execute(select(PDV).where(PDV.code == pdv_code_scanned))
        pdv = result.scalar_one_or_none()
        if not pdv:
            result = await db.execute(select(PDV).where(PDV.code == pdv_code_scanned.zfill(5)))
            pdv = result.scalar_one_or_none()
        if pdv:
            pdv_id = pdv.id

    # Sauvegarder la photo
    now = datetime.now(timezone.utc)
    scan_date = timestamp[:10] if len(timestamp) >= 10 else now.strftime("%Y-%m-%d")
    ext = mime.split("/")[-1].replace("jpeg", "jpg")
    unique_name = f"{uuid.uuid4().hex[:12]}.{ext}"
    photo_dir = CONTROL_PHOTOS_DIR / scan_date / str(device.id)
    photo_dir.mkdir(parents=True, exist_ok=True)
    file_path = photo_dir / unique_name
    file_path.write_bytes(content)

    evidence = ControlEvidence(
        control_context=ctx,
        device_id=device.id,
        pdv_id=pdv_id,
        pdv_code_scanned=pdv_code_scanned,
        label_code=label_code,
        combi_barcode=combi_barcode,
        latitude=latitude,
        longitude=longitude,
        accuracy=accuracy,
        photo_filename=file.filename or unique_name,
        photo_path=str(file_path),
        photo_size=len(content),
        photo_mime=mime,
        timestamp=timestamp,
        scan_date=scan_date,
        uploaded_at=now.isoformat(timespec="seconds"),
    )
    db.add(evidence)
    await db.flush()

    return {
        "id": evidence.id,
        "control_context": evidence.control_context.value,
        "scan_date": evidence.scan_date,
        "photo_filename": evidence.photo_filename,
    }
