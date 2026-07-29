"""Tests tablette magasin : déclaration contenants par auth appareil (X-Device-ID)."""

import uuid

import pytest

from app.models.mobile_device import MobileDevice


async def _make_device(db_session, pdv_id=None):
    did = str(uuid.uuid4())
    dev = MobileDevice(
        device_identifier=did,
        registration_code=uuid.uuid4().hex[:8].upper(),
        is_active=True,
        pdv_id=pdv_id,
        profile="PDV" if pdv_id else "DRIVER",
        allowed_features="pdv_pickup" if pdv_id else "tours,pickups,declarations",
    )
    db_session.add(dev)
    await db_session.commit()
    return did


@pytest.mark.asyncio
async def test_device_pickup_scoped_to_its_pdv(client, db_session, test_pdv):
    """Une tablette liée à un PDV crée une déclaration scopée à CE magasin (PDV forcé)."""
    did = await _make_device(db_session, pdv_id=test_pdv.id)
    payload = {
        "pdv_id": 999999,  # doit être ignoré et forcé au pdv de la tablette
        "pickup_type": "MERCHANDISE",
        "quantity": 2,
        "availability_date": "2026-06-10",
    }
    r = await client.post("/api/pickup-requests/device", json=payload, headers={"X-Device-ID": did})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["pdv_id"] == test_pdv.id
    assert len(body["labels"]) == 2


@pytest.mark.asyncio
async def test_device_without_pdv_forbidden(client, db_session):
    """Un appareil non rattaché à un PDV ne peut pas déclarer via le chemin tablette."""
    did = await _make_device(db_session, pdv_id=None)
    payload = {"pdv_id": 1, "pickup_type": "MERCHANDISE", "quantity": 1, "availability_date": "2026-06-10"}
    r = await client.post("/api/pickup-requests/device", json=payload, headers={"X-Device-ID": did})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_device_unknown_unauthorized(client):
    """Sans appareil connu, 401."""
    payload = {"pdv_id": 1, "pickup_type": "MERCHANDISE", "quantity": 1, "availability_date": "2026-06-10"}
    r = await client.post("/api/pickup-requests/device", json=payload, headers={"X-Device-ID": "00000000-0000-0000-0000-000000000000"})
    assert r.status_code == 401, r.text


async def _make_pdv(db_session, region_id, prefix="B"):
    from app.models.pdv import PDV, PDVType
    code = f"{prefix}{uuid.uuid4().hex[:5].upper()}"
    pdv = PDV(
        code=code, name=f"PDV {code}", type=PDVType.HYPER, address="x", city="y",
        postal_code="0000", latitude=50.0, longitude=4.0, region_id=region_id,
    )
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)
    return pdv


@pytest.mark.asyncio
async def test_pdv_tablet_cannot_validate_other_pdv_by_code(client, db_session, test_pdv):
    """Ticket #14 : une tablette verrouillée sur le PDV A ne peut pas valider/usurper
    le PDV B en saisissant son numéro. Elle n'accède qu'à son propre PDV."""
    pdv_b = await _make_pdv(db_session, test_pdv.region_id)
    did = await _make_device(db_session, pdv_id=test_pdv.id)

    # Son propre PDV : OK
    r = await client.get(f"/api/driver/validate-pdv/{test_pdv.code}", headers={"X-Device-ID": did})
    assert r.status_code == 200, r.text
    assert r.json()["id"] == test_pdv.id

    # Un autre PDV via son code : refusé (403)
    r = await client.get(f"/api/driver/validate-pdv/{pdv_b.code}", headers={"X-Device-ID": did})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_driver_tablet_can_validate_any_pdv(client, db_session, test_pdv):
    """Un appareil chauffeur (sans pdv_id) reste libre de valider n'importe quel PDV
    de sa tournée : la garde du ticket #14 ne mord que sur les tablettes magasin."""
    pdv_b = await _make_pdv(db_session, test_pdv.region_id)
    did = await _make_device(db_session, pdv_id=None)  # profil DRIVER, pdv_id absent
    r = await client.get(f"/api/driver/validate-pdv/{pdv_b.code}", headers={"X-Device-ID": did})
    assert r.status_code == 200, r.text
    assert r.json()["id"] == pdv_b.id


@pytest.mark.asyncio
async def test_pdv_tablet_inventory_lookup_scoped(client, db_session, test_pdv):
    """Ticket #14 : /driver/inventory-lookup est cloisonné au PDV de la tablette."""
    from app.models.mobile_device import MobileDevice
    pdv_b = await _make_pdv(db_session, test_pdv.region_id)
    did = str(uuid.uuid4())
    dev = MobileDevice(
        device_identifier=did, registration_code=uuid.uuid4().hex[:8].upper(),
        is_active=True, pdv_id=test_pdv.id, profile="PDV", allowed_features="inventory",
    )
    db_session.add(dev)
    await db_session.commit()

    r = await client.post("/api/driver/inventory-lookup", json={"pdv_code": test_pdv.code}, headers={"X-Device-ID": did})
    assert r.status_code == 200, r.text
    r = await client.post("/api/driver/inventory-lookup", json={"pdv_code": pdv_b.code}, headers={"X-Device-ID": did})
    assert r.status_code == 403, r.text
