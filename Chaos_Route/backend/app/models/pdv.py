"""Modèle Point de Vente / Point of Sale model."""

import enum

from sqlalchemy import Boolean, Enum, Float, ForeignKey, Integer, String, Text, Time
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.mixins import TenantMixin


class PDVType(str, enum.Enum):
    """Type de point de vente / Point of sale type."""
    EXPRESS = "EXPRESS"
    CONTACT = "CONTACT"
    SUPER_ALIMENTAIRE = "SUPER_ALIMENTAIRE"
    SUPER_GENERALISTE = "SUPER_GENERALISTE"
    HYPER = "HYPER"
    NETTO = "NETTO"
    DRIVE = "DRIVE"
    URBAIN_PROXI = "URBAIN_PROXI"


class PDV(Base, TenantMixin):
    __tablename__ = "pdvs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    address: Mapped[str | None] = mapped_column(String(255))
    postal_code: Mapped[str | None] = mapped_column(String(20))
    city: Mapped[str | None] = mapped_column(String(100))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(150))
    longitude: Mapped[float | None] = mapped_column(Float)
    latitude: Mapped[float | None] = mapped_column(Float)
    type: Mapped[PDVType] = mapped_column(Enum(PDVType), nullable=False)

    # SAS par température / SAS per temperature class
    has_sas_sec: Mapped[bool] = mapped_column(Boolean, default=False)
    sas_sec_surface_m2: Mapped[float | None] = mapped_column(Float)
    sas_sec_capacity_eqc: Mapped[int | None] = mapped_column(Integer)

    has_sas_frais: Mapped[bool] = mapped_column(Boolean, default=False)
    sas_frais_surface_m2: Mapped[float | None] = mapped_column(Float)
    sas_frais_capacity_eqc: Mapped[int | None] = mapped_column(Integer)

    has_sas_gel: Mapped[bool] = mapped_column(Boolean, default=False)
    sas_gel_surface_m2: Mapped[float | None] = mapped_column(Float)
    sas_gel_capacity_eqc: Mapped[int | None] = mapped_column(Integer)

    # Quai par activité / Dock per activity
    has_dock_sec: Mapped[bool] = mapped_column(Boolean, default=False)
    has_dock_frais: Mapped[bool] = mapped_column(Boolean, default=False)
    has_dock_gel: Mapped[bool] = mapped_column(Boolean, default=False)

    # Quai de déchargement global / Global unloading dock
    has_dock: Mapped[bool] = mapped_column(Boolean, default=False)
    dock_has_niche: Mapped[bool] = mapped_column(Boolean, default=False)
    dock_time_minutes: Mapped[int | None] = mapped_column(Integer)  # temps de mise à quai
    unload_time_per_eqp_minutes: Mapped[int | None] = mapped_column(Integer)  # temps déchargement par EQC

    # Fenêtre de livraison globale (fallback) / Global delivery window (fallback)
    delivery_window_start: Mapped[str | None] = mapped_column(String(5))  # HH:MM
    delivery_window_end: Mapped[str | None] = mapped_column(String(5))  # HH:MM

    # Jour/Nuit par activité (flags explicites) / Day/Night per activity (explicit flags)
    is_day_sec: Mapped[bool] = mapped_column(Boolean, default=True)
    is_day_frais: Mapped[bool] = mapped_column(Boolean, default=True)
    is_day_gel: Mapped[bool] = mapped_column(Boolean, default=True)

    # Fenêtres de livraison par activité / Delivery windows per activity
    delivery_window_sec_start: Mapped[str | None] = mapped_column(String(5))  # HH:MM
    delivery_window_sec_end: Mapped[str | None] = mapped_column(String(5))  # HH:MM
    delivery_window_frais_start: Mapped[str | None] = mapped_column(String(5))  # HH:MM
    delivery_window_frais_end: Mapped[str | None] = mapped_column(String(5))  # HH:MM
    delivery_window_gel_start: Mapped[str | None] = mapped_column(String(5))  # HH:MM
    delivery_window_gel_end: Mapped[str | None] = mapped_column(String(5))  # HH:MM

    # Contraintes d'accès / Access constraints
    access_constraints: Mapped[str | None] = mapped_column(Text)

    # Types de véhicules autorisés (pipe-delimited) / Allowed vehicle types (pipe-delimited)
    # NULL = tous acceptés / NULL = all accepted
    allowed_vehicle_types: Mapped[str | None] = mapped_column(String(200))

    # Groupe de livraison (#69) : « A » ou « B ». Les mises en avant sont
    # injectées en une seule fois pour tout le réseau, puis livrées en deux
    # vagues ; le groupe permet de filtrer les volumes d'une vague sans
    # refaire d'injection. / Delivery wave (A/B): lets a single volume import be
    # planned in two waves.
    delivery_group: Mapped[str | None] = mapped_column(String(1))

    # Plan du site / Site access plan (URL or file path)
    site_plan_url: Mapped[str | None] = mapped_column(String(500))

    region_id: Mapped[int] = mapped_column(ForeignKey("regions.id"), nullable=False)

    # Relations
    region: Mapped["Region"] = relationship(back_populates="pdvs")
    volumes: Mapped[list["Volume"]] = relationship(back_populates="pdv")
    tour_stops: Mapped[list["TourStop"]] = relationship(back_populates="pdv")

    def __repr__(self) -> str:
        return f"<PDV {self.code} - {self.name}>"
