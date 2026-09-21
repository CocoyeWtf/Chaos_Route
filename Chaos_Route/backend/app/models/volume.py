"""Modèle Volume / Volume model (commandes PDV)."""

import enum

from sqlalchemy import Boolean, Date, Enum, ForeignKey, Index, Integer, Numeric, String, inspect as sa_inspect
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.mixins import TenantMixin


class TemperatureClass(str, enum.Enum):
    """Classe de température / Temperature class."""
    SEC = "SEC"
    FRAIS = "FRAIS"
    GEL = "GEL"


class Volume(Base, TenantMixin):
    __tablename__ = "volumes"
    __table_args__ = (
        Index("ix_volumes_pdv_date", "pdv_id", "date"),
        Index("ix_volumes_base_date", "base_origin_id", "date"),
        Index("ix_volumes_tour_id", "tour_id"),
        # Les vues de planification filtrent sur la date de repartition a chaque
        # chargement (#83) / Planning views filter on dispatch_date on every load.
        Index("ix_volumes_dispatch_date", "dispatch_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    pdv_id: Mapped[int] = mapped_column(ForeignKey("pdvs.id"), nullable=False)
    date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD
    nb_colis: Mapped[int | None] = mapped_column(Integer, nullable=True)
    eqp_count: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    weight_kg: Mapped[float | None] = mapped_column(Numeric(10, 2))
    temperature_class: Mapped[TemperatureClass] = mapped_column(Enum(TemperatureClass), nullable=False)
    base_origin_id: Mapped[int] = mapped_column(ForeignKey("bases_logistics.id"), nullable=False)
    preparation_start: Mapped[str | None] = mapped_column(String(16))  # YYYY-MM-DDTHH:MM
    preparation_end: Mapped[str | None] = mapped_column(String(16))  # YYYY-MM-DDTHH:MM
    dispatch_date: Mapped[str | None] = mapped_column(String(10))   # YYYY-MM-DD — date de répartition
    dispatch_time: Mapped[str | None] = mapped_column(String(5))    # HH:MM — heure de répartition
    tour_id: Mapped[int | None] = mapped_column(ForeignKey("tours.id", ondelete="SET NULL"), nullable=True)

    # Volume total en m3 et nombre de supports/palettes (import SUPERLOG)
    # Total volume in m3 and number of supports/pallets (SUPERLOG import)
    volume_m3: Mapped[float | None] = mapped_column(Numeric(10, 4), nullable=True)
    nb_supports: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Activité : suivi (fond de rayon) ou mise en avant (promo) / Activity type
    activity_type: Mapped[str | None] = mapped_column(String(10))  # 'SUIVI' | 'MEAV'
    # Date début promo (MEAV uniquement) / Promo start date (MEAV only)
    promo_start_date: Mapped[str | None] = mapped_column(String(10))  # YYYY-MM-DD
    # Groupe de split — volumes issus du même original / Split group — volumes from same original
    split_group_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Reste à quai (ticket #68) : marchandise annoncée mais non chargée, remise à
    # disposition pour une tournée suivante. Le code de la tournée d'origine est
    # conservé pour la traçabilité — volontairement comme un simple texte et non
    # une clé étrangère, pour qu'une suppression de tournée ne bute pas dessus et
    # que la trace survive à la tournée. /
    # Left-at-dock goods, put back into the pool; the origin tour code is kept as
    # plain text so the trace outlives the tour and never blocks its deletion.
    is_raq: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    raq_from_tour_code: Mapped[str | None] = mapped_column(String(30))

    # Relations
    pdv: Mapped["PDV"] = relationship(back_populates="volumes")
    base_origin: Mapped["BaseLogistics"] = relationship()
    tour: Mapped["Tour | None"] = relationship()

    # Code/nom du PDV exposés directement sur le volume (= numéro de PDV métier).
    # Sûrs en async : renvoient None si la relation `pdv` n'a pas été chargée
    # (eager via selectinload dans l'endpoint liste), évitant tout lazy-load. /
    # PDV code/name surfaced on the volume; None if `pdv` not eagerly loaded.
    @property
    def pdv_code(self) -> str | None:
        if "pdv" in sa_inspect(self).unloaded:
            return None
        return self.pdv.code if self.pdv else None

    @property
    def pdv_name(self) -> str | None:
        if "pdv" in sa_inspect(self).unloaded:
            return None
        return self.pdv.name if self.pdv else None

    def __repr__(self) -> str:
        return f"<Volume pdv={self.pdv_id} date={self.date} eqp={self.eqp_count}>"
