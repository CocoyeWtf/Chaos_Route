"""
Utilitaires d'authentification / Authentication utilities.
Hashing de mots de passe et gestion des tokens JWT.
Password hashing and JWT token management.
"""

import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from jwt import InvalidTokenError

from app.config import settings

# Constantes des ressources et actions / Resource and action constants
RESOURCES = [
    "dashboard",
    "countries",
    "bases",
    "pdvs",
    "suppliers",
    "volumes",
    "contracts",
    "distances",
    "base-activities",
    "parameters",
    # Prix carburant : ressource à part (#24). Elle relevait de « parameters »,
    # qui ouvre aussi les paramètres généraux ET le journal d'audit : donner
    # l'accès aux prix du carburant à un rôle d'exploitation lui donnait bien
    # plus que demandé. / Fuel prices: own resource, was lumped with settings.
    "fuel-prices",
    "tour-planning",
    "tour-history",
    "operations",
    "guard-post",
    "imports-exports",
    "users",
    "roles",
    "loaders",
    "devices",
    "tracking",
    "support-types",
    "pickup-requests",
    "aide-decision",
    "surcharges",
    "surcharge-types",
    "declarations",
    "vehicles",
    "inspections",
    "fleet",
    "reports",
    "consignment-movements",
    "carriers",
    "waybill-archives",
    "pdv-stock",
    "base-container-stock",
    "supplier-pickups",
    "collection-requests",
    "temperature",
    "booking-appros",
    "booking-gate",
    "booking-reception",
    "cnuf-temperatures",
    "beer-consignments",
    "container-anomalies",
    "bottle-sorting",
    "base-drivers",
    "tour-stop-modify",
    "tour-unschedule",  # Retirer la planification d'un tour (transport, pas le postier)
    "consolidation",  # Multi-tenance : lève le cloisonnement tenant (lecture multi-société)
]
ACTIONS = ["read", "create", "update", "delete"]


def hash_password(password: str) -> str:
    """Hasher un mot de passe / Hash a password."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Vérifier un mot de passe / Verify a password."""
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))


def create_access_token(user_id: int) -> str:
    """Créer un access token JWT / Create a JWT access token.

    Porte un `jti` unique pour permettre la révocation serveur (STIME A4).
    """
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": str(user_id), "type": "access", "exp": expire, "jti": uuid.uuid4().hex}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_refresh_token(user_id: int) -> str:
    """Créer un refresh token JWT / Create a JWT refresh token (avec jti révocable)."""
    expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {"sub": str(user_id), "type": "refresh", "exp": expire, "jti": uuid.uuid4().hex}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_mfa_token(user_id: int) -> str:
    """Jeton intermédiaire MFA (5 min, usage unique via jti) / Interim MFA token (STIME B7)."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=5)
    payload = {"sub": str(user_id), "type": "mfa", "exp": expire, "jti": uuid.uuid4().hex}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_reset_token(user_id: int) -> str:
    """Créer un token de réinitialisation mot de passe (15 min) / Create a password reset token."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=15)
    payload = {"sub": str(user_id), "type": "reset", "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> dict | None:
    """Décoder un token JWT / Decode a JWT token. Returns None if invalid."""
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    except InvalidTokenError:
        return None
