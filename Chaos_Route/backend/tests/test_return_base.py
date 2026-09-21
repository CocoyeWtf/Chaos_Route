"""Ticket #64 : encoder une base de retour différente de la base de départ.

Un chauffeur part de Villers, livre, recharge sa semi à Trazegnies pour une
deuxième tournée, puis rentre à Villers en fin de second tour. CMRO calculait
systématiquement un retour sur la base de départ : l'agent trafic devait donc
décaler à la main le départ du deuxième tour pour absorber le trajet base-base.

Trois choses doivent suivre la base de retour : l'heure de retour, le kilométrage
total, et le dernier segment (dont dépend la taxe km). Et surtout, ne rien
préciser doit laisser le calcul strictement identique à l'existant.
"""

import uuid

import pytest

DATE = "2026-06-25"


async def _make_base(db_session, region):
    from app.models.base_logistics import BaseLogistics
    base = BaseLogistics(
        code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base", region_id=region.id
    )
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)
    return base


async def _make_pdv(db_session, region):
    from app.models.pdv import PDV, PDVType
    code = f"P{uuid.uuid4().hex[:5].upper()}"
    pdv = PDV(code=code, name=f"PDV {code}", type=PDVType.HYPER, region_id=region.id,
              dock_time_minutes=0, unload_time_per_eqp_minutes=0)
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)
    return pdv


async def _distance(db_session, o_type, o_id, d_type, d_id, km, minutes):
    from app.models.distance_matrix import DistanceMatrix
    db_session.add(DistanceMatrix(
        origin_type=o_type, origin_id=o_id, destination_type=d_type,
        destination_id=d_id, distance_km=km, duration_minutes=minutes,
    ))
    await db_session.commit()


async def _tracteur(db_session):
    from app.models.vehicle import Vehicle, VehicleStatus, FleetVehicleType
    v = Vehicle(
        code=f"V{uuid.uuid4().hex[:5].upper()}", status=VehicleStatus.ACTIVE,
        fleet_vehicle_type=FleetVehicleType.TRACTEUR,
    )
    db_session.add(v)
    await db_session.commit()
    await db_session.refresh(v)
    return v


async def _tour_avec_un_stop(db_session, base, pdv):
    from app.models.tour import Tour
    from app.models.tour_stop import TourStop
    tour = Tour(date=DATE, code=f"T-{uuid.uuid4().hex[:8]}", base_id=base.id, total_eqp=1)
    db_session.add(tour)
    await db_session.commit()
    await db_session.refresh(tour)
    db_session.add(TourStop(tour_id=tour.id, pdv_id=pdv.id, sequence_order=1, eqp_count=1))
    await db_session.commit()
    return tour.id


@pytest.mark.asyncio
async def test_retour_sur_autre_base_allonge_horaire_et_km(db_session, test_region):
    """Le retour vise la base indiquée, pas celle du départ."""
    from app.api.tours import calculate_tour_times

    villers = await _make_base(db_session, test_region)
    trazegnies = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)

    await _distance(db_session, "BASE", villers.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", villers.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", trazegnies.id, 50, 60)

    stops = [{"pdv_id": pdv.id, "sequence_order": 1, "eqp_count": 0.0}]

    _, ret_meme_base, duree_meme_base = await calculate_tour_times(
        "06:00", stops, villers.id, db_session,
    )
    _, ret_autre_base, duree_autre_base = await calculate_tour_times(
        "06:00", stops, villers.id, db_session, trazegnies.id,
    )

    # 30 min d'aller, l'arrêt au quai (valeur par défaut), puis le retour :
    # 30 min sur la base de départ, 60 min sur l'autre. / Outbound + dock + return.
    assert ret_meme_base == "07:15"
    assert ret_autre_base == "07:45"
    assert duree_autre_base - duree_meme_base == 30


