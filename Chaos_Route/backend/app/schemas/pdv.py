"""Schémas PDV / Point of Sale schemas."""

from pydantic import BaseModel, ConfigDict

from app.models.pdv import PDVType


class PDVBase(BaseModel):
    code: str
    name: str
    address: str | None = None
    postal_code: str | None = None
    city: str | None = None
    phone: str | None = None
    email: str | None = None
    longitude: float | None = None
    latitude: float | None = None
    type: PDVType
    has_sas_sec: bool = False
    sas_sec_surface_m2: float | None = None
    sas_sec_capacity_eqc: int | None = None
    has_sas_frais: bool = False
    sas_frais_surface_m2: float | None = None
    sas_frais_capacity_eqc: int | None = None
    has_sas_gel: bool = False
    sas_gel_surface_m2: float | None = None
    sas_gel_capacity_eqc: int | None = None
    is_day_sec: bool = True
    is_day_frais: bool = True
    is_day_gel: bool = True
    has_dock_sec: bool = False
    has_dock_frais: bool = False
    has_dock_gel: bool = False
    has_dock: bool = False
    dock_has_niche: bool = False
    dock_time_minutes: int | None = None
    unload_time_per_eqp_minutes: int | None = None
    delivery_window_start: str | None = None
    delivery_window_end: str | None = None
    delivery_window_sec_start: str | None = None
    delivery_window_sec_end: str | None = None
    delivery_window_frais_start: str | None = None
    delivery_window_frais_end: str | None = None
    delivery_window_gel_start: str | None = None
    delivery_window_gel_end: str | None = None
    access_constraints: str | None = None
    allowed_vehicle_types: str | None = None
    delivery_group: str | None = None
    site_plan_url: str | None = None
    region_id: int


class PDVCreate(PDVBase):
    pass


class PDVUpdate(BaseModel):
    code: str | None = None
    name: str | None = None
    address: str | None = None
    postal_code: str | None = None
    city: str | None = None
    phone: str | None = None
    email: str | None = None
    longitude: float | None = None
    latitude: float | None = None
    type: PDVType | None = None
    has_sas_sec: bool | None = None
    sas_sec_surface_m2: float | None = None
    sas_sec_capacity_eqc: int | None = None
    has_sas_frais: bool | None = None
    sas_frais_surface_m2: float | None = None
    sas_frais_capacity_eqc: int | None = None
    has_sas_gel: bool | None = None
    sas_gel_surface_m2: float | None = None
    sas_gel_capacity_eqc: int | None = None
    is_day_sec: bool | None = None
    is_day_frais: bool | None = None
    is_day_gel: bool | None = None
    has_dock_sec: bool | None = None
    has_dock_frais: bool | None = None
    has_dock_gel: bool | None = None
    has_dock: bool | None = None
    dock_has_niche: bool | None = None
    dock_time_minutes: int | None = None
    unload_time_per_eqp_minutes: int | None = None
    delivery_window_start: str | None = None
    delivery_window_end: str | None = None
    delivery_window_sec_start: str | None = None
    delivery_window_sec_end: str | None = None
    delivery_window_frais_start: str | None = None
    delivery_window_frais_end: str | None = None
    delivery_window_gel_start: str | None = None
    delivery_window_gel_end: str | None = None
    access_constraints: str | None = None
    allowed_vehicle_types: str | None = None
    delivery_group: str | None = None
    site_plan_url: str | None = None
    region_id: int | None = None


class PDVRead(PDVBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
