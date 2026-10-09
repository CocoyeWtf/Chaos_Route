"""Acces au board de tickets par les permissions de role (#102) /
Role-based access to the ticket board (#102).

Le board etait ouvert a tout utilisateur authentifie : un compte PDV voyait
donc les tickets de l'exploitation, et le bouton « Signaler » lui etait offert.
Il est desormais gate sur la ressource `tickets`, action par action. /
The board used to be open to any authenticated user, PDV accounts included.
"""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.orm import selectinload


async def _user_with(db_session, permissions: list[tuple[str, str]]):
    """Utilisateur non superadmin portant exactement ces permissions.

    Les roles sont charges explicitement : un lazy-load hors greenlet casserait
    le controle inline « auteur OU admin ». / Roles are eagerly loaded.
    """
    from app.models.user import Permission, Role, User

    suffix = uuid.uuid4().hex[:8]
    role = Role(name=f"role_{suffix}", description="role de test")
    role.permissions = [Permission(resource=r, action=a) for r, a in permissions]
    user = User(
        username=f"u_{suffix}", email=f"u-{suffix}@chaos.test",
        hashed_password="x", is_active=True, is_superadmin=False,
    )
    user.roles = [role]
    db_session.add(role)
    db_session.add(user)
    await db_session.commit()

    res = await db_session.execute(
        select(User).where(User.id == user.id).options(selectinload(User.roles))
    )
    return res.scalar_one()


@pytest_asyncio.fixture
async def as_user():
    """Bascule l'identite du client HTTP / Switch the HTTP client's identity."""
    from app.api.deps import get_current_user
    from app.main import app

    def _switch(user):
        app.dependency_overrides[get_current_user] = lambda: user

    yield _switch
    app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_sans_permission_le_board_est_invisible(client, db_session, as_user):
    """Profil PDV : ni lecture, ni creation. C'est la demande du #102."""
    pdv_like = await _user_with(db_session, [("pickup-requests", "read")])
    as_user(pdv_like)

    assert (await client.get("/api/tickets/")).status_code == 403
    resp = await client.post("/api/tickets/", json={"title": "T", "ticket_type": "BUG"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_lecture_seule_ne_permet_pas_de_contribuer(client, db_session, as_user):
    """`read` sans `create` : on consulte le fil, on n'y ecrit pas."""
    # Ticket d'autrui, cree par le superadmin du client
    resp = await client.post("/api/tickets/", json={"title": "Ticket tiers", "ticket_type": "BUG"})
    tid = resp.json()["id"]

    lecteur = await _user_with(db_session, [("tickets", "read")])
    as_user(lecteur)

    assert (await client.get("/api/tickets/")).status_code == 200
    assert (await client.get(f"/api/tickets/{tid}")).status_code == 200
    assert (await client.post("/api/tickets/", json={"title": "X", "ticket_type": "BUG"})).status_code == 403
    assert (await client.post(f"/api/tickets/{tid}/comments", json={"body": "coucou"})).status_code == 403


@pytest.mark.asyncio
async def test_demandeur_garde_la_main_sur_son_ticket(client, db_session, as_user):
    """`read` + `create` suffisent pour ouvrir, repondre, corriger et retirer SON
    ticket — mais pas pour toucher au statut ni au ticket d'autrui."""
    autre = await client.post("/api/tickets/", json={"title": "Ticket tiers", "ticket_type": "BUG"})
    tid_autre = autre.json()["id"]

    demandeur = await _user_with(db_session, [("tickets", "read"), ("tickets", "create")])
    as_user(demandeur)

    resp = await client.post("/api/tickets/", json={"title": "Mon souci", "ticket_type": "BUG"})
    assert resp.status_code == 201
    tid = resp.json()["id"]

    assert (await client.post(f"/api/tickets/{tid}/comments", json={"body": "precision"})).status_code == 201
    assert (await client.put(f"/api/tickets/{tid}", json={"title": "Mon souci (corrige)"})).status_code == 200

    # Statut : reserve a `tickets:update`
    assert (await client.put(f"/api/tickets/{tid}/status", json={"status": "RESOLVED"})).status_code == 403
    # Ticket d'autrui : intouchable
    assert (await client.put(f"/api/tickets/{tid_autre}", json={"title": "usurpation"})).status_code == 403
    assert (await client.delete(f"/api/tickets/{tid_autre}")).status_code == 403
    # Son propre ticket : il peut le retirer
    assert (await client.delete(f"/api/tickets/{tid}")).status_code == 204


@pytest.mark.asyncio
async def test_update_ne_donne_pas_le_droit_de_supprimer(client, db_session, as_user):
    """`update` traite le board (statut, priorite) ; effacer un ticket et ses
    echanges est une autre autorite, portee par `delete`."""
    resp = await client.post("/api/tickets/", json={"title": "Ticket tiers", "ticket_type": "BUG"})
    tid = resp.json()["id"]

    gestionnaire = await _user_with(db_session, [("tickets", "read"), ("tickets", "update")])
    as_user(gestionnaire)

    resp = await client.put(f"/api/tickets/{tid}/status", json={"status": "IN_PROGRESS"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "IN_PROGRESS"
    assert (await client.put(f"/api/tickets/{tid}", json={"title": "Titre arbitre"})).status_code == 200

    assert (await client.delete(f"/api/tickets/{tid}")).status_code == 403

    # Avec `delete`, la suppression passe
    nettoyeur = await _user_with(db_session, [("tickets", "read"), ("tickets", "delete")])
    as_user(nettoyeur)
    assert (await client.delete(f"/api/tickets/{tid}")).status_code == 204


@pytest.mark.asyncio
async def test_tickets_est_cochable_dans_la_matrice():
    """La ressource doit figurer dans RESOURCES, sinon aucun role ne peut la
    porter et le gate ci-dessus fermerait le board a tout le monde sauf aux
    superadmins. / Without the resource listed, no role could hold it."""
    from app.utils.auth import ACTIONS, RESOURCES

    assert "tickets" in RESOURCES
    assert {"read", "create", "update", "delete"} <= set(ACTIONS)
