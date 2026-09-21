"""Modèle Contrat (fusionné avec véhicule) / Contract model (merged with vehicle)."""

import enum

from sqlalchemy import Boolean, Enum, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.mixins import TenantMixin


class FuelType(str, enum.Enum):
    """Type de carburant / Fuel type.

    Partagé par les véhicules, les contrats et les prix carburant (un seul type
    enum PG `fueltype`). Pour les contrats/prix on n'utilise que DIESEL (gasoil)
    et GNV (gaz), mais l'enum complet reste disponible pour le parc véhicules.
    """
    DIESEL = "DIESEL"        # Gasoil
    ESSENCE = "ESSENCE"
    GNV = "GNV"              # Gaz (Gaz Naturel Véhicule)
    ELECTRIQUE = "ELECTRIQUE"
    HYBRIDE = "HYBRIDE"


class TemperatureType(str, enum.Enum):
    """Type de température du véhicule / Vehicle temperature type."""
    GEL = "GEL"
    FRAIS = "FRAIS"
    SEC = "SEC"
    BI_TEMP = "BI_TEMP"
    TRI_TEMP = "TRI_TEMP"


class VehicleType(str, enum.Enum):
    """Type de véhicule / Vehicle type."""
    SEMI = "SEMI"
    PORTEUR = "PORTEUR"
    PORTEUR_SURBAISSE = "PORTEUR_SURBAISSE"
    PORTEUR_REMORQUE = "PORTEUR_REMORQUE"
    # Semi courte (#65) : gabarit distinct, à autoriser point de vente par point
    # de vente comme les autres. / Short trailer, allowed per PDV like the rest.
    SEMI_COURTE = "SEMI_COURTE"
    # CITY n'est plus proposé à la saisie (#65) mais la valeur reste : trois
    # tournées et 144 points de vente y font encore référence, et les retirer de
    # l'énumération rendrait ces enregistrements illisibles. /
    # CITY is no longer offered but stays in the enum: existing records use it.
    CITY = "CITY"
    VL = "VL"


class TailgateType(str, enum.Enum):
    """Type de hayon / Tailgate type."""
    RETRACTABLE = "RETRACTABLE"
    RABATTABLE = "RABATTABLE"


class TrailerSupply(str, enum.Enum):
    """Qui fournit la remorque / Who supplies the trailer.

    Un contrat peut être éligible aux deux modes : certains transporteurs
    amènent leur remorque sur le frais (presté) mais tractent une remorque
    frigo CMRO sur le gel (mixte). / A contract can be eligible for both
    modes: some carriers bring their own trailer on chilled tours but tow a
    CMRO freezer trailer on frozen tours.
    """
    CARRIER = "CARRIER"   # Le transporteur amène sa remorque → presté uniquement
    CMRO = "CMRO"         # Nous fournissons la remorque (traction) → mixte uniquement
    BOTH = "BOTH"         # Les deux, le choix se fait par tournée à l'ordonnancement


