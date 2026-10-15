"""
Modèles SQLAlchemy / SQLAlchemy models.
Importer tous les modèles ici pour qu'Alembic les détecte.
Import all models here so Alembic can detect them.
"""

from app.models.tenant import Tenant, DEFAULT_TENANT_ID
from app.models.country import Country
from app.models.region import Region
from app.models.base_activity import BaseActivity, base_activity_link
from app.models.base_logistics import BaseLogistics
from app.models.pdv import PDV
from app.models.supplier import Supplier
from app.models.volume import Volume
from app.models.tour import Tour
from app.models.tour_stop import TourStop
from app.models.contract import Contract
from app.models.contract_schedule import ContractSchedule
from app.models.distance_matrix import DistanceMatrix
from app.models.fuel_price import FuelPrice
from app.models.km_tax import KmTax
from app.models.parameter import Parameter
from app.models.audit import AuditLog
from app.models.loader import Loader
from app.models.user import User, Role, Permission, user_roles, user_regions
from app.models.mobile_device import MobileDevice
from app.models.device_assignment import DeviceAssignment
from app.models.gps_position import GPSPosition
from app.models.stop_event import StopEvent, StopEventType
from app.models.support_scan import SupportScan
from app.models.delivery_alert import DeliveryAlert, AlertType, AlertSeverity
from app.models.support_type import SupportType
from app.models.pickup_request import PickupRequest, PickupLabel, PickupMovement, PickupType, PickupStatus, LabelStatus, MovementType
from app.models.tour_manifest_line import TourManifestLine
from app.models.surcharge_type import SurchargeType
from app.models.tour_surcharge import TourSurcharge, SurchargeStatus
from app.models.driver_declaration import DriverDeclaration, DeclarationPhoto, DeclarationType
from app.models.vehicle import Vehicle, FleetVehicleType, VehicleStatus, FuelType, OwnershipType
from app.models.inspection_template import InspectionTemplate, InspectionCategory
from app.models.vehicle_inspection import (
    VehicleInspection, InspectionItem, InspectionPhoto,
    InspectionType, InspectionStatus, InspectionItemResult,
)
from app.models.vehicle_maintenance import (
    VehicleMaintenanceRecord, MaintenanceScheduleRule,
    MaintenanceType, MaintenanceStatus,
)
from app.models.vehicle_fuel import VehicleFuelEntry
from app.models.vehicle_modification import VehicleModification
from app.models.vehicle_cost_entry import VehicleCostEntry, CostCategory
from app.models.carrier import Carrier
from app.models.consignment_movement import ConsignmentMovement
from app.models.waybill_archive import WaybillArchive, CMRStatus
from app.models.pdv_inventory import PdvInventory, PdvStock
from app.models.base_zone import BaseZone
from app.models.base_container_stock import BaseContainerStock, BaseContainerMovement, BaseMovementType, BaseInventoryType
from app.models.cnuf_temperature import CnufTemperature
from app.models.gic_invoice import GicInvoice, GicInvoiceLine, GicInvoiceStatus
from app.models.beer_consignment import BeerConsignmentTx, BeerConsignmentBalance, BeerTransactionType
from app.models.container_anomaly import ContainerAnomaly, AnomalyPhoto, AnomalyComment, AnomalyStatus, AnomalyCategory, AnomalySeverity
from app.models.bottle_sorting import BottleBrand, SortingSession, SortingLine, SortingStatus, BottleFormat, SortingRule
from app.models.combi_scan import CombiScan, ScanContext
from app.models.control_evidence import ControlEvidence, ControlContext
from app.models.base_support_rule import BaseSupportRule
from app.models.pdv_support_rule import PdvSupportRule
from app.models.reminder_ack import ReminderAck
from app.models.crate_type import CrateType
from app.models.crate_request import CrateRequest, CrateRequestStatus
from app.models.base_driver import BaseDriver, DriverStatus
from app.models.operational_alert import OperationalAlert, AlertComment, AlertType, AlertStatus, AlertPriority
from app.models.ticket import Ticket, TicketComment, TicketType, TicketStatus, TicketPriority

__all__ = [
    "Tenant",
    "DEFAULT_TENANT_ID",
    "Country",
    "Region",
    "BaseActivity",
    "base_activity_link",
    "BaseLogistics",
    "PDV",
    "Supplier",
    "Volume",
    "Tour",
    "TourStop",
    "Contract",
    "ContractSchedule",
    "DistanceMatrix",
    "FuelPrice",
    "KmTax",
    "Parameter",
    "AuditLog",
    "User",
    "Role",
    "Permission",
    "user_roles",
    "user_regions",
    "Loader",
    "MobileDevice",
    "DeviceAssignment",
    "GPSPosition",
    "StopEvent",
    "StopEventType",
    "SupportScan",
    "DeliveryAlert",
    "AlertType",
    "AlertSeverity",
    "SupportType",
    "PickupRequest",
    "PickupLabel",
    "PickupMovement",
    "PickupType",
    "PickupStatus",
    "LabelStatus",
    "MovementType",
    "TourManifestLine",
    "SurchargeType",
    "TourSurcharge",
    "SurchargeStatus",
    "DriverDeclaration",
    "DeclarationPhoto",
    "DeclarationType",
    "Vehicle",
    "FleetVehicleType",
    "VehicleStatus",
    "FuelType",
    "OwnershipType",
    "InspectionTemplate",
    "InspectionCategory",
    "VehicleInspection",
    "InspectionItem",
    "InspectionPhoto",
    "InspectionType",
    "InspectionStatus",
    "InspectionItemResult",
    "VehicleMaintenanceRecord",
    "MaintenanceScheduleRule",
    "MaintenanceType",
    "MaintenanceStatus",
    "VehicleFuelEntry",
    "VehicleModification",
    "VehicleCostEntry",
    "CostCategory",
    "ConsignmentMovement",
    "Carrier",
    "WaybillArchive",
    "CMRStatus",
    "PdvInventory",
    "PdvStock",
    "BaseZone",
    "BaseContainerStock",
    "BaseContainerMovement",
    "BaseMovementType",
    "BaseInventoryType",
    "CnufTemperature",
    "GicInvoice",
    "GicInvoiceLine",
    "GicInvoiceStatus",
    "BeerConsignmentTx",
    "BeerConsignmentBalance",
    "BeerTransactionType",
    "ContainerAnomaly",
    "AnomalyPhoto",
    "AnomalyComment",
    "AnomalyStatus",
    "AnomalyCategory",
    "AnomalySeverity",
    "BottleBrand",
    "SortingSession",
    "SortingLine",
    "SortingStatus",
    "BottleFormat",
    "SortingRule",
    "CombiScan",
    "ScanContext",
    "ControlEvidence",
    "ControlContext",
    "BaseSupportRule",
    "PdvSupportRule",
    "ReminderAck",
    "CrateType",
    "CrateRequest",
    "CrateRequestStatus",
    "BaseDriver",
    "DriverStatus",
    "OperationalAlert",
    "AlertComment",
    "AlertType",
    "AlertStatus",
    "AlertPriority",
]
