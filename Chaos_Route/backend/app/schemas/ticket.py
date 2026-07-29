"""Schémas Ticket / Ticket schemas."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.ticket import TicketType, TicketStatus, TicketPriority


class TicketCommentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int | None = None
    user_name: str | None = None
    body: str
    is_system: bool = False
    created_at: datetime | None = None


class TicketCommentCreate(BaseModel):
    body: str


class TicketCreate(BaseModel):
    title: str
    description: str | None = None
    ticket_type: TicketType = TicketType.BUG
    priority: TicketPriority = TicketPriority.MEDIUM
    # Contexte capturé côté client (route, version, navigateur, fil d'Ariane…) /
    # Client-captured context, serialized to JSON string server-side.
    context: dict | None = None


class TicketStatusUpdate(BaseModel):
    status: TicketStatus | None = None
    priority: TicketPriority | None = None


class TicketUpdate(BaseModel):
    """Modification par l'auteur (ou un admin) de son propre ticket / Author edit.

    Le statut n'est PAS modifiable ici (réservé aux admins via /status). Seuls le
    contenu et la classification saisis par l'auteur sont éditables.
    """
    title: str | None = None
    description: str | None = None
    ticket_type: TicketType | None = None
    priority: TicketPriority | None = None


class TicketRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ticket_type: TicketType
    status: TicketStatus
    priority: TicketPriority
    title: str
    description: str | None = None
    context: str | None = None
    created_by_user_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class TicketPhotoRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ticket_id: int
    filename: str
    file_size: int | None = None
    mime_type: str | None = None
    uploaded_at: str | None = None


class TicketDetail(TicketRead):
    comments: list[TicketCommentRead] = []
    photos: list[TicketPhotoRead] = []


class TicketListItem(TicketRead):
    """Élément de liste avec compteurs d'échanges et de photos / List item with counts."""
    comment_count: int = 0
    photo_count: int = 0
