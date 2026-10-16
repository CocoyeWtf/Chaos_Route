"""Affectation des chauffeurs en lot, pour la feuille de travail (#89).

Gaetan : « le RCAM affecte les chauffeurs de la bulle bleue a un tour en les
glissant-deposant dans la colonne Chauffeurs. Apres chaque affectation, la
feuille calcule le nombre de tours, le temps effectue et restant, ainsi que les
kilometres parcourus. Une pre-validation controle les eventuelles erreurs avant
d'appliquer les changements a l'ecran principal. »

D'ou un endpoint a deux modes : `dry_run` controle et annonce, l'appel ferme
applique. Les controles portent sur ce qu'une feuille de calcul ne peut pas
voir — le chevauchement horaire reel et le regime de travail du jour.

Rien n'est bloque : on annonce, le RCAM tranche. Bloquer depuis une vue de
planification reviendrait a lui demander de sortir de l'ecran pour contourner
l'outil cense l'aider.
"""

import uuid

import pytest
import pytest_asyncio

DATE = "2026-11-24"       # un mardi
SAMEDI = "2026-11-28"


@pytest_asyncio.fixture
async def decor(db_session, test_region):
    from app.models.base_driver import BaseDriver, DriverStatus
    from app.models.base_logistics import BaseLogistics

    sfx = uuid.uuid4().hex[:5].upper()
    base = BaseLogistics(code=f"B{sfx}", name="Base", region_id=test_region.id)
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)

    # Un chauffeur a semaine complete, un autre qui ne travaille pas le mardi.
    plein = BaseDriver(last_name="PLEIN", first_name=f"P{sfx}",
                       code_infolog=f"CP{sfx}", base_id=base.id,
                       status=DriverStatus.ACTIVE)
    quatre_cinq = BaseDriver(last_name="QUATRE", first_name=f"Q{sfx}",
                             code_infolog=f"CQ{sfx}", base_id=base.id,
                             status=DriverStatus.ACTIVE,
                             work_days="LUN,MER,JEU,VEN")
    db_session.add_all([plein, quatre_cinq])
    await db_session.commit()
    for d in (plein, quatre_cinq):
        await db_session.refresh(d)
    return {"base": base, "plein": plein, "quatre_cinq": quatre_cinq}


async def _tour(db_session, base, depart, retour, date=DATE, km=100, minutes=240):
    from app.models.tour import Tour, TourStatus

    t = Tour(code=f"T{uuid.uuid4().hex[:6].upper()}", date=date, delivery_date=date,
             base_id=base.id, status=TourStatus.DRAFT,
             departure_time=depart, return_time=retour,
             total_km=km, total_duration_minutes=minutes)
    db_session.add(t)
    await db_session.commit()
    await db_session.refresh(t)
    return t


def _nom(d):
    return f"{d.last_name} {d.first_name}"


