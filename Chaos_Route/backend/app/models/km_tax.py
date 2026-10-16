"""Modèle Taxe au kilomètre / Km tax model (matrix like distance_matrix)."""

from sqlalchemy import Index, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.mixins import TenantMixin


class KmTax(Base, TenantMixin):
    """Taxe au km par segment origine→destination / Km tax per origin→destination segment."""
    __tablename__ = "km_tax"
    __table_args__ = (
        # Le couple origine/destination est LA cle de recherche : toutes les
        # lectures passent par la, dans un sens ou dans l'autre. Sans index,
        # chaque appel balayait les 26 000 lignes — 2,8 milliards de lignes
        # lues cumulees en production au 2026-10-16, pour deux tables qui
        # tiennent dans 5 Mo.
        #
        # L'index couvre les deux sens parce que `_get_distance` interroge
        # aussi la paire inversee : le distancier est symetrique, mais il n'est
        # stocke que dans un sens.
        Index(
            "ix_km_tax_origine_destination",
            "origin_type", "origin_id", "destination_type", "destination_id",
        ),
        Index(
            "ix_km_tax_destination_origine",
            "destination_type", "destination_id", "origin_type", "origin_id",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    origin_type: Mapped[str] = mapped_column(String(20), nullable=False)   # BASE, PDV
    origin_id: Mapped[int] = mapped_column(Integer, nullable=False)
    destination_type: Mapped[str] = mapped_column(String(20), nullable=False)
    destination_id: Mapped[int] = mapped_column(Integer, nullable=False)
    tax_per_km: Mapped[float] = mapped_column(Numeric(8, 4), nullable=False)

    def __repr__(self) -> str:
        return f"<KmTax {self.origin_type}:{self.origin_id} -> {self.destination_type}:{self.destination_id}>"
