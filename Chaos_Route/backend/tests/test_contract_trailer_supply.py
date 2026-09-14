"""Ticket #41 : un contrat peut fournir sa remorque sur certaines tournées et
tracter une remorque CMRO sur d'autres (presté ET mixte).

Couvre :
- la nouvelle valeur `trailer_supply` (CARRIER / CMRO / BOTH) et la synchro du
  booléen historique `provides_trailer` ;
- la dérivation pour les contrats non migrés (trailer_supply NULL) ;
- le filtre `/api/tours/available-contracts?mode=...` : BOTH sort dans les deux
  modes, CARRIER seulement en presté, CMRO seulement en mixte.
"""

import uuid

import pytest

from app.models.base_logistics import BaseLogistics
from app.models.contract import TrailerSupply, effective_trailer_supply


async def _create_contract(client, region_id, **over):
    payload = {
        "code": f"T{uuid.uuid4().hex[:6].upper()}",
        "region_id": region_id,
        "transporter_name": "Transporteur #41",
        "has_tailgate": False,
        "fuel_type": "DIESEL",
        "provides_tractor": True,
        "billing_type": 2,
    }
    payload.update(over)
    resp = await client.post("/api/contracts/", json=payload)
    assert resp.status_code == 201, f"{resp.status_code}: {resp.text}"
    return resp.json()


@pytest.mark.asyncio
async def test_trailer_supply_both_syncs_legacy_boolean(client, test_region):
    """BOTH est stocké et le booléen historique reste cohérent (amène sa remorque)."""
    c = await _create_contract(client, test_region.id, trailer_supply="BOTH")
    assert c["trailer_supply"] == "BOTH"
    assert c["provides_trailer"] is True

    resp = await client.put(f"/api/contracts/{c['id']}", json={"trailer_supply": "CMRO"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["trailer_supply"] == "CMRO"
    assert resp.json()["provides_trailer"] is False


@pytest.mark.asyncio
async def test_legacy_contract_derives_supply_from_boolean(client, test_region):
    """Contrat non migré (pas de trailer_supply) : la valeur est dérivée à la lecture."""
    preste = await _create_contract(client, test_region.id, provides_trailer=True)
    mixte = await _create_contract(client, test_region.id, provides_trailer=False)
    assert preste["trailer_supply"] == "CARRIER"
    assert mixte["trailer_supply"] == "CMRO"


def test_effective_trailer_supply_helper():
    from types import SimpleNamespace
    assert effective_trailer_supply(
        SimpleNamespace(trailer_supply=TrailerSupply.BOTH, provides_trailer=False)
    ) is TrailerSupply.BOTH
    assert effective_trailer_supply(
        SimpleNamespace(trailer_supply=None, provides_trailer=True)
    ) is TrailerSupply.CARRIER
    assert effective_trailer_supply(
        SimpleNamespace(trailer_supply=None, provides_trailer=False)
    ) is TrailerSupply.CMRO
    # Legacy non renseigné : inconnu, ne filtre rien
    assert effective_trailer_supply(
        SimpleNamespace(trailer_supply=None, provides_trailer=None)
    ) is None


@pytest.mark.asyncio
async def test_available_contracts_both_modes(client, db_session, test_region):
    """Le coeur du ticket #41 : BOTH est proposé en presté ET en mixte."""
    base = BaseLogistics(
        code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base #41", region_id=test_region.id
    )
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)

    carrier = await _create_contract(client, test_region.id, trailer_supply="CARRIER")
    cmro = await _create_contract(client, test_region.id, trailer_supply="CMRO")
    both = await _create_contract(client, test_region.id, trailer_supply="BOTH")

    async def codes(mode):
        resp = await client.get(
            "/api/tours/available-contracts",
            params={"date": "2026-09-15", "base_id": base.id, "mode": mode},
        )
        assert resp.status_code == 200, resp.text
        return {c["id"] for c in resp.json()}

    preste_ids = await codes("preste")
    mixte_ids = await codes("mixte")

    assert both["id"] in preste_ids and both["id"] in mixte_ids
    assert carrier["id"] in preste_ids and carrier["id"] not in mixte_ids
    assert cmro["id"] in mixte_ids and cmro["id"] not in preste_ids
