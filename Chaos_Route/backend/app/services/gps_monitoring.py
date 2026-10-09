"""Detection des coupures de signal GPS / GPS signal loss detection.

Pourquoi ce service existe : on ne peut PAS empecher un chauffeur de refuser la
permission de localisation — aucun code applicatif n'y arrive, seul un MDM
(Android Enterprise, mode device owner) peut la pre-accorder et la verrouiller.
La seule parade disponible est donc de rendre la coupure **visible et
attribuable** : une tournee en cours qui n'emet plus leve une alerte nominative,
immediatement lisible par l'exploitation. Couper son GPS ne fait plus
disparaitre, ca allume un voyant. /
An app cannot prevent permission denial — only an MDM can. So instead of
preventing it, we make it visible: an active tour that stops emitting raises a
named alert.

Deux sources complementaires :
  - l'app signale explicitement son etat (permission refusee, GPS indisponible)
    → alerte immediate, avec la raison ;
  - ce detecteur cote serveur repere le silence → attrape aussi l'app tuee, le
    telephone eteint et le mode avion, que l'app ne peut evidemment pas
    signaler elle-meme.

Ce module porte aussi la surveillance « telephone non rentre sur base » (#99) :
un materiel qui ne revient pas est un cout reel, mais le suivre en continu hors
tournee reviendrait a suivre une personne en dehors de son temps de travail, ce
que le registre des traitements exclut. On regarde donc la FIN d'une tournee —
ou le telephone a emis pour la derniere fois — et rien d'autre.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.base_logistics import BaseLogistics
from app.models.delivery_alert import AlertSeverity, AlertType, DeliveryAlert
from app.models.device_assignment import DeviceAssignment
from app.models.gps_position import GPSPosition
from app.models.mobile_device import MobileDevice
from app.models.stop_event import StopEvent
from app.models.tour import Tour, TourStatus, return_base_of
from app.models.tour_stop import TourStop
from app.utils.geo import haversine

logger = logging.getLogger(__name__)

# Note multi-tenant : aucun bypass de filtre ici. La tache de fond ouvre une
# session sans tenant courant — le filtre est alors inactif et le detecteur
# voit tous les tenants. Appele depuis une requete, il ne voit que le tenant de
# l'appelant, ce qui est exactement ce qu'on veut. / No tenant bypass needed:
# the background session has no current tenant, a request-scoped one does.

# Statuts consideres comme « en tournee » / Statuses counting as on the road
ACTIVE_STATUSES = (TourStatus.IN_PROGRESS, TourStatus.RETURNING)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(value: str | None) -> datetime | None:
    """Horodatage ISO tolerant : les appareils envoient avec ou sans fuseau."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    # Un horodatage naif vient d'un appareil regle en UTC (cf. toISOString).
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def _has_open_alert(session: AsyncSession, tour_id: int, alert_type: AlertType) -> bool:
    """Alerte de ce type deja ouverte sur ce tour ? / Already an open alert?

    Une seule alerte par episode : tant que l'exploitation ne l'a pas
    acquittee, on n'en empile pas d'autres. Une fois acquittee, un nouvel
    episode en leve une nouvelle. / One alert per episode.
    """
    result = await session.execute(
        select(DeliveryAlert.id).where(
            DeliveryAlert.tour_id == tour_id,
            DeliveryAlert.alert_type == alert_type,
            DeliveryAlert.acknowledged_at.is_(None),
        ).limit(1)
    )
    return result.scalar_one_or_none() is not None


