"""Routes suivi temps reel web / Real-time web tracking routes."""

from datetime import date as date_cls, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.carrier import Carrier
from app.models.contract import Contract
from app.models.delivery_alert import DeliveryAlert
from app.models.gps_position import GPSPosition
from app.models.mobile_device import MobileDevice
from app.models.pdv import PDV
from app.models.stop_event import StopEvent
from app.models.support_scan import SupportScan
from app.models.tour import Tour, TourStatus
from app.models.tour_manifest_line import TourManifestLine
from app.models.tour_stop import TourStop
from app.models.base_logistics import BaseLogistics
from app.models.user import User
from app.schemas.mobile import (
    DeliveryAlertRead,
    DriverPositionRead,
    GPSPositionRead,
    SupportScanTraceRead,
    TrackingDashboard,
)
from app.utils.geo import haversine
from app.api.deps import require_permission, get_user_region_ids

router = APIRouter()


# Date operationnelle d'une tournee / A tour's operational date.
# `delivery_date` est nullable : elle n'est posee qu'a la planification, et
# seulement si le planificateur la transmet. Tout le reste du code lit
# `delivery_date or date` — le suivi doit faire pareil, sinon une tournee sans
# date de livraison disparait purement et simplement de la carte. /
# delivery_date is nullable; fall back to the tour's own date like the rest of
# the codebase does, or the tour vanishes from the live map.
def _tour_day():
    return func.coalesce(Tour.delivery_date, Tour.date)


@router.get("/positions", response_model=list[DriverPositionRead])
async def get_latest_positions(
    date: str | None = None,
    base_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tracking", "read")),
):
    """Derniere position GPS par tour actif / Latest GPS position per active tour."""
    target_date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Trouver les tours actifs / Find active tours
    query = select(Tour).where(
        _tour_day() == target_date,
        Tour.status.in_([TourStatus.IN_PROGRESS, TourStatus.VALIDATED, TourStatus.RETURNING]),
    )
    if base_id is not None:
        query = query.where(Tour.base_id == base_id)

    # Scope region
    region_ids = get_user_region_ids(user)
    if region_ids is not None:
        query = query.join(BaseLogistics, Tour.base_id == BaseLogistics.id).where(
            BaseLogistics.region_id.in_(region_ids)
        )

    result = await db.execute(query)
    tours = result.scalars().all()

    tour_ids = [t.id for t in tours]

    if not tour_ids:
        return []

    # Batch: derniere position GPS par tour / Latest GPS position per tour
    latest_ts = (
        select(GPSPosition.tour_id, func.max(GPSPosition.timestamp).label("max_ts"))
        .where(GPSPosition.tour_id.in_(tour_ids))
        .group_by(GPSPosition.tour_id)
        .subquery()
    )
    gps_result = await db.execute(
        select(GPSPosition).join(
            latest_ts,
            (GPSPosition.tour_id == latest_ts.c.tour_id) & (GPSPosition.timestamp == latest_ts.c.max_ts)
        )
    )
    gps_by_tour = {g.tour_id: g for g in gps_result.scalars().all()}

    # Batch: nombre total de stops par tour / Total stop counts per tour
    stops_total_result = await db.execute(
        select(TourStop.tour_id, func.count(TourStop.id))
        .where(TourStop.tour_id.in_(tour_ids))
        .group_by(TourStop.tour_id)
    )
    stops_total_map = dict(stops_total_result.all())

    # Batch: stops livres par tour / Delivered stop counts per tour
    stops_delivered_result = await db.execute(
        select(TourStop.tour_id, func.count(TourStop.id))
        .where(TourStop.tour_id.in_(tour_ids), TourStop.delivery_status == "DELIVERED")
        .group_by(TourStop.tour_id)
    )
    stops_delivered_map = dict(stops_delivered_result.all())

    positions = []
    for tour in tours:
        gps = gps_by_tour.get(tour.id)
        if not gps:
            continue

        total = stops_total_map.get(tour.id, 0)
        delivered = stops_delivered_map.get(tour.id, 0)

        positions.append(DriverPositionRead(
            tour_id=tour.id,
            tour_code=tour.code,
            driver_name=tour.driver_name,
            latitude=gps.latitude,
            longitude=gps.longitude,
            speed=gps.speed,
            accuracy=gps.accuracy,
            timestamp=gps.timestamp,
            stops_total=total,
            stops_delivered=delivered,
        ))

    return positions


