"""Ticket #34 : format de la date dans l'export TMS vers WMS.

La colonne E sortait en horodatage — « 2026-08-13 0:00:00 » — alors que la macro
d'encodage Infolog attend une date nue, affichée JJ-MM-AA. Le reste du fichier
était correct, seule la cellule de date posait problème.
"""

import io
import uuid
from datetime import date as date_type

import pytest
from openpyxl import load_workbook

PLANIF = "2026-08-13"
LIVRAISON = "2026-08-14"


async def _fixture(db_session, region_id, priority=None):
    from app.models.base_logistics import BaseLogistics
    from app.models.pdv import PDV, PDVType
    from app.models.tour import Tour, TourStatus
    from app.models.tour_stop import TourStop

    base = BaseLogistics(code=f"B{uuid.uuid4().hex[:5].upper()}", name="Base #34", region_id=region_id)
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)

    code = f"P{uuid.uuid4().hex[:5].upper()}"
    pdv = PDV(code=code, name=f"PDV {code}", type=PDVType.HYPER, region_id=region_id)
    db_session.add(pdv)
    await db_session.commit()
    await db_session.refresh(pdv)

    tour = Tour(
        date=PLANIF, delivery_date=LIVRAISON, code=f"T-{uuid.uuid4().hex[:8]}",
        base_id=base.id, status=TourStatus.VALIDATED, departure_time="06:00",
        priority=priority,
    )
    db_session.add(tour)
    await db_session.flush()
    db_session.add(TourStop(tour_id=tour.id, pdv_id=pdv.id, sequence_order=1, eqp_count=10))
    await db_session.commit()
    return base.id, pdv.code


@pytest.mark.asyncio
async def test_date_livraison_est_une_date_au_format_jjmmaa(client, db_session, test_region):
    """Le cœur du #34 : une date, pas un horodatage, et au bon format."""
    base_id, pdv_code = await _fixture(db_session, test_region.id)

    resp = await client.get("/api/exports/wms-infolog", params={"date": PLANIF, "base_id": base_id})
    assert resp.status_code == 200, resp.text

    ws = load_workbook(io.BytesIO(resp.content)).active
    ligne = next(r for r in range(1, ws.max_row + 1) if ws.cell(r, 2).value == pdv_code)
    cellule = ws.cell(ligne, 5)

    valeur = cellule.value
    assert isinstance(valeur, date_type), f"attendu une date, reçu {type(valeur)}"
    # Une date nue : pas de composante horaire résiduelle
    assert getattr(valeur, "hour", 0) == 0 and getattr(valeur, "minute", 0) == 0
    assert valeur.isoformat().startswith(LIVRAISON)
    assert cellule.number_format == "DD-MM-YY"


@pytest.mark.asyncio
async def test_priorite_decimale_sort_en_nombre(client, db_session, test_region):
    """La priorité est décimale depuis le #29 : elle doit sortir en NOMBRE."""
    base_id, pdv_code = await _fixture(db_session, test_region.id, priority=2.5)

    resp = await client.get("/api/exports/wms-infolog", params={"date": PLANIF, "base_id": base_id})
    assert resp.status_code == 200, resp.text

    ws = load_workbook(io.BytesIO(resp.content)).active
    ligne = next(r for r in range(1, ws.max_row + 1) if ws.cell(r, 2).value == pdv_code)
    ordre = ws.cell(ligne, 1).value
    assert isinstance(ordre, (int, float)), f"attendu un nombre, reçu {type(ordre)}"
    assert float(ordre) == 2.5