async def _raise_alert(
    session: AsyncSession,
    tour: Tour,
    alert_type: AlertType,
    message: str,
    *,
    device_id: int | None = None,
    severity: AlertSeverity = AlertSeverity.WARNING,
) -> DeliveryAlert | None:
    """Lever une alerte si aucune du meme type n'est ouverte sur ce tour."""
    if await _has_open_alert(session, tour.id, alert_type):
        return None
    alert = DeliveryAlert(
        tour_id=tour.id,
        alert_type=alert_type,
        severity=severity,
        message=message,
        created_at=_now().isoformat(timespec="seconds"),
        device_id=device_id,
    )
    # La tache de fond n'a pas de tenant en session : sans cette ligne l'alerte
    # naitrait sans tenant et serait invisible de tous. / The background task
    # has no session tenant, so stamp it explicitly.
    alert.tenant_id = tour.tenant_id
    session.add(alert)
    await session.flush()
    return alert


async def raise_no_gps_alert(
    session: AsyncSession,
    tour: Tour,
    message: str,
    *,
    device_id: int | None = None,
    severity: AlertSeverity = AlertSeverity.WARNING,
) -> DeliveryAlert | None:
    """Lever une alerte NO_GPS si aucune n'est deja ouverte sur ce tour."""
    return await _raise_alert(
        session, tour, AlertType.NO_GPS, message,
        device_id=device_id, severity=severity,
    )


