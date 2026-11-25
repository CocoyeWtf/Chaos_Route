"""Board des tickets : faire apparaître qu'on attend une réponse de l'utilisateur.

La règle suit l'auteur du dernier message humain, pas ses droits.
"""

import uuid

import pytest


@pytest.mark.asyncio
async def test_waiting_on_suit_le_dernier_message(client, db_session):
    from app.models.ticket import TicketComment
    from app.models.user import User

    resp = await client.post("/api/tickets/", json={"title": "Attente", "ticket_type": "BUG"})
    tid = resp.json()["id"]

    async def item():
        lst = await client.get("/api/tickets/")
        return next(t for t in lst.json() if t["id"] == tid)

    assert (await item())["waiting_on"] == "SUPPORT"          # personne n'a encore répondu

    sfx = uuid.uuid4().hex[:8]
    other = User(username=f"sup_{sfx}", email=f"sup-{sfx}@chaos.test", hashed_password="x",
                 is_active=True, is_superadmin=False)
    db_session.add(other)
    await db_session.commit()
    other_id = other.id
    db_session.add(TicketComment(ticket_id=tid, user_id=other_id, user_name="Support",
                                 body="Une question ?", tenant_id=1))
    await db_session.commit()
    it = await item()
    assert it["waiting_on"] == "USER"
    assert it["last_message_by"] == "Support"

    r = await client.post(f"/api/tickets/{tid}/comments", json={"body": "Voici la réponse"})
    assert r.status_code == 201
    assert (await item())["waiting_on"] == "SUPPORT"

    # Un changement de statut (événement système) ne compte pas comme réponse
    await client.put(f"/api/tickets/{tid}/status", json={"status": "IN_PROGRESS"})
    assert (await item())["waiting_on"] == "SUPPORT"

    await client.put(f"/api/tickets/{tid}/status", json={"status": "CLOSED"})
    assert (await item())["waiting_on"] is None
