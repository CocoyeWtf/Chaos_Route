"""Routes Tournées / Tour API routes."""

import json
import logging
from datetime import datetime, timedelta
from types import SimpleNamespace

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.audit import AuditLog
from app.models.contract import Contract, effective_vacation
from app.services.cmro_extraction import billing_type_of
from app.models.distance_matrix import DistanceMatrix
from app.models.km_tax import KmTax
from app.models.parameter import Parameter
from app.models.pdv import PDV
from app.models.tour import Tour, TourStatus, TourType, PICKUP_TYPES, return_base_of
from app.models.tour_stop import TourStop
from app.models.tour_surcharge import TourSurcharge, SurchargeStatus
from app.models.volume import Volume
from app.models.base_logistics import BaseLogistics
from app.models.user import User
from app.models.pickup_request import PickupRequest, PickupLabel, PickupStatus, PickupType, LabelStatus
from app.models.vehicle import Vehicle, FleetVehicleType, VehicleStatus
from app.models.tour_manifest_line import TourManifestLine
from app.models.supplier import Supplier
from app.schemas.tour import ManifestLineRead, ReorderStopsRequest, TourCreate, TourGateUpdate, TourOperationsUpdate, TourRead, TourSchedule, TourStopInsert, TourStopRaq, TourStopUpdate, TourUpdate
from app.api.deps import require_permission, get_user_region_ids
from app.utils.fuel_pricing import load_fuel_unit_prices, price_for_contract, contract_fuel_type
from app.services.cmro_extraction import CMRO_COLUMNS, CMRO_FIELDS, build_row as _build_cmro_row

router = APIRouter()

# -- Mapping checkbox TourStop → PickupType / TourStop checkbox → PickupType mapping --
PICKUP_FLAG_TO_TYPE: dict[str, PickupType] = {
    "pickup_containers": PickupType.CONTAINER,
    "pickup_cardboard": PickupType.CARDBOARD,
    "pickup_returns": PickupType.MERCHANDISE,
    "pickup_consignment": PickupType.CONSIGNMENT,
}

# -- Constantes par défaut / Default constants --
DEFAULT_DOCK_TIME_MINUTES = 15
DEFAULT_UNLOAD_TIME_PER_EQP_MINUTES = 2  # minutes par EQC / minutes per EQC (nom hérité)

# Facteur de conversion : 1 EQP = 1.64 EQC / Conversion factor: 1 EQP = 1.64 EQC
EQC_PER_EQP = 1.64


def _parse_time(t: str) -> datetime:
    """Parse HH:MM string to datetime (date-agnostic)."""
    return datetime.strptime(t, "%H:%M")


def _format_time(dt: datetime) -> str:
    """Format datetime to HH:MM string."""
    return dt.strftime("%H:%M")


def _add_minutes(time_str: str, minutes: int) -> str:
    """Ajouter des minutes à un HH:MM / Add minutes to HH:MM."""
    dt = _parse_time(time_str) + timedelta(minutes=minutes)
    return _format_time(dt)


async def _get_param(db: AsyncSession, key: str, default: str) -> str:
    """Lire un paramètre système / Read a system parameter."""
    result = await db.execute(select(Parameter).where(Parameter.key == key))
    param = result.scalar_one_or_none()
    return param.value if param else default


async def _get_distance(
    db: AsyncSession,
    origin_type: str, origin_id: int,
    dest_type: str, dest_id: int,
) -> DistanceMatrix | None:
    """Chercher distance dans le distancier (bidirectionnel) / Lookup distance (bidirectional)."""
    result = await db.execute(
        select(DistanceMatrix).where(
            DistanceMatrix.origin_type == origin_type,
            DistanceMatrix.origin_id == origin_id,
            DistanceMatrix.destination_type == dest_type,
            DistanceMatrix.destination_id == dest_id,
        )
    )
    entry = result.scalar_one_or_none()
    if entry:
        return entry
    result = await db.execute(
        select(DistanceMatrix).where(
            DistanceMatrix.origin_type == dest_type,
            DistanceMatrix.origin_id == dest_id,
            DistanceMatrix.destination_type == origin_type,
            DistanceMatrix.destination_id == origin_id,
        )
    )
    return result.scalar_one_or_none()


def _day_to_minutes(day_str: str | None) -> int:
    """YYYY-MM-DD -> minutes absolues depuis l'origine (0 si invalide) /
    YYYY-MM-DD -> absolute minutes since epoch ordinal (0 if invalid)."""
    if not day_str:
        return 0
    try:
        y, m, d = (int(x) for x in day_str.split("-"))
        return datetime(y, m, d).toordinal() * 24 * 60
    except (ValueError, AttributeError):
        return 0


def tours_time_overlap(
    day_a: str | None, dep_a: str, ret_a: str,
    day_b: str | None, dep_b: str, ret_b: str,
) -> bool:
    """Deux tours se chevauchent-ils sur une timeline ABSOLUE (jour de livraison
    + heure), passage minuit géré ? Deux tours livrés des jours différents ne se
    chevauchent jamais, même à heures de journée proches. /
    Do two tours overlap on an ABSOLUTE timeline (delivery day + time)?"""
    def to_min(t: str) -> int:
        h, m = t.split(":")[:2]
        return int(h) * 60 + int(m)

    a0 = _day_to_minutes(day_a) + to_min(dep_a)
    a1 = _day_to_minutes(day_a) + to_min(ret_a)
    if a1 <= a0:
        a1 += 24 * 60  # retour le lendemain / return next day
    b0 = _day_to_minutes(day_b) + to_min(dep_b)
    b1 = _day_to_minutes(day_b) + to_min(ret_b)
    if b1 <= b0:
        b1 += 24 * 60
    return a0 < b1 and a1 > b0


async def calculate_tour_times(
    departure_time: str,
    stops_data: list[dict],
    base_id: int,
    db: AsyncSession,
    return_base_id: int | None = None,
    final_pickup_supplier_id: int | None = None,
    final_pickup_duration_minutes: int | None = None,
) -> tuple[list[dict], str, int]:
    """
    Calculer les temps à chaque arrêt / Calculate times at each stop.

    `return_base_id` : base sur laquelle la tournée se termine quand elle diffère
    de la base de départ (#64). Sans elle, le retour était systématiquement
    calculé vers la base de départ, et l'agent trafic devait décaler à la main le
    départ de la tournée suivante pour absorber le trajet base-base. /
    Return base when it differs from the departure base.

    `final_pickup_supplier_id` : enlèvement fournisseur après le dernier PDV et
    avant le retour base (#74). Le trajet devient PDV → fournisseur → base, et le
    temps sur place s'ajoute. / Final supplier pickup inserted before the return.

    Returns: (enriched_stops, return_time, total_duration_minutes)
    """
    ret_base_id = return_base_id or base_id
    default_dock = int(await _get_param(db, "default_dock_time_minutes", str(DEFAULT_DOCK_TIME_MINUTES)))
    default_unload = int(await _get_param(db, "default_unload_time_per_eqp_minutes", str(DEFAULT_UNLOAD_TIME_PER_EQP_MINUTES)))

    current_time = _parse_time(departure_time)
    prev_type = "BASE"
    prev_id = base_id
    enriched = []

    for stop in stops_data:
        pdv_id = stop["pdv_id"]
        # Forcer float : eqp_count peut etre Decimal (colonne numeric en DB)
        # et timedelta n'accepte pas Decimal /
        # Force float: eqp_count may be Decimal (numeric column) and timedelta
        # doesn't accept Decimal
        eqp_count = float(stop["eqp_count"])

        dist_entry = await _get_distance(db, prev_type, prev_id, "PDV", pdv_id)
        travel_minutes = dist_entry.duration_minutes if dist_entry else 0
        distance_km = float(dist_entry.distance_km) if dist_entry else 0.0

        arrival = current_time + timedelta(minutes=travel_minutes)

        pdv_result = await db.execute(select(PDV).where(PDV.id == pdv_id))
        pdv = pdv_result.scalar_one_or_none()
        dock_time = pdv.dock_time_minutes if (pdv and pdv.dock_time_minutes) else default_dock
        unload_per_eqp = pdv.unload_time_per_eqp_minutes if (pdv and pdv.unload_time_per_eqp_minutes) else default_unload
        unload_duration = dock_time + (eqp_count * unload_per_eqp)

        departure = arrival + timedelta(minutes=unload_duration)

        enriched.append({
            "pdv_id": pdv_id,
            "sequence_order": stop["sequence_order"],
            "eqp_count": eqp_count,
            "arrival_time": _format_time(arrival),
            "departure_time": _format_time(departure),
            "distance_from_previous_km": round(distance_km, 2),
            "duration_from_previous_minutes": travel_minutes,
        })

        current_time = departure
        prev_type = "PDV"
        prev_id = pdv_id

    if enriched:
        last_pdv_id = enriched[-1]["pdv_id"]
        return_minutes = 0
        if final_pickup_supplier_id:
            # Détour par le fournisseur, puis retour depuis chez lui (#74).
            to_sup = await _get_distance(db, "PDV", last_pdv_id, "SUPPLIER", final_pickup_supplier_id)
            from_sup = await _get_distance(db, "SUPPLIER", final_pickup_supplier_id, "BASE", ret_base_id)
            return_minutes += to_sup.duration_minutes if to_sup else 0
            return_minutes += final_pickup_duration_minutes or default_dock
            return_minutes += from_sup.duration_minutes if from_sup else 0
        else:
            return_dist = await _get_distance(db, "PDV", last_pdv_id, "BASE", ret_base_id)
            return_minutes = return_dist.duration_minutes if return_dist else 0
        return_dt = current_time + timedelta(minutes=return_minutes)
        return_time = _format_time(return_dt)
    else:
        return_time = departure_time

    start_dt = _parse_time(departure_time)
    end_dt = _parse_time(return_time)
    total_minutes = int((end_dt - start_dt).total_seconds() / 60)
    if total_minutes < 0:
        total_minutes += 24 * 60

    return enriched, return_time, total_minutes


def _build_segments(
    base_id: int, stops: list[dict], return_base_id: int | None = None,
    final_pickup_supplier_id: int | None = None,
) -> list[tuple[str, int, str, int]]:
    """Construire la liste des segments du tour / Build list of tour segments.

    Le dernier segment vise la base de retour quand elle diffère du départ (#64) :
    la taxe km se lit par segment, elle doit suivre le trajet réellement parcouru.
    / The last leg targets the return base when it differs.

    Returns: [(origin_type, origin_id, dest_type, dest_id), ...]
    """
    segments: list[tuple[str, int, str, int]] = []
    sorted_stops = sorted(stops, key=lambda s: s.get("sequence_order", 0))
    prev_type = "BASE"
    prev_id = base_id
    for stop in sorted_stops:
        pdv_id = stop["pdv_id"]
        segments.append((prev_type, prev_id, "PDV", pdv_id))
        prev_type = "PDV"
        prev_id = pdv_id
    if sorted_stops:
        ret_base = return_base_id or base_id
        if final_pickup_supplier_id:
            # L'enlèvement de fin (#74) coupe le dernier trajet en deux segments :
            # la taxe km se lit par segment, elle doit suivre le détour.
            segments.append(("PDV", sorted_stops[-1]["pdv_id"], "SUPPLIER", final_pickup_supplier_id))
            segments.append(("SUPPLIER", final_pickup_supplier_id, "BASE", ret_base))
        else:
            segments.append(("PDV", sorted_stops[-1]["pdv_id"], "BASE", ret_base))
    return segments


async def _km_after_last_stop(
    db: AsyncSession,
    last_pdv_id: int,
    base_id: int,
    return_base_id: int | None = None,
    final_pickup_supplier_id: int | None = None,
) -> float:
    """Kilomètres parcourus après le dernier PDV : retour base, éventuellement
    via un enlèvement fournisseur (#74) et vers une autre base (#64).

    Cette fin de tournée se calculait à cinq endroits différents ; elle n'a plus
    qu'une seule écriture, sans quoi chaque nouvelle règle devrait être reportée
    cinq fois. / The tail of a tour, computed in one place.
    """
    ret_base = return_base_id or base_id
    if final_pickup_supplier_id:
        to_sup = await _get_distance(db, "PDV", last_pdv_id, "SUPPLIER", final_pickup_supplier_id)
        from_sup = await _get_distance(db, "SUPPLIER", final_pickup_supplier_id, "BASE", ret_base)
        return (float(to_sup.distance_km) if to_sup else 0.0) + (
            float(from_sup.distance_km) if from_sup else 0.0
        )
    dist = await _get_distance(db, "PDV", last_pdv_id, "BASE", ret_base)
    return float(dist.distance_km) if dist else 0.0


async def _calculate_cost(
    db: AsyncSession,
    total_km: float,
    contract: Contract,
    tour_date: str,
    tour_base_id: int,
    stops: list[dict],
    own_trailer: bool = False,
    return_base_id: int | None = None,
    final_pickup_supplier_id: int | None = None,
) -> tuple[float, list[str]]:
    """Calculer le coût du tour / Calculate tour cost.

    Formule : (vacation / nb_tours_jour) + terme km + terme remorque
              + (km * prix carburant * coeff consommation) + somme(taxe km par segment)

    `own_trailer` : la tournée roule avec une remorque CMRO (mode mixte). Le terme
    remorque n'est alors pas dû — même règle que la pré-facturation (#41).

    Le terme km et le terme remorque étaient absents de ce calcul alors que la
    pré-facturation les compte (#59) : le coût affiché sur une tournée était donc
    plus bas que ce qui sera facturé. / Km and trailer terms were missing here
    while the billing extraction charges them.
    """
    cost = 0.0
    warnings: list[str] = []

    # 1. Terme fixe + vacation / nombre de tours du contrat ce jour
    # Arrondir chaque composant à 2 décimales (cohérent avec cost-breakdown)
    # Round each component to 2 decimals (consistent with cost-breakdown)
    nb_tours = await db.scalar(
        select(func.count(Tour.id)).where(
            Tour.contract_id == contract.id,
            Tour.date == tour_date,
        )
    ) or 1

    # Contrats hors « tractionnaire » (types 1 base/intérim, 3 occasionnel,
    # 4 journalier) : un forfait journalier divisé par le nombre de tournées du
    # jour, et RIEN d'autre — ni terme km, ni carburant, ni taxe. Le coût affiché
    # ignorait ce type de facturation et appliquait le barème complet, alors que
    # la pré-facturation, elle, le respectait déjà (#60). /
    # Non-haulier contracts: a daily flat rate split across the day's tours.
    if billing_type_of(contract) != 2:
        daily = float(getattr(contract, "daily_cost", 0) or 0)
        if not daily:
            warnings.append(
                f"Contrat {contract.code} : forfait journalier absent alors que le "
                f"type de facturation ({contract.billing_type}) l'exige."
            )
        return round(daily / nb_tours, 2), warnings

    # UNE seule vacation (#58) : on additionnait « terme fixe » ET « vacation »,
    # qui portent la même valeur dans tous les contrats — le terme était donc
    # compté deux fois. / One single fixed term: both columns were added.
    cost += round(effective_vacation(contract) / nb_tours, 2)

    # 1b. Terme km et terme remorque (#59) — mêmes règles que la pré-facturation.
    # / Km and trailer terms, same rules as the billing extraction.
    cost += round(total_km * float(contract.cost_per_km or 0), 2)
    if not own_trailer:
        cost += round(float(getattr(contract, "trailer_cost", 0) or 0) / nb_tours, 2)

    # 2. km * prix carburant (selon type du contrat) * coefficient consommation
    fuel_prices = await load_fuel_unit_prices(db, tour_date)
    fuel_price = price_for_contract(fuel_prices, contract)
    if not fuel_price:
        ft = contract_fuel_type(contract).lower()
        warnings.append(f"Aucun prix {ft} trouvé pour la date {tour_date}")
        logger.warning("No %s fuel price found for date %s", ft, tour_date)
    consumption = float(contract.consumption_coefficient or 0)
    cost += round(total_km * fuel_price * consumption, 2)

    # 3. Taxe km (montant forfaitaire par segment, pas un taux/km)
    # Km tax (flat amount per segment, not a rate per km)
    km_tax_total = 0.0
    segments = _build_segments(tour_base_id, stops, return_base_id, final_pickup_supplier_id)
    for seg in segments:
        tax_entry = await db.scalar(
            select(KmTax.tax_per_km).where(
                KmTax.origin_type == seg[0], KmTax.origin_id == seg[1],
                KmTax.destination_type == seg[2], KmTax.destination_id == seg[3],
            )
        )
        if tax_entry:
            km_tax_total += round(float(tax_entry), 2)
    cost += round(km_tax_total, 2)

    return round(cost, 2), warnings


async def _recalculate_sibling_tours(
    db: AsyncSession,
    contract_id: int | None,
    tour_date: str,
) -> int:
    """Recalculer le coût de tous les tours d'un contrat pour une date /
    Recalculate cost for all tours of a contract on a given date.
    Returns the number of tours recalculated.
    """
    if not contract_id:
        return 0
    contract = await db.get(Contract, contract_id)
    if not contract:
        return 0
    result = await db.execute(
        select(Tour)
        .where(Tour.contract_id == contract_id, Tour.date == tour_date)
        .options(selectinload(Tour.stops))
    )
    siblings = result.scalars().all()
    count = 0
    for tour in siblings:
        if not tour.departure_time:
            continue
        stops_data = [
            {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
            for s in sorted(tour.stops, key=lambda s: s.sequence_order)
        ]
        new_cost, _ = await _calculate_cost(
            db, float(tour.total_km or 0), contract, tour.date, tour.base_id, stops_data,
            own_trailer=bool(getattr(tour, "vehicle_id", None)),
            return_base_id=tour.return_base_id,
            final_pickup_supplier_id=tour.final_pickup_supplier_id,
        )
        if tour.total_cost != new_cost:
            tour.total_cost = new_cost
            count += 1
    return count


async def _log_audit(
    db: AsyncSession,
    entity_type: str,
    entity_id: int,
    action: str,
    user: User,
    changes: dict | None = None,
) -> None:
    """Enregistrer une action dans l'historique / Log an action to audit_logs."""
    db.add(AuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        changes=json.dumps(changes, ensure_ascii=False) if changes else None,
        user=user.username,
        timestamp=datetime.utcnow().isoformat(),
    ))


