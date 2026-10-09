"""RGPD — Purge et anonymisation des données personnelles / GDPR — Personal data purge and anonymization.

Données personnelles dans le module booking:
- BookingCheckin: license_plate, phone_number, driver_name
- SmsQueue: phone, body (peut contenir des noms)
- Booking: supplier_name (nom commercial, pas perso — conservé)

Politique de retention:
- Données chauffeurs (plaques, tel, noms) : 90 jours après COMPLETED
- SMS : 30 jours après envoi
- Bookings eux-mêmes : conservés (données commerciales)
"""

import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.consent_record import ConsentRecord
from app.models.mobile_device import MobileDevice
from app.models.reception_booking import Booking, BookingCheckin, BookingStatus
from app.models.sms_queue import SmsQueue
from app.models.tour import Tour
from app.models.user import User
from app.models.audit import AuditLog
from app.api.deps import get_authenticated_device, get_current_user, require_permission
from app.services.consent import (
    GPS_PRIVACY_NOTICE,
    GPS_PRIVACY_NOTICE_VERSION,
    GPS_TRACKING,
    get_latest_consent,
    record_consent,
)

router = APIRouter()


def _now_iso() -> str:
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("Europe/Brussels")).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Géolocalisation : information (accusé de lecture) et journal des choix
# historiques (STIME A7 / action DPIA A3). Voir app/services/consent.py : la
# captation ne dépend plus d'un consentement, c'est l'information qui est tracée.
# ---------------------------------------------------------------------------

class ConsentInput(BaseModel):
    """Accusé de lecture de la notice, ou choix historique / Notice acknowledgement.

    `granted=True` sur le type `gps_information` signifie « notice lue », pas
    « je consens » : la géolocalisation repose sur l'intérêt légitime. /
    granted=True on gps_information means "notice read", not consent."""
    consent_type: str = Field(default=GPS_TRACKING, max_length=50)
    granted: bool
    subject_name: str | None = Field(default=None, max_length=150)
    info_version: str | None = Field(default=None, max_length=20)


@router.get("/privacy-notice/gps")
async def gps_privacy_notice():
    """Notice d'information géolocalisation, affichée par l'app mobile /
    GPS privacy notice, displayed by the mobile app."""
    return {"version": GPS_PRIVACY_NOTICE_VERSION, "text": GPS_PRIVACY_NOTICE}


