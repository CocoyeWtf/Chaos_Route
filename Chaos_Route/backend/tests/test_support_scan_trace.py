"""Tracabilite des scans supports : ou, quand, par qui, pour quel transporteur.

Support scan traceability: where, when, by whom, under which carrier.

Couvre : capture de la position + precision par le scan mobile, restitution web
enrichie (chauffeur, transporteur, PDV, ecart au PDV), filtres, et absence de
tout interrupteur cote chauffeur — la geolocalisation repose sur l'interet
legitime, pas sur le consentement.
"""

import uuid

import pytest


async def _make_device(db_session):
    from app.models.mobile_device import MobileDevice

    device = MobileDevice(
        device_identifier=f"dev-{uuid.uuid4().hex[:10]}",
        friendly_name="Tel test",
        registration_code=uuid.uuid4().hex[:8].upper(),
        is_active=True,
        profile="DRIVER",
        allowed_features="tours,pickups,declarations",
    )
    db_session.add(device)
    await db_session.commit()
    await db_session.refresh(device)
    return device


async def _make_tour(db_session, test_region, test_pdv, device, *, with_carrier=True):
    """Tour assigne a l'appareil, avec un stop sur le PDV de test."""
    from app.models.base_logistics import BaseLogistics
    from app.models.carrier import Carrier
    from app.models.contract import Contract
    from app.models.device_assignment import DeviceAssignment
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base Test", region_id=test_region.id)
    db_session.add(base)
    await db_session.flush()

    contract_id = None
    carrier_name = None
    if with_carrier:
        carrier = Carrier(
            code=f"C{uuid.uuid4().hex[:5].upper()}",
            name=f"Trans {uuid.uuid4().hex[:4]}",
            region_id=test_region.id,
        )
        db_session.add(carrier)
        await db_session.flush()
        contract = Contract(
            transporter_name=carrier.name,
            code=f"K{uuid.uuid4().hex[:5].upper()}",
            region_id=test_region.id,
            carrier_id=carrier.id,
        )
        db_session.add(contract)
        await db_session.flush()
        contract_id = contract.id
        carrier_name = carrier.name

    tour = Tour(
        date="2026-09-15",
        delivery_date="2026-09-15",
        code=f"T-{uuid.uuid4().hex[:8]}",
        base_id=base.id,
        status=TourStatus.IN_PROGRESS,
        driver_name="Jean Dupont",
        contract_id=contract_id,
    )
    db_session.add(tour)
    await db_session.flush()

    stop = TourStop(tour_id=tour.id, pdv_id=test_pdv.id, sequence_order=1, eqp_count=10)
    db_session.add(stop)
    db_session.add(DeviceAssignment(tour_id=tour.id, device_id=device.id, date="2026-09-15"))
    await db_session.commit()
    await db_session.refresh(tour)
    await db_session.refresh(stop)
    return tour, stop, carrier_name


