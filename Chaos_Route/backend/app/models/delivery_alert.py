"""Modele Alertes livraison / Delivery alert model."""

import enum

from sqlalchemy import Enum, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.mixins import TenantMixin


class AlertType(str, enum.Enum):
    """Type d'alerte / Alert type."""
    WRONG_PDV = "WRONG_PDV"
    MISSING_SUPPORTS = "MISSING_SUPPORTS"
    UNEXPECTED_SUPPORT = "UNEXPECTED_SUPPORT"
    FORCED_CLOSURE = "FORCED_CLOSURE"
    PICKUP_REFUSED = "PICKUP_REFUSED"
    PICKUP_PARTIAL = "PICKUP_PARTIAL"  # Reprise partielle chauffeur / Partial pickup by driver
    PICKUP_LOSS = "PICKUP_LOSS"  # Ecart chauffeur/base / Driver/base discrepancy
    STOP_REOPENED = "STOP_REOPENED"
    LONG_STOP = "LONG_STOP"
    LONG_TRAVEL = "LONG_TRAVEL"
    NO_GPS = "NO_GPS"
    # Le telephone n'est pas rentre avec le camion (#99) : sa derniere position
    # connue est loin de la base de retour. Anti-perte de materiel, dans le
    # cadre declare au registre — on regarde la fin d'une tournee, pas la vie
    # privee de quelqu'un. / Phone did not come back to base.
    DEVICE_NOT_AT_BASE = "DEVICE_NOT_AT_BASE"


class AlertSeverity(str, enum.Enum):
    """Severite de l'alerte / Alert severity."""
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class DeliveryAlert(Base, TenantMixin):
    """Alertes livraison / Delivery alerts."""
    __tablename__ = "delivery_alerts"
    __table_args__ = (
        Index("ix_delivery_alerts_tour_id", "tour_id"),
        Index("ix_delivery_alerts_severity", "severity"),
        Index("ix_delivery_alerts_created_at", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    tour_id: Mapped[int] = mapped_column(ForeignKey("tours.id"), nullable=False)
    tour_stop_id: Mapped[int | None] = mapped_column(ForeignKey("tour_stops.id"))
    alert_type: Mapped[AlertType] = mapped_column(Enum(AlertType), nullable=False)
    severity: Mapped[AlertSeverity] = mapped_column(Enum(AlertSeverity), nullable=False)
    message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)  # ISO 8601
    acknowledged_at: Mapped[str | None] = mapped_column(String(32))
    acknowledged_by: Mapped[int | None] = mapped_column(Integer)  # user_id
    device_id: Mapped[int | None] = mapped_column(ForeignKey("mobile_devices.id"))
