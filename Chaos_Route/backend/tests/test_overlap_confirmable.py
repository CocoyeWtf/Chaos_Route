"""#124 — Un chevauchement d'horaires n'est plus bloquant.

Le serveur le signale toujours (409 « Overlap… »), mais l'agent trafic peut
confirmer (`allow_overlap=true`) : l'heure de retour calculée peut se tromper.
"""

import uuid

import pytest

from tests.test_return_base import _make_base, _make_pdv, _distance, _tracteur, _tour_avec_un_stop


@pytest.mark.asyncio
async def test_overlap_signale_puis_confirmable(client, db_session, test_region):
    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 60, 120)
    await _distance(db_session, "PDV", pdv.id, "BASE", base.id, 60, 120)
    tracteur = await _tracteur(db_session)
    tracteur_id = tracteur.id

    t1 = await _tour_avec_un_stop(db_session, base, pdv)
    t2 = await _tour_avec_un_stop(db_session, base, pdv)

    r1 = await client.put(f"/api/tours/{t1}/schedule", json={
        "tractor_id": tracteur_id, "departure_time": "09:00", "driver_name": "A",
    })
    assert r1.status_code == 200, r1.text  # retour ~13:00

    payload = {"tractor_id": tracteur_id, "departure_time": "12:30", "driver_name": "A"}
    refus = await client.put(f"/api/tours/{t2}/schedule", json=payload)
    assert refus.status_code == 409
    assert refus.json()["detail"].startswith("Overlap")

    ok = await client.put(f"/api/tours/{t2}/schedule", json=payload, params={"allow_overlap": True})
    assert ok.status_code == 200, ok.text
    assert ok.json()["departure_time"] == "12:30"