async def _check_vehicle_type_compatibility(
    db: AsyncSession, stops_data: list[dict], contract: Contract,
    tour_vehicle_type: str | None = None,
) -> list[str]:
    """Vérifier compatibilité type véhicule entre les PDV et le contrat /
    Check vehicle type compatibility between PDVs and the contract.
    Returns list of violation messages (empty = OK).

    #32 : un quart des contrats n'a pas de type de véhicule (contrats de
    traction seule, la remorque étant CMRO). Ils échappaient donc totalement au
    contrôle : on pouvait planifier en mixte un semi CMRO chez un PDV qui
    n'accepte pas le semi. Ce qui se présente au point de vente, c'est le
    gabarit du TOUR — on l'utilise quand le contrat n'en impose pas. /
    Contracts without a vehicle type (traction-only, CMRO trailer) used to skip
    this check entirely; fall back to the tour's own vehicle type.
    """
    pdv_ids = [s["pdv_id"] for s in stops_data]
    if not pdv_ids:
        return []
    result = await db.execute(select(PDV).where(PDV.id.in_(pdv_ids)))
    pdvs = {p.id: p for p in result.scalars().all()}

    vt = contract.vehicle_type
    vt_value = vt.value if (vt and hasattr(vt, 'value')) else vt
    if not vt_value:
        vt_value = (
            tour_vehicle_type.value if hasattr(tour_vehicle_type, 'value')
            else tour_vehicle_type
        )

    violations: list[str] = []
    for stop in stops_data:
        pdv = pdvs.get(stop["pdv_id"])
        if not pdv or not pdv.allowed_vehicle_types:
            continue
        allowed = pdv.allowed_vehicle_types.split("|")
        if vt_value and vt_value not in allowed:
            violations.append(f"TYPE_NOT_ALLOWED:{pdv.code} {pdv.name} (requiert {', '.join(allowed)})")

    return violations


async def _check_dock_tailgate_compatibility(
    db: AsyncSession, stops_data: list[dict], contract: Contract
) -> list[str]:
    """Vérifier compatibilité quai/hayon entre les PDV et le contrat /
    Check dock/tailgate compatibility between PDVs and the contract.
    Returns list of violation messages (empty = OK).
    """
    pdv_ids = [s["pdv_id"] for s in stops_data]
    if not pdv_ids:
        return []
    result = await db.execute(select(PDV).where(PDV.id.in_(pdv_ids)))
    pdvs = {p.id: p for p in result.scalars().all()}

    has_tailgate = contract.has_tailgate
    tailgate_type = contract.tailgate_type
    # Normaliser la valeur du type de hayon / Normalize tailgate type value
    tg_value = tailgate_type.value if (tailgate_type and hasattr(tailgate_type, 'value')) else tailgate_type

    violations: list[str] = []
    for stop in stops_data:
        pdv = pdvs.get(stop["pdv_id"])
        if not pdv:
            continue

        if not pdv.has_dock:
            # PDV sans quai → hayon obligatoire / No dock → tailgate required
            if not has_tailgate:
                violations.append(f"DOCK_NO_TAILGATE:{pdv.code} {pdv.name}")
        else:
            # PDV avec quai / PDV with dock
            if not pdv.dock_has_niche and has_tailgate and tg_value == "RABATTABLE":
                # Quai sans niche : seul le hayon rétractable est utilisable (rabattable interdit) /
                # Dock without niche: only retractable tailgate usable (foldable forbidden)
                violations.append(f"DOCK_NO_NICHE_FOLDABLE:{pdv.code} {pdv.name}")

    return violations


# =========================================================================
# CRUD Endpoints
# =========================================================================

@router.get("/", response_model=list[TourRead])
async def list_tours(
    date: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    delivery_date: str | None = None,
    base_id: int | None = None,
    status: str | None = None,
    limit: int = Query(default=200, le=2000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "read")),
):
    """Lister les tours avec filtres / List tours with filters."""
    query = select(Tour).options(selectinload(Tour.stops))
    if date is not None:
        query = query.where(Tour.date == date)
    if date_from is not None:
        query = query.where(Tour.date >= date_from)
    if date_to is not None:
        query = query.where(Tour.date <= date_to)
    if delivery_date is not None:
        query = query.where(Tour.delivery_date == delivery_date)
    if base_id is not None:
        query = query.where(Tour.base_id == base_id)
    if status is not None:
        query = query.where(Tour.status == status)
    # Scope région via BaseLogistics / Region scope via BaseLogistics join
    user_region_ids = get_user_region_ids(user)
    if user_region_ids is not None:
        query = query.join(BaseLogistics, Tour.base_id == BaseLogistics.id).where(
            BaseLogistics.region_id.in_(user_region_ids)
        )
    query = query.order_by(Tour.id.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/available-contracts", response_model=list)
async def available_contracts_for_tours(
    date: str = Query(...),
    base_id: int = Query(...),
    after_time: str = Query(default="00:00"),
    vehicle_type: str | None = Query(default=None),
    temperature_type: str | None = Query(default=None),
    tour_id: int | None = Query(default=None),
    mode: str | None = Query(default=None, description="preste | mixte (filtre selon ce que le transporteur fournit)"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "read")),
):
    """Contrats disponibles à une date/heure / Available contracts at a date/time."""
    from app.models.contract_schedule import ContractSchedule
    from app.models.contract import TemperatureType, TrailerSupply, effective_trailer_supply

    base_result = await db.execute(select(BaseLogistics).where(BaseLogistics.id == base_id))
    base = base_result.scalar_one_or_none()
    if not base:
        raise HTTPException(status_code=404, detail="Base not found")

    contracts_result = await db.execute(
        select(Contract).where(Contract.region_id == base.region_id)
    )
    all_contracts = contracts_result.scalars().all()

    sched_result = await db.execute(
        select(ContractSchedule.contract_id).where(
            ContractSchedule.date == date,
            ContractSchedule.is_available == False,
        )
    )
    unavailable_ids = {row[0] for row in sched_result.all()}
    available = [c for c in all_contracts if c.id not in unavailable_ids]

    if vehicle_type:
        available = [c for c in available if not c.vehicle_type or c.vehicle_type.value == vehicle_type]

    # Filtre selon ce que le transporteur fournit (presté vs mixte/traction).
    # NULL = non renseigné (contrats legacy) → laissé passer pour ne rien
    # casser pendant la migration des donnees. /
    # Filter on what the carrier provides (presté vs mixte/traction).
    # NULL = unset (legacy contracts) → kept to avoid breaking during data
    # migration.
    # #41 : un contrat peut être éligible aux DEUX modes (remorque transporteur
    # sur le frais, remorque CMRO sur le gel) → trailer_supply=BOTH passe les
    # deux filtres. / #41: a contract can be eligible for BOTH modes.
    if mode in ("preste", "mixte"):
        allowed = (
            {TrailerSupply.CARRIER, TrailerSupply.BOTH} if mode == "preste"
            else {TrailerSupply.CMRO, TrailerSupply.BOTH}
        )
        available = [
            c for c in available
            if (c.provides_tractor is None or c.provides_tractor is True)
            and (effective_trailer_supply(c) or TrailerSupply.BOTH) in allowed
        ]

    # Filtre temperature : FRAIS match FRAIS+BI_TEMP+TRI_TEMP, GEL match GEL+BI_TEMP+TRI_TEMP, etc.
    # Temperature filter: bitemp/tritemp contracts are compatible with any single temperature type
    if temperature_type:
        compatible = {temperature_type, "BI_TEMP", "TRI_TEMP"}
        available = [
            c for c in available
            if not c.temperature_type
            or (c.temperature_type.value if hasattr(c.temperature_type, 'value') else c.temperature_type) in compatible
        ]

    # Filtrer les contrats incompatibles quai/hayon / Filter dock/tailgate incompatible contracts
    if tour_id is not None:
        tour_result = await db.execute(
            select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
        )
        tour = tour_result.scalar_one_or_none()
        if tour and tour.stops:
            stops_data = [
                {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
                for s in tour.stops
            ]
            compatible = []
            for c in available:
                dock_violations = await _check_dock_tailgate_compatibility(db, stops_data, c)
                vt_violations = await _check_vehicle_type_compatibility(
                    db, stops_data, c, vehicle_type or tour.vehicle_type
                )
                if not dock_violations and not vt_violations:
                    compatible.append(c)
            available = compatible

    return [
        {
            "id": c.id,
            "code": c.code,
            "transporter_name": c.transporter_name,
            "vehicle_code": c.vehicle_code,
            "vehicle_name": c.vehicle_name,
            "temperature_type": c.temperature_type.value if (c.temperature_type and hasattr(c.temperature_type, 'value')) else c.temperature_type,
            "vehicle_type": c.vehicle_type.value if (c.vehicle_type and hasattr(c.vehicle_type, 'value')) else c.vehicle_type,
            "capacity_eqp": c.capacity_eqp,
            "capacity_weight_kg": c.capacity_weight_kg,
            "fixed_daily_cost": float(c.fixed_daily_cost) if c.fixed_daily_cost else None,
            "cost_per_km": float(c.cost_per_km) if c.cost_per_km else None,
            "cost_per_hour": float(c.cost_per_hour) if c.cost_per_hour else None,
            "has_tailgate": c.has_tailgate,
            "tailgate_type": c.tailgate_type.value if (c.tailgate_type and hasattr(c.tailgate_type, 'value')) else c.tailgate_type,
            "provides_tractor": c.provides_tractor,
            "provides_trailer": c.provides_trailer,
            "trailer_supply": (effective_trailer_supply(c).value if effective_trailer_supply(c) else None),
            "start_date": c.start_date,
            "end_date": c.end_date,
            "region_id": c.region_id,
        }
        for c in available
    ]


@router.get("/{tour_id}/contract-blockers", response_model=list[str])
async def contract_blockers(
    tour_id: int,
    date: str = Query(...),
    base_id: int = Query(...),
    vehicle_type: str | None = Query(default=None),
    temperature_type: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "read")),
):
    """Raisons (en clair) pour lesquelles aucun contrat n'est disponible /
    Human-readable reasons why no contract is available for this tour.

    Appelé par l'ordonnancement quand la liste des contrats est vide, pour ne
    pas laisser l'utilisateur sans explication.
    """
    from app.models.contract_schedule import ContractSchedule

    base = (await db.execute(select(BaseLogistics).where(BaseLogistics.id == base_id))).scalar_one_or_none()
    tour_res = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = tour_res.scalar_one_or_none()
    if not base or not tour or not tour.stops:
        return []

    contracts = list((await db.execute(
        select(Contract).where(Contract.region_id == base.region_id)
    )).scalars().all())
    if not contracts:
        return ["Aucun contrat dans la région de cette base."]

    unavailable = {row[0] for row in (await db.execute(
        select(ContractSchedule.contract_id).where(
            ContractSchedule.date == date, ContractSchedule.is_available == False,
        )
    )).all()}
    pool = [c for c in contracts if c.id not in unavailable]
    if vehicle_type:
        pool = [c for c in pool if not c.vehicle_type
                or (c.vehicle_type.value if hasattr(c.vehicle_type, 'value') else c.vehicle_type) == vehicle_type]
    if temperature_type:
        compatible = {temperature_type, "BI_TEMP", "TRI_TEMP"}
        pool = [c for c in pool if not c.temperature_type
                or (c.temperature_type.value if hasattr(c.temperature_type, 'value') else c.temperature_type) in compatible]

    if not pool:
        return [f"Aucun contrat {vehicle_type or ''} compatible "
                f"(température {temperature_type or '—'}) disponible à cette date."]

    # Tous les contrats du pool sont exclus par les contraintes des PDV :
    # agréger les raisons distinctes / Aggregate distinct PDV-constraint reasons.
    stops_data = [
        {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
        for s in tour.stops
    ]
    codes: set[str] = set()
    for c in pool:
        for v in await _check_vehicle_type_compatibility(
            db, stops_data, c, vehicle_type or tour.vehicle_type
        ):
            codes.add(v)
        for v in await _check_dock_tailgate_compatibility(db, stops_data, c):
            codes.add(v)

    reasons: list[str] = []
    for m in sorted(codes):
        if m.startswith("TYPE_NOT_ALLOWED:"):
            reasons.append("Type de véhicule non autorisé sur " + m.split(":", 1)[1])
        elif m.startswith("DOCK_NO_TAILGATE:"):
            reasons.append("PDV sans quai (hayon obligatoire) : " + m.split(":", 1)[1])
        elif m.startswith("DOCK_NO_NICHE_FOLDABLE:"):
            reasons.append("Quai sans niche → hayon rétractable requis (rabattable interdit) : " + m.split(":", 1)[1])
        else:
            reasons.append(m)
    return reasons


async def _build_cmro_rows(db, date_from, date_to, base_id, transporter_name, user,
                           billing_company=None) -> list[dict]:
    """Construit les lignes d'extraction CMRO (1/tour) sur la période."""
    query = (
        select(Tour).where(
            Tour.date >= date_from, Tour.date <= date_to,
            Tour.contract_id.isnot(None), Tour.departure_time.isnot(None),
        ).options(selectinload(Tour.stops))
    )
    if base_id:
        query = query.where(Tour.base_id == base_id)
    if billing_company:
        bc_ids = (await db.execute(
            select(BaseLogistics.id).where(BaseLogistics.billing_company == billing_company))).scalars().all()
        query = query.where(Tour.base_id.in_(bc_ids if bc_ids else [-1]))
    user_region_ids = get_user_region_ids(user)
    if user_region_ids is not None:
        query = query.join(BaseLogistics, Tour.base_id == BaseLogistics.id).where(
            BaseLogistics.region_id.in_(user_region_ids)
        )
    tours = (await db.execute(query)).scalars().all()
    if not tours:
        return []

    contract_ids = list({t.contract_id for t in tours if t.contract_id})
    contracts_map = {c.id: c for c in (await db.execute(
        select(Contract).where(Contract.id.in_(contract_ids)))).scalars().all()}
    base_ids = list({t.base_id for t in tours})
    bases_map = {b.id: b for b in (await db.execute(
        select(BaseLogistics).where(BaseLogistics.id.in_(base_ids)))).scalars().all()}
    pdv_ids = list({s.pdv_id for t in tours for s in t.stops})
    pdvs_map = {p.id: p for p in (await db.execute(
        select(PDV).where(PDV.id.in_(pdv_ids)))).scalars().all()} if pdv_ids else {}

    if transporter_name:
        nl = transporter_name.lower()
        tours = [t for t in tours
                 if (contracts_map.get(t.contract_id)
                     and nl in (contracts_map[t.contract_id].transporter_name or "").lower())]

    nb_map: dict[tuple, int] = {}
    for cid, d in {(t.contract_id, t.date) for t in tours}:
        nb_map[(cid, d)] = (await db.scalar(
            select(func.count(Tour.id)).where(Tour.contract_id == cid, Tour.date == d))) or 1
    fuel_map: dict[str, dict] = {}
    for d in {t.date for t in tours}:
        fuel_map[d] = await load_fuel_unit_prices(db, d)

    rows: list[dict] = []
    for t in sorted(tours, key=lambda x: (x.date, x.departure_time or "",
                                          x.priority if x.priority is not None else 999)):
        c = contracts_map.get(t.contract_id)
        if not c:
            continue
        stops_data = [
            {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
            for s in sorted(t.stops, key=lambda s: s.sequence_order)
        ]
        km_tax_total = 0.0
        for seg in _build_segments(t.base_id, stops_data, t.return_base_id, t.final_pickup_supplier_id):
            tax = await db.scalar(select(KmTax.tax_per_km).where(
                KmTax.origin_type == seg[0], KmTax.origin_id == seg[1],
                KmTax.destination_type == seg[2], KmTax.destination_id == seg[3],
            ))
            if tax:
                km_tax_total += float(tax)
        eqc_liv, colis_liv = (await db.execute(
            select(func.sum(TourManifestLine.eqc), func.sum(TourManifestLine.nb_colis))
            .where(TourManifestLine.tour_id == t.id, TourManifestLine.scanned == True)  # noqa: E712
        )).one()
        fuel_price = price_for_contract(fuel_map.get(t.date, {}), c)
        base = bases_map.get(t.base_id)
        rows.append(_build_cmro_row(
            t, c, base.name if base else "", nb_map.get((t.contract_id, t.date), 1),
            fuel_price, km_tax_total, eqc_liv, colis_liv, pdvs_map,
        ))
    return rows


@router.get("/cmro-extraction")
async def cmro_extraction(
    date_from: str = Query(...),
    date_to: str = Query(...),
    base_id: int | None = Query(default=None),
    transporter_name: str | None = Query(default=None),
    billing_company: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-history", "read")),
):
    """Extraction pré-facturation au format CMRO (1 ligne/tour, colonnes Tour_ERT)."""
    rows = await _build_cmro_rows(db, date_from, date_to, base_id, transporter_name, user, billing_company)
    keep = [(f, col) for f, col in zip(CMRO_FIELDS, CMRO_COLUMNS) if col]
    return {
        "period": {"date_from": date_from, "date_to": date_to},
        "columns": [col for _, col in keep],
        "fields": [f for f, _ in keep],
        "rows": rows,
    }


@router.get("/cmro-extraction/export")
async def cmro_extraction_export(
    date_from: str = Query(...),
    date_to: str = Query(...),
    base_id: int | None = Query(default=None),
    transporter_name: str | None = Query(default=None),
    billing_company: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-history", "read")),
):
    """Export Excel de l'extraction CMRO (en-têtes/ordre du modèle Tour_ERT)."""
    import io
    import openpyxl

    rows = await _build_cmro_rows(db, date_from, date_to, base_id, transporter_name, user, billing_company)
    keep = [(f, col) for f, col in zip(CMRO_FIELDS, CMRO_COLUMNS) if col]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Tour_ERT"
    ws.append([col for _, col in keep])
    for r in rows:
        ws.append([r.get(f, "") for f, _ in keep])
    bio = io.BytesIO()
    wb.save(bio)
    bio.seek(0)
    filename = f"extraction_CMRO_{date_from}_{date_to}.xlsx"
    return StreamingResponse(
        bio,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# Mapping type de tour → fleet_vehicle_type(s) attendu(s)
# Tour vehicle_type → expected fleet_vehicle_type(s) for own vehicles
VEHICLE_TYPE_TO_FLEET: dict[str, list[str]] = {
    "SEMI": ["SEMI_REMORQUE", "SEMI"],
    "PORTEUR": ["PORTEUR", "PORTEUR_SURBAISSE"],
    "PORTEUR_SURBAISSE": ["PORTEUR_SURBAISSE"],
    "PORTEUR_REMORQUE": ["PORTEUR", "PORTEUR_SURBAISSE", "PORTEUR_REMORQUE", "REMORQUE"],
    "CITY": ["PORTEUR", "PORTEUR_SURBAISSE", "VL", "CITY"],
    "VL": ["VL"],
}


@router.get("/available-vehicles", response_model=list)
async def available_vehicles_for_tours(
    date: str = Query(...),
    base_id: int = Query(...),
    vehicle_type: str = Query(...),
    temperature_type: str | None = Query(default=None),
    tour_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "read")),
):
    """Véhicules propres disponibles pour un tour / Own fleet vehicles available for a tour."""
    from app.models.contract import TemperatureType as TempType

    base_result = await db.execute(select(BaseLogistics).where(BaseLogistics.id == base_id))
    base = base_result.scalar_one_or_none()
    if not base:
        raise HTTPException(status_code=404, detail="Base not found")

    # Scope région / Region scope
    user_region_ids = get_user_region_ids(user)
    region_ids = user_region_ids if user_region_ids is not None else [base.region_id]

    # Charger tous les véhicules ACTIVE de la région (ou sans région = dispo partout)
    # Load all ACTIVE vehicles in region (or without region = available everywhere)
    vehicles_result = await db.execute(
        select(Vehicle).where(
            Vehicle.status == VehicleStatus.ACTIVE,
            (Vehicle.region_id.in_(region_ids)) | (Vehicle.region_id.is_(None)),
        )
    )
    all_vehicles = list(vehicles_result.scalars().all())

    # Filtrer par type compatible avec le tour / Filter by types compatible with tour
    expected_types = VEHICLE_TYPE_TO_FLEET.get(vehicle_type, [])
    # Ajouter TRACTEUR à la liste pour les ensembles SEMI / Add TRACTEUR for SEMI ensembles
    if vehicle_type == "SEMI":
        expected_types = expected_types + ["TRACTEUR"]

    available = [
        v for v in all_vehicles
        if (v.fleet_vehicle_type.value if hasattr(v.fleet_vehicle_type, 'value') else v.fleet_vehicle_type) in expected_types
    ]

    # Filtre température / Temperature filter
    if temperature_type:
        compatible_temps = {temperature_type, "BI_TEMP", "TRI_TEMP"}
        available = [
            v for v in available
            if not v.temperature_type
            or (v.temperature_type.value if hasattr(v.temperature_type, 'value') else v.temperature_type) in compatible_temps
            # Les tracteurs n'ont pas de température — toujours inclus
            or (v.fleet_vehicle_type.value if hasattr(v.fleet_vehicle_type, 'value') else v.fleet_vehicle_type) == "TRACTEUR"
        ]

    # Exclure les véhicules déjà affectés à un autre tour le même jour
    # Exclude vehicles already assigned to another tour on the same date
    already_assigned_result = await db.execute(
        select(Tour.vehicle_id, Tour.tractor_id).where(
            Tour.date == date,
            Tour.status != TourStatus.COMPLETED,
        ).where(
            (Tour.vehicle_id.isnot(None)) | (Tour.tractor_id.isnot(None))
        )
    )
    assigned_ids: set[int] = set()
    for row in already_assigned_result.all():
        if row[0] is not None:
            assigned_ids.add(row[0])
        if row[1] is not None:
            assigned_ids.add(row[1])

    # Permettre la réaffectation au tour courant (s'il était déjà assigné)
    # Allow re-assignment to the current tour if already assigned
    if tour_id is not None:
        current_tour_result = await db.execute(
            select(Tour.vehicle_id, Tour.tractor_id).where(Tour.id == tour_id)
        )
        current = current_tour_result.first()
        if current:
            if current[0] is not None:
                assigned_ids.discard(current[0])
            if current[1] is not None:
                assigned_ids.discard(current[1])

    available = [v for v in available if v.id not in assigned_ids]

    return [
        {
            "id": v.id,
            "code": v.code,
            "license_plate": v.license_plate,
            "fleet_vehicle_type": v.fleet_vehicle_type.value if hasattr(v.fleet_vehicle_type, 'value') else v.fleet_vehicle_type,
            "temperature_type": v.temperature_type.value if (v.temperature_type and hasattr(v.temperature_type, 'value')) else v.temperature_type,
            "capacity_eqp": v.capacity_eqp,
            "has_tailgate": v.has_tailgate,
            "tailgate_type": v.tailgate_type.value if (v.tailgate_type and hasattr(v.tailgate_type, 'value')) else v.tailgate_type,
            "is_tractor": (v.fleet_vehicle_type.value if hasattr(v.fleet_vehicle_type, 'value') else v.fleet_vehicle_type) == "TRACTEUR",
            "label": f"{v.license_plate or v.code}" + (f" — {v.name}" if v.name else ""),
        }
        for v in available
    ]


@router.get("/timeline")
async def tour_timeline(
    date: str = Query(...),
    base_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "read")),
):
    """Timeline 3 jours (J, J+1, J+2) / 3-day timeline with stops."""
    from datetime import datetime as _dt, timedelta as _td
    _base = _dt.strptime(date, "%Y-%m-%d")
    _dates = [(_base + _td(days=i)).strftime("%Y-%m-%d") for i in range(3)]

    query = (
        select(Tour)
        .where(Tour.date.in_(_dates))
        .options(selectinload(Tour.stops))
        .order_by(Tour.departure_time)
    )
    if base_id is not None:
        query = query.where(Tour.base_id == base_id)
    # Scope région / Region scope
    user_region_ids = get_user_region_ids(user)
    if user_region_ids is not None:
        query = query.join(BaseLogistics, Tour.base_id == BaseLogistics.id).where(
            BaseLogistics.region_id.in_(user_region_ids)
        )
    result = await db.execute(query)
    tours = result.scalars().all()

    contract_ids = list({t.contract_id for t in tours if t.contract_id is not None})
    contracts_map: dict[int, Contract] = {}
    if contract_ids:
        c_result = await db.execute(select(Contract).where(Contract.id.in_(contract_ids)))
        for c in c_result.scalars().all():
            contracts_map[c.id] = c

    timeline = []
    for tour in tours:
        c = contracts_map.get(tour.contract_id) if tour.contract_id else None
        vt = tour.vehicle_type
        timeline.append({
            "tour_id": tour.id,
            "code": tour.code,
            "tour_date": tour.date,
            "contract_id": tour.contract_id,
            "vehicle_id": tour.vehicle_id,
            "tractor_id": tour.tractor_id,
            "vehicle_type": vt.value if (vt and hasattr(vt, 'value')) else vt,
            "capacity_eqp": tour.capacity_eqp,
            "vehicle_code": c.vehicle_code if c else None,
            "vehicle_name": c.vehicle_name if c else None,
            "contract_code": c.code if c else None,
            "transporter_name": c.transporter_name if c else None,
            "driver_name": tour.driver_name,
            "departure_time": tour.departure_time,
            "return_time": tour.return_time,
            "total_eqp": tour.total_eqp,
            "total_km": float(tour.total_km) if tour.total_km else None,
            "total_cost": float(tour.total_cost) if tour.total_cost else None,
            "total_duration_minutes": tour.total_duration_minutes,
            "delivery_date": tour.delivery_date,
            "status": tour.status.value if hasattr(tour.status, 'value') else tour.status,
            "stops": [
                {
                    "id": s.id,
                    "pdv_id": s.pdv_id,
                    "sequence_order": s.sequence_order,
                    "eqp_count": s.eqp_count,
                    "arrival_time": s.arrival_time,
                    "departure_time": s.departure_time,
                }
                for s in tour.stops
            ],
        })

    return timeline


