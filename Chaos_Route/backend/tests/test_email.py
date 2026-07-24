"""Tests du service email et du flux forgot-password.

Verrouille le correctif du bug historique « TLS implicite sur port 587 » :
- résolution correcte du mode TLS (implicite vs STARTTLS, mutuellement exclusifs) ;
- forgot-password renvoie toujours un 200 générique (anti-énumération) et ne
  plante jamais en 500, même si l'envoi SMTP échoue.
"""

import uuid

import pytest
import pytest_asyncio


# --------------------------------------------------------------------------
# Résolution du mode TLS / TLS mode resolution
# --------------------------------------------------------------------------

def test_resolve_tls_starttls_for_587(monkeypatch):
    """Port 587 (défaut) → STARTTLS, pas de TLS implicite."""
    from app.services import email

    monkeypatch.setattr(email.settings, "SMTP_USE_TLS", False)
    monkeypatch.setattr(email.settings, "SMTP_STARTTLS", True)
    use_tls, start_tls = email._resolve_tls()
    assert use_tls is False
    assert start_tls is True


def test_resolve_tls_implicit_for_465(monkeypatch):
    """TLS implicite (465) → use_tls seul, STARTTLS désactivé."""
    from app.services import email

    monkeypatch.setattr(email.settings, "SMTP_USE_TLS", True)
    monkeypatch.setattr(email.settings, "SMTP_STARTTLS", False)
    use_tls, start_tls = email._resolve_tls()
    assert use_tls is True
    assert start_tls is False


def test_resolve_tls_mutual_exclusion(monkeypatch):
    """Les deux activés (incohérent) → TLS implicite prioritaire, STARTTLS coupé."""
    from app.services import email

    monkeypatch.setattr(email.settings, "SMTP_USE_TLS", True)
    monkeypatch.setattr(email.settings, "SMTP_STARTTLS", True)
    use_tls, start_tls = email._resolve_tls()
    assert use_tls is True
    assert start_tls is False


# --------------------------------------------------------------------------
# send_email : transport / transport
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_email_passes_start_tls(monkeypatch):
    """send_email transmet bien start_tls=True sur le port 587 à aiosmtplib."""
    from app.services import email

    captured = {}

    async def fake_send(msg, **kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(email.settings, "SMTP_HOST", "smtp.example.test")
    monkeypatch.setattr(email.settings, "SMTP_PORT", 587)
    monkeypatch.setattr(email.settings, "SMTP_USE_TLS", False)
    monkeypatch.setattr(email.settings, "SMTP_STARTTLS", True)
    monkeypatch.setattr(email.aiosmtplib, "send", fake_send)

    await email.send_email("dest@example.test", "Sujet", "Corps")

    assert captured["start_tls"] is True
    assert captured["use_tls"] is False
    assert captured["port"] == 587


@pytest.mark.asyncio
async def test_send_email_wraps_transport_error(monkeypatch):
    """Une erreur de transport est encapsulée en EmailError (jamais propagée brute)."""
    from app.services import email

    async def boom(msg, **kwargs):
        raise ConnectionRefusedError("connexion refusée")

    monkeypatch.setattr(email.settings, "SMTP_HOST", "smtp.example.test")
    monkeypatch.setattr(email.aiosmtplib, "send", boom)

    with pytest.raises(email.EmailError):
        await email.send_email("dest@example.test", "Sujet", "Corps")


@pytest.mark.asyncio
async def test_send_email_requires_config(monkeypatch):
    """SMTP_HOST vide → EmailError explicite."""
    from app.services import email

    monkeypatch.setattr(email.settings, "SMTP_HOST", "")
    with pytest.raises(email.EmailError):
        await email.send_email("dest@example.test", "Sujet", "Corps")


# --------------------------------------------------------------------------
# forgot-password : résilience / resilience
# --------------------------------------------------------------------------

@pytest_asyncio.fixture
async def public_client(db_session):
    """Client HTTP sans auth, rate limit désactivé, + un user actif dédié."""
    from httpx import ASGITransport, AsyncClient

    from app.main import app
    from app.models.user import User
    from app.utils.auth import hash_password

    sfx = uuid.uuid4().hex[:8]
    user = User(
        username=f"forgot_{sfx}",
        email=f"forgot-{sfx}@chaos.test",
        hashed_password=hash_password(f"Reset!Solide#{sfx}Xx"),
        is_active=True,
    )
    db_session.add(user)
    await db_session.commit()

    app.state.limiter.enabled = False
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, user
    app.state.limiter.enabled = True


@pytest.mark.asyncio
async def test_forgot_password_send_failure_returns_generic_200(public_client, monkeypatch):
    """Un échec d'envoi SMTP → 200 générique (ni 500, ni fuite d'existence)."""
    from app.api import auth
    from app.services.email import EmailError

    async def failing_send(**kwargs):
        raise EmailError("SMTP down")

    # SMTP considéré configuré + envoi qui échoue / SMTP configured but send fails
    monkeypatch.setattr(auth, "smtp_configured", lambda: True)
    monkeypatch.setattr(auth, "send_email", failing_send)

    ac, user = public_client
    resp = await ac.post("/api/auth/forgot-password", json={"email": user.email})
    assert resp.status_code == 200
    assert resp.json()["detail"] == "Si cette adresse existe, un email a été envoyé"


@pytest.mark.asyncio
async def test_forgot_password_unknown_email_returns_generic_200(public_client):
    """Email inconnu → même réponse générique (anti-énumération)."""
    ac, _ = public_client
    resp = await ac.post("/api/auth/forgot-password", json={"email": "inconnu@nowhere.test"})
    assert resp.status_code == 200
    assert resp.json()["detail"] == "Si cette adresse existe, un email a été envoyé"


@pytest.mark.asyncio
async def test_forgot_password_success_calls_send(public_client, monkeypatch):
    """Envoi OK → 200 et send_email appelé avec l'adresse du user."""
    from app.api import auth

    calls = {}

    async def ok_send(*, to, subject, body):
        calls["to"] = to

    monkeypatch.setattr(auth, "smtp_configured", lambda: True)
    monkeypatch.setattr(auth, "send_email", ok_send)

    ac, user = public_client
    resp = await ac.post("/api/auth/forgot-password", json={"email": user.email})
    assert resp.status_code == 200
    assert calls["to"] == user.email
