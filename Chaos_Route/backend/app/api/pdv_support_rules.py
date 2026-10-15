"""Routes visibilite des supports par PDV / Per-PDV support visibility routes (#105).

Le PDV 01717 encode ses retours sur 16 types de support alors que l'app lui en
propose 41, dont 20 casiers biere qu'il ne retourne jamais. Ces routes pilotent
ce que chaque magasin voit, sans toucher a ce qu'il a le droit de reprendre.

Pas de matrice complete ici, contrairement a `base_support_rules` : 170 PDV x 41
supports font 7 000 cases. On travaille PDV par PDV, avec une copie en masse
pour ne pas avoir a repeter le meme reglage sur une enseigne entiere.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_permission
from app.database import get_db
from app.models.pdv import PDV
from app.models.pdv_support_rule import PdvSupportRule
from app.models.support_type import SupportType
from app.models.user import User
from app.utils.support_rules import is_return_support_code

router = APIRouter()


class SupportVisibility(BaseModel):
    """Un reglage de visibilite / One visibility setting."""
    support_type_id: int
    visible: bool


class BulkVisibilityRequest(BaseModel):
    """Reglages d'un PDV en un seul envoi / One PDV's settings in a single call."""
    items: list[SupportVisibility] = Field(default_factory=list)


class CopyRequest(BaseModel):
    """Recopier la configuration d'un PDV vers d'autres / Copy one PDV's setup."""
    target_pdv_ids: list[int] = Field(min_length=1)


async def _returnable_support_types(db: AsyncSession) -> list[SupportType]:
    """Les supports que l'app PDV peut proposer / Supports the PDV app may offer.

    Meme perimetre que `_pickup_form_data` : actifs ET retournables. Masquer un
    casier biere SF 3xxxx n'aurait aucun sens, il n'est deja pas propose.
    """
    result = await db.execute(
        select(SupportType)
        .where(SupportType.is_active == True)  # noqa: E712
        .order_by(SupportType.code)
    )
    return [st for st in result.scalars().all() if is_return_support_code(st.code)]


async def _rules_for(db: AsyncSession, pdv_id: int) -> dict[int, bool]:
    """Regles stockees d'un PDV / A PDV's stored rules, by support_type_id."""
    result = await db.execute(
        select(PdvSupportRule).where(PdvSupportRule.pdv_id == pdv_id)
    )
    return {r.support_type_id: r.visible for r in result.scalars().all()}


async def hidden_support_ids(db: AsyncSession, pdv_id: int | None) -> set[int]:
    """Supports masques pour ce PDV / Supports hidden for this PDV.

    Helper partage avec le formulaire de reprise. `pdv_id` nul (back-office qui
    n'est rattache a aucun magasin) → aucun masquage.
    """
    if pdv_id is None:
        return set()
    result = await db.execute(
        select(PdvSupportRule.support_type_id).where(
            PdvSupportRule.pdv_id == pdv_id,
            PdvSupportRule.visible == False,  # noqa: E712
        )
    )
    return set(result.scalars().all())


@router.get("/pdvs")
async def list_configurable_pdvs(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support-types", "read")),
):
    """PDV configurables, avec le nombre de supports masques / PDVs with hidden counts.

    Le compteur evite d'avoir a ouvrir chaque magasin pour savoir lesquels ont
    ete regles.
    """
    pdv_result = await db.execute(select(PDV).order_by(PDV.code))
    pdvs = pdv_result.scalars().all()

    rules_result = await db.execute(
        select(PdvSupportRule).where(PdvSupportRule.visible == False)  # noqa: E712
    )
    hidden_count: dict[int, int] = {}
    for rule in rules_result.scalars().all():
        hidden_count[rule.pdv_id] = hidden_count.get(rule.pdv_id, 0) + 1

    return [
        {
            "id": p.id,
            "code": p.code,
            "name": p.name,
            "hidden_count": hidden_count.get(p.id, 0),
        }
        for p in pdvs
    ]