class Contract(Base, TenantMixin):
    """1 contrat = 1 moyen (véhicule) mis à disposition / 1 contract = 1 vehicle provided."""
    __tablename__ = "contracts"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # Contrat / Contract
    transporter_name: Mapped[str] = mapped_column(String(150), nullable=False)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    # « Terme fixe » et « vacation » désignent la MÊME chose dans le métier
    # (ticket #58) : les 74 contrats renseignés portaient d'ailleurs la même
    # valeur dans les deux champs. Les deux colonnes subsistent — l'extraction
    # de pré-facturation lit `fixed_daily_cost` — mais elles sont tenues
    # synchronisées à l'écriture et ne comptent QU'UNE FOIS dans le coût.
    # / Same business notion; kept in sync, counted once.
    fixed_daily_cost: Mapped[float | None] = mapped_column(Numeric(10, 2))
    vacation: Mapped[float | None] = mapped_column(Numeric(10, 2))
    cost_per_km: Mapped[float | None] = mapped_column(Numeric(10, 4))
    cost_per_hour: Mapped[float | None] = mapped_column(Numeric(10, 2))
    # Barème pré-facturation CMRO / CMRO pre-billing tariff
    # Type de facturation chauffeur : 1=base/intérim (non facturé, éval),
    # 2=tractionnaire sous contrat (barème complet), 3=occasionnel (forfait jour),
    # 4=journalier (éval). Défaut 2.
    billing_type: Mapped[int | None] = mapped_column(Integer, default=2)
    daily_cost: Mapped[float | None] = mapped_column(Numeric(10, 2))          # Forfait/éval journalier (types 1/3/4)
    trailer_cost: Mapped[float | None] = mapped_column(Numeric(10, 2))        # T_rem : forfait remorque (÷ nb tournées)
    ha_cost: Mapped[float | None] = mapped_column(Numeric(10, 2))             # HA : forfait par tournée
    prime_saturday: Mapped[float | None] = mapped_column(Numeric(10, 2))      # Prime samedi
    prime_sunday_holiday: Mapped[float | None] = mapped_column(Numeric(10, 2))  # Prime dimanche/férié
    # Type de carburant (obligatoire à la saisie ; nullable en base pour migration
    # sûre, rétro-rempli GASOIL au démarrage). Détermine quel prix carburant utiliser.
    # Pour le gaz, consumption_coefficient s'exprime en kg/km (sinon L/km).
    fuel_type: Mapped[FuelType | None] = mapped_column(
        Enum(FuelType), nullable=True, default=FuelType.DIESEL
    )
    min_hours_per_day: Mapped[float | None] = mapped_column(Numeric(5, 2))
    min_km_per_day: Mapped[float | None] = mapped_column(Numeric(8, 2))
    consumption_coefficient: Mapped[float | None] = mapped_column(Numeric(6, 4))
    start_date: Mapped[str | None] = mapped_column(String(10))  # YYYY-MM-DD
    end_date: Mapped[str | None] = mapped_column(String(10))
    region_id: Mapped[int] = mapped_column(ForeignKey("regions.id"), nullable=False)

    # Véhicule / Vehicle
    vehicle_code: Mapped[str | None] = mapped_column(String(20), unique=True)
    vehicle_name: Mapped[str | None] = mapped_column(String(150))
    temperature_type: Mapped[TemperatureType | None] = mapped_column(Enum(TemperatureType))
    vehicle_type: Mapped[VehicleType | None] = mapped_column(Enum(VehicleType))
    capacity_eqp: Mapped[int | None] = mapped_column(Integer)
    capacity_weight_kg: Mapped[int | None] = mapped_column(Integer)
    has_tailgate: Mapped[bool] = mapped_column(Boolean, default=False)
    tailgate_type: Mapped[TailgateType | None] = mapped_column(Enum(TailgateType))

    # Fourniture par le transporteur / Provided by the carrier
    # NULL = non renseigne (contrats anciens, equipe doit completer) /
    # NULL = not yet set (legacy contracts, team to fill in)
    provides_tractor: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    provides_trailer: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Source de vérité pour la remorque depuis le ticket #41. NULL = contrat non
    # migré → on retombe sur provides_trailer (cf. effective_trailer_supply()). /
    # Source of truth for the trailer since ticket #41. NULL = unmigrated
    # contract → falls back to provides_trailer.
    trailer_supply: Mapped[TrailerSupply | None] = mapped_column(
        Enum(TrailerSupply, name="trailer_supply"), nullable=True
    )

    # Lien vers vehicule autonome (si applicable) / Link to standalone vehicle
    vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id"))
    # Lien vers transporteur / Link to carrier
    carrier_id: Mapped[int | None] = mapped_column(ForeignKey("carriers.id"))

    # Relations
    region: Mapped["Region"] = relationship(back_populates="contracts")
    carrier: Mapped["Carrier | None"] = relationship(back_populates="contracts")
    tours: Mapped[list["Tour"]] = relationship(back_populates="contract")
    schedules: Mapped[list["ContractSchedule"]] = relationship(
        back_populates="contract", cascade="all, delete-orphan"
    )
    vehicle: Mapped["Vehicle | None"] = relationship(back_populates="contracts")

    def __repr__(self) -> str:
        return f"<Contract {self.code} - {self.transporter_name}>"


def effective_trailer_supply(contract) -> TrailerSupply | None:
    """Fourniture de remorque effective d'un contrat / Effective trailer supply.

    Retombe sur l'ancien booléen tant que le contrat n'a pas été repassé en
    revue par le trafic. None = inconnu (legacy) : ne filtre rien. /
    Falls back to the legacy boolean until traffic reviews the contract.
    None = unknown (legacy): filters nothing out.
    """
    supply = getattr(contract, "trailer_supply", None)
    if supply is not None:
        return supply
    provides = getattr(contract, "provides_trailer", None)
    if provides is True:
        return TrailerSupply.CARRIER
    if provides is False:
        return TrailerSupply.CMRO
    return None


def effective_vacation(contract) -> float:
    """Montant de la vacation (ex-« terme fixe ») d'un contrat, compté UNE fois.

    Le coût des tournées additionnait `fixed_daily_cost` ET `vacation`, alors que
    les deux champs portent la même valeur : le terme fixe était donc compté deux
    fois — 394 085 EUR sur 819 305 EUR pour le seul mois de septembre. La
    pré-facturation CMRO, elle, n'en comptait déjà qu'un seul (ticket #58).
    / Single fixed term: the tour cost used to add both columns.
    """
    for champ in ("fixed_daily_cost", "vacation"):
        valeur = getattr(contract, champ, None)
        if valeur:
            return float(valeur)
    return 0.0
