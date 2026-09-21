"""Modèle Tournée / Tour model."""

import enum

from sqlalchemy import Boolean, Enum, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.mixins import TenantMixin
from app.models.contract import VehicleType


class TourStatus(str, enum.Enum):
    """Statut de la tournée / Tour status."""
    DRAFT = "DRAFT"
    VALIDATED = "VALIDATED"
    IN_PROGRESS = "IN_PROGRESS"
    RETURNING = "RETURNING"
    COMPLETED = "COMPLETED"


class TourType(str, enum.Enum):
    """Nature de la tournée / Tour nature.

    LIVRAISON = tournée de livraison classique (PDV + volumes).
    Les autres natures sont encodées et prises en compte (planning, coût si
    contrat) mais ne sont pas des livraisons : pas de contrôle volume/température.
    ENLEVEMENT/VIDANGES peuvent avoir des arrêts PDV ; DEPLACEMENT_BASE/GARAGE
    n'en ont pas (destination libre).
    """
    LIVRAISON = "LIVRAISON"
    ENLEVEMENT = "ENLEVEMENT"          # Reprise / pickup
    VIDANGES = "VIDANGES"              # Collecte de vidanges (contenants vides)
    DEPLACEMENT_BASE = "DEPLACEMENT_BASE"  # Déplacement camion sur/entre base(s)
    GARAGE = "GARAGE"                  # Envoi au garage / atelier
    TRANSFERT_PDV = "TRANSFERT_PDV"    # Transfert de marchandises d'un PDV à un autre
    ENLEVEMENT_DEDIE = "ENLEVEMENT_DEDIE"  # Enlèvement dédié chez un fournisseur (distancier)


# Natures sans livraison (pas de contrôle volume/température, arrêts optionnels) /
# Non-delivery natures
NON_DELIVERY_TYPES = {
    TourType.ENLEVEMENT, TourType.VIDANGES, TourType.DEPLACEMENT_BASE,
    TourType.GARAGE, TourType.TRANSFERT_PDV, TourType.ENLEVEMENT_DEDIE,
}
# Natures de type reprise (collecte PDV, comme l'ancien is_pickup_tour) / Pickup-like natures
PICKUP_TYPES = {TourType.ENLEVEMENT, TourType.VIDANGES}


