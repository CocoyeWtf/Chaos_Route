"""Page installation + enregistrement mobile / Mobile install + registration page.

Endpoint public (pas de JWT) : le chauffeur scanne le QR avec la camera native,
le navigateur s'ouvre sur cette page qui propose le telechargement de l'APK
et affiche le code d'enregistrement.
"""

import hashlib

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, FileResponse
from pathlib import Path

from app.config import settings

router = APIRouter()

# Dossier pour stocker l'APK / Directory for APK storage
APK_DIR = Path(__file__).resolve().parent.parent.parent / "apk"

# Cache de l'empreinte SHA-256 de l'APK (invalidé si mtime/taille changent) /
# APK SHA-256 fingerprint cache (invalidated on mtime/size change)
_apk_hash_cache: dict = {"mtime": None, "size": None, "sha256": None}


def _apk_sha256(apk_path: Path) -> str | None:
    """Empreinte SHA-256 de l'APK servi, pour vérification d'intégrité côté app.

    Permet à l'app de s'assurer que l'APK téléchargé est bien l'officiel (non
    altéré) avant de lancer l'installeur Android. Calculé par blocs + mis en cache.
    """
    try:
        st = apk_path.stat()
    except OSError:
        return None
    if (
        _apk_hash_cache["sha256"]
        and _apk_hash_cache["mtime"] == st.st_mtime
        and _apk_hash_cache["size"] == st.st_size
    ):
        return _apk_hash_cache["sha256"]
    h = hashlib.sha256()
    with open(apk_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    digest = h.hexdigest()
    _apk_hash_cache.update({"mtime": st.st_mtime, "size": st.st_size, "sha256": digest})
    return digest

# Version courante de l'app mobile / Current mobile app version
# Mettre a jour a chaque build APK / Update on each APK build
# IMPORTANT : build_number doit etre STRICTEMENT SUPERIEUR a celui dans l'APK sur le serveur
# pour declencher la mise a jour. Egal ou inferieur = pas de mise a jour.
APP_VERSION = "1.9.0"
APP_BUILD_NUMBER = 11

# Coupe-circuit auto-update / Auto-update kill switch.
# Mis a False en urgence : le build 11 (1.9.0) affiche un ecran blanc au demarrage.
# On ne force plus la mise a jour pour ne pas "bricker" les tablettes encore sur
# l'ancien build. A remettre a True une fois un build corrige (12) servi.
# Emergency kill switch: build 11 white-screens at launch — stop forcing updates.
FORCE_UPDATE = False


@router.get("/app/version")
async def get_app_version():
    """Version courante de l'app + URL telechargement / Current app version + download URL."""
    base_url = settings.PUBLIC_URL.rstrip("/")
    apk_file = APK_DIR / "cmro-driver.apk"
    apk_exists = apk_file.is_file()
    return {
        "version": APP_VERSION,
        "build_number": APP_BUILD_NUMBER,
        "download_url": f"{base_url}/app/download/cmro-driver.apk" if apk_exists else None,
        # Empreinte SHA-256 pour vérification d'intégrité de l'APK téléchargé /
        # SHA-256 for downloaded APK integrity check
        "sha256": _apk_sha256(apk_file) if apk_exists else None,
        "force_update": FORCE_UPDATE,
    }


@router.get("/app/setup/{registration_code}", response_class=HTMLResponse)
async def mobile_setup_page(registration_code: str, request: Request):
    """Page d'installation et enregistrement / Install and registration page."""
    # Toujours utiliser PUBLIC_URL (HTTPS) pour le telechargement APK
    # Always use PUBLIC_URL (HTTPS) for APK download
    base_url = settings.PUBLIC_URL.rstrip("/")
    apk_exists = (APK_DIR / "cmro-driver.apk").is_file()
    apk_url = f"{base_url}/app/download/cmro-driver.apk" if apk_exists else ""

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CMRO Driver — Installation</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a; color: #e5e5e5;
            min-height: 100vh; display: flex; justify-content: center; align-items: center;
            padding: 20px;
        }}
        .card {{
            background: #1a1a1a; border: 1px solid #333; border-radius: 16px;
            padding: 32px; max-width: 400px; width: 100%; text-align: center;
        }}
        .logo {{ font-size: 36px; font-weight: bold; color: #f97316; margin-bottom: 4px; }}
        .subtitle {{ font-size: 13px; color: #737373; margin-bottom: 24px; }}
        .step {{
            background: #2a2a2a; border-radius: 10px; padding: 16px; margin-bottom: 12px;
            text-align: left;
        }}
        .step-num {{
            display: inline-block; width: 24px; height: 24px; line-height: 24px;
            text-align: center; border-radius: 50%; background: #f97316;
            color: #fff; font-size: 12px; font-weight: 700; margin-right: 8px;
        }}
        .step-title {{ font-size: 14px; font-weight: 600; color: #e5e5e5; display: inline; }}
        .step-desc {{ font-size: 12px; color: #a3a3a3; margin-top: 6px; margin-left: 32px; }}
        .code-box {{
            background: #2a2a2a; border: 2px solid #f97316; border-radius: 12px;
            padding: 16px; margin: 20px 0;
        }}
        .code-label {{ font-size: 11px; color: #737373; text-transform: uppercase; letter-spacing: 1px; }}
        .code-value {{
            font-size: 32px; font-weight: 800; color: #f97316;
            letter-spacing: 6px; font-family: monospace; margin-top: 4px;
        }}
        .btn {{
            display: block; width: 100%; padding: 14px; border: none; border-radius: 10px;
            font-size: 16px; font-weight: 700; cursor: pointer; text-decoration: none;
            margin-bottom: 10px; text-align: center;
        }}
        .btn-primary {{ background: #f97316; color: #fff; }}
        .btn-secondary {{ background: transparent; border: 1px solid #333; color: #a3a3a3; }}
        .btn:active {{ opacity: 0.8; }}
        .no-apk {{ font-size: 12px; color: #ef4444; margin-bottom: 12px; }}
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">CMRO</div>
        <div class="subtitle">Chaos Manager Route Optimizer — Driver</div>

        <div class="step">
            <span class="step-num">1</span>
            <span class="step-title">Installer l'application</span>
            <div class="step-desc">Telecharger et installer l'app CMRO Driver sur ce telephone.</div>
        </div>

        {'<a href="' + apk_url + '" class="btn btn-primary" download="cmro-driver.apk">Telecharger CMRO Driver</a>' if apk_exists else '<div class="no-apk">APK non disponible — contactez votre administrateur</div>'}

        <div class="step">
            <span class="step-num">2</span>
            <span class="step-title">Enregistrer l'appareil</span>
            <div class="step-desc">Ouvrir l'app et saisir le code ci-dessous.</div>
        </div>

        <div class="code-box">
            <div class="code-label">Code d'enregistrement</div>
            <div class="code-value">{registration_code}</div>
        </div>

        <div class="step">
            <span class="step-num">3</span>
            <span class="step-title">C'est pret !</span>
            <div class="step-desc">Le postier valide l'enregistrement et vous etes operationnel.</div>
        </div>
    </div>
</body>
</html>"""


@router.get("/app/download/{filename}")
async def download_apk(filename: str):
    """Telechargement de l'APK / APK download."""
    # Sanitiser le filename pour eviter path traversal / Sanitize filename to prevent path traversal
    safe_name = Path(filename).name
    if safe_name != filename or ".." in filename:
        return HTMLResponse("<h1>Invalid filename</h1>", status_code=400)
    file_path = APK_DIR / safe_name
    if not file_path.is_file():
        return HTMLResponse("<h1>Fichier non disponible</h1>", status_code=404)
    return FileResponse(
        file_path,
        media_type="application/vnd.android.package-archive",
        filename=safe_name,
    )
