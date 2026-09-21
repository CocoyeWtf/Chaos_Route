"""Schémas Tour / Tour schemas."""

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.contract import VehicleType
from app.models.tour import TourStatus, TourType


class TourStopBase(BaseModel):
    pdv_id: int
    volume_id: int | None = None  # volume source exact (None pour reprise/legacy)
    sequence_order: int
    eqp_count: float
    arrival_time: str | None = None
    departure_time: str | None = None
    distance_from_previous_km: float | None = None
    duration_from_previous_minutes: int | None = None
    pickup_cardboard: bool = False
    pickup_containers: bool = False
    pickup_returns: bool = False
    pickup_consignment: bool = False


class TourStopCreate(TourStopBase):
    pass


class TourStopInsert(BaseModel):
    """Insertion d'un stop dans un tour existant / Insert a stop into an existing tour."""
    pdv_id: int
    sequence_order: int | None = None  # None = append at end
    eqp_count: float = 0
    pickup_cardboard: bool = False
    pickup_containers: bool = False
    pickup_returns: bool = False
    pickup_consignment: bool = False


class TourStopUpdate(BaseModel):
    """Correction d'un arrêt existant depuis l'onglet postier (ticket #37).

    Seule la quantité est modifiable : le postier constate la charge réelle au
    quai. C'est la même sémantique opérationnelle que l'EQC saisie à l'ajout
    d'un PDV — la quantité n'est pas recalculée depuis les volumes rattachés.
    """
    eqp_count: float = Field(ge=0, le=999)


class TourStopRaq(BaseModel):
    """Déclaration d'un reste à quai sur un arrêt (ticket #68).

    Le postier constate au chargement que tout n'est pas parti : il annonce la
    quantité restée à quai, et la date à laquelle elle redevient planifiable.
    """
    eqp_count: float = Field(gt=0, le=999)
    dispatch_date: str = Field(min_length=10, max_length=10)