class Tour(Base, TenantMixin):
    __tablename__ = "tours"
    __table_args__ = (
        Index("ix_tours_base_date", "base_id", "date"),
        Index("ix_tours_status", "status"),
        Index("ix_tours_contract_id", "contract_id"),
        Index("ix_tours_delivery_date", "delivery_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD
    code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    vehicle_type: Mapped[VehicleType | None] = mapped_column(Enum(VehicleType))
    capacity_eqp: Mapped[int | None] = mapped_column(Integer)
    contract_id: Mapped[int | None] = mapped_column(ForeignKey("contracts.id"), nullable=True)
    departure_time: Mapped[str | None] = mapped_column(String(5))  # HH:MM
    return_time: Mapped[str | None] = mapped_column(String(5))  # HH:MM
    total_km: Mapped[float | None] = mapped_column(Numeric(10, 2))
    total_duration_minutes: Mapped[int | None] = mapped_column(Integer)
    total_eqp: Mapped[float | None] = mapped_column(Numeric(10, 2))  # EQP fractionnaire (somme eqp_count)
    total_cost: Mapped[float | None] = mapped_column(Numeric(12, 2))
    total_weight_kg: Mapped[float | None] = mapped_column(Numeric(10, 2))
    # Poids total du tour (saisi par le postier) / Total tour weight (entered by dispatcher)
    status: Mapped[TourStatus] = mapped_column(Enum(TourStatus), default=TourStatus.DRAFT)
    base_id: Mapped[int] = mapped_column(ForeignKey("bases_logistics.id"), nullable=False)
    delivery_date: Mapped[str | None] = mapped_column(String(10))  # YYYY-MM-DD — date de livraison
    temperature_type: Mapped[str | None] = mapped_column(String(10))  # SEC|FRAIS|GEL|BI_TEMP|TRI_TEMP
    is_pickup_tour: Mapped[bool] = mapped_column(Boolean, default=False)
    # Nature de la tournée. Nullable en base (migration sûre), rétro-rempli LIVRAISON.
    tour_type: Mapped["TourType | None"] = mapped_column(Enum(TourType), nullable=True, default=TourType.LIVRAISON)
    # Destination libre pour les tours hors-livraison (garage, base cible, note)
    destination: Mapped[str | None] = mapped_column(String(150))
    # Fournisseur cible pour un enlèvement dédié (ENLEVEMENT_DEDIE) — point
    # d'enlèvement dans le distancier, fonctionne comme un PDV / Target supplier
    # for a dedicated pickup, a distancier pickup point that behaves like a PDV.
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"), nullable=True)
    bypass_support_rules: Mapped[bool] = mapped_column(Boolean, default=False)  # Desactive le controle support/base pour cette tournee
    # Priorité manuelle d'ordonnancement (1..n) saisie au moment de planifier ;
    # départage les tours à même heure de départ. NULL = non prioritaire (en dernier).
    # Priorité d'ordonnancement, DÉCIMALE (#29) : l'agent trafic intercale une
    # tournée entre la 2 et la 3 en saisissant 2,5, sans renuméroter les autres.
    # La colonne était un entier ; elle a été élargie en numeric(8,2) par une
    # migration manuelle (la migration de démarrage n'altère pas les types).
    # / Decimal scheduling priority so a tour can be slotted between two others.
    priority: Mapped[float | None] = mapped_column(Numeric(8, 2))

    # Champs opérationnels / Operational fields — datetime-local YYYY-MM-DDTHH:MM
    driver_name: Mapped[str | None] = mapped_column(String(100))
    # Code chauffeur Infolog (code_infolog du BaseDriver) figé au moment de la
    # planification, pour l'export WMS Infolog / Driver Infolog code captured at
    # scheduling time for the Infolog WMS export.
    driver_code_infolog: Mapped[str | None] = mapped_column(String(30))
    driver_arrival_time: Mapped[str | None] = mapped_column(String(16))
    loading_end_time: Mapped[str | None] = mapped_column(String(16))
    barrier_exit_time: Mapped[str | None] = mapped_column(String(16))
    barrier_entry_time: Mapped[str | None] = mapped_column(String(16))
    km_departure: Mapped[int | None] = mapped_column(Integer)  # km compteur départ / odometer at departure
    km_return: Mapped[int | None] = mapped_column(Integer)  # km compteur retour / odometer at return
    remarks: Mapped[str | None] = mapped_column(Text)

    # Champs opérationnels postier / Dispatcher operational fields
    loader_code: Mapped[str | None] = mapped_column(String(20))
    loader_name: Mapped[str | None] = mapped_column(String(100))
    trailer_number: Mapped[str | None] = mapped_column(String(30))
    dock_door_number: Mapped[str | None] = mapped_column(String(10))
    trailer_ready_time: Mapped[str | None] = mapped_column(String(16))
    eqp_loaded: Mapped[int | None] = mapped_column(Integer)
    departure_signal_time: Mapped[str | None] = mapped_column(String(16))
    wms_tour_code: Mapped[str | None] = mapped_column(String(30))

    # Temperatures relevees par le postier / Temperatures recorded by dispatcher
    trailer_ready_temp: Mapped[float | None] = mapped_column(Numeric(5, 1))  # °C a la mise a dispo semi
    loading_end_temp: Mapped[float | None] = mapped_column(Numeric(5, 1))    # °C en fin de chargement

    # Vehicules propres affectes au tour / Own vehicles assigned to tour
    # vehicle_id = vehicule principal (porteur seul, ou semi-remorque dans un ensemble)
    # tractor_id = tracteur (seulement pour les ensembles tracteur+semi)
    # Si NULL → vehicule preste (du transporteur, pas dans notre parc)
    vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id"))
    tractor_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id"))

    # Champs suivi mobile / Mobile tracking fields
    driver_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    device_assignment_id: Mapped[int | None] = mapped_column(ForeignKey("device_assignments.id"))
    actual_return_time: Mapped[str | None] = mapped_column(String(32))  # ISO 8601

    # Relations
    contract: Mapped["Contract | None"] = relationship(back_populates="tours")
    base: Mapped["BaseLogistics"] = relationship(back_populates="tours")
    vehicle: Mapped["Vehicle | None"] = relationship(foreign_keys=[vehicle_id])
    tractor: Mapped["Vehicle | None"] = relationship(foreign_keys=[tractor_id])
    supplier: Mapped["Supplier | None"] = relationship(foreign_keys=[supplier_id])
    stops: Mapped[list["TourStop"]] = relationship(
        back_populates="tour", cascade="all, delete-orphan", order_by="TourStop.sequence_order"
    )
    surcharges: Mapped[list["TourSurcharge"]] = relationship(
        back_populates="tour", cascade="all, delete-orphan"
    )
    driver_user: Mapped["User | None"] = relationship(foreign_keys=[driver_user_id])
    device_assignment: Mapped["DeviceAssignment | None"] = relationship(foreign_keys=[device_assignment_id])

    def __repr__(self) -> str:
        return f"<Tour {self.code} - {self.date}>"
