"""Templates d'impression d'etiquettes pour imprimantes thermiques portables /
Label print templates for portable thermal printers.

Cible : imprimantes 72 mm de large (3 pouces) a 203 dpi.
Format : 72x100 mm = 576x800 dots (203 dpi).
Protocoles supportes : ZPL (Zebra) et TSPL (TSC).

Le code machine est un QR CODE, pas un code-barres lineaire (ticket #103).
Un code d'etiquette fait 30 a 31 caracteres ; en Code 128 a la densite minimale
lisible par un appareil photo de telephone, cela demande environ 1100 dots de
large alors que l'etiquette n'en offre que 576. Le code-barres sortait donc de
l'etiquette a chaque impression — constate en production, bandes coupees et
ligne lisible tronquee a « RET-01717-PA 22000-2 ». Baisser la densite pour le
faire tenir l'aurait rendu illisible : c'est la forme du code qu'il fallait
changer, pas son cadrage. Le meme code en QR tient dans 37 mm de cote, et
l'application chauffeur lit deja le QR partout ou elle scanne une etiquette
(c'est aussi ce qu'imprime deja le poste de travail web).

Si un lecteur laser 1D devait un jour etre utilise a la base, il faudrait
revenir a un code lineaire IMPRIME A LA VERTICALE (800 dots de hauteur
disponibles) : un appareil photo s'en sort, un laser 1D ne lit pas un QR.

Target: 72 mm (3 inch) portable printers at 203 dpi.
Format: 72x100 mm = 576x800 dots (203 dpi).
Supported protocols: ZPL (Zebra) and TSPL (TSC).

Cote mobile, on envoie la chaine retournee ici en RAW au socket Bluetooth SPP
de l'imprimante. Pas de rendering local cote app.

The mobile side sends the returned string as RAW data to the printer's
Bluetooth SPP socket. No local rendering on the app side.
"""

from __future__ import annotations

from dataclasses import dataclass

# Constantes format / Format constants
LABEL_WIDTH_MM = 72
LABEL_HEIGHT_MM = 100
DPI = 203
DOTS_PER_MM = DPI / 25.4  # ~8 dots/mm
LABEL_WIDTH_DOTS = int(LABEL_WIDTH_MM * DOTS_PER_MM)   # ~576
LABEL_HEIGHT_DOTS = int(LABEL_HEIGHT_MM * DOTS_PER_MM)  # ~800

# QR code (#103). Selon le mode d'encodage retenu par l'imprimante, un code de
# 30-31 caracteres tient dans un QR version 2, 3 ou 4 — et c'est precisement le
# piege : ON NE CHOISIT PAS la version, l'encodeur la deduit des donnees. La
# premiere mouture reservait la place d'un version 3 (29 modules) et posait le
# code en clair 10 dots en dessous ; sur le terrain le symbole est sorti plus
# grand que prevu et le texte s'est imprime PAR-DESSUS le QR. On dimensionne
# donc sur le pire cas raisonnable (version 4, 33 modules) et on laisse une
# vraie respiration sous le symbole. /
# The encoder picks the QR version, not us: reserve the worst case.
QR_MODULES_MAX = 33          # version 4 — marge sur le pire cas
QR_MAGNIFICATION = 9         # 33 x 9 = 297 dots, soit ~37 mm de cote
QR_SIZE_DOTS = QR_MODULES_MAX * QR_MAGNIFICATION
QR_X_DOTS = (LABEL_WIDTH_DOTS - QR_SIZE_DOTS) // 2      # centre horizontalement
QR_Y_DOTS = 372
# Respiration sous le QR avant le code en clair / Breathing room below the QR
QR_TEXT_GAP_DOTS = 22
CODE_TEXT_Y_DOTS = QR_Y_DOTS + QR_SIZE_DOTS + QR_TEXT_GAP_DOTS
# Police du code en clair : largeur fixee, pour centrer par calcul sans
# dependre du bloc de texte ZPL (^FB) — que l'emulation ZPL des Brother RJ ne
# traite visiblement pas comme Zebra. / Fixed width so we centre by hand.
CODE_TEXT_HEIGHT_DOTS = 26
CODE_TEXT_CHAR_WIDTH_DOTS = 17


