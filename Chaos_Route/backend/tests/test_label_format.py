"""Format d'etiquette de retour PDV (#103) /
PDV return label format (#103).

Deux defauts, prouves en production le 2026-10-09 :

1. le code support porte une espace (« PA 22020 ») qui se retrouvait dans le
   code d'etiquette, alors que le controle de format du scan chauffeur
   n'accepte que lettres et chiffres → 184 etiquettes sur 185 refusees avec
   « Format de code etiquette invalide » ;
2. le code-barres lineaire d'un code de 30 caracteres demande ~1100 dots de
   large pour 576 disponibles : il sortait de l'etiquette a chaque impression.

Les etiquettes deja imprimees circulent : le scan doit continuer a les
accepter. / Labels already printed must keep scanning.
"""

import uuid

import pytest

from app.api.pickup_requests import _generate_label_code, _normalize_code_part
from app.utils.label_templates import (
    CODE_TEXT_CHAR_WIDTH_DOTS, CODE_TEXT_HEIGHT_DOTS, CODE_TEXT_Y_DOTS,
    DOTS_PER_MM, LABEL_HEIGHT_DOTS, LABEL_WIDTH_DOTS, QR_SIZE_DOTS, QR_X_DOTS,
    QR_Y_DOTS, LabelData, _centre, render,
)


def _data(code: str = "RET-01717-PA22020-20261010-002") -> LabelData:
    return LabelData(
        label_code=code, pdv_code="01717", pdv_name="Beyne",
        support_type_code="PA22020", support_type_name="Palette Europe bois",
        pickup_type_label="Contenants", quantity=2, availability_date="2026-10-10",
        sequence_number=2, total_labels=2,
    )


# ─── Format du code / Code format ───

def test_le_code_support_perd_son_espace():
    code = _generate_label_code("01717", "PA 22020", "2026-10-10", 2)
    assert code == "RET-01717-PA22020-20261010-002"
    assert " " not in code


def test_normalisation_robuste():
    assert _normalize_code_part("PA 22020") == "PA22020"
    assert _normalize_code_part("SF-30/400") == "SF30400"
    assert _normalize_code_part("") == ""


def test_le_code_genere_passe_le_controle_du_scan():
    """Le controle cote chauffeur doit accepter ce que la generation produit —
    c'est exactement ce qui manquait."""
    from app.api.driver import _PICKUP_LABEL_CODE_RE, _normalise_label_code

    code = _generate_label_code("01717", "PA 22020", "2026-10-10", 2)
    assert _PICKUP_LABEL_CODE_RE.match(_normalise_label_code(code))


def test_les_anciennes_etiquettes_restent_acceptees():
    """Celles qui sont deja imprimees et qui circulent, avec leur espace."""
    from app.api.driver import _PICKUP_LABEL_CODE_RE, _normalise_label_code

    ancien = "RET-01717-PA 22020-20261010-002"
    assert _PICKUP_LABEL_CODE_RE.match(_normalise_label_code(ancien))
    assert _normalise_label_code(ancien) == "RET-01717-PA22020-20261010-002"
    # Un code lu en minuscules par un lecteur reste reconnu
    assert _normalise_label_code("ret-01717-pa 22020-20261010-002") == \
        "RET-01717-PA22020-20261010-002"


def test_un_code_vraiment_invalide_reste_refuse():
    from app.api.driver import _PICKUP_LABEL_CODE_RE, _normalise_label_code

    for mauvais in ("RM-123456", "bonjour", "RET-01717-PA22020-2026-002", ""):
        assert not _PICKUP_LABEL_CODE_RE.match(_normalise_label_code(mauvais))


# ─── Rendu de l'etiquette / Label rendering ───

def test_zpl_imprime_un_qr_et_plus_de_code_barres_lineaire():
    zpl = render("ZPL", _data())
    assert "^BQN" in zpl, "le QR doit etre present"
    assert "^BC" not in zpl, "le code 128 doit avoir disparu (il sortait de l'etiquette)"
    assert "RET-01717-PA22020-20261010-002" in zpl


def test_tspl_imprime_un_qr_et_plus_de_code_barres_lineaire():
    tspl = render("TSPL", _data())
    assert "QRCODE" in tspl
    assert 'BARCODE' not in tspl
    assert "RET-01717-PA22020-20261010-002" in tspl


