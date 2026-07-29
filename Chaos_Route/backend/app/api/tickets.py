"""Routes Tickets / Ticket board API.

Board TRANSPARENT : tout utilisateur authentifié voit tous les tickets et tous
les échanges. Chaque action (création, commentaire, changement de statut) est
horodatée et attribuée → traçabilité complète (litige, bilan annuel).
"""

import io
import json
import re
import unicodedata
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_permission
from app.database import get_db
from app.models.ticket import Ticket, TicketComment, TicketPhoto, TicketStatus, TicketType, TicketPriority
from app.models.user import User
from app.schemas.ticket import (
    TicketCommentCreate, TicketCommentRead, TicketCreate, TicketDetail,
    TicketListItem, TicketPhotoRead, TicketStatusUpdate, TicketUpdate,
)

router = APIRouter()


def _user_has_permission(user: User, resource: str, action: str) -> bool:
    """L'utilisateur porte-t-il la permission resource:action ? (superadmin inclus).
    Réplique la logique de deps.require_permission pour un contrôle inline « auteur
    OU admin ». / Does the user hold resource:action? (superadmin bypasses)."""
    if user.is_superadmin:
        return True
    for role in user.roles:
        for perm in role.permissions:
            if perm.resource == resource and perm.action == action:
                return True
    return False


def _can_edit_ticket(user: User, ticket: Ticket) -> bool:
    """Auteur du ticket OU administrateur (tickets:update) / Ticket author OR admin."""
    return ticket.created_by_user_id == user.id or _user_has_permission(user, "tickets", "update")

# Stockage des photos de tickets (capture/illustration) / Ticket photo storage
TICKET_PHOTOS_DIR = Path("data/photos/tickets")
MAX_PHOTOS_PER_TICKET = 5
MAX_PHOTO_SIZE = 5 * 1024 * 1024  # 5 MB


def _user_name(user: User) -> str:
    return getattr(user, "full_name", None) or user.username


# ─── Export d'un ticket pour Claude Code / Ticket export helpers ───

def _slug(text: str | None, maxlen: int = 40) -> str:
    """Slug ASCII sûr pour un nom de fichier (translittère les accents)."""
    norm = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")
    norm = re.sub(r"[^a-zA-Z0-9]+", "-", norm).strip("-").lower()
    return norm[:maxlen].strip("-") or "ticket"


def _fmt_dt(value) -> str:
    """Formate une date (datetime ou ISO string) en lisible, sinon la renvoie telle quelle."""
    if not value:
        return "—"
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M")
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return str(value)


