"""Schemas mobile / Mobile schemas — devices, assignments, GPS, stops, alerts."""

from pydantic import BaseModel, ConfigDict, Field


# ─── MobileDevice ───

ALL_DEVICE_FEATURES = ["tours", "pickups", "base_reception", "inventory", "declarations", "inspections"]

DEVICE_PROFILE_LABELS = {
    "DRIVER": "Chauffeur",
    "BASE_RECEPTION": "Reception base",
    "INVENTORY": "Inventaire",
}

class MobileDeviceCreate(BaseModel):
    friendly_name: str | None = None
    imei: str | None = None
    base_id: int | None = None
    pdv_id: int | None = None  # tablette magasin (scope sans login)
    profile: str = "DRIVER"  # DRIVER, BASE_RECEPTION, INVENTORY, PDV

class MobileDeviceUpdate(BaseModel):
    device_identifier: str | None = None
    friendly_name: str | None = None
    imei: str | None = None
    base_id: int | None = None
    pdv_id: int | None = None
    is_active: bool | None = None
    profile: str | None = None  # DRIVER, BASE_RECEPTION, INVENTORY, PDV
    control_mode: bool | None = None  # null = herite du parametre global/regional

class MobileDeviceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    device_identifier: str | None = None
    friendly_name: str | None = None
    imei: str | None = None
    registration_code: str
    base_id: int | None = None
    pdv_id: int | None = None
    is_active: bool
    registered_at: str | None = None
    app_version: str | None = None
    # Build natif installe (#14) : app_version seul ne distingue pas les builds
    # 11 a 14, tous nommes « 1.9.3 ». / Installed native build.
    app_build: int | None = None
    os_version: str | None = None
    last_seen_at: str | None = None
    profile: str | None = "DRIVER"
    allowed_features: str | None = None
    control_mode: bool | None = None

class DeviceRegistration(BaseModel):
    """Enregistrement mobile via QR / Mobile registration via QR code."""
    registration_code: str = Field(max_length=36, pattern=r"^[A-Z0-9]{6,12}$")
    device_identifier: str = Field(max_length=100, pattern=r"^[0-9a-fA-F\-]{36}$")


# ─── DeviceAssignment ───

class DeviceAssignmentCreate(BaseModel):
    device_id: int
    tour_id: int
    date: str  # YYYY-MM-DD
    driver_name: str | None = None

class DeviceAssignmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    device_id: int
    tour_id: int
    date: str
    driver_name: str | None = None
    user_id: int | None = None
    assigned_at: str | None = None
    returned_at: str | None = None


# ─── GPS ───

class GPSPositionCreate(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: float | None = None
    speed: float | None = None
    timestamp: str = Field(max_length=30)

class GPSBatchCreate(BaseModel):
    """Batch de positions GPS / GPS position batch."""
    tour_id: int
    positions: list[GPSPositionCreate] = Field(max_length=100)

class GPSPositionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    device_id: int
    tour_id: int
    latitude: float
    longitude: float
    accuracy: float | None = None
    speed: float | None = None
    timestamp: str


# ─── StopEvent ───

class StopEventCreate(BaseModel):
    """Scan PDV a l'arrivee / PDV scan on arrival."""
    scanned_pdv_code: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z0-9_\-]+$")
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    accuracy: float | None = None
    timestamp: str = Field(max_length=30)
    notes: str | None = Field(default=None, max_length=500)

class StopClosureCreate(BaseModel):
    """Cloture d'un stop / Stop closure."""
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    accuracy: float | None = None
    timestamp: str = Field(max_length=30)
    notes: str | None = Field(default=None, max_length=500)
    force: bool = False


# ─── SupportScan ───

class SupportScanCreate(BaseModel):
    """Scan d'un support (code barre 1D) / Support barcode scan."""
    barcode: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9\-_]+$")
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    timestamp: str = Field(max_length=30)

class SupportScanRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tour_stop_id: int
    barcode: str
    timestamp: str
    expected_at_stop: bool = True
    expected_pdv_code: str | None = None   # PDV attendu selon manifeste / Expected PDV from manifest
    latitude: float | None = None
    longitude: float | None = None


