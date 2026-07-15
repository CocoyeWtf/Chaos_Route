"""Tests des tickets #8 / #10 / #11 / #12 : encodage de retours PDV.

- #8  : l'inventaire PDV ne liste/accepte que les supports de retour autorisés.
- #10 : la validation d'inventaire crée les demandes de reprise CMRO + étiquettes.
- #11 : un scan d'étiquette est refusé si elle n'appartient pas au PDV scanné.
- #12 : la palette support est obligatoire pour les balles (CARDBOARD).
"""

import uuid

import pytest

from app.models.mobile_device import MobileDevice
from app.models.support_type import SupportType


async def _make_device(db_session, pdv_id=None, features="inventory,pickups,pdv_pickup"):
    did = str(uuid.uuid4())
    dev = MobileDevice(
        device_identifier=did,
        registration_code=uuid.uuid4().hex[:8].upper(),
        is_active=True,
        pdv_id=pdv_id,
        profile="PDV" if pdv_id else "DRIVER",
        allowed_features=features,
    )
    db_session.add(dev)
    await db_session.commit()
    return did


async def _make_support(db_session, code, name="Support Test", is_combi=False):
    st = SupportType(code=code, short_code=code[:3], name=name, unit_quantity=1,
                     is_active=True, is_combi=is_combi)
    db_session.add(st)
    await db_session.commit()
    await db_session.refresh(st)
    return st


@pytest.mark.asyncio
async def test_inventory_lookup_filters_returns(client, db_session, test_pdv):
    """#8 : lookup ne renvoie que les supports autorisés (pas les casiers bière SF 3xxxx)."""
    pa = await _make_support(db_session, f"PA 220{uuid.uuid4().hex[:2]}", "Palette test")
    beer = await _make_support(db_session, f"SF 301{uuid.uuid4().hex[:2]}", "Casier biere")
    did = await _make_device(db_session, pdv_id=test_pdv.id)

    r = await client.post("/api/driver/inventory-lookup", json={"pdv_code": test_pdv.code},
                          headers={"X-Device-ID": did})
    assert r.status_code == 200, r.text
    codes = {s["code"] for s in r.json()["support_types"]}
    assert pa.code in codes
    assert beer.code not in codes


@pytest.mark.asyncio
async def test_inventory_submit_rejects_disallowed(client, db_session, test_pdv):
    """#8 : soumettre un casier bière (SF 3xxxx) à l'inventaire est refusé (400)."""
    beer = await _make_support(db_session, f"SF 302{uuid.uuid4().hex[:2]}", "Casier biere 2")
    did = await _make_device(db_session, pdv_id=test_pdv.id)

    r = await client.post("/api/driver/inventory", json={
        "pdv_id": test_pdv.id,
        "lines": [{"support_type_id": beer.id, "quantity": 3}],
        "inventoried_by": "Testeur",
    }, headers={"X-Device-ID": did})
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_inventory_creates_pickup_requests(client, db_session, test_pdv):
    """#10 : create_requests=true crée une demande CMRO + étiquettes par ligne."""
    pa = await _make_support(db_session, f"PA 221{uuid.uuid4().hex[:2]}", "Palette test")
    did = await _make_device(db_session, pdv_id=test_pdv.id)

    r = await client.post("/api/driver/inventory", json={
        "pdv_id": test_pdv.id,
        "lines": [{"support_type_id": pa.id, "quantity": 2}],
        "inventoried_by": "Testeur",
        "create_requests": True,
    }, headers={"X-Device-ID": did})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["requests_created"] == 1
    assert len(body["requests"][0]["labels"]) == 2  # 1 étiquette par unité


@pytest.mark.asyncio
async def test_cardboard_requires_pallet(client, db_session, test_pdv):
    """#12 : une demande balles (CARDBOARD) sans palette support est refusée (400)."""
    re_support = await _make_support(db_session, f"RE 520{uuid.uuid4().hex[:2]}", "Balle carton")
    did = await _make_device(db_session, pdv_id=test_pdv.id)

    payload = {
        "pdv_id": test_pdv.id,
        "pickup_type": "CARDBOARD",
        "support_type_id": re_support.id,
        "quantity": 1,
        "availability_date": "2026-06-10",
    }
    r = await client.post("/api/pickup-requests/device", json=payload, headers={"X-Device-ID": did})
    assert r.status_code == 400, r.text

    # Avec une palette support → OK
    pallet = await _make_support(db_session, f"PA 222{uuid.uuid4().hex[:2]}", "Pal Loc")
    payload["pallet_support_type_id"] = pallet.id
    r2 = await client.post("/api/pickup-requests/device", json=payload, headers={"X-Device-ID": did})
    assert r2.status_code == 201, r2.text


@pytest.mark.asyncio
async def test_scan_rejects_wrong_pdv(client, db_session, test_pdv):
    """#11 : scanner une étiquette avec un code PDV différent de celui de l'étiquette → 409."""
    pa = await _make_support(db_session, f"PA 223{uuid.uuid4().hex[:2]}", "Palette test")
    did = await _make_device(db_session, pdv_id=test_pdv.id)

    # Créer une demande (1 étiquette) via la tablette
    create = await client.post("/api/pickup-requests/device", json={
        "pdv_id": test_pdv.id,
        "pickup_type": "CONTAINER",
        "support_type_id": pa.id,
        "quantity": 1,
        "availability_date": "2026-06-10",
    }, headers={"X-Device-ID": did})
    assert create.status_code == 201, create.text
    label_code = create.json()["labels"][0]["label_code"]

    # Mauvais PDV → 409
    bad = await client.post(
        f"/api/driver/standalone-pickup/{label_code}?pdv_code=99999",
        headers={"X-Device-ID": did},
    )
    assert bad.status_code == 409, bad.text

    # Bon PDV → 200
    ok = await client.post(
        f"/api/driver/standalone-pickup/{label_code}?pdv_code={test_pdv.code}",
        headers={"X-Device-ID": did},
    )
    assert ok.status_code == 200, ok.text
