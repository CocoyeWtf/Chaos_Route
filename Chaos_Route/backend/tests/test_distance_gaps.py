"""Trous du distancier (#96) : les combler au lieu de compter 0 km.

Gaetan : « depart de Gosselies = 132 km pour 03h10 (OK), a Trazegnies = 0 km
pour 46 min ». Ce n'etait pas une lecture fautive mais un trou de donnees : le
distancier ne couvrait que Villers (164 PDV) et Gosselies SEC (158). Trazegnies,
Gosselies MEA et Heppignies n'avaient AUCUNE ligne.

Le vrai danger n'est pas l'affichage : une paire absente vaut `None`, donc 0 km
et 0 minute dans le calcul de cout. Toute tournee partant de ces bases sortait
sans carburant ni taxe kilometrique. Meme famille que #58 et #59.
"""

import uuid

import pytest
import pytest_asyncio


@pytest_asyncio.fixture
async def deux_bases_au_meme_endroit(db_session, test_region):
    """Gosselies SEC et Gosselies MEA partagent les memes coordonnees en prod."""
    from app.models.base_logistics import BaseLogistics

    suffixe = uuid.uuid4().hex[:4].upper()
    sec = BaseLogistics(code=f"S{suffixe}", name="Gosselies SEC test",
                        region_id=test_region.id, latitude=50.4651, longitude=4.4379)
    mea = BaseLogistics(code=f"M{suffixe}", name="Gosselies MEA test",
                        region_id=test_region.id, latitude=50.4651, longitude=4.4379)
    loin = BaseLogistics(code=f"T{suffixe}", name="Trazegnies test",
                         region_id=test_region.id, latitude=50.4582, longitude=4.3376)
    for b in (sec, mea, loin):
        db_session.add(b)
    await db_session.commit()
    for b in (sec, mea, loin):
        await db_session.refresh(b)
    return sec, mea, loin


@pytest_asyncio.fixture
async def un_pdv(db_session, test_region):
    from app.models.pdv import PDV, PDVType

    code = f"P{uuid.uuid4().hex[:5].upper()}"
    p = PDV(code=code, name=f"PDV {code}", type=PDVType.HYPER, address="a", city="c",
            postal_code="0000", latitude=50.52, longitude=5.24, region_id=test_region.id)
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    return p


@pytest.mark.asyncio
async def test_la_couverture_signale_les_bases_sans_distancier(
    client, db_session, deux_bases_au_meme_endroit, un_pdv,
):
    """Sans cet ecran, un trou ne se voit qu'une fois la tournee sortie a 0 km."""
    sec, _mea, _loin = deux_bases_au_meme_endroit

    resp = await client.get("/api/distance-matrix/coverage")
    assert resp.status_code == 200, resp.text
    lignes = {r["base_id"]: r for r in resp.json()}

    assert sec.id in lignes
    assert lignes[sec.id]["pdv_missing"] >= 1
    assert lignes[sec.id]["has_coordinates"] is True


