"""Schémas Distancier / Distance matrix schemas."""

from pydantic import BaseModel, ConfigDict


class DistanceMatrixBase(BaseModel):
    origin_type: str
    origin_id: int
    destination_type: str
    destination_id: int
    distance_km: float
    duration_minutes: int


class DistanceMatrixCreate(DistanceMatrixBase):
    pass


class DistanceMatrixUpdate(BaseModel):
    distance_km: float | None = None
    duration_minutes: int | None = None


class DistanceMatrixRead(DistanceMatrixBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    origin_label: str | None = None
    destination_label: str | None = None
    # Distance estimee et non mesuree (#96) : l'interface doit le dire.
    is_estimated: bool = False
