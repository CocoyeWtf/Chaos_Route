"""Tests creation de contrat / Contract creation tests.

Couvre le payload tel qu'envoye par le frontend (champs vides -> null) et
l'absence de conflit d'unicite sur vehicle_code NULL. Garde-fou de regression
contre le 500 cause par un schema DB desynchronise (colonnes manquantes).
"""

import uuid

import pytest


@pytest.mark.asyncio
async def test_create_contract_minimal(client, test_region):
    """Payload tel qu'envoye par le frontend (champs vides -> null)."""
    payload = {
        "code": f"C{uuid.uuid4().hex[:6].upper()}",
        "carrier_id": None,
        "vehicle_code": None,
        "vehicle_name": None,
        "temperature_type": None,
        "vehicle_type": None,
        "capacity_eqp": None,
        "capacity_weight_kg": None,
        "has_tailgate": False,
        "tailgate_type": None,
        "provides_tractor": False,
        "provides_trailer": False,
        "vacation": None,
        "cost_per_km": None,
        "cost_per_hour": None,
        "min_hours_per_day": None,
        "min_km_per_day": None,
        "consumption_coefficient": None,
        "region_id": test_region.id,
        "start_date": None,
        "end_date": None,
        "transporter_name": "Test Transporteur",
        "fuel_type": "DIESEL",
    }
    resp = await client.post("/api/contracts/", json=payload)
    assert resp.status_code == 201, f"{resp.status_code}: {resp.text}"
    assert resp.json()["fuel_type"] == "DIESEL"


@pytest.mark.asyncio
async def test_create_contract_gaz(client, test_region):
    """Création d'un contrat camion au gaz (GNV)."""
    payload = {
        "code": f"G{uuid.uuid4().hex[:6].upper()}",
        "region_id": test_region.id,
        "transporter_name": "Transporteur Gaz",
        "has_tailgate": False,
        "fuel_type": "GNV",
    }
    resp = await client.post("/api/contracts/", json=payload)
    assert resp.status_code == 201, f"{resp.status_code}: {resp.text}"
    assert resp.json()["fuel_type"] == "GNV"


@pytest.mark.asyncio
async def test_create_contract_fuel_type_required(client, test_region):
    """fuel_type est obligatoire à la création (422 si absent)."""
    payload = {
        "code": f"N{uuid.uuid4().hex[:6].upper()}",
        "region_id": test_region.id,
        "transporter_name": "Sans carburant",
        "has_tailgate": False,
    }
    resp = await client.post("/api/contracts/", json=payload)
    assert resp.status_code == 422, f"attendu 422, recu {resp.status_code}: {resp.text}"


@pytest.mark.asyncio
async def test_create_contract_two_empty_vehicle_code(client, test_region):
    """Deux contrats sans vehicle_code (null) ne doivent pas violer l'unicite."""
    base = {
        "carrier_id": None, "vehicle_code": None, "region_id": test_region.id,
        "transporter_name": "T", "has_tailgate": False, "fuel_type": "DIESEL",
    }
    r1 = await client.post("/api/contracts/", json={**base, "code": f"A{uuid.uuid4().hex[:6].upper()}"})
    r2 = await client.post("/api/contracts/", json={**base, "code": f"B{uuid.uuid4().hex[:6].upper()}"})
    assert r1.status_code == 201, f"{r1.status_code}: {r1.text}"
    assert r2.status_code == 201, f"{r2.status_code}: {r2.text}"