@pytest.mark.asyncio
async def test_sans_base_retour_rien_ne_change(db_session, test_region):
    """La régression à éviter : les tournées existantes ne bougent pas d'une minute."""
    from app.api.tours import calculate_tour_times

    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", base.id, 20, 30)

    stops = [{"pdv_id": pdv.id, "sequence_order": 1, "eqp_count": 0.0}]

    sans, ret_sans, duree_sans = await calculate_tour_times(
        "06:00", stops, base.id, db_session,
    )
    explicite, ret_explicite, duree_explicite = await calculate_tour_times(
        "06:00", stops, base.id, db_session, None,
    )

    assert (ret_sans, duree_sans) == (ret_explicite, duree_explicite) == ("07:15", 75)
    assert sans == explicite


def test_dernier_segment_vise_la_base_de_retour():
    """La taxe km se lit par segment : le dernier doit désigner la bonne base."""
    from app.api.tours import _build_segments

    stops = [
        {"pdv_id": 11, "sequence_order": 1, "eqp_count": 1},
        {"pdv_id": 12, "sequence_order": 2, "eqp_count": 1},
    ]

    meme = _build_segments(1, stops)
    assert meme[0] == ("BASE", 1, "PDV", 11)
    assert meme[-1] == ("PDV", 12, "BASE", 1)

    autre = _build_segments(1, stops, 2)
    assert autre[0] == ("BASE", 1, "PDV", 11)   # le départ ne bouge pas
    assert autre[-1] == ("PDV", 12, "BASE", 2)  # seul le retour change
    assert len(autre) == len(meme)


def test_helper_base_de_retour():
    """« Rien de précisé » se lit au même endroit pour tout le monde."""
    from app.models.tour import Tour, return_base_of

    assert return_base_of(Tour(base_id=7, return_base_id=None)) == 7
    assert return_base_of(Tour(base_id=7, return_base_id=9)) == 9


@pytest.mark.asyncio
async def test_planifier_avec_base_retour(client, db_session, test_region):
    """À l'ordonnancement, la base de retour est retenue et le km la reflète."""
    villers = await _make_base(db_session, test_region)
    trazegnies = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)

    await _distance(db_session, "BASE", villers.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", villers.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", trazegnies.id, 50, 60)

    tour_id = await _tour_avec_un_stop(db_session, villers, pdv)
    tracteur = await _tracteur(db_session)

    resp = await client.put(f"/api/tours/{tour_id}/schedule", json={
        "tractor_id": tracteur.id, "departure_time": "06:00",
        "driver_name": "Test", "return_base_id": trazegnies.id,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["return_base_id"] == trazegnies.id
    # 06:00 + 30 aller + quai + déchargement + 60 de retour vers l'autre base
    assert body["return_time"] == "07:47"
    assert float(body["total_km"]) == 70.0   # 20 aller + 50 retour


@pytest.mark.asyncio
async def test_base_retour_egale_depart_est_effacee(client, db_session, test_region):
    """Choisir la base de départ comme base de retour revient à ne rien choisir :
    on l'enregistre NULL pour qu'il n'existe qu'une écriture du cas normal."""
    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", base.id, 20, 30)

    tour_id = await _tour_avec_un_stop(db_session, base, pdv)
    tracteur = await _tracteur(db_session)

    resp = await client.put(f"/api/tours/{tour_id}/schedule", json={
        "tractor_id": tracteur.id, "departure_time": "06:00",
        "driver_name": "Test", "return_base_id": base.id,
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["return_base_id"] is None


@pytest.mark.asyncio
async def test_base_retour_inconnue_refusee(client, db_session, test_region):
    """Un identifiant de base qui n'existe pas doit être refusé, pas ignoré."""
    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", base.id, 20, 30)

    tour_id = await _tour_avec_un_stop(db_session, base, pdv)
    tracteur = await _tracteur(db_session)

    resp = await client.put(f"/api/tours/{tour_id}/schedule", json={
        "tractor_id": tracteur.id, "departure_time": "06:00",
        "driver_name": "Test", "return_base_id": 999999,
    })
    assert resp.status_code == 422, resp.text