@router.get("/tour/{tour_id}/trail", response_model=list[GPSPositionRead])
async def get_tour_trail(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tracking", "read")),
):
    """Trace GPS complete d'un tour / Full GPS trail for a tour."""
    result = await db.execute(
        select(GPSPosition)
        .where(GPSPosition.tour_id == tour_id)
        .order_by(GPSPosition.timestamp)
    )
    return result.scalars().all()


@router.get("/tour/{tour_id}/events")
async def get_tour_events(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tracking", "read")),
):
    """Tous les stop events d'un tour / All stop events for a tour."""
    # Trouver les stop_ids du tour
    stops_result = await db.execute(
        select(TourStop.id).where(TourStop.tour_id == tour_id)
    )
    stop_ids = [row[0] for row in stops_result.all()]
    if not stop_ids:
        return []

    result = await db.execute(
        select(StopEvent)
        .where(StopEvent.tour_stop_id.in_(stop_ids))
        .order_by(StopEvent.timestamp)
    )
    events = result.scalars().all()
    return [
        {
            "id": e.id,
            "tour_stop_id": e.tour_stop_id,
            "event_type": e.event_type.value if hasattr(e.event_type, "value") else e.event_type,
            "scanned_pdv_code": e.scanned_pdv_code,
            "latitude": e.latitude,
            "longitude": e.longitude,
            "timestamp": e.timestamp,
            "notes": e.notes,
            "forced": e.forced,
        }
        for e in events
    ]


@router.get("/alerts", response_model=list[DeliveryAlertRead])
async def get_alerts(
    date: str | None = None,
    severity: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tracking", "read")),
):
    """Alertes actives / Active alerts."""
    query = select(DeliveryAlert).where(DeliveryAlert.acknowledged_at.is_(None))
    if severity is not None:
        query = query.where(DeliveryAlert.severity == severity)
    if date is not None:
        # Filtrer par date de creation / Filter by creation date
        query = query.where(DeliveryAlert.created_at.like(f"{date}%"))
    query = query.order_by(DeliveryAlert.created_at.desc())
    result = await db.execute(query)
    return result.scalars().all()


