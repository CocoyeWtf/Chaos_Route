"""Extraction pré-facturation transporteur au format "Modèle extraction CMRO".

Produit une ligne par tour, colonnes dans l'ordre exact de la feuille Tour_ERT
du modèle (en-têtes chargés depuis cmro_columns.json). Les clés internes
(_CMRO_FIELDS) sont découplées des en-têtes accentués pour éviter toute erreur
de correspondance. Les colonnes que CHAOS ne sait pas remplir restent vides.

Le coût/tournée réplique le barème CMRO :
  Coût = T_fixe + T_km + Gasoil + T_horaire + HA + T_rem + Prime + Total_Taxe
"""

import json
from datetime import date, datetime
from pathlib import Path

from app.utils.holidays_be import is_belgian_holiday

# En-têtes exacts du modèle (Tour_ERT) / Exact model headers
_COLUMNS_PATH = Path(__file__).parent / "cmro_columns.json"
CMRO_COLUMNS: list[str] = json.loads(_COLUMNS_PATH.read_text(encoding="utf-8"))

# Clés internes parallèles aux en-têtes (même ordre) / Internal keys parallel to headers
CMRO_FIELDS: list[str] = (
    ["mois", "sem", "date_tour", "date_fact", "date_fac", "site_depart", "etat_depart",
     "passage_garde", "etat_mission", "ordre", "h_depart", "dispo_semi", "no_mission",
     "com_ert", "extr_livr", "extr_rep", "tour_valide_ert", "volume", "code_tour",
     "type_tour", "chauffeurs", "trac", "nom_chauff", "semi", "chargeurs", "code_ch",
     "porte", "temp", "h_disp_semi", "eqc_charges", "top_depart", "remarque",
     "observations", "depart", "retour"]
    + [f for i in range(1, 17) for f in (f"pdv{i}", f"ep{i}", f"rem{i}")]
    + ["delta_ep_ec", "eqc_prev", "capa_semi", "coef_prev", "coef_reel", "retard_dispo",
       "retard_exp", "retard_dep", "retard_fact", "pres_site", "h_sortie", "h_retour",
       "h_presta", "kms_depart", "kms_retour", "km_calcule", "remarque_garde", "nb_pdv",
       "km_tour", "t_pdv", "t_eqc", "t_approche", "t_tour", "retour_base_cont"]
    + [f"arr_pdv{i}" for i in range(1, 18)]
    + ["total_taxe", "type_ch", "km_hors_base", "t_km", "gasoil", "t_horaire", "ha",
       "prime_sam", "prime_dim", "cout_tournee", "t_fixe", "t_rem", "remarque_ert",
       "eqc_liv", "colis_liv", "eqc_zebre", "eqc_sol_zebre", "_b1", "_b2", "_b3"]
)

assert len(CMRO_FIELDS) == len(CMRO_COLUMNS), (
    f"CMRO mapping désaligné: {len(CMRO_FIELDS)} clés vs {len(CMRO_COLUMNS)} colonnes"
)

_STATUS_FR = {
    "DRAFT": "Brouillon", "VALIDATED": "Validée", "IN_PROGRESS": "En cours",
    "RETURNING": "Retour", "COMPLETED": "Livrée",
}
_TEMP_FR = {"SEC": "Sec", "FRAIS": "Frais", "GEL": "Gel", "BI_TEMP": "Bi-temp", "TRI_TEMP": "Tri-temp"}


def _parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _hhmm(s: str | None) -> str | None:
    """Extrait HH:MM d'une chaîne 'HH:MM' ou 'YYYY-MM-DDTHH:MM'."""
    if not s:
        return None
    if "T" in s:
        return s.split("T", 1)[1][:5]
    return s[:5]


def _prestation_hours(tour) -> float:
    """Heures de prestation chauffeur : sortie→retour (barrières) sinon durée tournée."""
    ex, en = tour.barrier_exit_time, tour.barrier_entry_time
    if ex and en:
        try:
            de = datetime.fromisoformat(ex)
            dn = datetime.fromisoformat(en)
            h = (dn - de).total_seconds() / 3600.0
            if h > 0:
                return h
        except ValueError:
            pass
    return float(tour.total_duration_minutes or 0) / 60.0


