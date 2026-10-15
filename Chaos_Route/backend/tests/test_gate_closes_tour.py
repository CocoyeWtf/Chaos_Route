"""Le poste de garde ferme la tournee, le telephone ne la rouvre pas (#90).

Samuel : « le tour est declare revenu par le poste de garde, mais le telephone
a encore la possibilite de cliquer apres ca sur "retour base" et est donc, sur
l'application, note comme en retour alors que d'apres le poste de garde il est
deja revenu. »

Deux defauts se combinaient :
  - la cloture au passage de barriere n'operait que depuis RETURNING, donc
    seulement si le chauffeur avait appuye AVANT le garde ;
  - `return_to_base` ecrasait le statut sans condition, donc meme apres.
"""

import uuid

import pytest
import pytest_asyncio

DATE = "2026-11-12"


@pytest_asyncio.fixture
async def tournee(db_session, test_region):
    from app.models.base_logistics import BaseLogistics
    from app.models.tour import Tour, TourStatus

    sfx = uuid.uuid4().hex[:5].upper()
    base = BaseLogistics(code=f"B{sfx}", name="Base", region_id=test_region.id)
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)

    t = Tour(code=f"T{sfx}", date=DATE, delivery_date=DATE, base_id=base.id,
             status=TourStatus.IN_PROGRESS, departure_time="06:00")
    db_session.add(t)
    await db_session.commit()
    await db_session.refresh(t)
    return t


@pytest.mark.asyncio
async def test_le_garde_cloture_depuis_in_progress(client, db_session, tournee):
    """Avant, la cloture n'operait que depuis RETURNING : si le chauffeur
    n'avait pas appuye sur « retour base », la tournee restait IN_PROGRESS
    alors que le camion etait au parking."""
    from app.models.tour import TourStatus

    resp = await client.put(f"/api/tours/{tournee.id}/gate",
                            json={"barrier_entry_time": "15:30"})
    assert resp.status_code == 200, resp.text

    await db_session.refresh(tournee)
    assert tournee.status == TourStatus.COMPLETED


@pytest.mark.asyncio
async def test_le_garde_cloture_aussi_depuis_returning(client, db_session, tournee):
    """Non-regression du comportement d'origine."""
    from app.models.tour import TourStatus

    tournee.status = TourStatus.RETURNING
    await db_session.commit()

    resp = await client.put(f"/api/tours/{tournee.id}/gate",
                            json={"barrier_entry_time": "15:30"})
    assert resp.status_code == 200, resp.text

    await db_session.refresh(tournee)
    assert tournee.status == TourStatus.COMPLETED


@pytest.mark.asyncio
async def test_le_telephone_ne_rouvre_pas_une_tournee_cloturee(db_session, tournee):
    """Le geste du chauffeur arrive forcement apres le passage de barriere :
    il ne doit pas faire reculer une tournee que le garde a pointee rentree."""
    from app.api.driver import return_to_base
    from app.models.tour import TourStatus
    from app.schemas.mobile import ReturnToBaseCreate

    tournee.status = TourStatus.COMPLETED
    tournee.barrier_entry_time = "15:30"
    await db_session.commit()

    class _Device:
        id = 1
        tenant_id = None

    res = await return_to_base(
        tour_id=tournee.id,
        data=ReturnToBaseCreate(timestamp="2026-11-12T15:45:00"),
        db=db_session,
        device=_Device(),
    )
    assert res["status"] == "already_closed"
    assert res["tour_status"] == "COMPLETED"

    await db_session.refresh(tournee)
    assert tournee.status == TourStatus.COMPLETED, "la tournee ne doit pas reculer"


@pytest.mark.asyncio
async def test_le_retour_base_fonctionne_toujours_en_cours_de_tournee(db_session, tournee):
    """On n'a ferme que le cas deja clos : le geste normal reste intact."""
    from app.api.driver import return_to_base
    from app.models.tour import TourStatus
    from app.schemas.mobile import ReturnToBaseCreate

    class _Device:
        id = 1
        tenant_id = None

    res = await return_to_base(
        tour_id=tournee.id,
        data=ReturnToBaseCreate(timestamp="2026-11-12T15:45:00"),
        db=db_session,
        device=_Device(),
    )
    assert res["tour_status"] == "RETURNING"

    await db_session.refresh(tournee)
    assert tournee.status == TourStatus.RETURNING
