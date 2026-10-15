"""Masquage des supports par PDV (#105) / Per-PDV support visibility (#105).

A la demande du PDV 01717 (Beyne) : l'app lui propose 41 types de support
retournables, dont 20 casiers biere, alors qu'il en utilise 16 et n'en encode
vraiment que 8. Chaque magasin peut desormais masquer ceux qu'il ne retourne
jamais, sans que son reglage deborde sur les 169 autres PDV.

Logique de masquage, pas d'autorisation : regle absente = visible, un support
cree plus tard apparait donc partout tout seul.
"""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select


@pytest_asyncio.fixture
async def supports(db_session):
    """Trois supports retournables : une palette, un casier, une balle.

    Les codes suivent les vrais prefixes (`PA`/`PL`/`RE`) parce que
    `is_return_support_code` filtre dessus — un code de fantaisie serait
    invisible et le test passerait pour de mauvaises raisons.
    """
    from app.models.support_type import SupportType

    suffix = uuid.uuid4().hex[:4].upper()
    created = []
    for prefix, name in (("PA", "Palette"), ("PL", "Casiers"), ("RE", "Balle")):
        st = SupportType(
            code=f"{prefix} 9{suffix}",
            short_code=prefix,
            name=f"{name} test {suffix}",
            unit_quantity=1,
            is_active=True,
        )
        db_session.add(st)
        created.append(st)
    await db_session.commit()
    for st in created:
        await db_session.refresh(st)
    return created


@pytest_asyncio.fixture
async def other_pdv(db_session, test_region):
    """Un second PDV, pour verifier le cloisonnement des reglages."""
    from app.models.pdv import PDV, PDVType

    code = f"T{uuid.uuid4().hex[:5].upper()}"
    pdv = PDV(
        code=code, name=f"PDV Test {code}", type=PDVType.HYPER,
        address="a", city="c", postal_code="0000",
        latitude=50.0, longitude=4.0, region_id=test_region.id,
    )
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)
    return pdv


def _visibility(payload: dict, support_id: int) -> bool:
    for st in payload["support_types"]:
        if st["id"] == support_id:
            return st["visible"]
    raise AssertionError(f"support {support_id} absent de la reponse")


@pytest.mark.asyncio
async def test_par_defaut_tout_est_visible(client, test_pdv, supports):
    """Aucune regle en base → le magasin voit tout. C'est l'etat d'aujourd'hui."""
    resp = await client.get(f"/api/pdv-support-rules/{test_pdv.id}")
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["pdv"]["id"] == test_pdv.id
    for st in supports:
        assert _visibility(data, st.id) is True


@pytest.mark.asyncio
async def test_masquer_puis_relire(client, test_pdv, supports):
    """Le reglage se relit tel qu'il a ete pose."""
    casier = supports[1]
    resp = await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={"items": [{"support_type_id": casier.id, "visible": False}]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["hidden_count"] == 1

    data = (await client.get(f"/api/pdv-support-rules/{test_pdv.id}")).json()
    assert _visibility(data, casier.id) is False
    assert _visibility(data, supports[0].id) is True


@pytest.mark.asyncio
async def test_le_reglage_ne_deborde_pas_sur_un_autre_pdv(
    client, test_pdv, other_pdv, supports,
):
    """La demande explicite du ticket : « il ne faut pas que le 1717 decoche
    certains supports et qu'ils disparaissent egalement de l'app du 7666 »."""
    casier = supports[1]
    await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={"items": [{"support_type_id": casier.id, "visible": False}]},
    )

    voisin = (await client.get(f"/api/pdv-support-rules/{other_pdv.id}")).json()
    assert _visibility(voisin, casier.id) is True


