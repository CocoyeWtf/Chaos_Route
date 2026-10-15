"""Tests des services / Service tests."""

from app.services.time_calculator import TimeCalculatorService
from app.services.cost_calculator import CostCalculatorService
from app.services.distance_service import DistanceService
from app.services.kpi_service import KpiService


def test_travel_time():
    assert TimeCalculatorService.calculate_travel_time_minutes(60.0, 60.0) == 60
    assert TimeCalculatorService.calculate_travel_time_minutes(30.0, 60.0) == 30


def test_stop_duration():
    # 10 min mise à quai + 3 EQP * 5 min = 25 min
    assert TimeCalculatorService.calculate_stop_duration(10, 3, 5) == 25


def test_add_minutes():
    assert TimeCalculatorService.add_minutes_to_time("08:00", 90) == "09:30"
    assert TimeCalculatorService.add_minutes_to_time("23:30", 60) == "00:30"


def test_tour_cost():
    cost = CostCalculatorService.calculate_tour_cost(
        total_km=200, vacation=150, cost_per_km=1.2
    )
    assert cost == 390.0


def test_haversine():
    # Paris -> Lyon ~ 392 km
    dist = DistanceService.haversine_km(48.8566, 2.3522, 45.7640, 4.8357)
    assert 380 < dist < 400


def test_fill_rate():
    assert KpiService.fill_rate(24, 30) == 80.0


def test_cost_per_eqp():
    assert KpiService.cost_per_eqp(300, 10) == 30.0


def test_co2():
    assert KpiService.estimate_co2_kg(100) == 90.0
