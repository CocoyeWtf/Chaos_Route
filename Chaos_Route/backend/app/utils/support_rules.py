"""Règles métier sur les types de support de retour / Business rules for return support types.

Contexte tickets #8 et #7/#10 : l'encodage d'un inventaire PDV (retours de consignes)
ne doit accepter qu'un sous-ensemble de types de support. Les casiers à bière (SF 3xxxx)
passent par le flux « consignes » dédié et ne doivent PAS apparaître dans l'inventaire PDV.

Codes autorisés à l'inventaire PDV (retours) :
  - préfixes CO / PA / PL / RE (contenants, palettes, palettes locatives, balles)
  - SF 40040 / SF 40104 / SF 40204 uniquement (caisse plast boucherie, rolls à fleurs)
"""

# Préfixes de code toujours autorisés à l'encodage de retours / Always-allowed prefixes
RETURN_SUPPORT_PREFIXES = ("CO", "PA", "PL", "RE")

# Codes SF explicitement autorisés (les autres SF = casiers bière, exclus) /
# Explicitly allowed SF codes (other SF codes are beer crates, excluded)
RETURN_SUPPORT_SF_CODES = frozenset({"SF40040", "SF40104", "SF40204"})


def _normalize_code(code: str) -> str:
    """Uppercase + suppression des espaces/tirets pour comparaison robuste."""
    return code.upper().replace(" ", "").replace("-", "")


def is_return_support_code(code: str | None) -> bool:
    """True si le code de support est autorisé à l'encodage d'un retour PDV.

    >>> is_return_support_code("PA 22020")
    True
    >>> is_return_support_code("SF 40040")
    True
    >>> is_return_support_code("SF 30100")  # casier bière
    False
    """
    if not code:
        return False
    norm = _normalize_code(code)
    if norm.startswith(RETURN_SUPPORT_PREFIXES):
        return True
    return norm in RETURN_SUPPORT_SF_CODES


# Inférence du type de reprise à partir du préfixe de code /
# Infer pickup type from code prefix (used when an inventory line becomes a pickup request)
#
# Ticket #15, « chacun dans sa bonne catégorie ». Deux corrections par rapport à
# la version précédente, qui rangeait CO, PA ET PL dans CONTAINER et tout SF dans
# CONSIGNMENT :
#   - PL (casiers consignés : Jupiler, Maes, Leffe…) relève des consignes, pas des
#     contenants. Il était en plus absent des filtres d'encodage, ce qui rendait
#     les 20 supports PL impossibles à encoder ;
#   - SF 40040 / 40104 / 40204 (caisse plastique, rolls à fleurs) sont des
#     CONTENANTS — le ticket le dit explicitement — et non des consignes bière.
# Les autres SF (casiers bière 3xxxx) restent en CONSIGNMENT, mais ils n'arrivent
# jamais ici : `is_return_support_code` les refuse en amont. /
# Pickup category from the support code — see ticket #15.
def pickup_type_for_support_code(code: str | None) -> str:
    """Type de reprise (PickupType) déduit du code support pour créer une demande.

    >>> pickup_type_for_support_code("PL 00803")   # casier consigné Jupiler
    'CONSIGNMENT'
    >>> pickup_type_for_support_code("SF 40040")   # caisse plastique = contenant
    'CONTAINER'
    >>> pickup_type_for_support_code("RE 52010")   # balle carton
    'CARDBOARD'
    """
    if not code:
        return "CONTAINER"
    norm = _normalize_code(code)
    if norm.startswith("RE"):
        return "CARDBOARD"
    if norm in RETURN_SUPPORT_SF_CODES:
        return "CONTAINER"
    if norm.startswith("PL") or norm.startswith("SF"):
        return "CONSIGNMENT"
    # CO / PA et défaut
    return "CONTAINER"