def type_tour_label(tour) -> str:
    """Libellé Type_tour façon modèle (mix nature/température)."""
    tt = getattr(tour, "tour_type", None)
    tt = tt.value if hasattr(tt, "value") else tt
    if tt == "VIDANGES":
        return "Vidanges"
    if tt == "ENLEVEMENT":
        return "Enl."
    if tt == "DEPLACEMENT_BASE":
        return "Parc"
    if tt == "GARAGE":
        return "Tech"
    # LIVRAISON (ou None) -> température
    temp = tour.temperature_type
    temp = temp.value if hasattr(temp, "value") else temp
    return _TEMP_FR.get(temp, temp or "")


_EMPTY_COST = {
    "t_fixe": "", "t_km": "", "gasoil": "", "t_horaire": "", "ha": "", "t_rem": "",
    "prime_sam": "", "prime_dim": "", "total_taxe": "", "cout_tournee": "",
}


def _consumption(contract, tour) -> float:
    """Consommation L/km : override contrat si renseigné (ex. gaz kg/km),
    sinon 0,29 pour SEMI/tracteur, 0,26 pour porteur."""
    cc = getattr(contract, "consumption_coefficient", None)
    if cc is not None and float(cc) > 0:
        return float(cc)
    vt = getattr(contract, "vehicle_type", None) or getattr(tour, "vehicle_type", None)
    vt = vt.value if hasattr(vt, "value") else vt
    return 0.29 if vt == "SEMI" else 0.26


def billing_type_of(contract) -> int:
    """Type de facturation du contrat (défaut 2 = tractionnaire)."""
    bt = getattr(contract, "billing_type", None)
    try:
        return int(bt) if bt else 2
    except (TypeError, ValueError):
        return 2


def compute_cost(tour, contract, nb_tours: int, fuel_price: float, km_tax_total: float) -> dict:
    """Composantes de coût CMRO selon le type de facturation chauffeur."""
    nb = nb_tours or 1
    btype = billing_type_of(contract)

    # Types 1 (base/intérim), 3 (occasionnel), 4 (journalier) :
    # forfait/éval journalier ÷ nb tournées effectuées (tous sites)
    if btype != 2:
        daily = float(getattr(contract, "daily_cost", 0) or 0)
        cost = dict(_EMPTY_COST)
        cost["cout_tournee"] = round(daily / nb, 2)
        return cost

    # Type 2 (tractionnaire sous contrat) : barème complet
    km = float(tour.total_km or 0)
    t_fixe = round(float(contract.fixed_daily_cost or 0) / nb, 2)          # vacation = fixe ÷ nb
    # Remorque ÷ nb — SEULEMENT si le transporteur amène la sienne (presté).
    # En mixte c'est NOTRE remorque (tour.vehicle_id renseigne) : ne pas
    # facturer t_rem, cf. ticket #41. / Trailer fee only when the carrier
    # brings its own (presté); in mixte the trailer is ours.
    t_rem = 0.0 if getattr(tour, "vehicle_id", None) else round(
        float(getattr(contract, "trailer_cost", 0) or 0) / nb, 2
    )
    t_km = round(km * float(contract.cost_per_km or 0), 2)
    gasoil = round(km * _consumption(contract, tour) * (fuel_price or 0), 2)
    t_horaire = round(_prestation_hours(tour) * float(contract.cost_per_hour or 0), 2)
    ha = round(float(getattr(contract, "ha_cost", 0) or 0), 2)
    prime_sam = prime_dim = 0.0
    d = _parse_date(tour.date)
    if d:
        wd = d.weekday()  # 5=samedi, 6=dimanche
        if wd == 5:
            prime_sam = round(float(getattr(contract, "prime_saturday", 0) or 0), 2)
        elif wd == 6 or is_belgian_holiday(d):
            prime_dim = round(float(getattr(contract, "prime_sunday_holiday", 0) or 0), 2)
    taxe = round(float(km_tax_total or 0), 2)
    total = round(t_fixe + t_km + gasoil + t_horaire + ha + t_rem + prime_sam + prime_dim + taxe, 2)
    return {
        "t_fixe": t_fixe, "t_km": t_km, "gasoil": gasoil, "t_horaire": t_horaire,
        "ha": ha, "t_rem": t_rem, "prime_sam": prime_sam or "", "prime_dim": prime_dim or "",
        "total_taxe": taxe, "cout_tournee": total,
    }


