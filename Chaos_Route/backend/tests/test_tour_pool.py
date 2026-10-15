"""Le « pot » : tournees construites a l'avance, en attente de date (#92).

Gaetan : « les tours Gosselies-MEA sont faits le vendredi de la S-1. Lors de la
creation des tours on dit a CMRO d'envoyer ces tours dans un "pot", et lorsqu'on
planifie ces tours un jour X de la S-0 on integre un ou des tours a la bonne
date. Ce "pot" sous-menu devrait avoir un indicatif des tours restant a
planifier afin de ne pas oublier de le faire. »
"""

import uuid

import pytest
import pytest_asyncio

DATE_CONSTRUCTION = "2026-11-06"   # vendredi S-1
DATE_PLANIFIEE = "2026-11-10"      # mardi S-0


@pytest_asyncio.fixture
async def base(db_session, test_region):
    from app.models.base_logistics import BaseLogistics

    b = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Gosselies MEA",
                      region_id=test_region.id)
    db_session.add(b)
    await db_session.commit()
    await db_session.refresh(b)
    return b


async def _tour(db_session, base, *, pooled: bool, date=DATE_CONSTRUCTION):
    from app.models.tour import Tour, TourStatus

    t = Tour(code=f"T{uuid.uuid4().hex[:6].upper()}", date=date, delivery_date=date,
             base_id=base.id, status=TourStatus.DRAFT, pooled=pooled)
    db_session.add(t)
    await db_session.commit()
    await db_session.refresh(t)
    return t


@pytest.mark.asyncio
async def test_une_tournee_au_pot_sort_des_listes_du_jour(client, db_session, base):
    """Sinon elle polluerait l'ordonnancement et l'ecran postier de la journee
    ou elle a ete construite, alors qu'elle n'appartient a aucune journee."""
    au_pot = await _tour(db_session, base, pooled=True)
    normale = await _tour(db_session, base, pooled=False)

    resp = await client.get("/api/tours/", params={"date": DATE_CONSTRUCTION})
    assert resp.status_code == 200, resp.text
    ids = {t["id"] for t in resp.json()}
    assert normale.id in ids
    assert au_pot.id not in ids


@pytest.mark.asyncio
async def test_on_peut_les_demander_explicitement(client, db_session, base):
    au_pot = await _tour(db_session, base, pooled=True)

    resp = await client.get("/api/tours/", params={"date": DATE_CONSTRUCTION,
                                                   "include_pooled": True})
    assert au_pot.id in {t["id"] for t in resp.json()}


@pytest.mark.asyncio
async def test_le_pot_annonce_son_compte(client, db_session, base):
    """« Ce sous-menu devrait avoir un indicatif des tours restant a planifier
    afin de ne pas oublier de le faire » — c'est tout l'interet du ticket."""
    for _ in range(3):
        await _tour(db_session, base, pooled=True)

    resp = await client.get("/api/tours/pooled", params={"base_id": base.id})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["count"] == 3
    assert len(data["tours"]) == 3
    assert data["tours"][0]["built_on"] == DATE_CONSTRUCTION


@pytest.mark.asyncio
async def test_sortir_du_pot_donne_la_date(client, db_session, base):
    t = await _tour(db_session, base, pooled=True)

    resp = await client.post("/api/tours/pooled/schedule", json={
        "tour_ids": [t.id], "date": DATE_PLANIFIEE, "delivery_date": "2026-11-11",
    })
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["scheduled"]) == 1

    await db_session.refresh(t)
    assert t.pooled is False
    assert t.date == DATE_PLANIFIEE
    assert t.delivery_date == "2026-11-11"

    # Et elle reapparait dans la journee visee.
    ids = {x["id"] for x in (await client.get("/api/tours/",
                                              params={"date": DATE_PLANIFIEE})).json()}
    assert t.id in ids


@pytest.mark.asyncio
async def test_la_date_de_livraison_n_est_pas_ecrasee_sans_raison(
    client, db_session, base,
):
    """Une tournee planifiee le J est livree le J+1 : ne pas fournir la date de
    livraison ne doit pas la recopier sur celle de planification."""
    t = await _tour(db_session, base, pooled=True)
    t.delivery_date = "2026-11-07"
    await db_session.commit()

    await client.post("/api/tours/pooled/schedule", json={
        "tour_ids": [t.id], "date": DATE_PLANIFIEE,
    })

    await db_session.refresh(t)
    assert t.date == DATE_PLANIFIEE
    assert t.delivery_date == "2026-11-07", "la date de livraison ne doit pas bouger"


@pytest.mark.asyncio
async def test_une_tournee_deja_planifiee_est_refusee(client, db_session, base):
    """L'appel sert a sortir du pot, pas a redater une tournee en cours : ce
    geste-la a ses propres ecrans et ses propres controles."""
    t = await _tour(db_session, base, pooled=False)

    resp = await client.post("/api/tours/pooled/schedule", json={
        "tour_ids": [t.id], "date": DATE_PLANIFIEE,
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["not_pooled"] == [t.code]
    assert resp.json()["scheduled"] == []

    await db_session.refresh(t)
    assert t.date == DATE_CONSTRUCTION, "la date ne doit pas avoir bouge"


@pytest.mark.asyncio
async def test_une_tournee_est_creee_au_pot_sur_demande(client, db_session, base):
    """« Lors de la creation des tours on dit a CMRO d'envoyer ces tours dans
    un pot »."""
    resp = await client.post("/api/tours/", json={
        "code": f"T{uuid.uuid4().hex[:6].upper()}",
        "date": DATE_CONSTRUCTION,
        "base_id": base.id,
        "pooled": True,
        "stops": [],
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["pooled"] is True

    pot = (await client.get("/api/tours/pooled", params={"base_id": base.id})).json()
    assert resp.json()["id"] in {t["id"] for t in pot["tours"]}


@pytest.mark.asyncio
async def test_une_tournee_ordinaire_n_est_pas_au_pot(client, db_session, base):
    """Le defaut doit rester le comportement d'aujourd'hui."""
    resp = await client.post("/api/tours/", json={
        "code": f"T{uuid.uuid4().hex[:6].upper()}",
        "date": DATE_CONSTRUCTION,
        "base_id": base.id,
        "stops": [],
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["pooled"] is False
