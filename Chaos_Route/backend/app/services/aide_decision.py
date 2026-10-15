"""
Service Aide à la Décision / Decision Support service.
Niveau 1 : nearest-neighbor heuristic (~1s).
Niveau 2 : OR-Tools CVRPTW solver (~15-30s).
Simulation pure : aucun tour créé, aucun volume modifié.
"""

import logging
import math
from collections import defaultdict

from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.base_logistics import BaseLogistics
from app.models.contract import Contract, TemperatureType, TailgateType, effective_vacation
from app.models.contract_schedule import ContractSchedule
from app.models.distance_matrix import DistanceMatrix
from app.models.km_tax import KmTax
from app.models.pdv import PDV
from app.models.tour import Tour
from app.models.volume import Volume
from app.schemas.aide_decision import (
    AideDecisionRequest,
    AideDecisionResponse,
    AideDecisionSummary,
    SuggestedContract,
    SuggestedStop,
    SuggestedTour,
    UnassignedPDV,
)
from app.utils.fuel_pricing import load_fuel_unit_prices, price_for_contract

log = logging.getLogger(__name__)

# Constantes / Constants
DEFAULT_DOCK_TIME = 15          # minutes
DEFAULT_UNLOAD_PER_EQP = 2      # minutes par EQP
MAX_DAILY_MINUTES = 600         # 10h
DEFAULT_CAPACITY_EQP = 54       # capacité par défaut si aucun contrat
SAS_DEADLINE = "06:00"
NON_SAS_DEADLINE = "09:00"
AVERAGE_SPEED_KMH = 60          # pour estimation durée si manquante

# Multiplicateurs par position dans la liste de priorités / Priority position multipliers
# Ecarts elargis pour que le changement d'ordre ait un effet visible /
# Wider gaps so reordering produces a visible effect.
PRIORITY_MULTIPLIERS = {0: 10.0, 1: 3.0, 2: 1.0, 3: 0.3}


def _compute_optimization_multipliers(priorities: list[str]) -> dict[str, float]:
    """Convertir la liste ordonnée en dict de multiplicateurs / Convert priority list to multiplier dict."""
    return {key: PRIORITY_MULTIPLIERS[idx] for idx, key in enumerate(priorities)}

# Compatible temperature mappings / Correspondances température
TEMP_COMPAT: dict[str, set[str]] = {
    "SEC": {"SEC", "BI_TEMP", "TRI_TEMP"},
    "FRAIS": {"FRAIS", "BI_TEMP", "TRI_TEMP"},
    "GEL": {"GEL", "BI_TEMP", "TRI_TEMP"},
}


def _time_to_minutes(t: str | None) -> int | None:
    """Convertir HH:MM en minutes depuis minuit / Convert HH:MM to minutes since midnight."""
    if not t:
        return None
    parts = t.split(":")
    return int(parts[0]) * 60 + int(parts[1])