async def detect_gps_silence(
    session: AsyncSession,
    *,
    silence_minutes: int,
    now: datetime | None = None,
) -> list[DeliveryAlert]:
    """Lever une alerte pour chaque tournee active devenue muette.

    Reference de temps : la derniere position recue ; a defaut, le premier
    evenement d'arret du tour (le scan d'arrivee, qui est justement ce qui a
    fait passer la tournee « en cours »). Sans aucune des deux, on ne juge pas —
    mieux vaut rater un cas que crier au loup. / Reference: last position, else
    first stop event; neither means no verdict.
    """
    now = now or _now()
    cutoff = now - timedelta(minutes=silence_minutes)

    # Bornage : on ne regarde que les tournees d'hier et d'aujourd'hui. Une
    # tournee restee « en cours » par oubli ne doit pas alerter indefiniment. /
    # Only yesterday's and today's tours, so a forgotten open tour stops nagging.
    since_date = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    tours = (await session.execute(
        select(Tour)
        .where(Tour.status.in_(ACTIVE_STATUSES), Tour.date >= since_date)
    )).scalars().all()
    if not tours:
        return []

    tour_ids = [t.id for t in tours]

    last_gps = dict((await session.execute(
        select(GPSPosition.tour_id, func.max(GPSPosition.timestamp))
        .where(GPSPosition.tour_id.in_(tour_ids))
        .group_by(GPSPosition.tour_id)
    )).all())

    first_event = dict((await session.execute(
        select(TourStop.tour_id, func.min(StopEvent.timestamp))
        .join(StopEvent, StopEvent.tour_stop_id == TourStop.id)
        .where(TourStop.tour_id.in_(tour_ids))
        .group_by(TourStop.tour_id)
    )).all())

    raised: list[DeliveryAlert] = []
    for tour in tours:
        last_position = _parse_iso(last_gps.get(tour.id))
        reference = last_position or _parse_iso(first_event.get(tour.id))
        if reference is None or reference > cutoff:
            continue

        minutes = int((now - reference).total_seconds() // 60)
        driver = tour.driver_name or "chauffeur inconnu"
        if last_position is None:
            message = (
                f"Aucune position GPS recue depuis le debut de la tournee "
                f"{tour.code} ({driver}) — {minutes} min. Verifier que la "
                f"localisation est activee sur le telephone."
            )
        else:
            message = (
                f"Signal GPS perdu depuis {minutes} min sur la tournee "
                f"{tour.code} ({driver})."
            )

        alert = await raise_no_gps_alert(session, tour, message)
        if alert is not None:
            raised.append(alert)

    return raised


async def detect_devices_away_from_base(
    session: AsyncSession,
    *,
    radius_km: float,
    quiet_minutes: int,
    now: datetime | None = None,
) -> list[DeliveryAlert]:
    """Telephones dont la tournee s'est terminee loin de leur base (#99).

    On ne juge qu'une tournee RETURNING ou COMPLETED dont le telephone s'est
    TU depuis `quiet_minutes` : tant qu'il emet, il est peut-etre encore sur la
    route du retour, et une alerte serait fausse. Sans position, pas de verdict
    — le silence complet est deja couvert par l'alerte NO_GPS. /
    Only judge a finished tour whose phone has gone quiet.
    """
    now = now or _now()
    cutoff = now - timedelta(minutes=quiet_minutes)
    since_date = (now - timedelta(days=1)).strftime("%Y-%m-%d")

    tours = (await session.execute(
        select(Tour).where(
            Tour.status.in_((TourStatus.RETURNING, TourStatus.COMPLETED)),
            Tour.date >= since_date,
        )
    )).scalars().all()
    if not tours:
        return []

    tour_ids = [t.id for t in tours]
    last_gps = dict((await session.execute(
        select(GPSPosition.tour_id, func.max(GPSPosition.timestamp))
        .where(GPSPosition.tour_id.in_(tour_ids))
        .group_by(GPSPosition.tour_id)
    )).all())

    raised: list[DeliveryAlert] = []
    for tour in tours:
        horodatage = _parse_iso(last_gps.get(tour.id))
        if horodatage is None or horodatage > cutoff:
            continue

        position = (await session.execute(
            select(GPSPosition)
            .where(GPSPosition.tour_id == tour.id)
            .order_by(GPSPosition.timestamp.desc())
            .limit(1)
        )).scalar_one_or_none()
        if position is None or position.latitude is None or position.longitude is None:
            continue

        base = await session.get(BaseLogistics, return_base_of(tour))
        if base is None or base.latitude is None or base.longitude is None:
            # Base sans coordonnees : on ne peut rien affirmer, et une alerte
            # non fondee userait l'attention de l'exploitation.
            continue

        distance = haversine(
            position.latitude, position.longitude, base.latitude, base.longitude)
        if distance <= radius_km:
            continue

        device = (await session.execute(
            select(MobileDevice)
            .join(DeviceAssignment, DeviceAssignment.device_id == MobileDevice.id)
            .where(DeviceAssignment.tour_id == tour.id)
            .limit(1)
        )).scalar_one_or_none()

        nom_appareil = (device.friendly_name if device else None) or "appareil inconnu"
        driver = tour.driver_name or "chauffeur inconnu"
        message = (
            f"Telephone « {nom_appareil} » ({driver}, tournee {tour.code}) : "
            f"derniere position connue a {distance:.1f} km de {base.name}, "
            f"le {horodatage.strftime('%d/%m a %Hh%M')}. Verifier que le "
            f"materiel est bien rentre."
        )
        alerte = await _raise_alert(
            session, tour, AlertType.DEVICE_NOT_AT_BASE, message,
            device_id=device.id if device else None,
            severity=AlertSeverity.WARNING,
        )
        if alerte is not None:
            raised.append(alerte)

    return raised


async def gps_monitor_scheduler(interval_minutes: int, silence_minutes: int) -> None:
    """Boucle de surveillance (tache de fond) / Monitoring background loop."""
    from app.database import async_session

    while True:
        await asyncio.sleep(interval_minutes * 60)
        try:
            async with async_session() as session:
                raised = await detect_gps_silence(session, silence_minutes=silence_minutes)
                if raised:
                    logger.warning("Coupure GPS detectee sur %d tournee(s)", len(raised))
                absents = await detect_devices_away_from_base(
                    session,
                    radius_km=settings.DEVICE_BASE_RADIUS_KM,
                    quiet_minutes=settings.DEVICE_BASE_QUIET_MINUTES,
                )
                if absents:
                    logger.warning(
                        "Telephone(s) non rentre(s) sur base : %d", len(absents))
                if raised or absents:
                    await session.commit()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Echec de la surveillance GPS (nouvelle tentative au prochain cycle)")
