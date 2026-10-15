"""Rappels periodiques a la connexion (#17 archive, #26 prix carburant).

Samuel a arbitre de garder ces deux taches manuelles, a condition que
l'application les reclame « a chaque connexion tant que [la tache] n'a pas ete
faite ». Deux regimes voulus differents :

  - le prix du carburant se CONSTATE en base : le rappel disparait tout seul des
    qu'un prix couvre la semaine, et il n'offre pas de bouton « c'est fait » —
    une case a cocher permettrait de faire taire l'alerte sans faire la tache,
    sur un chiffre qui entre dans la facturation ;
  - l'archive ne se constate pas : l'application ne peut pas savoir qu'un
    fichier a ete range quelque part. Elle demande donc une confirmation.
"""

import uuid
from datetime import date, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.orm import selectinload


async def _user_with(db_session, permissions: list[tuple[str, str]]):
    from app.models.user import Permission, Role, User

    sfx = uuid.uuid4().hex[:8]
    role = Role(name=f"role_{sfx}", description="role de test")
    role.permissions = [Permission(resource=r, action=a) for r, a in permissions]
    u = User(username=f"u_{sfx}", email=f"u-{sfx}@chaos.test", hashed_password="x",
             is_active=True, is_superadmin=False)
    u.roles = [role]
    db_session.add(role)
    db_session.add(u)
    await db_session.commit()
    return (await db_session.execute(
        select(User).where(User.id == u.id).options(selectinload(User.roles))
    )).scalar_one()


@pytest_asyncio.fixture
async def as_user():
    from app.api.deps import get_current_user
    from app.main import app

    def _switch(user):
        app.dependency_overrides[get_current_user] = lambda: user

    yield _switch
    app.dependency_overrides.pop(get_current_user, None)


@pytest_asyncio.fixture(autouse=True)
async def _table_propre(db_session):
    """Les accuses sont partages par toute la societe : on repart a blanc."""
    from app.models.reminder_ack import ReminderAck

    for a in (await db_session.execute(select(ReminderAck))).scalars().all():
        await db_session.delete(a)
    await db_session.commit()
    yield


@pytest.mark.asyncio
async def test_un_profil_sans_les_droits_n_est_pas_sollicite(client, db_session, as_user):
    """Le rappel s'adresse aux profils concernes, pas a tout le monde : un
    magasin n'a rien a faire d'une archive trimestrielle."""
    as_user(await _user_with(db_session, [("pickup-requests", "read")]))

    resp = await client.get("/api/reminders/")
    assert resp.status_code == 200, resp.text
    assert resp.json() == []


@pytest.mark.asyncio
async def test_l_archive_trimestrielle_est_reclamee(client, db_session, as_user):
    as_user(await _user_with(db_session, [("tour-history", "read")]))

    rappels = (await client.get("/api/reminders/")).json()
    cles = {r["key"] for r in rappels}
    assert "HISTORY_ARCHIVE" in cles

    archive = next(r for r in rappels if r["key"] == "HISTORY_ARCHIVE")
    assert archive["acknowledgeable"] is True, (
        "l'application ne peut pas constater qu'un fichier a ete range : "
        "elle doit demander confirmation"
    )
    assert archive["period_key"].startswith(str(datetime.now().year))


@pytest.mark.asyncio
async def test_confirmer_l_archive_fait_taire_le_rappel(client, db_session, as_user):
    as_user(await _user_with(db_session, [("tour-history", "read")]))

    resp = await client.post("/api/reminders/HISTORY_ARCHIVE/ack", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["already"] is False

    rappels = (await client.get("/api/reminders/")).json()
    assert "HISTORY_ARCHIVE" not in {r["key"] for r in rappels}


@pytest.mark.asyncio
async def test_l_accuse_vaut_pour_toute_la_societe(client, db_session, as_user):
    """L'archive trimestrielle se fait une fois, pas une fois par personne :
    sinon chaque R-Cam verrait le rappel apres que son collegue l'a traitee."""
    as_user(await _user_with(db_session, [("tour-history", "read")]))
    await client.post("/api/reminders/HISTORY_ARCHIVE/ack", json={})

    as_user(await _user_with(db_session, [("tour-history", "read")]))
    rappels = (await client.get("/api/reminders/")).json()
    assert "HISTORY_ARCHIVE" not in {r["key"] for r in rappels}


@pytest.mark.asyncio
async def test_l_accuse_est_borne_a_sa_periode(client, db_session, as_user):
    """Le rappel doit revenir au trimestre suivant : un accuse pose en Q4 ne
    doit pas eteindre le rappel de Q1."""
    from app.api.reminders import _periode_trimestre

    assert _periode_trimestre(datetime(2026, 10, 15)) == "2026-Q4"
    assert _periode_trimestre(datetime(2027, 1, 2)) == "2027-Q1"
    assert _periode_trimestre(datetime(2026, 3, 31)) == "2026-Q1"
    assert _periode_trimestre(datetime(2026, 4, 1)) == "2026-Q2"


@pytest.mark.asyncio
async def test_le_prix_carburant_est_reclame_quand_la_semaine_est_vide(
    client, db_session, as_user,
):
    as_user(await _user_with(db_session, [("fuel-prices", "update")]))

    rappels = (await client.get("/api/reminders/")).json()
    carburant = [r for r in rappels if r["key"] == "FUEL_PRICE"]
    # Le rappel ne part qu'a partir du lundi 8 h : un dimanche, il est muet.
    if datetime.now().weekday() == 0 and datetime.now().hour < 8:
        assert carburant == []
        return
    assert carburant, "la semaine de test n'a aucun prix encode"
    assert carburant[0]["acknowledgeable"] is False, (
        "pas de bouton « c'est fait » : on ne doit pas pouvoir faire taire "
        "l'alerte sans encoder le prix"
    )


@pytest.mark.asyncio
async def test_un_prix_encode_eteint_le_rappel_sans_clic(client, db_session, as_user):
    """Le point important du #26 : c'est la DONNEE qui fait foi, pas un accuse."""
    from app.models.fuel_price import FuelPrice

    aujourdhui = date.today()
    lundi = aujourdhui - timedelta(days=aujourdhui.weekday())
    dimanche = lundi + timedelta(days=6)
    db_session.add(FuelPrice(
        fuel_type="DIESEL", start_date=lundi.isoformat(),
        end_date=dimanche.isoformat(), price_per_liter=1.72,
    ))
    await db_session.commit()

    as_user(await _user_with(db_session, [("fuel-prices", "update")]))
    rappels = (await client.get("/api/reminders/")).json()
    assert "FUEL_PRICE" not in {r["key"] for r in rappels}


@pytest.mark.asyncio
async def test_la_semaine_iso_est_calculee_correctement():
    """Un decalage d'une semaine ferait reapparaitre le rappel le lundi alors
    que le prix vient d'etre encode."""
    from app.api.reminders import _bornes_semaine, _periode_semaine

    mercredi = datetime(2026, 10, 14)
    lundi, dimanche = _bornes_semaine(mercredi)
    assert lundi == "2026-10-12"
    assert dimanche == "2026-10-18"
    assert _periode_semaine(mercredi) == _periode_semaine(datetime(2026, 10, 18))
    assert _periode_semaine(mercredi) != _periode_semaine(datetime(2026, 10, 19))
