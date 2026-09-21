"""Schemas chauffeur base / Base Driver schemas."""

from pydantic import BaseModel, ConfigDict


class BaseDriverCreate(BaseModel):
    """Creation chauffeur base / Create base driver."""
    last_name: str
    first_name: str
    code_infolog: str
    status: str = "ACTIVE"
    base_id: int
    work_days: str | None = None   # « LUN,MAR,MER,JEU,VEN » — vide = semaine complète (#33)
    phone: str | None = None
    email: str | None = None
    notes: str | None = None


class BaseDriverUpdate(BaseModel):
    """Mise a jour chauffeur base / Update base driver."""
    last_name: str | None = None
    first_name: str | None = None
    code_infolog: str | None = None
    status: str | None = None
    base_id: int | None = None
    work_days: str | None = None   # « LUN,MAR,MER,JEU,VEN » — vide = semaine complète (#33)
    phone: str | None = None
    email: str | None = None
    notes: str | None = None


class BaseDriverRead(BaseModel):
    """Lecture chauffeur base / Read base driver."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    last_name: str
    first_name: str
    code_infolog: str
    status: str
    base_id: int
    work_days: str | None = None   # « LUN,MAR,MER,JEU,VEN » — vide = semaine complète (#33)
    phone: str | None = None
    email: str | None = None
    notes: str | None = None
