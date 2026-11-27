"""Import du distancier km / temps / taxe d'une ou plusieurs BASES (#96).

Contexte / Context :
  Le distancier n'avait aucune ligne pour Trazegnies ni Heppignies : toute
  tournee partant de ces bases sortait a 0 km, 0 carburant, 0 taxe km. Gaetan a
  fourni le vrai fichier (« Matrice_km_temps_taxe_Trazegnies_Heppignies.xlsx »),
  une matrice CARREE de tous les sites sur trois feuilles :
      Matrice_Km    -> km
      Matrice_app   -> temps de trajet (hh:mm:ss)
      Matrice_Taxe  -> taxe km du segment, en EUROS (montant forfaitaire par
                       segment, pas un taux/km — c'est ce que lit le calcul de
                       cout, malgre le nom de colonne `tax_per_km`)
  Ligne 1 = codes, ligne 2 = libelles, colonne A = codes, donnees en D+.

Ce que fait le script / What it does :
  - Ne touche QUE les paires ou l'une des bases ciblees intervient (ligne ET
    colonne de la base), vers les PDV, les fournisseurs et les autres bases
    ciblees. Le reste de la matrice (PDV <-> PDV, etc.) est ignore.
  - Ecrit les DEUX sens, comme dans le fichier : la matrice n'est pas tout a
    fait symetrique (Trazegnies -> Tournai 71 km, retour 81 km), et la taxe km
    n'est lue que dans le sens exact du segment.
  - Cellule vide, « nc » ou temps 00:00:00 = valeur absente. Si un sens manque,
    on reprend l'autre sens de la matrice ; s'il manque aussi, la paire est
    laissee de cote et listee dans le rapport.
  - Seule exception : km connu mais temps absent (dans le fichier de Gaetan,
    10 sites ont un temps a 00:00:00 pour les deux bases). Laisser la paire de
    cote la laisserait a 0 km dans le calcul de cout ; on ecrit donc le km reel
    avec un temps ESTIME par une droite temps = a + b x km ajustee sur les
    autres trajets de la meme base dans le fichier, et la ligne est marquee
    `is_estimated` pour etre remplacee des que le vrai temps arrive. Une telle
    estimation n'ecrase jamais une ligne existante mesuree.
  - UPSERT : une ligne existante est mise a jour (et perd `is_estimated`) ;
    les doublons eventuels d'une meme paire recoivent la meme valeur.
  - DRY-RUN par defaut : n'ecrit RIEN. Ajouter --apply pour ecrire.

Correspondance des bases / Base mapping :
  Par defaut, chaque base ciblee du fichier est retrouvee en base de donnees
  par son NOM (« 2785 (Trazegnies) » -> la base dont le nom contient
  « Trazegnies »). Si c'est ambigu ou introuvable, le script s'arrete et liste
  les bases existantes ; forcer alors avec --map 2785=<code base>.

Usage :
    cd backend
    python -m scripts.import_matrice_bases chemin/Matrice.xlsx --matrix-code 2785 --matrix-code 3252
    # relire le rapport, puis :
    python -m scripts.import_matrice_bases chemin/Matrice.xlsx --matrix-code 2785 --matrix-code 3252 --apply
"""

from __future__ import annotations

import argparse
import asyncio
import re
import unicodedata
from dataclasses import dataclass, field

SHEET_KM = "Matrice_Km"
SHEET_TIME = "Matrice_app"
SHEET_TAX = "Matrice_Taxe"
FIRST_DATA_COL = 3  # index 0-based de la colonne D
FIRST_DATA_ROW = 2  # index 0-based de la ligne 3


def _log(msg: str = "") -> None:
    print(msg, flush=True)


