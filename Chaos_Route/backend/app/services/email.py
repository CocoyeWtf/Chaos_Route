"""
Service d'envoi d'emails / Email sending service.

Point unique d'envoi SMTP (reset de mot de passe et futures notifications).
Résout correctement le mode TLS pour éviter le bug historique « TLS implicite
sur le port 587 » : le port 587 (submission) exige STARTTLS, pas le TLS
implicite (réservé au port 465).

Single SMTP entry point. Correctly resolves the TLS mode to avoid the historic
"implicit TLS on port 587" bug (587 requires STARTTLS, not implicit TLS).
"""

import logging
from email.message import EmailMessage

import aiosmtplib

from app.config import settings

logger = logging.getLogger("chaos_route.email")


class EmailError(RuntimeError):
    """Échec d'envoi ou configuration SMTP invalide / Send failure or invalid SMTP config."""


def smtp_configured() -> bool:
    """Le SMTP est-il configuré (host renseigné) ? / Is SMTP configured?"""
    return bool(settings.SMTP_HOST)


def _resolve_tls() -> tuple[bool, bool]:
    """Résoudre (use_tls, start_tls) de façon mutuellement exclusive.

    Resolve (use_tls, start_tls) as mutually exclusive.

    - use_tls  : TLS implicite dès la connexion (port 465).
    - start_tls: connexion en clair puis passage TLS via STARTTLS (port 587).

    aiosmtplib lève une erreur si les deux sont vrais ; on donne la priorité au
    TLS implicite et on désactive alors STARTTLS, en journalisant l'incohérence.
    """
    use_tls = settings.SMTP_USE_TLS
    start_tls = settings.SMTP_STARTTLS and not use_tls
    if settings.SMTP_USE_TLS and settings.SMTP_STARTTLS:
        logger.warning(
            "SMTP_USE_TLS et SMTP_STARTTLS sont tous deux activés (incompatibles) : "
            "TLS implicite retenu, STARTTLS ignoré. Vérifiez la configuration SMTP."
        )
    return use_tls, start_tls


async def send_email(to: str, subject: str, body: str) -> None:
    """Envoyer un email texte / Send a plain-text email.

    Raises:
        EmailError: SMTP non configuré ou échec d'envoi (avec cause d'origine).
    """
    if not smtp_configured():
        raise EmailError("SMTP non configuré (SMTP_HOST vide).")

    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    use_tls, start_tls = _resolve_tls()

    try:
        await aiosmtplib.send(
            msg,
            hostname=settings.SMTP_HOST,
            port=settings.SMTP_PORT,
            username=settings.SMTP_USER or None,
            password=settings.SMTP_PASSWORD or None,
            use_tls=use_tls,
            start_tls=start_tls,
            timeout=settings.SMTP_TIMEOUT,
        )
    except Exception as exc:  # aiosmtplib.* + erreurs réseau/TLS
        # Ne jamais journaliser le corps (peut contenir un lien/token) /
        # Never log the body (may contain a reset link/token).
        raise EmailError(
            f"Échec d'envoi SMTP vers {settings.SMTP_HOST}:{settings.SMTP_PORT} "
            f"(use_tls={use_tls}, start_tls={start_tls}) : {exc}"
        ) from exc
