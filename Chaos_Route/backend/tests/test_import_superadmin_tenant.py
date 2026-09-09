"""Ticket #22 — import de volumes par un superadmin (session sans tenant).

Un superadmin opère avec `tenant_id = None` (accès multi-société). L'import d'une
entité cloisonnée refusait alors tout (garde anti-orphelins : sinon lignes
`tenant_id = NULL` invisibles — incident du 2026-06-22), ce qui bloquait les
superadmins (400) alors qu'un rôle « métier » rattaché à une société passait.

Correctif : quand la société courante est indéterminée, on la résout SANS AMBIGUÏTÉ
depuis la base d'origine fournie (une base appartient à un tenant). À défaut d'ancre
fiable, on refuse toujours.
"""

import uuid

import pytest

from app.database import set_session_tenant
from app.models.base_logistics import BaseLogistics
from app.models.tenant import Tenant


@pytest.mark.asyncio
async def test_superadmin_import_refused_without_origin_base(client):
    """Sans base d'origine, la société cible est indéterminable → refus 400 (garde)."""
    resp = await client.post(
        "/api/imports/volumes",
        files={"file": ("v.csv", b"pdv\n001\n", "text/csv")},
    )
    assert resp.status_code == 400
    assert "société cible" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_superadmin_import_resolves_tenant_from_origin_base(client, db_session, test_region):
    """Avec une base d'origine, la garde résout la société de la base et laisse passer."""
    tenant = Tenant(code=f"IT{uuid.uuid4().hex[:4]}", name="Tenant Import #22")
    db_session.add(tenant)
    await db_session.commit()

    set_session_tenant(db_session, tenant.id)
    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:4]}", name="Base Import #22", region_id=test_region.id)
    db_session.add(base)
    await db_session.commit()
    assert base.tenant_id == tenant.id  # stampé sur la société de la base
    set_session_tenant(db_session, None)

    resp = await client.post(
        f"/api/imports/volumes?base_origin_id={base.id}",
        files={"file": ("v.csv", b"pdv\n001\n", "text/csv")},
    )
    # La garde tenant est franchie : la réponse n'est PAS le refus « société cible »
    # (le traitement en aval du fichier factice peut échouer pour d'autres raisons,
    # ce qui n'est pas l'objet de ce test).
    detail = ""
    if resp.headers.get("content-type", "").startswith("application/json"):
        detail = str(resp.json().get("detail", ""))
    assert "société cible" not in detail
