#!/usr/bin/env python3
"""
Smoke-test SMTP / SMTP self-test.

À lancer après un déploiement pour valider la configuration email SANS passer
par le flux « mot de passe oublié ». Envoie un email de contrôle à l'adresse
fournie et affiche un diagnostic clair (mode TLS résolu, cause d'échec).

Usage (sur le serveur, dans le conteneur app) :
    docker compose exec app python -m scripts.smtp_selftest destinataire@exemple.fr

Sortie : code 0 si l'email part, code 1 sinon (utilisable en CI/déploiement).
"""

import asyncio
import sys

from app.config import settings
from app.services.email import EmailError, _resolve_tls, send_email, smtp_configured


async def _main(recipient: str) -> int:
    use_tls, start_tls = _resolve_tls()
    print("=== Configuration SMTP ===")
    print(f"  host      : {settings.SMTP_HOST or '(vide)'}")
    print(f"  port      : {settings.SMTP_PORT}")
    print(f"  user      : {settings.SMTP_USER or '(anonyme)'}")
    print(f"  from      : {settings.SMTP_FROM}")
    print(f"  use_tls   : {use_tls}  (TLS implicite / implicit TLS, port 465)")
    print(f"  start_tls : {start_tls}  (STARTTLS, port 587)")
    print(f"  timeout   : {settings.SMTP_TIMEOUT}s")
    print()

    if not smtp_configured():
        print("ÉCHEC : SMTP_HOST non configuré.")
        return 1

    print(f"Envoi d'un email de contrôle à {recipient} ...")
    try:
        await send_email(
            to=recipient,
            subject="Chaos RouteManager — Test SMTP",
            body="Ceci est un email de contrôle. Si vous le recevez, le SMTP est opérationnel.",
        )
    except EmailError as exc:
        print(f"ÉCHEC : {exc}")
        return 1

    print("OK : email accepté par le serveur SMTP.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python -m scripts.smtp_selftest destinataire@exemple.fr", file=sys.stderr)
        sys.exit(2)
    sys.exit(asyncio.run(_main(sys.argv[1])))