@router.get("/{pdv_id}")
async def get_pdv_rules(
    pdv_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support-types", "read")),
):
    """Supports retournables d'un PDV avec leur visibilite / A PDV's supports and visibility."""
    pdv = await db.get(PDV, pdv_id)
    if not pdv:
        raise HTTPException(status_code=404, detail="PDV introuvable")

    supports = await _returnable_support_types(db)
    rules = await _rules_for(db, pdv_id)

    return {
        "pdv": {"id": pdv.id, "code": pdv.code, "name": pdv.name},
        "support_types": [
            {
                "id": st.id,
                "code": st.code,
                "name": st.name,
                "is_combi": st.is_combi,
                "has_image": bool(st.image_path),
                # Regle absente = visible / Missing rule means visible.
                "visible": rules.get(st.id, True),
            }
            for st in supports
        ],
    }


@router.put("/{pdv_id}")
async def set_pdv_rules(
    pdv_id: int,
    data: BulkVisibilityRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support-types", "update")),
):
    """Enregistrer les reglages d'un PDV / Save a PDV's settings.

    Envoi complet depuis l'ecran : on n'ecrit une ligne que pour les supports
    reellement masques et on supprime celles qui repassent a visible. La table
    ne garde donc que les exceptions, et un support rendu a tout le monde ne
    laisse pas de ligne morte derriere lui.
    """
    pdv = await db.get(PDV, pdv_id)
    if not pdv:
        raise HTTPException(status_code=404, detail="PDV introuvable")

    known = {st.id for st in await _returnable_support_types(db)}
    unknown = [i.support_type_id for i in data.items if i.support_type_id not in known]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Types de support inconnus ou non retournables : {unknown}",
        )

    existing_result = await db.execute(
        select(PdvSupportRule).where(PdvSupportRule.pdv_id == pdv_id)
    )
    existing = {r.support_type_id: r for r in existing_result.scalars().all()}

    hidden = 0
    for item in data.items:
        rule = existing.get(item.support_type_id)
        if item.visible:
            if rule is not None:
                await db.delete(rule)
        else:
            hidden += 1
            if rule is None:
                db.add(PdvSupportRule(
                    pdv_id=pdv_id,
                    support_type_id=item.support_type_id,
                    visible=False,
                ))
            else:
                rule.visible = False

    await db.flush()
    return {"pdv_id": pdv_id, "hidden_count": hidden}


@router.post("/{pdv_id}/copy")
async def copy_pdv_rules(
    pdv_id: int,
    data: CopyRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support-types", "update")),
):
    """Recopier la configuration d'un PDV vers d'autres / Copy one PDV's setup to others.

    Remplacement, pas fusion : les PDV cibles finissent avec exactement la
    configuration de la source. Sans cela, une copie ne pourrait que masquer
    davantage et il serait impossible de rattraper un reglage trop large.
    """
    source = await db.get(PDV, pdv_id)
    if not source:
        raise HTTPException(status_code=404, detail="PDV source introuvable")

    targets = [t for t in dict.fromkeys(data.target_pdv_ids) if t != pdv_id]
    if not targets:
        raise HTTPException(status_code=400, detail="Aucun PDV cible")

    found_result = await db.execute(select(PDV.id).where(PDV.id.in_(targets)))
    found = set(found_result.scalars().all())
    missing = [t for t in targets if t not in found]
    if missing:
        raise HTTPException(status_code=404, detail=f"PDV cibles introuvables : {missing}")

    source_rules = await _rules_for(db, pdv_id)
    hidden_ids = [st_id for st_id, visible in source_rules.items() if not visible]

    old_result = await db.execute(
        select(PdvSupportRule).where(PdvSupportRule.pdv_id.in_(targets))
    )
    for rule in old_result.scalars().all():
        await db.delete(rule)
    await db.flush()

    for target_id in targets:
        for st_id in hidden_ids:
            db.add(PdvSupportRule(
                pdv_id=target_id, support_type_id=st_id, visible=False,
            ))

    await db.flush()
    return {
        "source_pdv_id": pdv_id,
        "target_pdv_ids": targets,
        "hidden_count": len(hidden_ids),
    }


@router.delete("/{pdv_id}")
async def reset_pdv_rules(
    pdv_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support-types", "update")),
):
    """Tout remettre visible pour ce PDV / Make everything visible again for this PDV."""
    result = await db.execute(
        select(PdvSupportRule).where(PdvSupportRule.pdv_id == pdv_id)
    )
    removed = 0
    for rule in result.scalars().all():
        await db.delete(rule)
        removed += 1

    return {"pdv_id": pdv_id, "removed": removed}