@router.post("/consent/device")
async def record_device_consent(
    data: ConsentInput,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Enregistrer le choix du chauffeur sur cet appareil (append-only, tracé) /
    Record the driver's choice on this device (append-only, audited)."""
    record = await record_consent(
        db,
        consent_type=data.consent_type,
        granted=data.granted,
        device_id=device.id,
        subject_name=data.subject_name,
        info_version=data.info_version or GPS_PRIVACY_NOTICE_VERSION,
        source="mobile_app",
    )
    db.add(AuditLog(
        entity_type="consent", entity_id=record.id,
        action="CONSENT_GRANTED" if data.granted else "CONSENT_REVOKED",
        changes=json.dumps({
            "type": data.consent_type, "device_id": device.id,
            "subject": data.subject_name, "version": record.info_version,
        }, ensure_ascii=False),
        user=f"device:{device.id}", timestamp=_now_iso(),
    ))
    await db.flush()
    return {"ok": True, "consent_type": data.consent_type, "granted": data.granted}


@router.get("/consent/device/{consent_type}")
async def get_device_consent(
    consent_type: str,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """État courant du consentement pour cet appareil / Current consent state.

    granted=None : rien d'enregistré pour ce type (l'app doit afficher la notice).
    """
    latest = await get_latest_consent(db, consent_type, device_id=device.id)
    return {
        "consent_type": consent_type,
        "granted": latest.granted if latest else None,
        "recorded_at": latest.recorded_at if latest else None,
        "notice_version": GPS_PRIVACY_NOTICE_VERSION,
    }


@router.get("/consents/")
async def list_consents(
    limit: int = 200,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("parameters", "read")),
):
    """Journal des consentements (traçabilité) / Consent log (traceability)."""
    result = await db.execute(
        select(ConsentRecord).order_by(ConsentRecord.id.desc()).limit(min(limit, 1000))
    )
    return [
        {
            "id": c.id, "consent_type": c.consent_type, "granted": c.granted,
            "device_id": c.device_id, "user_id": c.user_id,
            "subject_name": c.subject_name, "info_version": c.info_version,
            "source": c.source, "recorded_at": c.recorded_at,
        }
        for c in result.scalars().all()
    ]


# ---------------------------------------------------------------------------
# Portabilité — Art. 20 RGPD (STIME A7)
# ---------------------------------------------------------------------------

@router.get("/my-data")
async def export_my_data(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Export self-service des données de l'utilisateur connecté (Art. 20) /
    Self-service export of the current user's data (JSON, machine-readable)."""
    # Journal d'audit : actions effectuées par l'utilisateur / User's own actions
    audit_rows = (await db.execute(
        select(AuditLog).where(AuditLog.user == user.username)
        .order_by(AuditLog.id.desc()).limit(5000)
    )).scalars().all()

    # Tournées conduites (si chauffeur) / Tours driven (if driver)
    tours = (await db.execute(
        select(Tour.id, Tour.code, Tour.date).where(Tour.driver_user_id == user.id)
        .order_by(Tour.date.desc()).limit(1000)
    )).fetchall()

    consents = (await db.execute(
        select(ConsentRecord).where(ConsentRecord.user_id == user.id)
        .order_by(ConsentRecord.id)
    )).scalars().all()

    return {
        "format": "chaos-route-gdpr-export/1.0",
        "generated_at": _now_iso(),
        "profile": {
            "id": user.id,
            "username": user.username,
            "email": user.email,
            "badge_code": user.badge_code,
            "default_route": user.default_route,
            "roles": [r.name for r in user.roles],
            "regions": [r.name for r in user.regions],
            "created_at": str(user.created_at),
        },
        "consents": [
            {"type": c.consent_type, "granted": c.granted, "recorded_at": c.recorded_at}
            for c in consents
        ],
        "tours_driven": [
            {"id": t.id, "code": t.code, "date": t.date} for t in tours
        ],
        "activity_log": [
            {"action": a.action, "entity": f"{a.entity_type}:{a.entity_id}", "timestamp": a.timestamp}
            for a in audit_rows
        ],
    }


@router.get("/export-driver/")
async def export_driver_data(
    license_plate: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("parameters", "read")),
):
    """Export des données d'un chauffeur externe par plaque (droit d'accès /
    portabilité pour les personnes sans compte) / External driver data export."""
    checkins = (await db.execute(
        select(BookingCheckin).where(BookingCheckin.license_plate == license_plate)
    )).scalars().all()
    if not checkins:
        raise HTTPException(status_code=404, detail="Aucune donnée trouvée pour cette plaque")

    booking_ids = [ci.booking_id for ci in checkins]
    sms = (await db.execute(
        select(SmsQueue).where(SmsQueue.booking_id.in_(booking_ids))
    )).scalars().all()

    db.add(AuditLog(
        entity_type="gdpr", entity_id=0, action="EXPORT_DRIVER_DATA",
        changes=json.dumps({"plate": license_plate, "checkins": len(checkins)}, ensure_ascii=False),
        user=user.username, timestamp=_now_iso(),
    ))
    await db.flush()

    return {
        "format": "chaos-route-gdpr-export/1.0",
        "generated_at": _now_iso(),
        "license_plate": license_plate,
        "checkins": [
            {
                "booking_id": ci.booking_id, "driver_name": ci.driver_name,
                "phone_number": ci.phone_number, "checkin_at": getattr(ci, "checkin_at", None),
            }
            for ci in checkins
        ],
        "sms": [
            {"phone": s.phone, "body": s.body, "status": s.status, "sent_at": s.sent_at}
            for s in sms
        ],
    }


@router.post("/purge-personal-data/")
async def purge_personal_data(
    days_retention: int = 90,
    dry_run: bool = True,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("parameters", "delete")),
):
    """Anonymiser les donnees personnelles des bookings termines depuis plus de N jours.
    RGPD : droit a l'oubli / Anonymize personal data from bookings completed more than N days ago."""
    from zoneinfo import ZoneInfo
    cutoff = (datetime.now(ZoneInfo("Europe/Brussels")) - timedelta(days=days_retention)).strftime("%Y-%m-%d")

    # Trouver les checkins a anonymiser / Find checkins to anonymize
    result = await db.execute(
        select(BookingCheckin).join(Booking).where(
            Booking.status.in_([BookingStatus.COMPLETED, BookingStatus.CANCELLED, BookingStatus.REFUSED]),
            Booking.booking_date < cutoff,
            BookingCheckin.license_plate != "***",  # Pas deja anonymise
        )
    )
    checkins = result.scalars().all()

    # Trouver les SMS a purger / Find SMS to purge
    sms_cutoff = (datetime.now(ZoneInfo("Europe/Brussels")) - timedelta(days=30)).isoformat()
    sms_result = await db.execute(
        select(SmsQueue).where(
            SmsQueue.status == "SENT",
            SmsQueue.sent_at < sms_cutoff,
        )
    )
    sms_to_purge = sms_result.scalars().all()

    if dry_run:
        return {
            "dry_run": True,
            "checkins_to_anonymize": len(checkins),
            "sms_to_purge": len(sms_to_purge),
            "cutoff_date": cutoff,
            "message": "Aucune donnee modifiee. Relancer avec dry_run=false pour executer.",
        }

    # Anonymiser les checkins / Anonymize checkins
    for ci in checkins:
        ci.license_plate = "***"
        ci.phone_number = "***"
        ci.driver_name = None

    # Purger les SMS / Purge SMS
    for sms in sms_to_purge:
        sms.phone = "***"
        sms.body = "[purge RGPD]"

    await db.flush()

    # Audit log
    db.add(AuditLog(
        entity_type="gdpr",
        entity_id=0,
        action="PURGE_PERSONAL_DATA",
        changes=json.dumps({
            "checkins_anonymized": len(checkins),
            "sms_purged": len(sms_to_purge),
            "retention_days": days_retention,
            "cutoff_date": cutoff,
        }, ensure_ascii=False),
        user=user.username,
        timestamp=_now_iso(),
    ))
    await db.flush()

    return {
        "dry_run": False,
        "checkins_anonymized": len(checkins),
        "sms_purged": len(sms_to_purge),
        "cutoff_date": cutoff,
    }


