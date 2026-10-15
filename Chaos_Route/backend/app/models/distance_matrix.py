"""Modèle Distancier / Distance matrix model."""

from sqlalchemy import Boolean, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.mixins import TenantMixin


class DistanceMatrix(Base, TenantMixin):
    __tablename__ = "distance_matrix"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    origin_type: Mapped[str] = mapped_column(String(20), nullable=False)  # BASE, PDV, SUPPLIER
    origin_id: Mapped[int] = mapped_column(Integer, nullable=False)
    destination_type: Mapped[str] = mapped_column(String(20), nullable=False)
    destination_id: Mapped[int] = mapped_column(Integer, nullable=False)
    distance_km: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    duration_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    # Distance ESTIMEE (vol d'oiseau x coefficient) et non mesuree (#96).
    # Une paire absente du distancier valait silencieusement 0 km et 0 minute :
    # toute tournee au depart de Trazegnies sortait avec un kilometrage, un
    # carburant et une taxe km nuls. Une estimation grossiere mais signalee vaut
    # mieux qu'un zero muet ; le drapeau permet de la remplacer sans hesiter des
    # que la vraie valeur arrive. / Estimated, not measured: a missing pair used
    # to silently count as 0 km.
    is_estimated: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False,
    )

    def __repr__(self) -> str:
        return f"<Distance {self.origin_type}:{self.origin_id} -> {self.destination_type}:{self.destination_id}>"