def build_row(tour, contract, base_name: str, nb_tours: int, fuel_price: float,
              km_tax_total: float, eqc_liv, colis_liv, pdv_map: dict) -> dict:
    """Construit la ligne CMRO (dict clé interne -> valeur) pour un tour."""
    d = _parse_date(tour.date)
    stops = sorted(tour.stops, key=lambda s: s.sequence_order)
    row: dict = {k: "" for k in CMRO_FIELDS}

    row["mois"] = d.month if d else ""
    row["sem"] = d.isocalendar().week if d else ""
    row["date_tour"] = tour.date or ""
    row["date_fact"] = tour.delivery_date or tour.date or ""
    row["site_depart"] = base_name
    row["passage_garde"] = _hhmm(tour.barrier_exit_time) or ""
    row["etat_mission"] = _STATUS_FR.get(
        tour.status.value if hasattr(tour.status, "value") else tour.status, "")
    row["ordre"] = tour.priority if tour.priority is not None else ""
    row["h_depart"] = tour.departure_time or ""
    row["no_mission"] = tour.wms_tour_code or tour.code or ""
    row["code_tour"] = tour.code or ""
    row["type_tour"] = type_tour_label(tour)
    row["chauffeurs"] = (contract.vehicle_name or contract.code) if contract else ""
    row["nom_chauff"] = tour.driver_name or ""
    row["chargeurs"] = tour.loader_name or ""
    row["code_ch"] = tour.loader_code or ""
    row["porte"] = tour.dock_door_number or ""
    tt = tour.temperature_type
    row["temp"] = (tt.value if hasattr(tt, "value") else tt) or ""
    row["h_disp_semi"] = _hhmm(tour.trailer_ready_time) or ""
    row["eqc_charges"] = float(tour.eqp_loaded) if tour.eqp_loaded is not None else ""
    row["top_depart"] = _hhmm(tour.departure_signal_time) or ""
    row["remarque"] = tour.remarks or ""
    row["depart"] = base_name
    row["retour"] = base_name

    # Stops -> PDV1..16 + E.P + arrivées
    for i, s in enumerate(stops[:16], 1):
        pdv = pdv_map.get(s.pdv_id)
        row[f"pdv{i}"] = f"{pdv.code}-{pdv.name}" if pdv is not None else ""
        row[f"ep{i}"] = float(s.eqp_count) if s.eqp_count is not None else ""
    for i, s in enumerate(stops[:17], 1):
        row[f"arr_pdv{i}"] = _hhmm(s.arrival_time) or ""

    row["nb_pdv"] = len(stops)
    row["km_tour"] = float(tour.total_km) if tour.total_km is not None else ""
    row["type_ch"] = (tour.vehicle_type.value if hasattr(tour.vehicle_type, "value") else tour.vehicle_type) or ""
    row["kms_depart"] = tour.km_departure if tour.km_departure is not None else ""
    row["kms_retour"] = tour.km_return if tour.km_return is not None else ""
    if tour.km_departure is not None and tour.km_return is not None:
        row["km_calcule"] = tour.km_return - tour.km_departure
    row["h_sortie"] = _hhmm(tour.barrier_exit_time) or ""
    row["h_retour"] = _hhmm(tour.barrier_entry_time) or ""
    row["eqc_liv"] = round(float(eqc_liv), 2) if eqc_liv is not None else ""
    row["colis_liv"] = int(colis_liv) if colis_liv is not None else ""

    if contract:
        row.update(compute_cost(tour, contract, nb_tours, fuel_price, km_tax_total))
    return row
