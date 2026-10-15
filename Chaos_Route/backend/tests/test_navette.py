"""Navette inter-bases belges (#43).

Samuel : « il faudrait rajouter un onglet Navette pour les situations ou la
marchandise est envoyee par exemple de Trazegnies vers Villers pour expedition
depuis Villers. Il faudrait ici pouvoir choisir les volumes de Trazegnies a
integrer dans cette navette, et que ces volumes basculent reellement sur les
volumes disponibles a Villers. »

Ses quatre reponses de cadrage, chacune verrouillee par un test :
  1. la navette est attribuee a un contrat transporteur, comme une tournee ;
  2. le volume GARDE sa date de repartition, modifiable a la main ;
  3. la bascule prend effet « une fois arrivee seulement » ;
  4. a l'annulation, les volumes reviennent automatiquement, AVEC notification.
"""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select

DATE = "2026-11-20"


@pytest_asyncio.fixture
async def decor(db_session, test_region):
    """Trazegnies, Villers, un PDV et trois volumes secs au depart de Trazegnies."""
    from app.models.base_logistics import BaseLogistics
    from app.models.contract import Contract
    from app.models.pdv import PDV, PDVType
    from app.models.volume import Volume

    sfx = uuid.uuid4().hex[:5].upper()
    traz = BaseLogistics(code=f"TRA{sfx}", name="Trazegnies", region_id=test_region.id)
    villers = BaseLogistics(code=f"VIL{sfx}", name="Villers", region_id=test_region.id)
    pdv = PDV(code=f"P{sfx}", name=f"PDV {sfx}", type=PDVType.HYPER, address="a",
              city="c", postal_code="0000", latitude=50.5, longitude=4.5,
              region_id=test_region.id)
    contrat = Contract(code=f"C{sfx}", transporter_name="Transporteur", vacation=400,
                       region_id=test_region.id, billing_type=2)
    for o in (traz, villers, pdv, contrat):
        db_session.add(o)
    await db_session.commit()
    for o in (traz, villers, pdv, contrat):
        await db_session.refresh(o)

    volumes = []
    for i, classe in enumerate(("SEC", "SEC", "FRAIS")):
        v = Volume(pdv_id=pdv.id, date=DATE, dispatch_date=DATE, eqp_count=10,
                   temperature_class=classe, base_origin_id=traz.id)
        db_session.add(v)
        volumes.append(v)
    await db_session.commit()
    for v in volumes:
        await db_session.refresh(v)
    return {"traz": traz, "villers": villers, "pdv": pdv, "contrat": contrat,
            "volumes": volumes}


async def _creer(client, decor, **extra):
    charge = {
        "date": DATE,
        "base_id": decor["traz"].id,
        "destination_base_id": decor["villers"].id,
        "volume_ids": [v.id for v in decor["volumes"][:2]],
        "contract_id": decor["contrat"].id,
        "vehicle_type": "SEMI",
    }
    charge.update(extra)
    return await client.post("/api/tours/navette", json=charge)


@pytest.mark.asyncio
async def test_la_navette_porte_un_contrat_transporteur(client, db_session, decor):
    """Reponse 1 : « la navette est effectivement a attribuer a un contrat
    transporteur (propre, preste ou mixte comme une tournee classique) »."""
    from app.models.tour import Tour, TourType

    resp = await _creer(client, decor)
    assert resp.status_code == 201, resp.text
    tour = await db_session.get(Tour, resp.json()["id"])
    assert tour.tour_type == TourType.NAVETTE
    assert tour.contract_id == decor["contrat"].id
    # La navette se TERMINE sur la base d'arrivee : c'est ce que dit `return_base_id`.
    assert tour.return_base_id == decor["villers"].id


@pytest.mark.asyncio
async def test_avant_l_arrivee_les_volumes_restent_a_trazegnies(client, db_session, decor):
    """Reponse 3 : « une fois arrivee seulement ». Construire une navette ne
    doit pas deplacer de la marchandise — une navette qui ne part jamais
    n'aurait rien deplace du tout."""
    from app.models.volume import Volume

    resp = await _creer(client, decor)
    assert resp.status_code == 201, resp.text

    for v in decor["volumes"][:2]:
        ligne = (await db_session.execute(
            select(Volume.base_origin_id, Volume.tour_id).where(Volume.id == v.id)
        )).first()
        assert ligne[0] == decor["traz"].id, "la base ne doit pas encore avoir change"
        assert ligne[1] is not None, "mais le volume n'est plus planifiable a Trazegnies"


