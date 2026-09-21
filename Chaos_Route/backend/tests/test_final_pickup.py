"""Ticket #74 : terminer une tournée de livraison par un enlèvement fournisseur.

Certaines tournées livrent leurs PDV puis poussent chez un fournisseur (Avion,
Saint-Feuillien, Bister) avant de rentrer. Ce n'est pas un enlèvement dédié —
celui-là part à vide de la base — et ce n'est pas un arrêt de livraison : aucun
volume, aucun EQC. Découper en « un tour + un mouvement » fausserait à la fois
les kilomètres et la facturation.

L'enlèvement se place donc toujours entre le dernier PDV et le retour base, et
trois choses doivent le suivre : l'heure de retour, le kilométrage, et le
découpage en segments dont dépend la taxe km.
"""

import uuid

import pytest

DATE = "2026-07-02"


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
    pdv = PDV(code=code, name=f"PDV {code}", type=PDVType.HYPER, region_id=region.id)
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)
    return pdv


async def _make_supplier(db_session, region, name="Avion"):
    from app.models.supplier import Supplier
    sup = Supplier(code=f"S{uuid.uuid4().hex[:5].upper()}", name=name, region_id=region.id)
    db_session.add(sup)
    await db_session.commit()
    await db_session.refresh(sup)
    return sup


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
async def test_enlevement_de_fin_allonge_le_retour(db_session, test_region):
    """Le retour passe par le fournisseur : deux trajets et un temps sur place."""
    from app.api.tours import calculate_tour_times

    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    avion = await _make_supplier(db_session, test_region)

    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", base.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "SUPPLIER", avion.id, 15, 20)
    await _distance(db_session, "SUPPLIER", avion.id, "BASE", base.id, 25, 35)

    stops = [{"pdv_id": pdv.id, "sequence_order": 1, "eqp_count": 0.0}]

    _, ret_sans, duree_sans = await calculate_tour_times(
        "06:00", stops, base.id, db_session,
    )
    _, ret_avec, duree_avec = await calculate_tour_times(
        "06:00", stops, base.id, db_session, None, avion.id, 45,
    )

    # Sans enlèvement : 30 de retour. Avec : 20 + 45 sur place + 35 = 100.
    assert duree_avec - duree_sans == 70
    assert ret_sans != ret_avec


@pytest.mark.asyncio
async def test_temps_sur_place_par_defaut(db_session, test_region):
    """Sans durée précisée, on retient le temps de quai par défaut plutôt que zéro :
    un chargement chez un fournisseur n'est jamais instantané."""
    from app.api.tours import calculate_tour_times

    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    avion = await _make_supplier(db_session, test_region)

    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "SUPPLIER", avion.id, 15, 20)
    await _distance(db_session, "SUPPLIER", avion.id, "BASE", base.id, 25, 35)

    stops = [{"pdv_id": pdv.id, "sequence_order": 1, "eqp_count": 0.0}]

    _, _, duree_defaut = await calculate_tour_times(
        "06:00", stops, base.id, db_session, None, avion.id, None,
    )
    _, _, duree_explicite = await calculate_tour_times(
        "06:00", stops, base.id, db_session, None, avion.id, 90,
    )

    assert duree_explicite - duree_defaut == 90 - 15  # quai par défaut = 15 min


@pytest.mark.asyncio
async def test_sans_enlevement_rien_ne_change(db_session, test_region):
    """La régression à éviter : les tournées sans enlèvement gardent leur calcul."""
    from app.api.tours import calculate_tour_times

    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", base.id, 20, 30)

    stops = [{"pdv_id": pdv.id, "sequence_order": 1, "eqp_count": 0.0}]

    a = await calculate_tour_times("06:00", stops, base.id, db_session)
    b = await calculate_tour_times("06:00", stops, base.id, db_session, None, None, None)
    assert a == b


