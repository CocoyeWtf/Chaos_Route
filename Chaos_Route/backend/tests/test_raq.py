"""Ticket #68 : reste à quai.

Le postier constate au chargement qu'une partie de la marchandise n'est pas
partie. Deux effets décidés avec l'exploitation : l'arrêt est réduit d'autant —
la tournée annonce ce qui est réellement parti — et la quantité restée à quai
repart dans les volumes disponibles, marquée « RAQ », à la date que le postier
choisit.
"""

import uuid

import pytest
from sqlalchemy import select

DATE = "2026-10-06"
DEMAIN = "2026-10-07"


async def _fixture(db_session, region_id, eqp=20.0):
    """Une tournée validée d'un PDV, avec son volume rattaché."""
    from app.models.base_logistics import BaseLogistics
    from app.models.pdv import PDV, PDVType
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop
    from app.models.volume import Volume, TemperatureClass

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base #68", region_id=region_id)
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)

    code = f"P{uuid.uuid4().hex[:5].upper()}"
    pdv = PDV(code=code, name=f"PDV {code}", type=PDVType.HYPER, region_id=region_id)
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)

    tour = Tour(
        date=DATE, code=f"T-{uuid.uuid4().hex[:10]}", base_id=base.id,
        status=TourStatus.VALIDATED, departure_time="06:00", vehicle_type="SEMI",
        total_eqp=eqp,
    )
    db_session.add(tour)
    await db_session.flush()

    vol = Volume(
        pdv_id=pdv.id, date=DATE, dispatch_date=DATE, eqp_count=eqp,
        temperature_class=TemperatureClass("FRAIS"), base_origin_id=base.id, tour_id=tour.id,
    )
    db_session.add(vol)
    db_session.add(TourStop(tour_id=tour.id, pdv_id=pdv.id, sequence_order=1,
                            volume_id=None, eqp_count=eqp))
    await db_session.commit()
    await db_session.refresh(tour)

    from app.models.tour_stop import TourStop as TS
    stop = (await db_session.execute(select(TS).where(TS.tour_id == tour.id))).scalars().first()
    return {"base_id": base.id, "pdv_id": pdv.id, "tour_id": tour.id, "stop_id": stop.id}


@pytest.mark.asyncio
async def test_raq_reduit_l_arret_et_rend_le_volume(client, db_session, test_region):
    """Le cœur du #68 : l'arrêt maigrit, le reste redevient planifiable."""
    from app.models.tour import Tour
    from app.models.tour_stop import TourStop
    from app.models.volume import Volume

    f = await _fixture(db_session, test_region.id, eqp=20.0)

    resp = await client.post(
        f"/api/tours/{f['tour_id']}/stops/{f['stop_id']}/raq",
        json={"eqp_count": 5.0, "dispatch_date": DEMAIN},
    )
    assert resp.status_code == 200, resp.text

    db_session.expire_all()
    stop = (await db_session.execute(
        select(TourStop).where(TourStop.id == f["stop_id"]))).scalar_one()
    assert float(stop.eqp_count) == 15.0, "l'arrêt doit refléter ce qui est parti"

    tour = (await db_session.execute(
        select(Tour).where(Tour.id == f["tour_id"]))).scalar_one()
    assert float(tour.total_eqp) == 15.0

    raq = (await db_session.execute(select(Volume).where(
        Volume.is_raq == True, Volume.pdv_id == f["pdv_id"]))).scalars().all()  # noqa: E712
    assert len(raq) == 1
    v = raq[0]
    assert float(v.eqp_count) == 5.0
    assert v.tour_id is None, "le reste à quai doit être disponible"
    assert v.dispatch_date == DEMAIN
    assert v.pdv_id == f["pdv_id"]
    assert v.base_origin_id == f["base_id"], "même base de chargement que l'origine"
    assert v.temperature_class.value == "FRAIS", "même température que l'origine"
    assert v.raq_from_tour_code, "la tournée d'origine doit rester tracée"


@pytest.mark.asyncio
async def test_raq_refuse_si_superieur_a_l_arret(client, db_session, test_region):
    """On ne peut pas laisser à quai plus que ce qui était prévu."""
    from app.models.tour_stop import TourStop
    from app.models.volume import Volume

    f = await _fixture(db_session, test_region.id, eqp=10.0)

    resp = await client.post(
        f"/api/tours/{f['tour_id']}/stops/{f['stop_id']}/raq",
        json={"eqp_count": 12.0, "dispatch_date": DEMAIN},
    )
    assert resp.status_code == 422, resp.text

    db_session.expire_all()
    stop = (await db_session.execute(
        select(TourStop).where(TourStop.id == f["stop_id"]))).scalar_one()
    assert float(stop.eqp_count) == 10.0, "rien ne doit bouger sur un refus"
    assert (await db_session.execute(select(Volume).where(
        Volume.is_raq == True, Volume.pdv_id == f["pdv_id"]))).scalars().first() is None  # noqa: E712


@pytest.mark.asyncio
async def test_raq_total_laisse_l_arret_a_zero(client, db_session, test_region):
    """Rien n'est parti : l'arrêt tombe à zéro mais reste visible dans la tournée."""
    from app.models.tour_stop import TourStop
    from app.models.volume import Volume

    f = await _fixture(db_session, test_region.id, eqp=8.0)

    resp = await client.post(
        f"/api/tours/{f['tour_id']}/stops/{f['stop_id']}/raq",
        json={"eqp_count": 8.0, "dispatch_date": DEMAIN},
    )
    assert resp.status_code == 200, resp.text

    db_session.expire_all()
    stop = (await db_session.execute(
        select(TourStop).where(TourStop.id == f["stop_id"]))).scalar_one()
    assert float(stop.eqp_count) == 0.0
    v = (await db_session.execute(select(Volume).where(
        Volume.is_raq == True, Volume.pdv_id == f["pdv_id"]))).scalars().one()  # noqa: E712
    assert float(v.eqp_count) == 8.0


@pytest.mark.asyncio
async def test_volume_raq_sort_dans_les_volumes_disponibles(client, db_session, test_region):
    """Le volume RAQ est servi par l'API volumes, avec son marqueur."""
    f = await _fixture(db_session, test_region.id, eqp=12.0)
    resp = await client.post(
        f"/api/tours/{f['tour_id']}/stops/{f['stop_id']}/raq",
        json={"eqp_count": 4.0, "dispatch_date": DEMAIN},
    )
    assert resp.status_code == 200, resp.text

    listing = await client.get("/api/volumes/", params={"dispatch_date": DEMAIN, "limit": 500})
    assert listing.status_code == 200, listing.text
    raq = [v for v in listing.json() if v.get("is_raq") and v["pdv_id"] == f["pdv_id"]]
    assert len(raq) == 1
    assert raq[0]["eqp_count"] == 4.0
    assert raq[0]["raq_from_tour_code"]