@router.get("/transporter-summary")
async def transporter_summary(
    date_from: str = Query(...),
    date_to: str = Query(...),
    base_id: int | None = Query(default=None),
    transporter_name: str | None = Query(default=None),
    billing_company: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-history", "read")),
):
    """Synthèse par transporteur/contrat sur une période / Transporter summary over a period."""
    # 1. Charger les tours sur la période / Load tours in the period
    query = (
        select(Tour)
        .where(
            Tour.date >= date_from,
            Tour.date <= date_to,
            Tour.contract_id.isnot(None),
            Tour.departure_time.isnot(None),
        )
        .options(selectinload(Tour.stops))
    )
    if base_id:
        query = query.where(Tour.base_id == base_id)
    # Filtre société facturante (bases rattachées) / Billing company filter (its bases)
    if billing_company:
        bc_ids = (await db.execute(
            select(BaseLogistics.id).where(BaseLogistics.billing_company == billing_company))).scalars().all()
        query = query.where(Tour.base_id.in_(bc_ids if bc_ids else [-1]))
    # Scope région / Region scope
    user_region_ids = get_user_region_ids(user)
    if user_region_ids is not None:
        query = query.join(BaseLogistics, Tour.base_id == BaseLogistics.id).where(
            BaseLogistics.region_id.in_(user_region_ids)
        )
    result = await db.execute(query)
    tours = result.scalars().all()

    if not tours:
        return {"period": {"date_from": date_from, "date_to": date_to}, "transporters": []}

    # 1b. Batch-load surcharges (validées + compteur pending) / Batch-load surcharges
    tour_ids = [t.id for t in tours]
    surcharges_map: dict[int, list] = {tid: [] for tid in tour_ids}
    pending_surcharges_count: dict[int, int] = {tid: 0 for tid in tour_ids}
    if tour_ids:
        s_result = await db.execute(
            select(TourSurcharge).where(TourSurcharge.tour_id.in_(tour_ids))
        )
        all_surcharges = s_result.scalars().all()
        # Eager-load surcharge_type for label / Charger le type de surcharge
        for s in all_surcharges:
            await db.refresh(s, ["surcharge_type"])
        for s in all_surcharges:
            if s.status == SurchargeStatus.VALIDATED:
                surcharges_map[s.tour_id].append({
                    "id": s.id,
                    "amount": float(s.amount),
                    "motif": s.motif,
                    "surcharge_type_label": s.surcharge_type.label if s.surcharge_type else "",
                })
            elif s.status == SurchargeStatus.PENDING:
                pending_surcharges_count[s.tour_id] = pending_surcharges_count.get(s.tour_id, 0) + 1

    # 2. Batch load contrats, bases, PDVs / Batch load contracts, bases, PDVs
    contract_ids = list({t.contract_id for t in tours if t.contract_id})
    contracts_map: dict[int, Contract] = {}
    if contract_ids:
        c_result = await db.execute(select(Contract).where(Contract.id.in_(contract_ids)))
        for c in c_result.scalars().all():
            contracts_map[c.id] = c

    base_ids = list({t.base_id for t in tours})
    bases_map: dict[int, BaseLogistics] = {}
    if base_ids:
        b_result = await db.execute(select(BaseLogistics).where(BaseLogistics.id.in_(base_ids)))
        for b in b_result.scalars().all():
            bases_map[b.id] = b

    pdv_ids = list({s.pdv_id for t in tours for s in t.stops})
    pdvs_map: dict[int, PDV] = {}
    if pdv_ids:
        p_result = await db.execute(select(PDV).where(PDV.id.in_(pdv_ids)))
        for p in p_result.scalars().all():
            pdvs_map[p.id] = p

    # 2b. Batch-load carriers / Charger les transporteurs
    from app.models.carrier import Carrier as CarrierModel
    carrier_ids = list({c.carrier_id for c in contracts_map.values() if c.carrier_id})
    carriers_map: dict[int, CarrierModel] = {}
    if carrier_ids:
        cr_result = await db.execute(select(CarrierModel).where(CarrierModel.id.in_(carrier_ids)))
        for cr in cr_result.scalars().all():
            carriers_map[cr.id] = cr

    # Filtre transporteur / Transporter filter
    if transporter_name:
        name_lower = transporter_name.lower()
        def _matches_transporter(t):
            contract = contracts_map.get(t.contract_id)
            if not contract:
                return False
            if contract.carrier_id and contract.carrier_id in carriers_map:
                return name_lower in carriers_map[contract.carrier_id].name.lower()
            return name_lower in (contract.transporter_name or "").lower()
        tours = [t for t in tours if t.contract_id and _matches_transporter(t)]

    # 3. Calculer le cost breakdown par tour / Calculate cost breakdown per tour
    # Pré-charger nb_tours par (contract_id, date) / Pre-load nb_tours per (contract_id, date)
    contract_date_pairs = list({(t.contract_id, t.date) for t in tours if t.contract_id})
    nb_tours_map: dict[tuple[int, str], int] = {}
    for cid, d in contract_date_pairs:
        count = await db.scalar(
            select(func.count(Tour.id)).where(Tour.contract_id == cid, Tour.date == d)
        )
        nb_tours_map[(cid, d)] = count or 1

    # Pré-charger prix carburant par date unique (par type) / Pre-load fuel prices per date (by type)
    unique_dates = list({t.date for t in tours})
    fuel_map: dict[str, dict[str, float]] = {}
    missing_fuel_dates: list[str] = []
    for d in unique_dates:
        fuel_map[d] = await load_fuel_unit_prices(db, d)
        if not fuel_map[d]:
            missing_fuel_dates.append(d)
            logger.warning("No fuel price found for date %s in transporter summary", d)

    # 4. Construire les données par tour / Build per-tour data
    default_dock = int(await _get_param(db, "default_dock_time_minutes", str(DEFAULT_DOCK_TIME_MINUTES)))
    default_unload = int(await _get_param(db, "default_unload_time_per_eqp_minutes", str(DEFAULT_UNLOAD_TIME_PER_EQP_MINUTES)))

    tour_rows: list[dict] = []
    for tour in tours:
        contract = contracts_map.get(tour.contract_id)
        if not contract:
            continue
        base = bases_map.get(tour.base_id)
        total_km = float(tour.total_km or 0)
        nb_tours = nb_tours_map.get((contract.id, tour.date), 1)
        # Une seule vacation (#58) : « terme fixe » et « vacation » sont le même
        # montant. `fixed_share` reste exposé à 0 pour ne pas casser les
        # consommateurs existants du détail de coût. /
        # Single fixed term; `fixed_share` kept at 0 for backward compatibility.
        fixed_share = 0.0
        vacation_share = round(effective_vacation(contract) / nb_tours, 2)

        fuel_price = price_for_contract(fuel_map.get(tour.date, {}), contract)
        consumption = float(contract.consumption_coefficient or 0)
        fuel_cost = round(total_km * fuel_price * consumption, 2)

        # Taxe km / Km tax
        stops_data = [
            {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
            for s in sorted(tour.stops, key=lambda s: s.sequence_order)
        ]
        segments = _build_segments(tour.base_id, stops_data, tour.return_base_id, tour.final_pickup_supplier_id)
        km_tax_total = 0.0
        for seg in segments:
            tax_entry = await db.scalar(
                select(KmTax.tax_per_km).where(
                    KmTax.origin_type == seg[0], KmTax.origin_id == seg[1],
                    KmTax.destination_type == seg[2], KmTax.destination_id == seg[3],
                )
            )
            if tax_entry:
                km_tax_total += round(float(tax_entry), 2)
        km_tax_total = round(km_tax_total, 2)
        surcharges_for_tour = surcharges_map.get(tour.id, [])
        surcharges_total = sum(s["amount"] for s in surcharges_for_tour)
        total_calculated = round(fixed_share + vacation_share + fuel_cost + km_tax_total + surcharges_total, 2)

        sorted_stops = sorted(tour.stops, key=lambda s: s.sequence_order)

        # Calcul time_breakdown / Time breakdown calculation
        tb_travel = sum(s.duration_from_previous_minutes or 0 for s in sorted_stops)
        if sorted_stops:
            # La fin de tournée peut passer par un enlèvement fournisseur (#74)
            # et viser une autre base (#64) : on additionne les segments réels.
            # / The tail may route through a supplier and target another base.
            for seg in _build_segments(
                tour.base_id,
                [{"pdv_id": st.pdv_id, "sequence_order": st.sequence_order, "eqp_count": st.eqp_count}
                 for st in sorted_stops],
                tour.return_base_id, tour.final_pickup_supplier_id,
            )[len(sorted_stops):]:
                leg = await _get_distance(db, seg[0], seg[1], seg[2], seg[3])
                tb_travel += leg.duration_minutes if leg else 0
        tb_dock = sum(
            (pdvs_map[s.pdv_id].dock_time_minutes if s.pdv_id in pdvs_map and pdvs_map[s.pdv_id].dock_time_minutes else default_dock)
            for s in sorted_stops
        )
        tb_unload = sum(
            s.eqp_count * (pdvs_map[s.pdv_id].unload_time_per_eqp_minutes if s.pdv_id in pdvs_map and pdvs_map[s.pdv_id].unload_time_per_eqp_minutes else default_unload)
            for s in sorted_stops
        )

        tour_rows.append({
            "tour_id": tour.id,
            "tour_code": tour.code,
            "date": tour.date,
            "base_code": base.code if base else "",
            "base_name": base.name if base else "",
            "departure_time": tour.departure_time,
            "return_time": tour.return_time,
            "total_km": total_km,
            "total_eqp": tour.total_eqp or 0,
            "total_duration_minutes": tour.total_duration_minutes or 0,
            "total_cost": total_calculated,
            "status": tour.status.value if hasattr(tour.status, 'value') else tour.status,
            "driver_name": tour.driver_name,
            "driver_arrival_time": tour.driver_arrival_time,
            "loading_end_time": tour.loading_end_time,
            "barrier_exit_time": tour.barrier_exit_time,
            "barrier_entry_time": tour.barrier_entry_time,
            "remarks": tour.remarks,
            "surcharges": surcharges_for_tour,
            "surcharges_total": round(surcharges_total, 2),
            "pending_surcharges_count": pending_surcharges_count.get(tour.id, 0),
            "cost_breakdown": {
                "fixed_share": fixed_share,
                "vacation_share": vacation_share,
                "fuel_cost": fuel_cost,
                "km_tax_total": km_tax_total,
                "surcharges_total": round(surcharges_total, 2),
                "total_calculated": total_calculated,
            },
            "time_breakdown": {
                "travel_minutes": tb_travel,
                "dock_minutes": tb_dock,
                "unload_minutes": tb_unload,
                "total_minutes": tour.total_duration_minutes or 0,
            },
            "stops": [
                {
                    "sequence_order": s.sequence_order,
                    "pdv_code": pdvs_map[s.pdv_id].code if s.pdv_id in pdvs_map else f"#{s.pdv_id}",
                    "pdv_name": pdvs_map[s.pdv_id].name if s.pdv_id in pdvs_map else "",
                    "eqp_count": s.eqp_count,
                    "distance_from_previous_km": float(s.distance_from_previous_km) if s.distance_from_previous_km else 0,
                    "duration_from_previous_minutes": s.duration_from_previous_minutes or 0,
                    "arrival_time": s.arrival_time,
                    "departure_time": s.departure_time,
                    "pickup_cardboard": getattr(s, "pickup_cardboard", False),
                    "pickup_containers": getattr(s, "pickup_containers", False),
                    "pickup_returns": getattr(s, "pickup_returns", False),
                    "pickup_consignment": getattr(s, "pickup_consignment", False),
                }
                for s in sorted_stops
            ],
            # Pour le groupement / For grouping — carrier.name prioritaire si carrier_id
            "_transporter_name": (
                carriers_map[contract.carrier_id].name
                if contract.carrier_id and contract.carrier_id in carriers_map
                else contract.transporter_name or ""
            ),
            "_carrier_id": contract.carrier_id,
            "_carrier_code": (
                carriers_map[contract.carrier_id].code
                if contract.carrier_id and contract.carrier_id in carriers_map
                else None
            ),
            "_contract_id": contract.id,
            "_contract_code": contract.code,
            "_vehicle_code": contract.vehicle_code,
            "_vehicle_name": contract.vehicle_name,
        })

    # 5. Grouper par transporteur > contrat / Group by transporter > contract
    from collections import defaultdict
    by_transporter: dict[str, dict[int, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for row in tour_rows:
        by_transporter[row["_transporter_name"]][row["_contract_id"]].append(row)

    transporters_result = []
    for t_name in sorted(by_transporter.keys()):
        contracts_group = by_transporter[t_name]
        contracts_result = []
        grand_nb_tours = 0
        grand_km = 0.0
        grand_eqp = 0
        grand_duration = 0
        grand_fixed = 0.0
        grand_vacation = 0.0
        grand_fuel = 0.0
        grand_km_tax = 0.0
        grand_surcharges = 0.0
        grand_cost = 0.0

        for cid in sorted(contracts_group.keys()):
            c_tours = contracts_group[cid]
            contract = contracts_map[cid]
            # Sous-totaux contrat / Contract subtotals
            sub_km = sum(t["total_km"] for t in c_tours)
            sub_eqp = sum(t["total_eqp"] for t in c_tours)
            sub_duration = sum(t["total_duration_minutes"] for t in c_tours)
            sub_fixed = sum(t["cost_breakdown"]["fixed_share"] for t in c_tours)
            sub_vacation = sum(t["cost_breakdown"]["vacation_share"] for t in c_tours)
            sub_fuel = sum(t["cost_breakdown"]["fuel_cost"] for t in c_tours)
            sub_km_tax = sum(t["cost_breakdown"]["km_tax_total"] for t in c_tours)
            sub_surcharges = sum(t["surcharges_total"] for t in c_tours)
            sub_cost = sum(t["cost_breakdown"]["total_calculated"] for t in c_tours)

            # Nettoyer les clés internes / Remove internal keys
            clean_tours = []
            for t in sorted(c_tours, key=lambda x: (x["date"], x["departure_time"] or "")):
                ct = {k: v for k, v in t.items() if not k.startswith("_")}
                clean_tours.append(ct)

            contracts_result.append({
                "contract_id": cid,
                "contract_code": contract.code,
                "vehicle_code": contract.vehicle_code,
                "vehicle_name": contract.vehicle_name,
                "tours": clean_tours,
                "subtotal": {
                    "nb_tours": len(c_tours),
                    "total_km": round(sub_km, 2),
                    "total_eqp": sub_eqp,
                    "total_duration_minutes": sub_duration,
                    "fixed_cost_total": round(sub_fixed, 2),
                    "vacation_cost_total": round(sub_vacation, 2),
                    "fuel_cost_total": round(sub_fuel, 2),
                    "km_tax_total": round(sub_km_tax, 2),
                    "surcharges_total": round(sub_surcharges, 2),
                    "total_cost": round(sub_cost, 2),
                },
            })

            grand_nb_tours += len(c_tours)
            grand_km += sub_km
            grand_eqp += sub_eqp
            grand_duration += sub_duration
            grand_fixed += sub_fixed
            grand_vacation += sub_vacation
            grand_fuel += sub_fuel
            grand_km_tax += sub_km_tax
            grand_surcharges += sub_surcharges
            grand_cost += sub_cost

        # Extraire carrier_id/code depuis le 1er tour du groupe / Extract from first tour
        first_row = next(iter(next(iter(contracts_group.values()))), None)
        transporters_result.append({
            "transporter_name": t_name,
            "carrier_id": first_row["_carrier_id"] if first_row else None,
            "carrier_code": first_row["_carrier_code"] if first_row else None,
            "contracts": contracts_result,
            "grand_total": {
                "nb_contracts": len(contracts_result),
                "nb_tours": grand_nb_tours,
                "total_km": round(grand_km, 2),
                "total_eqp": grand_eqp,
                "total_duration_minutes": grand_duration,
                "fixed_cost_total": round(grand_fixed, 2),
                "vacation_cost_total": round(grand_vacation, 2),
                "fuel_cost_total": round(grand_fuel, 2),
                "km_tax_total": round(grand_km_tax, 2),
                "surcharges_total": round(grand_surcharges, 2),
                "total_cost": round(grand_cost, 2),
            },
        })

    warnings = [f"Aucun prix carburant trouvé pour la date {d}" for d in sorted(missing_fuel_dates)]
    return {
        "period": {"date_from": date_from, "date_to": date_to},
        "transporters": transporters_result,
        "warnings": warnings,
    }


@router.get("/by-code/{code}", response_model=TourRead)
async def get_tour_by_code(
    code: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("guard-post", "read")),
):
    """Chercher un tour par son code (scan code-barre) / Lookup tour by code (barcode scan)."""
    result = await db.execute(
        select(Tour).where(Tour.code == code).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")
    return tour


@router.get("/{tour_id}/time-breakdown")
async def get_tour_time_breakdown(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "read")),
):
    """Détail du calcul de temps d'un tour / Tour time calculation breakdown."""
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    default_dock = int(await _get_param(db, "default_dock_time_minutes", str(DEFAULT_DOCK_TIME_MINUTES)))
    default_unload = int(await _get_param(db, "default_unload_time_per_eqp_minutes", str(DEFAULT_UNLOAD_TIME_PER_EQP_MINUTES)))

    sorted_stops = sorted(tour.stops, key=lambda s: s.sequence_order)

    # Charger les PDVs et la base / Load PDVs and base
    pdv_ids = list({s.pdv_id for s in sorted_stops})
    pdv_map: dict[int, PDV] = {}
    if pdv_ids:
        pdv_result = await db.execute(select(PDV).where(PDV.id.in_(pdv_ids)))
        for p in pdv_result.scalars().all():
            pdv_map[p.id] = p
    base = await db.get(BaseLogistics, tour.base_id)
    ret_base = await db.get(BaseLogistics, tour.return_base_id) if tour.return_base_id else base
    base_names = {tour.base_id: base, return_base_of(tour): ret_base}
    fin_sup = (
        await db.get(Supplier, tour.final_pickup_supplier_id)
        if tour.final_pickup_supplier_id else None
    )

    # Construire les segments et stops / Build segments and stops
    stops_data = [
        {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
        for s in sorted_stops
    ]
    segments = _build_segments(tour.base_id, stops_data, tour.return_base_id, tour.final_pickup_supplier_id)

    segment_details = []
    total_travel = 0
    for seg in segments:
        dist = await _get_distance(db, seg[0], seg[1], seg[2], seg[3])
        travel_min = dist.duration_minutes if dist else 0
        total_travel += travel_min

        # Un segment BASE peut viser la base de retour (#64) : on nomme la base
        # du segment, pas systématiquement celle de départ. / Name the leg's own base.
        if seg[0] == "BASE" and base_names.get(seg[1]):
            origin_label = base_names[seg[1]].name
        elif seg[0] == "SUPPLIER":
            origin_label = fin_sup.name if fin_sup else f"#{seg[1]}"
        else:
            pdv = pdv_map.get(seg[1])
            origin_label = f"{pdv.code} {pdv.name}" if pdv else f"#{seg[1]}"
        if seg[2] == "BASE" and base_names.get(seg[3]):
            dest_label = base_names[seg[3]].name
        elif seg[2] == "SUPPLIER":
            dest_label = fin_sup.name if fin_sup else f"#{seg[3]}"
        else:
            pdv = pdv_map.get(seg[3])
            dest_label = f"{pdv.code} {pdv.name}" if pdv else f"#{seg[3]}"

        segment_details.append({
            "origin": f"{seg[0]}:{origin_label}",
            "destination": f"{seg[2]}:{dest_label}",
            "travel_minutes": travel_min,
        })

    stop_details = []
    total_dock = 0
    total_unload = 0
    total_eqp = 0
    for s in sorted_stops:
        pdv = pdv_map.get(s.pdv_id)
        dock = pdv.dock_time_minutes if (pdv and pdv.dock_time_minutes) else default_dock
        unload_per = pdv.unload_time_per_eqp_minutes if (pdv and pdv.unload_time_per_eqp_minutes) else default_unload
        unload_min = s.eqp_count * unload_per
        total_dock += dock
        total_unload += unload_min
        total_eqp += s.eqp_count
        stop_details.append({
            "pdv_code": pdv.code if pdv else f"#{s.pdv_id}",
            "pdv_name": pdv.name if pdv else "",
            "eqp": s.eqp_count,
            "dock_min": dock,
            "unload_min": unload_min,
            "total_stop_min": dock + unload_min,
        })

    return {
        "tour_id": tour.id,
        "tour_code": tour.code,
        "departure_time": tour.departure_time,
        "return_time": tour.return_time,
        "total_duration_minutes": tour.total_duration_minutes or 0,
        "travel_minutes": total_travel,
        "dock_minutes": total_dock,
        "unload_minutes": total_unload,
        "segments": segment_details,
        "stops": stop_details,
    }


@router.get("/transporter-confirmation")
async def transporter_confirmation_preview(
    date: str = Query(...),
    carrier_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "read")),
):
    """Aperçu du mail de confirmation pour un transporteur / Preview the confirmation email.

    Déclaré avant GET /{tour_id} pour ne pas être capté par la route dynamique.
    """
    carrier, tours, subject, html_doc, text_doc = await _build_transporter_confirmation(
        db, date, carrier_id
    )
    return {
        "carrier_id": carrier.id,
        "carrier_name": carrier.name,
        "to": carrier.email,
        "subject": subject,
        "html": html_doc,
        "text": text_doc,
        "tour_count": len(tours),
    }


