"""Ticket #13 (sécurité) : garde anti-usurpation à l'enregistrement d'appareil.

Un code d'enregistrement est lié à UN seul appareil physique : une fois utilisé,
un autre appareil ne peut pas s'y enregistrer (plus d'écrasement silencieux de
l'identité). Le re-binding exige une réinitialisation admin (reset-identity).
"""

import uuid

import pytest
from sqlalchemy import select, update

from app.models.mobile_device import MobileDevice
from app.rate_limit import limiter


@pytest.fixture(autouse=True)
def _disable_rate_limit():
    prev = limiter.enabled
    limiter.enabled = False
    yield
    limiter.enabled = prev


async def _make_unbound_device(db_session, pdv_id, code):
    dev = MobileDevice(
        registration_code=code, is_active=True, pdv_id=pdv_id,
        device_identifier=None, profile="PDV", allowed_features="pdv_pickup",
    )
    db_session.add(dev)
    await db_session.commit()
    return dev


@pytest.mark.asyncio
async def test_registration_single_use_guard(client, db_session, test_pdv):
    code = uuid.uuid4().hex[:8].upper()
    dev_a = str(uuid.uuid4())
    dev_b = str(uuid.uuid4())
    await _make_unbound_device(db_session, test_pdv.id, code)

    # 1. Premier appareil : liaison OK
    r1 = await client.post("/api/devices/register",
                           json={"registration_code": code, "device_identifier": dev_a})
    assert r1.status_code == 200, r1.text
    assert r1.json()["device_identifier"] == dev_a

    # 2. Même appareil qui re-présente le code : idempotent (200)
    r2 = await client.post("/api/devices/register",
                           json={"registration_code": code, "device_identifier": dev_a})
    assert r2.status_code == 200, r2.text

    # 3. Un AUTRE appareil avec le même code : refusé (anti-usurpation)
    r3 = await client.post("/api/devices/register",
                           json={"registration_code": code, "device_identifier": dev_b})
    assert r3.status_code == 409, r3.text

    # 4. Après réinitialisation admin de l'identité, un nouvel appareil peut se lier
    await db_session.execute(
        update(MobileDevice).where(MobileDevice.registration_code == code)
        .values(device_identifier=None)
    )
    await db_session.commit()
    r4 = await client.post("/api/devices/register",
                           json={"registration_code": code, "device_identifier": dev_b})
    assert r4.status_code == 200, r4.text
    assert r4.json()["device_identifier"] == dev_b

    # Vérifier l'appareil final en base
    dev = (await db_session.execute(
        select(MobileDevice).where(MobileDevice.registration_code == code)
    )).scalar_one()
    assert dev.device_identifier == dev_b
