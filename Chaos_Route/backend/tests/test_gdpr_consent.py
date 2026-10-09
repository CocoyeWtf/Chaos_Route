"""Tests remédiation STIME A7 — information GPS + portabilité RGPD (Art. 20).

Couvre : notice d'information versionnée, accusé de lecture append-only
(preuve de l'information individuelle, L.1222-4), **absence d'opt-out en
libre-service** — la géolocalisation repose sur l'intérêt légitime, pas sur le
consentement — export self-service /my-data, export chauffeur par plaque.
"""

import uuid

import pytest


async def _make_device(db_session):
    from app.models.mobile_device import MobileDevice

    did = f"dev-{uuid.uuid4().hex[:10]}"
    device = MobileDevice(
        device_identifier=did,
        registration_code=uuid.uuid4().hex[:8].upper(),
        is_active=True,
        profile="DRIVER",
        allowed_features="tours,pickups,declarations",
    )
    db_session.add(device)
    await db_session.commit()
    await db_session.refresh(device)
    return device


async def _make_tour_with_assignment(db_session, test_region, device):
    from app.models.base_logistics import BaseLogistics
    from app.models.device_assignment import DeviceAssignment
    from app.models.tour import Tour, TourStatus

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base", region_id=test_region.id)
    db_session.add(base)
    await db_session.flush()
    tour = Tour(date="2026-07-08", code=f"T-{uuid.uuid4().hex[:8]}", base_id=base.id,
                status=TourStatus.VALIDATED)
    db_session.add(tour)
    await db_session.flush()
    db_session.add(DeviceAssignment(tour_id=tour.id, device_id=device.id, date="2026-07-08"))
    await db_session.commit()
    await db_session.refresh(tour)
    return tour


@pytest.mark.asyncio
async def test_gps_privacy_notice_is_public_and_versioned(client):
    resp = await client.get("/api/gdpr/privacy-notice/gps")
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"]
    assert "Finalité" in data["text"]
    assert "60 jours" in data["text"]


@pytest.mark.asyncio
async def test_notice_is_acknowledged_and_never_gates_ingestion(client, db_session, test_region):
    """La notice s'accuse, elle ne se refuse pas — et rien ne coupe l'ingestion.

    Regression garde-fou : un opt-out en libre-service suffisait a rendre un
    vehicule invisible d'un seul bouton, alors meme que le registre CNIL fonde
    le traitement sur l'interet legitime. Ce test verrouille le fait qu'aucun
    enregistrement, meme un ancien refus, n'arrete la captation.
    """
    device = await _make_device(db_session)
    tour = await _make_tour_with_assignment(db_session, test_region, device)
    headers = {"X-Device-ID": device.device_identifier}

    # Aucun accuse de lecture : l'app doit afficher la notice
    resp = await client.get("/api/gdpr/consent/device/gps_information", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["granted"] is None

    gps_payload = {
        "tour_id": tour.id,
        "positions": [{
            "latitude": 50.5, "longitude": 4.5, "accuracy": 5.0, "speed": 60.0,
            "timestamp": "2026-07-08T10:00:00+00:00",
        }],
    }

    # L'ingestion fonctionne avant meme l'accuse de lecture
    resp = await client.post("/api/driver/gps", json=gps_payload, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["inserted"] == 1

    # Le chauffeur accuse reception de la notice / Driver acknowledges the notice
    resp = await client.post(
        "/api/gdpr/consent/device",
        json={"consent_type": "gps_information", "granted": True,
              "subject_name": "Chauffeur Test", "info_version": "2.0-2026-09"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    resp = await client.get("/api/gdpr/consent/device/gps_information", headers=headers)
    assert resp.json()["granted"] is True

    # Un refus enregistre sous l'ANCIEN type ne coupe plus rien /
    # A legacy refusal no longer stops anything
    resp = await client.post(
        "/api/gdpr/consent/device",
        json={"consent_type": "gps_tracking", "granted": False},
        headers=headers,
    )
    assert resp.status_code == 200
    resp = await client.post("/api/driver/gps", json=gps_payload, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["inserted"] == 1, "un ancien opt-out ne doit plus couper l'ingestion"

    # Tracabilite : le journal reste append-only / Journal stays append-only
    resp = await client.get("/api/gdpr/consents/")
    assert resp.status_code == 200
    records = [c for c in resp.json() if c["device_id"] == device.id]
    assert len(records) == 2
    assert {r["consent_type"] for r in records} == {"gps_information", "gps_tracking"}


@pytest.mark.asyncio
async def test_notice_states_legitimate_interest_not_consent(client):
    """La notice doit annoncer la bonne base legale, sinon elle desinforme."""
    resp = await client.get("/api/gdpr/privacy-notice/gps")
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == "2.0-2026-09"
    text = data["text"]
    assert "int" in text and "6.1.f" in text            # intérêt légitime
    assert "L.1222-4" in text                            # information du salarié
    assert "ne repose pas sur votre consentement" in text
    assert "60 jours" in text


@pytest.mark.asyncio
async def test_my_data_export(client, test_user):
    resp = await client.get("/api/gdpr/my-data")
    assert resp.status_code == 200
    data = resp.json()
    assert data["format"].startswith("chaos-route-gdpr-export/")
    assert data["profile"]["username"] == test_user.username
    assert data["profile"]["email"] == test_user.email
    assert "consents" in data
    assert "tours_driven" in data
    assert "activity_log" in data


@pytest.mark.asyncio
async def test_export_driver_unknown_plate(client):
    resp = await client.get("/api/gdpr/export-driver/", params={"license_plate": "1-ZZZ-999"})
    assert resp.status_code == 404
