"""Routes Demandes de reprise / Pickup Request API routes."""

import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.pickup_request import PickupRequest, PickupLabel, PickupMovement, PickupStatus, LabelStatus, PickupType, MovementType
from app.models.support_type import SupportType
from app.models.pdv import PDV
from app.models.pdv_inventory import PdvStock
from app.models.control_evidence import ControlEvidence
from app.models.user import User
from app.models.label_print_event import LabelPrintEvent, PrintProtocol, PrintSource
from app.schemas.pickup import (
    PickupRequestCreate,
    PickupRequestRead,
    PickupRequestListRead,
    PickupRequestUpdate,
    PickupLabelRead,
    PdvPickupSummary,
    RenderedLabel,
    RenderLabelsResponse,
    LabelPrintEventCreate,
)
from app.api.deps import (
    require_permission, enforce_pdv_scope, get_authenticated_device, get_user_pdv_id,
)
from app.models.mobile_device import MobileDevice
from app.utils.label_templates import LabelData, render as render_label

router = APIRouter()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _enrich_with_label_counts(req: PickupRequest) -> dict:
    """Ajouter les compteurs labels au dict de reponse / Add label counts to response dict.

    Combi (support_type.is_combi=True) : compteurs bases sur quantity (stock declare)
    et actual_picked_quantity (nb scans chauffeur), pas sur le nb d'etiquettes (toujours 1).
    """
    data = PickupRequestListRead.model_validate(req, from_attributes=True)
    is_combi = bool(req.support_type and req.support_type.is_combi)

    if is_combi:
        data.total_labels = req.quantity
        picked = req.actual_picked_quantity or 0
        data.picked_up_count = picked
        data.received_count = picked if req.status == PickupStatus.RECEIVED else 0
        data.pending_count = max(0, req.quantity - picked) if req.status in (PickupStatus.REQUESTED, PickupStatus.PLANNED) else 0
    elif req.labels:
        active_labels = [lb for lb in req.labels if lb.status != LabelStatus.CANCELLED]
        data.total_labels = len(active_labels)
        data.picked_up_count = sum(1 for lb in active_labels if lb.status == LabelStatus.PICKED_UP)
        data.received_count = sum(1 for lb in active_labels if lb.status == LabelStatus.RECEIVED)
        data.pending_count = sum(1 for lb in active_labels if lb.status in (LabelStatus.PENDING, LabelStatus.PLANNED))
    else:
        data.total_labels = req.quantity
    return data


async def _update_pdv_stock_on_pickup(db: AsyncSession, pdv_id: int, support_type_id: int, delta: int = -1):
    """Mettre à jour le stock PDV lors d'une reprise / Update PDV stock on pickup.
    delta=-1 : chauffeur reprend (stock PDV diminue).
    """
    result = await db.execute(
        select(PdvStock).where(
            PdvStock.pdv_id == pdv_id,
            PdvStock.support_type_id == support_type_id,
        )
    )
    stock = result.scalar_one_or_none()
    if stock:
        stock.current_stock = max(0, stock.current_stock + delta)


def _create_movement(label: PickupLabel, movement_type: MovementType, device_id: int | None = None,
                     user_id: int | None = None, notes: str | None = None) -> PickupMovement:
    """Créer un enregistrement de mouvement / Create a movement record."""
    return PickupMovement(
        pickup_label_id=label.id,
        movement_type=movement_type,
        timestamp=_now_iso(),
        device_id=device_id,
        user_id=user_id,
        notes=notes,
    )


def _generate_label_code(pdv_code: str, support_code: str, date_str: str, seq: int) -> str:
    """Générer le code étiquette / Generate label code.
    Format : RET-{PDV_CODE}-{SUPPORT_CODE}-{YYYYMMDD}-{SEQ:03d}
    """
    date_compact = date_str.replace("-", "")
    return f"RET-{pdv_code}-{support_code}-{date_compact}-{seq:03d}"


async def _pickup_form_data(db: AsyncSession, scope_pdv_id: int | None) -> dict:
    """Données du formulaire (types de support actifs + PDV accessibles).
    scope_pdv_id : si fourni, n'expose que ce PDV (user PDV ou tablette)."""
    st_result = await db.execute(select(SupportType).where(SupportType.is_active == True).order_by(SupportType.code))
    support_types = st_result.scalars().all()

    pdv_query = select(PDV).order_by(PDV.code)
    if scope_pdv_id is not None:
        pdv_query = pdv_query.where(PDV.id == scope_pdv_id)
    pdv_result = await db.execute(pdv_query)
    pdvs = pdv_result.scalars().all()

    return {
        "support_types": [
            {
                "id": st.id, "code": st.code, "name": st.name,
                "short_code": st.short_code, "unit_quantity": st.unit_quantity,
                "unit_label": st.unit_label, "unit_value": st.unit_value,
                "content_item_label": st.content_item_label,
                "content_items_per_unit": st.content_items_per_unit,
                "content_item_value": st.content_item_value,
                "image_path": st.image_path,
                "is_combi": st.is_combi,
            }
            for st in support_types
        ],
        "pdvs": [{"id": p.id, "code": p.code, "name": p.name} for p in pdvs],
    }