def _ticket_markdown(ticket: Ticket, photo_arcnames: list[tuple[str, TicketPhoto]]) -> str:
    """Construit un Markdown auto-suffisant du ticket, prêt à injecter dans Claude Code."""
    try:
        ctx = json.loads(ticket.context) if ticket.context else None
    except (json.JSONDecodeError, TypeError):
        ctx = None

    lines: list[str] = []
    lines.append(f"# Ticket #{ticket.id} — {ticket.title}")
    lines.append("")
    lines.append(f"- **Type** : {ticket.ticket_type.value}")
    lines.append(f"- **Statut** : {ticket.status.value}")
    lines.append(f"- **Priorité** : {ticket.priority.value}")
    lines.append(f"- **Auteur** : {ticket.created_by_name or '—'}")
    lines.append(f"- **Créé le** : {_fmt_dt(ticket.created_at)}")
    lines.append(f"- **Mis à jour** : {_fmt_dt(ticket.updated_at)}")
    lines.append("")
    lines.append("## Description")
    lines.append("")
    lines.append(ticket.description.strip() if ticket.description else "_(aucune description)_")
    lines.append("")

    if ctx:
        lines.append("## Contexte technique capturé")
        lines.append("")
        labels = {
            "route": "Écran", "app_version": "Version app", "platform": "Plateforme",
            "language": "Langue", "screen": "Résolution", "user_agent": "Navigateur / OS",
        }
        for key, label in labels.items():
            if ctx.get(key):
                lines.append(f"- **{label}** : {ctx[key]}")
        breadcrumb = ctx.get("breadcrumb")
        if isinstance(breadcrumb, list) and breadcrumb:
            trail = " → ".join(b.get("path", str(b)) if isinstance(b, dict) else str(b) for b in breadcrumb)
            lines.append(f"- **Parcours (fil d'Ariane)** : {trail}")
        errors = ctx.get("recent_errors")
        if isinstance(errors, list) and errors:
            lines.append("- **Erreurs récentes (console)** :")
            for err in errors:
                lines.append(f"  - `{err}`")
        # Toute clé de contexte non listée ci-dessus (robustesse aux évolutions)
        known = set(labels) | {"breadcrumb", "recent_errors", "session"}
        for key, val in ctx.items():
            if key not in known and val not in (None, "", [], {}):
                lines.append(f"- **{key}** : {val}")
        lines.append("")

        # Déroulé de la session (dashcam) : ce que l'utilisateur a fait juste avant
        # le signalement — clics, saisies masquées, navigation, erreurs, échecs
        # réseau, notes épinglées. / Session timeline (dashcam) before the report.
        session = ctx.get("session")
        if isinstance(session, list) and session:
            type_label = {
                "route": "🧭 écran", "click": "🖱️ clic", "input": "⌨️ saisie",
                "network": "🌐 réseau", "error": "❌ erreur", "note": "📌 note",
            }
            lines.append("## Déroulé de la session (dashcam, avant le signalement)")
            lines.append("")
            for ev in session:
                if not isinstance(ev, dict):
                    continue
                lbl = type_label.get(ev.get("type", ""), ev.get("type", ""))
                lines.append(f"- **t-{ev.get('ago_s')}s** · {lbl} — {ev.get('msg', '')}")
            lines.append("")

    if photo_arcnames:
        lines.append("## Captures d'écran")
        lines.append("")
        for arc, photo in photo_arcnames:
            lines.append(f"### {photo.filename}")
            lines.append("")
            lines.append(f"![{photo.filename}]({arc})")
            lines.append("")

    comments = list(ticket.comments or [])
    if comments:
        lines.append("## Historique des échanges")
        lines.append("")
        for c in comments:
            when = _fmt_dt(c.created_at)
            if c.is_system:
                lines.append(f"- _{when} — {c.body}_")
            else:
                lines.append(f"- **{when} · {c.user_name or 'Utilisateur'}** : {c.body}")
        lines.append("")

    return "\n".join(lines)


