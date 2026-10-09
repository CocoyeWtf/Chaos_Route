"""Une tournee se prend au scan, pas au tap (#98) /
Taking a tour requires a scan, not a tap (#98).

Un telephone reste avec son chauffeur toute la journee. L'ecran listait les
tournees disponibles de la base et un simple tap les affectait : n'importe quel
chauffeur pouvait prendre la tournee d'un collegue, qui se retrouvait alors
sans rien. Le serveur exige desormais la preuve du scan — le QR du postier
« TOUR:<id> » ou le code-barres de la feuille de route. /
The server now demands proof of scan.

La tolerance pour les builds anterieurs au 16 est testee aussi : la retirer
bloquerait des chauffeurs en tournee le temps que le parc se mette a jour.
"""

import uuid

import pytest


async def _make_device(db_session, *, base_id=None, app_build=None):
    from app.models.mobile_device import MobileDevice

    device = MobileDevice(
        device_identifier=f"dev-{uuid.uuid4().hex[:10]}",
        registration_code=uuid.uuid4().hex[:8].upper(),
        is_active=True,
        profile="DRIVER",
        allowed_features="tours,pickups,declarations",
        base_id=base_id,
        app_build=app_build,
    )
    db_session.add(device)
    await db_session.commit()
    await db_session.refresh(device)
    return device


async def _make_tour(db_session, test_region, test_pdv, *, day="2026-10-09"):
    from app.models.base_logistics import BaseLogistics
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base", region_id=test_region.id)
    db_session.add(base)
    await db_session.flush()

    tour = Tour(
        date=day, delivery_date=day,
        code=f"T-{uuid.uuid4().hex[:8].upper()}",
        base_id=base.id,
        status=TourStatus.VALIDATED,
        driver_name="Jean Dupont",
    )
    db_session.add(tour)
    await db_session.flush()
    db_session.add(TourStop(tour_id=tour.id, pdv_id=test_pdv.id, sequence_order=1, eqp_count=10))
    await db_session.commit()
    await db_session.refresh(tour)
    return tour


def _headers(device, build=None):
    h = {"X-Device-ID": device.device_identifier}
    if build is not None:
        h["X-App-Build"] = str(build)
    return h


@pytest.mark.asyncio
async def test_sans_scan_le_build_16_est_refuse(client, db_session, test_region, test_pdv):
    """Le tap d'autrefois : un tour_id nu, sans preuve. Refuse."""
    tour = await _make_tour(db_session, test_region, test_pdv)
    device = await _make_device(db_session, base_id=tour.base_id, app_build=16)

    resp = await client.post(
        "/api/driver/assign-tour", json={"tour_id": tour.id}, headers=_headers(device, 16),
    )
    assert resp.status_code == 403, resp.text
    assert "scan" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_le_code_de_la_feuille_de_route_suffit(client, db_session, test_region, test_pdv):
    """Le code-barres de la feuille de route identifie la tournee a lui seul :
    l'app n'a pas besoin de connaitre la liste des tournees disponibles."""
    tour = await _make_tour(db_session, test_region, test_pdv)
    device = await _make_device(db_session, base_id=tour.base_id, app_build=16)

    resp = await client.post(
        "/api/driver/assign-tour", json={"scan_code": tour.code}, headers=_headers(device, 16),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["code"] == tour.code


@pytest.mark.asyncio
async def test_le_qr_du_postier_est_accepte(client, db_session, test_region, test_pdv):
    """Format « TOUR:<id> » (#51), celui qu'affiche l'ecran du postier."""
    tour = await _make_tour(db_session, test_region, test_pdv)
    device = await _make_device(db_session, base_id=tour.base_id, app_build=16)

    resp = await client.post(
        "/api/driver/assign-tour", json={"scan_code": f"TOUR:{tour.id}"}, headers=_headers(device, 16),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["code"] == tour.code


@pytest.mark.asyncio
async def test_un_code_qui_designe_une_autre_tournee_est_refuse(client, db_session, test_region, test_pdv):
    """Scanner la feuille d'un collegue pour s'attribuer une autre tournee :
    le code doit designer LA tournee demandee."""
    tour = await _make_tour(db_session, test_region, test_pdv)
    autre = await _make_tour(db_session, test_region, test_pdv)
    device = await _make_device(db_session, base_id=tour.base_id, app_build=16)

    resp = await client.post(
        "/api/driver/assign-tour",
        json={"tour_id": tour.id, "scan_code": autre.code},
        headers=_headers(device, 16),
    )
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
async def test_code_inconnu_renvoie_404(client, db_session, test_region, test_pdv):
    device = await _make_device(db_session, app_build=16)
    resp = await client.post(
        "/api/driver/assign-tour", json={"scan_code": "PAS-UN-CODE"}, headers=_headers(device, 16),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_rien_a_affecter_sans_code_ni_id(client, db_session):
    device = await _make_device(db_session, app_build=16)
    resp = await client.post("/api/driver/assign-tour", json={}, headers=_headers(device, 16))
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_les_builds_anterieurs_restent_servis(client, db_session, test_region, test_pdv):
    """Build 15 : l'app ne sait pas envoyer la preuve. La refuser immobiliserait
    des chauffeurs le temps que le parc passe au 16. / Older builds still work."""
    tour = await _make_tour(db_session, test_region, test_pdv)
    device = await _make_device(db_session, base_id=tour.base_id, app_build=15)

    resp = await client.post(
        "/api/driver/assign-tour", json={"tour_id": tour.id}, headers=_headers(device, 15),
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_le_mode_d_affectation_est_audite(client, db_session, test_region, test_pdv):
    """L'audit doit dire si la tournee a ete prise au scan ou en mode legacy :
    c'est le seul moyen de verifier que le parc est bien passe au scan."""
    from sqlalchemy import select

    from app.models.audit import AuditLog

    tour = await _make_tour(db_session, test_region, test_pdv)
    device = await _make_device(db_session, base_id=tour.base_id, app_build=16)
    resp = await client.post(
        "/api/driver/assign-tour", json={"scan_code": tour.code}, headers=_headers(device, 16),
    )
    assert resp.status_code == 200, resp.text

    rows = (await db_session.execute(
        select(AuditLog).where(AuditLog.entity_id == tour.id, AuditLog.action == "SELF_ASSIGN")
    )).scalars().all()
    assert rows and '"mode":"scan"' in rows[-1].changes
