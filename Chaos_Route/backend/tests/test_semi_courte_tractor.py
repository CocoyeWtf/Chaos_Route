"""#122 — Chauffeur « Base » sur une semi courte : aucun tracteur proposé.

`VEHICLE_TYPE_TO_FLEET` ignorait SEMI_COURTE et le tracteur n'était ajouté que
pour SEMI : la liste du mode propre restait vide, la tournée impossible à
planifier en interne.
"""

import uuid

import pytest


@pytest.mark.asyncio
async def test_semi_courte_offers_tractor_and_trailer(client, db_session, test_region):
    from app.models.base_logistics import BaseLogistics
    from app.models.vehicle import Vehicle, FleetVehicleType, VehicleStatus

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5]}", name="Base", region_id=test_region.id)
    tractor = Vehicle(code=f"TR{uuid.uuid4().hex[:5]}", fleet_vehicle_type=FleetVehicleType.TRACTEUR,
                      status=VehicleStatus.ACTIVE, region_id=test_region.id)
    trailer = Vehicle(code=f"SR{uuid.uuid4().hex[:5]}", fleet_vehicle_type=FleetVehicleType.SEMI_REMORQUE,
                      status=VehicleStatus.ACTIVE, region_id=test_region.id)
    db_session.add_all([base, tractor, trailer])
    await db_session.commit()

    resp = await client.get("/api/tours/available-vehicles", params={
        "date": "2026-11-20", "base_id": base.id, "vehicle_type": "SEMI_COURTE",
    })
    assert resp.status_code == 200, resp.text
    codes = {v["code"]: v["is_tractor"] for v in resp.json()}
    assert codes.get(tractor.code) is True
    assert codes.get(trailer.code) is False
