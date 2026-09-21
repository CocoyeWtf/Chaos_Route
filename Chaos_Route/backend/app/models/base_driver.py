"""Modele Chauffeur Base / Base Driver model.

Chauffeurs employes par l'entreprise, rattaches a une base logistique.
Company-employed drivers, attached to a logistics base.
"""

import enum

from sqlalchemy import DateTime, Enum, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.mixins import TenantMixin


class DriverStatus(str, enum.Enum):
    """Statut du chauffeur / Driver status."""
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    ON_LEAVE = "ON_LEAVE"


class BaseDriver(Base, TenantMixin):
    """Chauffeur base / Company driver."""
    __tablename__ = "base_drivers"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # --- Identification ---
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    code_infolog: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)

    # --- Statut ---
    status: Mapped[DriverStatus] = mapped_column(
        Enum(DriverStatus), default=DriverStatus.ACTIVE
    )

    # --- Rattachement / Home base ---
    base_id: Mapped[int] = mapped_column(ForeignKey("bases_logistics.id"), nullable=False)

    # --- Régime de travail (#33) ---
    # Jours travaillés, en clair : « LUN,MAR,MER,JEU,VEN ». Vide ou absent =
    # semaine complète, pour ne rien changer aux chauffeurs déjà enregistrés.
    # Un contrat 4/5 se traduit simplement par un jour en moins dans la liste,
    # et l'ordonnancement peut alors signaler qu'on attribue une tournée à
    # quelqu'un qui ne travaille pas ce jour-là. /
    # Working days as plain text; empty means the full week.
    work_days: Mapped[str | None] = mapped_column(String(40))

    # --- Contact ---
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(150))

    # --- Notes ---
    notes: Mapped[str | None] = mapped_column(Text)

    # --- Audit ---
    created_at: Mapped[str | None] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[str | None] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # --- Relations ---
    base: Mapped["BaseLogistics"] = relationship()

    def __repr__(self) -> str:
        return f"<BaseDriver {self.code_infolog} — {self.last_name} {self.first_name}>"
