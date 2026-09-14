"""Tests calcul de coût pré-facturation CMRO + jours fériés belges.

Barème équipe transport :
- Type 2 (tractionnaire) = vacation(fixe÷nb) + remorque(÷nb) + km×t_km
  + gasoil(km×conso×prix) + t_horaire + HA + prime(jour) + taxe.
- Conso = override contrat sinon 0,29 (SEMI) / 0,26 (porteur).
- Types 1/3/4 = forfait journalier ÷ nb tournées.
"""

from datetime import date
from types import SimpleNamespace

from app.services.cmro_extraction import compute_cost
from app.utils.holidays_be import is_belgian_holiday


def _tour(d: str, vehicle_type="SEMI"):
    return SimpleNamespace(
        total_km=100, total_duration_minutes=120,  # 2h
        barrier_exit_time=None, barrier_entry_time=None, date=d, vehicle_type=vehicle_type,
    )


def _contract(**over):
    base = dict(
        fixed_daily_cost=400, cost_per_km=0.5, consumption_coefficient=0.3,
        cost_per_hour=10, ha_cost=50, trailer_cost=65,
        prime_saturday=30, prime_sunday_holiday=60,
        billing_type=2, daily_cost=0, vehicle_type="SEMI",
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_cost_type2_weekday():
    # lundi, nb_tours=2 -> termes "÷ nb" partagés
    c = compute_cost(_tour("2026-06-08"), _contract(), nb_tours=2, fuel_price=1.8, km_tax_total=20)
    assert c["t_fixe"] == 200        # 400/2
    assert c["t_rem"] == 32.5        # 65/2  (remorque ÷ nb)
    assert c["t_km"] == 50           # 100*0.5
    assert c["gasoil"] == 54         # 100*0.3*1.8 (override contrat)
    assert c["t_horaire"] == 20
    assert c["ha"] == 50
    assert c["total_taxe"] == 20
    assert c["cout_tournee"] == 426.5  # 200+50+54+20+50+32.5+20


def test_trailer_fee_not_billed_in_mixte():
    """Ticket #41 : en mixte la remorque est la NOTRE (tour.vehicle_id) ->
    t_rem n'est pas facture. En preste il l'est."""
    tour = _tour("2026-06-08")
    tour.vehicle_id = 77  # remorque CMRO affectee => mode mixte
    c = compute_cost(tour, _contract(), nb_tours=1, fuel_price=1.8, km_tax_total=0)
    assert c["t_rem"] == 0
    assert c["cout_tournee"] == 574   # 400+50+54+20+50 (sans les 65 de remorque)

    preste = _tour("2026-06-08")      # pas de vehicle_id => preste
    c2 = compute_cost(preste, _contract(), nb_tours=1, fuel_price=1.8, km_tax_total=0)
    assert c2["t_rem"] == 65
    assert c2["cout_tournee"] == 639  # 574 + 65


def test_consumption_by_vehicle_type():
    # Pas de consumption_coefficient -> défaut par type véhicule
    semi = compute_cost(_tour("2026-06-08", "SEMI"), _contract(consumption_coefficient=None),
                        nb_tours=1, fuel_price=1.0, km_tax_total=0)
    assert semi["gasoil"] == 29      # 100*0.29*1.0
    porteur = compute_cost(_tour("2026-06-08", "PORTEUR"),
                           _contract(consumption_coefficient=None, vehicle_type="PORTEUR"),
                           nb_tours=1, fuel_price=1.0, km_tax_total=0)
    assert porteur["gasoil"] == 26   # 100*0.26*1.0


def test_cost_type3_forfait():
    # Occasionnel : forfait journalier ÷ nb tournées, pas de breakdown
    c = compute_cost(_tour("2026-06-08"), _contract(billing_type=3, daily_cost=300),
                     nb_tours=2, fuel_price=1.8, km_tax_total=20)
    assert c["cout_tournee"] == 150  # 300/2
    assert c["t_km"] == "" and c["gasoil"] == ""


def test_prime_saturday_and_holiday():
    sam = compute_cost(_tour("2026-06-13"), _contract(), nb_tours=1, fuel_price=0, km_tax_total=0)
    assert sam["prime_sam"] == 30 and sam["prime_dim"] == ""
    fer = compute_cost(_tour("2026-07-21"), _contract(), nb_tours=1, fuel_price=0, km_tax_total=0)
    assert fer["prime_dim"] == 60 and fer["prime_sam"] == ""


def test_holidays():
    assert is_belgian_holiday(date(2026, 7, 21))   # Fête nationale
    assert is_belgian_holiday(date(2026, 4, 6))    # Lundi de Pâques 2026
    assert not is_belgian_holiday(date(2026, 4, 7))
