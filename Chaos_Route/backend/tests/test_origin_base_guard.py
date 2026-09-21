"""Ticket #84 : un tour = UNE seule base d'origine.

Un camion ne charge que sur un site, et la base est persistée sur le tour : elle
fixe le lieu de chargement, les kms (calculés depuis ses coordonnées), les
contrats proposés et l'export planning. Or un même PDV est servi depuis deux
bases le même jour (SEC → 092 Gosselies, FRAIS → 080 Villers) : cliquer sa
pastille empilait les deux dans le même tour. 23 tournées en production
mélangeaient deux bases, dont deux créées après le correctif d'affichage.

Le trafic a tranché (réponse B au ticket) : on empêche, on n'avertit pas.
Trois vecteurs sont couverts ici — le payload de création, la reprise gloutonne
qui complétait jusqu'à la cible EQC, et l'ajout d'un PDV à un tour ordonnancé.
"""

import uuid

import pytest

DATE = "2026-06-18"


async def _make_base(db_session, region, code=None):
    from app.models.base_logistics import BaseLogistics
    base = BaseLogistics(
        code=code or f"B{uuid.uuid4().hex[:5].upper()}", name="Base", region_id=region.id
    )
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)
    return base


async def _make_pdv(db_session, region):
    from app.models.pdv import PDV, PDVType
    code = f"P{uuid.uuid4().hex[:5].upper()}"
    pdv = PDV(code=code, name=f"PDV {code}", type=PDVType.HYPER, region_id=region.id)
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)
    return pdv


async def _make_volume(db_session, pdv, base, eqp, *, temp="SEC"):
    from app.models.volume import Volume, TemperatureClass
    vol = Volume(
        pdv_id=pdv.id, date=DATE, dispatch_date=DATE, eqp_count=eqp,
        temperature_class=TemperatureClass(temp), base_origin_id=base.id, tour_id=None,
    )
    db_session.add(vol)
    await db_session.commit()
    await db_session.refresh(vol)
    return vol


def _tour_payload(base, stops, total):
    return {
        "date": DATE, "code": f"T-{uuid.uuid4().hex[:8]}", "base_id": base.id,
        "status": "DRAFT", "total_eqp": total, "stops": stops,
    }


@pytest.mark.asyncio
async def test_two_origin_bases_in_one_tour_refused(client, db_session, test_region):
    """Le cœur du #84 : le SEC de Gosselies et le FRAIS de Villers ne peuvent pas
    partir dans la même tournée."""
    from sqlalchemy import select
    from app.models.tour import Tour

    gosselies = await _make_base(db_session, test_region)
    villers = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    sec = await _make_volume(db_session, pdv, gosselies, 10.0)
    frais = await _make_volume(db_session, pdv, villers, 8.0, temp="FRAIS")

    stops = [
        {"pdv_id": pdv.id, "volume_id": sec.id, "sequence_order": 1, "eqp_count": 10.0},
        {"pdv_id": pdv.id, "volume_id": frais.id, "sequence_order": 2, "eqp_count": 8.0},
    ]
    resp = await client.post("/api/tours/", json=_tour_payload(gosselies, stops, 18.0))
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert gosselies.code in detail and villers.code in detail  # les deux bases nommees
    assert pdv.code in detail

    # Rien n'est cree, aucun volume rattache / nothing created, no volume attached
    assert (await db_session.execute(select(Tour).where(Tour.date == DATE))).scalars().first() is None
    for vol in (sec, frais):
        await db_session.refresh(vol)
        assert vol.tour_id is None


@pytest.mark.asyncio
async def test_single_origin_base_still_passes(client, db_session, test_region):
    """Le cas normal n'est pas touché : deux PDV d'une même base passent."""
    base = await _make_base(db_session, test_region)
    pdv_a = await _make_pdv(db_session, test_region)
    pdv_b = await _make_pdv(db_session, test_region)
    vol_a = await _make_volume(db_session, pdv_a, base, 10.0)
    vol_b = await _make_volume(db_session, pdv_b, base, 12.0)

    stops = [
        {"pdv_id": pdv_a.id, "volume_id": vol_a.id, "sequence_order": 1, "eqp_count": 10.0},
        {"pdv_id": pdv_b.id, "volume_id": vol_b.id, "sequence_order": 2, "eqp_count": 12.0},
    ]
    resp = await client.post("/api/tours/", json=_tour_payload(base, stops, 22.0))
    assert resp.status_code == 201, resp.text

    for vol in (vol_a, vol_b):
        await db_session.refresh(vol)
        assert vol.tour_id is not None


@pytest.mark.asyncio
async def test_declared_base_must_match_volumes(client, db_session, test_region):
    """La base déclarée sur le tour ne peut pas contredire l'origine des volumes :
    c'est ce décalage qui faussait le site de chargement et les kms (57 tournées
    en production)."""
    gosselies = await _make_base(db_session, test_region)
    villers = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    vol = await _make_volume(db_session, pdv, gosselies, 10.0)

    stops = [{"pdv_id": pdv.id, "volume_id": vol.id, "sequence_order": 1, "eqp_count": 10.0}]
    resp = await client.post("/api/tours/", json=_tour_payload(villers, stops, 10.0))
    assert resp.status_code == 409, resp.text
    assert gosselies.code in resp.json()["detail"]

    await db_session.refresh(vol)
    assert vol.tour_id is None


@pytest.mark.asyncio
async def test_greedy_topup_stays_on_tour_base(client, db_session, test_region):
    """La reprise gloutonne (stop sans volume_id) ne complète plus avec un volume
    parti d'une autre base."""
    gosselies = await _make_base(db_session, test_region)
    villers = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    sec = await _make_volume(db_session, pdv, gosselies, 10.0)
    frais = await _make_volume(db_session, pdv, villers, 10.0, temp="FRAIS")

    # Stop legacy sans volume_id, cible EQC assez large pour avaler les deux.
    stops = [{"pdv_id": pdv.id, "sequence_order": 1, "eqp_count": 20.0}]
    resp = await client.post("/api/tours/", json=_tour_payload(gosselies, stops, 20.0))
    assert resp.status_code == 201, resp.text
    tour_id = resp.json()["id"]

    await db_session.refresh(sec)
    await db_session.refresh(frais)
    assert sec.tour_id == tour_id
    assert frais.tour_id is None, "le volume d'une autre base a ete avale"


@pytest.mark.asyncio
async def test_add_stop_refuses_pdv_from_another_base(client, db_session, test_region):
    """Ajouter un PDV à un tour ordonnancé n'y fait plus entrer son volume parti
    d'une autre base."""
    gosselies = await _make_base(db_session, test_region)
    villers = await _make_base(db_session, test_region)
    pdv_ok = await _make_pdv(db_session, test_region)
    pdv_autre = await _make_pdv(db_session, test_region)
    vol_ok = await _make_volume(db_session, pdv_ok, gosselies, 10.0)
    vol_autre = await _make_volume(db_session, pdv_autre, villers, 6.0, temp="FRAIS")

    stops = [{"pdv_id": pdv_ok.id, "volume_id": vol_ok.id, "sequence_order": 1, "eqp_count": 10.0}]
    created = await client.post("/api/tours/", json=_tour_payload(gosselies, stops, 10.0))
    assert created.status_code == 201, created.text
    tour_id = created.json()["id"]

    resp = await client.post(
        f"/api/tours/{tour_id}/stops",
        json={"pdv_id": pdv_autre.id, "eqp_count": 6.0},
    )
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert pdv_autre.code in detail and villers.code in detail

    await db_session.refresh(vol_autre)
    assert vol_autre.tour_id is None