class TourStopRead(TourStopBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tour_id: int
    delivery_status: str | None = None
    actual_arrival_time: str | None = None
    actual_departure_time: str | None = None
    missing_supports_count: int | None = 0
    forced_closure: bool = False
    delivery_notes: str | None = None


class TourBase(BaseModel):
    date: str
    code: str
    vehicle_type: str | None = None
    capacity_eqp: int | None = None
    contract_id: int | None = None
    departure_time: str | None = None
    return_time: str | None = None
    total_km: float | None = None
    total_duration_minutes: int | None = None
    total_eqp: float | None = None  # EQP fractionnaire (somme d'eqp_count numeric)
    total_cost: float | None = None
    total_weight_kg: float | None = None
    status: TourStatus = TourStatus.DRAFT
    base_id: int
    delivery_date: str | None = None
    temperature_type: str | None = None
    is_pickup_tour: bool = False
    # Optionnel pour tolérer une éventuelle ligne non rétro-remplie (lecture) ;
    # défaut LIVRAISON à la création. Le front traite null comme LIVRAISON.
    tour_type: TourType | None = TourType.LIVRAISON
    destination: str | None = None            # destination libre (garage, base cible…)
    supplier_id: int | None = None            # fournisseur cible (enlèvement dédié)
    bypass_support_rules: bool = False
    priority: int | None = None  # Priorité manuelle d'ordonnancement (1..n)
    driver_name: str | None = None
    driver_code_infolog: str | None = None  # Code chauffeur Infolog (export WMS)
    driver_arrival_time: str | None = None
    loading_end_time: str | None = None
    barrier_exit_time: str | None = None
    barrier_entry_time: str | None = None
    km_departure: int | None = None
    km_return: int | None = None
    remarks: str | None = None
    loader_code: str | None = None
    loader_name: str | None = None
    trailer_number: str | None = None
    dock_door_number: str | None = None
    trailer_ready_time: str | None = None
    eqp_loaded: int | None = None
    departure_signal_time: str | None = None
    wms_tour_code: str | None = None
    trailer_ready_temp: float | None = None
    loading_end_temp: float | None = None
    driver_user_id: int | None = None
    device_assignment_id: int | None = None
    actual_return_time: str | None = None
    vehicle_id: int | None = None
    tractor_id: int | None = None


class TourCreate(TourBase):
    stops: list[TourStopCreate] = []


class TourUpdate(BaseModel):
    date: str | None = None
    code: str | None = None
    vehicle_type: str | None = None
    capacity_eqp: int | None = None
    contract_id: int | None = None
    departure_time: str | None = None
    return_time: str | None = None
    total_km: float | None = None
    total_duration_minutes: int | None = None
    total_eqp: float | None = None  # EQP fractionnaire (somme d'eqp_count numeric)
    total_cost: float | None = None
    total_weight_kg: float | None = None
    status: TourStatus | None = None
    base_id: int | None = None
    delivery_date: str | None = None
    temperature_type: str | None = None
    is_pickup_tour: bool | None = None
    tour_type: TourType | None = None
    destination: str | None = None
    supplier_id: int | None = None
    bypass_support_rules: bool | None = None
    priority: int | None = None
    driver_name: str | None = None
    driver_arrival_time: str | None = None
    loading_end_time: str | None = None
    barrier_exit_time: str | None = None
    barrier_entry_time: str | None = None
    km_departure: int | None = None
    km_return: int | None = None
    remarks: str | None = None
    loader_code: str | None = None
    loader_name: str | None = None
    trailer_number: str | None = None
    dock_door_number: str | None = None
    trailer_ready_time: str | None = None
    eqp_loaded: int | None = None
    departure_signal_time: str | None = None
    trailer_ready_temp: float | None = None
    loading_end_temp: float | None = None
    driver_user_id: int | None = None
    device_assignment_id: int | None = None
    actual_return_time: str | None = None
    vehicle_id: int | None = None
    tractor_id: int | None = None


class TourOperationsUpdate(BaseModel):
    """Mise à jour exploitant / Operations update (driver, loading, weight, remarks)."""
    driver_name: str | None = None
    driver_arrival_time: str | None = None
    loading_end_time: str | None = None
    total_weight_kg: float | None = None
    remarks: str | None = None
    loader_code: str | None = None
    loader_name: str | None = None
    trailer_number: str | None = None
    dock_door_number: str | None = None
    trailer_ready_time: str | None = None
    eqp_loaded: int | None = None
    departure_signal_time: str | None = None
    trailer_ready_temp: float | None = None
    loading_end_temp: float | None = None
    vehicle_id: int | None = None
    tractor_id: int | None = None


class TourGateUpdate(BaseModel):
    """Mise à jour poste de garde / Gate update (barrier times + km)."""
    barrier_exit_time: str | None = None
    barrier_entry_time: str | None = None
    km_departure: int | None = None
    km_return: int | None = None


class TourSchedule(BaseModel):
    """Planification : contrat ou véhicule propre + heure de départ.

    Modes :
    - Presté  : contract_id seul (tracteur + remorque du prestataire)
    - Propre  : tractor_id + driver_name (tracteur et remorque à nous, remorque assignée par le postier)
    - Mixte   : contract_id (tracteur presté, remorque à nous assignée par le postier)
    """
    contract_id: int | None = None          # presté ou mixte (tracteur presté)
    vehicle_id: int | None = None           # remorque propre (assignée par le postier)
    tractor_id: int | None = None           # propre : tracteur propre
    departure_time: str                     # HH:MM
    delivery_date: str | None = None        # YYYY-MM-DD
    driver_name: str | None = None          # propre : chauffeur base
    driver_code_infolog: str | None = None  # code Infolog du chauffeur (export WMS)
    priority: int | None = None             # priorité manuelle d'ordonnancement (1..n)

    @model_validator(mode="after")
    def check_assignment(self) -> "TourSchedule":
        if not self.contract_id and not self.tractor_id:
            raise ValueError("Au moins un contrat ou un tracteur propre doit être fourni")
        return self


class TourRead(TourBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    stops: list[TourStopRead] = []


class ReorderStopsRequest(BaseModel):
    """Permutation des arrêts d'un tour / Reorder a tour's stops.

    stop_order = ids des TourStop dans le nouvel ordre de livraison (1..n).
    """
    stop_order: list[int]


class ManifestLineRead(BaseModel):
    """Ligne manifeste WMS / WMS manifest line."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    pdv_code: str
    support_number: str
    support_label: str | None = None
    eqc: float
    nb_colis: int
    scanned: bool
    scanned_at_stop_id: int | None = None
    scanned_at: str | None = None


class ManifestImportResult(BaseModel):
    """Résultat import manifeste / Manifest import result."""
    created: int
    skipped: int = 0
    total_rows: int
    errors: list[str]