@pytest.mark.asyncio
async def test_a_l_arrivee_les_volumes_basculent_sur_villers(client, db_session, decor):
    """Le coeur du ticket : « que ces volumes basculent reellement sur les
    volumes disponibles a Villers pour expedition depuis la-bas, et donc
    supprimes des volumes disponibles a Trazegnies »."""
    from app.models.volume import Volume

    tour_id = (await _creer(client, decor)).json()["id"]

    resp = await client.post(f"/api/tours/{tour_id}/navette/arrive", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["volumes_moved"] == 2
    assert resp.json()["destination_base_id"] == decor["villers"].id

    for v in decor["volumes"][:2]:
        ligne = (await db_session.execute(
            select(Volume.base_origin_id, Volume.tour_id, Volume.dispatch_date)
            .where(Volume.id == v.id)
        )).first()
        assert ligne[0] == decor["villers"].id
        assert ligne[1] is None, "redevenus planifiables, depuis Villers"
        # Reponse 2 : la date de repartition est conservee par defaut.
        assert ligne[2] == DATE


@pytest.mark.asyncio
async def test_la_date_de_repartition_est_modifiable_a_l_arrivee(
    client, db_session, decor,
):
    """Reponse 2 : « par defaut il garde sa date de repartition initiale, mais
    celle-ci doit pouvoir etre modifiee manuellement »."""
    from app.models.volume import Volume

    tour_id = (await _creer(client, decor)).json()["id"]
    await client.post(f"/api/tours/{tour_id}/navette/arrive",
                      json={"new_dispatch_date": "2026-11-25"})

    for v in decor["volumes"][:2]:
        d = (await db_session.execute(
            select(Volume.dispatch_date).where(Volume.id == v.id)
        )).scalar()
        assert d == "2026-11-25"


@pytest.mark.asyncio
async def test_l_arrivee_est_idempotente(client, decor):
    tour_id = (await _creer(client, decor)).json()["id"]
    premier = await client.post(f"/api/tours/{tour_id}/navette/arrive", json={})
    second = await client.post(f"/api/tours/{tour_id}/navette/arrive", json={})
    assert second.json()["status"] == "already_arrived"
    assert second.json()["arrived_at"] == premier.json()["arrived_at"]


@pytest.mark.asyncio
async def test_annuler_avant_l_arrivee_rend_les_volumes(client, db_session, decor):
    """Reponse 4, cas simple : la navette n'est pas partie."""
    from app.models.volume import Volume

    tour_id = (await _creer(client, decor)).json()["id"]
    resp = await client.post(f"/api/tours/{tour_id}/navette/cancel")
    assert resp.status_code == 200, resp.text
    assert resp.json()["volumes_returned"] == 2

    for v in decor["volumes"][:2]:
        ligne = (await db_session.execute(
            select(Volume.base_origin_id, Volume.tour_id).where(Volume.id == v.id)
        )).first()
        assert ligne[0] == decor["traz"].id
        assert ligne[1] is None, "de nouveau planifiables a Trazegnies"


@pytest.mark.asyncio
async def test_annuler_apres_l_arrivee_rapatrie_les_volumes(client, db_session, decor):
    """Reponse 4, cas difficile : les volumes sont deja comptes a Villers."""
    from app.models.volume import Volume

    tour_id = (await _creer(client, decor)).json()["id"]
    await client.post(f"/api/tours/{tour_id}/navette/arrive", json={})

    resp = await client.post(f"/api/tours/{tour_id}/navette/cancel")
    assert resp.status_code == 200, resp.text
    assert resp.json()["volumes_returned"] == 2

    for v in decor["volumes"][:2]:
        base = (await db_session.execute(
            select(Volume.base_origin_id).where(Volume.id == v.id)
        )).scalar()
        assert base == decor["traz"].id, "retour automatique a Trazegnies"


@pytest.mark.asyncio
async def test_l_annulation_laisse_une_notification(client, db_session, decor):
    """« avec une notification pour prevenir de l'action ». Elle compte autant
    que le retour : quelqu'un a peut-etre deja planifie ces volumes a Villers."""
    from app.models.operational_alert import OperationalAlert

    tour_id = (await _creer(client, decor)).json()["id"]
    await client.post(f"/api/tours/{tour_id}/navette/cancel")

    alerte = (await db_session.execute(
        select(OperationalAlert).where(OperationalAlert.tour_id == tour_id)
    )).scalars().first()
    assert alerte is not None, "l'annulation doit prevenir"
    assert "annulee" in (alerte.title or "").lower()
    assert str(len(decor["volumes"][:2])) in (alerte.message or "")


@pytest.mark.asyncio
async def test_l_annulation_signale_les_volumes_deja_replanifies(
    client, db_session, decor,
):
    """Le cas qui fait mal : les volumes sont arrives a Villers, quelqu'un les a
    places dans une tournee, et la navette est annulee. Les ramener en silence
    viderait une tournee sans prevenir personne."""
    from app.models.operational_alert import AlertPriority, OperationalAlert
    from app.models.tour import Tour, TourStatus

    tour_id = (await _creer(client, decor)).json()["id"]
    await client.post(f"/api/tours/{tour_id}/navette/arrive", json={})

    autre = Tour(code=f"T{uuid.uuid4().hex[:5].upper()}", date=DATE, delivery_date=DATE,
                 base_id=decor["villers"].id, status=TourStatus.DRAFT)
    db_session.add(autre)
    await db_session.commit()
    await db_session.refresh(autre)
    decor["volumes"][0].tour_id = autre.id
    await db_session.commit()

    resp = await client.post(f"/api/tours/{tour_id}/navette/cancel")
    assert resp.status_code == 200, resp.text
    assert decor["volumes"][0].id in resp.json()["already_replanned"]

    alerte = (await db_session.execute(
        select(OperationalAlert).where(OperationalAlert.tour_id == tour_id)
    )).scalars().first()
    assert alerte.priority == AlertPriority.HIGH
    assert "ATTENTION" in (alerte.message or "")


@pytest.mark.asyncio
async def test_un_melange_de_temperatures_est_accepte_mais_signale(client, decor):
    """« Un volume Sec transporte dans une tournee frais c'est possible, il faut
    que l'application accepte, mais que ce soit signale. »"""
    resp = await _creer(
        client, decor,
        volume_ids=[v.id for v in decor["volumes"]],   # 2 SEC + 1 FRAIS
        temperature_type="FRAIS",
    )
    assert resp.status_code == 201, "accepte"
    assert resp.json()["warnings"], "mais signale"
    assert "SEC" in resp.json()["warnings"][0]


@pytest.mark.asyncio
async def test_une_navette_vers_sa_propre_base_est_refusee(client, decor):
    resp = await _creer(client, decor, destination_base_id=decor["traz"].id)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_un_volume_d_une_autre_base_est_refuse(client, db_session, decor):
    """Une navette part d'une seule base, comme une tournee (#84)."""
    from app.models.volume import Volume

    etranger = Volume(pdv_id=decor["pdv"].id, date=DATE, dispatch_date=DATE,
                      eqp_count=5, temperature_class="SEC",
                      base_origin_id=decor["villers"].id)
    db_session.add(etranger)
    await db_session.commit()
    await db_session.refresh(etranger)

    resp = await _creer(client, decor, volume_ids=[decor["volumes"][0].id, etranger.id])
    assert resp.status_code == 422
    assert "une seule base" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_un_volume_deja_pris_est_refuse(client, db_session, decor):
    """Sinon la navette emporterait de la marchandise deja promise ailleurs."""
    from app.models.tour import Tour, TourStatus

    autre = Tour(code=f"T{uuid.uuid4().hex[:5].upper()}", date=DATE, delivery_date=DATE,
                 base_id=decor["traz"].id, status=TourStatus.DRAFT)
    db_session.add(autre)
    await db_session.commit()
    await db_session.refresh(autre)
    decor["volumes"][0].tour_id = autre.id
    await db_session.commit()

    resp = await _creer(client, decor)
    assert resp.status_code == 422
    assert "deja affectes" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_arriver_sur_une_tournee_ordinaire_est_refuse(client, db_session, decor):
    from app.models.tour import Tour, TourStatus

    t = Tour(code=f"T{uuid.uuid4().hex[:5].upper()}", date=DATE, delivery_date=DATE,
             base_id=decor["traz"].id, status=TourStatus.DRAFT)
    db_session.add(t)
    await db_session.commit()
    await db_session.refresh(t)

    resp = await client.post(f"/api/tours/{t.id}/navette/arrive", json={})
    assert resp.status_code == 422
