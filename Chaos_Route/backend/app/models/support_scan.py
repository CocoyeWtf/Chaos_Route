"""Modele Scan support individuel / Individual support scan model."""

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.mixins import TenantMixin


class SupportScan(Base, TenantMixin):
    """Scan support individuel (code barre 1D) / Individual support scan (1D barcode)."""
    __tablename__ = "support_scans"
    __table_args__ = (
        Index("ix_support_scans_tour_stop_id", "tour_stop_id"),
        Index("ix_support_scans_barcode", "barcode"),
        # Tracabilite « ou a-t-on scanne quoi » : la consultation web filtre par
        # plage de dates, l'index evite un seq scan sur toute la table. /
        # Web traceability view filters by date range.
        Index("ix_support_scans_timestamp", "timestamp"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    tour_stop_id: Mapped[int] = mapped_column(ForeignKey("tour_stops.id"), nullable=False)
    device_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("mobile_devices.id"))
    barcode: Mapped[str] = mapped_column(String(100), nullable=False)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    # Precision du point en metres (rayon a 68 %) : sans elle, impossible de
    # distinguer un scan reellement localise d'un point radio a 2 km. /
    # Fix accuracy in metres — tells a real fix from a 2 km cell-tower guess.
    accuracy: Mapped[float | None] = mapped_column(Float)
    timestamp: Mapped[str] = mapped_column(String(32), nullable=False)  # ISO 8601
    expected_at_stop: Mapped[bool] = mapped_column(Boolean, default=True)
