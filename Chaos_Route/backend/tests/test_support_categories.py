"""Ticket #15 : « chacun dans sa bonne catégorie ».

Le périmètre des retours (CO/PA/PL/RE + SF 40040/40104/40204) était bien filtré
depuis août, mais la catégorisation était fausse, et les écrans d'encodage — web
comme tablette — s'appuyaient sur une table de préfixes qui ignorait « PL ».
Conséquence mesurée en production : sur 42 supports retournables, 22 seulement
étaient atteignables, et les 20 casiers consignés (Jupiler, Maes, Leffe, Duvel,
Chimay, Grimbergen) ne pouvaient être encodés par aucune catégorie. Zéro demande
de reprise n'existait sur un support PL, ce qui confirmait le blocage.

Les SF 40040 / 40104 / 40204 sont par ailleurs des CONTENANTS — le ticket le dit
explicitement — et non des consignes bière.
"""

import pytest

from app.utils.support_rules import is_return_support_code, pickup_type_for_support_code


@pytest.mark.parametrize(
    "code,categorie",
    [
        ("CO 11010", "CONTAINER"),      # contenants (combis, rolls)
        ("PA 24010", "CONTAINER"),      # palettes, présentées avec les contenants
        ("PL 00803", "CONSIGNMENT"),    # casier consigné Jupiler — le cœur du ticket
        ("PL 00820", "CONSIGNMENT"),
        ("RE 52010", "CARDBOARD"),      # balle carton
        ("SF 40040", "CONTAINER"),      # caisse plastique = contenant, pas une consigne
        ("SF 40104", "CONTAINER"),      # roll à fleurs
        ("SF 40204", "CONTAINER"),
        ("SF 30100", "CONSIGNMENT"),    # casier bière : hors périmètre retour de toute façon
    ],
)
def test_categorie_par_code(code, categorie):
    assert pickup_type_for_support_code(code) == categorie


def test_perimetre_retour_inchange():
    """Le filtre d'août reste tel quel : on ne corrige que la catégorie."""
    for code in ("CO 11010", "PA 24010", "PL 00803", "RE 52010", "SF 40040", "SF 40104", "SF 40204"):
        assert is_return_support_code(code), code
    for code in ("SF 30100", "SF 30101", "41001"):
        assert not is_return_support_code(code), code


def test_casiers_consignes_atteignables():
    """Chaque support retournable tombe dans une catégorie proposée à l'encodage.

    C'est la garantie qui manquait : un support autorisé par le serveur mais
    rangé dans aucune catégorie de l'écran est invisible, donc inencodable.
    """
    categories_ecran = {"CONTAINER", "CARDBOARD", "CONSIGNMENT"}
    codes = [
        "CO 11010", "PA 24010", "PA 28020",
        "PL 00801", "PL 00803", "PL 00819",
        "RE 52010", "RE 52020",
        "SF 40040", "SF 40104", "SF 40204",
    ]
    for code in codes:
        assert is_return_support_code(code)
        assert pickup_type_for_support_code(code) in categories_ecran, code


def test_normalisation_robuste():
    """Espaces et casse ne doivent pas changer la catégorie."""
    assert pickup_type_for_support_code("pl00803") == "CONSIGNMENT"
    assert pickup_type_for_support_code("sf 40040") == "CONTAINER"
    assert pickup_type_for_support_code("SF-40040") == "CONTAINER"