def test_le_qr_tient_dans_la_largeur_de_l_etiquette():
    """La regression a eviter : un code machine plus large que l'etiquette."""
    assert QR_X_DOTS >= 0
    assert QR_X_DOTS + QR_SIZE_DOTS <= LABEL_WIDTH_DOTS


def test_le_code_en_clair_est_imprime_en_entier():
    """Le recours quand le QR est abime : il ne doit pas etre tronque non plus.
    Sur le papier incrimine, il s'arretait a « RET-01717-PA 22000-2 »."""
    code = "RET-01717-PA22020-20261010-002"
    zpl = render("ZPL", _data(code))
    # Deux occurrences : la donnee du QR, et la ligne lisible
    assert zpl.count(code) == 2
    # Centre par calcul, pas par ^FB : l'emulation des Brother RJ ne l'a pas
    # rendu comme Zebra et le texte s'est imprime sur le QR (#103, reouvert).
    assert "^FB" not in zpl
    assert "^FO%d,%d" % (_centre(len(code), CODE_TEXT_CHAR_WIDTH_DOTS), CODE_TEXT_Y_DOTS) in zpl


def test_le_code_en_clair_ne_chevauche_pas_le_qr():
    """La regression exacte signalee par le terrain : le code imprime PAR-DESSUS
    le symbole. La place reservee doit couvrir le pire cas de version QR."""
    assert CODE_TEXT_Y_DOTS >= QR_Y_DOTS + QR_SIZE_DOTS + 20
    assert CODE_TEXT_Y_DOTS + CODE_TEXT_HEIGHT_DOTS <= LABEL_HEIGHT_DOTS
    # Et le code en clair doit tenir dans la largeur
    assert 31 * CODE_TEXT_CHAR_WIDTH_DOTS <= LABEL_WIDTH_DOTS


def test_le_qr_est_assez_grand_pour_etre_lu_de_loin():
    """Samuel : « le QR a l'air petit ». 30 mm de cote minimum."""
    assert QR_SIZE_DOTS / DOTS_PER_MM >= 30


@pytest.mark.asyncio
async def test_le_scan_retrouve_une_etiquette_imprimee_avec_espace(client, db_session, test_pdv):
    """Bout en bout : une etiquette d'avant le correctif, scannee telle qu'elle
    est imprimee, doit etre retrouvee."""
    from app.models.mobile_device import MobileDevice
    from app.models.pickup_request import (
        LabelStatus, PickupLabel, PickupRequest, PickupStatus, PickupType,
    )

    device = MobileDevice(
        device_identifier=f"dev-{uuid.uuid4().hex[:10]}",
        registration_code=uuid.uuid4().hex[:8].upper(),
        is_active=True, profile="DRIVER",
        allowed_features="tours,pickups,declarations",
    )
    req = PickupRequest(
        pdv_id=test_pdv.id, quantity=1, availability_date="2026-10-10",
        pickup_type=PickupType.CONTAINER, status=PickupStatus.REQUESTED,
    )
    db_session.add_all([device, req])
    await db_session.flush()
    ancien_code = "RET-01717-PA 22020-20261010-009"
    db_session.add(PickupLabel(
        pickup_request_id=req.id, label_code=ancien_code,
        sequence_number=9, status=LabelStatus.PENDING,
    ))
    await db_session.commit()

    from urllib.parse import quote

    resp = await client.post(
        f"/api/driver/pickup-labels/{quote(ancien_code)}/scan",
        headers={"X-Device-ID": device.device_identifier},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["label_code"] == ancien_code

    # Et la meme etiquette scannee sans l'espace (lecteur qui le supprime)
    # doit mener a la meme ligne. / Same label, space-less reading.
    resp = await client.post(
        f"/api/driver/pickup-labels/{quote(ancien_code.replace(' ', ''))}/scan",
        headers={"X-Device-ID": device.device_identifier},
    )
    assert resp.status_code in (200, 400), resp.text
    if resp.status_code == 400:
        # Deja PICKED_UP par le scan precedent : c'est bien la meme etiquette.
        assert "deja" in resp.json()["detail"].lower() or "picked" in resp.json()["detail"].lower()
