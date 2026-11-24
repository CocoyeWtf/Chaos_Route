"""#115 — Changer le chauffeur / le moyen depuis l'écran postier.

Avant : impossible sans supprimer la tournée (ce qui menait au #116).
"""

import pytest

from tests.test_return_base import _make_base, _make_pdv, _distance, _tracteur, _tour_avec_un_stop


async def _planned_tour(client, db_session, region):
    base = await _make_base(db_session, region)
    pdv = await _make_pdv(db_session, region)
    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", base.id, 20, 30)
    t1, t2 = await _tracteur(db_session), await _tracteur(db_session)
    ids = (t1.id, t2.id)
    tour_id = await _tour_avec_un_stop(db_session, base, pdv)
    r = await client.put(f"/api/tours/{tour_id}/schedule", json={
        "tractor_id": ids[0], "departure_time": "06:00", "driver_name": "Dupont",
    })
    assert r.status_code == 200, r.text
    return tour_id, ids


@pytest.mark.asyncio
async def test_reassign_keeps_time_and_changes_means(client, db_session, test_region):
    tour_id, (_, tr2) = await _planned_tour(client, db_session, test_region)
    r = await client.put(f"/api/tours/{tour_id}/reassign", json={"tractor_id": tr2, "driver_name": "Martin"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tractor_id"] == tr2
    assert body["driver_name"] == "Martin"
    assert body["departure_time"] == "06:00"


@pytest.mark.asyncio
async def test_reassign_refused_after_departure(client, db_session, test_region):
    from app.models.tour import Tour
    tour_id, (_, tr2) = await _planned_tour(client, db_session, test_region)
    tour = await db_session.get(Tour, tour_id)
    tour.departure_signal_time = "2026-06-25T06:05"
    await db_session.commit()
    r = await client.put(f"/api/tours/{tour_id}/reassign", json={"tractor_id": tr2})
    assert r.status_code == 409
