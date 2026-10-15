"""Accuses de rappel periodique / Periodic reminder acknowledgements (#17, #26).

Samuel a arbitre que certaines taches resteraient MANUELLES, a condition que
l'application les reclame tant qu'elles ne sont pas faites :

  #17 — « une alerte qui apparait tous les 3 mois sur les profils R-Cam au
         moment ou ils ouvrent CMRO pour leur rappeler de faire l'archive, le
         message doit s'afficher pour chaque profil R-CAM a chaque connexion
         tant que l'archive trimestrielle n'a pas ete faite » ;
  #26 — « une alerte hebdomadaire pour la mise a jour manuelle des prix du
         carburant, jusqu'a ce qu'un prix carburant soit encode pour la semaine
         en cours. L'alerte se lance chaque lundi a 8h. »

Une seule table pour les deux, et pour ceux qui viendront. Elle ne stocke que
les accuses EXPLICITES (« c'est fait ») : quand la tache laisse une trace
verifiable en base — un prix carburant encode cette semaine — c'est cette trace
qui fait foi, pas une case cochee. On ne demande a l'utilisateur de confirmer
que ce que le systeme ne peut pas constater lui-meme.

La cle de periode est lisible (« 2026-W42 », « 2026-Q4 ») : un accuse se rattache
a une periode precise, et le rappel revient tout seul a la suivante.
"""

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.mixins import TenantMixin


class ReminderAck(Base, TenantMixin):
    """« Cette tache a ete faite pour cette periode » / Task done for this period."""
    __tablename__ = "reminder_acks"
    __table_args__ = (
        Index("ix_reminder_acks_key_period", "reminder_key", "period_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # Identifiant du rappel, p. ex. « HISTORY_ARCHIVE » / Reminder identifier.
    reminder_key: Mapped[str] = mapped_column(String(50), nullable=False)
    # Periode concernee, p. ex. « 2026-Q4 » ou « 2026-W42 » / Period concerned.
    period_key: Mapped[str] = mapped_column(String(20), nullable=False)
    # Qui a confirme. L'accuse vaut pour toute la societe, pas pour le seul
    # utilisateur : l'archive trimestrielle se fait une fois, pas une fois par
    # personne. / Who confirmed; the ack covers the whole company.
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    user_name: Mapped[str | None] = mapped_column(String(150))
    acknowledged_at: Mapped[str | None] = mapped_column(DateTime, server_default=func.now())
    note: Mapped[str | None] = mapped_column(String(500))
