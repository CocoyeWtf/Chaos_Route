"""Schémas Volume / Volume schemas."""

from pydantic import BaseModel, ConfigDict

from app.models.volume import TemperatureClass


class VolumeBase(BaseModel):
    pdv_id: int
    date: str
    nb_colis: int | None = None
    eqp_count: float
    weight_kg: float | None = None
    temperature_class: TemperatureClass
    base_origin_id: int
    preparation_start: str | None = None
    preparation_end: str | None = None
    dispatch_date: str | None = None
    dispatch_time: str | None = None
    activity_type: str | None = None      # 'SUIVI' | 'MEAV'
    promo_start_date: str | None = None   # YYYY-MM-DD
    volume_m3: float | None = None
    nb_supports: int | None = None


class VolumeCreate(VolumeBase):
    pass


class VolumeUpdate(BaseModel):
    pdv_id: int | None = None
    date: str | None = None
    nb_colis: int | None = None
    eqp_count: float | None = None
    weight_kg: float | None = None
    temperature_class: TemperatureClass | None = None
    base_origin_id: int | None = None
    preparation_start: str | None = None
    preparation_end: str | None = None
    dispatch_date: str | None = None
    dispatch_time: str | None = None
    activity_type: str | None = None
    promo_start_date: str | None = None
    volume_m3: float | None = None
    nb_supports: int | None = None


class VolumeRead(VolumeBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tour_id: int | None = None
    split_group_id: int | None = None
    # Reste à quai (#68) : marchandise non chargée, remise à disposition.
    is_raq: bool = False
    raq_from_tour_code: str | None = None
    # Numéro/nom du PDV (résolus côté serveur) — l'UI affiche toujours le vrai
    # code PDV même si la liste PDV n'est pas chargée. / PDV code/name from server.
    pdv_code: str | None = None
    pdv_name: str | None = None


class VolumeSplit(BaseModel):
    """Quantité EQP à garder dans ce volume / EQP count to keep in this volume."""
    eqp_count: float