@router.get("/{tour_id}", response_model=TourRead)
async def get_tour(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "read")),
):
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")
    return tour


# ─── Confirmation transporteur (mail récapitulatif des tournées attribuées) ───
# Transporter confirmation (recap email of assigned tours), one carrier at a time.

async def _build_transporter_confirmation(db: AsyncSession, date: str, carrier_id: int):
    """Construire le récapitulatif des tournées d'un transporteur pour une journée.

    Retourne (carrier, tours, subject, html, text). Reproduit le tableau du
    modèle « mouvements » : Code Ch. | H.Départ | N° Mission | Chauffeurs |
    Observations/Enlèvement | Départ | Retour | PDV 1..N.
    """
    from html import escape
    from app.models.carrier import Carrier

    carrier = await db.get(Carrier, carrier_id)
    if not carrier:
        raise HTTPException(status_code=404, detail="Transporteur non trouvé")

    contract_rows = await db.execute(
        select(Contract.id).where(Contract.carrier_id == carrier_id)
    )
    contract_ids = [r[0] for r in contract_rows.all()]

    tours: list[Tour] = []
    if contract_ids:
        tres = await db.execute(
            select(Tour).options(selectinload(Tour.stops)).where(
                Tour.date == date,
                Tour.contract_id.in_(contract_ids),
                Tour.departure_time.isnot(None),
            )
        )
        tours = sorted(tres.scalars().all(), key=lambda t: t.departure_time or "")

    base_ids = {t.base_id for t in tours} | {t.return_base_id for t in tours if t.return_base_id}
    base_map: dict[int, BaseLogistics] = {}
    if base_ids:
        bres = await db.execute(select(BaseLogistics).where(BaseLogistics.id.in_(base_ids)))
        base_map = {b.id: b for b in bres.scalars().all()}

    pdv_ids = {s.pdv_id for t in tours for s in t.stops}
    pdv_map: dict[int, PDV] = {}
    if pdv_ids:
        pres = await db.execute(select(PDV).where(PDV.id.in_(pdv_ids)))
        pdv_map = {p.id: p for p in pres.scalars().all()}

    def base_label(bid: int) -> str:
        b = base_map.get(bid)
        return f"{b.code} ({b.name})" if b else ""

    rows: list[dict] = []
    max_pdv = 0
    for t in tours:
        stops = sorted(t.stops, key=lambda s: s.sequence_order)
        pdv_cells: list[str] = []
        for s in stops:
            p = pdv_map.get(s.pdv_id)
            if p:
                loc = p.city or p.name or ""
                pdv_cells.append(f"{p.code} ({loc})" if loc else p.code)
            else:
                pdv_cells.append(f"#{s.pdv_id}")
        max_pdv = max(max_pdv, len(pdv_cells))
        rows.append({
            "code_ch": t.driver_code_infolog or "",
            "h_depart": t.departure_time or "",
            "n_mission": t.wms_tour_code or t.code or "",
            "chauffeur": t.driver_name or "",
            "observations": t.remarks or t.destination or "",
            "depart": base_label(t.base_id),
            "retour": base_label(return_base_of(t)),
            "pdvs": pdv_cells,
        })

    subject = f"Tournées attribuées — {date} — {carrier.name}"

    headers = (
        ["Code Ch.", "H.Départ", "N° Mission", "Chauffeurs",
         "Observations/Enlèvement", "Départ", "Retour"]
        + [f"PDV {i + 1}" for i in range(max_pdv)]
    )
    th = "".join(
        f'<th style="border:1px solid #999;padding:4px 6px;background:#f0f0f0;'
        f'font-size:12px;text-align:left;">{escape(h)}</th>' for h in headers
    )
    body_rows = ""
    for r in rows:
        cells = [r["code_ch"], r["h_depart"], r["n_mission"], r["chauffeur"],
                 r["observations"], r["depart"], r["retour"]]
        cells += r["pdvs"] + [""] * (max_pdv - len(r["pdvs"]))
        tds = "".join(
            f'<td style="border:1px solid #999;padding:4px 6px;font-size:12px;'
            f'white-space:nowrap;">{escape(str(c))}</td>' for c in cells
        )
        body_rows += f"<tr>{tds}</tr>"

    html_doc = (
        '<div style="font-family:Arial,Helvetica,sans-serif;color:#222;">'
        '<p>Bonjour,</p>'
        f'<p>Ci-dessous le récapitulatif des tournées qui vous ont été attribuées '
        f'pour la journée du {escape(date)}.</p>'
        "<p>Merci d'en prendre bonne note.</p>"
        '<table style="border-collapse:collapse;border:1px solid #999;">'
        f'<thead><tr>{th}</tr></thead><tbody>{body_rows}</tbody></table>'
        '<p style="margin-top:16px;">Cordialement,<br/>— Chaos RouteManager</p>'
        '</div>'
    )

    text_lines = [
        "Bonjour,",
        f"Ci-dessous le récapitulatif des tournées attribuées pour la journée du {date}.",
        "",
    ]
    for r in rows:
        text_lines.append(
            f"- {r['h_depart']} | {r['n_mission']} | "
            f"{r['chauffeur'] or r['observations']} | "
            f"Départ {r['depart']} → Retour {r['retour']} | "
            "PDV: " + ", ".join(r["pdvs"])
        )
    text_lines += ["", "Cordialement,", "— Chaos RouteManager"]
    text_doc = "\n".join(text_lines)

    return carrier, tours, subject, html_doc, text_doc


@router.post("/transporter-confirmation/send")
async def transporter_confirmation_send(
    date: str = Query(...),
    carrier_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "update")),
):
    """Envoyer le mail récapitulatif au transporteur / Send the recap email to the carrier."""
    from app.config import settings

    carrier, tours, subject, html_doc, text_doc = await _build_transporter_confirmation(
        db, date, carrier_id
    )
    if not carrier.email:
        raise HTTPException(status_code=400, detail="Le transporteur n'a pas d'adresse email")
    if not tours:
        raise HTTPException(status_code=400, detail="Aucune tournée attribuée à ce transporteur pour cette date")

    if settings.SMTP_HOST:
        import aiosmtplib
        from email.message import EmailMessage

        msg = EmailMessage()
        msg["From"] = settings.SMTP_FROM
        msg["To"] = carrier.email
        msg["Subject"] = subject
        msg.set_content(text_doc)
        msg.add_alternative(html_doc, subtype="html")
        try:
            await aiosmtplib.send(
                msg,
                hostname=settings.SMTP_HOST,
                port=settings.SMTP_PORT,
                username=settings.SMTP_USER or None,
                password=settings.SMTP_PASSWORD or None,
                use_tls=settings.SMTP_USE_TLS,
            )
        except Exception as e:
            logger.error(f"Erreur envoi confirmation transporteur: {e}")
            raise HTTPException(status_code=500, detail="Erreur lors de l'envoi de l'email")
    else:
        logger.warning(
            f"SMTP non configuré. Confirmation transporteur:\nTo: {carrier.email}\n{text_doc}"
        )

    await _log_audit(
        db, "tour_confirmation", carrier.id, "EMAIL_SENT", user,
        {"to": carrier.email, "date": date, "tour_count": len(tours)},
    )
    return {"detail": f"Email envoyé à {carrier.email}", "to": carrier.email, "tour_count": len(tours)}