@router.post("/forget-driver/")
async def forget_driver(
    license_plate: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("parameters", "delete")),
):
    """Droit a l'oubli — supprimer toutes les donnees d'un chauffeur par plaque.
    RGPD Art. 17 / Right to be forgotten — erase all driver data by plate."""
    result = await db.execute(
        select(BookingCheckin).where(BookingCheckin.license_plate == license_plate)
    )
    checkins = result.scalars().all()

    if not checkins:
        raise HTTPException(status_code=404, detail="Aucune donnee trouvee pour cette plaque")

    count = 0
    for ci in checkins:
        ci.license_plate = "***"
        ci.phone_number = "***"
        ci.driver_name = None
        count += 1

    # Purger les SMS associes / Purge associated SMS
    booking_ids = [ci.booking_id for ci in checkins]
    sms_result = await db.execute(
        select(SmsQueue).where(SmsQueue.booking_id.in_(booking_ids))
    )
    for sms in sms_result.scalars().all():
        sms.phone = "***"
        sms.body = "[purge RGPD]"

    await db.flush()

    db.add(AuditLog(
        entity_type="gdpr",
        entity_id=0,
        action="FORGET_DRIVER",
        changes=json.dumps({"plate": license_plate, "checkins_erased": count}, ensure_ascii=False),
        user=user.username,
        timestamp=_now_iso(),
    ))
    await db.flush()

    return {"ok": True, "checkins_erased": count, "plate": license_plate}


@router.get("/data-inventory/")
async def data_inventory(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("parameters", "read")),
):
    """Registre de traitement RGPD — inventaire des donnees personnelles.
    RGPD Art. 30 / Processing registry — personal data inventory."""
    from sqlalchemy import func

    # Compter les checkins avec donnees personnelles
    ci_count = (await db.execute(
        select(func.count(BookingCheckin.id)).where(BookingCheckin.license_plate != "***")
    )).scalar() or 0

    ci_anonymized = (await db.execute(
        select(func.count(BookingCheckin.id)).where(BookingCheckin.license_plate == "***")
    )).scalar() or 0

    sms_count = (await db.execute(
        select(func.count(SmsQueue.id)).where(SmsQueue.phone != "***")
    )).scalar() or 0

    sms_purged = (await db.execute(
        select(func.count(SmsQueue.id)).where(SmsQueue.phone == "***")
    )).scalar() or 0

    return {
        "personal_data_categories": [
            {
                "category": "Donnees chauffeurs (checkins)",
                "fields": ["license_plate", "phone_number", "driver_name"],
                "active_records": ci_count,
                "anonymized_records": ci_anonymized,
                "retention_policy": "90 jours apres fin du booking",
                "legal_basis": "Interet legitime — gestion logistique reception",
            },
            {
                "category": "SMS envoyes",
                "fields": ["phone", "body"],
                "active_records": sms_count,
                "purged_records": sms_purged,
                "retention_policy": "30 jours apres envoi",
                "legal_basis": "Interet legitime — notification numero de quai",
            },
        ],
        "data_processor": "Heberge sur Hostinger (EU), Docker container",
        "dpo_contact": "A definir",
    }
