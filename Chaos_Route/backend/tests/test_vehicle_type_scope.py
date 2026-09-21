"""Ticket #32 : « aucun contrat ne fournit tracteur + remorque » alors que les
PDV sont bien paramétrés.

Mesure en production : 17 tours non ordonnancés de septembre sur 61 étaient
bloqués en presté. Dans chacun, les seuls contrats survivants étaient les 24
contrats de **traction seule** (pas de type de véhicule, remorque CMRO) — tous
les contrats typés avaient été éliminés par la contrainte de gabarit du PDV,
posée à la construction sans que rien ne l'y signale.

Deux défauts couverts ici :
- un contrat sans type de véhicule échappait totalement au contrôle de gabarit,
  alors que ce qui se présente au point de vente est le gabarit du TOUR ;
- `contract-blockers` doit nommer la vraie raison, pour que l'écran cesse de
  parler de remorque quand le motif est « type de véhicule non autorisé ».
"""

import uuid

import pytest

from app.models.base_logistics import BaseLogistics
from app.models.pdv import PDV, PDVType
from app.models.tour import Tour, TourStatus
from app.models.tour_stop import TourStop

DATE = "2026-09-24"


async def _create_contract(client, region_id, **over):
    payload = {
        "code": f"T{uuid.uuid4().hex[:6].upper()}",
        "region_id": region_id,
        "transporter_name": "Transporteur #32",
        "has_tailgate": True,
        "fuel_type": "DIESEL",
        "provides_tractor": True,
        "billing_type": 2,
    }
    payload.update(over)
    resp = await client.post("/api/contracts/", json=payload)
    assert resp.status_code == 201, f"{resp.status_code}: {resp.text}"
    return resp.json()


async def _base(db_session, region):
    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base #32", region_id=region.id)
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)
    return base


async def _pdv(db_session, region, allowed):
    code = f"P{uuid.uuid4().hex[:5].upper()}"
    pdv = PDV(
        code=code, name=f"PDV {code}", type=PDVType.HYPER, region_id=region.id,
        allowed_vehicle_types=allowed, has_dock=True, dock_has_niche=True,
    )
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)
    return pdv


async def _tour(db_session, base, pdv, vehicle_type):
    tour = Tour(
        date=DATE, code=f"T-{uuid.uuid4().hex[:8]}", base_id=base.id,
        vehicle_type=vehicle_type, status=TourStatus.DRAFT, total_eqp=10,
    )
    db_session.add(tour)
    await db_session.flush()
    db_session.add(TourStop(tour_id=tour.id, pdv_id=pdv.id, sequence_order=1, eqp_count=10))
    await db_session.commit()
    await db_session.refresh(tour)
    return tour


@pytest.mark.asyncio
async def test_traction_only_contract_checked_against_tour_type(client, db_session, test_region):
    """Le cœur du #32 : un contrat sans type de véhicule n'échappe plus au
    contrôle — c'est le gabarit du tour qui se présente au point de vente."""
    base = await _base(db_session, test_region)
    # PDV qui n'accepte QUE le porteur surbaissé (cas « Bruxelles Monnaie Mint »)
    pdv = await _pdv(db_session, test_region, "PORTEUR_SURBAISSE")
    joker = await _create_contract(client, test_region.id, vehicle_type=None, trailer_supply="CMRO")

    # Tour monté en SEMI : le PDV refuse ce gabarit -> le joker ne doit plus sortir
    semi = await _tour(db_session, base, pdv, "SEMI")
    resp = await client.get("/api/tours/available-contracts", params={
        "date": DATE, "base_id": base.id, "vehicle_type": "SEMI", "tour_id": semi.id,
    })
    assert resp.status_code == 200, resp.text
    assert joker["id"] not in {c["id"] for c in resp.json()}

    # Tour monté au bon gabarit : le joker reste proposé
    surb = await _tour(db_session, base, pdv, "PORTEUR_SURBAISSE")
    resp = await client.get("/api/tours/available-contracts", params={
        "date": DATE, "base_id": base.id, "vehicle_type": "PORTEUR_SURBAISSE", "tour_id": surb.id,
    })
    assert resp.status_code == 200, resp.text
    assert joker["id"] in {c["id"] for c in resp.json()}


@pytest.mark.asyncio
async def test_blockers_name_the_vehicle_type_reason(client, db_session, test_region):
    """L'écran doit pouvoir dire POURQUOI : le blocage est nommé, PDV compris."""
    base = await _base(db_session, test_region)
    pdv = await _pdv(db_session, test_region, "PORTEUR_SURBAISSE")
    await _create_contract(client, test_region.id, vehicle_type=None, trailer_supply="CMRO")
    await _create_contract(client, test_region.id, vehicle_type="SEMI", trailer_supply="CARRIER")

    tour = await _tour(db_session, base, pdv, "SEMI")
    resp = await client.get(f"/api/tours/{tour.id}/contract-blockers", params={
        "date": DATE, "base_id": base.id, "vehicle_type": "SEMI",
    })
    assert resp.status_code == 200, resp.text
    reasons = resp.json()
    assert any("Type de véhicule non autorisé" in r and pdv.code in r for r in reasons), reasons


@pytest.mark.asyncio
async def test_allowed_vehicle_type_still_passes(client, db_session, test_region):
    """Cas normal préservé : un PDV qui accepte le gabarit ne bloque rien."""
    base = await _base(db_session, test_region)
    pdv = await _pdv(db_session, test_region, "SEMI|PORTEUR|PORTEUR_SURBAISSE")
    semi = await _create_contract(client, test_region.id, vehicle_type="SEMI", trailer_supply="CARRIER")
    joker = await _create_contract(client, test_region.id, vehicle_type=None, trailer_supply="CMRO")

    tour = await _tour(db_session, base, pdv, "SEMI")
    resp = await client.get("/api/tours/available-contracts", params={
        "date": DATE, "base_id": base.id, "vehicle_type": "SEMI", "tour_id": tour.id,
    })
    assert resp.status_code == 200, resp.text
    ids = {c["id"] for c in resp.json()}
    assert semi["id"] in ids and joker["id"] in ids

    blockers = await client.get(f"/api/tours/{tour.id}/contract-blockers", params={
        "date": DATE, "base_id": base.id, "vehicle_type": "SEMI",
    })
    assert blockers.json() == []


@pytest.mark.asyncio
async def test_pdv_without_restriction_is_not_blocked(client, db_session, test_region):
    """Un PDV sans liste de gabarits n'impose rien (137 PDV sur 170 en prod)."""
    base = await _base(db_session, test_region)
    pdv = await _pdv(db_session, test_region, None)
    joker = await _create_contract(client, test_region.id, vehicle_type=None, trailer_supply="CMRO")

    tour = await _tour(db_session, base, pdv, "SEMI")
    resp = await client.get("/api/tours/available-contracts", params={
        "date": DATE, "base_id": base.id, "vehicle_type": "SEMI", "tour_id": tour.id,
    })
    assert resp.status_code == 200, resp.text
    assert joker["id"] in {c["id"] for c in resp.json()}