@router.post("/", response_model=TourRead, status_code=201)
async def create_tour(
    data: TourCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "create")),
):
    """Créer un tour avec calcul automatique des temps / Create a tour with automatic time calculation."""
    stops_input = [
        {
            "pdv_id": s.pdv_id,
            "volume_id": s.volume_id,
            "sequence_order": s.sequence_order,
            "eqp_count": s.eqp_count,
            "pickup_cardboard": s.pickup_cardboard,
            "pickup_containers": s.pickup_containers,
            "pickup_returns": s.pickup_returns,
            "pickup_consignment": s.pickup_consignment,
        }
        for s in data.stops
    ]

    # Garde anti double-planification (#83) : un volume deja rattache a une autre
    # tournee ne doit pas repartir dans une seconde. Sans ce controle, la tournee
    # etait creee avec un arret FANTOME (EQC comptes, volume non rattache), et la
    # reprise gloutonne pouvait avaler un AUTRE volume du meme PDV pour atteindre
    # la cible EQC. Le cas se produit quand deux planificateurs travaillent en
    # meme temps, ou quand la liste affichee n'est plus a jour. /
    # Double-planning guard: a volume already attached to another tour must not be
    # planned again — otherwise the tour was created with a phantom stop.
    explicit_volume_ids = [s["volume_id"] for s in stops_input if s.get("volume_id") is not None]
    if explicit_volume_ids:
        taken = (await db.execute(
            select(Volume)
            .options(selectinload(Volume.pdv))
            .where(Volume.id.in_(explicit_volume_ids), Volume.tour_id.is_not(None))
        )).scalars().all()
        if taken:
            tour_codes = dict((await db.execute(
                select(Tour.id, Tour.code).where(Tour.id.in_({v.tour_id for v in taken}))
            )).all())
            details = ", ".join(
                f"{(v.pdv.code if v.pdv else f'PDV #{v.pdv_id}')} "
                f"({float(v.eqp_count or 0):.2f} EQC) deja dans la tournee "
                f"{tour_codes.get(v.tour_id, f'#{v.tour_id}')}"
                for v in taken
            )
            raise HTTPException(
                status_code=409,
                detail=(
                    "Volume(s) deja planifie(s) dans une autre tournee : "
                    f"{details}. Retirez ce(s) point(s) de vente du tour, "
                    "puis reessayez (rafraichissez la liste des volumes)."
                ),
            )

    # Garde anti melange de bases (#84) : un tour = UNE seule base d'origine.
    # Un camion ne charge que sur un site, et la base est persistee sur le tour :
    # elle fixe le lieu de chargement, les kms (calcules depuis ses coordonnees),
    # les contrats proposes et l'export planning. Or un meme PDV est servi depuis
    # deux bases le meme jour (SEC -> 092 Gosselies, FRAIS -> 080 Villers) : un
    # simple clic sur sa pastille empilait les deux dans le meme tour. Decision du
    # trafic (reponse B au ticket) : on refuse, on n'avertit pas. /
    # Origin-base guard: one tour = one origin base (a truck loads at one site).
    origin_base_id: int | None = None
    if explicit_volume_ids:
        payload_vols = (await db.execute(
            select(Volume)
            .options(selectinload(Volume.pdv))
            .where(Volume.id.in_(explicit_volume_ids))
        )).scalars().all()
        by_origin: dict[int, list[Volume]] = {}
        for v in payload_vols:
            if v.base_origin_id is not None:
                by_origin.setdefault(v.base_origin_id, []).append(v)

        if by_origin:
            base_labels = dict((await db.execute(
                select(BaseLogistics.id, BaseLogistics.code).where(
                    BaseLogistics.id.in_(set(by_origin) | {data.base_id})
                )
            )).all())

            def _label(bid: int | None) -> str:
                return base_labels.get(bid) or f"base #{bid}"

            if len(by_origin) > 1:
                details = " ; ".join(
                    f"{_label(bid)} : "
                    + ", ".join(
                        sorted({(v.pdv.code if v.pdv else f"PDV #{v.pdv_id}") for v in group})
                    )
                    for bid, group in sorted(by_origin.items())
                )
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Deux bases d'origine dans la meme tournee : "
                        f"{details}. Un camion ne charge que sur un seul site : "
                        "faites une tournee par base (elles peuvent etre confiees "
                        "au meme chauffeur)."
                    ),
                )

            origin_base_id = next(iter(by_origin))
            # base_id absente (0/None) = base non encore detectee cote front : on
            # adopte celle des volumes plutot que de refuser. / Missing base_id
            # means "not detected yet": adopt the volumes' base instead of failing.
            if not data.base_id:
                data.base_id = origin_base_id
            elif data.base_id != origin_base_id:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"La tournee charge a {_label(data.base_id)} mais ses volumes "
                        f"partent de {_label(origin_base_id)}. Rechargez la page et "
                        "reconstruisez la tournee pour repartir de la bonne base."
                    ),
                )

    # Base de retour (#64) : « la même que le départ » s'écrit NULL, une seule
    # valeur pour un seul sens, de sorte qu'aucun calcul n'ait à comparer deux
    # identifiants. / "Same as departure" is stored as NULL, one single form.
    if data.return_base_id == data.base_id:
        data.return_base_id = None
    if data.return_base_id and not await db.get(BaseLogistics, data.return_base_id):
        raise HTTPException(status_code=422, detail="Base de retour introuvable")

    # Enlèvement fournisseur de fin (#74) : il n'a de sens qu'après un arrêt de
    # livraison. Sans PDV, c'est un enlèvement dédié, qui a déjà sa nature.
    # / A final pickup only makes sense after a delivery stop.
    if data.final_pickup_supplier_id:
        if not await db.get(Supplier, data.final_pickup_supplier_id):
            raise HTTPException(status_code=422, detail="Fournisseur d'enlèvement introuvable")
        if not stops_input:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Un enlèvement de fin de tournée suppose une tournée de livraison. "
                    "Pour un enlèvement seul, utilisez la nature « Enlèvement dédié »."
                ),
            )

    if data.departure_time:
        enriched_stops, return_time, total_duration = await calculate_tour_times(
            data.departure_time, stops_input, data.base_id, db, data.return_base_id,
            data.final_pickup_supplier_id, data.final_pickup_duration_minutes,
        )
    else:
        enriched_stops = stops_input
        return_time = None
        total_duration = None

    # Heure de fin saisie à la main (enlèvement dédié / mouvement) : prime sur le
    # calcul automatique / Manually entered end time (dedicated pickup / movement)
    # takes precedence over the computed return time.
    if data.return_time:
        return_time = data.return_time

    contract = await db.get(Contract, data.contract_id) if data.contract_id else None

    # Vérification compatibilité quai/hayon (blocage dur) / Dock/tailgate compatibility (hard block)
    if contract and stops_input:
        dock_violations = await _check_dock_tailgate_compatibility(db, stops_input, contract)
        if dock_violations:
            raise HTTPException(
                status_code=422,
                detail=f"DOCK_TAILGATE:{' | '.join(dock_violations)}",
            )

    # Vérification compatibilité type véhicule / Vehicle type compatibility check
    if contract and stops_input:
        vt_violations = await _check_vehicle_type_compatibility(
            db, stops_input, contract, data.vehicle_type
        )
        if vt_violations:
            raise HTTPException(
                status_code=422,
                detail=f"VEHICLE_TYPE:{' | '.join(vt_violations)}",
            )

    total_km = data.total_km or 0
    if data.departure_time and enriched_stops:
        total_km = sum(s.get("distance_from_previous_km", 0) for s in enriched_stops)
        if enriched_stops:
            last_pdv_id = enriched_stops[-1]["pdv_id"]
            total_km += await _km_after_last_stop(
                db, last_pdv_id, data.base_id, data.return_base_id,
                data.final_pickup_supplier_id,
            )
        total_km = round(total_km, 2)
    elif data.supplier_id and not enriched_stops:
        # Enlèvement dédié : aller-retour base ↔ fournisseur depuis le distancier /
        # Dedicated pickup: base ↔ supplier round-trip from the distance matrix.
        sup_dist = await _get_distance(db, "BASE", data.base_id, "SUPPLIER", data.supplier_id)
        if sup_dist:
            total_km = round(float(sup_dist.distance_km) * 2, 2)

    total_cost = data.total_cost or 0

    # Nature du tour : is_pickup_tour est dérivé de tour_type (source unique).
    # Compat : un ancien payload pickup (is_pickup_tour=True sans tour_type) -> ENLEVEMENT.
    tour_type = data.tour_type or TourType.LIVRAISON
    if data.is_pickup_tour and tour_type == TourType.LIVRAISON:
        tour_type = TourType.ENLEVEMENT
    is_pickup = tour_type in PICKUP_TYPES

    tour = Tour(
        date=data.date,
        code=data.code,
        vehicle_type=data.vehicle_type,
        capacity_eqp=data.capacity_eqp,
        contract_id=data.contract_id,
        departure_time=data.departure_time,
        return_time=return_time,
        total_km=total_km,
        total_duration_minutes=total_duration,
        total_eqp=data.total_eqp,
        total_cost=total_cost,
        status=data.status,
        base_id=data.base_id,
        return_base_id=data.return_base_id,
        final_pickup_supplier_id=data.final_pickup_supplier_id,
        final_pickup_duration_minutes=data.final_pickup_duration_minutes,
        temperature_type=data.temperature_type,
        is_pickup_tour=is_pickup,
        tour_type=tour_type,
        destination=data.destination,
        supplier_id=data.supplier_id,
        driver_name=data.driver_name,
        driver_code_infolog=data.driver_code_infolog,
        remarks=data.remarks,
    )
    db.add(tour)
    await db.flush()

    # Calculer le coût après flush (pour que nb_tours inclue le tour courant)
    if contract and data.departure_time:
        tour.total_cost, _ = await _calculate_cost(
            db, total_km, contract, data.date, data.base_id, stops_input,
            own_trailer=bool(getattr(data, "vehicle_id", None)),
            return_base_id=data.return_base_id,
            final_pickup_supplier_id=data.final_pickup_supplier_id,
        )

    pdv_ids = []
    # Index des données pickup originales par (pdv_id, seq) / Original pickup data index
    pickup_index = {(s["pdv_id"], s["sequence_order"]): s for s in stops_input}

    for stop_data in enriched_stops:
        original = pickup_index.get((stop_data["pdv_id"], stop_data["sequence_order"]), {})
        stop = TourStop(
            tour_id=tour.id,
            pdv_id=stop_data["pdv_id"],
            volume_id=original.get("volume_id"),
            sequence_order=stop_data["sequence_order"],
            eqp_count=stop_data["eqp_count"],
            arrival_time=stop_data.get("arrival_time"),
            departure_time=stop_data.get("departure_time"),
            distance_from_previous_km=stop_data.get("distance_from_previous_km"),
            duration_from_previous_minutes=stop_data.get("duration_from_previous_minutes"),
            pickup_cardboard=original.get("pickup_cardboard", False),
            pickup_containers=original.get("pickup_containers", False),
            pickup_returns=original.get("pickup_returns", False),
            pickup_consignment=original.get("pickup_consignment", False),
        )
        db.add(stop)
        pdv_ids.append(stop_data["pdv_id"])

    if pdv_ids:
        # Calculer EQP cible par PDV (somme des stops) / Compute target EQP per PDV
        # Tout en float pour eviter les TypeError float/Decimal apres ALTER COLUMN
        # numeric. / All in float to avoid float/Decimal TypeError after the
        # eqp_count column type change to numeric.
        stop_eqp_by_pdv: dict[int, float] = {}
        for stop_data in enriched_stops:
            pid = stop_data["pdv_id"]
            stop_eqp_by_pdv[pid] = stop_eqp_by_pdv.get(pid, 0.0) + float(stop_data["eqp_count"])

        # Volumes explicitement référencés par les stops (front récent) → assignation
        # EXACTE, sans ambiguïté quand un PDV a plusieurs volumes de même eqc. /
        # Volume ids explicitly referenced by stops → exact assignment.
        explicit_ids = {s["volume_id"] for s in stops_input if s.get("volume_id") is not None}

        vol_result = await db.execute(
            select(Volume).where(
                Volume.pdv_id.in_(pdv_ids),
                Volume.dispatch_date == data.date,
                Volume.tour_id.is_(None),
            )
        )
        all_unassigned = list(vol_result.scalars().all())

        # 1) Assigner exactement les volumes référencés et déduire leur eqc de la
        #    cible du PDV. / Exact-assign referenced volumes, subtract from target.
        assigned_exact: set[int] = set()
        for vol in all_unassigned:
            if vol.id in explicit_ids:
                vol.tour_id = tour.id
                assigned_exact.add(vol.id)
                stop_eqp_by_pdv[vol.pdv_id] = stop_eqp_by_pdv.get(vol.pdv_id, 0.0) - float(vol.eqp_count)

        # 2) Greedy résiduel pour les stops SANS volume_id (legacy / robustesse) :
        #    grouper par pdv_id et compléter jusqu'à l'EQP cible restant (plus grands
        #    d'abord). / Residual greedy for stops without a volume_id (legacy).
        by_pdv: dict[int, list[Volume]] = {}
        for vol in all_unassigned:
            if vol.id in assigned_exact:
                continue
            # #84 : ne completer qu'avec des volumes de la base de chargement du
            # tour. Sans ce filtre la reprise gloutonne rattachait au tour FRAIS
            # de Villers le volume SEC du meme PDV parti de Gosselies. /
            # Only top up with volumes from the tour's own loading base.
            if (
                data.base_id
                and vol.base_origin_id is not None
                and vol.base_origin_id != data.base_id
            ):
                continue
            by_pdv.setdefault(vol.pdv_id, []).append(vol)

        for pid, vols in by_pdv.items():
            target = stop_eqp_by_pdv.get(pid, 0.0)
            if target <= 0:
                continue
            vols.sort(key=lambda v: float(v.eqp_count), reverse=True)
            remaining = target
            for vol in vols:
                if remaining <= 0:
                    break
                vol_eqp = float(vol.eqp_count)
                if vol_eqp <= remaining:
                    vol.tour_id = tour.id
                    remaining -= vol_eqp

    # Recalculer les tours frères (terme fixe réparti) / Recalculate sibling tours (shared fixed cost)
    if data.contract_id:
        await _recalculate_sibling_tours(db, data.contract_id, data.date)

    # Audit log
    await _log_audit(db, "tour", tour.id, "CREATE", user, {
        "code": tour.code, "date": tour.date, "contract_id": tour.contract_id,
        "total_cost": float(tour.total_cost) if tour.total_cost else None,
    })

    await db.flush()
    result = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return result.scalar_one()


@router.put("/{tour_id}", response_model=TourRead)
async def update_tour(
    tour_id: int,
    data: TourUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "update")),
):
    tour = await db.get(Tour, tour_id)
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")
    changes = data.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(tour, key, value)

    # Audit log
    await _log_audit(db, "tour", tour.id, "UPDATE", user, changes)

    await db.flush()
    result = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return result.scalar_one()