@pytest.mark.asyncio
async def test_rendre_visible_supprime_la_ligne(client, db_session, test_pdv, supports):
    """La table ne garde que les exceptions : repasser un support a visible
    efface sa ligne au lieu d'y laisser un `visible=True` qui ne sert a rien."""
    from app.models.pdv_support_rule import PdvSupportRule

    casier = supports[1]
    await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={"items": [{"support_type_id": casier.id, "visible": False}]},
    )
    await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={"items": [{"support_type_id": casier.id, "visible": True}]},
    )

    rows = (await db_session.execute(
        select(PdvSupportRule).where(PdvSupportRule.pdv_id == test_pdv.id)
    )).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_un_support_inconnu_est_refuse(client, test_pdv):
    """On ne cree pas de regle sur un support qui n'existe pas ou qui n'est
    de toute facon pas propose au magasin (casiers biere SF 3xxxx)."""
    resp = await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={"items": [{"support_type_id": 999999, "visible": False}]},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_copie_vers_d_autres_pdv(client, test_pdv, other_pdv, supports):
    """Regler une enseigne entiere sans repeter 41 cases par magasin."""
    casier, balle = supports[1], supports[2]
    await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={
            "items": [
                {"support_type_id": casier.id, "visible": False},
                {"support_type_id": balle.id, "visible": False},
            ]
        },
    )

    resp = await client.post(
        f"/api/pdv-support-rules/{test_pdv.id}/copy",
        json={"target_pdv_ids": [other_pdv.id]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["hidden_count"] == 2

    cible = (await client.get(f"/api/pdv-support-rules/{other_pdv.id}")).json()
    assert _visibility(cible, casier.id) is False
    assert _visibility(cible, balle.id) is False
    assert _visibility(cible, supports[0].id) is True


@pytest.mark.asyncio
async def test_la_copie_remplace_au_lieu_de_cumuler(
    client, test_pdv, other_pdv, supports,
):
    """Sinon une copie ne saurait que masquer davantage, et un reglage trop
    large serait irrattrapable autrement qu'a la main."""
    palette, casier = supports[0], supports[1]

    # La cible masque deja la palette, que la source laisse visible.
    await client.put(
        f"/api/pdv-support-rules/{other_pdv.id}",
        json={"items": [{"support_type_id": palette.id, "visible": False}]},
    )
    await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={"items": [{"support_type_id": casier.id, "visible": False}]},
    )

    await client.post(
        f"/api/pdv-support-rules/{test_pdv.id}/copy",
        json={"target_pdv_ids": [other_pdv.id]},
    )

    cible = (await client.get(f"/api/pdv-support-rules/{other_pdv.id}")).json()
    assert _visibility(cible, palette.id) is True
    assert _visibility(cible, casier.id) is False


@pytest.mark.asyncio
async def test_reinitialiser_rend_tout_visible(client, test_pdv, supports):
    """Le retour en arriere complet, en un geste."""
    await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={"items": [{"support_type_id": st.id, "visible": False} for st in supports]},
    )

    resp = await client.delete(f"/api/pdv-support-rules/{test_pdv.id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["removed"] == 3

    data = (await client.get(f"/api/pdv-support-rules/{test_pdv.id}")).json()
    for st in supports:
        assert _visibility(data, st.id) is True


@pytest.mark.asyncio
async def test_le_compteur_de_pdv_signale_les_magasins_regles(
    client, test_pdv, supports,
):
    """La liste des PDV porte le nombre de masques : sans ce compteur il
    faudrait ouvrir les 170 magasins pour savoir lesquels ont ete touches."""
    await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={"items": [{"support_type_id": supports[1].id, "visible": False}]},
    )

    rows = (await client.get("/api/pdv-support-rules/pdvs")).json()
    ligne = next(r for r in rows if r["id"] == test_pdv.id)
    assert ligne["hidden_count"] == 1


@pytest_asyncio.fixture
async def as_pdv_user():
    """Bascule le client HTTP sur un compte rattache a un PDV."""
    from app.api.deps import get_current_user
    from app.main import app

    def _switch(user):
        app.dependency_overrides[get_current_user] = lambda: user

    yield _switch
    app.dependency_overrides.pop(get_current_user, None)


async def _pdv_user(db_session, pdv_id: int):
    """Compte magasin portant juste de quoi lire le formulaire de reprise."""
    from sqlalchemy.orm import selectinload
    from app.models.user import Permission, Role, User

    suffix = uuid.uuid4().hex[:8]
    role = Role(name=f"pdv_{suffix}", description="role PDV de test")
    role.permissions = [Permission(resource="pickup-requests", action="read")]
    user = User(
        username=f"p_{suffix}", email=f"p-{suffix}@chaos.test",
        hashed_password="x", is_active=True, is_superadmin=False, pdv_id=pdv_id,
    )
    user.roles = [role]
    db_session.add(role)
    db_session.add(user)
    await db_session.commit()

    return (await db_session.execute(
        select(User).where(User.id == user.id).options(selectinload(User.roles))
    )).scalar_one()


@pytest.mark.asyncio
async def test_le_formulaire_de_reprise_marque_les_supports_masques(
    client, db_session, test_pdv, other_pdv, supports, as_pdv_user,
):
    """Le bout qui compte pour le magasin : son app recoit bien le drapeau.

    Les supports masques restent dans la reponse, marques `hidden`. L'app les
    retire de la liste d'encodage mais les garde disponibles pour la palette
    support obligatoire des balles (#12), dont le choix se fait parmi les codes
    PA : les supprimer ici empecherait un PDV ayant masque ses palettes de
    declarer la moindre balle.
    """
    casier = supports[1]
    await client.put(
        f"/api/pdv-support-rules/{test_pdv.id}",
        json={"items": [{"support_type_id": casier.id, "visible": False}]},
    )

    as_pdv_user(await _pdv_user(db_session, test_pdv.id))
    data = (await client.get("/api/pickup-requests/form-data/")).json()
    par_id = {st["id"]: st for st in data["support_types"]}
    assert par_id[casier.id]["hidden"] is True
    assert par_id[supports[0].id]["hidden"] is False

    # Le magasin voisin, lui, ne voit rien de ce reglage.
    as_pdv_user(await _pdv_user(db_session, other_pdv.id))
    voisin = (await client.get("/api/pickup-requests/form-data/")).json()
    assert {st["id"]: st for st in voisin["support_types"]}[casier.id]["hidden"] is False
