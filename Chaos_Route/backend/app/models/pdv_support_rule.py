"""Modele visibilite des supports par PDV / Per-PDV support visibility model.

Quels types de support apparaissent dans l'app du magasin au moment d'encoder
un retour. Regle absente pour un couple PDV/support → **visible**, comme
`BaseSupportRule` : c'est une logique de masquage, pas d'autorisation. Un type
de support cree plus tard apparait donc partout tout seul, au lieu de rester
invisible chez les 170 PDV jusqu'a ce que quelqu'un y pense (#105).

Ne commande que l'affichage : un support masque reste parfaitement reprenable
cote serveur, et les reprises deja encodees dessus ne bougent pas. /
Per-PDV display filter for the store return form. Missing rule = visible.
"""

from sqlalchemy import Boolean, ForeignKey, Index, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class PdvSupportRule(Base):
    """Visibilite d'un type de support dans l'app d'un PDV / Support visibility for a PDV."""
    __tablename__ = "pdv_support_rules"
    __table_args__ = (
        Index("ix_pdv_support_rules_pdv_support", "pdv_id", "support_type_id", unique=True),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    pdv_id: Mapped[int] = mapped_column(ForeignKey("pdvs.id"), nullable=False)
    support_type_id: Mapped[int] = mapped_column(ForeignKey("support_types.id"), nullable=False)
    visible: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Relations
    pdv: Mapped["PDV"] = relationship()
    support_type: Mapped["SupportType"] = relationship()