@router.get("/form-data/")
async def pickup_form_data(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Données du formulaire de demande (utilisateur JWT, scopé à son PDV)."""
    return await _pickup_form_data(db, get_user_pdv_id(user))


@router.get("/device/form-data/")
async def pickup_form_data_device(
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Données du formulaire depuis une tablette magasin (auth appareil, scope device.pdv_id)."""
    if not device.pdv_id:
        raise HTTPException(status_code=403, detail="Appareil non rattaché à un PDV")
    return await _pickup_form_data(db, device.pdv_id)


@router.get("/", response_model=list[PickupRequestListRead])
async def list_pickup_requests(
    pdv_id: int | None = None,
    status: str | None = None,
    pickup_type: str | None = None,
    availability_date: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Liste des demandes de reprise avec filtres et compteurs labels / List pickup requests with filters and label counts."""
    # Forcer le scope PDV si utilisateur lié à un PDV / Enforce PDV scope
    pdv_id = enforce_pdv_scope(user, pdv_id)

    query = select(PickupRequest).options(
        selectinload(PickupRequest.pdv),
        selectinload(PickupRequest.support_type),
        selectinload(PickupRequest.pallet_support_type),
        selectinload(PickupRequest.labels),
    ).order_by(PickupRequest.id.desc())

    if pdv_id is not None:
        query = query.where(PickupRequest.pdv_id == pdv_id)
    if status is not None:
        query = query.where(PickupRequest.status == status)
    if pickup_type is not None:
        query = query.where(PickupRequest.pickup_type == pickup_type)
    if availability_date is not None:
        query = query.where(PickupRequest.availability_date == availability_date)

    result = await db.execute(query)
    requests = result.scalars().all()

    # Batch lookup evidences photo pour les labels / Batch lookup photo evidences for labels
    all_label_codes = [lb.label_code for req in requests for lb in (req.labels or [])]
    evidence_codes: set[str] = set()
    if all_label_codes:
        ev_result = await db.execute(
            select(ControlEvidence.label_code)
            .where(ControlEvidence.label_code.in_(all_label_codes))
            .distinct()
        )
        evidence_codes = {row[0] for row in ev_result.all() if row[0]}

    enriched = []
    for req in requests:
        data = _enrich_with_label_counts(req)
        req_evidence_codes = [lb.label_code for lb in (req.labels or []) if lb.label_code in evidence_codes]
        data.evidence_label_codes = req_evidence_codes
        enriched.append(data)

    return enriched


@router.get("/by-pdv/pending/", response_model=list[PdvPickupSummary])
async def pending_by_pdv(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Résumé des reprises en attente par PDV (pour planning) / Pending pickups summary by PDV (for planning)."""
    user_pdv = enforce_pdv_scope(user, None)

    query = (
        select(PickupRequest)
        .where(PickupRequest.status.in_([PickupStatus.REQUESTED, PickupStatus.PLANNED]))
        .options(
            selectinload(PickupRequest.pdv),
            selectinload(PickupRequest.support_type),
        selectinload(PickupRequest.pallet_support_type),
            selectinload(PickupRequest.labels),
        )
    )
    if user_pdv is not None:
        query = query.where(PickupRequest.pdv_id == user_pdv)

    result = await db.execute(query)
    requests = result.scalars().all()

    # Grouper par PDV en dicts puis construire les schemas /
    # Group by PDV as dicts then build schemas
    pdv_map: dict[int, dict] = {}
    for req in requests:
        if req.pdv_id not in pdv_map:
            pdv_map[req.pdv_id] = {
                "pdv_id": req.pdv_id,
                "pdv_code": req.pdv.code,
                "pdv_name": req.pdv.name,
                "pending_count": 0,
                "requests": [],
            }
        entry = pdv_map[req.pdv_id]
        pending_labels = sum(1 for lb in req.labels if lb.status in (LabelStatus.PENDING, LabelStatus.PLANNED))
        entry["pending_count"] += pending_labels
        entry["requests"].append(_enrich_with_label_counts(req))

    return [PdvPickupSummary(**v) for v in pdv_map.values()]


@router.get("/labels/{label_code}", response_model=PickupLabelRead)
async def get_label_by_code(
    label_code: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Lookup étiquette par code (impression/scan) / Label lookup by code (print/scan)."""
    result = await db.execute(select(PickupLabel).where(PickupLabel.label_code == label_code))
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")
    return label


@router.post("/labels/receive", response_model=PickupLabelRead)
async def receive_label(
    label_code: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "update")),
):
    """Scan réception base → statut RECEIVED / Base reception scan → status RECEIVED."""
    result = await db.execute(
        select(PickupLabel)
        .where(PickupLabel.label_code == label_code)
        .options(selectinload(PickupLabel.pickup_request).selectinload(PickupRequest.labels))
    )
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")
    if label.status == LabelStatus.RECEIVED:
        raise HTTPException(status_code=400, detail="Label already received")

    label.status = LabelStatus.RECEIVED
    label.received_at = _now_iso()

    # Mouvement traçabilité / Traceability movement
    db.add(_create_movement(label, MovementType.RECEIVED, user_id=user.id))

    # Auto-progression de la demande parent / Auto-progress parent request
    _auto_progress_request(label.pickup_request)

    # Increment stock base sur reception / Increment base stock on reception
    # Determiner la base via le tour_stop du label / Determine base via label's tour_stop
    base_id = None
    if label.tour_stop_id:
        from app.models.tour_stop import TourStop
        from app.models.tour import Tour
        ts_result = await db.execute(select(TourStop).where(TourStop.id == label.tour_stop_id))
        ts = ts_result.scalar_one_or_none()
        if ts:
            tour_result = await db.execute(select(Tour).where(Tour.id == ts.tour_id))
            tour = tour_result.scalar_one_or_none()
            if tour:
                base_id = tour.base_id

    if base_id and label.pickup_request:
        req = label.pickup_request
        st_result = await db.execute(select(SupportType).where(SupportType.id == req.support_type_id))
        st = st_result.scalar_one_or_none()
        unit_qty = st.unit_quantity if st else 1
        from app.api.base_container_stock import increment_base_stock_on_receive
        await increment_base_stock_on_receive(
            db, base_id, req.support_type_id, unit_qty,
            label.label_code, device_id=None,
        )

    await db.flush()
    await db.refresh(label)
    return label


@router.get("/export/csv")
async def export_pickup_requests_csv(
    pdv_id: int | None = Query(default=None),
    status: str | None = Query(default=None),
    pickup_type: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Export CSV des demandes de reprise / CSV export of pickup requests."""
    # Forcer le scope PDV / Enforce PDV scope
    pdv_id = enforce_pdv_scope(user, pdv_id)

    query = select(PickupRequest).options(
        selectinload(PickupRequest.pdv),
        selectinload(PickupRequest.support_type),
        selectinload(PickupRequest.pallet_support_type),
    ).order_by(PickupRequest.availability_date.desc(), PickupRequest.id.desc())

    if pdv_id is not None:
        query = query.where(PickupRequest.pdv_id == pdv_id)
    if status is not None:
        query = query.where(PickupRequest.status == status)
    if pickup_type is not None:
        query = query.where(PickupRequest.pickup_type == pickup_type)
    if date_from is not None:
        query = query.where(PickupRequest.availability_date >= date_from)
    if date_to is not None:
        query = query.where(PickupRequest.availability_date <= date_to)

    result = await db.execute(query)
    requests = result.scalars().all()

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";", quoting=csv.QUOTE_ALL)

    # En-têtes / Headers
    writer.writerow([
        "PDV code", "PDV nom", "Type reprise", "Support", "Qté",
        "Avec contenu", "Date disponibilité",
        "Valeur unitaire (€)", "Valeur contenu/unité (€)", "Valeur totale (€)",
        "Statut", "Demandé le", "Notes",
    ])

    for req in requests:
        pdv_code = req.pdv.code if req.pdv else ""
        pdv_name = req.pdv.name if req.pdv else ""
        support_name = req.support_type.name if req.support_type else ""
        avec_contenu = "Oui" if req.with_content else "Non"
        val_unitaire = f"{req.declared_unit_value:.2f}".replace(".", ",") if req.declared_unit_value is not None else ""
        val_contenu = ""
        if req.declared_content_item_value is not None and req.declared_content_items_per_unit is not None:
            val_contenu = f"{float(req.declared_content_item_value) * req.declared_content_items_per_unit:.4f}".replace(".", ",")
        val_totale = f"{req.total_declared_value:.2f}".replace(".", ",") if req.total_declared_value is not None else ""
        demande_le = req.requested_at.strftime("%Y-%m-%d %H:%M") if isinstance(req.requested_at, datetime) else (str(req.requested_at)[:16] if req.requested_at else "")

        writer.writerow([
            pdv_code, pdv_name, req.pickup_type, support_name, req.quantity,
            avec_contenu, req.availability_date,
            val_unitaire, val_contenu, val_totale,
            req.status, demande_le, req.notes or "",
        ])

    output.seek(0)
    filename = f"reprises_export_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{request_id}", response_model=PickupRequestRead)
async def get_pickup_request(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Détail d'une demande avec étiquettes / Request detail with labels."""
    result = await db.execute(
        select(PickupRequest)
        .where(PickupRequest.id == request_id)
        .options(
            selectinload(PickupRequest.pdv),
            selectinload(PickupRequest.support_type),
        selectinload(PickupRequest.pallet_support_type),
            selectinload(PickupRequest.labels),
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Pickup request not found")
    return req


@router.post("/{request_id}/printed")
async def mark_printed(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Incrementer le compteur d'impression / Increment print counter."""
    result = await db.execute(
        select(PickupRequest).where(PickupRequest.id == request_id)
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Pickup request not found")
    req.print_count = (req.print_count or 0) + 1
    await db.commit()
    return {"print_count": req.print_count}


# Labels et types qu'on considere "actifs" pour le rendu / labels and types we render
_RENDER_LABEL_ACTIVE_STATUSES = {LabelStatus.PENDING, LabelStatus.PLANNED}


_PICKUP_TYPE_LABELS = {
    PickupType.CONTAINER: "Contenants",
    PickupType.CARDBOARD: "Balles carton",
    PickupType.MERCHANDISE: "Retour marchandise",
    PickupType.CONSIGNMENT: "Consignes",
}


async def _render_request_labels(
    db: AsyncSession, request_id: int, protocol: str, required_pdv_id: int | None,
) -> RenderLabelsResponse:
    """Rendre les étiquettes actives d'une demande en ZPL/TSPL (RAW impression mobile).

    required_pdv_id : si fourni (user PDV ou tablette), la demande doit appartenir à
    ce PDV (sinon 403). None = pas de restriction (back-office / superadmin).
    """
    proto = protocol.strip().upper()
    if proto not in ("ZPL", "TSPL"):
        raise HTTPException(status_code=400, detail="Protocole invalide (ZPL ou TSPL)")

    result = await db.execute(
        select(PickupRequest)
        .where(PickupRequest.id == request_id)
        .options(
            selectinload(PickupRequest.labels),
            selectinload(PickupRequest.pdv),
            selectinload(PickupRequest.support_type),
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Pickup request not found")

    # Verifier scope PDV / Check PDV scope
    if required_pdv_id is not None and req.pdv_id != required_pdv_id:
        raise HTTPException(status_code=403, detail="Acces interdit a ce PDV")

    if not req.pdv:
        raise HTTPException(status_code=500, detail="PDV non charge")
    if not req.support_type:
        raise HTTPException(status_code=400, detail="Type de support requis pour impression")

    is_combi = bool(req.support_type.is_combi)
    active_labels = [
        lb for lb in (req.labels or []) if lb.status in _RENDER_LABEL_ACTIVE_STATUSES
    ]
    if not active_labels:
        raise HTTPException(status_code=400, detail="Aucune etiquette active a imprimer")
    active_labels.sort(key=lambda lb: lb.sequence_number)
    total = len(active_labels)

    pickup_type_label = _PICKUP_TYPE_LABELS.get(req.pickup_type, req.pickup_type.value)

    rendered: list[RenderedLabel] = []
    for lb in active_labels:
        data = LabelData(
            label_code=lb.label_code,
            pdv_code=req.pdv.code,
            pdv_name=req.pdv.name,
            support_type_code=req.support_type.code,
            support_type_name=req.support_type.name,
            pickup_type_label=pickup_type_label,
            quantity=req.quantity,
            availability_date=req.availability_date,
            sequence_number=lb.sequence_number,
            total_labels=total,
            is_combi=is_combi,
        )
        payload = render_label(proto, data)
        rendered.append(
            RenderedLabel(
                label_id=lb.id,
                label_code=lb.label_code,
                sequence_number=lb.sequence_number,
                payload=payload,
            )
        )

    return RenderLabelsResponse(protocol=proto, labels=rendered)


@router.post("/{request_id}/render-labels", response_model=RenderLabelsResponse)
async def render_labels_for_print(
    request_id: int,
    protocol: str = Query("ZPL", description="ZPL ou TSPL"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Rendre les étiquettes d'une demande (utilisateur JWT, scopé à son PDV)."""
    return await _render_request_labels(db, request_id, protocol, get_user_pdv_id(user))


@router.post("/device/{request_id}/render-labels", response_model=RenderLabelsResponse)
async def render_labels_for_print_device(
    request_id: int,
    protocol: str = Query("ZPL", description="ZPL ou TSPL"),
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Rendre les étiquettes depuis une tablette magasin (auth appareil, scope device.pdv_id)."""
    if not device.pdv_id:
        raise HTTPException(status_code=403, detail="Appareil non rattaché à un PDV")
    return await _render_request_labels(db, request_id, protocol, device.pdv_id)


async def _log_print_events_core(
    db: AsyncSession, payload: LabelPrintEventCreate, *,
    scope_pdv_id: int | None, user_id: int | None = None, device_id: int | None = None,
) -> dict:
    """Enregistrer les événements d'impression + incrémenter print_count.

    scope_pdv_id : si fourni, chaque étiquette doit appartenir à ce PDV (sinon 403).
    Audit attribué via user_id (JWT) et/ou device_id (tablette).
    """
    if not payload.label_ids:
        raise HTTPException(status_code=400, detail="label_ids requis")

    try:
        proto = PrintProtocol(payload.protocol.strip().upper())
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Protocole invalide: {payload.protocol}")
    try:
        source = PrintSource(payload.source.strip().upper())
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Source invalide: {payload.source}")

    # Charger les labels concernes + leur pickup_request pour scope PDV /
    # Load labels + parent request for PDV scope
    result = await db.execute(
        select(PickupLabel)
        .where(PickupLabel.id.in_(payload.label_ids))
        .options(selectinload(PickupLabel.pickup_request))
    )
    labels = result.scalars().all()
    if len(labels) != len(set(payload.label_ids)):
        raise HTTPException(status_code=404, detail="Une ou plusieurs etiquettes introuvables")

    # Verifier scope PDV pour chaque label / Check PDV scope for each label
    if scope_pdv_id is not None:
        for lb in labels:
            if lb.pickup_request and lb.pickup_request.pdv_id != scope_pdv_id:
                raise HTTPException(status_code=403, detail="Acces interdit a ce PDV")

    # Creer un event par label / One event per label
    affected_request_ids: set[int] = set()
    for lb in labels:
        event = LabelPrintEvent(
            pickup_label_id=lb.id,
            protocol=proto,
            source=source,
            user_id=user_id,
            device_id=device_id,
            printer_name=payload.printer_name,
            printer_address=payload.printer_address,
            success=payload.success,
            error_detail=payload.error_detail,
        )
        db.add(event)
        if payload.success and lb.pickup_request:
            affected_request_ids.add(lb.pickup_request_id)

    # Incrementer print_count sur les demandes parentes (une seule fois par demande,
    # peu importe le nb d'etiquettes imprimees dans le meme appel) /
    # Increment print_count on parent requests (once per request, regardless of
    # number of labels printed in the same call)
    if affected_request_ids:
        result = await db.execute(
            select(PickupRequest).where(PickupRequest.id.in_(affected_request_ids))
        )
        for req in result.scalars().all():
            req.print_count = (req.print_count or 0) + 1

    await db.flush()
    return {"events_created": len(labels), "requests_updated": len(affected_request_ids)}


@router.post("/print-events", status_code=201)
async def log_print_events(
    payload: LabelPrintEventCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Enregistrer un événement d'impression (utilisateur JWT)."""
    return await _log_print_events_core(
        db, payload, scope_pdv_id=get_user_pdv_id(user), user_id=user.id)


@router.post("/device/print-events", status_code=201)
async def log_print_events_device(
    payload: LabelPrintEventCreate,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Enregistrer un événement d'impression depuis une tablette magasin (auth appareil)."""
    if not device.pdv_id:
        raise HTTPException(status_code=403, detail="Appareil non rattaché à un PDV")
    return await _log_print_events_core(
        db, payload, scope_pdv_id=device.pdv_id, device_id=device.id)


async def _do_create_pickup_request(
    db: AsyncSession, data: PickupRequestCreate, *,
    user_id: int | None = None, device_id: int | None = None,
) -> PickupRequest:
    """Logique commune : créer une demande + auto-générer les étiquettes.

    `data.pdv_id` doit déjà être résolu/forcé par l'appelant. L'audit est
    attribué via user_id (utilisateur JWT) et/ou device_id (tablette magasin).
    Combi (is_combi) : 1 seule étiquette, annule les déclarations combi actives du PDV.
    """
    # Validation quantite : protection contre valeurs aberrantes /
    # Quantity validation: protect against malicious or aberrant values
    if data.quantity < 0 or data.quantity > 9999:
        raise HTTPException(status_code=400, detail="Quantite invalide (doit etre entre 0 et 9999)")

    # Valider PDV / Validate PDV
    pdv = await db.get(PDV, data.pdv_id)
    if not pdv:
        raise HTTPException(status_code=404, detail="PDV not found")

    # Valider SupportType (optionnel pour MERCHANDISE) / Validate SupportType (optional for MERCHANDISE)
    st = None
    if data.support_type_id is not None:
        st = await db.get(SupportType, data.support_type_id)
        if not st:
            raise HTTPException(status_code=404, detail="Support type not found")
    elif data.pickup_type != "MERCHANDISE":
        raise HTTPException(status_code=400, detail="Type de support requis pour ce type de reprise")

    # Ticket #12 : palette support obligatoire pour les balles (CARDBOARD) /
    # Pallet support mandatory for cardboard/plastic bales
    if str(data.pickup_type) == "CARDBOARD" and data.pallet_support_type_id is None:
        raise HTTPException(
            status_code=400,
            detail="Palette support obligatoire pour les balles (ex: PA 22020 — Pal Loc 80*120)",
        )
    # Valider la palette support si fournie / Validate pallet support when provided
    if data.pallet_support_type_id is not None:
        pallet_st = await db.get(SupportType, data.pallet_support_type_id)
        if not pallet_st:
            raise HTTPException(status_code=404, detail="Palette support introuvable")

    st_code = st.code if st else "MERCH"
    is_combi = bool(st and st.is_combi)

    # Pour les combis : annuler les declarations actives precedentes sur ce PDV /
    # For combis: cancel previous active declarations on this PDV
    if is_combi:
        await _cancel_active_combi_declarations(db, data.pdv_id, st.id, user_id)

    req = PickupRequest(
        pdv_id=data.pdv_id,
        support_type_id=data.support_type_id,
        quantity=data.quantity,
        availability_date=data.availability_date,
        pickup_type=data.pickup_type,
        status=PickupStatus.REQUESTED,
        requested_by_user_id=user_id,
        notes=data.notes,
        # Snapshots valeur au moment de la declaration / Value snapshots at declaration time
        with_content=data.with_content,
        declared_unit_value=float(st.unit_value) if st and st.unit_value is not None else None,
        declared_unit_quantity=st.unit_quantity if st else 1,
        declared_content_item_value=float(st.content_item_value) if st and st.content_item_value is not None else None,
        declared_content_items_per_unit=st.content_items_per_unit if st else None,
        pallet_support_type_id=data.pallet_support_type_id,
    )
    db.add(req)
    await db.flush()

    if is_combi:
        # Combi : 1 seule etiquette de declaration / Combi: single declaration label
        # La sequence est globale par PDV/date pour eviter les collisions de label_code
        existing_count_result = await db.execute(
            select(func.count(PickupLabel.id))
            .join(PickupRequest)
            .where(
                PickupRequest.pdv_id == data.pdv_id,
                PickupRequest.availability_date == data.availability_date,
                PickupLabel.pickup_request_id != req.id,
            )
        )
        seq = (existing_count_result.scalar() or 0) + 1
        label = PickupLabel(
            pickup_request_id=req.id,
            label_code=_generate_label_code(pdv.code, st_code, data.availability_date, seq),
            sequence_number=1,
            status=LabelStatus.PENDING,
        )
        db.add(label)
        await db.flush()
        db.add(_create_movement(
            label, MovementType.REQUESTED, user_id=user_id, device_id=device_id,
            notes=f"Declaration combi : stock declare = {data.quantity}",
        ))
    else:
        # Standard : N etiquettes / Standard: N labels
        existing_count_result = await db.execute(
            select(func.count(PickupLabel.id))
            .join(PickupRequest)
            .where(
                PickupRequest.pdv_id == data.pdv_id,
                PickupRequest.availability_date == data.availability_date,
                PickupLabel.pickup_request_id != req.id,
            )
        )
        start_seq = (existing_count_result.scalar() or 0) + 1
        for i in range(data.quantity):
            seq = start_seq + i
            label = PickupLabel(
                pickup_request_id=req.id,
                label_code=_generate_label_code(pdv.code, st_code, data.availability_date, seq),
                sequence_number=i + 1,
                status=LabelStatus.PENDING,
            )
            db.add(label)
            await db.flush()
            db.add(_create_movement(label, MovementType.REQUESTED, user_id=user_id, device_id=device_id))

    await db.flush()

    # Reload avec relations / Reload with relations
    result = await db.execute(
        select(PickupRequest)
        .where(PickupRequest.id == req.id)
        .options(
            selectinload(PickupRequest.pdv),
            selectinload(PickupRequest.support_type),
            selectinload(PickupRequest.pallet_support_type),
            selectinload(PickupRequest.labels),
        )
    )
    return result.scalar_one()


@router.post("/", response_model=PickupRequestRead, status_code=201)
async def create_pickup_request(
    data: PickupRequestCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "create")),
):
    """Créer une demande + étiquettes (utilisateur JWT). PDV forcé pour un user PDV."""
    forced_pdv = enforce_pdv_scope(user, data.pdv_id)
    if forced_pdv is not None:
        data.pdv_id = forced_pdv
    return await _do_create_pickup_request(db, data, user_id=user.id)


@router.post("/device", response_model=PickupRequestRead, status_code=201)
async def create_pickup_request_device(
    data: PickupRequestCreate,
    db: AsyncSession = Depends(get_db),
    device: MobileDevice = Depends(get_authenticated_device),
):
    """Créer une demande depuis une tablette magasin (auth appareil, scope device.pdv_id).

    Pas de login : l'identité provient de l'appareil (X-Device-ID), rattaché à un PDV.
    Le PDV est forcé à celui de la tablette ; audit via device_id.
    """
    if not device.pdv_id:
        raise HTTPException(status_code=403, detail="Appareil non rattaché à un PDV")
    data.pdv_id = device.pdv_id
    return await _do_create_pickup_request(db, data, device_id=device.id)


async def _cancel_active_combi_declarations(
    db: AsyncSession, pdv_id: int, support_type_id: int, user_id: int,
) -> int:
    """Annuler les declarations combi actives non encore prises sur ce PDV /
    Cancel active combi declarations not yet picked up on this PDV.

    "Active" = status REQUESTED ou PLANNED ET au moins une etiquette non
    PICKED_UP/RECEIVED. Idempotent : ne fait rien si aucune declaration active.
    Trace l'annulation dans PickupMovement pour audit.
    Retourne le nombre de declarations annulees.
    """
    result = await db.execute(
        select(PickupRequest)
        .where(
            PickupRequest.pdv_id == pdv_id,
            PickupRequest.support_type_id == support_type_id,
            PickupRequest.status.in_([PickupStatus.REQUESTED, PickupStatus.PLANNED]),
        )
        .options(selectinload(PickupRequest.labels))
    )
    active_requests = result.scalars().all()
    cancelled_count = 0
    for active in active_requests:
        active.status = PickupStatus.CANCELLED
        # Annuler chaque etiquette non encore prise / Cancel each not-yet-picked label
        for label in active.labels:
            if label.status in (LabelStatus.PENDING, LabelStatus.PLANNED):
                label.status = LabelStatus.CANCELLED
                db.add(_create_movement(
                    label, MovementType.UNLINKED, user_id=user_id,
                    notes="Declaration combi remplacee par une nouvelle declaration",
                ))
        cancelled_count += 1
    return cancelled_count


@router.put("/{request_id}", response_model=PickupRequestRead)
async def update_pickup_request(
    request_id: int,
    data: PickupRequestUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "create")),
):
    """Mise à jour d'une demande / Update a pickup request.
    PDV : peut modifier ses propres demandes en statut REQUESTED uniquement.
    Dispatcher/admin : peut modifier toute demande (avec permission update).
    """
    result = await db.execute(
        select(PickupRequest)
        .where(PickupRequest.id == request_id)
        .options(
            selectinload(PickupRequest.pdv),
            selectinload(PickupRequest.support_type),
        selectinload(PickupRequest.pallet_support_type),
            selectinload(PickupRequest.labels),
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Pickup request not found")

    # Utilisateur PDV : uniquement ses propres demandes en REQUESTED
    user_pdv = enforce_pdv_scope(user, None)
    if user_pdv is not None:
        if req.pdv_id != user_pdv:
            raise HTTPException(status_code=403, detail="Acces limite a votre PDV")
        if req.status != PickupStatus.REQUESTED:
            raise HTTPException(status_code=400, detail="Modification impossible : la demande est deja en cours de traitement")
        # PDV ne peut pas changer le statut
        if data.status is not None:
            raise HTTPException(status_code=403, detail="Vous ne pouvez pas changer le statut")

    updates = data.model_dump(exclude_unset=True)
    old_quantity = req.quantity
    old_date = req.availability_date
    new_quantity = updates.get("quantity", old_quantity)
    new_date = updates.get("availability_date", old_date)

    for key, value in updates.items():
        setattr(req, key, value)

    # Si quantite ou date change et statut REQUESTED : annuler les anciennes + regenerer
    cancelled_codes: list[str] = []
    if req.status == PickupStatus.REQUESTED and (new_quantity != old_quantity or new_date != old_date):
        # Marquer les anciennes etiquettes comme CANCELLED (gardees en base pour tracabilite)
        for label in list(req.labels):
            if label.status in (LabelStatus.PENDING, LabelStatus.PLANNED):
                cancelled_codes.append(label.label_code)
                label.status = LabelStatus.CANCELLED
        await db.flush()

        # Regenerer
        pdv = await db.get(PDV, req.pdv_id)
        st = await db.get(SupportType, req.support_type_id) if req.support_type_id else None
        st_code = st.code if st else "MERCH"

        existing_count_result = await db.execute(
            select(func.count(PickupLabel.id))
            .join(PickupRequest)
            .where(
                PickupRequest.pdv_id == req.pdv_id,
                PickupRequest.availability_date == new_date,
                PickupLabel.pickup_request_id != req.id,
            )
        )
        start_seq = (existing_count_result.scalar() or 0) + 1

        for i in range(new_quantity):
            seq = start_seq + i
            label = PickupLabel(
                pickup_request_id=req.id,
                label_code=_generate_label_code(pdv.code, st_code, new_date, seq),
                sequence_number=i + 1,
                status=LabelStatus.PENDING,
            )
            db.add(label)
            await db.flush()
            db.add(_create_movement(label, MovementType.REQUESTED, user_id=user.id))

    await db.flush()

    # Reload avec relations
    result2 = await db.execute(
        select(PickupRequest)
        .where(PickupRequest.id == req.id)
        .options(
            selectinload(PickupRequest.pdv),
            selectinload(PickupRequest.support_type),
        selectinload(PickupRequest.pallet_support_type),
            selectinload(PickupRequest.labels),
        )
    )
    updated = result2.scalar_one()

    # Inclure les codes annules dans la reponse pour affichage au PDV
    response = PickupRequestRead.model_validate(updated, from_attributes=True).model_dump()
    if cancelled_codes:
        response["cancelled_label_codes"] = cancelled_codes
    return response


@router.delete("/{request_id}", status_code=204)
async def delete_pickup_request(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "create")),
):
    """Supprimer une demande / Delete a pickup request.
    PDV : peut supprimer ses propres demandes en statut REQUESTED uniquement.
    Dispatcher/admin : peut supprimer toute demande en REQUESTED.
    """
    req = await db.get(PickupRequest, request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Pickup request not found")
    if req.status != PickupStatus.REQUESTED:
        raise HTTPException(status_code=400, detail="Suppression impossible : la demande est deja en cours de traitement")

    # Utilisateur PDV : uniquement ses propres demandes
    user_pdv = enforce_pdv_scope(user, None)
    if user_pdv is not None and req.pdv_id != user_pdv:
        raise HTTPException(status_code=403, detail="Acces limite a votre PDV")

    await db.delete(req)


def _auto_progress_request(request: PickupRequest):
    """Auto-progression basée sur les statuts individuels des étiquettes.
    Auto-progress based on individual label statuses.
    - Tous RECEIVED → RECEIVED
    - Tous PICKED_UP (ou mix PICKED_UP/RECEIVED) → PICKED_UP
    - Tous PLANNED → PLANNED
    - Sinon statut le plus avancé
    """
    if not request.labels:
        return

    statuses = {lb.status for lb in request.labels}

    if statuses == {LabelStatus.RECEIVED}:
        request.status = PickupStatus.RECEIVED
    elif LabelStatus.RECEIVED in statuses:
        # Mix RECEIVED + autre → PICKED_UP (en transit partiel)
        request.status = PickupStatus.PICKED_UP
    elif LabelStatus.PICKED_UP in statuses:
        request.status = PickupStatus.PICKED_UP
    elif statuses == {LabelStatus.PLANNED}:
        request.status = PickupStatus.PLANNED


@router.get("/{request_id}/movements")
async def get_request_movements(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Historique mouvements d'une demande / Movement history for a request."""
    result = await db.execute(
        select(PickupMovement)
        .join(PickupLabel, PickupMovement.pickup_label_id == PickupLabel.id)
        .where(PickupLabel.pickup_request_id == request_id)
        .order_by(PickupMovement.timestamp.desc())
    )
    movements = result.scalars().all()
    return [
        {
            "id": m.id,
            "label_id": m.pickup_label_id,
            "movement_type": m.movement_type.value if hasattr(m.movement_type, "value") else m.movement_type,
            "timestamp": m.timestamp,
            "device_id": m.device_id,
            "user_id": m.user_id,
            "notes": m.notes,
        }
        for m in movements
    ]


@router.get("/discrepancies/", response_model=list[PickupRequestListRead])
async def list_discrepancies(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("pickup-requests", "read")),
):
    """Demandes avec écarts chauffeur/base / Requests with driver/base discrepancies.
    Retourne les demandes où picked_up_count != received_count (écart = perte potentielle).
    Returns requests where picked_up_count != received_count (gap = potential loss).
    """
    query = select(PickupRequest).options(
        selectinload(PickupRequest.pdv),
        selectinload(PickupRequest.support_type),
        selectinload(PickupRequest.pallet_support_type),
        selectinload(PickupRequest.labels),
    ).where(PickupRequest.status == PickupStatus.PICKED_UP)

    result = await db.execute(query)
    requests = result.scalars().all()

    discrepancies = []
    for req in requests:
        picked = sum(1 for lb in req.labels if lb.status in (LabelStatus.PICKED_UP, LabelStatus.RECEIVED))
        received = sum(1 for lb in req.labels if lb.status == LabelStatus.RECEIVED)
        # Ecart = des labels repris mais pas encore reçus (perte potentielle)
        if picked > 0 and received < picked:
            discrepancies.append(_enrich_with_label_counts(req))

    return discrepancies
