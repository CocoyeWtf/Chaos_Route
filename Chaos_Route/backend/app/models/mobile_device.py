"""Modele Telephone enregistre / Registered mobile device model."""

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.mixins import TenantMixin


# Profils mobiles et features associees / Mobile profiles and associated features
DEVICE_PROFILES = {
    "DRIVER": "tours,pickups,declarations",
    "BASE_RECEPTION": "base_reception",
    "INVENTORY": "inventory",
    # Tablette magasin : déclaration contenants uniquement (jamais inventaire base)
    "PDV": "pdv_pickup",
}


class MobileDevice(Base, TenantMixin):
    """Telephone enregistre dans le parc / Registered fleet phone."""
    __tablename__ = "mobile_devices"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    device_identifier: Mapped[str | None] = mapped_column(String(100), unique=True, nullable=True)  # UUID du tel, rempli a l'enregistrement
    friendly_name: Mapped[str | None] = mapped_column(String(100))
    imei: Mapped[str | None] = mapped_column(String(20), unique=True, nullable=True)  # IMEI du telephone (15 chiffres)
    registration_code: Mapped[str] = mapped_column(String(36), unique=True, nullable=False)  # UUID court pour QR
    base_id: Mapped[int | None] = mapped_column(ForeignKey("bases_logistics.id"))
    # Tablette magasin : rattachement à un PDV (scope sans login) / Store tablet: PDV binding
    pdv_id: Mapped[int | None] = mapped_column(ForeignKey("pdvs.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    registered_at: Mapped[str | None] = mapped_column(String(32))  # ISO 8601
    app_version: Mapped[str | None] = mapped_column(String(20))
    # Ticket #14 : le NUMERO DE BUILD, seul moyen de savoir ce qui tourne
    # reellement sur une tablette. Les builds 11 a 14 portent tous le meme
    # app_version « 1.9.3 » : sans cette colonne, le registre affichait 1.9.3
    # quel que soit le build installe, et aucune mise a jour n'etait verifiable.
    # Nullable : une tablette non encore mise a jour n'envoie pas l'en-tete. /
    # Build number — the only way to tell which build a tablet actually runs.
    app_build: Mapped[int | None] = mapped_column(Integer)
    os_version: Mapped[str | None] = mapped_column(String(50))
    last_seen_at: Mapped[str | None] = mapped_column(String(32))  # ISO 8601
    profile: Mapped[str | None] = mapped_column(String(30), default="DRIVER")  # DRIVER, BASE_RECEPTION, INVENTORY
    allowed_features: Mapped[str | None] = mapped_column(String(500), default="tours,pickups,declarations")  # CSV auto-derive du profil
    control_mode: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=None)  # null = herite du parametre global/regional

    # Relations
    base: Mapped["BaseLogistics | None"] = relationship()
    pdv: Mapped["PDV | None"] = relationship()
    assignments: Mapped[list["DeviceAssignment"]] = relationship(back_populates="device")