def _centre(nb_caracteres: int, largeur_police: int) -> int:
    """Abscisse pour centrer un texte a la main / X offset to centre text.

    Vaut pour les deux protocoles : TSPL n'a pas de bloc centre, et le ^FB de
    ZPL n'a pas donne le resultat attendu sur l'emulation des Brother RJ — le
    code en clair s'est retrouve imprime par-dessus le QR. La position est donc
    calculee, elle ne depend plus de l'interpretation de l'imprimante. Jamais
    negative, sinon le champ est ignore. /
    Compute the offset instead of trusting ^FB.
    """
    return max(0, (LABEL_WIDTH_DOTS - nb_caracteres * largeur_police) // 2)


@dataclass(frozen=True)
class LabelData:
    """Donnees a imprimer sur une etiquette / Data to print on a label."""
    label_code: str          # ex: RET-02805-CO-20260522-001
    pdv_code: str            # ex: 02805
    pdv_name: str
    support_type_code: str   # ex: CO, PA, RE
    support_type_name: str   # ex: Combi, Palette Europe
    pickup_type_label: str   # ex: "Contenants", "Balles carton"
    quantity: int            # quantite declaree (pour combi = stock absolu)
    availability_date: str   # YYYY-MM-DD
    sequence_number: int     # 1-based, position de l'etiquette dans la demande
    total_labels: int        # nb total d'etiquettes de la demande
    is_combi: bool = False   # si True, presentation specifique combi


def _escape_zpl(text: str) -> str:
    """Echapper les caracteres speciaux ZPL / Escape ZPL special characters.
    ^ et ~ sont des delimiteurs de commande, on les remplace par leur equivalent.
    """
    return text.replace("^", " ").replace("~", " ")


def _truncate(text: str, max_len: int) -> str:
    """Tronquer en ajoutant ... si necessaire / Truncate with ellipsis if needed."""
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "."


def render_zpl(data: LabelData) -> str:
    """Generer une etiquette au format ZPL II (Zebra) /
    Generate a label in ZPL II format (Zebra).

    Layout 576x800 dots, marges 20 dots :
    - Header : code PDV + nom (gros)
    - Type de reprise / support
    - Quantite (ou "STOCK COMBI : X" si is_combi)
    - Date dispo
    - QR code (label_code), centre
    - Footer : label_code en clair, centre, SOUS le QR (le rang n/N figure deja
      sur la ligne quantite)
    """
    pdv_code = _escape_zpl(data.pdv_code)
    pdv_name = _truncate(_escape_zpl(data.pdv_name), 28)
    support = _truncate(_escape_zpl(data.support_type_name), 28)
    pickup_type = _escape_zpl(data.pickup_type_label)
    label_code = _escape_zpl(data.label_code)

    qty_line = (
        f"STOCK COMBI: {data.quantity}"
        if data.is_combi
        else f"QTE: {data.quantity}    ({data.sequence_number}/{data.total_labels})"
    )

    # ZPL II : ^XA debut, ^XZ fin
    # ^FOx,y position, ^A0N,h,w police, ^FD donnees, ^FS fin de champ
    # ^BCN,h,Y,N,N : code 128 hauteur h, texte sous le code
    # ^PW largeur de l'etiquette en dots
    # ^LL longueur de l'etiquette en dots
    zpl = (
        "^XA"
        f"^PW{LABEL_WIDTH_DOTS}"
        f"^LL{LABEL_HEIGHT_DOTS}"
        "^CI28"  # Encoding UTF-8
        "^LH0,0"
        # Code PDV (tres gros) / PDV code (very large)
        f"^FO30,24^A0N,80,80^FD{pdv_code}^FS"
        # Nom PDV / PDV name
        f"^FO30,110^A0N,32,32^FD{pdv_name}^FS"
        # Separateur / Separator
        "^FO20,156^GB536,3,3^FS"
        # Type de reprise / Pickup type
        f"^FO30,172^A0N,28,28^FD{pickup_type}^FS"
        # Support / Support type
        f"^FO30,208^A0N,40,40^FD{support}^FS"
        # Quantite / Quantity — porte deja le rang n/N de l'etiquette
        f"^FO30,262^A0N,40,40^FD{qty_line}^FS"
        # Date dispo / Availability date
        f"^FO30,318^A0N,28,28^FDDispo: {data.availability_date}^FS"
        # Separateur / Separator
        f"^FO20,{QR_Y_DOTS - 16}^GB536,3,3^FS"
        # QR code centre (#103) / Centred QR code
        # ^BQN,2,<grossissement> : modele 2, 9 dots par module. ^FDMA, =
        # correction M, saisie automatique. / Model 2, 9 dots per module.
        f"^FO{QR_X_DOTS},{QR_Y_DOTS}^BQN,2,{QR_MAGNIFICATION}^FDMA,{label_code}^FS"
        # Code en clair SOUS le QR, centre par calcul : c'est le recours quand
        # le symbole est abime, il ne doit etre ni tronque ni superpose. /
        # Human-readable fallback below the QR, centred by computation.
        f"^FO{_centre(len(label_code), CODE_TEXT_CHAR_WIDTH_DOTS)},{CODE_TEXT_Y_DOTS}"
        f"^A0N,{CODE_TEXT_HEIGHT_DOTS},{CODE_TEXT_CHAR_WIDTH_DOTS}^FD{label_code}^FS"
        "^XZ"
    )
    return zpl


def render_tspl(data: LabelData) -> str:
    """Generer une etiquette au format TSPL (TSC) /
    Generate a label in TSPL format (TSC).

    TSPL commandes principales :
    - SIZE largeur,hauteur (en mm)
    - GAP gap,offset (en mm)
    - CLS efface buffer
    - TEXT x,y,"font",rotation,xmul,ymul,"data"
    - BARCODE x,y,"type",hauteur,human_readable,rotation,wide,narrow,"data"
    - PRINT 1
    """
    pdv_code = _escape_zpl(data.pdv_code)  # meme echappement basique
    pdv_name = _truncate(_escape_zpl(data.pdv_name), 28)
    support = _truncate(_escape_zpl(data.support_type_name), 28)
    pickup_type = _escape_zpl(data.pickup_type_label)
    label_code = _escape_zpl(data.label_code)

    qty_line = (
        f"STOCK COMBI: {data.quantity}"
        if data.is_combi
        else f"QTE: {data.quantity}    ({data.sequence_number}/{data.total_labels})"
    )

    # TSPL fontes : "0" mono ~12x20, "3" 16x24, "4" 24x32, "5" 32x48, "6" 14x19, "8" 14x22
    tspl = (
        f"SIZE {LABEL_WIDTH_MM} mm, {LABEL_HEIGHT_MM} mm\r\n"
        "GAP 2 mm, 0 mm\r\n"
        "DIRECTION 1\r\n"
        "CLS\r\n"
        # Code PDV (font 5 = grand) / PDV code (font 5 = large)
        f'TEXT 30,24,"5",0,2,2,"{pdv_code}"\r\n'
        # Nom PDV / PDV name
        f'TEXT 30,110,"3",0,1,1,"{pdv_name}"\r\n'
        # Separateur / Separator
        "BAR 20,156,536,3\r\n"
        # Type de reprise / Pickup type
        f'TEXT 30,172,"3",0,1,1,"{pickup_type}"\r\n'
        # Support / Support type
        f'TEXT 30,208,"4",0,1,1,"{support}"\r\n'
        # Quantite / Quantity — porte deja le rang n/N de l'etiquette
        f'TEXT 30,262,"4",0,1,1,"{qty_line}"\r\n'
        # Date dispo / Availability date
        f'TEXT 30,318,"3",0,1,1,"Dispo: {data.availability_date}"\r\n'
        # Separateur / Separator
        f"BAR 20,{QR_Y_DOTS - 16},536,3\r\n"
        # QR code centre (#103) / Centred QR code
        # QRCODE x,y,correction,taille_cellule,mode,rotation,"contenu"
        f'QRCODE {QR_X_DOTS},{QR_Y_DOTS},M,{QR_MAGNIFICATION},A,0,"{label_code}"\r\n'
        # Code en clair SOUS le QR, centre par calcul : police "3" = 16 dots de
        # large par caractere a l'echelle 1. / Human-readable fallback below.
        f'TEXT {_centre(len(label_code), 16)},{CODE_TEXT_Y_DOTS},"3",0,1,1,"{label_code}"\r\n'
        "PRINT 1\r\n"
    )
    return tspl


def render(protocol: str, data: LabelData) -> str:
    """Dispatcher selon le protocole / Dispatch by protocol.

    Raises:
        ValueError: si protocole inconnu / if unknown protocol.
    """
    p = protocol.upper()
    if p == "ZPL":
        return render_zpl(data)
    if p == "TSPL":
        return render_tspl(data)
    raise ValueError(f"Protocole non supporte: {protocol}")