def _minutes_to_time(m: int) -> str:
    """Convertir minutes en HH:MM / Convert minutes to HH:MM."""
    m = int(m)
    if m < 0:
        m = 0
    h = m // 60
    mn = m % 60
    return f"{h:02d}:{mn:02d}"


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance haversine en km × 1.3 (correction route) / Haversine distance in km × 1.3 (road correction)."""
    R = 6371.0
    rlat1, rlon1, rlat2, rlon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a)) * 1.3


class AideDecisionService:
    """Service de simulation aide à la décision / Decision support simulation service."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def generate(self, request: AideDecisionRequest) -> AideDecisionResponse:
        """Générer la simulation / Generate simulation."""
        warnings: list[str] = []

        # --- 0. Charger la base d'origine / Load origin base ---
        base = await self._load_base(request.base_origin_id)
        if not base:
            return self._empty_response(request, "Base inconnue", "Base introuvable")

        # --- 1. Charger les volumes non affectés / Load unassigned volumes ---
        pdv_agg = await self._load_volumes(request)
        if not pdv_agg:
            return self._empty_response(
                request, base.name, "Aucun volume non affecté pour ces critères"
            )

        # --- 2. Charger les PDV / Load PDVs ---
        pdv_ids = list(pdv_agg.keys())
        pdvs = await self._load_pdvs(pdv_ids)

        # --- 3. Précharger la matrice de distances / Preload distance matrix ---
        dist_cache, dur_cache = await self._load_distance_cache(
            base.id, pdv_ids, base, pdvs
        )

        # --- 4. Charger les contrats disponibles / Load available contracts ---
        contracts = await self._load_contracts(request, base)
        if not contracts:
            warnings.append("Aucun contrat disponible — capacité par défaut (54 EQP)")

        # --- 4b. Charger prix gasoil + cache taxe km / Load fuel price + km tax cache ---
        fuel_prices = await self._load_fuel_prices(request.dispatch_date)
        if not fuel_prices:
            warnings.append(
                f"Aucun prix carburant pour le {request.dispatch_date} — coût carburant à 0"
            )
        km_tax_cache = await self._load_km_tax_cache(base.id, pdv_ids)

        # --- 5. Branchement Niveau 1 / Niveau 2 ---
        if request.level == 2:
            tours, unassigned, level_warnings = self._build_tours_level2(
                request, base, pdv_agg, pdv_ids, pdvs, dist_cache, dur_cache,
                contracts, fuel_prices, km_tax_cache,
            )
            warnings.extend(level_warnings)
        else:
            tours, unassigned, level_warnings = self._build_tours_level1(
                request, base, pdv_agg, pdv_ids, pdvs, dist_cache, dur_cache,
                contracts, fuel_prices, km_tax_cache,
            )
            warnings.extend(level_warnings)

        # --- 6. Résumé / Summary ---
        total_tours = len(tours)
        sum_eqp = sum(t.total_eqp for t in tours)
        sum_weight = sum(t.total_weight_kg for t in tours)
        sum_km = sum(t.total_km for t in tours)
        sum_cost = sum(t.total_cost for t in tours)

        fill_rates = []
        for t in tours:
            if t.contract and t.contract.capacity_eqp > 0:
                fill_rates.append(t.contract.fill_rate_pct)
        avg_fill = round(sum(fill_rates) / len(fill_rates), 1) if fill_rates else 0.0

        summary = AideDecisionSummary(
            total_tours=total_tours,
            total_eqp=sum_eqp,
            total_weight_kg=round(sum_weight, 2),
            total_km=round(sum_km, 1),
            total_cost=round(sum_cost, 2),
            avg_fill_rate_pct=avg_fill,
        )

        return AideDecisionResponse(
            dispatch_date=request.dispatch_date,
            base_origin_id=request.base_origin_id,
            base_name=base.name,
            temperature_class=request.temperature_class,
            tours=tours,
            unassigned_pdvs=unassigned,
            summary=summary,
            warnings=warnings,
        )

    # ══════════════════════════════════════════════════════════════
    # Niveau 1 — Nearest-Neighbor Heuristic
    # ══════════════════════════════════════════════════════════════

    def _build_tours_level1(
        self,
        request: AideDecisionRequest,
        base: BaseLogistics,
        pdv_agg: dict,
        pdv_ids: list[int],
        pdvs: dict[int, PDV],
        dist_cache: dict,
        dur_cache: dict,
        contracts: list[Contract],
        fuel_prices: dict[str, float],
        km_tax_cache: dict[tuple, float],
    ) -> tuple[list[SuggestedTour], list[UnassignedPDV], list[str]]:
        """Construire les tours par nearest-neighbor / Build tours by nearest-neighbor."""
        warnings: list[str] = []

        # Trier PDV par distance depuis la base (décroissant)
        pdv_distances = {}
        for pid in pdv_ids:
            key = ("BASE", base.id, "PDV", pid)
            pdv_distances[pid] = dist_cache.get(key, 9999)
        sorted_pdv_ids = sorted(pdv_ids, key=lambda p: pdv_distances.get(p, 0), reverse=True)

        # Capacité max disponible
        max_capacity = DEFAULT_CAPACITY_EQP
        if contracts:
            max_cap_contract = max((c.capacity_eqp or 0) for c in contracts)
            if max_cap_contract > 0:
                max_capacity = max_cap_contract

        remaining = set(sorted_pdv_ids)
        unassigned: list[UnassignedPDV] = []
        tours: list[SuggestedTour] = []
        tour_number = 0
        contract_tour_count: dict[int, int] = defaultdict(int)
        contract_duration: dict[int, int] = defaultdict(int)

        while remaining:
            tour_number += 1

            # a) Graine = PDV le plus loin
            seed_id = None
            for pid in sorted_pdv_ids:
                if pid in remaining:
                    seed_id = pid
                    break
            if seed_id is None:
                break

            tour_pdvs = [seed_id]
            remaining.discard(seed_id)
            tour_eqp = pdv_agg[seed_id]["eqp_count"]

            # b) Remplir par nearest-neighbor
            while remaining:
                last_id = tour_pdvs[-1]
                best_id = None
                best_dist = float("inf")
                for candidate in remaining:
                    key = ("PDV", last_id, "PDV", candidate)
                    d = dist_cache.get(key, 9999)
                    if d < best_dist:
                        best_dist = d
                        best_id = candidate
                if best_id is None:
                    break
                cand_eqp = pdv_agg[best_id]["eqp_count"]
                if tour_eqp + cand_eqp > max_capacity:
                    if cand_eqp > max_capacity:
                        break
                    break
                est_time = self._estimate_tour_time(
                    tour_pdvs + [best_id], base, pdvs, pdv_agg,
                    dist_cache, dur_cache
                )
                if est_time > MAX_DAILY_MINUTES - 30:
                    break
                tour_pdvs.append(best_id)
                remaining.discard(best_id)
                tour_eqp += cand_eqp

            # c) Séquencer : SAS d'abord, puis non-SAS
            sequenced = self._sequence_sas_first(
                tour_pdvs, base, pdvs, dist_cache, request.temperature_class
            )

            # d-g) Construire le tour complet
            tour = self._build_single_tour(
                tour_number, sequenced, base, pdvs, pdv_agg,
                dist_cache, dur_cache, contracts, request,
                contract_tour_count, contract_duration, max_capacity,
                fuel_prices, km_tax_cache,
            )
            tours.append(tour)

        return tours, unassigned, warnings

    # ══════════════════════════════════════════════════════════════
    # Niveau 2 — OR-Tools CVRPTW
    # ══════════════════════════════════════════════════════════════

    def _build_tours_level2(
        self,
        request: AideDecisionRequest,
        base: BaseLogistics,
        pdv_agg: dict,
        pdv_ids: list[int],
        pdvs: dict[int, PDV],
        dist_cache: dict,
        dur_cache: dict,
        contracts: list[Contract],
        fuel_prices: dict[str, float],
        km_tax_cache: dict[tuple, float],
    ) -> tuple[list[SuggestedTour], list[UnassignedPDV], list[str]]:
        """Construire les tours par OR-Tools CVRPTW / Build tours with OR-Tools CVRPTW."""
        warnings: list[str] = []

        # Import conditionnel / Conditional import
        try:
            from app.services.optimizer_ortools import (
                ORToolsInput, VehicleSlot, solve_cvrptw,
            )
        except ImportError:
            warnings.append(
                "OR-Tools non installé — fallback Niveau 1. "
                "Installer avec : pip install ortools"
            )
            return self._build_tours_level1(
                request, base, pdv_agg, pdv_ids, pdvs,
                dist_cache, dur_cache, contracts, fuel_prices, km_tax_cache
            )

        # ── Calculer les multiplicateurs d'optimisation / Compute optimization multipliers ──
        # Le cout d'arc reste neutre (multiplier uniforme = no-op).
        # Les penalites sont exprimees en RATIO relatif au cost : quand cost est
        # prioritaire, les autres penalites diminuent et le solveur minimise plus
        # librement le cout total. /
        # Arc cost stays neutral (uniform multiplier = no-op). Penalties are
        # expressed as RATIOS relative to cost: when cost ranks high, other
        # penalties shrink and the solver minimizes total cost more freely.
        mults = _compute_optimization_multipliers(request.optimization_priorities)
        cost_mult = max(mults.get("cost", 1.0), 0.1)  # éviter division par 0
        fixed_cost_mult = max(mults.get("fill_rate", 1.0), mults.get("num_tours", 1.0)) / cost_mult
        late_penalty_ratio = mults.get("punctuality", 1.0) / cost_mult
        # drop_penalty est fige - un PDV ne doit jamais etre drop par choix
        # d'optimisation, seulement par impossibilite reelle /
        # drop_penalty stays fixed - a PDV must never be dropped by optimization
        # choice, only by real infeasibility
        log.info(
            "Aide-decision L2 mults: priorities=%s -> cost=%.2f, punctuality=%.2f, "
            "fill_rate=%.2f, num_tours=%.2f | derived ratios: late=%.2f, fixed=%.2f",
            request.optimization_priorities,
            mults.get("cost", 1.0), mults.get("punctuality", 1.0),
            mults.get("fill_rate", 1.0), mults.get("num_tours", 1.0),
            late_penalty_ratio, fixed_cost_mult,
        )

        # ── Construire l'entrée OR-Tools ──

        # Index mapping : node 0 = depot, node 1..N = PDVs
        node_to_pdv: dict[int, int] = {}  # node_index → pdv_id
        pdv_to_node: dict[int, int] = {}  # pdv_id → node_index
        for i, pid in enumerate(pdv_ids):
            node = i + 1
            node_to_pdv[node] = pid
            pdv_to_node[pid] = node

        num_pdvs = len(pdv_ids)
        num_nodes = num_pdvs + 1  # depot + PDVs

        # Demands (EQP par nœud) — int obligatoire pour OR-Tools
        demands = [0]  # depot
        for pid in pdv_ids:
            demands.append(int(pdv_agg[pid]["eqp_count"]))

        # Service times (minutes par nœud) — int obligatoire pour OR-Tools
        service_times = [0]  # depot
        for pid in pdv_ids:
            pdv = pdvs.get(pid)
            eqp = float(pdv_agg[pid]["eqp_count"])
            dock = (pdv.dock_time_minutes if pdv and pdv.dock_time_minutes else DEFAULT_DOCK_TIME)
            unload = (pdv.unload_time_per_eqp_minutes if pdv and pdv.unload_time_per_eqp_minutes else DEFAULT_UNLOAD_PER_EQP)
            service_times.append(int(dock + eqp * unload))

        # Time windows (earliest, deadline) en minutes
        time_windows: list[tuple[int, int]] = [(0, MAX_DAILY_MINUTES)]  # depot
        for pid in pdv_ids:
            pdv = pdvs.get(pid)
            deadline_str = self._get_pdv_deadline(pdv, request.temperature_class)
            deadline_min = _time_to_minutes(deadline_str) or MAX_DAILY_MINUTES
            # Fenêtre custom : delivery_window_start si défini
            start_min = 0
            if pdv and pdv.delivery_window_start:
                ws = _time_to_minutes(pdv.delivery_window_start)
                if ws is not None:
                    start_min = ws
            time_windows.append((start_min, deadline_min))

        # Matrices distance (mètres) et temps (minutes) — entiers
        distance_matrix: list[list[int]] = [[0] * num_nodes for _ in range(num_nodes)]
        time_matrix: list[list[int]] = [[0] * num_nodes for _ in range(num_nodes)]

        for from_node in range(num_nodes):
            for to_node in range(num_nodes):
                if from_node == to_node:
                    continue
                # Déterminer les clés dans dist_cache
                if from_node == 0:
                    key = ("BASE", base.id, "PDV", node_to_pdv[to_node])
                elif to_node == 0:
                    key = ("PDV", node_to_pdv[from_node], "BASE", base.id)
                else:
                    key = ("PDV", node_to_pdv[from_node], "PDV", node_to_pdv[to_node])

                dist_km = dist_cache.get(key, 50)  # fallback 50 km
                dur_min = dur_cache.get(key, int(dist_km / AVERAGE_SPEED_KMH * 60) if dist_km else 0)
                distance_matrix[from_node][to_node] = int(dist_km * 1000)  # km → mètres
                time_matrix[from_node][to_node] = dur_min

        # Vehicles : 2 slots par contrat (multi-trip, séquencement en post-processing)
        vehicles: list[VehicleSlot] = []
        contract_list = contracts if contracts else []

        if not contract_list:
            # Fallback : véhicules virtuels (capacité 54 EQP)
            total_eqp_demand = sum(pdv_agg[pid]["eqp_count"] for pid in pdv_ids)
            num_virtual = max(4, ((total_eqp_demand // DEFAULT_CAPACITY_EQP) + 2) * 2)
            for i in range(num_virtual):
                vehicles.append(VehicleSlot(
                    contract_idx=0,
                    capacity_eqp=DEFAULT_CAPACITY_EQP,
                    fixed_cost_cents=int(10000 * fixed_cost_mult),
                    cost_per_km_cents=100,
                    compatible_nodes=set(range(1, num_nodes)),
                ))
        else:
            for c_idx, c in enumerate(contract_list):
                cap = c.capacity_eqp or DEFAULT_CAPACITY_EQP
                # Coût fixe = LA vacation, comptee une fois (#58). On additionnait
                # ici « terme fixe » ET « vacation », deux colonnes portant la
                # meme valeur : l'optimiseur surevaluait donc de 100 % le cout
                # fixe de chaque contrat, et arbitrait sur des chiffres faux.
                # Le correctif de septembre n'avait pas atteint ce fichier.
                fixed_cents = int(effective_vacation(c) * 100)
                if fixed_cents < 10000:
                    fixed_cents = 10000

                # Coût km = prix carburant (selon type contrat) * consumption_coefficient
                consumption = float(c.consumption_coefficient or 0)
                km_cents = int(price_for_contract(fuel_prices, c) * consumption * 100)
                # Fallback sur cost_per_km si fuel ou conso manquant
                if km_cents == 0:
                    km_cents = int(float(c.cost_per_km or 0) * 100)

                # Compatible nodes (dock/hayon + type véhicule)
                compatible = set()
                for node in range(1, num_nodes):
                    pid = node_to_pdv[node]
                    pdv = pdvs.get(pid)
                    if pdv and self._check_dock_tailgate(pdv, c) and self._check_vehicle_type(pdv, c):
                        compatible.add(node)
                    elif not pdv:
                        compatible.add(node)

                # Slot A — coût complet (premier trip)
                vehicles.append(VehicleSlot(
                    contract_idx=c_idx,
                    capacity_eqp=cap,
                    fixed_cost_cents=int(fixed_cents * fixed_cost_mult),
                    cost_per_km_cents=km_cents,
                    compatible_nodes=compatible,
                ))
                # Slot B — km seul (deuxième trip, fixed déjà payé)
                vehicles.append(VehicleSlot(
                    contract_idx=c_idx,
                    capacity_eqp=cap,
                    fixed_cost_cents=0,
                    cost_per_km_cents=km_cents,
                    compatible_nodes=compatible,
                ))

        # Construire la matrice km_tax pour OR-Tools (centimes, forfait par arc)
        km_tax_mat: list[list[int]] = [[0] * num_nodes for _ in range(num_nodes)]
        for from_node in range(num_nodes):
            for to_node in range(num_nodes):
                if from_node == to_node:
                    continue
                if from_node == 0:
                    key = ("BASE", base.id, "PDV", node_to_pdv[to_node])
                elif to_node == 0:
                    key = ("PDV", node_to_pdv[from_node], "BASE", base.id)
                else:
                    key = ("PDV", node_to_pdv[from_node], "PDV", node_to_pdv[to_node])
                tax = km_tax_cache.get(key, 0.0)
                km_tax_mat[from_node][to_node] = int(tax * 100)  # € → centimes

        ortools_input = ORToolsInput(
            num_pdvs=num_pdvs,
            pdv_ids=[0] + pdv_ids,
            demands=demands,
            service_times=service_times,
            time_windows=time_windows,
            distance_matrix=distance_matrix,
            time_matrix=time_matrix,
            vehicles=vehicles,
            km_tax_matrix=km_tax_mat,
            time_limit_seconds=request.time_limit_seconds,
            late_penalty_per_min=int(500 * late_penalty_ratio),
            drop_penalty=1_000_000,  # fige - jamais drop par choix d'optim
            cost_multiplier=1.0,  # neutre : multiplier uniforme = no-op
        )

        # ── Résoudre / Solve ──
        log.info(
            "OR-Tools L2: %d PDVs, %d vehicle slots, time_limit=%ds",
            num_pdvs, len(vehicles), request.time_limit_seconds,
        )
        try:
            raw_tours, dropped_indices = solve_cvrptw(ortools_input)
        except Exception:
            log.exception("OR-Tools L2: solver crashed — fallback Niveau 1")
            warnings.append(
                "Erreur interne OR-Tools — fallback calcul simple"
            )
            return self._build_tours_level1(
                request, base, pdv_agg, pdv_ids, pdvs,
                dist_cache, dur_cache, contracts, fuel_prices, km_tax_cache
            )
        log.info(
            "OR-Tools L2: %d tours trouvés, %d PDVs droppés",
            len(raw_tours), len(dropped_indices),
        )

        if not raw_tours and dropped_indices:
            # Aucune solution → fallback Niveau 1
            warnings.append(
                "OR-Tools n'a trouvé aucune solution — fallback Niveau 1"
            )
            return self._build_tours_level1(
                request, base, pdv_agg, pdv_ids, pdvs,
                dist_cache, dur_cache, contracts, fuel_prices, km_tax_cache
            )

        # ── Convertir les tours bruts en SuggestedTour ──
        tours: list[SuggestedTour] = []
        unassigned: list[UnassignedPDV] = []
        contract_tour_count: dict[int, int] = defaultdict(int)
        contract_duration: dict[int, int] = defaultdict(int)

        # Compter les tours par contrat (pour le coût fixe)
        contract_slot_tours: dict[int, int] = defaultdict(int)
        for rt in raw_tours:
            contract_slot_tours[rt.contract_idx] += 1

        for tour_idx, rt in enumerate(raw_tours):
            # Mapper node_sequence → pdv_ids
            sequenced = [node_to_pdv[n] for n in rt.node_sequence]

            # Construire le tour complet
            tour_number = tour_idx + 1

            # Stops info
            stops_info = self._compute_stops_info(
                sequenced, base, pdvs, pdv_agg, dist_cache, dur_cache,
                request.temperature_class
            )

            # Totaux
            total_tour_km = sum(s["distance_km"] for s in stops_info)
            if sequenced:
                last_key = ("PDV", sequenced[-1], "BASE", base.id)
                return_km = dist_cache.get(last_key, 0)
                return_dur = dur_cache.get(last_key, int(return_km / AVERAGE_SPEED_KMH * 60) if return_km else 0)
            else:
                return_km = 0
                return_dur = 0
            total_tour_km += return_km

            total_eqp = sum(pdv_agg[pid]["eqp_count"] for pid in sequenced)
            total_weight = sum(pdv_agg[pid]["weight_kg"] for pid in sequenced)

            # Calcul heures
            earliest_deadline = self._get_earliest_deadline(
                sequenced, pdvs, request.temperature_class
            )
            total_driving = sum(s["duration_min"] for s in stops_info)
            total_unload = sum(s["unload_min"] for s in stops_info)

            if earliest_deadline is not None:
                departure_min = earliest_deadline - total_driving - total_unload
                if departure_min < 0:
                    departure_min = 0
            else:
                departure_min = 180

            # Forward pass
            tour_warnings: list[str] = []
            current_min = departure_min
            built_stops: list[SuggestedStop] = []
            for idx, info in enumerate(stops_info):
                current_min += info["duration_min"]
                arrival_min = current_min
                pdv = pdvs.get(info["pdv_id"])
                pdv_data = pdv_agg[info["pdv_id"]]

                has_sas = pdv and self._has_sas(pdv, request.temperature_class)
                deadline_str = self._get_pdv_deadline(pdv, request.temperature_class)
                deadline_min = _time_to_minutes(deadline_str)

                stop_warnings: list[str] = []
                if deadline_min is not None and arrival_min > deadline_min:
                    stop_warnings.append(
                        f"Retard: arrivée {_minutes_to_time(arrival_min)} > deadline {deadline_str}"
                    )
                    tour_warnings.append(
                        f"Stop {idx + 1} ({pdv.code if pdv else '?'}): retard livraison"
                    )

                departure_stop_min = arrival_min + info["unload_min"]
                current_min = departure_stop_min

                built_stops.append(SuggestedStop(
                    sequence_order=idx + 1,
                    pdv_id=info["pdv_id"],
                    pdv_code=pdv.code if pdv else "?",
                    pdv_name=pdv.name if pdv else "?",
                    pdv_city=pdv.city if pdv else None,
                    eqp_count=pdv_data["eqp_count"],
                    weight_kg=pdv_data["weight_kg"],
                    nb_colis=pdv_data["nb_colis"],
                    has_sas=has_sas or False,
                    arrival_time=_minutes_to_time(arrival_min),
                    departure_time=_minutes_to_time(departure_stop_min),
                    distance_from_previous_km=round(info["distance_km"], 1),
                    duration_from_previous_minutes=info["duration_min"],
                    deadline=deadline_str,
                    warnings=stop_warnings,
                ))

            return_min = current_min + return_dur
            total_duration = return_min - departure_min

            # Contrat associé au slot
            selected_contract = None
            sc = None
            fill_rate = 0.0

            if contract_list and rt.contract_idx < len(contract_list):
                c = contract_list[rt.contract_idx]
                cid = c.id
                contract_tour_count[cid] += 1
                contract_duration[cid] += total_duration

                cap = c.capacity_eqp or DEFAULT_CAPACITY_EQP
                fill_rate = round((total_eqp / cap) * 100, 1) if cap > 0 else 0.0

                # Coût — formule alignée historique/synthèse
                nb_tours_for_contract = contract_tour_count[cid]
                # Une seule vacation (#58) : `fixed` additionnait un doublon.
                fixed = 0.0
                vacation = effective_vacation(c) / nb_tours_for_contract
                consumption = float(c.consumption_coefficient or 0)
                km_rate = price_for_contract(fuel_prices, c) * consumption
                # Fallback sur cost_per_km si fuel ou conso manquant
                if km_rate == 0:
                    km_rate = float(c.cost_per_km or 0)
                fuel_cost = total_tour_km * km_rate
                km_tax = self._sum_km_tax(km_tax_cache, base.id, sequenced)
                total_cost = round(fixed + vacation + fuel_cost + km_tax, 2)

                sc = SuggestedContract(
                    contract_id=c.id,
                    contract_code=c.code,
                    transporter_name=c.transporter_name,
                    vehicle_code=c.vehicle_code,
                    vehicle_name=c.vehicle_name,
                    vehicle_type=c.vehicle_type.value if c.vehicle_type else None,
                    temperature_type=c.temperature_type.value if c.temperature_type else None,
                    capacity_eqp=cap,
                    has_tailgate=c.has_tailgate,
                    tailgate_type=c.tailgate_type.value if c.tailgate_type else None,
                    score=0.0,
                    fill_rate_pct=fill_rate,
                )
            else:
                total_cost = 0.0
                tour_warnings.append("Aucun contrat compatible")

            tours.append(SuggestedTour(
                tour_number=tour_number,
                contract=sc,
                stops=built_stops,
                total_eqp=total_eqp,
                total_weight_kg=round(total_weight, 2),
                total_km=round(total_tour_km, 1),
                total_cost=total_cost,
                departure_time=_minutes_to_time(departure_min),
                return_time=_minutes_to_time(return_min),
                total_duration_minutes=total_duration,
                warnings=tour_warnings,
            ))

        # ── Post-processing : séquencer les multi-trips du même contrat ──
        # Grouper les tours par contract_id (pas contract_idx) pour détecter les doublons
        contract_tours_map: dict[int, list[int]] = defaultdict(list)  # contract_id → [tour list indices]
        for t_idx, tour in enumerate(tours):
            if tour.contract:
                contract_tours_map[tour.contract.contract_id].append(t_idx)

        for cid, t_indices in contract_tours_map.items():
            if len(t_indices) < 2:
                continue
            # Trier par heure de départ actuelle (le plus tôt d'abord)
            t_indices.sort(key=lambda i: _time_to_minutes(tours[i].departure_time) or 0)

            # Le premier tour (A) garde ses horaires inchangés
            # Les tours suivants (B, C...) sont décalés après le retour du précédent
            for seq in range(1, len(t_indices)):
                prev_tour = tours[t_indices[seq - 1]]
                curr_idx = t_indices[seq]
                curr_tour = tours[curr_idx]

                prev_return_min = _time_to_minutes(prev_tour.return_time) or 0
                curr_departure_min = _time_to_minutes(curr_tour.departure_time) or 0

                if curr_departure_min < prev_return_min:
                    # Décaler : nouveau départ = retour du tour précédent + 15 min de battement
                    new_departure_min = prev_return_min + 15
                    offset = new_departure_min - curr_departure_min

                    # Recalculer les horaires de chaque stop
                    new_stops: list[SuggestedStop] = []
                    for stop in curr_tour.stops:
                        old_arr = _time_to_minutes(stop.arrival_time) or 0
                        old_dep = _time_to_minutes(stop.departure_time) or 0
                        new_stops.append(SuggestedStop(
                            sequence_order=stop.sequence_order,
                            pdv_id=stop.pdv_id,
                            pdv_code=stop.pdv_code,
                            pdv_name=stop.pdv_name,
                            pdv_city=stop.pdv_city,
                            eqp_count=stop.eqp_count,
                            weight_kg=stop.weight_kg,
                            nb_colis=stop.nb_colis,
                            has_sas=stop.has_sas,
                            arrival_time=_minutes_to_time(old_arr + offset),
                            departure_time=_minutes_to_time(old_dep + offset),
                            distance_from_previous_km=stop.distance_from_previous_km,
                            duration_from_previous_minutes=stop.duration_from_previous_minutes,
                            deadline=stop.deadline,
                            warnings=stop.warnings,
                        ))

                    new_return_min = (_time_to_minutes(curr_tour.return_time) or 0) + offset

                    # Vérifier si le tour dépasse 10h journée (600 min = 00:00→10:00)
                    tour_warnings = list(curr_tour.warnings)
                    if new_return_min > MAX_DAILY_MINUTES:
                        tour_warnings.append(
                            f"Multi-trip : retour à {_minutes_to_time(new_return_min)}, dépasse 10h"
                        )

                    # Remplacer le tour avec horaires décalés
                    tours[curr_idx] = SuggestedTour(
                        tour_number=curr_tour.tour_number,
                        contract=curr_tour.contract,
                        stops=new_stops,
                        total_eqp=curr_tour.total_eqp,
                        total_weight_kg=curr_tour.total_weight_kg,
                        total_km=curr_tour.total_km,
                        total_cost=curr_tour.total_cost,
                        departure_time=_minutes_to_time(new_departure_min),
                        return_time=_minutes_to_time(new_return_min),
                        total_duration_minutes=curr_tour.total_duration_minutes,
                        warnings=tour_warnings,
                    )
                    log.info(
                        "Multi-trip contrat %d: tour %d décalé %d→%d min (après tour %d retour %d)",
                        cid, curr_tour.tour_number, curr_departure_min,
                        new_departure_min, prev_tour.tour_number, prev_return_min,
                    )

        # PDV droppés → unassigned
        for node_idx in dropped_indices:
            pid = node_to_pdv.get(node_idx)
            if pid is None:
                continue
            pdv = pdvs.get(pid)
            unassigned.append(UnassignedPDV(
                pdv_id=pid,
                pdv_code=pdv.code if pdv else "?",
                pdv_name=pdv.name if pdv else "?",
                pdv_city=pdv.city if pdv else None,
                eqp_count=pdv_agg[pid]["eqp_count"],
                reason="Non plaçable par l'optimiseur (capacité, temps ou dock/hayon)",
            ))

        return tours, unassigned, warnings

    # ══════════════════════════════════════════════════════════════
    # Helpers communs / Common helpers
    # ══════════════════════════════════════════════════════════════

    def _sequence_sas_first(
        self, tour_pdvs: list[int], base: BaseLogistics,
        pdvs: dict[int, PDV], dist_cache: dict, temperature_class: str
    ) -> list[int]:
        """Séquencer SAS d'abord, puis non-SAS par nearest-neighbor / Sequence SAS first then non-SAS."""
        sas_pdvs = []
        non_sas_pdvs = []
        for pid in tour_pdvs:
            pdv = pdvs.get(pid)
            if pdv and self._has_sas(pdv, temperature_class):
                sas_pdvs.append(pid)
            else:
                non_sas_pdvs.append(pid)

        sequenced = []
        current_type, current_id = "BASE", base.id

        # SAS first
        sas_remaining = set(sas_pdvs)
        while sas_remaining:
            best_id = None
            best_dist = float("inf")
            for pid in sas_remaining:
                key = (current_type, current_id, "PDV", pid)
                d = dist_cache.get(key, 9999)
                if d < best_dist:
                    best_dist = d
                    best_id = pid
            if best_id is None:
                break
            sequenced.append(best_id)
            sas_remaining.discard(best_id)
            current_type, current_id = "PDV", best_id

        # Then non-SAS
        non_sas_remaining = set(non_sas_pdvs)
        while non_sas_remaining:
            best_id = None
            best_dist = float("inf")
            for pid in non_sas_remaining:
                key = (current_type, current_id, "PDV", pid)
                d = dist_cache.get(key, 9999)
                if d < best_dist:
                    best_dist = d
                    best_id = pid
            if best_id is None:
                break
            sequenced.append(best_id)
            non_sas_remaining.discard(best_id)
            current_type, current_id = "PDV", best_id

        return sequenced

    def _build_single_tour(
        self,
        tour_number: int,
        sequenced: list[int],
        base: BaseLogistics,
        pdvs: dict[int, PDV],
        pdv_agg: dict,
        dist_cache: dict,
        dur_cache: dict,
        contracts: list[Contract],
        request: AideDecisionRequest,
        contract_tour_count: dict[int, int],
        contract_duration: dict[int, int],
        max_capacity: int,
        fuel_prices: dict[str, float],
        km_tax_cache: dict[tuple, float],
    ) -> SuggestedTour:
        """Construire un tour complet à partir d'une séquence PDV / Build a complete tour from a PDV sequence."""
        stops_info = self._compute_stops_info(
            sequenced, base, pdvs, pdv_agg, dist_cache, dur_cache, request.temperature_class
        )

        total_tour_km = sum(s["distance_km"] for s in stops_info)
        if sequenced:
            last_key = ("PDV", sequenced[-1], "BASE", base.id)
            return_km = dist_cache.get(last_key, 0)
            return_dur = dur_cache.get(last_key, int(return_km / AVERAGE_SPEED_KMH * 60) if return_km else 0)
        else:
            return_km = 0
            return_dur = 0
        total_tour_km += return_km

        total_eqp = sum(pdv_agg[pid]["eqp_count"] for pid in sequenced)
        total_weight = sum(pdv_agg[pid]["weight_kg"] for pid in sequenced)

        earliest_deadline = self._get_earliest_deadline(
            sequenced, pdvs, request.temperature_class
        )
        total_driving = sum(s["duration_min"] for s in stops_info)
        total_unload = sum(s["unload_min"] for s in stops_info)
        total_route_minutes = total_driving + total_unload + return_dur

        if earliest_deadline is not None:
            departure_min = earliest_deadline - total_driving - total_unload
            if departure_min < 0:
                departure_min = 0
        else:
            departure_min = 180

        tour_warnings: list[str] = []
        current_min = departure_min
        built_stops: list[SuggestedStop] = []
        for idx, info in enumerate(stops_info):
            current_min += info["duration_min"]
            arrival_min = current_min
            pdv = pdvs.get(info["pdv_id"])
            pdv_data = pdv_agg[info["pdv_id"]]

            has_sas = pdv and self._has_sas(pdv, request.temperature_class)
            deadline_str = self._get_pdv_deadline(pdv, request.temperature_class)
            deadline_min = _time_to_minutes(deadline_str)

            stop_warnings: list[str] = []
            if deadline_min is not None and arrival_min > deadline_min:
                stop_warnings.append(f"Retard: arrivée {_minutes_to_time(arrival_min)} > deadline {deadline_str}")
                tour_warnings.append(
                    f"Stop {idx + 1} ({pdv.code if pdv else '?'}): retard livraison"
                )

            departure_stop_min = arrival_min + info["unload_min"]
            current_min = departure_stop_min

            built_stops.append(SuggestedStop(
                sequence_order=idx + 1,
                pdv_id=info["pdv_id"],
                pdv_code=pdv.code if pdv else "?",
                pdv_name=pdv.name if pdv else "?",
                pdv_city=pdv.city if pdv else None,
                eqp_count=pdv_data["eqp_count"],
                weight_kg=pdv_data["weight_kg"],
                nb_colis=pdv_data["nb_colis"],
                has_sas=has_sas or False,
                arrival_time=_minutes_to_time(arrival_min),
                departure_time=_minutes_to_time(departure_stop_min),
                distance_from_previous_km=round(info["distance_km"], 1),
                duration_from_previous_minutes=info["duration_min"],
                deadline=deadline_str,
                warnings=stop_warnings,
            ))

        return_min = current_min + return_dur
        total_duration = return_min - departure_min

        for pid in sequenced:
            if pdv_agg[pid]["eqp_count"] > max_capacity:
                p = pdvs.get(pid)
                tour_warnings.append(
                    f"PDV {p.code if p else pid} dépasse la capacité max ({pdv_agg[pid]['eqp_count']} > {max_capacity} EQP)"
                )

        selected_contract = None
        if contracts:
            selected_contract = self._select_contract(
                contracts, sequenced, pdvs, total_eqp, total_duration,
                request.temperature_class, contract_tour_count, contract_duration
            )
            if selected_contract:
                cid = selected_contract["contract"].id
                contract_tour_count[cid] += 1
                contract_duration[cid] += total_duration
            else:
                tour_warnings.append("Aucun contrat compatible (capacité, dock/hayon, ou 10h dépassées)")

        total_cost = self._compute_cost(
            selected_contract, total_tour_km, contract_tour_count,
            fuel_prices, km_tax_cache, base.id, sequenced,
        )

        sc = None
        fill_rate = 0.0
        if selected_contract:
            c = selected_contract["contract"]
            cap = c.capacity_eqp or DEFAULT_CAPACITY_EQP
            fill_rate = round((total_eqp / cap) * 100, 1) if cap > 0 else 0.0
            sc = SuggestedContract(
                contract_id=c.id,
                contract_code=c.code,
                transporter_name=c.transporter_name,
                vehicle_code=c.vehicle_code,
                vehicle_name=c.vehicle_name,
                vehicle_type=c.vehicle_type.value if c.vehicle_type else None,
                temperature_type=c.temperature_type.value if c.temperature_type else None,
                capacity_eqp=cap,
                has_tailgate=c.has_tailgate,
                tailgate_type=c.tailgate_type.value if c.tailgate_type else None,
                score=round(selected_contract["score"], 4),
                fill_rate_pct=fill_rate,
            )

        return SuggestedTour(
            tour_number=tour_number,
            contract=sc,
            stops=built_stops,
            total_eqp=total_eqp,
            total_weight_kg=round(total_weight, 2),
            total_km=round(total_tour_km, 1),
            total_cost=round(total_cost, 2),
            departure_time=_minutes_to_time(departure_min),
            return_time=_minutes_to_time(return_min),
            total_duration_minutes=total_duration,
            warnings=tour_warnings,
        )

    # ── Data loading helpers ──────────────────────────────────────

    async def _load_base(self, base_id: int) -> BaseLogistics | None:
        result = await self.db.execute(select(BaseLogistics).where(BaseLogistics.id == base_id))
        return result.scalar_one_or_none()

    async def _load_volumes(self, request: AideDecisionRequest) -> dict:
        """Agréger volumes par PDV / Aggregate volumes by PDV."""
        stmt = (
            select(
                Volume.pdv_id,
                func.sum(Volume.eqp_count).label("eqp_count"),
                func.sum(Volume.weight_kg).label("weight_kg"),
                func.sum(Volume.nb_colis).label("nb_colis"),
            )
            .where(
                Volume.dispatch_date == request.dispatch_date,
                Volume.base_origin_id == request.base_origin_id,
                Volume.temperature_class == request.temperature_class,
                Volume.tour_id.is_(None),
            )
            .group_by(Volume.pdv_id)
        )
        result = await self.db.execute(stmt)
        rows = result.all()
        agg: dict = {}
        for row in rows:
            agg[row.pdv_id] = {
                "eqp_count": float(row.eqp_count or 0),
                "weight_kg": float(row.weight_kg or 0),
                "nb_colis": int(row.nb_colis or 0),
            }
        return agg

    async def _load_pdvs(self, pdv_ids: list[int]) -> dict[int, PDV]:
        if not pdv_ids:
            return {}
        result = await self.db.execute(select(PDV).where(PDV.id.in_(pdv_ids)))
        return {p.id: p for p in result.scalars().all()}

    async def _load_distance_cache(
        self, base_id: int, pdv_ids: list[int],
        base: BaseLogistics, pdvs: dict[int, PDV]
    ) -> tuple[dict, dict]:
        """Charger toutes les distances en batch / Load all distances in batch.
        Returns (dist_cache, dur_cache) with bidirectional keys.
        """
        dist_cache: dict[tuple, float] = {}
        dur_cache: dict[tuple, int] = {}

        if not pdv_ids:
            return dist_cache, dur_cache

        # All pairs involving BASE or PDV↔PDV
        all_ids = pdv_ids + [base_id]
        stmt = select(DistanceMatrix).where(
            or_(
                and_(
                    DistanceMatrix.origin_type == "BASE",
                    DistanceMatrix.origin_id == base_id,
                    DistanceMatrix.destination_type == "PDV",
                    DistanceMatrix.destination_id.in_(pdv_ids),
                ),
                and_(
                    DistanceMatrix.origin_type == "PDV",
                    DistanceMatrix.origin_id.in_(pdv_ids),
                    DistanceMatrix.destination_type == "BASE",
                    DistanceMatrix.destination_id == base_id,
                ),
                and_(
                    DistanceMatrix.origin_type == "PDV",
                    DistanceMatrix.origin_id.in_(pdv_ids),
                    DistanceMatrix.destination_type == "PDV",
                    DistanceMatrix.destination_id.in_(pdv_ids),
                ),
            )
        )
        result = await self.db.execute(stmt)
        for row in result.scalars().all():
            fwd = (row.origin_type, row.origin_id, row.destination_type, row.destination_id)
            rev = (row.destination_type, row.destination_id, row.origin_type, row.origin_id)
            d = float(row.distance_km)
            dur = int(row.duration_minutes)
            dist_cache[fwd] = d
            dist_cache[rev] = d
            dur_cache[fwd] = dur
            dur_cache[rev] = dur

        # Fallback haversine for missing pairs
        base_lat, base_lon = base.latitude, base.longitude
        for pid in pdv_ids:
            key_fwd = ("BASE", base_id, "PDV", pid)
            if key_fwd not in dist_cache:
                pdv = pdvs.get(pid)
                if pdv and pdv.latitude and pdv.longitude and base_lat and base_lon:
                    d = _haversine_km(base_lat, base_lon, pdv.latitude, pdv.longitude)
                    dur = int(d / AVERAGE_SPEED_KMH * 60)
                    key_rev = ("PDV", pid, "BASE", base_id)
                    dist_cache[key_fwd] = d
                    dist_cache[key_rev] = d
                    dur_cache[key_fwd] = dur
                    dur_cache[key_rev] = dur

            for pid2 in pdv_ids:
                if pid == pid2:
                    continue
                key = ("PDV", pid, "PDV", pid2)
                if key not in dist_cache:
                    p1, p2 = pdvs.get(pid), pdvs.get(pid2)
                    if (p1 and p2 and p1.latitude and p1.longitude
                            and p2.latitude and p2.longitude):
                        d = _haversine_km(p1.latitude, p1.longitude, p2.latitude, p2.longitude)
                        dur = int(d / AVERAGE_SPEED_KMH * 60)
                        key_rev = ("PDV", pid2, "PDV", pid)
                        dist_cache[key] = d
                        dist_cache[key_rev] = d
                        dur_cache[key] = dur
                        dur_cache[key_rev] = dur

        return dist_cache, dur_cache

    async def _load_contracts(
        self, request: AideDecisionRequest, base: BaseLogistics
    ) -> list[Contract]:
        """Charger les contrats disponibles / Load available contracts."""
        compatible_temps = TEMP_COMPAT.get(request.temperature_class, {request.temperature_class})

        # IDs des contrats indisponibles ce jour / Unavailable contract IDs for this date
        unavail_stmt = (
            select(ContractSchedule.contract_id)
            .where(
                ContractSchedule.date == request.dispatch_date,
                ContractSchedule.is_available == False,  # noqa: E712
            )
        )
        unavail_result = await self.db.execute(unavail_stmt)
        unavail_ids = {row[0] for row in unavail_result.all()}

        stmt = select(Contract).where(
            Contract.region_id == base.region_id,
        )
        result = await self.db.execute(stmt)
        all_contracts = result.scalars().all()

        valid = []
        for c in all_contracts:
            if c.id in unavail_ids:
                continue
            # Check date validity
            if c.start_date and c.start_date > request.dispatch_date:
                continue
            if c.end_date and c.end_date < request.dispatch_date:
                continue
            # Check temperature compatibility
            if c.temperature_type:
                temp_val = c.temperature_type.value if hasattr(c.temperature_type, "value") else c.temperature_type
                if temp_val not in compatible_temps:
                    continue
            valid.append(c)

        return valid

    async def _load_fuel_prices(self, dispatch_date: str) -> dict[str, float]:
        """Charger les prix carburant (par type) pour la date /
        Load fuel prices (by type) for the date."""
        return await load_fuel_unit_prices(self.db, dispatch_date)

    async def _load_km_tax_cache(
        self, base_id: int, pdv_ids: list[int]
    ) -> dict[tuple, float]:
        """Charger la taxe km pour tous les segments possibles / Load km tax for all possible segments.
        Returns dict: (origin_type, origin_id, dest_type, dest_id) → tax_amount (flat).
        """
        cache: dict[tuple, float] = {}
        if not pdv_ids:
            return cache

        stmt = select(KmTax).where(
            or_(
                # BASE → PDV
                and_(
                    KmTax.origin_type == "BASE",
                    KmTax.origin_id == base_id,
                    KmTax.destination_type == "PDV",
                    KmTax.destination_id.in_(pdv_ids),
                ),
                # PDV → BASE
                and_(
                    KmTax.origin_type == "PDV",
                    KmTax.origin_id.in_(pdv_ids),
                    KmTax.destination_type == "BASE",
                    KmTax.destination_id == base_id,
                ),
                # PDV → PDV
                and_(
                    KmTax.origin_type == "PDV",
                    KmTax.origin_id.in_(pdv_ids),
                    KmTax.destination_type == "PDV",
                    KmTax.destination_id.in_(pdv_ids),
                ),
            )
        )
        result = await self.db.execute(stmt)
        for row in result.scalars().all():
            key = (row.origin_type, row.origin_id, row.destination_type, row.destination_id)
            cache[key] = float(row.tax_per_km)
        return cache

    # ── PDV helpers ───────────────────────────────────────────────

    def _has_sas(self, pdv: PDV, temperature_class: str) -> bool:
        """Vérifie si le PDV a un SAS pour la classe de température / Check if PDV has SAS for temp class."""
        if temperature_class == "SEC":
            return pdv.has_sas_sec
        elif temperature_class == "FRAIS":
            return pdv.has_sas_frais
        elif temperature_class == "GEL":
            return pdv.has_sas_gel
        return False

    def _get_pdv_deadline(self, pdv: PDV | None, temperature_class: str) -> str | None:
        """Deadline pour un PDV / Deadline for a PDV."""
        if not pdv:
            return None
        if pdv.delivery_window_end:
            return pdv.delivery_window_end
        if self._has_sas(pdv, temperature_class):
            return SAS_DEADLINE
        return NON_SAS_DEADLINE

    def _get_earliest_deadline(
        self, pdv_ids: list[int], pdvs: dict[int, PDV], temperature_class: str
    ) -> int | None:
        """Plus tôt deadline du tour en minutes / Earliest deadline in tour in minutes."""
        earliest = None
        for pid in pdv_ids:
            pdv = pdvs.get(pid)
            dl = self._get_pdv_deadline(pdv, temperature_class)
            dl_min = _time_to_minutes(dl)
            if dl_min is not None:
                if earliest is None or dl_min < earliest:
                    earliest = dl_min
        return earliest

    # ── Tour computation helpers ─────────────────────────────────

    def _compute_stops_info(
        self, sequenced: list[int], base: BaseLogistics,
        pdvs: dict[int, PDV], pdv_agg: dict,
        dist_cache: dict, dur_cache: dict, temperature_class: str
    ) -> list[dict]:
        """Compute distance/duration/unload info for each stop in sequence."""
        stops_info = []
        prev_type, prev_id = "BASE", base.id
        for pid in sequenced:
            key = (prev_type, prev_id, "PDV", pid)
            distance_km = dist_cache.get(key, 0)
            duration_min = dur_cache.get(key, int(distance_km / AVERAGE_SPEED_KMH * 60) if distance_km else 0)

            pdv = pdvs.get(pid)
            eqp = pdv_agg[pid]["eqp_count"]
            dock_time = (pdv.dock_time_minutes if pdv and pdv.dock_time_minutes else DEFAULT_DOCK_TIME)
            unload_per_eqp = (pdv.unload_time_per_eqp_minutes if pdv and pdv.unload_time_per_eqp_minutes else DEFAULT_UNLOAD_PER_EQP)
            unload_min = dock_time + (eqp * unload_per_eqp)

            stops_info.append({
                "pdv_id": pid,
                "distance_km": distance_km,
                "duration_min": duration_min,
                "unload_min": unload_min,
            })
            prev_type, prev_id = "PDV", pid
        return stops_info

    def _estimate_tour_time(
        self, pdv_ids: list[int], base: BaseLogistics,
        pdvs: dict[int, PDV], pdv_agg: dict,
        dist_cache: dict, dur_cache: dict
    ) -> int:
        """Estimer la durée totale d'un tour (conduite + déchargement + retour) / Estimate total tour duration."""
        total = 0
        prev_type, prev_id = "BASE", base.id
        for pid in pdv_ids:
            key = (prev_type, prev_id, "PDV", pid)
            d_km = dist_cache.get(key, 0)
            total += dur_cache.get(key, int(d_km / AVERAGE_SPEED_KMH * 60) if d_km else 0)
            pdv = pdvs.get(pid)
            eqp = pdv_agg[pid]["eqp_count"]
            dock = (pdv.dock_time_minutes if pdv and pdv.dock_time_minutes else DEFAULT_DOCK_TIME)
            unload = (pdv.unload_time_per_eqp_minutes if pdv and pdv.unload_time_per_eqp_minutes else DEFAULT_UNLOAD_PER_EQP)
            total += dock + (eqp * unload)
            prev_type, prev_id = "PDV", pid
        if pdv_ids:
            key = ("PDV", pdv_ids[-1], "BASE", base.id)
            d_km = dist_cache.get(key, 0)
            total += dur_cache.get(key, int(d_km / AVERAGE_SPEED_KMH * 60) if d_km else 0)
        return total

    # ── Contract helpers ─────────────────────────────────────────

    def _check_vehicle_type(self, pdv: PDV, contract: Contract) -> bool:
        """Vérifie compatibilité type véhicule / Check vehicle type compatibility.
        NULL allowed_vehicle_types = tous acceptés / all accepted.
        Returns True if compatible, False if violation.
        """
        if not pdv.allowed_vehicle_types:
            return True
        allowed = pdv.allowed_vehicle_types.split("|")
        vt = contract.vehicle_type
        vt_value = vt.value if (vt and hasattr(vt, "value")) else vt
        return vt_value in allowed if vt_value else True

    def _check_dock_tailgate(self, pdv: PDV, contract: Contract) -> bool:
        """Vérifie compatibilité dock/hayon / Check dock/tailgate compatibility.
        Returns True if compatible, False if violation.
        """
        has_tailgate = contract.has_tailgate
        tg_type = contract.tailgate_type
        tg_value = tg_type.value if (tg_type and hasattr(tg_type, "value")) else tg_type

        if not pdv.has_dock:
            if not has_tailgate:
                return False
        else:
            # Quai sans niche : seul le hayon rétractable est utilisable (rabattable interdit)
            if not pdv.dock_has_niche and has_tailgate and tg_value == "RABATTABLE":
                return False
        return True

    def _select_contract(
        self, contracts: list[Contract], pdv_ids: list[int],
        pdvs: dict[int, PDV], total_eqp: int, total_duration: int,
        temperature_class: str, contract_tour_count: dict[int, int],
        contract_duration: dict[int, int]
    ) -> dict | None:
        """Sélectionner le meilleur contrat / Select best contract."""
        candidates = []
        for c in contracts:
            cap = c.capacity_eqp or DEFAULT_CAPACITY_EQP
            if cap < total_eqp:
                continue

            used = contract_duration.get(c.id, 0)
            if used + total_duration > MAX_DAILY_MINUTES:
                continue

            compatible = True
            for pid in pdv_ids:
                pdv = pdvs.get(pid)
                if pdv and (not self._check_dock_tailgate(pdv, c) or not self._check_vehicle_type(pdv, c)):
                    compatible = False
                    break
            if not compatible:
                continue

            fill_rate = total_eqp / cap if cap > 0 else 0
            nb_used = contract_tour_count.get(c.id, 0)

            fixed = effective_vacation(c)
            km_cost_unit = float(c.cost_per_km or 0)
            if nb_used == 0:
                marginal_cost = fixed + km_cost_unit * 100
            else:
                marginal_cost = km_cost_unit * 100

            candidates.append({
                "contract": c,
                "fill_rate": fill_rate,
                "marginal_cost": marginal_cost,
                "nb_used": nb_used,
            })

        if not candidates:
            return None

        max_cost = max(x["marginal_cost"] for x in candidates) or 1
        best = None
        best_score = float("inf")
        for cand in candidates:
            norm_cost = cand["marginal_cost"] / max_cost
            score = (norm_cost * 0.6) + ((1 - cand["fill_rate"]) * 0.4)
            if score < best_score:
                best_score = score
                best = {**cand, "score": score}

        return best

    def _compute_cost(
        self, selected_contract: dict | None, total_km: float,
        contract_tour_count: dict[int, int],
        fuel_prices: dict[str, float], km_tax_cache: dict[tuple, float],
        base_id: int, sequenced_pdv_ids: list[int],
    ) -> float:
        """Calculer le coût estimé — formule alignée sur historique/synthèse.
        Compute estimated cost — aligned with history/synthesis formula.
        fixed/nb_tours + vacation/nb_tours + km * fuel * conso + sum(km_tax)
        """
        if not selected_contract:
            return 0.0
        c = selected_contract["contract"]
        nb_tours = contract_tour_count.get(c.id, 1) or 1
        # Une seule vacation (#58).
        fixed = 0.0
        vacation = effective_vacation(c) / nb_tours
        consumption = float(c.consumption_coefficient or 0)
        km_rate = price_for_contract(fuel_prices, c) * consumption
        # Fallback sur cost_per_km si fuel ou conso manquant
        if km_rate == 0:
            km_rate = float(c.cost_per_km or 0)
        fuel_cost = total_km * km_rate
        # Taxe km forfaitaire par segment / Flat km tax per segment
        km_tax_total = self._sum_km_tax(km_tax_cache, base_id, sequenced_pdv_ids)
        return round(fixed + vacation + fuel_cost + km_tax_total, 2)

    @staticmethod
    def _sum_km_tax(
        km_tax_cache: dict[tuple, float], base_id: int, sequenced_pdv_ids: list[int]
    ) -> float:
        """Sommer la taxe km pour les segments d'un tour / Sum km tax for tour segments."""
        total = 0.0
        prev_type, prev_id = "BASE", base_id
        for pid in sequenced_pdv_ids:
            key = (prev_type, prev_id, "PDV", pid)
            total += km_tax_cache.get(key, 0.0)
            prev_type, prev_id = "PDV", pid
        if sequenced_pdv_ids:
            key = ("PDV", sequenced_pdv_ids[-1], "BASE", base_id)
            total += km_tax_cache.get(key, 0.0)
        return round(total, 2)

    def _empty_response(
        self, request: AideDecisionRequest, base_name: str, warning: str
    ) -> AideDecisionResponse:
        return AideDecisionResponse(
            dispatch_date=request.dispatch_date,
            base_origin_id=request.base_origin_id,
            base_name=base_name,
            temperature_class=request.temperature_class,
            tours=[],
            unassigned_pdvs=[],
            summary=AideDecisionSummary(
                total_tours=0, total_eqp=0, total_weight_kg=0,
                total_km=0, total_cost=0, avg_fill_rate_pct=0,
            ),
            warnings=[warning],
        )
