"""Ticket #58 : « terme fixe » et « vacation » sont le même montant.

Les deux champs portaient la même valeur dans les 74 contrats renseignés en
production, et le calcul de coût des tournées les ADDITIONNAIT : le terme fixe
était compté deux fois, soit 394 085 EUR sur 819 305 EUR pour le seul mois de
septembre. L'extraction de pré-facturation, elle, n'en comptait déjà qu'un.

On ne compte donc plus qu'une vacation, et les deux colonnes sont tenues égales
à l'écriture — l'interface n'expose qu'un champ, l'extraction lit l'autre.
"""

import uuid

import pytest

from app.models.contract import effective_vacation


def test_helper_ne_compte_qu_une_fois():
    from types import SimpleNamespace
    assert effective_vacation(SimpleNamespace(fixed_daily_cost=400, vacation=400)) == 400.0
    assert effective_vacation(SimpleNamespace(fixed_daily_cost=None, vacation=365)) == 365.0
    assert effective_vacation(SimpleNamespace(fixed_daily_cost=475, vacation=None)) == 475.0
    assert effective_vacation(SimpleNamespace(fixed_daily_cost=None, vacation=None)) == 0.0


async def _contract(client, region_id, **over):
    payload = {
        "code": f"T{uuid.uuid4().hex[:6].upper()}",
        "region_id": region_id,
        "transporter_name": "Transporteur #58",
        "has_tailgate": False,
        "fuel_type": "DIESEL",
        "provides_tractor": True,
        "billing_type": 2,
    }
    payload.update(over)
    resp = await client.post("/api/contracts/", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_les_deux_champs_restent_egaux(client, test_region):
    """Saisir la vacation renseigne aussi l'ancien champ, et réciproquement."""
    c = await _contract(client, test_region.id, vacation=420)
    assert float(c["vacation"]) == 420.0
    assert float(c["fixed_daily_cost"]) == 420.0, "l'extraction lit ce champ"

    resp = await client.put(f"/api/contracts/{c['id']}", json={"vacation": 500})
    assert resp.status_code == 200, resp.text
    assert float(resp.json()["fixed_daily_cost"]) == 500.0
    assert float(resp.json()["vacation"]) == 500.0


@pytest.mark.asyncio
async def test_ancien_champ_seul_reste_accepte(client, test_region):
    """Un contrat créé avec le seul « terme fixe » reste cohérent."""
    c = await _contract(client, test_region.id, fixed_daily_cost=380)
    assert float(c["fixed_daily_cost"]) == 380.0
    assert float(c["vacation"]) == 380.0


@pytest.mark.asyncio
async def test_cout_du_tour_ne_double_plus_la_vacation(client, db_session, test_region):
    """Le cœur du #58 : une tournée à 400 EUR de vacation coûte 400, pas 800."""
    from app.models.base_logistics import BaseLogistics
    from app.models.pdv import PDV, PDVType
    from app.models.tour_stop import TourStop
    from sqlalchemy import select
    from app.models.tour import Tour

    contrat = await _contract(client, test_region.id, vacation=400, consumption_coefficient=0)

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base #58", region_id=test_region.id)
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)
    base_id = base.id

    code = f"P{uuid.uuid4().hex[:5].upper()}"
    pdv = PDV(code=code, name=f"PDV {code}", type=PDVType.HYPER, region_id=test_region.id,
              has_dock=True, dock_has_niche=True)
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)

    resp = await client.post("/api/tours/", json={
        "date": "2026-11-03", "code": f"T-{uuid.uuid4().hex[:8]}", "base_id": base_id,
        "status": "DRAFT", "total_eqp": 10, "contract_id": contrat["id"],
        "departure_time": "06:00",
        "stops": [{"pdv_id": pdv.id, "sequence_order": 1, "eqp_count": 10}],
    })
    assert resp.status_code == 201, resp.text
    tour_id = resp.json()["id"]

    tour = (await db_session.execute(select(Tour).where(Tour.id == tour_id))).scalar_one()
    # Sans carburant (coefficient nul) ni taxe km, le coût se résume à la vacation.
    assert float(tour.total_cost) == 400.0, "la vacation ne doit être comptée qu'une fois"

    stops = (await db_session.execute(select(TourStop).where(TourStop.tour_id == tour_id))).scalars().all()
    assert len(stops) == 1
