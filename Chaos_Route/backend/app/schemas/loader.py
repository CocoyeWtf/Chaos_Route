"""Schémas Chargeur / Loader schemas."""

from pydantic import BaseModel, ConfigDict


class LoaderBase(BaseModel):
    code: str
    name: str
    base_id: int
    # Seconde base de rattachement, facultative (#63)
    secondary_base_id: int | None = None


class LoaderCreate(LoaderBase):
    pass


class LoaderUpdate(BaseModel):
    code: str | None = None
    name: str | None = None
    base_id: int | None = None
    secondary_base_id: int | None = None


class LoaderRead(LoaderBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
