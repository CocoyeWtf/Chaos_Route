"""Une tournee sans date de livraison doit rester visible sur le suivi.

`Tour.delivery_date` est nullable et n'est posee qu'a la planification. Le
module de suivi filtrait dessus strictement, alors que tout le reste du code
lit `delivery_date or date` : une tournee planifiee sans date de livraison
disparaissait de la carte, des arrets actifs et du tableau de bord — sans le
moindre message. / A tour with no delivery_date used to vanish from the live
tracking screen.
"""

import uuid

import pytest


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


async def _make_tour(db_session, test_region, test_pdv, device, *, day, delivery_date):
    from app.models.base_logistics import BaseLogistics
    from app.models.device_assignment import DeviceAssignment
    from app.models.gps_position import GPSPosition
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base", region_id=test_region.id)
    db_session.add(base)
    await db_session.flush()

    tour = Tour(
        date=day,
        delivery_date=delivery_date,
        code=f"T-{uuid.uuid4().hex[:8]}",
        base_id=base.id,
        status=TourStatus.IN_PROGRESS,
        driver_name="Jean Dupont",
    )
    db_session.add(tour)
    await db_session.flush()

    db_session.add(TourStop(tour_id=tour.id, pdv_id=test_pdv.id, sequence_order=1, eqp_count=10))
    db_session.add(DeviceAssignment(tour_id=tour.id, device_id=device.id, date=day))
    db_session.add(GPSPosition(
        device_id=device.id, tour_id=tour.id,
        latitude=50.1, longitude=4.1, accuracy=5.0, speed=45.0,
        timestamp=f"{day}T09:00:00+00:00",
    ))
    await db_session.commit()
    await db_session.refresh(tour)
    return tour


@pytest.mark.asyncio
async def test_tour_without_delivery_date_still_appears(client, db_session, test_region, test_pdv):
    day = "2026-09-22"
    device = await _make_device(db_session)
    tour = await _make_tour(db_session, test_region, test_pdv, device, day=day, delivery_date=None)

    # Position sur la carte / Marker on the map
    resp = await client.get("/api/tracking/positions", params={"date": day})
    assert resp.status_code == 200, resp.text
    assert tour.id in [p["tour_id"] for p in resp.json()]

    # Arrets actifs / Active stops
    resp = await client.get("/api/tracking/active-stops", params={"date": day})
    assert resp.status_code == 200, resp.text
    assert tour.id in [t["tour_id"] for t in resp.json()]

    # Tableau de bord / Dashboard
    resp = await client.get("/api/tracking/dashboard", params={"date": day})
    assert resp.status_code == 200, resp.text
    assert resp.json()["active_tours"] >= 1


@pytest.mark.asyncio
async def test_delivery_date_still_wins_over_planning_date(client, db_session, test_region, test_pdv):
    """Une tournee reportee doit suivre sa date de LIVRAISON, pas celle du plan."""
    device = await _make_device(db_session)
    tour = await _make_tour(
        db_session, test_region, test_pdv, device,
        day="2026-09-23", delivery_date="2026-09-24",
    )

    resp = await client.get("/api/tracking/positions", params={"date": "2026-09-24"})
    assert tour.id in [p["tour_id"] for p in resp.json()]

    resp = await client.get("/api/tracking/positions", params={"date": "2026-09-23"})
    assert tour.id not in [p["tour_id"] for p in resp.json()]
