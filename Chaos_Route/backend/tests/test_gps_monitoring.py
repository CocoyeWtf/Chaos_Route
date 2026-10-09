"""Detection des coupures GPS / GPS silence detection.

Aucune app ne peut empecher un chauffeur de refuser la permission de
localisation — seul un MDM le peut. La parade retenue est donc de rendre la
coupure visible : ces tests verrouillent le fait qu'une tournee en cours
devenue muette leve bien une alerte NO_GPS nominative, sans en empiler.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.delivery_alert import AlertSeverity, AlertType
from app.services.gps_monitoring import detect_gps_silence

SILENCE_MIN = 30


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


async def _make_device(db_session):
    from app.models.mobile_device import MobileDevice

    device = MobileDevice(
        device_identifier=f"dev-{uuid.uuid4().hex[:10]}",
        registration_code=uuid.uuid4().hex[:8].upper(),
        is_active=True,
        profile="DRIVER",
        allowed_features="tours,pickups,declarations",
    )
    db_session.add(device)
    await db_session.commit()
    await db_session.refresh(device)
    return device


async def _make_active_tour(db_session, test_region, test_pdv, device, *, now):
    """Tournee en cours, assignee a l'appareil, avec un arret."""
    from app.models.base_logistics import BaseLogistics
    from app.models.device_assignment import DeviceAssignment
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base", region_id=test_region.id)
    db_session.add(base)
    await db_session.flush()

    day = now.strftime("%Y-%m-%d")
    tour = Tour(
        date=day, delivery_date=day, code=f"T-{uuid.uuid4().hex[:8]}",
        base_id=base.id, status=TourStatus.IN_PROGRESS, driver_name="Jean Dupont",
    )
    db_session.add(tour)
    await db_session.flush()

    stop = TourStop(tour_id=tour.id, pdv_id=test_pdv.id, sequence_order=1, eqp_count=10)
    db_session.add(stop)
    db_session.add(DeviceAssignment(tour_id=tour.id, device_id=device.id, date=day))
    await db_session.commit()
    await db_session.refresh(tour)
    await db_session.refresh(stop)
    return tour, stop


async def _add_position(db_session, tour, device, when):
    from app.models.gps_position import GPSPosition

    db_session.add(GPSPosition(
        device_id=device.id, tour_id=tour.id,
        latitude=50.0, longitude=4.0, accuracy=5.0, speed=50.0,
        timestamp=_iso(when),
    ))
    await db_session.commit()


async def _add_arrival_event(db_session, stop, device, when):
    from app.models.stop_event import StopEvent

    db_session.add(StopEvent(
        tour_stop_id=stop.id, event_type="ARRIVAL", device_id=device.id,
        timestamp=_iso(when),
    ))
    await db_session.commit()


@pytest.mark.asyncio
async def test_silent_tour_raises_alert_once(db_session, test_region, test_pdv):
    now = datetime.now(timezone.utc)
    device = await _make_device(db_session)
    tour, _ = await _make_active_tour(db_session, test_region, test_pdv, device, now=now)
    await _add_position(db_session, tour, device, now - timedelta(minutes=45))

    raised = await detect_gps_silence(db_session, silence_minutes=SILENCE_MIN, now=now)
    mine = [a for a in raised if a.tour_id == tour.id]
    assert len(mine) == 1
    assert mine[0].alert_type == AlertType.NO_GPS
    assert mine[0].severity == AlertSeverity.WARNING
    assert tour.code in mine[0].message
    assert "Jean Dupont" in mine[0].message
    await db_session.commit()

    # Deuxieme passage : pas d'empilement tant que l'alerte n'est pas acquittee
    again = await detect_gps_silence(db_session, silence_minutes=SILENCE_MIN, now=now)
    assert [a for a in again if a.tour_id == tour.id] == []


@pytest.mark.asyncio
async def test_recent_position_is_not_flagged(db_session, test_region, test_pdv):
    now = datetime.now(timezone.utc)
    device = await _make_device(db_session)
    tour, _ = await _make_active_tour(db_session, test_region, test_pdv, device, now=now)
    await _add_position(db_session, tour, device, now - timedelta(minutes=4))

    raised = await detect_gps_silence(db_session, silence_minutes=SILENCE_MIN, now=now)
    assert [a for a in raised if a.tour_id == tour.id] == []


@pytest.mark.asyncio
async def test_tour_that_never_emitted_is_flagged_from_first_arrival(
    db_session, test_region, test_pdv
):
    """Permission refusee des le depart : aucune position n'arrive jamais.

    C'est le cas qui motive tout le dispositif — sans point de reference, le
    detecteur s'appuie sur le scan d'arrivee qui a fait passer la tournee
    « en cours ».
    """
    now = datetime.now(timezone.utc)
    device = await _make_device(db_session)
    tour, stop = await _make_active_tour(db_session, test_region, test_pdv, device, now=now)
    await _add_arrival_event(db_session, stop, device, now - timedelta(minutes=50))

    raised = await detect_gps_silence(db_session, silence_minutes=SILENCE_MIN, now=now)
    mine = [a for a in raised if a.tour_id == tour.id]
    assert len(mine) == 1
    assert "Aucune position" in mine[0].message


@pytest.mark.asyncio
async def test_tour_without_any_reference_is_not_flagged(db_session, test_region, test_pdv):
    """Ni position ni scan d'arrivee : on ne juge pas, plutot que de crier au loup."""
    now = datetime.now(timezone.utc)
    device = await _make_device(db_session)
    tour, _ = await _make_active_tour(db_session, test_region, test_pdv, device, now=now)

    raised = await detect_gps_silence(db_session, silence_minutes=SILENCE_MIN, now=now)
    assert [a for a in raised if a.tour_id == tour.id] == []


@pytest.mark.asyncio
async def test_mobile_reports_denied_permission_immediately(
    client, db_session, test_region, test_pdv
):
    """Refus de permission signale par l'app : alerte critique, sans attendre."""
    now = datetime.now(timezone.utc)
    device = await _make_device(db_session)
    tour, _ = await _make_active_tour(db_session, test_region, test_pdv, device, now=now)
    headers = {"X-Device-ID": device.device_identifier}

    resp = await client.post(
        "/api/driver/gps-status",
        json={"tour_id": tour.id, "status": "denied"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["alert_raised"] is True

    resp = await client.get("/api/tracking/alerts")
    assert resp.status_code == 200
    alerts = [a for a in resp.json() if a["tour_id"] == tour.id]
    assert len(alerts) == 1
    assert alerts[0]["alert_type"] == "NO_GPS"
    assert alerts[0]["severity"] == "CRITICAL"
    assert "REFUSEE" in alerts[0]["message"]

    # Un statut « ok » ne leve rien / An "ok" status raises nothing
    resp = await client.post(
        "/api/driver/gps-status",
        json={"tour_id": tour.id, "status": "ok"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["alert_raised"] is False


@pytest.mark.asyncio
async def test_gps_status_rejects_unassigned_device(client, db_session, test_region, test_pdv):
    now = datetime.now(timezone.utc)
    device = await _make_device(db_session)
    other = await _make_device(db_session)
    tour, _ = await _make_active_tour(db_session, test_region, test_pdv, device, now=now)

    resp = await client.post(
        "/api/driver/gps-status",
        json={"tour_id": tour.id, "status": "denied"},
        headers={"X-Device-ID": other.device_identifier},
    )
    assert resp.status_code == 403
