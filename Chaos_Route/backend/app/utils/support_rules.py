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
def pickup_type_for_support_code(code: str | None) -> str:
    """Type de reprise (PickupType) déduit du code support pour créer une demande."""
    if not code:
        return "CONTAINER"
    norm = _normalize_code(code)
    if norm.startswith("RE"):
        return "CARDBOARD"
    if norm.startswith("SF"):
        return "CONSIGNMENT"
    # CO / PA / PL et défaut
    return "CONTAINER"
