"""
Configuration de l'application / Application configuration.
Utilise pydantic-settings pour charger depuis .env ou variables d'environnement.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Application
    APP_NAME: str = "Chaos RouteManager"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = True

    # Database - SQLite par défaut pour le développement
    # Database - SQLite by default for development
    DATABASE_URL: str = "sqlite+aiosqlite:///./chaos_route.db"

    # URL publique HTTPS (pour QR code, telechargement APK, etc.)
    # Public HTTPS URL (for QR code, APK download, etc.)
    PUBLIC_URL: str = "https://chaosroute.chaosmanager.tech"

    # CORS - origines autorisées / allowed origins
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://localhost:3000", "http://localhost:8081", "http://localhost:19006"]

    # Compte superadmin initial (seed au premier démarrage, base vide uniquement).
    # ADMIN_PASSWORD est OBLIGATOIRE sur base vide : sans lui, refus de démarrer
    # (plus de compte admin/admin par défaut — remédiation STIME A1).
    # Initial superadmin account (seeded on first start with an empty DB only).
    ADMIN_USERNAME: str = "admin"
    ADMIN_EMAIL: str = "admin@chaos-route.app"
    ADMIN_PASSWORD: str = ""

    # MFA (STIME B7) : exiger le TOTP pour les superadmins. Activer une fois
    # les comptes enrôlés (sinon blocage du login superadmin sans MFA).
    REQUIRE_MFA_SUPERADMIN: bool = False

    # JWT Authentication
    SECRET_KEY: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # SMTP (reset mot de passe / password reset)
    # Deux modes TLS mutuellement exclusifs / Two mutually exclusive TLS modes :
    #  - SMTP_USE_TLS=True  → TLS implicite dès la connexion (port 465).
    #  - SMTP_STARTTLS=True → connexion en clair puis STARTTLS (port 587, submission).
    # Le port 587 exige STARTTLS, PAS le TLS implicite : c'est le défaut correct.
    # (Implicit TLS on 587 fails the handshake — the historical bug.)
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "noreply@chaosmanager.tech"
    SMTP_USE_TLS: bool = False
    SMTP_STARTTLS: bool = True
    SMTP_TIMEOUT: int = 15

    # Rate Limiting
    RATE_LIMIT_LOGIN: str = "5/minute"
    RATE_LIMIT_REGISTER: str = "3/minute"
    RATE_LIMIT_GPS: str = "30/minute"
    RATE_LIMIT_DEFAULT: str = "60/minute"

    # Paramètres par défaut / Default parameters
    DEFAULT_COMMERCIAL_SPEED_KMH: float = 60.0
    DEFAULT_MAX_DAILY_HOURS: float = 10.0
    DEFAULT_BREAK_DURATION_MINUTES: int = 45

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