@pytest.mark.asyncio
async def test_la_simulation_n_ecrit_rien(client, db_session, deux_bases_au_meme_endroit, un_pdv):
    """L'action porte sur du referentiel : on annonce avant d'ecrire."""
    from sqlalchemy import func, select
    from app.models.distance_matrix import DistanceMatrix

    sec, _, _ = deux_bases_au_meme_endroit
    avant = (await db_session.execute(select(func.count(DistanceMatrix.id)))).scalar()

    resp = await client.post("/api/distance-matrix/fill-missing",
                             params={"base_id": sec.id, "dry_run": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["dry_run"] is True
    assert resp.json()["estimees"] >= 1

    apres = (await db_session.execute(select(func.count(DistanceMatrix.id)))).scalar()
    assert apres == avant


@pytest.mark.asyncio
async def test_une_base_jumelle_est_recopiee_et_non_estimee(
    client, db_session, deux_bases_au_meme_endroit, un_pdv,
):
    """Gosselies MEA est au MEME endroit que Gosselies SEC : sa distance n'est
    pas a estimer, c'est le meme trajet. Une estimation la-dessus serait une
    degradation gratuite d'une donnee qu'on possede deja."""
    from sqlalchemy import select
    from app.models.distance_matrix import DistanceMatrix

    sec, mea, _ = deux_bases_au_meme_endroit
    db_session.add(DistanceMatrix(
        origin_type="BASE", origin_id=sec.id,
        destination_type="PDV", destination_id=un_pdv.id,
        distance_km=66, duration_minutes=56, is_estimated=False,
    ))
    await db_session.commit()

    resp = await client.post("/api/distance-matrix/fill-missing",
                             params={"base_id": mea.id, "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["copiees_depuis_base_jumelle"] >= 1

    ligne = (await db_session.execute(
        select(DistanceMatrix).where(
            DistanceMatrix.origin_type == "BASE", DistanceMatrix.origin_id == mea.id,
            DistanceMatrix.destination_type == "PDV", DistanceMatrix.destination_id == un_pdv.id,
        )
    )).scalar_one()
    assert float(ligne.distance_km) == 66.0
    assert ligne.duration_minutes == 56
    assert ligne.is_estimated is False, "une copie exacte n'est pas une estimation"


@pytest.mark.asyncio
async def test_une_base_isolee_est_estimee_et_marquee(
    client, db_session, deux_bases_au_meme_endroit, un_pdv,
):
    """Trazegnies n'a pas de jumelle : estimation routiere, marquee comme telle
    pour etre remplacee sans hesiter quand la vraie valeur arrivera."""
    from sqlalchemy import select
    from app.models.distance_matrix import DistanceMatrix

    _, _, loin = deux_bases_au_meme_endroit
    resp = await client.post("/api/distance-matrix/fill-missing",
                             params={"base_id": loin.id, "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["estimees"] >= 1

    ligne = (await db_session.execute(
        select(DistanceMatrix).where(
            DistanceMatrix.origin_type == "BASE", DistanceMatrix.origin_id == loin.id,
            DistanceMatrix.destination_type == "PDV", DistanceMatrix.destination_id == un_pdv.id,
        )
    )).scalar_one()
    assert ligne.is_estimated is True
    assert float(ligne.distance_km) > 0, "le point du ticket : ne plus valoir 0 km"
    assert ligne.duration_minutes > 0


@pytest.mark.asyncio
async def test_une_distance_mesuree_n_est_jamais_ecrasee(
    client, db_session, deux_bases_au_meme_endroit, un_pdv,
):
    """Le pire resultat possible serait de remplacer une vraie valeur par une
    estimation. On ne touche que les paires absentes."""
    from sqlalchemy import select
    from app.models.distance_matrix import DistanceMatrix

    _, _, loin = deux_bases_au_meme_endroit
    db_session.add(DistanceMatrix(
        origin_type="BASE", origin_id=loin.id,
        destination_type="PDV", destination_id=un_pdv.id,
        distance_km=42.5, duration_minutes=37, is_estimated=False,
    ))
    await db_session.commit()

    await client.post("/api/distance-matrix/fill-missing",
                      params={"base_id": loin.id, "dry_run": False})

    lignes = (await db_session.execute(
        select(DistanceMatrix).where(
            DistanceMatrix.origin_type == "BASE", DistanceMatrix.origin_id == loin.id,
            DistanceMatrix.destination_type == "PDV", DistanceMatrix.destination_id == un_pdv.id,
        )
    )).scalars().all()
    assert len(lignes) == 1, "aucun doublon ne doit etre cree"
    assert float(lignes[0].distance_km) == 42.5
    assert lignes[0].is_estimated is False


@pytest.mark.asyncio
async def test_reimporter_une_distance_ne_cree_pas_de_doublon(
    client, db_session, deux_bases_au_meme_endroit, un_pdv,
):
    """Faille trouvee en traitant le #96, anterieure a lui : la table n'a aucune
    contrainte d'unicite et l'import inserait a l'aveugle. Deux imports du meme
    fichier suffisaient a faire LEVER la lecture bidirectionnelle du distancier
    (`scalar_one_or_none`), donc a casser tout calcul de tournee sur la paire.
    """
    from sqlalchemy import func, select
    from app.models.distance_matrix import DistanceMatrix

    sec, _, _ = deux_bases_au_meme_endroit
    charge = {
        "origin_type": "BASE", "origin_id": sec.id,
        "destination_type": "PDV", "destination_id": un_pdv.id,
        "distance_km": 66, "duration_minutes": 56,
    }
    assert (await client.post("/api/distance-matrix/", json=charge)).status_code == 201
    charge2 = dict(charge, distance_km=70, duration_minutes=60)
    assert (await client.post("/api/distance-matrix/", json=charge2)).status_code == 201

    lignes = (await db_session.execute(
        select(DistanceMatrix).where(
            DistanceMatrix.origin_id == sec.id,
            DistanceMatrix.destination_id == un_pdv.id,
            DistanceMatrix.origin_type == "BASE",
        )
    )).scalars().all()
    assert len(lignes) == 1, "le second envoi doit mettre a jour, pas empiler"
    assert float(lignes[0].distance_km) == 70.0


@pytest.mark.asyncio
async def test_une_vraie_distance_remplace_l_estimation(
    client, db_session, deux_bases_au_meme_endroit, un_pdv,
):
    """Le scenario qui compte : on comble les trous aujourd'hui a l'estime, et
    l'import du vrai distancier de Trazegnies doit gagner demain sans qu'il
    faille aller supprimer les estimations a la main."""
    from sqlalchemy import select
    from app.models.distance_matrix import DistanceMatrix

    _, _, loin = deux_bases_au_meme_endroit
    await client.post("/api/distance-matrix/fill-missing",
                      params={"base_id": loin.id, "dry_run": False})

    estimee = (await db_session.execute(
        select(DistanceMatrix).where(
            DistanceMatrix.origin_id == loin.id,
            DistanceMatrix.destination_id == un_pdv.id,
            DistanceMatrix.origin_type == "BASE",
        )
    )).scalar_one()
    assert estimee.is_estimated is True

    # Import du vrai distancier, dans l'autre sens pour faire bonne mesure.
    resp = await client.post("/api/distance-matrix/bulk", json=[{
        "origin_type": "PDV", "origin_id": un_pdv.id,
        "destination_type": "BASE", "destination_id": loin.id,
        "distance_km": 31.5, "duration_minutes": 29,
    }])
    assert resp.status_code == 201, resp.text

    # On relit les COLONNES, pas l'objet : la session de test garde une copie
    # chargee avant l'appel HTTP, et la rafraichir declencherait une IO hors
    # greenlet. / Read columns, not the stale ORM object.
    lignes = (await db_session.execute(
        select(DistanceMatrix.distance_km, DistanceMatrix.is_estimated).where(
            ((DistanceMatrix.origin_id == loin.id) & (DistanceMatrix.origin_type == "BASE")
             & (DistanceMatrix.destination_id == un_pdv.id))
            | ((DistanceMatrix.destination_id == loin.id) & (DistanceMatrix.destination_type == "BASE")
               & (DistanceMatrix.origin_id == un_pdv.id))
        )
    )).all()
    assert len(lignes) == 1, "le distancier est symetrique : une seule ligne par paire"
    assert float(lignes[0][0]) == 31.5
    assert bool(lignes[0][1]) is False