@router.put("/alerts/{alert_id}/acknowledge", response_model=DeliveryAlertRead)
async def acknowledge_alert(
    alert_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tracking", "update")),
):
    """Acquitter une alerte / Acknowledge an alert."""
    alert = await db.get(DeliveryAlert, alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.acknowledged_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    alert.acknowledged_by = user.id
    await db.flush()
    return alert


@router.get("/active-stops")
async def get_active_stops(
    date: str | None = None,
    base_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tracking", "read")),
):
    """Stops des tours actifs avec infos PDV / Active tour stops with PDV info."""
    target_date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Meme filtre que get_latest_positions / Same filter as get_latest_positions
    query = (
        select(Tour)
        .where(
            _tour_day() == target_date,
            Tour.status.in_([TourStatus.IN_PROGRESS, TourStatus.VALIDATED, TourStatus.RETURNING]),
        )
        .options(selectinload(Tour.stops).selectinload(TourStop.pdv))
    )
    if base_id is not None:
        query = query.where(Tour.base_id == base_id)

    # Scope region
    region_ids = get_user_region_ids(user)
    if region_ids is not None:
        query = query.join(BaseLogistics, Tour.base_id == BaseLogistics.id).where(
            BaseLogistics.region_id.in_(region_ids)
        )

    result = await db.execute(query)
    tours = result.scalars().unique().all()

    data = []
    for tour in tours:
        stops_data = []
        for stop in tour.stops:
            pdv = stop.pdv
            stops_data.append({
                "stop_id": stop.id,
                "sequence_order": stop.sequence_order,
                "delivery_status": stop.delivery_status or "PENDING",
                "arrival_time": stop.arrival_time,
                "eqp_count": stop.eqp_count,
                "actual_arrival_time": stop.actual_arrival_time,
                "actual_departure_time": stop.actual_departure_time,
                "pdv_code": pdv.code if pdv else None,
                "pdv_name": pdv.name if pdv else None,
                "pdv_city": pdv.city if pdv else None,
                "pdv_latitude": pdv.latitude if pdv else None,
                "pdv_longitude": pdv.longitude if pdv else None,
                "pdv_delivery_window_start": pdv.delivery_window_start if pdv else None,
                "pdv_delivery_window_end": pdv.delivery_window_end if pdv else None,
            })
        data.append({
            "tour_id": tour.id,
            "tour_code": tour.code,
            "driver_name": tour.driver_name,
            "departure_time": tour.departure_time,
            "stops": stops_data,
        })

    return data


@router.get("/dashboard", response_model=TrackingDashboard)
async def get_dashboard(
    date: str | None = None,
    base_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tracking", "read")),
):
    """Stats resume (actifs, completes, retards, alertes) / Dashboard summary stats."""
    target_date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    base_query = select(Tour).where(_tour_day() == target_date)
    if base_id is not None:
        base_query = base_query.where(Tour.base_id == base_id)

    # Scope region
    region_ids = get_user_region_ids(user)
    if region_ids is not None:
        base_query = base_query.join(BaseLogistics, Tour.base_id == BaseLogistics.id).where(
            BaseLogistics.region_id.in_(region_ids)
        )

    result = await db.execute(base_query)
    tours = result.scalars().all()

    active = sum(1 for t in tours if t.status in (TourStatus.IN_PROGRESS, TourStatus.VALIDATED, TourStatus.RETURNING))
    completed = sum(1 for t in tours if t.status == TourStatus.COMPLETED)

    # Alertes actives non acquittees
    alert_count = await db.scalar(
        select(func.count(DeliveryAlert.id)).where(
            DeliveryAlert.acknowledged_at.is_(None),
            DeliveryAlert.created_at.like(f"{target_date}%"),
        )
    ) or 0

    return TrackingDashboard(
        active_tours=active,
        completed_tours=completed,
        delayed_tours=0,  # Sera calcule plus tard / Will be computed later
        active_alerts=alert_count,
    )


@router.get("/support-scans/", response_model=list[SupportScanTraceRead])
async def list_support_scans(
    date_from: str | None = None,
    date_to: str | None = None,
    barcode: str | None = None,
    pdv_id: int | None = None,
    carrier_id: int | None = None,
    tour_id: int | None = None,
    base_id: int | None = None,
    driver: str | None = None,
    only_geolocated: bool = False,
    limit: int = Query(1000, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tracking", "read")),
):
    """Ou a-t-on scanne quel support, quand, par qui et pour quel transporteur.

    Where each support was scanned, when, by whom, under which carrier.

    Le transporteur n'est pas porte par la tournee : il se deduit du contrat
    affecte (Tour -> Contract -> Carrier). Une tournee sans contrat est une
    tournee en propre — carrier_name reste vide, ce n'est pas une anomalie. /
    Carrier is derived from the tour's contract; no contract = own fleet.
    """
    query = (
        select(SupportScan, TourStop, Tour, PDV, Contract, Carrier, BaseLogistics, MobileDevice)
        .join(TourStop, SupportScan.tour_stop_id == TourStop.id)
        .join(Tour, TourStop.tour_id == Tour.id)
        .outerjoin(PDV, TourStop.pdv_id == PDV.id)
        .outerjoin(Contract, Tour.contract_id == Contract.id)
        .outerjoin(Carrier, Contract.carrier_id == Carrier.id)
        .outerjoin(BaseLogistics, Tour.base_id == BaseLogistics.id)
        .outerjoin(MobileDevice, SupportScan.device_id == MobileDevice.id)
    )

    # Bornes de dates sur le timestamp ISO : comparaison lexicographique, donc
    # borne haute = lendemain exclu (evite de rater les scans de fin de journee
    # et les fuseaux decales). / ISO timestamps compare lexicographically, so
    # the upper bound is the exclusive next day.
    if date_from:
        query = query.where(SupportScan.timestamp >= date_from)
    if date_to:
        try:
            next_day = (date_cls.fromisoformat(date_to) + timedelta(days=1)).isoformat()
        except ValueError:
            raise HTTPException(status_code=422, detail="date_to invalide (attendu AAAA-MM-JJ)")
        query = query.where(SupportScan.timestamp < next_day)

    if barcode:
        query = query.where(SupportScan.barcode.ilike(f"%{barcode.strip()}%"))
    if pdv_id is not None:
        query = query.where(TourStop.pdv_id == pdv_id)
    if tour_id is not None:
        query = query.where(Tour.id == tour_id)
    if base_id is not None:
        query = query.where(Tour.base_id == base_id)
    if driver:
        query = query.where(Tour.driver_name.ilike(f"%{driver.strip()}%"))
    if carrier_id is not None:
        query = query.where(Contract.carrier_id == carrier_id)
    if only_geolocated:
        query = query.where(SupportScan.latitude.is_not(None), SupportScan.longitude.is_not(None))

    # Scope region (meme regle que les positions temps reel) / Region scope
    region_ids = get_user_region_ids(user)
    if region_ids is not None:
        query = query.where(BaseLogistics.region_id.in_(region_ids))

    query = query.order_by(SupportScan.timestamp.desc(), SupportScan.id.desc()).limit(limit).offset(offset)
    rows = (await db.execute(query)).all()

    # PDV attendu au manifeste, charge en un coup pour la page / Expected PDV
    # from the WMS manifest, loaded in one go for the page.
    tour_ids = {t.id for _, _, t, *_ in rows}
    barcodes = {sc.barcode for sc, *_ in rows}
    expected_map: dict[tuple[int, str], str] = {}
    if tour_ids and barcodes:
        manifest_rows = (await db.execute(
            select(TourManifestLine.tour_id, TourManifestLine.support_number, TourManifestLine.pdv_code)
            .where(
                TourManifestLine.tour_id.in_(tour_ids),
                TourManifestLine.support_number.in_(barcodes),
            )
        )).all()
        expected_map = {(t_id, num): code for t_id, num, code in manifest_rows}

    results: list[SupportScanTraceRead] = []
    for scan, stop, tour, pdv, contract, carrier, base, device in rows:
        distance_m = None
        if (
            scan.latitude is not None and scan.longitude is not None
            and pdv is not None and pdv.latitude is not None and pdv.longitude is not None
        ):
            distance_m = round(
                haversine(scan.latitude, scan.longitude, pdv.latitude, pdv.longitude) * 1000, 1
            )

        results.append(SupportScanTraceRead(
            id=scan.id,
            barcode=scan.barcode,
            timestamp=scan.timestamp,
            latitude=scan.latitude,
            longitude=scan.longitude,
            accuracy=scan.accuracy,
            distance_to_pdv_m=distance_m,
            expected_at_stop=scan.expected_at_stop,
            expected_pdv_code=expected_map.get((tour.id, scan.barcode)),
            tour_id=tour.id,
            tour_code=tour.code,
            delivery_date=tour.delivery_date or tour.date,
            driver_name=tour.driver_name,
            carrier_id=contract.carrier_id if contract else None,
            carrier_code=carrier.code if carrier else None,
            # Le nom du transporteur vient de la fiche Transporteur quand elle
            # existe, sinon du libelle porte par le contrat. / Carrier name from
            # the carrier record, else the contract's own label.
            carrier_name=(carrier.name if carrier else (contract.transporter_name if contract else None)),
            contract_code=contract.code if contract else None,
            pdv_id=pdv.id if pdv else None,
            pdv_code=pdv.code if pdv else None,
            pdv_name=pdv.name if pdv else None,
            pdv_city=pdv.city if pdv else None,
            pdv_latitude=pdv.latitude if pdv else None,
            pdv_longitude=pdv.longitude if pdv else None,
            base_id=base.id if base else None,
            base_name=base.name if base else None,
            device_id=device.id if device else None,
            device_name=device.friendly_name if device else None,
        ))

    return results
