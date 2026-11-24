"""Ticket #116 — « Remplacer » à l'import des volumes vidait les tournées.

Constaté en production le 18/11/2026 : les volumes du 17/11 (base Villers) ont
été réimportés en mode « Remplacer » alors que des tournées étaient déjà
construites. Le DELETE en masse emportait aussi les volumes rattachés à ces
tournées ; elles restaient affichées, arrêts compris, mais sans volume derrière.
Supprimer ensuite la tournée ne libérait plus rien : les PDV et les EQC
semblaient « disparaître ».

Correctif : un périmètre (date de répartition × base) dont des volumes sont déjà
planifiés ne se remplace plus. L'analyse préalable (`mode=check`) nomme les
tournées concernées, et `mode=replace` est refusé (409) sans rien supprimer.
"""

import uuid

import pytest
from sqlalchemy import select

DATE = "2026-11-17"


async def _setup(db_session, region, *, planned: bool):
    from app.models.base_logistics import BaseLogistics
    from app.models.pdv import PDV, PDVType
    from app.models.tour import Tour
    from app.models.volume import Volume, TemperatureClass
    from app.models.tenant import Tenant
    from app.database import set_session_tenant

    # Le client de test est superadmin : l'import résout la société depuis la base.
    tenant = Tenant(code=f"T{uuid.uuid4().hex[:4]}", name="Tenant #116")
    db_session.add(tenant)
    await db_session.commit()
    set_session_tenant(db_session, tenant.id)

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base", region_id=region.id)
    pdv = PDV(code=f"P{uuid.uuid4().hex[:5].upper()}", name="PDV", type=PDVType.HYPER, region_id=region.id)
    db_session.add_all([base, pdv])
    await db_session.commit()
    tour = None
    if planned:
        tour = Tour(date=DATE, code=f"T-{uuid.uuid4().hex[:8]}", base_id=base.id)
        db_session.add(tour)
        await db_session.commit()
    vol = Volume(
        pdv_id=pdv.id, date=DATE, dispatch_date=DATE, eqp_count=10,
        temperature_class=TemperatureClass("SEC"), base_origin_id=base.id,
        tour_id=tour.id if tour else None,
    )
    db_session.add(vol)
    await db_session.commit()
    # Valeurs lues avant toute expiration de session (pas de lazy-load async).
    ids = {
        "base": base.id, "pdv_code": pdv.code, "vol": vol.id,
        "tour": tour.id if tour else None, "tour_code": tour.code if tour else None,
    }
    set_session_tenant(db_session, None)
    return ids


def _csv(pdv_code: str) -> bytes:
    return f"pdv_code;eqp_count;temperature_class\n{pdv_code};12;SEC\n".encode()


@pytest.mark.asyncio
async def test_check_names_planned_tours(client, db_session, test_region):
    r = await _setup(db_session, test_region, planned=True)
    resp = await client.post(
        f"/api/imports/volumes?mode=check&dispatch_date={DATE}&base_origin_id={r['base']}",
        files={"file": ("v.csv", _csv(r['pdv_code']), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "duplicate_warning"
    assert body["planned_tours"] == [r['tour_code']]


@pytest.mark.asyncio
async def test_replace_refused_when_volumes_planned(client, db_session, test_region):
    from app.models.volume import Volume

    r = await _setup(db_session, test_region, planned=True)
    resp = await client.post(
        f"/api/imports/volumes?mode=replace&dispatch_date={DATE}&base_origin_id={r['base']}",
        files={"file": ("v.csv", _csv(r['pdv_code']), "text/csv")},
    )
    assert resp.status_code == 409, resp.text
    assert r['tour_code'] in resp.json()["detail"]
    # Rien n'a été supprimé : le volume est toujours là, toujours dans sa tournée.
    db_session.expire_all()
    kept = (await db_session.execute(select(Volume).where(Volume.id == r['vol']))).scalar_one_or_none()
    assert kept is not None and kept.tour_id == r['tour']


@pytest.mark.asyncio
async def test_replace_still_allowed_when_nothing_planned(client, db_session, test_region):
    from app.models.volume import Volume

    r = await _setup(db_session, test_region, planned=False)
    resp = await client.post(
        f"/api/imports/volumes?mode=replace&dispatch_date={DATE}&base_origin_id={r['base']}",
        files={"file": ("v.csv", _csv(r['pdv_code']), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    db_session.expire_all()
    gone = (await db_session.execute(select(Volume).where(Volume.id == r['vol']))).scalar_one_or_none()
    assert gone is None


@pytest.mark.asyncio
async def test_87_autre_base_deja_chargee_demande_confirmation(client, db_session, test_region):
    """#87 (option A) — le jour porte déjà les volumes d'une AUTRE base : on
    nomme les bases avant d'écrire, et rien n'est importé sans confirmation."""
    from app.models.base_logistics import BaseLogistics
    from app.models.volume import Volume
    from app.models.tenant import Tenant
    from app.database import set_session_tenant

    r = await _setup(db_session, test_region, planned=False)  # base A chargée ce jour
    autre = BaseLogistics(code=f"Z{uuid.uuid4().hex[:5].upper()}", name="Trazegnies", region_id=test_region.id)
    base_a = await db_session.get(BaseLogistics, r["base"])
    autre.tenant_id = base_a.tenant_id
    db_session.add(autre)
    await db_session.commit()
    autre_id = autre.id

    resp = await client.post(
        f"/api/imports/volumes?mode=check&dispatch_date={DATE}&base_origin_id={autre_id}",
        files={"file": ("v.csv", _csv(r["pdv_code"]), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "base_warning"
    assert body["other_bases"][0]["count"] == 1
    n = (await db_session.execute(select(Volume).where(Volume.base_origin_id == autre_id))).scalars().all()
    assert n == []