@pytest.mark.asyncio
async def test_la_simulation_n_affecte_rien(client, db_session, decor):
    """« Une pre-validation controle les eventuelles erreurs AVANT d'appliquer
    les changements a l'ecran principal. »"""
    t = await _tour(db_session, decor["base"], "06:00", "12:00")

    resp = await client.post("/api/tours/assign-drivers", json={
        "assignments": [{"tour_id": t.id, "driver_name": _nom(decor["plein"])}],
        "dry_run": True,
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["dry_run"] is True

    await db_session.refresh(t)
    assert t.driver_name is None


@pytest.mark.asyncio
async def test_l_affectation_est_appliquee(client, db_session, decor):
    t = await _tour(db_session, decor["base"], "06:00", "12:00")
    nom = _nom(decor["plein"])

    resp = await client.post("/api/tours/assign-drivers", json={
        "assignments": [{
            "tour_id": t.id, "driver_name": nom,
            "driver_code_infolog": decor["plein"].code_infolog,
        }],
        "dry_run": False,
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["modifies"] == 1

    await db_session.refresh(t)
    assert t.driver_name == nom
    assert t.driver_code_infolog == decor["plein"].code_infolog


@pytest.mark.asyncio
async def test_un_chevauchement_est_signale(client, db_session, decor):
    """Le meme chauffeur sur deux tournees qui se recouvrent : c'est
    exactement ce qu'une feuille de calcul ne voit pas."""
    a = await _tour(db_session, decor["base"], "06:00", "12:00")
    b = await _tour(db_session, decor["base"], "10:00", "16:00")
    nom = _nom(decor["plein"])

    resp = await client.post("/api/tours/assign-drivers", json={
        "assignments": [
            {"tour_id": a.id, "driver_name": nom},
            {"tour_id": b.id, "driver_name": nom},
        ],
        "dry_run": True,
    })
    assert resp.status_code == 200, resp.text
    alertes = [x for x in resp.json()["alertes"] if x["type"] == "CHEVAUCHEMENT"]
    assert alertes, "le chevauchement doit etre signale"
    assert set(alertes[0]["tour_codes"]) == {a.code, b.code}


@pytest.mark.asyncio
async def test_deux_tournees_qui_se_suivent_ne_sont_pas_signalees(
    client, db_session, decor,
):
    """Sinon l'alerte sortirait sur tout enchainement normal et on cesserait
    de la lire."""
    a = await _tour(db_session, decor["base"], "06:00", "12:00")
    b = await _tour(db_session, decor["base"], "13:00", "18:00")
    nom = _nom(decor["plein"])

    resp = await client.post("/api/tours/assign-drivers", json={
        "assignments": [
            {"tour_id": a.id, "driver_name": nom},
            {"tour_id": b.id, "driver_name": nom},
        ],
        "dry_run": True,
    })
    assert [x for x in resp.json()["alertes"] if x["type"] == "CHEVAUCHEMENT"] == []


@pytest.mark.asyncio
async def test_un_chauffeur_en_repos_est_signale_sans_etre_bloque(
    client, db_session, decor,
):
    """Regime 4/5 (#33) : on signale, on n'interdit pas — un remplacement doit
    rester possible, et c'est precisement ce qu'on decide a la main ici."""
    t = await _tour(db_session, decor["base"], "06:00", "12:00", date=DATE)
    nom = _nom(decor["quatre_cinq"])   # ne travaille pas le mardi

    resp = await client.post("/api/tours/assign-drivers", json={
        "assignments": [{"tour_id": t.id, "driver_name": nom}],
        "dry_run": False,
    })
    assert resp.status_code == 200, resp.text
    assert [x for x in resp.json()["alertes"] if x["type"] == "REPOS"], "doit etre signale"
    assert resp.json()["modifies"] == 1, "mais pas bloque"

    await db_session.refresh(t)
    assert t.driver_name == nom


@pytest.mark.asyncio
async def test_le_recapitulatif_cumule_tours_temps_et_km(client, db_session, decor):
    """« La feuille calcule le nombre de tours, le temps effectue et restant,
    ainsi que les kilometres parcourus. »"""
    a = await _tour(db_session, decor["base"], "06:00", "10:00", km=120, minutes=240)
    b = await _tour(db_session, decor["base"], "13:00", "16:00", km=80, minutes=180)
    nom = _nom(decor["plein"])

    resp = await client.post("/api/tours/assign-drivers", json={
        "assignments": [
            {"tour_id": a.id, "driver_name": nom},
            {"tour_id": b.id, "driver_name": nom},
        ],
        "dry_run": True,
    })
    recap = resp.json()["recap"][nom]
    assert recap["tours"] == 2
    assert recap["minutes"] == 420
    assert recap["km"] == 200.0


@pytest.mark.asyncio
async def test_le_recapitulatif_compte_les_tournees_deja_affectees(
    client, db_session, decor,
):
    """Un chauffeur deja pose sur une tournee de la journee par un autre
    chemin doit apparaitre dans le total : sinon la feuille annoncerait du
    temps disponible qui n'existe pas."""
    nom = _nom(decor["plein"])
    deja = await _tour(db_session, decor["base"], "06:00", "10:00", km=120, minutes=240)
    deja.driver_name = nom
    await db_session.commit()

    nouvelle = await _tour(db_session, decor["base"], "13:00", "16:00", km=80, minutes=180)
    resp = await client.post("/api/tours/assign-drivers", json={
        "assignments": [{"tour_id": nouvelle.id, "driver_name": nom}],
        "dry_run": True,
    })
    assert resp.json()["recap"][nom]["tours"] == 2


@pytest.mark.asyncio
async def test_retirer_un_chauffeur(client, db_session, decor):
    """Glisser un chauffeur hors de la colonne doit pouvoir le retirer."""
    t = await _tour(db_session, decor["base"], "06:00", "12:00")
    t.driver_name = _nom(decor["plein"])
    await db_session.commit()

    resp = await client.post("/api/tours/assign-drivers", json={
        "assignments": [{"tour_id": t.id, "driver_name": None}],
        "dry_run": False,
    })
    assert resp.status_code == 200, resp.text

    await db_session.refresh(t)
    assert t.driver_name is None


@pytest.mark.asyncio
async def test_une_tournee_introuvable_est_nommee(client, db_session, decor):
    """Plutot qu'ignoree en silence sur une action en lot."""
    t = await _tour(db_session, decor["base"], "06:00", "12:00")
    resp = await client.post("/api/tours/assign-drivers", json={
        "assignments": [
            {"tour_id": t.id, "driver_name": _nom(decor["plein"])},
            {"tour_id": 999999, "driver_name": _nom(decor["plein"])},
        ],
        "dry_run": True,
    })
    assert resp.json()["introuvables"] == [999999]
