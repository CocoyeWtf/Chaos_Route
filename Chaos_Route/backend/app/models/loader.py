"""Modèle Chargeur / Loader model."""

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.mixins import TenantMixin


class Loader(Base, TenantMixin):
    """Chargeur rattaché à une base / Loader linked to a logistics base."""
    __tablename__ = "loaders"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    base_id: Mapped[int] = mapped_column(ForeignKey("bases_logistics.id"), nullable=False)
    # Seconde base, facultative (#63) : les chargeurs de Gosselies SEC chargent
    # aussi pour Gosselies MEA. Rattacher plutôt que dupliquer la fiche évite
    # deux chargeurs portant le même code. /
    # Optional second base: one loader can serve two sites without duplicating.
    secondary_base_id: Mapped[int | None] = mapped_column(ForeignKey("bases_logistics.id"))