def _ticket_json(ticket: Ticket, photo_arcnames: list[tuple[str, TicketPhoto]]) -> str:
    """Représentation brute structurée du ticket (JSON) incluse dans l'archive."""
    try:
        ctx = json.loads(ticket.context) if ticket.context else None
    except (json.JSONDecodeError, TypeError):
        ctx = ticket.context
    arc_by_id = {photo.id: arc for arc, photo in photo_arcnames}
    payload = {
        "id": ticket.id,
        "type": ticket.ticket_type.value,
        "status": ticket.status.value,
        "priority": ticket.priority.value,
        "title": ticket.title,
        "description": ticket.description,
        "created_by": ticket.created_by_name,
        "created_at": _fmt_dt(ticket.created_at),
        "updated_at": _fmt_dt(ticket.updated_at),
        "context": ctx,
        "photos": [
            {"id": p.id, "filename": p.filename, "mime_type": p.mime_type,
             "file_size": p.file_size, "archive_path": arc_by_id.get(p.id)}
            for p in (ticket.photos or [])
        ],
        "comments": [
            {"at": _fmt_dt(c.created_at), "author": c.user_name,
             "is_system": c.is_system, "body": c.body}
            for c in (ticket.comments or [])
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


@router.get("/", response_model=list[TicketListItem])
async def list_tickets(
    status: TicketStatus | None = Query(None),
    ticket_type: TicketType | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Lister TOUS les tickets (transparent) avec nb d'échanges / List all tickets."""
    count_sq = (
        select(TicketComment.ticket_id, func.count(TicketComment.id).label("cnt"))
        .group_by(TicketComment.ticket_id)
        .subquery()
    )
    photo_sq = (
        select(TicketPhoto.ticket_id, func.count(TicketPhoto.id).label("pcnt"))
        .group_by(TicketPhoto.ticket_id)
        .subquery()
    )
    query = (
        select(Ticket, func.coalesce(count_sq.c.cnt, 0), func.coalesce(photo_sq.c.pcnt, 0))
        .outerjoin(count_sq, count_sq.c.ticket_id == Ticket.id)
        .outerjoin(photo_sq, photo_sq.c.ticket_id == Ticket.id)
        .order_by(Ticket.created_at.desc())
    )
    if status is not None:
        query = query.where(Ticket.status == status)
    if ticket_type is not None:
        query = query.where(Ticket.ticket_type == ticket_type)

    result = await db.execute(query)
    items: list[TicketListItem] = []
    for ticket, cnt, pcnt in result.all():
        item = TicketListItem.model_validate(ticket)
        item.comment_count = int(cnt or 0)
        item.photo_count = int(pcnt or 0)
        items.append(item)
    return items


@router.get("/{ticket_id}", response_model=TicketDetail)
async def get_ticket(
    ticket_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Détail d'un ticket + tous les échanges (visible par tous) / Ticket detail."""
    result = await db.execute(
        select(Ticket).where(Ticket.id == ticket_id).options(
            selectinload(Ticket.comments), selectinload(Ticket.photos)
        )
    )
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return ticket


@router.get("/{ticket_id}/export")
async def export_ticket(
    ticket_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Exporter un ticket en archive ZIP auto-suffisante pour Claude Code.

    L'archive `ticket-{id}-{slug}.zip` contient :
      - `ticket-{id}.md`  : ticket complet en Markdown (description, contexte
        technique, historique des échanges, captures référencées) ;
      - `ticket-{id}.json`: données brutes structurées ;
      - `photos/…`        : les captures d'écran jointes.
    Il suffit de dézipper et d'ouvrir le dossier dans Claude Code pour résolution.
    """
    result = await db.execute(
        select(Ticket).where(Ticket.id == ticket_id).options(
            selectinload(Ticket.comments), selectinload(Ticket.photos)
        )
    )
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    buf = io.BytesIO()
    photo_arcnames: list[tuple[str, TicketPhoto]] = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for idx, photo in enumerate(ticket.photos or [], start=1):
            src = Path(photo.file_path)
            if not src.is_file():
                continue
            ext = src.suffix or "." + (photo.mime_type or "image/jpeg").split("/")[-1].replace("jpeg", "jpg")
            arc = f"photos/{idx:02d}-{_slug(Path(photo.filename).stem, 30)}{ext}"
            zf.write(src, arc)
            photo_arcnames.append((arc, photo))
        zf.writestr(f"ticket-{ticket.id}.md", _ticket_markdown(ticket, photo_arcnames))
        zf.writestr(f"ticket-{ticket.id}.json", _ticket_json(ticket, photo_arcnames))
    buf.seek(0)

    filename = f"ticket-{ticket.id}-{_slug(ticket.title)}.zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/", response_model=TicketDetail, status_code=201)
async def create_ticket(
    data: TicketCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Créer un ticket (avec contexte capturé) / Create a ticket with captured context."""
    ticket = Ticket(
        ticket_type=data.ticket_type,
        priority=data.priority,
        status=TicketStatus.OPEN,
        title=data.title,
        description=data.description,
        context=json.dumps(data.context, ensure_ascii=False) if data.context else None,
        created_by_user_id=user.id,
        created_by_name=_user_name(user),
    )
    db.add(ticket)
    await db.flush()
    # Événement système d'ouverture (trace) / Opening system event (trace)
    db.add(TicketComment(
        ticket_id=ticket.id, user_id=user.id, user_name=_user_name(user),
        body=f"Ticket ouvert par {_user_name(user)}.", is_system=True,
    ))
    await db.flush()
    result = await db.execute(
        select(Ticket).where(Ticket.id == ticket.id).options(
            selectinload(Ticket.comments), selectinload(Ticket.photos)
        )
    )
    return result.scalar_one()


# ─── Photos / captures d'écran jointes au ticket / Ticket photos ───

@router.post("/{ticket_id}/photos", response_model=TicketPhotoRead, status_code=201)
async def upload_ticket_photo(
    ticket_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Joindre une photo / capture d'écran à un ticket (illustre le problème).

    Ouvert à tout utilisateur authentifié, comme la création de ticket et les
    échanges (board transparent). Image uniquement, 5 Mo max, 5 photos max.
    """
    ticket = await db.get(Ticket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    result = await db.execute(
        select(func.count(TicketPhoto.id)).where(TicketPhoto.ticket_id == ticket_id)
    )
    if (result.scalar() or 0) >= MAX_PHOTOS_PER_TICKET:
        raise HTTPException(status_code=400, detail=f"Max {MAX_PHOTOS_PER_TICKET} photos par ticket")

    content = await file.read()
    if len(content) > MAX_PHOTO_SIZE:
        raise HTTPException(status_code=400, detail="Photo trop volumineuse (max 5 Mo)")

    mime = file.content_type or "image/jpeg"
    if not mime.startswith("image/"):
        raise HTTPException(status_code=400, detail="Seules les images sont acceptées")

    # Nom de fichier sûr (UUID) — aucune entrée utilisateur dans le chemin /
    # Safe UUID filename — no user input in the path (anti path-traversal)
    ext = mime.split("/")[-1].replace("jpeg", "jpg").replace("svg+xml", "svg")
    unique_name = f"{uuid.uuid4().hex[:12]}.{ext}"
    photo_dir = TICKET_PHOTOS_DIR / str(ticket_id)
    photo_dir.mkdir(parents=True, exist_ok=True)
    file_path = photo_dir / unique_name
    file_path.write_bytes(content)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    photo = TicketPhoto(
        ticket_id=ticket_id,
        filename=file.filename or unique_name,
        file_path=str(file_path),
        file_size=len(content),
        mime_type=mime,
        uploaded_at=now,
    )
    db.add(photo)
    # Trace : photo jointe (événement système) / system event for the audit trail
    db.add(TicketComment(
        ticket_id=ticket_id, user_id=user.id, user_name=_user_name(user),
        body=f"{_user_name(user)} a joint une photo.", is_system=True,
    ))
    await db.flush()
    await db.refresh(photo)
    return photo


@router.get("/{ticket_id}/photos/{photo_id}")
async def download_ticket_photo(
    ticket_id: int,
    photo_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Télécharger / afficher une photo de ticket / Download a ticket photo."""
    photo = await db.get(TicketPhoto, photo_id)
    if not photo or photo.ticket_id != ticket_id:
        raise HTTPException(status_code=404, detail="Photo not found")
    if not Path(photo.file_path).is_file():
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    return FileResponse(
        photo.file_path,
        media_type=photo.mime_type or "image/jpeg",
        filename=photo.filename,
    )


@router.post("/{ticket_id}/comments", response_model=TicketCommentRead, status_code=201)
async def add_comment(
    ticket_id: int,
    data: TicketCommentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Ajouter un échange (visible par tous) / Add an exchange (visible to all)."""
    ticket = await db.get(Ticket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if not data.body.strip():
        raise HTTPException(status_code=422, detail="Message vide")
    comment = TicketComment(
        ticket_id=ticket_id, user_id=user.id, user_name=_user_name(user),
        body=data.body.strip(), is_system=False,
    )
    db.add(comment)
    await db.flush()
    await db.refresh(comment)
    return comment


@router.put("/{ticket_id}", response_model=TicketDetail)
async def update_ticket(
    ticket_id: int,
    data: TicketUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Modifier son propre ticket (titre, description, type, priorité).

    Autorisé à l'AUTEUR du ticket ou à un admin (tickets:update). Le statut n'est
    pas modifiable ici (réservé aux admins via /status). Chaque modification est
    tracée comme événement système. / Edit own ticket; author or admin only."""
    ticket = await db.get(Ticket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if not _can_edit_ticket(user, ticket):
        raise HTTPException(status_code=403, detail="Seul l'auteur ou un administrateur peut modifier ce ticket")

    changes: list[str] = []
    if data.title is not None and data.title.strip() and data.title.strip() != ticket.title:
        ticket.title = data.title.strip()
        changes.append("titre")
    if data.description is not None and (data.description or None) != ticket.description:
        ticket.description = data.description or None
        changes.append("description")
    if data.ticket_type is not None and data.ticket_type != ticket.ticket_type:
        changes.append(f"type : {ticket.ticket_type.value} → {data.ticket_type.value}")
        ticket.ticket_type = data.ticket_type
    if data.priority is not None and data.priority != ticket.priority:
        changes.append(f"priorité : {ticket.priority.value} → {data.priority.value}")
        ticket.priority = data.priority

    if changes:
        db.add(TicketComment(
            ticket_id=ticket.id, user_id=user.id, user_name=_user_name(user),
            body=f"{_user_name(user)} a modifié le ticket ({', '.join(changes)}).", is_system=True,
        ))
    await db.flush()
    result = await db.execute(
        select(Ticket).where(Ticket.id == ticket.id).options(
            selectinload(Ticket.comments), selectinload(Ticket.photos)
        )
    )
    return result.scalar_one()


@router.delete("/{ticket_id}", status_code=204)
async def delete_ticket(
    ticket_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Supprimer son propre ticket / Delete own ticket.

    Autorisé à l'AUTEUR du ticket ou à un admin (tickets:update). La suppression
    entraîne en cascade celle des échanges et des photos (relation ORM). Les
    fichiers image sur disque sont retirés au passage (best-effort)."""
    ticket = await db.execute(
        select(Ticket).where(Ticket.id == ticket_id).options(selectinload(Ticket.photos))
    )
    ticket = ticket.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if not _can_edit_ticket(user, ticket):
        raise HTTPException(status_code=403, detail="Seul l'auteur ou un administrateur peut supprimer ce ticket")

    # Retirer les fichiers image du disque avant la suppression ORM (best-effort) /
    # Remove image files from disk before ORM delete (best-effort).
    for photo in (ticket.photos or []):
        try:
            p = Path(photo.file_path)
            if p.is_file():
                p.unlink()
        except OSError:
            pass

    await db.delete(ticket)
    await db.flush()
    return Response(status_code=204)


@router.put("/{ticket_id}/status", response_model=TicketDetail)
async def update_status(
    ticket_id: int,
    data: TicketStatusUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tickets", "update")),
):
    """Changer statut/priorité — RÉSERVÉ admin (tickets:update ; superadmin inclus).
    Tracé comme événement système. / Status/priority change restricted to admins."""
    # Charger SANS les commentaires (sinon la collection en cache ne refléterait
    # pas l'événement système ajouté ci-dessous au moment du rechargement). /
    # Load without comments so the freshly-added system event is visible on reload.
    ticket = await db.get(Ticket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    changes: list[str] = []
    if data.status is not None and data.status != ticket.status:
        changes.append(f"statut : {ticket.status.value} → {data.status.value}")
        ticket.status = data.status
    if data.priority is not None and data.priority != ticket.priority:
        changes.append(f"priorité : {ticket.priority.value} → {data.priority.value}")
        ticket.priority = data.priority

    if changes:
        db.add(TicketComment(
            ticket_id=ticket.id, user_id=user.id, user_name=_user_name(user),
            body=f"{_user_name(user)} a modifié le {' ; '.join(changes)}.", is_system=True,
        ))
    await db.flush()
    result = await db.execute(
        select(Ticket).where(Ticket.id == ticket.id).options(
            selectinload(Ticket.comments), selectinload(Ticket.photos)
        )
    )
    return result.scalar_one()