@pytest.mark.asyncio
async def test_scan_records_position_and_trace_exposes_driver_and_carrier(
    client, db_session, test_region, test_pdv
):
    device = await _make_device(db_session)
    tour, stop, carrier_name = await _make_tour(db_session, test_region, test_pdv, device)
    headers = {"X-Device-ID": device.device_identifier}
    barcode = f"SUP{uuid.uuid4().hex[:8].upper()}"

    # Le mobile scanne avec sa position et sa precision / Mobile scans with its fix
    resp = await client.post(
        f"/api/driver/tour/{tour.id}/stops/{stop.id}/scan-support",
        json={
            "barcode": barcode,
            "latitude": 50.001,
            "longitude": 4.0,
            "accuracy": 8.0,
            "timestamp": "2026-09-15T09:30:00+00:00",
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["accuracy"] == 8.0

    # Restitution web / Web traceability view
    resp = await client.get(
        "/api/tracking/support-scans/",
        params={"date_from": "2026-09-15", "date_to": "2026-09-15", "barcode": barcode},
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    row = rows[0]

    assert row["barcode"] == barcode
    assert row["timestamp"] == "2026-09-15T09:30:00+00:00"   # date + heure
    assert row["latitude"] == 50.001 and row["longitude"] == 4.0
    assert row["accuracy"] == 8.0
    assert row["driver_name"] == "Jean Dupont"
    assert row["carrier_name"] == carrier_name
    assert row["pdv_code"] == test_pdv.code
    assert row["tour_code"] == tour.code
    assert row["device_name"] == "Tel test"

    # Ecart au PDV : ~111 m pour 0.001 degre de latitude /
    # Gap to the PDV: ~111 m for 0.001 degree of latitude
    assert 100 < row["distance_to_pdv_m"] < 125


@pytest.mark.asyncio
async def test_trace_filters_by_carrier_and_geolocation(client, db_session, test_region, test_pdv):
    device_a = await _make_device(db_session)
    tour_a, stop_a, _ = await _make_tour(db_session, test_region, test_pdv, device_a)
    device_b = await _make_device(db_session)
    tour_b, stop_b, _ = await _make_tour(db_session, test_region, test_pdv, device_b)

    bc_a = f"SUP{uuid.uuid4().hex[:8].upper()}"
    bc_b = f"SUP{uuid.uuid4().hex[:8].upper()}"

    await client.post(
        f"/api/driver/tour/{tour_a.id}/stops/{stop_a.id}/scan-support",
        json={"barcode": bc_a, "latitude": 50.0, "longitude": 4.0, "accuracy": 5.0,
              "timestamp": "2026-09-16T08:00:00+00:00"},
        headers={"X-Device-ID": device_a.device_identifier},
    )
    # Scan sans position (GPS indisponible) / Scan with no fix
    await client.post(
        f"/api/driver/tour/{tour_b.id}/stops/{stop_b.id}/scan-support",
        json={"barcode": bc_b, "timestamp": "2026-09-16T08:05:00+00:00"},
        headers={"X-Device-ID": device_b.device_identifier},
    )

    carrier_id = (await client.get(
        "/api/tracking/support-scans/",
        params={"date_from": "2026-09-16", "date_to": "2026-09-16", "barcode": bc_a},
    )).json()[0]["carrier_id"]

    # Filtre transporteur / Carrier filter
    resp = await client.get(
        "/api/tracking/support-scans/",
        params={"date_from": "2026-09-16", "date_to": "2026-09-16", "carrier_id": carrier_id},
    )
    assert resp.status_code == 200
    codes = {r["barcode"] for r in resp.json()}
    assert bc_a in codes and bc_b not in codes

    # Filtre « geolocalises seulement » / Geolocated-only filter
    resp = await client.get(
        "/api/tracking/support-scans/",
        params={"date_from": "2026-09-16", "date_to": "2026-09-16", "only_geolocated": True},
    )
    codes = {r["barcode"] for r in resp.json()}
    assert bc_a in codes and bc_b not in codes


@pytest.mark.asyncio
async def test_date_bounds_include_end_of_day(client, db_session, test_region, test_pdv):
    """La borne haute ne doit pas couper les scans de fin de journee."""
    device = await _make_device(db_session)
    tour, stop, _ = await _make_tour(db_session, test_region, test_pdv, device)
    barcode = f"SUP{uuid.uuid4().hex[:8].upper()}"

    await client.post(
        f"/api/driver/tour/{tour.id}/stops/{stop.id}/scan-support",
        json={"barcode": barcode, "latitude": 50.0, "longitude": 4.0,
              "timestamp": "2026-09-17T23:58:12+00:00"},
        headers={"X-Device-ID": device.device_identifier},
    )

    resp = await client.get(
        "/api/tracking/support-scans/",
        params={"date_from": "2026-09-17", "date_to": "2026-09-17", "barcode": barcode},
    )
    assert resp.status_code == 200
    assert len(resp.json()) == 1


@pytest.mark.asyncio
async def test_scan_coordinates_survive_a_legacy_refusal(client, db_session, test_region, test_pdv):
    """Aucun enregistrement cote chauffeur ne doit faire disparaitre un scan.

    Regression garde-fou : la position du scan a un temps ete effacee quand le
    chauffeur avait refuse le suivi — un bouton suffisait donc a masquer ou un
    support avait ete scanne. / Guard: a driver-side flag must not erase where
    a support was scanned.
    """
    device = await _make_device(db_session)
    tour, stop, _ = await _make_tour(db_session, test_region, test_pdv, device)
    headers = {"X-Device-ID": device.device_identifier}
    barcode = f"SUP{uuid.uuid4().hex[:8].upper()}"

    resp = await client.post(
        "/api/gdpr/consent/device",
        json={"consent_type": "gps_tracking", "granted": False, "info_version": "1.0-2026-07"},
        headers=headers,
    )
    assert resp.status_code in (200, 201), resp.text

    resp = await client.post(
        f"/api/driver/tour/{tour.id}/stops/{stop.id}/scan-support",
        json={"barcode": barcode, "latitude": 50.0, "longitude": 4.0, "accuracy": 5.0,
              "timestamp": "2026-09-18T10:00:00+00:00"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["latitude"] == 50.0
    assert body["longitude"] == 4.0
    assert body["accuracy"] == 5.0
