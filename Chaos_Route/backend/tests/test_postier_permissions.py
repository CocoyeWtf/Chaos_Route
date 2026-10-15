"""Acces de l'ecran postier a ses propres donnees (#107) /
Postier screen access to its own data (#107).

L'onglet « Postier » (Exploitation — Departs du jour) est gate cote menu sur la
ressource `operations`, mais il lit `/tours/`, `/volumes/` et `/contracts/`, qui
exigeaient respectivement `tour-planning:read`, `volumes:read` et
`contracts:read`. Un compte portant le role Postier voyait donc l'ecran, la
liste des bases se remplissait (bases:read), et le tableau restait vide : huit
403 d'affilee dans sa console. Meme classe de defaut que #102 et #24 — la
ressource de l'ecran ne commandait pas ses endpoints.

Donner `tour-planning:read` au role aurait suffi, mais lui aurait fait
apparaitre les menus Ordonnancement, Volumes et Contrats : les lectures
acceptent desormais `operations:read` en alternative. /
The postier screen's endpoints now accept `operations:read` as an alternative.
"""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.orm import selectinload


# Les 45 permissions du role « Postier » en production, au 2026-10-15, reduites
# a ce que touche cet ecran. On teste le role tel qu'il existe, pas un role
# ideal. / The production "Postier" role, trimmed to what this screen touches.
POSTIER_PERMISSIONS = [
    ("bases", "read"),
    ("pdvs", "read"),
    ("vehicles", "read"),
    ("operations", "read"),
    ("operations", "create"),
    ("operations", "update"),
    ("operations", "delete"),
    ("devices", "create"),
    ("devices", "read"),
    ("devices", "update"),
    ("loaders", "read"),
    ("tour-history", "read"),
    ("tour-stop-modify", "create"),
    ("tour-stop-modify", "read"),
    ("tour-stop-modify", "update"),
]


async def _user_with(db_session, permissions: list[tuple[str, str]]):
    """Utilisateur non superadmin portant exactement ces permissions.

    Les roles sont charges explicitement : un lazy-load hors greenlet casserait
    la verification de permission. / Roles are eagerly loaded.
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
async def test_le_postier_lit_les_tournees(client, db_session, as_user):
    """Le bug du ticket : `GET /tours/` renvoyait 403 au role Postier."""
    postier = await _user_with(db_session, POSTIER_PERMISSIONS)
    as_user(postier)

    resp = await client.get("/api/tours/", params={"delivery_date": "2026-10-14"})
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_le_postier_lit_volumes_et_contrats(client, db_session, as_user):
    """Les deux autres lectures de l'ecran, 403 elles aussi avant le #107.

    `/contracts/` est l'appel sans `.catch()` du front : son 403 remontait en
    `unhandledrejection` dans la console de Samuel.
    """
    postier = await _user_with(db_session, POSTIER_PERMISSIONS)
    as_user(postier)

    assert (await client.get("/api/volumes/")).status_code == 200
    assert (await client.get("/api/contracts/")).status_code == 200


@pytest.mark.asyncio
async def test_operations_read_seul_suffit(client, db_session, as_user):
    """C'est bien `operations:read` qui ouvre, pas une autre des 45 permissions."""
    minimal = await _user_with(db_session, [("operations", "read")])
    as_user(minimal)

    assert (await client.get("/api/tours/")).status_code == 200
    assert (await client.get("/api/volumes/")).status_code == 200
    assert (await client.get("/api/contracts/")).status_code == 200


@pytest.mark.asyncio
async def test_sans_aucune_des_deux_permissions_toujours_403(client, db_session, as_user):
    """La porte reste fermee : on a elargi, pas ouvert.

    Un profil PDV ne doit pas lire les tournees de l'exploitation.
    """
    pdv_like = await _user_with(db_session, [("pickup-requests", "read"), ("pdvs", "read")])
    as_user(pdv_like)

    assert (await client.get("/api/tours/")).status_code == 403
    assert (await client.get("/api/volumes/")).status_code == 403
    assert (await client.get("/api/contracts/")).status_code == 403


@pytest.mark.asyncio
async def test_tour_planning_read_ouvre_toujours(client, db_session, as_user):
    """Non-regression : l'ordonnancement lit toujours par `tour-planning:read`."""
    planner = await _user_with(db_session, [
        ("tour-planning", "read"), ("volumes", "read"), ("contracts", "read"),
    ])
    as_user(planner)

    assert (await client.get("/api/tours/")).status_code == 200
    assert (await client.get("/api/volumes/")).status_code == 200
    assert (await client.get("/api/contracts/")).status_code == 200


@pytest.mark.asyncio
async def test_le_manifeste_n_est_plus_reserve_au_superadmin(client, db_session, as_user):
    """`GET /tours/{id}/manifest` exigeait `tours:read`.

    Cette ressource n'est pas dans `RESOURCES` (`app/utils/auth.py`) : elle
    n'etait cochable par personne, donc le manifeste n'etait lisible que par un
    superadmin. Exactement l'oubli du #102, trouve en traitant le #107.
    Le 404 ci-dessous est la preuve qu'on a passe le controle de permission.
    """
    from app.utils.auth import RESOURCES

    assert "tours" not in RESOURCES, (
        "Si « tours » devient une vraie ressource, ce garde-fou n'a plus de sens."
    )

    postier = await _user_with(db_session, POSTIER_PERMISSIONS)
    as_user(postier)

    resp = await client.get("/api/tours/999999/manifest")
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_liberer_un_telephone_ne_demande_plus_devices_delete(
    client, db_session, as_user,
):
    """Reprendre un telephone n'est pas supprimer l'appareil.

    Le postier peut affecter (`devices:create`) mais ne pouvait pas liberer :
    `DELETE /assignments/{id}` exigeait `devices:delete`, qu'il n'a pas — et
    qu'on ne veut pas lui donner, puisqu'elle supprime aussi les appareils.
    """
    postier = await _user_with(db_session, POSTIER_PERMISSIONS)
    as_user(postier)

    # 404 et non 403 : le controle de permission est passe.
    resp = await client.delete("/api/assignments/999999")
    assert resp.status_code == 404, resp.text

    # La suppression d'un appareil, elle, reste fermee.
    assert (await client.delete("/api/devices/999999")).status_code == 403


@pytest.mark.asyncio
async def test_reordonner_les_arrets_suit_tour_stop_modify(client, db_session, as_user):
    """Ajouter, retirer et changer l'EQC d'un arret relevent de
    `tour-stop-modify:update` ; les reordonner exigeait `tour-planning:update`.
    L'incoherence bloquait le postier sur son propre ecran.
    """
    postier = await _user_with(db_session, POSTIER_PERMISSIONS)
    as_user(postier)

    resp = await client.put(
        "/api/tours/999999/reorder-stops", json={"stop_order": [1, 2]},
    )
    assert resp.status_code == 404, resp.text
