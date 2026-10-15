"""Corriger la base de depart de tournees deja construites (#87).

Gaetan : « une erreur a l'importation des volumes de Trazegnies sur les tours du
25/09. Le RCAM s'est trompe de site de depart et ne s'en est pas rendu compte.
Il a dit a CMRO depart et retour de Villers. Les tours sont valides et envoyes a
la poste. » Quinze tournees etaient a refaire a la main.

Trois invariants defendus ici :
  - les volumes suivent leur tournee (#84 : un tour = UNE base d'origine) ;
  - les kilometres sont recalcules, sinon l'erreur change juste de place ;
  - une tournee deja sortie de la barriere n'est pas reecrite.
"""

import uuid

import pytest
import pytest_asyncio

DATE = "2026-11-05"


@pytest_asyncio.fixture
async def decor(db_session, test_region):
    """Deux bases, un PDV, un distancier, une tournee planifiee depuis la base A."""
    from app.models.base_logistics import BaseLogistics
    from app.models.distance_matrix import DistanceMatrix
    from app.models.pdv import PDV, PDVType
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop
    from app.models.volume import Volume

    sfx = uuid.uuid4().hex[:5].upper()
    a = BaseLogistics(code=f"A{sfx}", name="Villers test", region_id=test_region.id,
                      latitude=50.5794, longitude=5.2983)
    b = BaseLogistics(code=f"B{sfx}", name="Trazegnies test", region_id=test_region.id,
                      latitude=50.4582, longitude=4.3376)
    pdv = PDV(code=f"P{sfx}", name=f"PDV {sfx}", type=PDVType.HYPER, address="a",
              city="c", postal_code="0000", latitude=50.50, longitude=4.80,
              region_id=test_region.id)
    for o in (a, b, pdv):
        db_session.add(o)
    await db_session.commit()
    for o in (a, b, pdv):
        await db_session.refresh(o)

    # Distancier : A est loin, B est pres. Le recalcul doit se voir.
    db_session.add_all([
        DistanceMatrix(origin_type="BASE", origin_id=a.id, destination_type="PDV",
                       destination_id=pdv.id, distance_km=100, duration_minutes=80),
        DistanceMatrix(origin_type="BASE", origin_id=b.id, destination_type="PDV",
                       destination_id=pdv.id, distance_km=20, duration_minutes=25),
    ])

    tour = Tour(code=f"T{sfx}", date=DATE, delivery_date=DATE, base_id=a.id,
                status=TourStatus.VALIDATED, departure_time="06:00", total_km=200)
    db_session.add(tour)
    await db_session.commit()
    await db_session.refresh(tour)

    db_session.add(TourStop(tour_id=tour.id, pdv_id=pdv.id, sequence_order=1, eqp_count=10))
    db_session.add(Volume(pdv_id=pdv.id, date=DATE, dispatch_date=DATE, eqp_count=10,
                          temperature_class="SEC", base_origin_id=a.id, tour_id=tour.id))
    await db_session.commit()
    await db_session.refresh(tour)
    return {"a": a, "b": b, "pdv": pdv, "tour": tour}


@pytest.mark.asyncio
async def test_la_simulation_annonce_sans_ecrire(client, db_session, decor):
    """L'action porte sur des tournees deja envoyees a la poste : on regarde
    avant de toucher."""
    tour, b = decor["tour"], decor["b"]

    resp = await client.post("/api/tours/change-base", json={
        "tour_ids": [tour.id], "base_id": b.id, "dry_run": True,
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["dry_run"] is True
    assert len(data["modifiables"]) == 1
    assert data["volumes_a_deplacer"] == 1

    await db_session.refresh(tour)
    assert tour.base_id == decor["a"].id, "la simulation ne doit rien changer"


@pytest.mark.asyncio
async def test_le_changement_deplace_tour_et_volumes(client, db_session, decor):
    """Laisser les volumes sur l'ancienne base casserait l'invariant du #84 :
    un tour a UNE base d'origine et ses volumes la partagent."""
    from sqlalchemy import select
    from app.models.volume import Volume

    tour, a, b = decor["tour"], decor["a"], decor["b"]

    resp = await client.post("/api/tours/change-base", json={
        "tour_ids": [tour.id], "base_id": b.id, "dry_run": False,
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["volumes_deplaces"] == 1

    await db_session.refresh(tour)
    assert tour.base_id == b.id

    vols = (await db_session.execute(
        select(Volume).where(Volume.tour_id == tour.id)
    )).scalars().all()
    assert all(v.base_origin_id == b.id for v in vols)
    assert all(v.base_origin_id != a.id for v in vols)


@pytest.mark.asyncio
async def test_les_kilometres_sont_recalcules(client, db_session, decor):
    """Changer la base sans recalculer laisserait les km de Villers sur des
    tournees parties de Trazegnies : l'erreur aurait juste change de place."""
    tour, b = decor["tour"], decor["b"]
    ancien_km = float(tour.total_km)

    resp = await client.post("/api/tours/change-base", json={
        "tour_ids": [tour.id], "base_id": b.id, "dry_run": False,
    })
    assert resp.status_code == 200, resp.text

    await db_session.refresh(tour)
    nouveau_km = float(tour.total_km)
    assert nouveau_km != ancien_km
    # Aller-retour base B <-> PDV = 20 + 20.
    assert nouveau_km == pytest.approx(40.0, abs=0.01)


@pytest.mark.asyncio
async def test_une_tournee_deja_sortie_est_refusee(client, db_session, decor):
    """Le passage de barriere est un constat du poste de garde. A ce stade le
    camion est physiquement parti d'un site : on ne reecrit pas d'ou."""
    tour, a, b = decor["tour"], decor["a"], decor["b"]
    tour.barrier_exit_time = "06:12"
    await db_session.commit()

    resp = await client.post("/api/tours/change-base", json={
        "tour_ids": [tour.id], "base_id": b.id, "dry_run": False,
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["deja_parties"] == [tour.code]
    assert data["modifies"] == []

    await db_session.refresh(tour)
    assert tour.base_id == a.id


@pytest.mark.asyncio
async def test_la_base_de_retour_egale_au_depart_est_rangee_en_null(
    client, db_session, decor,
):
    """Convention du #64 : une seule forme pour le cas normal."""
    tour, b = decor["tour"], decor["b"]

    resp = await client.post("/api/tours/change-base", json={
        "tour_ids": [tour.id], "base_id": b.id, "return_base_id": b.id, "dry_run": False,
    })
    assert resp.status_code == 200, resp.text

    await db_session.refresh(tour)
    assert tour.return_base_id is None


@pytest.mark.asyncio
async def test_une_base_inconnue_est_refusee(client, decor):
    resp = await client.post("/api/tours/change-base", json={
        "tour_ids": [decor["tour"].id], "base_id": 999999, "dry_run": True,
    })
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_les_tournees_introuvables_sont_nommees(client, decor):
    """Plutot que d'etre ignorees en silence sur une action en masse."""
    resp = await client.post("/api/tours/change-base", json={
        "tour_ids": [decor["tour"].id, 999999], "base_id": decor["b"].id, "dry_run": True,
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["introuvables"] == [999999]