@router.put("/{tour_id}/schedule", response_model=TourRead)
async def schedule_tour(
    tour_id: int,
    data: TourSchedule,
    force: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "update")),
):
    """Planifier un tour : contrat presté, parc propre ou mixte.
    Schedule: contract (rented), own fleet, or mixed (own semi + rented tractor).
    """
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    # Base de retour (#64) : elle se décide à l'ordonnancement, en même temps que
    # le contrat et l'heure de départ, et doit donc être posée AVANT le calcul des
    # horaires et du kilométrage. Rien de précisé = retour sur la base de départ.
    # / The return base is decided when scheduling, so set it before computing.
    if "return_base_id" in data.model_fields_set:
        if data.return_base_id and data.return_base_id != tour.base_id:
            ret_base = await db.get(BaseLogistics, data.return_base_id)
            if not ret_base:
                raise HTTPException(status_code=422, detail="Base de retour introuvable")
            tour.return_base_id = data.return_base_id
        else:
            tour.return_base_id = None

    # Enlèvement fournisseur de fin de tournée (#74) : il se décide en même temps
    # que le reste de l'attribution, donc avant les calculs qui en dépendent.
    if "final_pickup_supplier_id" in data.model_fields_set:
        if data.final_pickup_supplier_id:
            if not await db.get(Supplier, data.final_pickup_supplier_id):
                raise HTTPException(status_code=422, detail="Fournisseur d'enlèvement introuvable")
            if not tour.stops:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Un enlèvement de fin de tournée suppose une tournée de livraison. "
                        "Pour un enlèvement seul, utilisez la nature « Enlèvement dédié »."
                    ),
                )
            tour.final_pickup_supplier_id = data.final_pickup_supplier_id
            tour.final_pickup_duration_minutes = data.final_pickup_duration_minutes
        else:
            tour.final_pickup_supplier_id = None
            tour.final_pickup_duration_minutes = None

    stops_data = [
        {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
        for s in sorted(tour.stops, key=lambda s: s.sequence_order)
    ]

    enriched_stops, return_time, total_duration = await calculate_tour_times(
        data.departure_time, stops_data, tour.base_id, db, tour.return_base_id,
        tour.final_pickup_supplier_id, tour.final_pickup_duration_minutes,
    )

    # ── Validation véhicule propre / Own vehicle validation ──────────────────
    own_vehicle: Vehicle | None = None
    own_tractor: Vehicle | None = None
    if data.vehicle_id:
        own_vehicle = await db.get(Vehicle, data.vehicle_id)
        if not own_vehicle:
            raise HTTPException(status_code=422, detail=f"Véhicule propre introuvable (id={data.vehicle_id})")
        if own_vehicle.status != VehicleStatus.ACTIVE:
            raise HTTPException(status_code=422, detail=f"Véhicule propre non disponible : {own_vehicle.code} ({own_vehicle.status.value})")
        if tour.vehicle_type:
            expected_fleet = VEHICLE_TYPE_TO_FLEET.get(tour.vehicle_type, [])
            fvt = own_vehicle.fleet_vehicle_type.value if hasattr(own_vehicle.fleet_vehicle_type, 'value') else own_vehicle.fleet_vehicle_type
            if expected_fleet and fvt not in expected_fleet:
                raise HTTPException(status_code=422, detail=f"Type de véhicule propre incompatible : {fvt} (attendu {', '.join(expected_fleet)})")

    if data.tractor_id:
        own_tractor = await db.get(Vehicle, data.tractor_id)
        if not own_tractor:
            raise HTTPException(status_code=422, detail=f"Tracteur propre introuvable (id={data.tractor_id})")
        if own_tractor.status != VehicleStatus.ACTIVE:
            raise HTTPException(status_code=422, detail=f"Tracteur propre non disponible : {own_tractor.code} ({own_tractor.status.value})")
        tractor_fvt = own_tractor.fleet_vehicle_type.value if hasattr(own_tractor.fleet_vehicle_type, 'value') else own_tractor.fleet_vehicle_type
        if tractor_fvt != "TRACTEUR":
            raise HTTPException(status_code=422, detail=f"Le véhicule tractor_id n'est pas un tracteur : {tractor_fvt}")

    # Mode propre : tracteur obligatoire / Own mode: tractor required
    if data.tractor_id and not data.contract_id and not data.vehicle_id:
        pass  # Mode propre valide : tracteur propre, remorque assignée par le postier

    # Chevauchement comparé sur une timeline ABSOLUE (jour de livraison + heure) :
    # une même répartition peut produire des tours livrés des jours différents,
    # qui ne se chevauchent donc pas. Voir tours_time_overlap(). /
    # Overlap compared on an ABSOLUTE timeline (delivery day + time).
    _intervals_overlap = tours_time_overlap

    # Jour de livraison du tour planifié (priorité à la nouvelle date saisie) /
    # Delivery day of the tour being scheduled (new date takes precedence)
    sched_day = data.delivery_date or tour.delivery_date or tour.date

    # ── Vérification chevauchement contrat / Contract overlap check ───────────
    if data.contract_id:
        other_contract_tours_result = await db.execute(
            select(Tour).where(
                Tour.date == tour.date,
                Tour.contract_id == data.contract_id,
                Tour.id != tour.id,
                Tour.departure_time.isnot(None),
                Tour.return_time.isnot(None),
            )
        )
        other_contract_tours = list(other_contract_tours_result.scalars().all())
        for other in other_contract_tours:
            if _intervals_overlap(
                sched_day, data.departure_time, return_time,
                other.delivery_date or other.date, other.departure_time, other.return_time,
            ):
                raise HTTPException(
                    status_code=409,
                    detail=f"Overlap with tour {other.code} ({other.departure_time}-{other.return_time})",
                )

        # Vérification dépassement 10h / Check 10h daily limit
        MAX_CONTRACT_DAILY_MINUTES = 600
        if not force:
            existing_minutes = sum(t.total_duration_minutes or 0 for t in other_contract_tours)
            projected_total = existing_minutes + (total_duration or 0)
            if projected_total > MAX_CONTRACT_DAILY_MINUTES:
                hours = projected_total // 60
                mins = projected_total % 60
                raise HTTPException(status_code=422, detail=f"OVER_10H:{hours}h{mins:02d}")
    else:
        other_contract_tours = []

    # ── Vérification chevauchement véhicule propre / Own vehicle overlap check ─
    if data.vehicle_id:
        overlap_q = select(Tour).where(
            Tour.date == tour.date,
            Tour.id != tour.id,
            Tour.departure_time.isnot(None),
            Tour.return_time.isnot(None),
            Tour.vehicle_id == data.vehicle_id,
        )
        overlap_result = await db.execute(overlap_q)
        for other in overlap_result.scalars().all():
            if _intervals_overlap(
                sched_day, data.departure_time, return_time,
                other.delivery_date or other.date, other.departure_time, other.return_time,
            ):
                raise HTTPException(
                    status_code=409,
                    detail=f"Overlap (véhicule propre) with tour {other.code} ({other.departure_time}-{other.return_time})",
                )
    if data.tractor_id:
        tractor_overlap_q = select(Tour).where(
            Tour.date == tour.date,
            Tour.id != tour.id,
            Tour.departure_time.isnot(None),
            Tour.return_time.isnot(None),
            Tour.tractor_id == data.tractor_id,
        )
        tractor_overlap_result = await db.execute(tractor_overlap_q)
        for other in tractor_overlap_result.scalars().all():
            if _intervals_overlap(
                sched_day, data.departure_time, return_time,
                other.delivery_date or other.date, other.departure_time, other.return_time,
            ):
                raise HTTPException(
                    status_code=409,
                    detail=f"Overlap (tracteur propre) with tour {other.code} ({other.departure_time}-{other.return_time})",
                )

    # ── Vérification fenêtres de livraison PDV / PDV delivery windows ────────
    if not force and enriched_stops:
        pdv_ids = [s["pdv_id"] for s in enriched_stops]
        pdv_result = await db.execute(select(PDV).where(PDV.id.in_(pdv_ids)))
        pdv_windows = {p.id: p for p in pdv_result.scalars().all()}
        violations = []
        for stop in enriched_stops:
            pdv = pdv_windows.get(stop["pdv_id"])
            if not pdv or not stop.get("arrival_time"):
                continue
            arrival = stop["arrival_time"]
            if pdv.delivery_window_start and arrival < pdv.delivery_window_start:
                violations.append(f"{pdv.code} {pdv.name}: {arrival} < {pdv.delivery_window_start}")
            if pdv.delivery_window_end and arrival > pdv.delivery_window_end:
                violations.append(f"{pdv.code} {pdv.name}: {arrival} > {pdv.delivery_window_end}")
        if violations:
            raise HTTPException(status_code=422, detail=f"DELIVERY_WINDOW:{' | '.join(violations)}")

    # ── Chargement du contrat / Load contract ─────────────────────────────────
    contract: Contract | None = None
    if data.contract_id:
        contract = await db.get(Contract, data.contract_id)

        # Disponibilité contrat / Contract availability
        from app.models.contract_schedule import ContractSchedule
        check_date = data.delivery_date or tour.delivery_date or tour.date
        sched_check = await db.execute(
            select(ContractSchedule).where(
                ContractSchedule.contract_id == data.contract_id,
                ContractSchedule.date == check_date,
                ContractSchedule.is_available == False,
            )
        )
        if sched_check.scalar_one_or_none():
            raise HTTPException(status_code=422, detail=f"CONTRACT_UNAVAILABLE:{check_date}")

    # ── Compatibilité quai/hayon et type véhicule / Dock, tailgate, vehicle type ─
    # Construire un objet "vehicle_props" pour les helpers (contract ou véhicule propre)
    # Build a "vehicle_props" duck-typed object for the compatibility helpers
    if stops_data:
        if contract:
            vehicle_props = contract
        elif own_vehicle:
            vehicle_props = SimpleNamespace(
                vehicle_type=tour.vehicle_type,
                has_tailgate=own_vehicle.has_tailgate,
                tailgate_type=own_vehicle.tailgate_type,
            )
        else:
            vehicle_props = None

        if vehicle_props:
            dock_violations = await _check_dock_tailgate_compatibility(db, stops_data, vehicle_props)  # type: ignore[arg-type]
            if dock_violations:
                raise HTTPException(status_code=422, detail=f"DOCK_TAILGATE:{' | '.join(dock_violations)}")
            vt_violations = await _check_vehicle_type_compatibility(
                db, stops_data, vehicle_props, tour.vehicle_type,  # type: ignore[arg-type]
            )
            if vt_violations:
                raise HTTPException(status_code=422, detail=f"VEHICLE_TYPE:{' | '.join(vt_violations)}")

    # ── Calcul km et sauvegarde / Km calculation and save ────────────────────
    total_km = sum(s.get("distance_from_previous_km", 0) for s in enriched_stops)
    if enriched_stops:
        last_pdv_id = enriched_stops[-1]["pdv_id"]
        total_km += await _km_after_last_stop(
            db, last_pdv_id, tour.base_id, tour.return_base_id,
            tour.final_pickup_supplier_id,
        )
    total_km = round(total_km, 2)

    tour.contract_id = data.contract_id
    tour.vehicle_id = data.vehicle_id
    tour.tractor_id = data.tractor_id
    if data.driver_name:
        tour.driver_name = data.driver_name
    # Code chauffeur Infolog figé au planning (pour l'export WMS) /
    # Driver Infolog code captured at scheduling time (for the WMS export)
    tour.driver_code_infolog = data.driver_code_infolog or None
    tour.departure_time = data.departure_time
    tour.return_time = return_time
    if data.delivery_date:
        tour.delivery_date = data.delivery_date
    # Priorité manuelle d'ordonnancement (départage les départs à même heure)
    tour.priority = data.priority
    tour.total_km = total_km
    tour.total_duration_minutes = total_duration

    # Flush d'abord pour que nb_tours soit correct / Flush first so nb_tours count is correct
    await db.flush()
    if contract:
        total_cost, _ = await _calculate_cost(
            db, total_km, contract, tour.date, tour.base_id, stops_data,
            own_trailer=bool(getattr(tour, "vehicle_id", None)),
            return_base_id=tour.return_base_id,
            final_pickup_supplier_id=tour.final_pickup_supplier_id,
        )
        tour.total_cost = total_cost
    else:
        tour.total_cost = None  # Parc propre : coût géré par VehicleCostEntry / Own fleet: cost via VehicleCostEntry

    for stop in tour.stops:
        for enriched in enriched_stops:
            if stop.pdv_id == enriched["pdv_id"] and stop.sequence_order == enriched["sequence_order"]:
                stop.arrival_time = enriched.get("arrival_time")
                stop.departure_time = enriched.get("departure_time")
                stop.distance_from_previous_km = enriched.get("distance_from_previous_km")
                stop.duration_from_previous_minutes = enriched.get("duration_from_previous_minutes")
                break

    # Recalculer les tours frères (seulement si contrat) / Recalculate sibling tours (contract only)
    if data.contract_id:
        await _recalculate_sibling_tours(db, data.contract_id, tour.date)

    # Audit log
    await _log_audit(db, "tour", tour.id, "SCHEDULE", user, {
        "contract_id": data.contract_id,
        "vehicle_id": data.vehicle_id,
        "tractor_id": data.tractor_id,
        "departure_time": data.departure_time,
        "total_cost": float(tour.total_cost) if tour.total_cost else None,
    })

    await db.flush()
    result = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return result.scalar_one()


@router.put("/{tour_id}/reorder-stops", response_model=TourRead)
async def reorder_tour_stops(
    tour_id: int,
    data: ReorderStopsRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "update")),
):
    """Permuter / réordonner les arrêts PDV d'un tour, avec recalcul des temps,
    km et coût. Réordonnancement manuel (pas de blocage fenêtre/chevauchement :
    le front affiche les avertissements). / Reorder a tour's PDV stops with
    time/km/cost recompute.
    """
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    stops_by_id = {s.id: s for s in tour.stops}
    if set(data.stop_order) != set(stops_by_id.keys()):
        raise HTTPException(
            status_code=422,
            detail="stop_order doit contenir exactement les arrêts du tour",
        )

    # Réassigner l'ordre / Reassign sequence order
    for new_seq, sid in enumerate(data.stop_order, start=1):
        stops_by_id[sid].sequence_order = new_seq
    await db.flush()

    # Recalcul des temps/km/coût si le tour est planifié (heure de départ) /
    # Recompute times/km/cost if scheduled
    if tour.departure_time:
        stops_data = [
            {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
            for s in sorted(tour.stops, key=lambda s: s.sequence_order)
        ]
        enriched_stops, return_time, total_duration = await calculate_tour_times(
            tour.departure_time, stops_data, tour.base_id, db, tour.return_base_id,
            tour.final_pickup_supplier_id, tour.final_pickup_duration_minutes,
        )
        total_km = sum(s.get("distance_from_previous_km", 0) for s in enriched_stops)
        if enriched_stops:
            last_pdv_id = enriched_stops[-1]["pdv_id"]
            total_km += await _km_after_last_stop(
                db, last_pdv_id, tour.base_id, tour.return_base_id,
                tour.final_pickup_supplier_id,
            )
        tour.return_time = return_time
        tour.total_km = round(total_km, 2)
        tour.total_duration_minutes = total_duration

        for stop in tour.stops:
            for e in enriched_stops:
                if stop.pdv_id == e["pdv_id"] and stop.sequence_order == e["sequence_order"]:
                    stop.arrival_time = e.get("arrival_time")
                    stop.departure_time = e.get("departure_time")
                    stop.distance_from_previous_km = e.get("distance_from_previous_km")
                    stop.duration_from_previous_minutes = e.get("duration_from_previous_minutes")
                    break

        await db.flush()
        if tour.contract_id:
            contract = await db.get(Contract, tour.contract_id)
            if contract:
                tour.total_cost, _ = await _calculate_cost(
                    db, tour.total_km, contract, tour.date, tour.base_id, stops_data,
                    own_trailer=bool(getattr(tour, "vehicle_id", None)),
                    return_base_id=tour.return_base_id,
                    final_pickup_supplier_id=tour.final_pickup_supplier_id,
                )

    await _log_audit(db, "tour", tour.id, "REORDER_STOPS", user, {"stop_order": data.stop_order})

    await db.flush()
    result = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return result.scalar_one()


@router.delete("/{tour_id}/schedule", response_model=TourRead)
async def unschedule_tour(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-unschedule", "update")),
):
    """Retirer la planification d'un tour / Remove tour scheduling.

    Permission dédiée `tour-unschedule` (distincte de tour-planning:update) :
    le transport peut retirer un tour au postier, le Poste de Garde non.
    """
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    if tour.departure_signal_time:
        raise HTTPException(
            status_code=409,
            detail="Tour verrouillé : top départ validé / Tour locked: departure signal confirmed",
        )

    old_contract_id = tour.contract_id
    old_date = tour.date

    old_vehicle_id = tour.vehicle_id
    old_tractor_id = tour.tractor_id

    tour.contract_id = None
    tour.vehicle_id = None     # Libérer le véhicule propre / Release own vehicle
    tour.tractor_id = None     # Libérer le tracteur propre / Release own tractor
    tour.departure_time = None
    tour.return_time = None
    tour.total_duration_minutes = None
    tour.total_cost = None

    for stop in tour.stops:
        stop.arrival_time = None
        stop.departure_time = None

    # Recalculer les tours frères restants / Recalculate remaining sibling tours
    if old_contract_id:
        await _recalculate_sibling_tours(db, old_contract_id, old_date)

    # Audit log
    await _log_audit(db, "tour", tour.id, "UNSCHEDULE", user, {
        "old_contract_id": old_contract_id,
        "old_vehicle_id": old_vehicle_id,
        "old_tractor_id": old_tractor_id,
    })

    await db.flush()
    result = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return result.scalar_one()


# =========================================================================
# Auto-liaison reprises / Pickup auto-linking helper
# =========================================================================

async def _auto_link_pickup_labels(tour: Tour, db: AsyncSession) -> int:
    """Lier les étiquettes PENDING aux stops qui ont un flag reprise /
    Auto-link PENDING pickup labels to tour stops that have a pickup flag enabled.
    Returns the number of labels linked.
    """
    linked = 0
    for stop in tour.stops:
        for flag_name, ptype in PICKUP_FLAG_TO_TYPE.items():
            if not getattr(stop, flag_name, False):
                continue
            label_result = await db.execute(
                select(PickupLabel).join(PickupRequest).where(
                    PickupRequest.pdv_id == stop.pdv_id,
                    PickupRequest.pickup_type == ptype,
                    PickupLabel.status == LabelStatus.PENDING,
                    PickupLabel.tour_stop_id.is_(None),
                )
            )
            labels = label_result.scalars().all()
            for label in labels:
                label.tour_stop_id = stop.id
                label.status = LabelStatus.PLANNED
                linked += 1
            if labels:
                req_ids = list({lb.pickup_request_id for lb in labels})
                for rid in req_ids:
                    req_result = await db.execute(
                        select(PickupRequest)
                        .where(PickupRequest.id == rid)
                        .options(selectinload(PickupRequest.labels))
                    )
                    req = req_result.scalar_one_or_none()
                    if req:
                        from app.api.pickup_requests import _auto_progress_request
                        _auto_progress_request(req)
    return linked


# =========================================================================
# Validation endpoints / Endpoints de validation
# =========================================================================

@router.put("/{tour_id}/validate", response_model=TourRead)
async def validate_tour(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "update")),
):
    """Valider un tour DRAFT → VALIDATED / Validate a DRAFT tour."""
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")
    if tour.status != TourStatus.DRAFT:
        raise HTTPException(status_code=422, detail="Seuls les tours DRAFT peuvent etre valides")
    tour.status = TourStatus.VALIDATED

    # Auto-link pickup labels aux tour_stops (tous types) / Auto-link pickup labels to stops (all types)
    await _auto_link_pickup_labels(tour, db)

    await _log_audit(db, "tour", tour.id, "VALIDATE", user, {"old_status": "DRAFT", "new_status": "VALIDATED"})
    await db.flush()
    result = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return result.scalar_one()


@router.put("/{tour_id}/revert-draft", response_model=TourRead)
async def revert_tour_draft(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "update")),
):
    """Remettre un tour VALIDATED → DRAFT / Revert a VALIDATED tour to DRAFT."""
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")
    if tour.status != TourStatus.VALIDATED:
        raise HTTPException(status_code=422, detail="Seuls les tours VALIDATED peuvent etre remis en DRAFT")
    if tour.departure_signal_time:
        raise HTTPException(
            status_code=409,
            detail="Tour verrouille : top depart valide / Tour locked: departure signal confirmed",
        )
    tour.status = TourStatus.DRAFT
    await _log_audit(db, "tour", tour.id, "REVERT_DRAFT", user, {"old_status": "VALIDATED", "new_status": "DRAFT"})
    await db.flush()
    result = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return result.scalar_one()


@router.post("/validate-batch")
async def validate_batch(
    date: str = Query(...),
    base_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "update")),
):
    """Valider tous les tours DRAFT planifies pour une date/base / Validate all scheduled DRAFT tours for a date/base."""
    filters = [
        Tour.date == date,
        Tour.status == TourStatus.DRAFT,
        Tour.departure_time.isnot(None),
    ]
    if base_id is not None:
        filters.append(Tour.base_id == base_id)
    result = await db.execute(
        select(Tour).where(*filters).options(selectinload(Tour.stops))
    )
    tours_to_validate = result.scalars().all()
    count = 0
    for tour in tours_to_validate:
        tour.status = TourStatus.VALIDATED
        await _auto_link_pickup_labels(tour, db)
        await _log_audit(db, "tour", tour.id, "VALIDATE", user, {"old_status": "DRAFT", "new_status": "VALIDATED"})
        count += 1
    await db.flush()
    return {"validated": count}


# =========================================================================
# Endpoints opérationnels / Operational endpoints
# =========================================================================

@router.put("/{tour_id}/operations", response_model=TourRead)
async def update_tour_operations(
    tour_id: int,
    data: TourOperationsUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("operations", "update")),
):
    """Mise à jour exploitant : chauffeur, heures, remarques / Operations update: driver, times, remarks."""
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")
    changes = data.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(tour, key, value)
    await _log_audit(db, "tour", tour.id, "UPDATE_OPERATIONS", user, changes)
    await db.flush()
    result = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return result.scalar_one()


@router.put("/{tour_id}/gate", response_model=TourRead)
async def update_tour_gate(
    tour_id: int,
    data: TourGateUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("guard-post", "update")),
):
    """Mise à jour poste de garde : barrière sortie/entrée / Gate update: barrier exit/entry."""
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")
    changes = data.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(tour, key, value)
    # Si barrier_entry_time renseigne et tour RETURNING → passer a COMPLETED / If barrier_entry_time set and tour RETURNING → transition to COMPLETED
    if "barrier_entry_time" in changes and changes["barrier_entry_time"] and tour.status == TourStatus.RETURNING:
        tour.status = TourStatus.COMPLETED
        from app.api.ws_tracking import manager
        await manager.broadcast(tenant_id=tour.tenant_id, message={
            "type": "tour_status",
            "tour_id": tour_id,
            "tour_code": tour.code,
            "status": "COMPLETED",
            "barrier_entry_time": changes["barrier_entry_time"],
        })

        # ── Mise à jour flotte parc propre / Own fleet update on completion ──
        from app.models.vehicle_cost_entry import VehicleCostEntry, CostCategory
        km_parcourus: int | None = None
        if tour.km_return is not None and tour.km_departure is not None and tour.km_return > tour.km_departure:
            km_parcourus = tour.km_return - tour.km_departure

        async def _update_vehicle_on_completion(vehicle_id: int, is_tractor: bool) -> None:
            """Met à jour le kilométrage et trace l'utilisation en tournée.
            Updates mileage and logs tour usage for an own fleet vehicle.
            """
            vehicle = await db.get(Vehicle, vehicle_id)
            if not vehicle:
                return
            # Mise à jour kilométrage / Update mileage
            if tour.km_return is not None:
                vehicle.current_km = tour.km_return
                vehicle.last_km_update = datetime.utcnow().isoformat()

            # Entrée de coût OPERATION (montant 0 — sert de journal d'utilisation)
            # OPERATION cost entry (amount 0 — serves as usage log, actual costs tracked via fuel/maintenance)
            desc_parts = [f"Tour {tour.code} — {tour.date}"]
            if tour.driver_name:
                desc_parts.append(f"Chauffeur : {tour.driver_name}")
            if km_parcourus is not None:
                desc_parts.append(f"{km_parcourus} km")
            if is_tractor:
                desc_parts.append("(tracteur)")
            cost_entry = VehicleCostEntry(
                vehicle_id=vehicle_id,
                category=CostCategory.OPERATION,
                date=tour.date,
                description=" | ".join(desc_parts),
                amount=0.0,
                notes=f"Tour {tour.code} | départ {tour.departure_time} → retour {tour.return_time or tour.actual_return_time or '?'}"
                      + (f" | km départ {tour.km_departure} → retour {tour.km_return}" if tour.km_departure and tour.km_return else ""),
            )
            db.add(cost_entry)

        if tour.vehicle_id:
            await _update_vehicle_on_completion(tour.vehicle_id, is_tractor=False)
        if tour.tractor_id:
            await _update_vehicle_on_completion(tour.tractor_id, is_tractor=True)

    await _log_audit(db, "tour", tour.id, "UPDATE_GATE", user, changes)
    await db.flush()
    result = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return result.scalar_one()


