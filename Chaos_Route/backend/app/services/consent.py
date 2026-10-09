"""Journal d'information et de consentement / Information & consent journal.

État courant = dernière ligne du journal append-only
(app/models/consent_record.py).

**Géolocalisation : information, pas consentement.** Le registre CNIL
(traitement n°2) fonde la géolocalisation des chauffeurs sur l'INTÉRÊT LÉGITIME
(art. 6.1.f), et non sur le consentement — lequel n'est de toute façon pas une
base valable entre employeur et salarié : le lien de subordination prive le
consentement de son caractère libre. Ce qui est exigé, c'est l'information
individuelle (art. L.1222-4 du Code du travail) et collective (CSE), la
proportionnalité, et l'absence de suivi hors heures de travail.

L'opt-out en libre-service a donc été retiré : il était incohérent avec la base
légale déclarée, et il suffisait d'un bouton pour rendre un véhicule invisible.
Le droit d'opposition (art. 21) subsiste mais s'exerce auprès du responsable de
traitement / DPO, au cas par cas — pas par un interrupteur dans l'app. Les
refus enregistrés sous l'ancien type `gps_tracking` restent dans le journal
(append-only) à titre d'historique et ne conditionnent plus rien. /
Geolocation rests on legitimate interest, not consent: the self-service opt-out
was removed as inconsistent with the declared legal basis.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.consent_record import ConsentRecord

# Types journalisés / Journalled types
# Accusé de lecture de la notice géolocalisation : c'est la preuve de
# l'information individuelle exigée par L.1222-4, pas un consentement. /
# Acknowledgement of the GPS notice — proof of individual information.
GPS_INFORMATION = "gps_information"
# Ancien type « consentement / opt-out ». Conservé uniquement pour relire
# l'historique ; ne conditionne plus aucune captation. / Legacy opt-out type,
# history only.
GPS_TRACKING = "gps_tracking"

# Notice d'information géolocalisation, affichée par l'app mobile. Versionnée :
# chaque accusé de lecture enregistre la version affichée.
# La notice n'affirme PAS que les représentants du personnel ont été consultés :
# le registre des traitements porte encore cette ligne en « à vérifier », et une
# note d'information ne peut pas attester d'une formalité qui n'est pas prouvée.
# À rétablir le jour où la consultation sera documentée au registre. /
# The notice makes no claim about works-council consultation while the register
# still marks it unverified.
GPS_PRIVACY_NOTICE_VERSION = "2.0-2026-09"
GPS_PRIVACY_NOTICE = (
    "Suivi GPS des tournées — Note d'information (RGPD)\n\n"
    "Finalité : pendant vos tournées, l'application transmet la position du "
    "véhicule pour le suivi opérationnel en temps réel (avancement, alertes "
    "retard), la preuve de passage, la traçabilité des supports scannés et "
    "la sécurité des personnes et du matériel.\n\n"
    "Base légale : intérêt légitime de l'entreprise (art. 6.1.f du RGPD) — "
    "gestion de flotte, sécurité des biens et des personnes, preuve de "
    "livraison. Ce dispositif ne repose pas sur votre consentement : il fait "
    "partie des moyens de travail mis à votre disposition, et vous en êtes "
    "informé conformément à l'article L.1222-4 du Code du travail.\n\n"
    "Données : position, vitesse, précision, horodatage — uniquement pendant "
    "une tournée qui vous est assignée. Aucun suivi en dehors de vos heures "
    "de travail : la transmission cesse à la clôture de la tournée.\n\n"
    "Conservation : positions brutes conservées 60 jours puis supprimées "
    "automatiquement. Les positions attachées au scan d'un support sont "
    "conservées avec la preuve de livraison correspondante.\n\n"
    "Vos droits : accès, rectification, effacement, limitation, et droit "
    "d'opposition pour un motif tenant à votre situation particulière "
    "(art. 21) — exercez-les auprès de votre responsable ou du délégué à la "
    "protection des données, dont les coordonnées figurent au registre des "
    "traitements. Le suivi ne peut pas être désactivé depuis l'appareil ; "
    "toute interruption du signal pendant une tournée est signalée à "
    "l'exploitation."
)


async def get_latest_consent(
    session: AsyncSession,
    consent_type: str,
    device_id: int | None = None,
    user_id: int | None = None,
) -> ConsentRecord | None:
    """Dernier choix enregistré pour ce sujet / Latest recorded choice, or None."""
    query = select(ConsentRecord).where(ConsentRecord.consent_type == consent_type)
    if device_id is not None:
        query = query.where(ConsentRecord.device_id == device_id)
    if user_id is not None:
        query = query.where(ConsentRecord.user_id == user_id)
    result = await session.execute(query.order_by(ConsentRecord.id.desc()).limit(1))
    return result.scalars().first()


async def record_consent(
    session: AsyncSession,
    consent_type: str,
    granted: bool,
    device_id: int | None = None,
    user_id: int | None = None,
    subject_name: str | None = None,
    info_version: str | None = None,
    source: str | None = None,
) -> ConsentRecord:
    """Journaliser un choix (append-only) / Append a consent choice."""
    record = ConsentRecord(
        consent_type=consent_type,
        granted=granted,
        device_id=device_id,
        user_id=user_id,
        subject_name=subject_name,
        info_version=info_version,
        source=source,
        recorded_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    session.add(record)
    await session.flush()
    return record
