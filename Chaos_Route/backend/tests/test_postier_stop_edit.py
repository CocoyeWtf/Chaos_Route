"""Ticket #37 : le postier doit pouvoir corriger une tournée déjà envoyée.

Trois manques constatés sur l'onglet postier :
- une tournée validée ne pouvait pas être supprimée pour libérer ses volumes :
  on retirait les PDV un par un jusqu'au dernier, refusé (« Supprimez le tour
  entier ») — sans qu'aucun bouton ne permette de le faire ;
- la quantité d'un arrêt déjà présent n'était pas modifiable, et le PDV étant
  exclu de la liste d'ajout, une tournée à un seul PDV était figée ;
- l'ordre de livraison n'était pas modifiable après ajout d'un PDV.

Les deux derniers points s'appuient désormais sur `PATCH /tours/{id}/stops/{id}`
et sur `PUT /tours/{id}/reorder-stops`, que ces tests verrouillent.
"""

import uuid

import pytest

DATE = "2026-10-02"


# Les objets ORM expirent au commit suivant et un accès à `.id` déclencherait
# alors une lecture en base, interdite hors contexte greenlet. On ne fait donc
# circuler que des identifiants. / Pass ids around, not ORM objects.
async def _base(db_session, region_id: int) -> int:
    from app.models.base_logistics import BaseLogistics
    b = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base #37", region_id=region_id)
    db_session.add(b)
    await db_session.commit()
    await db_session.refresh(b)
    return b.id


async def _pdv(db_session, region_id: int) -> int:
    from app.models.pdv import PDV, PDVType
    code = f"P{uuid.uuid4().hex[:5].upper()}"
    p = PDV(code=code, name=f"PDV {code}", type=PDVType.HYPER, region_id=region_id)
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    return p.id


async def _tour(db_session, base_id: int, pdvs, *, status="VALIDATED", departure="06:00") -> int:
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop
    t = Tour(
        date=DATE, code=f"T-{uuid.uuid4().hex[:10]}", base_id=base_id,
        status=getattr(TourStatus, status), departure_time=departure,
        vehicle_type="SEMI", total_eqp=sum(e for _, e in pdvs),
    )
    db_session.add(t)
    await db_session.flush()
    for i, (pdv_id, eqp) in enumerate(pdvs, start=1):
        db_session.add(TourStop(tour_id=t.id, pdv_id=pdv_id, sequence_order=i, eqp_count=eqp))
    await db_session.commit()
    await db_session.refresh(t)
    return t.id


async def _stops(db_session, tour_id):
    from sqlalchemy import select
    from app.models.tour_stop import TourStop
    rows = (await db_session.execute(
        select(TourStop).where(TourStop.tour_id == tour_id)
    )).scalars().all()
    return sorted(rows, key=lambda s: s.sequence_order)


@pytest.mark.asyncio
async def test_eqc_editable_on_single_stop_tour(client, db_session, test_region):
    """Le cœur du #37 : une tournée à UN seul PDV n'est plus figée."""
    from sqlalchemy import select
    from app.models.tour import Tour

    region_id = test_region.id
    base_id = await _base(db_session, region_id)
    pdv_id = await _pdv(db_session, region_id)
    tour_id = await _tour(db_session, base_id, [(pdv_id, 20.0)])
    stop = (await _stops(db_session, tour_id))[0]

    resp = await client.patch(f"/api/tours/{tour_id}/stops/{stop.id}", json={"eqp_count": 26.5})
    assert resp.status_code == 200, resp.text

    db_session.expire_all()
    stop = (await _stops(db_session, tour_id))[0]
    assert float(stop.eqp_count) == 26.5
    # Le total de la tournée suit / the tour total follows
    tour = (await db_session.execute(select(Tour).where(Tour.id == tour_id))).scalar_one()
    assert float(tour.total_eqp) == 26.5


@pytest.mark.asyncio
async def test_eqc_edit_refused_after_departure_signal(client, db_session, test_region):
    """Une tournée partie est verrouillée : le top départ reste la limite."""
    from sqlalchemy import select
    from app.models.tour import Tour

    region_id = test_region.id
    base_id = await _base(db_session, region_id)
    pdv_id = await _pdv(db_session, region_id)
    tour_id = await _tour(db_session, base_id, [(pdv_id, 10.0)])
    tour = (await db_session.execute(select(Tour).where(Tour.id == tour_id))).scalar_one()
    tour.departure_signal_time = "2026-10-02T05:55:00"
    await db_session.commit()
    stop = (await _stops(db_session, tour_id))[0]

    resp = await client.patch(f"/api/tours/{tour_id}/stops/{stop.id}", json={"eqp_count": 15})
    assert resp.status_code == 409, resp.text

    db_session.expire_all()
    stop = (await _stops(db_session, tour_id))[0]
    assert float(stop.eqp_count) == 10.0


@pytest.mark.asyncio
async def test_reorder_stops_after_add(client, db_session, test_region):
    """L'ordre de livraison est modifiable une fois un PDV ajouté."""
    region_id = test_region.id
    base_id = await _base(db_session, region_id)
    a, b, c = [await _pdv(db_session, region_id) for _ in range(3)]
    tour_id = await _tour(db_session, base_id, [(a, 5.0), (b, 6.0), (c, 7.0)])
    stops = await _stops(db_session, tour_id)
    inverse = [s.id for s in reversed(stops)]

    resp = await client.put(f"/api/tours/{tour_id}/reorder-stops", json={"stop_order": inverse})
    assert resp.status_code == 200, resp.text

    db_session.expire_all()
    apres = await _stops(db_session, tour_id)
    assert [s.id for s in apres] == inverse


@pytest.mark.asyncio
async def test_validated_tour_can_be_deleted_and_frees_volumes(client, db_session, test_region):
    """Une tournée validée se supprime et rend ses volumes au pool.

    C'est la porte de sortie que l'écran n'offrait pas : sans elle, retirer les
    PDV un par un butait sur le dernier, et les volumes restaient bloqués.
    """
    from sqlalchemy import select
    from app.models.tour import Tour
    from app.models.volume import Volume, TemperatureClass

    region_id = test_region.id
    base_id = await _base(db_session, region_id)
    pdv_id = await _pdv(db_session, region_id)
    tour_id = await _tour(db_session, base_id, [(pdv_id, 20.0)])
    vol = Volume(
        pdv_id=pdv_id, date=DATE, dispatch_date=DATE, eqp_count=20.0,
        temperature_class=TemperatureClass("SEC"), base_origin_id=base_id, tour_id=tour_id,
    )
    db_session.add(vol)
    await db_session.commit()
    await db_session.refresh(vol)
    vol_id = vol.id

    resp = await client.delete(f"/api/tours/{tour_id}")
    assert resp.status_code == 204, resp.text

    db_session.expire_all()
    assert (await db_session.execute(select(Tour).where(Tour.id == tour_id))).scalar_one_or_none() is None
    libere = (await db_session.execute(select(Volume).where(Volume.id == vol_id))).scalar_one()
    assert libere.tour_id is None, "le volume doit être rendu au pool"
