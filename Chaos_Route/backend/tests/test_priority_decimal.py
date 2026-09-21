"""Ticket #29 : priorité d'ordonnancement décimale.

L'agent trafic veut intercaler une tournée entre la 2 et la 3 sans renuméroter
les autres. La colonne était un entier : 2,5 était arrondi silencieusement.
Elle a été élargie en numeric(8,2) (migration manuelle en production).
"""

import uuid

import pytest
from sqlalchemy import select

DATE = "2026-10-12"


async def _base(db_session, region_id):
    from app.models.base_logistics import BaseLogistics
    b = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base #29", region_id=region_id)
    db_session.add(b)
    await db_session.commit()
    await db_session.refresh(b)
    return b.id


async def _tour(db_session, base_id, priority=None):
    from app.models.tour import Tour, TourStatus
    t = Tour(
        date=DATE, code=f"T-{uuid.uuid4().hex[:10]}", base_id=base_id,
        status=TourStatus.VALIDATED, departure_time="06:00", priority=priority,
    )
    db_session.add(t)
    await db_session.commit()
    await db_session.refresh(t)
    return t.id


@pytest.mark.asyncio
async def test_priorite_decimale_conservee(client, db_session, test_region):
    """Le cœur du #29 : 2,5 s'enregistre tel quel et ressort tel quel."""
    from app.models.tour import Tour

    base_id = await _base(db_session, test_region.id)
    tour_id = await _tour(db_session, base_id)

    resp = await client.put(f"/api/tours/{tour_id}", json={"priority": 2.5})
    assert resp.status_code == 200, resp.text
    assert float(resp.json()["priority"]) == 2.5

    db_session.expire_all()
    tour = (await db_session.execute(select(Tour).where(Tour.id == tour_id))).scalar_one()
    assert float(tour.priority) == 2.5, "la décimale ne doit pas être arrondie"


@pytest.mark.asyncio
async def test_intercalage_entre_deux_tournees(client, db_session, test_region):
    """Une tournée à 2,5 se classe bien entre celles à 2 et à 3."""
    from app.models.tour import Tour

    base_id = await _base(db_session, test_region.id)
    ids = [await _tour(db_session, base_id, p) for p in (1, 2, 3)]
    intercalee = await _tour(db_session, base_id)

    resp = await client.put(f"/api/tours/{intercalee}", json={"priority": 2.5})
    assert resp.status_code == 200, resp.text

    db_session.expire_all()
    tours = (await db_session.execute(
        select(Tour).where(Tour.id.in_([*ids, intercalee])))).scalars().all()
    ordre = sorted(tours, key=lambda t: float(t.priority))
    assert [t.id for t in ordre] == [ids[0], ids[1], intercalee, ids[2]]


@pytest.mark.asyncio
async def test_priorite_entiere_toujours_acceptee(client, db_session, test_region):
    """Les priorités entières existantes continuent de fonctionner."""
    from app.models.tour import Tour

    base_id = await _base(db_session, test_region.id)
    tour_id = await _tour(db_session, base_id, priority=4)

    resp = await client.get("/api/tours/", params={"date": DATE, "limit": 500})
    assert resp.status_code == 200, resp.text
    ligne = next(t for t in resp.json() if t["id"] == tour_id)
    assert float(ligne["priority"]) == 4.0

    db_session.expire_all()
    valeur = (await db_session.execute(
        select(Tour.priority).where(Tour.id == tour_id))).scalar_one()
    assert float(valeur) == 4.0