def norm_code(raw) -> str | None:
    """80 / '080' / 80.0 -> '80' ; 'E004' -> 'e004' ; 'x' / vide -> None."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s.lower() == "x":
        return None
    try:
        return str(int(float(s)))
    except (TypeError, ValueError):
        return s.lower()


def norm_text(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower().strip()


def label_name(label) -> str:
    """'2785 (Trazegnies)' -> 'Trazegnies' ; '1262-Tubize' -> 'Tubize'."""
    s = str(label or "").strip()
    if "(" in s and s.endswith(")"):
        return s[s.index("(") + 1:-1].strip()
    if "-" in s:
        return s.split("-", 1)[1].strip()
    return s


def _num(val) -> float | None:
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(str(val).strip().replace(",", "."))
    except ValueError:
        return None  # 'nc', '#N/A', ...


def _minutes(val) -> int | None:
    from app.api.imports import _time_to_minutes
    if isinstance(val, str) and _num(val) is None and ":" not in val:
        return None  # 'nc'
    try:
        m = _time_to_minutes(val)
    except Exception:
        return None
    return m if m and m > 0 else None  # 00:00:00 = non renseigne


@dataclass
class Matrix:
    codes: list[str | None]            # code normalise par position
    labels: list[str]
    km: dict[tuple[str, str], float] = field(default_factory=dict)
    minutes: dict[tuple[str, str], int] = field(default_factory=dict)
    tax: dict[tuple[str, str], float] = field(default_factory=dict)

    def get(self, kind: str, a: str, b: str):
        """Valeur a->b, a defaut celle de b->a / value, falling back to reverse."""
        d = getattr(self, kind)
        if (a, b) in d:
            return d[(a, b)], False
        if (b, a) in d:
            return d[(b, a)], True
        return None, False


def read_matrix(path: str) -> Matrix:
    import openpyxl
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheets = {s: list(wb[s].iter_rows(values_only=True)) for s in (SHEET_KM, SHEET_TIME, SHEET_TAX)}
    head = sheets[SHEET_KM][0]
    for s, rows in sheets.items():
        if rows[0] != head:
            raise SystemExit(f"ABANDON : les codes en-tete de {s} different de {SHEET_KM}.")

    codes = [norm_code(c) for c in head]
    labels = [str(x or "") for x in sheets[SHEET_KM][1]]
    mx = Matrix(codes=codes, labels=labels)
    for kind, sheet, conv in (("km", SHEET_KM, _num), ("minutes", SHEET_TIME, _minutes), ("tax", SHEET_TAX, _num)):
        target = getattr(mx, kind)
        for row in sheets[sheet][FIRST_DATA_ROW:]:
            a = norm_code(row[0])
            if a is None:
                continue
            for j in range(FIRST_DATA_COL, len(row)):
                b = codes[j] if j < len(codes) else None
                if b is None or b == a:
                    continue
                v = conv(row[j])
                if v is None or v < 0:
                    continue
                target.setdefault((a, b), v)
    return mx


async def run(path: str, matrix_codes: list[str], mapping: dict[str, str], tenant_id: int, apply: bool) -> None:
    from sqlalchemy import or_, select

    from app.database import async_session, set_session_tenant
    from app.models.base_logistics import BaseLogistics
    from app.models.distance_matrix import DistanceMatrix
    from app.models.km_tax import KmTax
    from app.models.pdv import PDV
    from app.models.supplier import Supplier

    mx = read_matrix(path)
    positions = {c: i for i, c in enumerate(mx.codes) if c is not None and i >= FIRST_DATA_COL}

    async with async_session() as db:
        set_session_tenant(db, tenant_id)
        bases = (await db.execute(select(BaseLogistics))).scalars().all()
        pdvs = (await db.execute(select(PDV))).scalars().all()
        suppliers = (await db.execute(select(Supplier))).scalars().all()

        # 1. Bases ciblees / target bases
        targets: dict[str, BaseLogistics] = {}
        for mc in matrix_codes:
            mc = norm_code(mc)
            if mc not in positions:
                raise SystemExit(f"ABANDON : code {mc} absent de la matrice.")
            name = label_name(mx.labels[positions[mc]])
            if mc in mapping:
                found = [b for b in bases if norm_code(b.code) == norm_code(mapping[mc])]
            else:
                found = [b for b in bases if norm_text(name) and norm_text(name) in norm_text(b.name)]
            if len(found) != 1:
                _log(f"Bases du tenant {tenant_id} :")
                for b in sorted(bases, key=lambda x: x.code):
                    _log(f"   code={b.code!r:10} id={b.id:<4} {b.name}")
                raise SystemExit(
                    f"ABANDON : base « {name} » (code matrice {mc}) "
                    f"{'introuvable' if not found else 'ambigue : ' + ', '.join(b.name for b in found)}. "
                    f"Preciser avec --map {mc}=<code base>. Aucune ecriture."
                )
            targets[mc] = found[0]
            _log(f"Base ciblee : matrice {mc} ({name}) -> base {found[0].code} « {found[0].name} » (id={found[0].id})")

        # 2. Contreparties : PDV, puis fournisseur / counterparts
        pdv_by = {norm_code(p.code): p for p in pdvs}
        sup_by = {norm_code(s.code): s for s in suppliers}
        counterparts: dict[str, tuple[str, int, str]] = {}
        unknown: list[str] = []
        for c, i in positions.items():
            # Le code d'en-tete peut etre un ancien code : Andenne porte 9921 en
            # en-tete mais « 12666-Andenne » en libelle, et 12666 en base. On
            # retente avec le code du libelle. / Fall back to the label's code.
            m = re.match(r"\s*([A-Za-z]?\d+)", mx.labels[i])
            alt = norm_code(m.group(1)) if m else None
            if c in targets:
                counterparts[c] = ("BASE", targets[c].id, targets[c].name)
            elif c in pdv_by:
                counterparts[c] = ("PDV", pdv_by[c].id, pdv_by[c].name)
            elif c in sup_by:
                counterparts[c] = ("SUPPLIER", sup_by[c].id, sup_by[c].name)
            elif alt in pdv_by:
                counterparts[c] = ("PDV", pdv_by[alt].id, pdv_by[alt].name)
                _log(f"Code d'en-tete {c} inconnu, code du libelle retenu : « {mx.labels[i]} »")
            elif alt in sup_by:
                counterparts[c] = ("SUPPLIER", sup_by[alt].id, sup_by[alt].name)
                _log(f"Code d'en-tete {c} inconnu, code du libelle retenu : « {mx.labels[i]} »")
            else:
                unknown.append(mx.labels[i])

        # 3. Lignes existantes impliquant les bases ciblees
        ids = [b.id for b in targets.values()]
        def _touching(model):
            return select(model).where(or_(
                (model.origin_type == "BASE") & model.origin_id.in_(ids),
                (model.destination_type == "BASE") & model.destination_id.in_(ids),
            ))
        exist_dm: dict[tuple, list] = {}
        for e in (await db.execute(_touching(DistanceMatrix))).scalars().all():
            exist_dm.setdefault((e.origin_type, e.origin_id, e.destination_type, e.destination_id), []).append(e)
        exist_tx: dict[tuple, list] = {}
        for e in (await db.execute(_touching(KmTax))).scalars().all():
            exist_tx.setdefault((e.origin_type, e.origin_id, e.destination_type, e.destination_id), []).append(e)

        # 4. Paires a ecrire : base ciblee <-> tout le reste, dans les deux sens
        pairs: list[tuple[str, str]] = []
        for t in targets:
            for c in counterparts:
                if c == t:
                    continue
                pairs.append((t, c))
                if c not in targets:
                    pairs.append((c, t))

        # Droite temps = a + b x km par base ciblee, sur les paires completes
        fits: dict[str, tuple[float, float]] = {}
        for t in targets:
            pts = [(k, mx.minutes[(t, c)]) for (o, c), k in mx.km.items()
                   if o == t and (t, c) in mx.minutes and k > 0]
            n = len(pts)
            if n >= 10:
                mk = sum(k for k, _ in pts) / n
                mm = sum(m for _, m in pts) / n
                var = sum((k - mk) ** 2 for k, _ in pts)
                b_ = sum((k - mk) * (m - mm) for k, m in pts) / var if var else 0.0
                fits[t] = (mm - b_ * mk, b_)
                _log(f"Temps estime pour {targets[t].name} : {fits[t][0]:.1f} min + {fits[t][1]:.3f} min/km "
                     f"(ajuste sur {n} trajets)")

        estimated: list[str] = []
        stats = {k: 0 for k in ("dm_new", "dm_upd", "dm_same", "dm_missing", "dm_reverse", "dm_est",
                                "tx_new", "tx_upd", "tx_same", "tx_missing", "tx_reverse")}
        changes: list[str] = []
        missing: dict[str, list[str]] = {}

        for a, b in pairs:
            ta, ia, na = counterparts[a]
            tb, ib, nb = counterparts[b]
            key = (ta, ia, tb, ib)
            label = f"{na} -> {nb}"

            km, rev_km = mx.get("km", a, b)
            mn, rev_mn = mx.get("minutes", a, b)
            is_est = False
            fit = fits.get(a if a in targets else b)
            if km is not None and mn is None and fit is not None:
                mn, is_est = max(1, round(fit[0] + fit[1] * km)), True
                estimated.append(f"{label} : {km:g} km, ~{mn} min")
            if km is None or mn is None:
                stats["dm_missing"] += 1
                missing.setdefault("distance/temps", []).append(label)
            else:
                stats["dm_reverse"] += int(rev_km or rev_mn)
                stats["dm_est"] += int(is_est)
                rows = exist_dm.get(key, [])
                if rows and is_est and any(not r.is_estimated for r in rows):
                    stats["dm_same"] += 1  # une mesure existante prime sur une estimation
                elif not rows:
                    stats["dm_new"] += 1
                    if apply:
                        db.add(DistanceMatrix(origin_type=ta, origin_id=ia, destination_type=tb,
                                              destination_id=ib, distance_km=km,
                                              duration_minutes=mn, is_estimated=is_est))
                else:
                    differs = any(float(r.distance_km) != km or r.duration_minutes != mn
                                  or r.is_estimated != is_est for r in rows)
                    if differs:
                        stats["dm_upd"] += 1
                        r0 = rows[0]
                        if len(changes) < 15:
                            changes.append(f"   {label} : {float(r0.distance_km):g} km / {r0.duration_minutes} min"
                                           f"{' (estime)' if r0.is_estimated else ''} -> {km:g} km / {mn} min")
                        if apply:
                            for r in rows:
                                r.distance_km, r.duration_minutes, r.is_estimated = km, mn, is_est
                    else:
                        stats["dm_same"] += 1

            tx, rev_tx = mx.get("tax", a, b)
            if tx is None:
                stats["tx_missing"] += 1
                missing.setdefault("taxe", []).append(label)
            else:
                stats["tx_reverse"] += int(rev_tx)
                rows = exist_tx.get(key, [])
                if not rows:
                    stats["tx_new"] += 1
                    if apply:
                        db.add(KmTax(origin_type=ta, origin_id=ia, destination_type=tb,
                                     destination_id=ib, tax_per_km=tx))
                elif any(float(r.tax_per_km) != tx for r in rows):
                    stats["tx_upd"] += 1
                    if apply:
                        for r in rows:
                            r.tax_per_km = tx
                else:
                    stats["tx_same"] += 1

        # 5. Rapport
        _log()
        _log(f"Contreparties reconnues : {len(counterparts)} "
             f"(PDV {sum(1 for v in counterparts.values() if v[0] == 'PDV')}, "
             f"fournisseurs {sum(1 for v in counterparts.values() if v[0] == 'SUPPLIER')}, "
             f"bases {sum(1 for v in counterparts.values() if v[0] == 'BASE')})")
        if unknown:
            _log(f"Codes de la matrice inconnus en base (ignores) : {len(unknown)}")
            _log("   " + ", ".join(unknown))
        _log()
        _log(f"Distancier : {stats['dm_new']} a creer, {stats['dm_upd']} a mettre a jour, "
             f"{stats['dm_same']} deja identiques, {stats['dm_missing']} sans valeur "
             f"({stats['dm_reverse']} repris du sens inverse, {stats['dm_est']} avec temps estime)")
        _log(f"Taxe km    : {stats['tx_new']} a creer, {stats['tx_upd']} a mettre a jour, "
             f"{stats['tx_same']} deja identiques, {stats['tx_missing']} sans valeur "
             f"({stats['tx_reverse']} repris du sens inverse)")
        if changes:
            _log("Exemples de valeurs existantes remplacees :")
            for c in changes:
                _log(c)
        if estimated:
            _log(f"Km reels, temps ESTIME (marques is_estimated) ({len(estimated)}) :")
            for e in estimated:
                _log(f"   {e}")
        for what, items in missing.items():
            _log(f"Paires laissees de cote faute de {what} ({len(items)}) :")
            for it in items[:40]:
                _log(f"   {it}")
            if len(items) > 40:
                _log(f"   ... et {len(items) - 40} autres")

        if apply:
            await db.commit()
            _log("\nECRIT en base.")
        else:
            await db.rollback()
            _log("\nDRY-RUN : rien n'a ete ecrit. Relancer avec --apply.")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("file")
    p.add_argument("--matrix-code", action="append", required=True,
                   help="Code de la base dans la matrice (ex. 2785). Repetable.")
    p.add_argument("--map", action="append", default=[],
                   help="Forcer la correspondance code_matrice=code_base (ex. 2785=TRZ).")
    p.add_argument("--tenant", type=int, default=1, help="Tenant cible (defaut 1 = Belgique)")
    p.add_argument("--apply", action="store_true", help="Ecrire (sinon simulation)")
    args = p.parse_args()
    mapping = {}
    for m in args.map:
        k, _, v = m.partition("=")
        mapping[norm_code(k)] = v.strip()
    asyncio.run(run(args.file, args.matrix_code, mapping, args.tenant, args.apply))


if __name__ == "__main__":
    main()
