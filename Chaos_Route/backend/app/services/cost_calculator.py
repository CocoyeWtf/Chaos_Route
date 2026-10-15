"""
Service de calcul des coûts / Cost calculation service.
Calcule le coût d'un tour basé sur le contrat transporteur.
"""

from decimal import Decimal


class CostCalculatorService:
    """Calcul des coûts de tournée / Tour cost calculation."""

    @staticmethod
    def calculate_tour_cost(
        total_km: float,
        vacation: float,
        cost_per_km: float,
        cost_per_hour: float | None = None,
        total_hours: float | None = None,
    ) -> float:
        """
        Calculer le coût d'un tour / Calculate tour cost.
        Règle: 1 vacation par jour par transporteur (même si multi-tours) (#58).
        Rule: 1 vacation per day per transporter (even if multi-tours).
        """
        cost = vacation + (total_km * cost_per_km)
        if cost_per_hour and total_hours:
            cost += total_hours * cost_per_hour
        return round(cost, 2)
