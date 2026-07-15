"""Schémas inventaire PDV / PDV inventory schemas."""

from pydantic import BaseModel, ConfigDict


class InventoryLineCreate(BaseModel):
    """Une ligne d'inventaire / One inventory line."""
    support_type_id: int
    quantity: int


class InventorySubmit(BaseModel):
    """Soumission d'inventaire complet PDV / Full PDV inventory submission."""
    pdv_id: int
    lines: list[InventoryLineCreate]
    inventoried_by: str | None = None
    # Ticket #10 : à la validation, créer aussi les demandes de reprise CMRO /
    # On validation, also create CMRO pickup requests (one per line with quantity > 0)
    create_requests: bool = False
    # Date de disponibilité pour les demandes créées (défaut : demain) /
    # Availability date for created requests (default: tomorrow) — format YYYY-MM-DD
    availability_date: str | None = None


class PdvStockRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    pdv_id: int
    support_type_id: int
    current_stock: int
    puo: int | None = None
    last_inventory_at: str | None
    last_inventoried_by: str | None


class PdvStockDetail(BaseModel):
    """Stock enrichi avec noms / Enriched stock with names."""
    pdv_id: int
    pdv_code: str
    pdv_name: str
    support_type_id: int
    support_type_code: str
    support_type_name: str
    current_stock: int
    puo: int | None = None
    unit_value: float | None = None
    last_inventory_at: str | None
    last_inventoried_by: str | None


class PuoUpdate(BaseModel):
    """Mise à jour du PUO pour un couple PDV × type / Update PUO for a PDV × type pair."""
    pdv_id: int
    support_type_id: int
    puo: int | None = None


class PuoBulkUpdate(BaseModel):
    """Mise à jour en masse des PUO / Bulk PUO update."""
    updates: list[PuoUpdate]


class PuoOverageItem(BaseModel):
    """Un dépassement PUO / A PUO overage item."""
    pdv_id: int
    pdv_code: str
    pdv_name: str
    support_type_id: int
    support_type_code: str
    support_type_name: str
    current_stock: int
    puo: int
    overage: int
    unit_value: float
    overage_value: float


class PuoOverageReport(BaseModel):
    """Rapport de dépassements PUO / PUO overage report."""
    items: list[PuoOverageItem]
    total_overage_units: int
    total_overage_value: float
    pdv_count: int


class PdvInventoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    pdv_id: int
    support_type_id: int
    quantity: int
    inventoried_at: str
    inventoried_by: str | None
