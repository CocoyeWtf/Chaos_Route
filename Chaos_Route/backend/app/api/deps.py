"""
Dépendances d'authentification et d'autorisation / Authentication and authorization dependencies.
Injectées dans les routes via Depends().
"""

from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, set_session_tenant
from app.models.device_assignment import DeviceAssignment
from app.models.mobile_device import MobileDevice
from app.models.tenant import DEFAULT_TENANT_ID
from app.models.user import User
from app.utils.auth import decode_token

# Permission spéciale levant le cloisonnement tenant (lecture multi-société) /
# Special permission lifting tenant isolation (cross-company read).
CONSOLIDATION_RESOURCE = "consolidation"
CONSOLIDATION_ACTION = "read"

# auto_error=False : le jeton peut aussi venir du cookie HttpOnly (web, STIME A4)
security = HTTPBearer(auto_error=False)

# Chemins accessibles quand le changement de mot de passe est obligatoire /
# Paths reachable while a password change is required.
_MUST_CHANGE_PASSWORD_EXEMPT_PATHS = frozenset({
    "/api/auth/me",
    "/api/auth/change-password",
    "/api/auth/logout",
})


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Extraire et valider l'utilisateur depuis le JWT / Extract and validate user from JWT.

    Jeton accepté depuis le header Authorization (mobile/API) ou le cookie
    HttpOnly `access_token` (web, STIME A4). Les jetons révoqués (logout)
    sont refusés.
    """
    raw_token = credentials.credentials if credentials else request.cookies.get("access_token")
    if not raw_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    payload = decode_token(raw_token)
    if payload is None or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    # Révocation serveur (logout) / Server-side revocation (logout)
    from app.services.token_revocation import is_revoked
    if await is_revoked(db, payload.get("jti")):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")

    user_id = int(payload["sub"])
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    # Compte avec rotation de mot de passe imposée (ex. superadmin seedé) :
    # bloquer tout sauf la consultation du profil et le changement de mot de passe /
    # Forced password rotation: block everything but profile read and password change.
    if user.must_change_password and request.url.path not in _MUST_CHANGE_PASSWORD_EXEMPT_PATHS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Changement de mot de passe requis avant toute autre action",
        )

    # Positionner le tenant courant sur la session : toutes les requêtes suivantes
    # de cette requête HTTP seront filtrées automatiquement (None = pas de filtre,
    # pour superadmin / rôle consolidation) / Set current tenant on the session.
    set_session_tenant(db, get_user_tenant_id(user))
    # Acteur pour l'audit ORM généralisé (STIME A5) / Actor for the generic audit trail
    db.info["actor"] = user.username

    return user


def user_can_consolidate(user: User) -> bool:
    """L'utilisateur a-t-il le droit de consolidation multi-société ? /
    May the user read across tenants?

    Superadmin ou rôle portant la permission `consolidation:read`.
    """
    if user.is_superadmin:
        return True
    for role in user.roles:
        for perm in role.permissions:
            if perm.resource == CONSOLIDATION_RESOURCE and perm.action == CONSOLIDATION_ACTION:
                return True
    return False


def get_user_tenant_id(user: User) -> int | None:
    """Tenant à appliquer pour cet utilisateur / Tenant to enforce for this user.

    - None  = aucun filtre (superadmin ou rôle « consolidation groupe ») → accès
      multi-société, à journaliser à l'audit côté endpoints sensibles.
    - sinon = le tenant de l'utilisateur (tenant par défaut/Belgique si non assigné).
    """
    if user_can_consolidate(user):
        return None
    return user.tenant_id or DEFAULT_TENANT_ID


async def require_superadmin(user: User = Depends(get_current_user)) -> User:
    """Réserver l'accès aux superadmins / Restrict access to superadmins.

    Utilisé pour les opérations transverses au cloisonnement tenant (ex. lister
    les sociétés, affecter un utilisateur à un tenant).
    """
    if not user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Réservé aux superadmins",
        )
    return user


def require_permission(resource: str, action: str):
    """Factory de dépendance qui vérifie une permission / Dependency factory that checks a permission.

    Superadmin bypass toutes les permissions / Superadmin bypasses all permissions.
    """

    async def _check(user: User = Depends(get_current_user)) -> User:
        if user.is_superadmin:
            return user

        for role in user.roles:
            for perm in role.permissions:
                if perm.resource == resource and perm.action == action:
                    return user

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permission required: {resource}:{action}",
        )

    return _check


async def get_authenticated_device(
    x_device_id: str = Header(..., alias="X-Device-ID"),
    x_app_version: str | None = Header(None, alias="X-App-Version"),
    x_app_build: str | None = Header(None, alias="X-App-Build"),
    x_os_version: str | None = Header(None, alias="X-OS-Version"),
    db: AsyncSession = Depends(get_db),
) -> MobileDevice:
    """Authentifier un appareil mobile via son UUID / Authenticate a mobile device via its UUID.

    Le telephone envoie son device_identifier dans le header X-Device-ID.
    Met a jour automatiquement app_version, os_version, last_seen_at.
    """
    if not x_device_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing X-Device-ID header")

    result = await db.execute(
        select(MobileDevice).where(MobileDevice.device_identifier == x_device_id)
    )
    device = result.scalar_one_or_none()

    if device is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown device")
    if not device.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Device deactivated")

    # Positionner le tenant de l'appareil sur la session : sans ça, les opérations
    # mobiles (scans, déclarations, GPS, événements…) tournaient en tenant=None →
    # écrites en tenant_id=NULL puis aspirées vers la Belgique (tenant 1) par le
    # backfill de démarrage, et lues sans cloisonnement. Une tablette appartient à
    # une société : tout son trafic est scopé à ce tenant. /
    # Set the device's tenant on the session (mobile ops were running tenant-less).
    set_session_tenant(db, device.tenant_id)
    # Acteur pour l'audit ORM généralisé (STIME A5) / Actor for the generic audit trail
    db.info["actor"] = f"device:{device.id}"

    # Auto-update tracabilite / Auto-update traceability fields
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    device.last_seen_at = now
    if x_app_version:
        device.app_version = x_app_version
    # Build natif (#14) : envoye par les apps a partir du build 15. Une valeur
    # illisible est ignoree plutot que de casser l'authentification de l'appareil. /
    # Native build, sent from build 15 on; an unreadable value is ignored.
    if x_app_build:
        try:
            device.app_build = int(x_app_build)
        except (TypeError, ValueError):
            pass
    if x_os_version:
        device.os_version = x_os_version

    return device


async def get_device_pdv(
    device: MobileDevice = Depends(get_authenticated_device),
) -> int:
    """PDV rattaché à la tablette / PDV bound to the tablet.

    Pour les tablettes magasin (sans login) : l'appareil porte un pdv_id et
    tout accès est scopé à ce PDV. 403 si l'appareil n'est pas lié à un PDV.
    """
    if not getattr(device, "pdv_id", None):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Appareil non rattaché à un PDV",
        )
    return device.pdv_id


async def require_device_tour_access(
    tour_id: int,
    device: MobileDevice = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
) -> MobileDevice:
    """Vérifier que l'appareil est assigné au tour / Verify device is assigned to the tour."""
    result = await db.execute(
        select(DeviceAssignment).where(
            DeviceAssignment.tour_id == tour_id,
            DeviceAssignment.device_id == device.id,
        ).limit(1)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Device not assigned to this tour")
    return device


def get_user_region_ids(user: User) -> list[int] | None:
    """Retourne les IDs de régions de l'utilisateur / Returns user's region IDs.

    None = pas de filtre (superadmin ou aucune région assignée) / no filter (superadmin or no regions assigned).
    """
    if user.is_superadmin:
        return None
    if not user.regions:
        return None
    return [r.id for r in user.regions]


def get_user_pdv_id(user: User) -> int | None:
    """Retourne le pdv_id si l'utilisateur est lié à un PDV / Returns pdv_id if user is linked to a PDV.

    None = pas de filtre (superadmin ou utilisateur non-PDV) / no filter (superadmin or non-PDV user).
    """
    if user.is_superadmin:
        return None
    return user.pdv_id


def enforce_pdv_scope(user: User, requested_pdv_id: int | None) -> int | None:
    """Force le pdv_id pour un utilisateur PDV / Force pdv_id for a PDV user.

    - Utilisateur PDV : ignore le pdv_id demandé, retourne toujours user.pdv_id
    - Utilisateur non-PDV : retourne le pdv_id demandé tel quel
    - Raises 403 si utilisateur PDV tente d'accéder à un autre PDV
    """
    user_pdv = get_user_pdv_id(user)
    if user_pdv is None:
        return requested_pdv_id
    if requested_pdv_id is not None and requested_pdv_id != user_pdv:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accès limité à votre PDV",
        )
    return user_pdv