def test_segments_passent_par_le_fournisseur():
    """La taxe km se lit par segment : le retour en fait désormais deux."""
    from app.api.tours import _build_segments

    stops = [{"pdv_id": 11, "sequence_order": 1, "eqp_count": 1}]

    sans = _build_segments(1, stops)
    assert sans == [("BASE", 1, "PDV", 11), ("PDV", 11, "BASE", 1)]

    avec = _build_segments(1, stops, None, 5)
    assert avec == [
        ("BASE", 1, "PDV", 11),
        ("PDV", 11, "SUPPLIER", 5),
        ("SUPPLIER", 5, "BASE", 1),
    ]


def test_enlevement_et_base_de_retour_se_combinent():
    """Les deux demandes (#64 et #74) doivent tenir ensemble : le camion charge
    chez le fournisseur puis rentre sur l'autre base."""
    from app.api.tours import _build_segments

    stops = [{"pdv_id": 11, "sequence_order": 1, "eqp_count": 1}]
    segs = _build_segments(1, stops, 2, 5)
    assert segs[-2] == ("PDV", 11, "SUPPLIER", 5)
    assert segs[-1] == ("SUPPLIER", 5, "BASE", 2)


@pytest.mark.asyncio
async def test_planifier_avec_enlevement_de_fin(client, db_session, test_region):
    """À l'ordonnancement, l'enlèvement est retenu et le kilométrage le reflète."""
    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    avion = await _make_supplier(db_session, test_region)

    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", base.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "SUPPLIER", avion.id, 15, 20)
    await _distance(db_session, "SUPPLIER", avion.id, "BASE", base.id, 25, 35)

    tour_id = await _tour_avec_un_stop(db_session, base, pdv)
    tracteur = await _tracteur(db_session)

    resp = await client.put(f"/api/tours/{tour_id}/schedule", json={
        "tractor_id": tracteur.id, "departure_time": "06:00", "driver_name": "Test",
        "final_pickup_supplier_id": avion.id, "final_pickup_duration_minutes": 45,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["final_pickup_supplier_id"] == avion.id
    assert body["final_pickup_duration_minutes"] == 45
    assert float(body["total_km"]) == 60.0   # 20 aller + 15 détour + 25 retour


@pytest.mark.asyncio
async def test_enlevement_seul_refuse(client, db_session, test_region):
    """Sans arrêt de livraison, ce n'est pas un enlèvement de FIN de tournée :
    c'est un enlèvement dédié, qui a déjà sa propre nature."""
    from app.models.tour import Tour

    base = await _make_base(db_session, test_region)
    avion = await _make_supplier(db_session, test_region)
    tour = Tour(date=DATE, code=f"T-{uuid.uuid4().hex[:8]}", base_id=base.id, total_eqp=0)
    db_session.add(tour)
    await db_session.commit()
    await db_session.refresh(tour)
    tour_id = tour.id
    tracteur = await _tracteur(db_session)

    resp = await client.put(f"/api/tours/{tour_id}/schedule", json={
        "tractor_id": tracteur.id, "departure_time": "06:00", "driver_name": "Test",
        "final_pickup_supplier_id": avion.id,
    })
    assert resp.status_code == 422, resp.text
    assert "Enlèvement dédié" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_fournisseur_inconnu_refuse(client, db_session, test_region):
    """Un fournisseur qui n'existe pas doit être refusé, pas ignoré."""
    base = await _make_base(db_session, test_region)
    pdv = await _make_pdv(db_session, test_region)
    await _distance(db_session, "BASE", base.id, "PDV", pdv.id, 20, 30)
    await _distance(db_session, "PDV", pdv.id, "BASE", base.id, 20, 30)

    tour_id = await _tour_avec_un_stop(db_session, base, pdv)
    tracteur = await _tracteur(db_session)

    resp = await client.put(f"/api/tours/{tour_id}/schedule", json={
        "tractor_id": tracteur.id, "departure_time": "06:00", "driver_name": "Test",
        "final_pickup_supplier_id": 999999,
    })
    assert resp.status_code == 422, resp.text
