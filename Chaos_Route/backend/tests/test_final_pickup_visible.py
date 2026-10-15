"""L'enlevement fournisseur doit etre VU et VALIDE par le chauffeur (#57).

Samuel a reduit le perimetre du ticket : « finalement il faut simplement
laisser la possibilite d'ajouter un arret enlevement fournisseur dans une
tournee, le reste sera gere autrement. 2. oui ils doivent apparaitre sur la
feuille de route. 3. il doit valider manuellement, mais pas de QR code a
scanner. 4. oui ils sont factures comme le reste. »

Le #74 avait pose l'enlevement dans le calcul des horaires, des kilometres et
du cout — donc le point 4 etait deja acquis — mais il n'apparaissait NULLE
PART : ni sur la feuille de route, ni dans l'application. Le chauffeur ne
savait pas qu'il devait y passer.
"""

import uuid

import pytest
import pytest_asyncio

DATE = "2026-11-20"


@pytest_asyncio.fixture
async def tournee_avec_enlevement(db_session, test_region):
    from app.models.base_logistics import BaseLogistics
    from app.models.contract import Contract
    from app.models.pdv import PDV, PDVType
    from app.models.supplier import Supplier
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop

    sfx = uuid.uuid4().hex[:5].upper()
    base = BaseLogistics(code=f"B{sfx}", name="Base", region_id=test_region.id)
    pdv = PDV(code=f"P{sfx}", name=f"PDV {sfx}", type=PDVType.HYPER, address="rue A",
              city="Ville", postal_code="0000", latitude=50.5, longitude=4.5,
              region_id=test_region.id)
    fournisseur = Supplier(name=f"Brasserie {sfx}", code=f"F{sfx}",
                           address="rue du Houblon 1", postal_code="7000",
                           city="Mons", region_id=test_region.id)
    contrat = Contract(code=f"C{sfx}", transporter_name="T", vacation=400,
                       region_id=test_region.id, billing_type=2)
    for o in (base, pdv, fournisseur, contrat):
        db_session.add(o)
    await db_session.commit()
    for o in (base, pdv, fournisseur, contrat):
        await db_session.refresh(o)

    t = Tour(code=f"T{sfx}", date=DATE, delivery_date=DATE, base_id=base.id,
             contract_id=contrat.id, status=TourStatus.IN_PROGRESS,
             departure_time="06:00",
             final_pickup_supplier_id=fournisseur.id,
             final_pickup_duration_minutes=45)
    db_session.add(t)
    await db_session.commit()
    await db_session.refresh(t)
    db_session.add(TourStop(tour_id=t.id, pdv_id=pdv.id, sequence_order=1, eqp_count=10))
    await db_session.commit()
    await db_session.refresh(t)
    return {"tour": t, "fournisseur": fournisseur}


@pytest.mark.asyncio
async def test_l_enlevement_figure_sur_la_feuille_de_route(client, tournee_avec_enlevement):
    """Point 2 de Samuel : « oui ils doivent apparaitre sur la feuille de route »."""
    t = tournee_avec_enlevement["tour"]
    f = tournee_avec_enlevement["fournisseur"]

    resp = await client.get(f"/api/tours/{t.id}/waybill")
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["final_pickup"] is not None, (
        "l'enlevement comptait dans les horaires et les km sans etre imprime"
    )
    assert data["final_pickup"]["name"] == f.name
    assert data["final_pickup"]["duration_minutes"] == 45
    assert data["final_pickup"]["done_at"] is None


@pytest.mark.asyncio
async def test_une_tournee_sans_enlevement_n_en_affiche_pas(
    client, db_session, tournee_avec_enlevement,
):
    """Non-regression : la ligne ne doit pas apparaitre partout."""
    t = tournee_avec_enlevement["tour"]
    t.final_pickup_supplier_id = None
    await db_session.commit()

    data = (await client.get(f"/api/tours/{t.id}/waybill")).json()
    assert data["final_pickup"] is None


@pytest.mark.asyncio
async def test_le_chauffeur_valide_a_la_main(db_session, tournee_avec_enlevement):
    """Point 3 : « il doit valider manuellement, mais pas de QR code a scanner »."""
    from app.api.driver import validate_final_pickup

    t = tournee_avec_enlevement["tour"]

    class _Device:
        id = 1
        tenant_id = None

    res = await validate_final_pickup(tour_id=t.id, db=db_session, device=_Device())
    assert res["status"] == "ok"
    assert res["done_at"]

    await db_session.refresh(t)
    assert t.final_pickup_done_at is not None


@pytest.mark.asyncio
async def test_la_validation_est_idempotente(db_session, tournee_avec_enlevement):
    """Le chauffeur appuie parfois deux fois : la premiere heure est la bonne."""
    from app.api.driver import validate_final_pickup

    t = tournee_avec_enlevement["tour"]

    class _Device:
        id = 1
        tenant_id = None

    premier = await validate_final_pickup(tour_id=t.id, db=db_session, device=_Device())
    second = await validate_final_pickup(tour_id=t.id, db=db_session, device=_Device())

    assert second["status"] == "already_done"
    assert second["done_at"] == premier["done_at"]


@pytest.mark.asyncio
async def test_valider_un_enlevement_inexistant_est_refuse(
    db_session, tournee_avec_enlevement,
):
    """Sinon on poserait un horodatage sur une tournee qui ne passe nulle part."""
    from fastapi import HTTPException
    from app.api.driver import validate_final_pickup

    t = tournee_avec_enlevement["tour"]
    t.final_pickup_supplier_id = None
    await db_session.commit()

    class _Device:
        id = 1
        tenant_id = None

    with pytest.raises(HTTPException) as exc:
        await validate_final_pickup(tour_id=t.id, db=db_session, device=_Device())
    assert exc.value.status_code == 422
