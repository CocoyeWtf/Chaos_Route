"""Alerte « telephone non rentre sur base » (#99) /
"Phone did not come back to base" alert (#99).

Samuel a demande un suivi permanent des telephones pour ne pas perdre le
materiel. Refuse : le registre des traitements limite la geolocalisation aux
heures de travail, et c'est ce qui fonde l'interet legitime. L'alerte ci-dessous
couvre le besoin sans sortir du cadre — elle regarde la FIN d'une tournee, la
ou le telephone a emis pour la derniere fois.

Les deux pieges a eviter sont testes : alerter un telephone encore sur la route
du retour, et alerter sans savoir (base sans coordonnees, aucune position).
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.delivery_alert import AlertType
from app.services.gps_monitoring import detect_devices_away_from_base

# Base de Gosselies (coordonnees plausibles) et un point a ~12 km
BASE_LAT, BASE_LON = 50.4600, 4.4400
LOIN_LAT, LOIN_LON = 50.5600, 4.4400          # ~11 km au nord
PROCHE_LAT, PROCHE_LON = 50.4610, 4.4410      # ~130 m


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


async def _tournee(
    db_session, test_region, test_pdv, *,
    statut, lat, lon, age_minutes, base_coords=(BASE_LAT, BASE_LON),
):
    from app.models.base_logistics import BaseLogistics
    from app.models.device_assignment import DeviceAssignment
    from app.models.gps_position import GPSPosition
    from app.models.mobile_device import MobileDevice
    from app.models.tour import Tour
    from app.models.tour_stop import TourStop

    jour = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    base = BaseLogistics(
        code=f"B{uuid.uuid4().hex[:5].upper()}", name="Gosselies SEC",
        region_id=test_region.id,
        latitude=base_coords[0], longitude=base_coords[1],
    )
    device = MobileDevice(
        device_identifier=f"dev-{uuid.uuid4().hex[:10]}",
        registration_code=uuid.uuid4().hex[:8].upper(),
        is_active=True, profile="DRIVER", friendly_name="Gosselies 6 - Samuel",
        allowed_features="tours,pickups,declarations",
    )
    db_session.add_all([base, device])
    await db_session.flush()

    tour = Tour(
        date=jour, delivery_date=jour, code=f"T-{uuid.uuid4().hex[:8].upper()}",
        base_id=base.id, status=statut, driver_name="Jean Dupont",
    )
    db_session.add(tour)
    await db_session.flush()
    db_session.add(TourStop(tour_id=tour.id, pdv_id=test_pdv.id, sequence_order=1, eqp_count=5))
    db_session.add(DeviceAssignment(tour_id=tour.id, device_id=device.id, date=jour))
    if lat is not None:
        db_session.add(GPSPosition(
            device_id=device.id, tour_id=tour.id,
            latitude=lat, longitude=lon, accuracy=8.0, speed=0.0,
            timestamp=_iso(datetime.now(timezone.utc) - timedelta(minutes=age_minutes)),
        ))
    await db_session.commit()
    return tour, device


@pytest.mark.asyncio
async def test_telephone_loin_de_la_base_leve_une_alerte(db_session, test_region, test_pdv):
    from app.models.tour import TourStatus

    tour, device = await _tournee(
        db_session, test_region, test_pdv,
        statut=TourStatus.COMPLETED, lat=LOIN_LAT, lon=LOIN_LON, age_minutes=120,
    )
    alertes = await detect_devices_away_from_base(
        db_session, radius_km=3.0, quiet_minutes=45)
    mienne = [a for a in alertes if a.tour_id == tour.id]
    assert len(mienne) == 1
    alerte = mienne[0]
    assert alerte.alert_type == AlertType.DEVICE_NOT_AT_BASE
    assert alerte.device_id == device.id
    # Le message doit nommer l'appareil et chiffrer l'ecart : c'est ce qui rend
    # l'alerte actionnable.
    assert "Gosselies 6 - Samuel" in alerte.message
    assert "km de Gosselies SEC" in alerte.message


@pytest.mark.asyncio
async def test_telephone_rentre_ne_leve_rien(db_session, test_region, test_pdv):
    from app.models.tour import TourStatus

    tour, _ = await _tournee(
        db_session, test_region, test_pdv,
        statut=TourStatus.COMPLETED, lat=PROCHE_LAT, lon=PROCHE_LON, age_minutes=120,
    )
    alertes = await detect_devices_away_from_base(
        db_session, radius_km=3.0, quiet_minutes=45)
    assert [a for a in alertes if a.tour_id == tour.id] == []


@pytest.mark.asyncio
async def test_pas_d_alerte_tant_que_le_telephone_emet(db_session, test_region, test_pdv):
    """Encore sur la route du retour : alerter serait faux."""
    from app.models.tour import TourStatus

    tour, _ = await _tournee(
        db_session, test_region, test_pdv,
        statut=TourStatus.RETURNING, lat=LOIN_LAT, lon=LOIN_LON, age_minutes=5,
    )
    alertes = await detect_devices_away_from_base(
        db_session, radius_km=3.0, quiet_minutes=45)
    assert [a for a in alertes if a.tour_id == tour.id] == []


@pytest.mark.asyncio
async def test_tournee_en_cours_ignoree(db_session, test_region, test_pdv):
    """Une tournee IN_PROGRESS n'est pas censee etre a la base : c'est l'alerte
    NO_GPS qui couvre son silence, pas celle-ci."""
    from app.models.tour import TourStatus

    tour, _ = await _tournee(
        db_session, test_region, test_pdv,
        statut=TourStatus.IN_PROGRESS, lat=LOIN_LAT, lon=LOIN_LON, age_minutes=180,
    )
    alertes = await detect_devices_away_from_base(
        db_session, radius_km=3.0, quiet_minutes=45)
    assert [a for a in alertes if a.tour_id == tour.id] == []


@pytest.mark.asyncio
async def test_base_sans_coordonnees_ne_declenche_rien(db_session, test_region, test_pdv):
    """Sans coordonnees de base, on ne peut rien affirmer — et une alerte non
    fondee userait l'attention de l'exploitation."""
    from app.models.tour import TourStatus

    tour, _ = await _tournee(
        db_session, test_region, test_pdv,
        statut=TourStatus.COMPLETED, lat=LOIN_LAT, lon=LOIN_LON, age_minutes=120,
        base_coords=(None, None),
    )
    alertes = await detect_devices_away_from_base(
        db_session, radius_km=3.0, quiet_minutes=45)
    assert [a for a in alertes if a.tour_id == tour.id] == []


@pytest.mark.asyncio
async def test_aucune_position_ne_declenche_rien(db_session, test_region, test_pdv):
    """Le silence complet est deja couvert par NO_GPS."""
    from app.models.tour import TourStatus

    tour, _ = await _tournee(
        db_session, test_region, test_pdv,
        statut=TourStatus.COMPLETED, lat=None, lon=None, age_minutes=0,
    )
    alertes = await detect_devices_away_from_base(
        db_session, radius_km=3.0, quiet_minutes=45)
    assert [a for a in alertes if a.tour_id == tour.id] == []


@pytest.mark.asyncio
async def test_une_seule_alerte_par_tournee(db_session, test_region, test_pdv):
    """Le detecteur tourne toutes les 5 minutes : il ne doit pas empiler."""
    from app.models.tour import TourStatus

    tour, _ = await _tournee(
        db_session, test_region, test_pdv,
        statut=TourStatus.COMPLETED, lat=LOIN_LAT, lon=LOIN_LON, age_minutes=120,
    )
    premier = await detect_devices_away_from_base(
        db_session, radius_km=3.0, quiet_minutes=45)
    second = await detect_devices_away_from_base(
        db_session, radius_km=3.0, quiet_minutes=45)
    assert len([a for a in premier if a.tour_id == tour.id]) == 1
    assert [a for a in second if a.tour_id == tour.id] == []


@pytest.mark.asyncio
async def test_le_rayon_est_bien_un_parametre(db_session, test_region, test_pdv):
    """Les coordonnees des bases sont approximatives : le seuil doit se regler
    sans toucher au code."""
    from app.models.tour import TourStatus

    tour, _ = await _tournee(
        db_session, test_region, test_pdv,
        statut=TourStatus.COMPLETED, lat=LOIN_LAT, lon=LOIN_LON, age_minutes=120,
    )
    large = await detect_devices_away_from_base(
        db_session, radius_km=50.0, quiet_minutes=45)
    assert [a for a in large if a.tour_id == tour.id] == []
