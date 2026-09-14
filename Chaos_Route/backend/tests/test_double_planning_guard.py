"""Tickets #27 (suivi) / #83 : ne plus planifier deux fois le même volume, et
scoper le chargement des volumes sur la date de répartition.

Avant correctif :
- `GET /volumes` n'avait pas de filtre `dispatch_date` (le filtre `date` porte
  sur une AUTRE colonne), donc les vues de planification chargeaient tout
  l'historique pour n'en garder qu'une journée → lenteur, et fenêtre pendant
  laquelle un volume déjà pris restait affiché comme disponible ;
- créer une tournée référençant un volume déjà rattaché à une autre ne levait
  aucune erreur : le volume n'était pas réassigné (garde `tour_id IS NULL`) mais
  l'arrêt FANTÔME était créé, EQC comptés, et la reprise gloutonne pouvait
  avaler un autre volume du même PDV. 10 cas constatés en production.
"""

import uuid

import pytest
from sqlalchemy import select

DATE = "2026-06-11"


async def _make_base(db_session, region):
    from app.models.base_logistics import BaseLogistics
    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base", region_id=region.id)
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


async def _make_volume(db_session, pdv, base, eqp, *, date=DATE, dispatch_date=DATE):
    from app.models.volume import Volume, TemperatureClass
    vol = Volume(
        pdv_id=pdv.id, date=date, dispatch_date=dispatch_date, eqp_count=eqp,
        temperature_class=TemperatureClass("SEC"), base_origin_id=base.id, tour_id=None,
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
async def test_volume_already_planned_is_refused(client, db_session, test_region):
    """Le coeur du #83 : refus explicite, pas d'arrêt fantôme."""
    from app.models.tour import Tour
    from app.models.tour_stop import TourStop

    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    vol = await _make_volume(db_session, pdv, base, 12.5)

    stops = [{"pdv_id": pdv.id, "volume_id": vol.id, "sequence_order": 1, "eqp_count": 12.5}]
    first = await client.post("/api/tours/", json=_tour_payload(base, stops, 12.5))
    assert first.status_code == 201, first.text
    first_id = first.json()["id"]

    # Deuxieme tournee sur le MEME volume -> refus
    second = await client.post("/api/tours/", json=_tour_payload(base, stops, 12.5))
    assert second.status_code == 409, second.text
    detail = second.json()["detail"]
    assert pdv.code in detail                      # le PDV concerne est nomme
    assert first.json()["code"] in detail          # et la tournee qui le detient

    # Aucune seconde tournee, aucun arret fantome / no phantom tour or stop
    tours = (await db_session.execute(select(Tour).where(Tour.date == DATE))).scalars().all()
    assert [t.id for t in tours] == [first_id]
    stops_db = (await db_session.execute(
        select(TourStop).where(TourStop.volume_id == vol.id))).scalars().all()
    assert len(stops_db) == 1 and stops_db[0].tour_id == first_id


@pytest.mark.asyncio
async def test_other_volume_not_swallowed_on_conflict(client, db_session, test_region):
    """Le refus protege aussi le 2e volume du PDV, que la reprise gloutonne
    pouvait avaler pour atteindre la cible EQC."""
    from app.models.volume import Volume

    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    pris = await _make_volume(db_session, pdv, base, 20.0)
    libre = await _make_volume(db_session, pdv, base, 20.0)

    stops = [{"pdv_id": pdv.id, "volume_id": pris.id, "sequence_order": 1, "eqp_count": 20.0}]
    assert (await client.post("/api/tours/", json=_tour_payload(base, stops, 20.0))).status_code == 201

    resp = await client.post("/api/tours/", json=_tour_payload(base, stops, 20.0))
    assert resp.status_code == 409, resp.text

    await db_session.refresh(libre)
    assert libre.tour_id is None, "le volume libre du meme PDV a ete avale"


@pytest.mark.asyncio
async def test_volumes_filtered_by_dispatch_date(client, db_session, test_region):
    """`dispatch_date` filtre bien, et ne se confond pas avec `date`."""
    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    jour = await _make_volume(db_session, pdv, base, 5.0, dispatch_date=DATE)
    autre = await _make_volume(db_session, pdv, base, 6.0, dispatch_date="2026-06-12")
    # Meme `date` que `jour`, mais repartie un autre jour : ne doit PAS sortir.
    assert autre.date == DATE

    resp = await client.get("/api/volumes/", params={"dispatch_date": DATE, "limit": 5000})
    assert resp.status_code == 200, resp.text
    ids = {v["id"] for v in resp.json()}
    assert jour.id in ids
    assert autre.id not in ids

    # Sans le filtre, les deux sortent (comportement historique preserve).
    resp = await client.get("/api/volumes/", params={"limit": 5000})
    ids = {v["id"] for v in resp.json()}
    assert {jour.id, autre.id} <= ids