@router.get("/{tour_id}/waybill")
async def get_tour_waybill(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("operations", "read")),
):
    """Données lettre de voiture CMR / Waybill data (tour + base + contract + PDVs + volumes)."""
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    base = await db.get(BaseLogistics, tour.base_id)
    contract = await db.get(Contract, tour.contract_id) if tour.contract_id else None
    # Charger le carrier via le contrat / Load carrier through contract
    carrier = None
    if contract and contract.carrier_id:
        from app.models.carrier import Carrier
        carrier = await db.get(Carrier, contract.carrier_id)

    # Charger véhicules / Load vehicles
    from app.models.vehicle import Vehicle
    vehicle = await db.get(Vehicle, tour.vehicle_id) if tour.vehicle_id else None
    tractor = await db.get(Vehicle, tour.tractor_id) if tour.tractor_id else None

    # Vérifier si un CMR existe pour ce tour / Check if CMR archive exists for this tour
    from app.models.waybill_archive import WaybillArchive
    cmr_result = await db.execute(
        select(WaybillArchive).where(WaybillArchive.tour_id == tour_id)
    )
    cmr_archive = cmr_result.scalar_one_or_none()

    # Charger PDVs et volumes des stops / Load PDVs and volumes for stops
    pdv_ids = [s.pdv_id for s in tour.stops]
    pdvs_map: dict[int, PDV] = {}
    if pdv_ids:
        pdv_result = await db.execute(select(PDV).where(PDV.id.in_(pdv_ids)))
        for p in pdv_result.scalars().all():
            pdvs_map[p.id] = p

    volumes_map: dict[int, list[Volume]] = {}
    if pdv_ids:
        vol_result = await db.execute(
            select(Volume).where(Volume.tour_id == tour.id)
        )
        for v in vol_result.scalars().all():
            volumes_map.setdefault(v.pdv_id, []).append(v)

    sorted_stops = sorted(tour.stops, key=lambda s: s.sequence_order)
    stops_data = []
    total_eqp = 0
    total_weight = 0.0
    for stop in sorted_stops:
        pdv = pdvs_map.get(stop.pdv_id)
        vols = volumes_map.get(stop.pdv_id, [])
        weight = sum(float(v.weight_kg or 0) for v in vols)
        temp_classes = list({v.temperature_class for v in vols if v.temperature_class})
        total_eqp += stop.eqp_count
        total_weight += weight
        stops_data.append({
            "sequence": stop.sequence_order,
            "pdv_code": pdv.code if pdv else f"#{stop.pdv_id}",
            "pdv_name": pdv.name if pdv else "",
            "address": pdv.address if pdv else "",
            "postal_code": pdv.postal_code if pdv else "",
            "city": pdv.city if pdv else "",
            "eqp_count": stop.eqp_count,
            "weight_kg": round(weight, 2),
            "temperature_classes": temp_classes,
            "arrival_time": stop.arrival_time,
            "departure_time": stop.departure_time,
            "pickup_cardboard": getattr(stop, "pickup_cardboard", False),
            "pickup_containers": getattr(stop, "pickup_containers", False),
            "pickup_returns": getattr(stop, "pickup_returns", False),
            "pickup_consignment": getattr(stop, "pickup_consignment", False),
        })

    # Dispatch info : prendre le premier volume avec dispatch_date / First volume with dispatch info
    dispatch_date = None
    dispatch_time = None
    for vols in volumes_map.values():
        for v in vols:
            if v.dispatch_date:
                dispatch_date = v.dispatch_date
                dispatch_time = v.dispatch_time
                break
        if dispatch_date:
            break

    return {
        "tour_id": tour.id,
        "tour_code": tour.code,
        "date": tour.date,
        "delivery_date": tour.delivery_date,
        "dispatch_date": dispatch_date,
        "dispatch_time": dispatch_time,
        "departure_time": tour.departure_time,
        "return_time": tour.return_time,
        "driver_name": tour.driver_name,
        "trailer_number": tour.trailer_number,
        "dock_door_number": tour.dock_door_number,
        "remarks": tour.remarks,
        "vehicle_license_plate": vehicle.license_plate if vehicle else None,
        "tractor_license_plate": tractor.license_plate if tractor else None,
        "base": {
            "code": base.code if base else "",
            "name": base.name if base else "",
            "address": base.address if base else "",
            "postal_code": base.postal_code if base else "",
            "city": base.city if base else "",
        } if base else None,
        "contract": {
            "code": contract.code,
            "transporter_name": carrier.name if carrier else contract.transporter_name,
            "vehicle_code": contract.vehicle_code,
            "vehicle_name": contract.vehicle_name,
            "temperature_type": contract.temperature_type.value if contract.temperature_type else None,
            "vehicle_type": contract.vehicle_type.value if contract.vehicle_type else None,
            "capacity_weight_kg": contract.capacity_weight_kg,
            "carrier_address": carrier.address if carrier else None,
            "carrier_postal_code": carrier.postal_code if carrier else None,
            "carrier_city": carrier.city if carrier else None,
            "carrier_country": carrier.country if carrier else None,
            "carrier_transport_license": carrier.transport_license if carrier else None,
            "carrier_vat_number": carrier.vat_number if carrier else None,
            "carrier_siren": carrier.siren if carrier else None,
            "carrier_phone": carrier.phone if carrier else None,
        } if contract else None,
        "cmr_archive": {
            "id": cmr_archive.id,
            "cmr_number": cmr_archive.cmr_number,
            "status": cmr_archive.status.value if cmr_archive.status else None,
            "issued_at": cmr_archive.issued_at,
        } if cmr_archive else None,
        "stops": stops_data,
        "total_eqp": total_eqp,
        "total_weight_kg": round(total_weight, 2),
    }