# ─── Manifest Check ───

class ManifestCheckResponse(BaseModel):
    """Verification manifeste avant cloture / Manifest check before closure."""
    total_expected: int = 0
    scanned: int = 0
    missing_barcodes: list[str] = []


# ─── Pickup Summary ───

class PickupSummaryItem(BaseModel):
    """Resume reprise par type de support / Pickup summary per support type."""
    support_type_code: str
    support_type_name: str
    total_labels: int
    pending_labels: int


class PickupRefusalCreate(BaseModel):
    """Refus de reprise par le chauffeur / Pickup refusal by driver."""
    reason: str = Field(default="Refuse par le chauffeur", max_length=500)
    timestamp: str = Field(max_length=30)


# ─── Driver Tour views ───

class DriverTourStopRead(BaseModel):
    """Vue stop pour le chauffeur / Driver stop view."""
    id: int
    sequence_order: int
    eqp_count: float
    pdv_code: str | None = None
    pdv_name: str | None = None
    pdv_address: str | None = None
    pdv_city: str | None = None
    pdv_latitude: float | None = None
    pdv_longitude: float | None = None
    delivery_status: str | None = None
    arrival_time: str | None = None
    departure_time: str | None = None
    actual_arrival_time: str | None = None
    actual_departure_time: str | None = None
    pickup_cardboard: bool = False
    pickup_containers: bool = False
    pickup_returns: bool = False
    pickup_consignment: bool = False
    scanned_supports_count: int = 0
    pending_pickup_labels_count: int = 0
    pickup_summary: list[PickupSummaryItem] = []

class DriverTourRead(BaseModel):
    """Vue tour complete pour le chauffeur / Full driver tour view."""
    id: int
    code: str
    date: str
    delivery_date: str | None = None
    departure_time: str | None = None
    return_time: str | None = None
    total_eqp: float | None = None  # EQP fractionnaire (volumes injectés)
    status: str
    base_code: str | None = None
    base_name: str | None = None
    vehicle_code: str | None = None
    vehicle_name: str | None = None
    driver_name: str | None = None
    temperature_type: str | None = None
    stops: list[DriverTourStopRead] = []


# ─── Tour assignment from mobile ───

class AvailableTourRead(BaseModel):
    """Tour disponible pour affectation depuis le mobile / Available tour for mobile assignment."""
    id: int
    code: str
    delivery_date: str | None = None
    departure_time: str | None = None
    total_eqp: float | None = None  # EQP fractionnaire (volumes injectés)
    stops_count: int = 0
    driver_name: str | None = None
    vehicle_code: str | None = None

class SelfAssignCreate(BaseModel):
    """Affectation tour depuis le mobile / Tour assignment from mobile."""
    tour_id: int
    driver_name: str | None = None


# ─── DeliveryAlert ───

class DeliveryAlertRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tour_id: int
    tour_stop_id: int | None = None
    alert_type: str
    severity: str
    message: str | None = None
    created_at: str
    acknowledged_at: str | None = None
    acknowledged_by: int | None = None
    device_id: int | None = None

class AlertAcknowledge(BaseModel):
    pass  # user_id from JWT


# ─── ReturnToBase ───

class ReturnToBaseCreate(BaseModel):
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    timestamp: str = Field(max_length=30)


# ─── DriverPosition (tracking dashboard) ───

class DriverPositionRead(BaseModel):
    """Derniere position d'un chauffeur pour le dashboard / Latest driver position for dashboard."""
    tour_id: int
    tour_code: str
    driver_name: str | None = None
    latitude: float
    longitude: float
    speed: float | None = None
    accuracy: float | None = None
    timestamp: str
    stops_total: int = 0
    stops_delivered: int = 0

class TrackingDashboard(BaseModel):
    """Stats resume suivi / Tracking dashboard stats."""
    active_tours: int = 0
    completed_tours: int = 0
    delayed_tours: int = 0
    active_alerts: int = 0
