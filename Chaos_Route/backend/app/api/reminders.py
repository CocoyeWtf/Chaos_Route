"""Rappels periodiques affiches a la connexion / Periodic login reminders (#17, #26).

Samuel a choisi de garder deux taches manuelles, a condition que l'application
les reclame tant qu'elles ne sont pas faites. Le mecanisme est commun :

  - chaque rappel sait calculer la PERIODE en cours (trimestre, semaine) ;
  - il sait dire si la tache est faite pour cette periode, en regardant d'abord
    une trace reelle en base, et seulement a defaut un accuse explicite ;
  - il ne s'adresse qu'aux profils concernes, designes par la PERMISSION qui
    correspond a la tache plutot que par le nom d'un role : « R Cam » est le
    role d'aujourd'hui, la permission reste vraie demain.

Un rappel qui ne peut pas se verifier tout seul se solde par un bouton
« c'est fait » ; un rappel verifiable disparait de lui-meme des que la trace
existe, sans qu'on ait a cliquer quoi que ce soit.
"""

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.fuel_price import FuelPrice
from app.models.reminder_ack import ReminderAck
from app.models.user import User

router = APIRouter()

# Le lundi a 8 h, demande du #26. Avant cette heure-la, le rappel ne se declenche
# pas : personne n'encode un prix a 6 h du matin.
FUEL_REMINDER_WEEKDAY = 0   # lundi
FUEL_REMINDER_HOUR = 8


def _periode_semaine(moment: datetime) -> str:
    annee, semaine, _ = moment.isocalendar()
    return f"{annee}-W{semaine:02d}"


def _periode_trimestre(moment: datetime) -> str:
    return f"{moment.year}-Q{(moment.month - 1) // 3 + 1}"


def _bornes_semaine(moment: datetime) -> tuple[str, str]:
    """Lundi et dimanche de la semaine ISO, en YYYY-MM-DD."""
    lundi = date.fromordinal(moment.date().toordinal() - moment.weekday())
    dimanche = date.fromordinal(lundi.toordinal() + 6)
    return lundi.isoformat(), dimanche.isoformat()


def _a_la_permission(user: User, resource: str, action: str) -> bool:
    if user.is_superadmin:
        return True
    return any(
        p.resource == resource and p.action == action
        for role in user.roles for p in role.permissions
    )


async def _accuse_existe(db: AsyncSession, cle: str, periode: str) -> ReminderAck | None:
    return (await db.execute(
        select(ReminderAck).where(
            ReminderAck.reminder_key == cle,
            ReminderAck.period_key == periode,
        ).limit(1)
    )).scalars().first()


async def _prix_carburant_de_la_semaine(db: AsyncSession, moment: datetime) -> bool:
    """Un prix couvre-t-il la semaine en cours ? / Is a price covering this week?

    On regarde la DONNEE, pas un accuse : si quelqu'un a encode le prix, le
    rappel doit disparaitre sans que personne ait a cliquer « c'est fait ».
    """
    lundi, dimanche = _bornes_semaine(moment)
    ligne = (await db.execute(
        select(FuelPrice.id).where(
            FuelPrice.start_date <= dimanche,
            FuelPrice.end_date >= lundi,
        ).limit(1)
    )).scalars().first()
    return ligne is not None


class ReminderAckRequest(BaseModel):
    note: str | None = None


@router.get("/")
async def list_reminders(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Rappels dus pour l'utilisateur connecte / Reminders due for this user.

    Appele au chargement de l'application. Renvoie une liste vide la plupart du
    temps — c'est le cas normal, et il doit couter une requete, pas dix.
    """
    maintenant = datetime.now()
    rappels: list[dict] = []

    # ── #26 : prix du carburant, chaque lundi a 8 h ───────────────────────
    if _a_la_permission(user, "fuel-prices", "update"):
        declenche = (
            maintenant.weekday() > FUEL_REMINDER_WEEKDAY
            or (maintenant.weekday() == FUEL_REMINDER_WEEKDAY
                and maintenant.hour >= FUEL_REMINDER_HOUR)
        )
        if declenche:
            periode = _periode_semaine(maintenant)
            fait = await _prix_carburant_de_la_semaine(db, maintenant)
            if not fait and not await _accuse_existe(db, "FUEL_PRICE", periode):
                lundi, dimanche = _bornes_semaine(maintenant)
                rappels.append({
                    "key": "FUEL_PRICE",
                    "period_key": periode,
                    "title": "Prix du carburant de la semaine",
                    "message": (
                        f"Aucun prix carburant ne couvre la semaine du {lundi} au "
                        f"{dimanche}. Sans lui, le cout carburant des tournees de "
                        f"la semaine est calcule a zero."
                    ),
                    "link": "/fuel-prices",
                    "link_label": "Encoder le prix",
                    # Verifiable tout seul : pas de bouton « c'est fait », le
                    # rappel disparait des que le prix est encode.
                    "acknowledgeable": False,
                    "severity": "HIGH",
                })

    # ── #17 : archive trimestrielle de l'historique ───────────────────────
    if _a_la_permission(user, "tour-history", "read"):
        periode = _periode_trimestre(maintenant)
        if not await _accuse_existe(db, "HISTORY_ARCHIVE", periode):
            rappels.append({
                "key": "HISTORY_ARCHIVE",
                "period_key": periode,
                "title": f"Archive trimestrielle de l'historique ({periode})",
                "message": (
                    "L'historique est conserve en ligne sur l'annee en cours et "
                    "N-1. Au-dela, l'export Excel est la seule archive : exportez "
                    "l'historique des tournees, rangez le fichier, puis confirmez ici."
                ),
                "link": "/tour-history",
                "link_label": "Ouvrir l'historique",
                # L'application ne peut pas constater qu'un fichier a ete range
                # quelque part : c'est le seul cas ou l'on demande une confirmation.
                "acknowledgeable": True,
                "severity": "MEDIUM",
            })

    return rappels


@router.post("/{reminder_key}/ack")
async def acknowledge_reminder(
    reminder_key: str,
    data: ReminderAckRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Confirmer qu'une tache periodique a ete faite / Mark a periodic task done.

    L'accuse vaut pour toute la societe et pour la periode en cours : l'archive
    trimestrielle se fait une fois, pas une fois par personne. Il nomme son
    auteur, parce qu'une tache declaree faite doit pouvoir etre retracee.
    """
    maintenant = datetime.now()
    if reminder_key == "HISTORY_ARCHIVE":
        if not _a_la_permission(user, "tour-history", "read"):
            raise HTTPException(status_code=403, detail="Permission required: tour-history:read")
        periode = _periode_trimestre(maintenant)
    elif reminder_key == "FUEL_PRICE":
        if not _a_la_permission(user, "fuel-prices", "update"):
            raise HTTPException(status_code=403, detail="Permission required: fuel-prices:update")
        periode = _periode_semaine(maintenant)
    else:
        raise HTTPException(status_code=404, detail="Rappel inconnu")

    existant = await _accuse_existe(db, reminder_key, periode)
    if existant:
        return {"reminder_key": reminder_key, "period_key": periode, "already": True}

    db.add(ReminderAck(
        reminder_key=reminder_key,
        period_key=periode,
        user_id=user.id,
        user_name=getattr(user, "username", None),
        note=data.note,
    ))
    await db.flush()
    return {"reminder_key": reminder_key, "period_key": periode, "already": False}