@router.get("/{tour_id}/cost-breakdown")
async def get_tour_cost_breakdown(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "read")),
):
    """Détail du calcul de coût d'un tour / Tour cost calculation breakdown."""
    result = await db.execute(
        select(Tour).where(Tour.id == tour_id).options(selectinload(Tour.stops))
    )
    tour = result.scalar_one_or_none()
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    contract = await db.get(Contract, tour.contract_id) if tour.contract_id else None
    if not contract:
        return {
            "tour_id": tour.id, "tour_code": tour.code,
            "total_cost": float(tour.total_cost) if tour.total_cost else 0,
            "message": "No contract assigned",
        }

    total_km = float(tour.total_km or 0)

    # 1. Terme fixe + vacation / Fixed cost + vacation share
    nb_tours = await db.scalar(
        select(func.count(Tour.id)).where(
            Tour.contract_id == contract.id,
            Tour.date == tour.date,
        )
    ) or 1
    # Une seule vacation (#58) — voir effective_vacation. / Single fixed term.
    fixed_daily = 0.0
    fixed_share = 0.0
    vacation_daily = effective_vacation(contract)
    vacation_share = round(vacation_daily / nb_tours, 2)

    # 2. Coût carburant (selon type du contrat) / Fuel cost (by contract fuel type)
    breakdown_warnings: list[str] = []
    fuel_prices = await load_fuel_unit_prices(db, tour.date)
    fuel_price = price_for_contract(fuel_prices, contract)
    if not fuel_price:
        breakdown_warnings.append(
            f"Aucun prix {contract_fuel_type(contract).lower()} trouvé pour la date {tour.date}"
        )
    consumption = float(contract.consumption_coefficient or 0)
    fuel_cost = round(total_km * fuel_price * consumption, 2)

    # 3. Taxe km par segment / Km tax per segment
    stops_data = [
        {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
        for s in sorted(tour.stops, key=lambda s: s.sequence_order)
    ]
    segments = _build_segments(tour.base_id, stops_data, tour.return_base_id, tour.final_pickup_supplier_id)

    # Charger les noms des PDV et bases / Load PDV and base names
    pdv_ids = list({s.pdv_id for s in tour.stops})
    pdv_result = await db.execute(select(PDV).where(PDV.id.in_(pdv_ids))) if pdv_ids else None
    pdv_map = {p.id: p for p in pdv_result.scalars().all()} if pdv_result else {}
    base = await db.get(BaseLogistics, tour.base_id)
    ret_base = await db.get(BaseLogistics, tour.return_base_id) if tour.return_base_id else base
    base_names = {tour.base_id: base, return_base_of(tour): ret_base}
    fin_sup = (
        await db.get(Supplier, tour.final_pickup_supplier_id)
        if tour.final_pickup_supplier_id else None
    )

    segment_details = []
    km_tax_total = 0.0
    for seg in segments:
        tax_entry = await db.scalar(
            select(KmTax.tax_per_km).where(
                KmTax.origin_type == seg[0], KmTax.origin_id == seg[1],
                KmTax.destination_type == seg[2], KmTax.destination_id == seg[3],
            )
        )
        dist = await _get_distance(db, seg[0], seg[1], seg[2], seg[3])
        seg_km = float(dist.distance_km) if dist else 0
        seg_tax = round(float(tax_entry), 2) if tax_entry else 0
        km_tax_total += seg_tax

        # Labels
        # Un segment BASE peut viser la base de retour (#64) : on nomme la base
        # du segment, pas systématiquement celle de départ. / Name the leg's own base.
        if seg[0] == "BASE" and base_names.get(seg[1]):
            origin_label = base_names[seg[1]].name
        elif seg[0] == "SUPPLIER":
            origin_label = fin_sup.name if fin_sup else f"#{seg[1]}"
        else:
            pdv = pdv_map.get(seg[1])
            origin_label = f"{pdv.code} {pdv.name}" if pdv else f"#{seg[1]}"
        if seg[2] == "BASE" and base_names.get(seg[3]):
            dest_label = base_names[seg[3]].name
        elif seg[2] == "SUPPLIER":
            dest_label = fin_sup.name if fin_sup else f"#{seg[3]}"
        else:
            pdv = pdv_map.get(seg[3])
            dest_label = f"{pdv.code} {pdv.name}" if pdv else f"#{seg[3]}"

        segment_details.append({
            "origin": f"{seg[0]}:{origin_label}",
            "destination": f"{seg[2]}:{dest_label}",
            "distance_km": seg_km,
            "segment_tax": seg_tax,
        })

    # Contrat au forfait journalier (#60) : le détail se résume au forfait.
    if billing_type_of(contract) != 2:
        daily = float(getattr(contract, "daily_cost", 0) or 0)
        part = round(daily / nb_tours, 2)
        if not daily:
            breakdown_warnings.append(
                f"Contrat {contract.code} : forfait journalier absent alors que le "
                f"type de facturation ({contract.billing_type}) l'exige."
            )
        return {
            "tour_id": tour.id,
            "tour_code": tour.code,
            "tour_date": tour.date,
            "total_km": total_km,
            "total_cost_stored": float(tour.total_cost) if tour.total_cost else 0,
            "total_cost_calculated": part,
            "warnings": breakdown_warnings,
            "contract": {
                "code": contract.code,
                "transporter_name": contract.transporter_name,
                "billing_type": contract.billing_type,
                "daily_cost": daily,
            },
            "daily_flat": {
                "daily_cost": daily,
                "nb_tours_today": nb_tours,
                "share": part,
            },
        }

    # 4. Terme km et terme remorque (#59) : ils étaient facturés par l'extraction
    # CMRO sans jamais apparaître dans le coût de la tournée ni dans ce détail.
    # Le terme remorque n'est pas dû quand la tournée roule avec une remorque
    # CMRO (mode mixte, #41). / Km and trailer terms, billed but never shown.
    km_term = round(total_km * float(contract.cost_per_km or 0), 2)
    own_trailer = bool(getattr(tour, "vehicle_id", None))
    trailer_daily = float(getattr(contract, "trailer_cost", 0) or 0)
    trailer_term = 0.0 if own_trailer else round(trailer_daily / nb_tours, 2)

    km_tax_total = round(km_tax_total, 2)
    total_calculated = round(
        fixed_share + vacation_share + km_term + trailer_term + fuel_cost + km_tax_total, 2)

    return {
        "tour_id": tour.id,
        "tour_code": tour.code,
        "tour_date": tour.date,
        "total_km": total_km,
        "total_cost_stored": float(tour.total_cost) if tour.total_cost else 0,
        "total_cost_calculated": total_calculated,
        "warnings": breakdown_warnings,
        "contract": {
            "code": contract.code,
            "transporter_name": contract.transporter_name,
            "fixed_daily_cost": fixed_daily,
            "vacation": vacation_daily,
            "consumption_coefficient": consumption,
        },
        "fixed_cost": {
            "daily_cost": fixed_daily,
            "nb_tours_today": nb_tours,
            "share": fixed_share,
        },
        "vacation_cost": {
            "daily_cost": vacation_daily,
            "nb_tours_today": nb_tours,
            "share": vacation_share,
        },
        "fuel_cost": {
            "total_km": total_km,
            "fuel_price_per_liter": fuel_price,
            "consumption_coefficient": consumption,
            "cost": fuel_cost,
        },
        "km_term": {
            "total_km": total_km,
            "cost_per_km": float(contract.cost_per_km or 0),
            "cost": km_term,
        },
        "trailer_term": {
            "daily_cost": trailer_daily,
            "nb_tours_today": nb_tours,
            "own_trailer": own_trailer,
            "cost": trailer_term,
        },
        "km_tax": {
            "total": km_tax_total,
            "segments": segment_details,
        },
    }


@router.post("/recalculate")
async def recalculate_tour_costs(
    date: str | None = Query(default=None),
    base_id: int | None = Query(default=None),
    contract_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "update")),
):
    """Recalculer en masse les coûts des tours / Bulk recalculate tour costs.
    Filtres optionnels : date, base_id, contract_id. Sans filtre = tous les tours planifiés.
    """
    query = (
        select(Tour)
        .where(Tour.departure_time.isnot(None), Tour.contract_id.isnot(None))
        .options(selectinload(Tour.stops))
    )
    if date:
        query = query.where(Tour.date == date)
    if base_id:
        query = query.where(Tour.base_id == base_id)
    if contract_id:
        query = query.where(Tour.contract_id == contract_id)

    result = await db.execute(query)
    tours = result.scalars().all()

    # Charger les contrats en une seule requête / Load contracts in a single query
    contract_ids = list({t.contract_id for t in tours if t.contract_id})
    contracts_map: dict[int, Contract] = {}
    if contract_ids:
        c_result = await db.execute(select(Contract).where(Contract.id.in_(contract_ids)))
        for c in c_result.scalars().all():
            contracts_map[c.id] = c

    updated = 0
    for tour in tours:
        contract = contracts_map.get(tour.contract_id)
        if not contract:
            continue
        stops_data = [
            {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": s.eqp_count}
            for s in sorted(tour.stops, key=lambda s: s.sequence_order)
        ]
        old_cost = float(tour.total_cost) if tour.total_cost else 0
        new_cost, _ = await _calculate_cost(
            db, float(tour.total_km or 0), contract, tour.date, tour.base_id, stops_data,
            own_trailer=bool(getattr(tour, "vehicle_id", None)),
            return_base_id=tour.return_base_id,
            final_pickup_supplier_id=tour.final_pickup_supplier_id,
        )
        if old_cost != new_cost:
            tour.total_cost = new_cost
            await _log_audit(db, "tour", tour.id, "RECALCULATE", user, {
                "old_cost": old_cost, "new_cost": new_cost,
            })
            updated += 1

    await db.flush()
    return {"total": len(tours), "updated": updated}


@router.delete("/{tour_id}", status_code=204)
async def delete_tour(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-planning", "delete")),
):
    """Supprimer un tour et libérer les volumes / Delete a tour and release its volumes."""
    tour = await db.get(Tour, tour_id)
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    if tour.departure_signal_time:
        raise HTTPException(
            status_code=409,
            detail="Tour verrouillé : top départ validé / Tour locked: departure signal confirmed",
        )

    old_contract_id = tour.contract_id
    old_date = tour.date
    old_code = tour.code

    vol_result = await db.execute(select(Volume).where(Volume.tour_id == tour_id))
    freed_volumes = list(vol_result.scalars().all())
    for vol in freed_volumes:
        vol.tour_id = None

    # Reconstituer les volumes splittés si tous les fragments sont libres /
    # Merge split volumes back if all fragments are unassigned
    group_ids = {v.split_group_id for v in freed_volumes if v.split_group_id}
    for gid in group_ids:
        grp_result = await db.execute(
            select(Volume).where(Volume.split_group_id == gid)
        )
        frags = list(grp_result.scalars().all())
        if all(f.tour_id is None for f in frags):
            frags.sort(key=lambda f: f.id)
            keeper = frags[0]
            keeper.eqp_count = sum(f.eqp_count for f in frags)
            total_weight = sum(float(f.weight_kg or 0) for f in frags)
            total_colis = sum(f.nb_colis or 0 for f in frags)
            keeper.weight_kg = round(total_weight, 2) if total_weight else None
            keeper.nb_colis = total_colis if total_colis else None
            keeper.split_group_id = None
            for f in frags[1:]:
                await db.delete(f)

    # Audit log (avant suppression / before delete)
    await _log_audit(db, "tour", tour_id, "DELETE", user, {
        "code": old_code, "date": old_date, "contract_id": old_contract_id,
    })

    await db.delete(tour)
    await db.flush()

    # Recalculer les tours frères restants / Recalculate remaining sibling tours
    if old_contract_id:
        await _recalculate_sibling_tours(db, old_contract_id, old_date)


# ── Modification des stops en live (postier) / Live stop modification ──


async def _recalc_tour_after_stop_change(db: AsyncSession, tour: Tour) -> dict:
    """Recalculer horaires, distances, coûts après ajout/suppression d'un stop.
    Recalculate times, distances, costs after adding/removing a stop."""
    warnings: list[str] = []

    # Mettre à jour total_eqp / Update total_eqp
    # EQP fractionnaire (volumes injectés) : on garde 2 décimales, total_eqp est numeric en DB
    tour.total_eqp = round(sum(float(s.eqp_count) for s in tour.stops), 2)

    if not tour.departure_time:
        await db.flush()
        return {"warnings": warnings}

    # Recalculer les horaires / Recalculate times
    # Cast eqp_count Decimal -> float pour eviter timedelta(Decimal) errors
    stops_data = [
        {"pdv_id": s.pdv_id, "sequence_order": s.sequence_order, "eqp_count": float(s.eqp_count)}
        for s in sorted(tour.stops, key=lambda s: s.sequence_order)
    ]

    enriched, return_time, total_duration = await calculate_tour_times(
        tour.departure_time, stops_data, tour.base_id, db, tour.return_base_id,
        tour.final_pickup_supplier_id, tour.final_pickup_duration_minutes,
    )

    tour.return_time = return_time
    tour.total_duration_minutes = total_duration

    # Calculer le km total / Calculate total km
    total_km = sum(float(s.get("distance_from_previous_km") or 0) for s in enriched)
    # Ajouter le retour base / Add return leg
    last_pdv_id = enriched[-1]["pdv_id"] if enriched else None
    if last_pdv_id:
        total_km += await _km_after_last_stop(
            db, last_pdv_id, tour.base_id, tour.return_base_id,
            tour.final_pickup_supplier_id,
        )
    tour.total_km = round(total_km, 2)

    # Mettre à jour chaque stop / Update each stop
    for stop in tour.stops:
        for es in enriched:
            if stop.pdv_id == es["pdv_id"] and stop.sequence_order == es["sequence_order"]:
                stop.arrival_time = es.get("arrival_time")
                stop.departure_time = es.get("departure_time")
                stop.distance_from_previous_km = es.get("distance_from_previous_km")
                stop.duration_from_previous_minutes = es.get("duration_from_previous_minutes")
                break

    # Recalculer le coût / Recalculate cost
    if tour.contract_id:
        contract = await db.get(Contract, tour.contract_id)
        if contract:
            cost, cost_warnings = await _calculate_cost(
                db, tour.total_km, contract, tour.date, tour.base_id, stops_data,
                own_trailer=bool(getattr(tour, "vehicle_id", None)),
                return_base_id=tour.return_base_id,
                final_pickup_supplier_id=tour.final_pickup_supplier_id,
            )
            tour.total_cost = round(cost, 2)
            warnings.extend(cost_warnings)
            await _recalculate_sibling_tours(db, tour.contract_id, tour.date)

    # Vérifier les fenêtres de livraison / Check delivery windows
    for stop in tour.stops:
        if not stop.arrival_time:
            continue
        pdv = await db.get(PDV, stop.pdv_id)
        if not pdv:
            continue
        dw_start = pdv.delivery_window_start
        dw_end = pdv.delivery_window_end
        if dw_start and stop.arrival_time < dw_start:
            warnings.append(f"PDV {pdv.code}: arrivée {stop.arrival_time} avant ouverture {dw_start}")
        if dw_end and stop.arrival_time > dw_end:
            warnings.append(f"PDV {pdv.code}: arrivée {stop.arrival_time} après fermeture {dw_end}")

    await db.flush()
    return {"warnings": warnings}


@router.post("/{tour_id}/stops/{stop_id}/raq", response_model=TourRead)
async def declare_stop_raq(
    tour_id: int,
    stop_id: int,
    data: TourStopRaq,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-stop-modify", "update")),
):
    """Déclarer un reste à quai sur un arrêt (ticket #68).

    Le postier constate au chargement qu'une partie de la marchandise n'est pas
    partie. Deux effets, décidés avec l'exploitation :
      - l'arrêt est réduit d'autant : la tournée, sa feuille de route et sa
        lettre de voiture annoncent ce qui est RÉELLEMENT parti ;
      - la quantité restée à quai repart dans les volumes disponibles, marquée
        « RAQ » et rattachée au code de la tournée d'origine, pour être replacée
        dans une tournée suivante à la date choisie par le postier.
    L'écart avec le prévisionnel reste lisible dans la trace d'audit. /
    Declare goods left at the dock: shrink the stop, put the remainder back into
    the available volumes flagged RAQ.
    """
    tour = await db.get(Tour, tour_id, options=[selectinload(Tour.stops)])
    if not tour:
        raise HTTPException(404, "Tour not found")
    if tour.status == TourStatus.COMPLETED:
        raise HTTPException(409, "Tournée terminée : reste à quai non déclarable")

    target = next((s for s in tour.stops if s.id == stop_id), None)
    if not target:
        raise HTTPException(404, "Stop not found in this tour")

    planned = float(target.eqp_count or 0)
    raq = float(data.eqp_count)
    if raq > planned:
        raise HTTPException(
            422,
            f"Reste à quai ({raq:.2f} EQC) supérieur à la quantité de l'arrêt "
            f"({planned:.2f} EQC).",
        )

    # Le volume d'origine sert de gabarit : même base de chargement, même
    # température, même journée d'origine. On prend celui rattaché à l'arrêt, et
    # à défaut n'importe quel volume du PDV dans cette tournée (arrêts anciens
    # sans volume source). / Use the source volume as a template.
    modele = None
    if target.volume_id is not None:
        modele = await db.get(Volume, target.volume_id)
    if modele is None:
        modele = (await db.execute(
            select(Volume).where(Volume.tour_id == tour_id, Volume.pdv_id == target.pdv_id)
        )).scalars().first()
    if modele is None:
        raise HTTPException(
            422,
            "Aucun volume d'origine sur cet arrêt : impossible de déterminer la "
            "base de chargement et la température du reste à quai.",
        )

    pdv = await db.get(PDV, target.pdv_id)

    raq_volume = Volume(
        pdv_id=target.pdv_id,
        date=modele.date,
        dispatch_date=data.dispatch_date,
        eqp_count=raq,
        temperature_class=modele.temperature_class,
        base_origin_id=modele.base_origin_id,
        activity_type=modele.activity_type,
        tour_id=None,
        is_raq=True,
        raq_from_tour_code=tour.code,
    )
    db.add(raq_volume)

    target.eqp_count = round(planned - raq, 2)
    await db.flush()

    await db.refresh(tour, ["stops"])
    await _recalc_tour_after_stop_change(db, tour)

    await _log_audit(db, "tour", tour.id, "RAQ", user, {
        "stop_id": stop_id, "pdv_code": pdv.code if pdv else None,
        "eqp_planned": planned, "eqp_raq": raq, "eqp_remaining": float(target.eqp_count),
        "raq_volume_id": raq_volume.id, "dispatch_date": data.dispatch_date,
    })

    await db.flush()
    refreshed = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    return refreshed.scalar_one()


@router.patch("/{tour_id}/stops/{stop_id}", response_model=TourRead)
async def update_tour_stop(
    tour_id: int,
    stop_id: int,
    data: TourStopUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-stop-modify", "update")),
):
    """Corriger la quantité d'un arrêt depuis l'onglet postier (ticket #37).

    Le postier pouvait ajouter un PDV avec ses EQC et en retirer un, mais pas
    corriger la quantité d'un arrêt déjà présent : sur une tournée à un seul
    PDV, il n'avait donc aucun moyen d'ajuster la charge, puisque le PDV était
    exclu de la liste d'ajout. C'est une correction OPÉRATIONNELLE — la charge
    réellement constatée au quai — de même nature que l'EQC saisie à l'ajout
    d'un PDV : les volumes rattachés ne sont pas redécoupés. /
    Fix an existing stop's quantity: an operational correction, like the EQC
    entered when adding a PDV; attached volumes are not re-split.
    """
    tour = await db.get(Tour, tour_id, options=[selectinload(Tour.stops)])
    if not tour:
        raise HTTPException(404, "Tour not found")
    if tour.departure_signal_time:
        raise HTTPException(409, "Tour verrouillé : top départ validé")
    if tour.status not in (TourStatus.DRAFT, TourStatus.VALIDATED):
        raise HTTPException(409, f"Tour en statut {tour.status.value}, modification impossible")

    target = next((s for s in tour.stops if s.id == stop_id), None)
    if not target:
        raise HTTPException(404, "Stop not found in this tour")

    # Lire ce dont on a besoin AVANT le flush/refresh : après, toucher `target`
    # déclenche un chargement paresseux, interdit en session asynchrone. /
    # Read what we need before flush/refresh: touching `target` afterwards
    # triggers a lazy load, which async sessions forbid.
    before = float(target.eqp_count or 0)
    pdv = await db.get(PDV, target.pdv_id)
    pdv_code = pdv.code if pdv else None

    target.eqp_count = data.eqp_count
    await db.flush()

    await db.refresh(tour, ["stops"])
    result = await _recalc_tour_after_stop_change(db, tour)

    await _log_audit(db, "tour", tour.id, "UPDATE_STOP", user, {
        "stop_id": stop_id, "pdv_code": pdv_code,
        "eqp_count_before": before, "eqp_count_after": float(data.eqp_count),
    })

    await db.flush()
    refreshed = await db.execute(
        select(Tour).where(Tour.id == tour.id).options(selectinload(Tour.stops))
    )
    tour_out = refreshed.scalar_one()
    if result.get("warnings"):
        logger.info("Stop %s du tour %s mis a jour: %s", stop_id, tour_id, result["warnings"])
    return tour_out


@router.delete("/{tour_id}/stops/{stop_id}", response_model=TourRead)
async def remove_tour_stop(
    tour_id: int,
    stop_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-stop-modify", "update")),
):
    """Retirer un PDV d'un tour planifié / Remove a PDV from a scheduled tour."""
    tour = await db.get(Tour, tour_id, options=[selectinload(Tour.stops)])
    if not tour:
        raise HTTPException(404, "Tour not found")
    if tour.departure_signal_time:
        raise HTTPException(409, "Tour verrouillé : top départ validé")
    if tour.status not in (TourStatus.DRAFT, TourStatus.VALIDATED):
        raise HTTPException(409, f"Tour en statut {tour.status.value}, modification impossible")

    # Trouver le stop / Find the stop
    target = next((s for s in tour.stops if s.id == stop_id), None)
    if not target:
        raise HTTPException(404, "Stop not found in this tour")
    if len(tour.stops) <= 1:
        raise HTTPException(422, "Impossible de retirer le dernier stop. Supprimez le tour entier.")

    pdv_id = target.pdv_id
    pdv = await db.get(PDV, pdv_id)
    pdv_code = pdv.code if pdv else str(pdv_id)

    # Libérer les volumes du PDV dans ce tour / Release volumes.
    # Si le stop est rattaché à un volume précis (front récent), ne libérer QUE
    # celui-ci : un PDV peut avoir plusieurs stops/volumes de même eqc (Gel+Frais),
    # retirer un segment ne doit pas libérer l'autre. Sinon (legacy sans volume_id),
    # comportement historique = tous les volumes du PDV. / Free only this stop's
    # volume when known, else fall back to all PDV volumes (legacy).
    if target.volume_id is not None:
        vol_result = await db.execute(
            select(Volume).where(Volume.tour_id == tour_id, Volume.id == target.volume_id)
        )
    else:
        vol_result = await db.execute(
            select(Volume).where(Volume.tour_id == tour_id, Volume.pdv_id == pdv_id)
        )
    freed = list(vol_result.scalars().all())
    freed_ids = [v.id for v in freed]
    freed_eqp = sum(v.eqp_count for v in freed)
    for v in freed:
        v.tour_id = None

    # Reconstituer les volumes splités / Reconstitute split volumes
    group_ids = {v.split_group_id for v in freed if v.split_group_id}
    for gid in group_ids:
        grp_result = await db.execute(select(Volume).where(Volume.split_group_id == gid))
        frags = list(grp_result.scalars().all())
        if all(f.tour_id is None for f in frags):
            frags.sort(key=lambda f: f.id)
            keeper = frags[0]
            keeper.eqp_count = sum(f.eqp_count for f in frags)
            total_w = sum(float(f.weight_kg or 0) for f in frags)
            total_c = sum(f.nb_colis or 0 for f in frags)
            keeper.weight_kg = round(total_w, 2) if total_w else None
            keeper.nb_colis = total_c if total_c else None
            keeper.split_group_id = None
            for f in frags[1:]:
                await db.delete(f)

    # Supprimer le stop / Delete the stop
    await db.delete(target)
    await db.flush()

    # Renuméroter / Resequence
    remaining = sorted([s for s in tour.stops if s.id != stop_id], key=lambda s: s.sequence_order)
    for idx, s in enumerate(remaining):
        s.sequence_order = idx + 1

    # Recalculer / Recalculate
    result = await _recalc_tour_after_stop_change(db, tour)

    await _log_audit(db, "tour", tour.id, "REMOVE_STOP", user, {
        "stop_id": stop_id, "pdv_id": pdv_id, "pdv_code": pdv_code,
        "freed_volume_ids": freed_ids, "freed_eqp": float(freed_eqp),
        "warnings": result["warnings"],
    })

    # Créer alerte opérationnelle / Create operational alert
    from app.api.operational_alerts import create_system_alert
    from app.models.operational_alert import AlertType, AlertPriority
    await create_system_alert(
        db, AlertType.VOLUMES_RELEASED,
        title=f"PDV {pdv_code} retiré du tour {tour.code}",
        message=f"{float(freed_eqp)} EQC libérés pour le {tour.date}. Volumes à réaffecter.",
        user=user,
        priority=AlertPriority.HIGH,
        tour_id=tour.id, tour_code=tour.code,
        pdv_id=pdv_id, pdv_code=pdv_code,
        base_id=tour.base_id, date=tour.date,
        freed_eqp=float(freed_eqp),
    )

    await db.refresh(tour, ["stops"])
    return tour


@router.post("/{tour_id}/stops", response_model=TourRead)
async def add_tour_stop(
    tour_id: int,
    data: TourStopInsert,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tour-stop-modify", "update")),
):
    """Ajouter un PDV à un tour planifié / Add a PDV to a scheduled tour."""
    tour = await db.get(Tour, tour_id, options=[selectinload(Tour.stops)])
    if not tour:
        raise HTTPException(404, "Tour not found")
    if tour.departure_signal_time:
        raise HTTPException(409, "Tour verrouillé : top départ validé")
    if tour.status not in (TourStatus.DRAFT, TourStatus.VALIDATED):
        raise HTTPException(409, f"Tour en statut {tour.status.value}, modification impossible")

    # Vérifier le PDV / Verify PDV
    pdv = await db.get(PDV, data.pdv_id)
    if not pdv:
        raise HTTPException(404, "PDV not found")

    # Déterminer la position / Determine position
    max_seq = max((s.sequence_order for s in tour.stops), default=0)
    insert_pos = data.sequence_order if data.sequence_order is not None else max_seq + 1

    # Décaler les stops existants / Shift existing stops
    for s in tour.stops:
        if s.sequence_order >= insert_pos:
            s.sequence_order += 1

    # Créer le nouveau stop / Create new stop
    new_stop = TourStop(
        tour_id=tour.id,
        pdv_id=data.pdv_id,
        sequence_order=insert_pos,
        eqp_count=data.eqp_count,
        pickup_cardboard=data.pickup_cardboard,
        pickup_containers=data.pickup_containers,
        pickup_returns=data.pickup_returns,
        pickup_consignment=data.pickup_consignment,
    )
    db.add(new_stop)
    await db.flush()

    # Assigner les volumes disponibles / Assign available volumes
    vol_result = await db.execute(
        select(Volume).where(
            Volume.pdv_id == data.pdv_id,
            Volume.tour_id.is_(None),
            Volume.dispatch_date == tour.date,
        ).order_by(Volume.eqp_count.desc())
    )
    available = list(vol_result.scalars().all())

    # #84 : n'assigner que les volumes qui partent de la base de chargement du
    # tour. Cet endpoint prenait TOUS les volumes libres du PDV pour la date :
    # ajouter un PDV a un tour ordonnance de Villers y faisait entrer au passage
    # son volume parti de Gosselies. Si le PDV n'a de volume que sur une AUTRE
    # base, on refuse l'ajout plutot que de creer un arret sans marchandise —
    # sauf tournee de reprise, ou l'arret n'a legitimement aucun volume. /
    # Only attach volumes loaded at the tour's own base; refuse the stop when the
    # PDV's volumes all belong to another base (pickup tours excepted).
    if available:
        off_base = [v for v in available if v.base_origin_id not in (None, tour.base_id)]
        available = [v for v in available if v.base_origin_id in (None, tour.base_id)]
        if off_base and not available and not tour.is_pickup_tour:
            other_ids = {v.base_origin_id for v in off_base}
            labels = dict((await db.execute(
                select(BaseLogistics.id, BaseLogistics.code).where(
                    BaseLogistics.id.in_(other_ids | {tour.base_id})
                )
            )).all())
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{pdv.code} n'a rien a charger a "
                    f"{labels.get(tour.base_id) or f'base #{tour.base_id}'} : ses "
                    f"volumes du jour partent de "
                    f"{', '.join(sorted(labels.get(b) or f'base #{b}' for b in other_ids))}. "
                    "Un camion ne charge que sur un seul site : placez ce point de "
                    "vente dans une tournee au depart de cette base."
                ),
            )
    assigned_ids: list[int] = []
    assigned_eqp = 0.0
    for v in available:
        v.tour_id = tour.id
        assigned_ids.append(v.id)
        assigned_eqp += float(v.eqp_count)

    # Utiliser le max entre EQC saisis et volumes assignés / Use max of input and assigned
    new_stop.eqp_count = max(float(data.eqp_count), assigned_eqp)

    # Recalculer / Recalculate
    await db.refresh(tour, ["stops"])
    result = await _recalc_tour_after_stop_change(db, tour)

    await _log_audit(db, "tour", tour.id, "ADD_STOP", user, {
        "pdv_id": data.pdv_id, "pdv_code": pdv.code,
        "sequence_order": insert_pos, "eqp_count": float(new_stop.eqp_count),
        "assigned_volume_ids": assigned_ids,
        "warnings": result["warnings"],
    })

    await db.refresh(tour, ["stops"])
    return tour


@router.get("/{tour_id}/manifest", response_model=list[ManifestLineRead])
async def get_tour_manifest(
    tour_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tours", "read")),
):
    """Lire le manifeste WMS d'un tour / Read WMS manifest for a tour."""
    tour = await db.get(Tour, tour_id)
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    result = await db.execute(
        select(TourManifestLine)
        .where(TourManifestLine.tour_id == tour_id)
        .order_by(TourManifestLine.pdv_code, TourManifestLine.id)
    )
    return result.scalars().all()
