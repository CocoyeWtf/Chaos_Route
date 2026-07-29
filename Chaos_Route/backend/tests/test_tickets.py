"""Tests board de tickets / Ticket board tests."""

import pytest


@pytest.mark.asyncio
async def test_ticket_full_flow(client):
    # Créer un ticket avec contexte
    payload = {
        "title": "Bouton export ne répond pas",
        "description": "Rien ne se passe au clic.",
        "ticket_type": "BUG",
        "priority": "HIGH",
        "context": {"route": "/ordonnancement", "app_version": "1.0.0", "breadcrumb": ["/tours", "/ordonnancement"]},
    }
    resp = await client.post("/api/tickets/", json=payload)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    tid = body["id"]
    assert body["status"] == "OPEN"
    assert body["title"] == payload["title"]
    # Contexte sérialisé + événement système d'ouverture
    assert body["context"] and "ordonnancement" in body["context"]
    assert any(c["is_system"] for c in body["comments"])

    # Liste transparente (tout le monde voit) + compteur
    resp = await client.get("/api/tickets/")
    assert resp.status_code == 200
    listed = [t for t in resp.json() if t["id"] == tid]
    assert listed and listed[0]["comment_count"] >= 1

    # Ajouter un échange
    resp = await client.post(f"/api/tickets/{tid}/comments", json={"body": "Je confirme le souci."})
    assert resp.status_code == 201
    assert resp.json()["is_system"] is False

    # Changer le statut -> tracé comme événement système
    resp = await client.put(f"/api/tickets/{tid}/status", json={"status": "IN_PROGRESS"})
    assert resp.status_code == 200
    detail = resp.json()
    assert detail["status"] == "IN_PROGRESS"
    sys_events = [c for c in detail["comments"] if c["is_system"]]
    assert any("IN_PROGRESS" in c["body"] for c in sys_events)


@pytest.mark.asyncio
async def test_status_change_no_op_when_same(client):
    resp = await client.post("/api/tickets/", json={"title": "T", "ticket_type": "QUESTION"})
    tid = resp.json()["id"]
    before = len(resp.json()["comments"])
    # Même statut -> pas de nouvel événement
    resp = await client.put(f"/api/tickets/{tid}/status", json={"status": "OPEN"})
    assert resp.status_code == 200
    assert len(resp.json()["comments"]) == before


@pytest.mark.asyncio
async def test_author_can_edit_and_delete(client):
    # Ticket #19 : l'auteur modifie puis supprime son propre ticket
    resp = await client.post("/api/tickets/", json={"title": "Titre initial", "ticket_type": "BUG", "priority": "LOW"})
    tid = resp.json()["id"]

    resp = await client.put(f"/api/tickets/{tid}", json={"title": "Titre corrigé", "priority": "HIGH", "description": "Détails ajoutés"})
    assert resp.status_code == 200, resp.text
    d = resp.json()
    assert d["title"] == "Titre corrigé"
    assert d["priority"] == "HIGH"
    assert d["description"] == "Détails ajoutés"
    # La modification laisse une trace système
    assert any(c["is_system"] and "modifié" in c["body"] for c in d["comments"])

    # Suppression (cascade échanges/photos) -> 204 puis introuvable
    resp = await client.delete(f"/api/tickets/{tid}")
    assert resp.status_code == 204
    resp = await client.get(f"/api/tickets/{tid}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_non_author_without_permission_cannot_edit_or_delete(client, db_session):
    """Un utilisateur tiers sans tickets:update ne peut ni modifier ni supprimer
    le ticket d'autrui (ticket #19 : garde d'autorisation auteur-ou-admin)."""
    import uuid
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    from app.api.deps import get_current_user
    from app.main import app
    from app.models.user import User

    # Ticket créé par le test_user (auteur) via le client authentifié
    resp = await client.post("/api/tickets/", json={"title": "Ticket protégé", "ticket_type": "BUG"})
    tid = resp.json()["id"]

    # Utilisateur tiers, non superadmin, sans rôle -> aucune permission
    suffix = uuid.uuid4().hex[:8]
    other = User(username=f"other_{suffix}", email=f"other-{suffix}@chaos.test",
                 hashed_password="x", is_active=True, is_superadmin=False)
    db_session.add(other)
    await db_session.commit()
    # Recharger avec les rôles (vide) pour éviter tout lazy-load hors greenlet
    res = await db_session.execute(select(User).where(User.id == other.id).options(selectinload(User.roles)))
    other = res.scalar_one()

    app.dependency_overrides[get_current_user] = lambda: other
    try:
        resp = await client.put(f"/api/tickets/{tid}", json={"title": "usurpation"})
        assert resp.status_code == 403
        resp = await client.delete(f"/api/tickets/{tid}")
        assert resp.status_code == 403
    finally:
        # Le client fixture nettoie les overrides en teardown, mais on restaure par prudence
        app.dependency_overrides.pop(get_current_user, None)
