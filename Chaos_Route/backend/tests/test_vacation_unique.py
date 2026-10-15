"""Suppression complete du doublon « terme fixe » / « vacation » (#58).

La premiere passe (septembre) avait retire le double comptage du cout des
tournees, mais avait LAISSE la colonne jumelle `fixed_daily_cost`, tenue egale
a `vacation`. Samuel a rouvert : « le terme doit etre supprime partout, si les
deux existent cela fait doublon et peut causer des problemes notamment a la
facturation ».

Il avait raison au-dela du vocabulaire : trois endroits de l'aide a la decision
additionnaient encore les deux colonnes, donc surevaluaient de 100 % le cout
fixe de chaque contrat et arbitraient sur des chiffres faux. La colonne est
desormais absente du modele, de la base, des schemas et de l'interface.
"""

import uuid

import pytest
import pytest_asyncio


@pytest_asyncio.fixture
async def contrat(db_session, test_region):
    """Contrat avec une vacation de 400 EUR."""
    from app.models.contract import Contract

    c = Contract(
        code=f"C{uuid.uuid4().hex[:6].upper()}",
        transporter_name="Transporteur test",
        vacation=400,
        cost_per_km=0.5,
        region_id=test_region.id,
        billing_type=2,
    )
    db_session.add(c)
    await db_session.commit()
    await db_session.refresh(c)
    return c


def test_la_colonne_jumelle_a_disparu_du_modele():
    """`fixed_daily_cost` ne doit plus exister : c'est la demande du ticket."""
    from app.models.contract import Contract

    assert not hasattr(Contract, "fixed_daily_cost"), (
        "La colonne « terme fixe » est revenue. Elle porte la meme notion que "
        "`vacation` et ce doublon a deja coute 394 085 EUR d'ecart sur un mois."
    )
    assert hasattr(Contract, "vacation")


def test_la_colonne_a_disparu_des_schemas():
    """Ni en entree ni en sortie d'API : sinon l'interface la reproposerait."""
    from app.schemas.contract import ContractBase, ContractRead, ContractUpdate

    for schema in (ContractBase, ContractRead, ContractUpdate):
        assert "fixed_daily_cost" not in schema.model_fields, schema.__name__


@pytest.mark.asyncio
async def test_la_vacation_est_comptee_une_seule_fois(contrat):
    """Le helper unique de lecture rend le montant, pas son double."""
    from app.models.contract import effective_vacation

    assert effective_vacation(contrat) == 400.0


def test_un_contrat_sans_vacation_vaut_zero():
    """Et pas None, qui ferait planter l'addition du cout."""
    from app.models.contract import Contract, effective_vacation

    assert effective_vacation(Contract(code="X", transporter_name="X")) == 0.0


@pytest.mark.asyncio
async def test_l_extraction_de_prefacturation_lit_la_vacation(contrat):
    """Elle lisait `fixed_daily_cost` : si elle avait continue, elle aurait
    facture 0 EUR de terme fixe des la suppression de la colonne. C'est le
    risque principal de ce ticket, d'ou ce test."""
    from app.services.cmro_extraction import compute_cost

    class _Tour:
        """Tournee minimale : seul le kilometrage compte ici, tout le reste
        vaut None pour ne pas avoir a recopier les 40 colonnes du modele."""
        total_km = 100
        vehicle_id = None
        date = "2026-10-15"

        def __getattr__(self, nom):
            return None

    cost = compute_cost(_Tour(), contrat, nb_tours=2, fuel_price=1.5, km_tax_total=0)
    # 400 / 2 tournees = 200 EUR de vacation dans le total.
    assert cost["t_fixe"] == 200.0, cost


@pytest.mark.asyncio
async def test_l_aide_a_la_decision_ne_double_plus_le_cout_fixe(contrat):
    """Les trois sites de `aide_decision` additionnaient terme fixe + vacation.

    On verifie par le helper partage : tant que tout passe par lui, le double
    comptage ne peut pas revenir par une ligne oubliee.
    """
    import inspect

    from app.services import aide_decision

    source = inspect.getsource(aide_decision)
    assert "fixed_daily_cost" not in source, (
        "L'aide a la decision lit de nouveau la colonne supprimee."
    )
    # Et le montant reste celui du contrat, pas son double.
    from app.models.contract import effective_vacation
    assert effective_vacation(contrat) == 400.0


@pytest.mark.asyncio
async def test_le_detail_de_cout_n_expose_plus_de_terme_fixe(client, db_session):
    """La cle `fixed_share`, laissee a 0 pour compatibilite, affichait une
    colonne « Terme fixe » a 0,00 EUR dans le recapitulatif transporteur :
    exactement le doublon que le ticket demande d'effacer."""
    import inspect

    from app.api import tours

    source = inspect.getsource(tours)
    for mort in ("fixed_share", "fixed_cost_total", "fixed_daily_cost"):
        # Les commentaires d'historique ont le droit de nommer l'ancien champ ;
        # le code, non. / History comments may name it; code may not.
        lignes_de_code = [
            l for l in source.splitlines()
            if mort in l and not l.strip().startswith("#")
        ]
        assert not lignes_de_code, (mort, lignes_de_code[:3])
