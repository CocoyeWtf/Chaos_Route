"""Ticket #59 : terme km et terme remorque dans le coût d'une tournée.

Les deux existent au paramétrage du contrat et sont facturés par l'extraction de
pré-facturation, mais le calcul du coût d'une tournée les ignorait : le coût
affiché était inférieur à ce qui sera facturé. Sur septembre, 82 503 EUR de
terme km et 23 195 EUR de terme remorque manquaient.

Le terme remorque suit la règle du #41 : il n'est pas dû quand la tournée roule
avec une remorque CMRO (mode mixte).

Les kilomètres d'une tournée sont recalculés depuis le distancier dès qu'une
heure de départ est posée ; les tests passent donc par le détail de coût, qui
part du kilométrage porté par la tournée.
"""

import uuid

import pytest
from sqlalchemy import select

DATE = "2026-11-17"


async def _contract(client, region_id, **over):
    payload = {
        "code": f"T{uuid.uuid4().hex[:6].upper()}",
        "region_id": region_id,
        "transporter_name": "Transporteur #59",
        "has_tailgate": False,
        "fuel_type": "DIESEL",
        "provides_tractor": True,
        "billing_type": 2,
        "consumption_coefficient": 0,
    }
    payload.update(over)
    resp = await client.post("/api/contracts/", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _base_pdv(db_session, region_id):
    from app.models.base_logistics import BaseLogistics
    from app.models.pdv import PDV, PDVType

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base #59", region_id=region_id)
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)

    code = f"P{uuid.uuid4().hex[:5].upper()}"
    pdv = PDV(code=code, name=f"PDV {code}", type=PDVType.HYPER, region_id=region_id,
              has_dock=True, dock_has_niche=True)
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)
    return base.id, pdv.id


async def _tour(db_session, base_id, pdv_id, contract_id, total_km, vehicle_id=None):
    """Tournée posée directement en base : pas d'heure de départ, donc le
    kilométrage saisi est conservé tel quel."""
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop

    t = Tour(
        date=DATE, code=f"T-{uuid.uuid4().hex[:8]}", base_id=base_id,
        status=TourStatus.VALIDATED, contract_id=contract_id, total_km=total_km,
        total_eqp=10, vehicle_id=vehicle_id,
    )
    db_session.add(t)
    await db_session.flush()
    db_session.add(TourStop(tour_id=t.id, pdv_id=pdv_id, sequence_order=1, eqp_count=10))
    await db_session.commit()
    await db_session.refresh(t)
    return t.id


@pytest.mark.asyncio
async def test_terme_km_dans_le_detail(client, db_session, test_region):
    """Le cœur du #59 : 100 km à 1,20 € font 120 € de terme km."""
    contrat = await _contract(client, test_region.id, vacation=300, cost_per_km=1.20)
    base_id, pdv_id = await _base_pdv(db_session, test_region.id)
    tour_id = await _tour(db_session, base_id, pdv_id, contrat["id"], 100)

    resp = await client.get(f"/api/tours/{tour_id}/cost-breakdown")
    assert resp.status_code == 200, resp.text
    d = resp.json()
    assert d["km_term"]["cost"] == 120.0
    assert d["km_term"]["cost_per_km"] == 1.20
    # vacation 300 + terme km 120, sans carburant ni taxe km
    assert d["total_cost_calculated"] == 420.0


@pytest.mark.asyncio
async def test_terme_remorque_du_quand_le_transporteur_la_fournit(client, db_session, test_region):
    """Terme remorque dû quand la remorque est celle du transporteur."""
    contrat = await _contract(client, test_region.id, vacation=300, trailer_cost=80)
    base_id, pdv_id = await _base_pdv(db_session, test_region.id)
    tour_id = await _tour(db_session, base_id, pdv_id, contrat["id"], 0)

    resp = await client.get(f"/api/tours/{tour_id}/cost-breakdown")
    assert resp.status_code == 200, resp.text
    d = resp.json()
    assert d["trailer_term"]["cost"] == 80.0
    assert d["trailer_term"]["own_trailer"] is False
    assert d["total_cost_calculated"] == 380.0


@pytest.mark.asyncio
async def test_pas_de_terme_remorque_en_mixte(client, db_session, test_region):
    """Règle du #41 : avec notre propre remorque, le terme n'est pas dû."""
    from app.models.vehicle import Vehicle, FleetVehicleType

    contrat = await _contract(client, test_region.id, vacation=300, trailer_cost=80)
    base_id, pdv_id = await _base_pdv(db_session, test_region.id)

    remorque = Vehicle(code=f"V{uuid.uuid4().hex[:5].upper()}",
                       fleet_vehicle_type=FleetVehicleType.SEMI_REMORQUE)
    db_session.add(remorque)
    await db_session.commit()
    await db_session.refresh(remorque)
    vid = remorque.id

    tour_id = await _tour(db_session, base_id, pdv_id, contrat["id"], 0, vehicle_id=vid)

    resp = await client.get(f"/api/tours/{tour_id}/cost-breakdown")
    assert resp.status_code == 200, resp.text
    d = resp.json()
    assert d["trailer_term"]["own_trailer"] is True
    assert d["trailer_term"]["cost"] == 0.0
    assert d["total_cost_calculated"] == 300.0


@pytest.mark.asyncio
async def test_cout_enregistre_inclut_le_terme_remorque(client, db_session, test_region):
    """Le coût STOCKÉ suit aussi : une tournée ordonnancée porte le terme remorque."""
    from app.models.tour import Tour

    contrat = await _contract(client, test_region.id, vacation=300, trailer_cost=80)
    base_id, pdv_id = await _base_pdv(db_session, test_region.id)

    resp = await client.post("/api/tours/", json={
        "date": DATE, "code": f"T-{uuid.uuid4().hex[:8]}", "base_id": base_id,
        "status": "DRAFT", "total_eqp": 10, "contract_id": contrat["id"],
        "departure_time": "06:00",
        "stops": [{"pdv_id": pdv_id, "sequence_order": 1, "eqp_count": 10}],
    })
    assert resp.status_code == 201, resp.text
    tour_id = resp.json()["id"]

    tour = (await db_session.execute(select(Tour).where(Tour.id == tour_id))).scalar_one()
    # Le distancier est vide en test : 0 km, donc pas de terme km ni de carburant.
    assert float(tour.total_cost) == 380.0, "vacation 300 + terme remorque 80"
