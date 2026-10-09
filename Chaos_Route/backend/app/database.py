"""
Connexion a la base de donnees / Database connection.
Supporte SQLite (dev) et PostgreSQL (prod) via SQLAlchemy 2.0 async.
"""

from sqlalchemy import Enum as SAEnum, event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, ORMExecuteState, Session, with_loader_criteria

from app.config import settings

_is_sqlite = settings.DATABASE_URL.startswith("sqlite")

# Configuration moteur / Engine configuration
_engine_kwargs: dict = {
    "echo": settings.DEBUG,
}

# PostgreSQL : connection pooling pour 230 utilisateurs concurrents /
# PostgreSQL: connection pooling for 230 concurrent users (200 drivers + 30 office)
if not _is_sqlite:
    _engine_kwargs.update({
        "pool_size": 20,
        "max_overflow": 30,
        "pool_timeout": 30,
        "pool_recycle": 1800,
        "pool_pre_ping": True,
    })

engine = create_async_engine(settings.DATABASE_URL, **_engine_kwargs)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# Multi-tenance : cloisonnement automatique et central par tenant_id.
#
# Principe : la session porte le tenant courant dans `session.info["tenant_id"]`
# (positionné après authentification, cf. app.api.deps.get_current_user).
#   - tenant_id = un entier  -> toute requête sur un modèle TenantMixin est filtrée
#     automatiquement (impossible d'oublier le filtre dans un endpoint).
#   - tenant_id = None / absent -> AUCUN filtre (superadmin, rôle « consolidation
#     groupe », ou contextes sans utilisateur comme le démarrage/migrations).
# À l'écriture, les nouveaux objets TenantMixin sans tenant_id héritent du tenant
# courant (stampage central).
#
# Clé d'info de session servant à FORCER l'absence de filtre dans un bloc précis
# (ex. tâches d'administration) via session.info[TENANT_BYPASS] = True.
# ---------------------------------------------------------------------------
TENANT_BYPASS = "tenant_bypass"


def set_session_tenant(session, tenant_id: int | None) -> None:
    """Positionner le tenant courant sur une session (sync ou AsyncSession).

    tenant_id=None => pas de filtrage (accès multi-tenant : superadmin / consolidation).
    """
    info = session.info
    info["tenant_id"] = tenant_id
    info[TENANT_BYPASS] = tenant_id is None


@event.listens_for(Session, "do_orm_execute")
def _apply_tenant_filter(state: ORMExecuteState) -> None:
    """Injecter le filtre tenant sur toute lecture ET toute écriture en masse
    (UPDATE/DELETE ORM) des modèles TenantMixin.

    Les SELECT étaient déjà filtrés ; les UPDATE/DELETE en masse (ex. import mode
    « replace », suppressions groupées) ne l'étaient PAS → un utilisateur d'un
    tenant pouvait modifier/supprimer les lignes d'un autre tenant. with_loader_criteria
    s'applique aussi aux UPDATE/DELETE ORM (SQLAlchemy 2.0), ce qui ajoute la
    contrainte `tenant_id = <courant>` à leur WHERE. / Tenant filter now also covers
    bulk ORM UPDATE/DELETE, not just SELECT."""
    if not (state.is_select or state.is_update or state.is_delete):
        return
    if state.execution_options.get("skip_tenant_filter"):
        return
    info = state.session.info
    if info.get(TENANT_BYPASS):
        return
    tenant_id = info.get("tenant_id")
    if tenant_id is None:
        return
    from app.models.mixins import TenantMixin

    # IMPORTANT : `tenant_id` doit être une variable de CLÔTURE (closure), pas un
    # argument par défaut. Le système de lambda-SQL de SQLAlchemy met en cache la
    # criteria par identité de code ; un défaut `tid=tenant_id` est traité comme une
    # CONSTANTE et fige la valeur du PREMIER appel → toutes les requêtes suivantes
    # seraient filtrées sur le tenant initial (invisible à 1 seul tenant, fuite/0
    # résultat dès 2 tenants). La forme closure ci-dessous est suivie et re-liée en
    # bindparam à chaque exécution. / Must be a tracked closure var, not a default arg.
    state.statement = state.statement.options(
        with_loader_criteria(
            TenantMixin,
            lambda cls: cls.tenant_id == tenant_id,
            include_aliases=True,
        )
    )


@event.listens_for(Session, "before_flush")
def _stamp_tenant_on_insert(session: Session, flush_context, instances) -> None:
    """Affecter le tenant courant aux nouveaux objets TenantMixin sans tenant_id."""
    tenant_id = session.info.get("tenant_id")
    if tenant_id is None:
        return
    from app.models.mixins import TenantMixin

    for obj in session.new:
        if isinstance(obj, TenantMixin) and getattr(obj, "tenant_id", None) is None:
            obj.tenant_id = tenant_id


async def get_db() -> AsyncSession:
    """Dependance FastAPI pour obtenir une session DB / FastAPI dependency for DB session."""
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db():
    """Creer les tables au demarrage / Create tables on startup."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # Ajouter les colonnes manquantes sur tables existantes /
    # Add missing columns on existing tables
    await _migrate_enum_values()
    # Créer les types ENUM PG manquants AVANT d'ajouter les colonnes qui les utilisent /
    # Create missing PG ENUM types BEFORE adding columns that reference them
    await _migrate_create_enum_types()
    await _migrate_missing_columns()
    # Multi-tenance : créer le tenant par défaut (Belgique) et retro-remplir
    # tenant_id=1 sur toutes les lignes existantes / Seed default tenant + backfill
    await _seed_default_tenant_and_backfill()
    # Aligner les types de colonnes critiques sur les modèles /
    # Align critical column types with models
    await _migrate_column_types()
    # Ajouter les indexes manquants sur tables existantes /
    # Add missing indexes on existing tables
    await _migrate_missing_indexes()
    # Ajouter les contraintes FK manquantes (PG uniquement) /
    # Add missing FK constraints (PG only)
    await _migrate_missing_foreign_keys()
    # Retro-remplir le type de carburant (DIESEL/gasoil par defaut) / Backfill fuel_type
    await _backfill_fuel_type()
    # Retro-remplir la nature des tours (LIVRAISON par defaut) / Backfill tour_type
    await _backfill_tour_type()
    # Generer les QR/badge codes manquants / Backfill missing QR/badge codes
    await _backfill_qr_codes()
    # Marquer le support combi (code CO) si pas encore fait /
    # Mark combi support type (code CO) if not yet flagged
    await _backfill_combi_support_type()
    # Purger les positions GPS > 30 jours / Purge GPS positions older than 30 days
    await _cleanup_old_gps()


async def _backfill_tour_type():
    """Retro-remplir tour_type=LIVRAISON sur les tours existants (NULL) /
    Backfill tour_type=LIVRAISON on existing tours.

    Aligne aussi la nature sur l'ancien drapeau is_pickup_tour : les tours
    de reprise existants deviennent ENLEVEMENT.
    """
    async with engine.begin() as conn:
        try:
            r1 = await conn.execute(text(
                "UPDATE tours SET tour_type = 'ENLEVEMENT' "
                "WHERE tour_type IS NULL AND is_pickup_tour = "
                + ("TRUE" if not _is_sqlite else "1")
            ))
            r2 = await conn.execute(text(
                "UPDATE tours SET tour_type = 'LIVRAISON' WHERE tour_type IS NULL"
            ))
            n = (r1.rowcount or 0) + (r2.rowcount or 0)
            if n:
                print(f"[backfill] tours: {n} lignes -> tour_type (LIVRAISON/ENLEVEMENT)")
        except Exception as e:
            print(f"[backfill] WARN tour_type: {e}")


async def _backfill_qr_codes():
    """Generer qr_code/badge_code pour les entites existantes / Backfill QR/badge codes for existing entities."""
    import uuid

    async with async_session() as session:
        # Vehicules sans qr_code / Vehicles without qr_code
        result = await session.execute(
            text("SELECT id FROM vehicles WHERE qr_code IS NULL OR qr_code = ''")
        )
        vehicle_ids = [row[0] for row in result.fetchall()]
        for vid in vehicle_ids:
            code = uuid.uuid4().hex[:8].upper()
            await session.execute(
                text("UPDATE vehicles SET qr_code = :code WHERE id = :id"),
                {"code": code, "id": vid},
            )
        if vehicle_ids:
            print(f"[backfill] Generated qr_code for {len(vehicle_ids)} vehicles")

        # Users sans badge_code / Users without badge_code
        result = await session.execute(
            text("SELECT id FROM users WHERE badge_code IS NULL OR badge_code = ''")
        )
        user_ids = [row[0] for row in result.fetchall()]
        for uid in user_ids:
            code = uuid.uuid4().hex[:8].upper()
            await session.execute(
                text("UPDATE users SET badge_code = :code WHERE id = :id"),
                {"code": code, "id": uid},
            )
        if user_ids:
            print(f"[backfill] Generated badge_code for {len(user_ids)} users")

        await session.commit()


async def _backfill_combi_support_type():
    """Marquer le SupportType code='CO' comme is_combi=True s'il ne l'est pas /
    Mark SupportType with code='CO' as is_combi=True if not already.

    Idempotent : ne fait rien si deja flagge.
    Si le code 'CO' n'existe pas encore en DB, ne fait rien (silencieux).
    """
    async with async_session() as session:
        result = await session.execute(
            text("SELECT id, is_combi FROM support_types WHERE code = 'CO'")
        )
        row = result.fetchone()
        if row and not row[1]:
            await session.execute(
                text("UPDATE support_types SET is_combi = 1 WHERE id = :id"),
                {"id": row[0]},
            )
            await session.commit()
            print(f"[backfill] Flagged support_type id={row[0]} (code=CO) as is_combi")


async def _cleanup_old_gps(days: int = 30):
    """Purger les positions GPS des tours > 30 jours / Purge GPS positions for tours older than 30 days."""
    from datetime import datetime, timedelta
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    async with engine.begin() as conn:
        result = await conn.execute(text(
            "DELETE FROM gps_positions WHERE tour_id IN "
            "(SELECT id FROM tours WHERE date < :cutoff)"
        ), {"cutoff": cutoff})
        if result.rowcount:
            print(f"[cleanup] {result.rowcount} GPS positions removed (tours before {cutoff})")


async def _seed_default_tenant_and_backfill():
    """Créer le tenant par défaut (id=1, Belgique) et retro-remplir tenant_id=1.

    Idempotent. À exécuter APRÈS _migrate_missing_columns (les colonnes tenant_id
    doivent exister, ajoutées en NULLABLE — donc sans DEFAULT 0 invalide).
    Le backfill couvre TOUTE table possédant une colonne tenant_id (modèles
    TenantMixin + users), de façon dynamique : pas de liste à maintenir.
    """
    from app.models.tenant import DEFAULT_TENANT_ID

    async with engine.begin() as conn:
        # 1) Créer le tenant par défaut s'il n'existe pas / Create default tenant
        result = await conn.execute(
            text("SELECT id FROM tenants WHERE id = :tid"),
            {"tid": DEFAULT_TENANT_ID},
        )
        if result.fetchone() is None:
            active = "TRUE" if not _is_sqlite else "1"
            await conn.execute(
                text(
                    "INSERT INTO tenants (id, code, name, is_active) "
                    f"VALUES (:tid, 'BE', 'Belgique', {active})"
                ),
                {"tid": DEFAULT_TENANT_ID},
            )
            print(f"[tenant] Created default tenant id={DEFAULT_TENANT_ID} (Belgique)")
            # PostgreSQL : recaler la séquence d'auto-incrément après INSERT d'id
            # explicite / realign identity sequence after explicit id insert
            if not _is_sqlite:
                await conn.execute(text(
                    "SELECT setval(pg_get_serial_sequence('tenants', 'id'), "
                    "(SELECT MAX(id) FROM tenants))"
                ))

        # 2) Backfill tenant_id=1 sur toutes les tables qui ont cette colonne /
        #    Backfill tenant_id=1 on every table that has the column
        for table in Base.metadata.sorted_tables:
            if "tenant_id" not in table.columns:
                continue
            try:
                r = await conn.execute(text(
                    f'UPDATE "{table.name}" SET tenant_id = :tid WHERE tenant_id IS NULL'
                ), {"tid": DEFAULT_TENANT_ID})
                if r.rowcount:
                    print(f"[tenant] backfill {table.name}: {r.rowcount} lignes -> tenant_id={DEFAULT_TENANT_ID}")
            except Exception as e:
                print(f"[tenant] WARN backfill {table.name}: {e}")


async def _migrate_enum_values():
    """Ajouter les nouvelles valeurs aux types enum PostgreSQL / Add new enum values to PostgreSQL enum types."""
    if _is_sqlite:
        return
    enum_updates = [
        ("bookingstatus", ["UNLOADING", "DOCK_LEFT"]),
        ("dockeventtype", ["UNLOADING", "DOCK_LEFT", "SITE_LEFT"]),
        ("pickupstatus", ["CANCELLED"]),  # Annulation declaration combi remplacee
        ("vehicletype", ["PORTEUR_SURBAISSE"]),  # Porteur surbaisse ajoute apres coup
        ("tourtype", ["TRANSFERT_PDV", "ENLEVEMENT_DEDIE"]),  # Transfert PDV a PDV + enlevement dedie ajoutes apres coup
        # Cette liste est MANUELLE : elle ne se deduit pas des modeles. Une
        # valeur ajoutee a un Enum Python sans etre reportee ici manque en base,
        # et la premiere ecriture qui l'utilise part en erreur. Constate le
        # 2026-10-09 : PICKUP_PARTIAL et PICKUP_LOSS vivaient dans AlertType
        # depuis des semaines et etaient absentes de l'enum PostgreSQL. /
        # This list is MANUAL: a value added to a Python Enum and not mirrored
        # here is missing in the database.
        ("alerttype", ["PICKUP_PARTIAL", "PICKUP_LOSS", "DEVICE_NOT_AT_BASE"]),
    ]
    async with engine.begin() as conn:
        for enum_name, new_values in enum_updates:
            # Lire les valeurs existantes / Read existing values
            result = await conn.execute(text(
                "SELECT enumlabel FROM pg_enum WHERE enumtypid = "
                "(SELECT oid FROM pg_type WHERE typname = :enum_name)"
            ), {"enum_name": enum_name})
            existing = {row[0] for row in result.fetchall()}
            for val in new_values:
                if val not in existing:
                    await conn.execute(text(
                        f"ALTER TYPE {enum_name} ADD VALUE IF NOT EXISTS '{val}'"
                    ))
                    print(f"[migrate] Added enum value {enum_name}.{val}")


async def _migrate_create_enum_types():
    """Creer les types ENUM PostgreSQL manquants / Create missing PG ENUM types.

    create_all ne cree pas le type PG pour une colonne enum ajoutee a une table
    deja existante. On cree donc explicitement chaque type enum reference par les
    modeles (idempotent via checkfirst). PG uniquement (SQLite n'a pas de type enum).
    """
    if _is_sqlite:
        return
    seen: set[str] = set()
    async with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            for col in table.columns:
                t = col.type
                if isinstance(t, SAEnum) and t.name and t.name not in seen:
                    seen.add(t.name)
                    try:
                        await conn.run_sync(lambda sc, tt=t: tt.create(sc, checkfirst=True))
                    except Exception as e:
                        print(f"[migrate] WARN: failed to create enum type {t.name}: {e}")


async def _backfill_fuel_type():
    """Retro-remplir fuel_type=DIESEL (gasoil) sur les lignes existantes (NULL) /
    Backfill fuel_type=DIESEL on existing rows (legacy contracts/fuel prices).
    """
    async with engine.begin() as conn:
        for table in ("contracts", "fuel_prices"):
            try:
                result = await conn.execute(text(
                    f"UPDATE {table} SET fuel_type = 'DIESEL' WHERE fuel_type IS NULL"
                ))
                if result.rowcount:
                    print(f"[backfill] {table}: {result.rowcount} lignes -> fuel_type=DIESEL")
            except Exception as e:
                print(f"[backfill] WARN fuel_type {table}: {e}")


async def _migrate_missing_columns():
    """Verifier et ajouter les colonnes manquantes / Check and add missing columns via ALTER TABLE.

    Supporte SQLite (PRAGMA) et PostgreSQL (information_schema).
    """
    async with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            # Detecter les colonnes existantes / Detect existing columns
            if _is_sqlite:
                result = await conn.execute(text(f"PRAGMA table_info('{table.name}')"))
                existing_cols = {row[1] for row in result.fetchall()}
            else:
                result = await conn.execute(text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = :table_name AND table_schema = 'public'"
                ), {"table_name": table.name})
                existing_cols = {row[0] for row in result.fetchall()}

            for col in table.columns:
                if col.name not in existing_cols:
                    col_type = col.type.compile(dialect=engine.dialect)
                    col_type_str = str(col_type)

                    # Si la colonne est nullable, ne PAS forcer un DEFAULT
                    # (laisse NULL pour les lignes existantes) /
                    # If column is nullable, do NOT force a DEFAULT
                    # (leave NULL for existing rows)
                    if col.nullable:
                        default = ""
                    # Determiner la valeur par defaut / Determine default value
                    elif col_type_str == "BOOLEAN":
                        default = "DEFAULT FALSE" if not _is_sqlite else "DEFAULT 0"
                    elif col_type_str.startswith("VARCHAR") or col_type_str == "TEXT":
                        default = "DEFAULT ''"
                    elif col_type_str in ("INTEGER", "BIGINT"):
                        default = "DEFAULT 0"
                    elif col_type_str.startswith("NUMERIC") or col_type_str.startswith("FLOAT"):
                        default = "DEFAULT 0"
                    else:
                        default = ""

                    await conn.execute(text(
                        f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col_type} {default}'
                    ))
                    print(f"[migrate] Added column {table.name}.{col.name} ({col_type})")


async def _migrate_column_types():
    """Aligner les types de colonnes specifiques avec le modele SQLAlchemy
    pour les cas ou un ALTER TYPE est requis (SQLAlchemy create_all ne modifie
    pas les colonnes existantes).

    Liste des conversions sures (pas de perte) :
    - volumes.eqp_count : integer -> numeric(10,2)
    - tour_stops.eqp_count : integer -> numeric(10,2)

    PostgreSQL uniquement. SQLite est typage faible et tolere les decimaux dans
    une colonne integer.
    """
    if _is_sqlite:
        return

    targets = [
        ("volumes", "eqp_count", "numeric(10,2)"),
        ("tour_stops", "eqp_count", "numeric(10,2)"),
        ("tours", "total_eqp", "numeric(10,2)"),  # EQP fractionnaire (volumes injectes)
    ]

    async with engine.begin() as conn:
        for table, column, target_type in targets:
            try:
                result = await conn.execute(text(
                    "SELECT data_type FROM information_schema.columns "
                    "WHERE table_name = :t AND column_name = :c AND table_schema = 'public'"
                ), {"t": table, "c": column})
                row = result.fetchone()
                if not row:
                    continue
                current = row[0]
                # Si deja en numeric, rien a faire / Already numeric, skip
                if "numeric" in current.lower() or "double" in current.lower():
                    continue
                await conn.execute(text(
                    f'ALTER TABLE "{table}" ALTER COLUMN "{column}" TYPE {target_type} '
                    f'USING "{column}"::{target_type}'
                ))
                print(f"[migrate] Changed {table}.{column} type: {current} -> {target_type}")
            except Exception as e:
                print(f"[migrate] WARN: failed to alter {table}.{column}: {e}")


async def _migrate_missing_indexes():
    """Creer les indexes definis dans les modeles mais absents en DB /
    Create indexes defined in models but missing in DB.

    Compare Base.metadata.tables vs indexes existants en DB et cree ceux manquants.
    Idempotent : utilise CREATE INDEX IF NOT EXISTS.
    """
    async with engine.begin() as conn:
        # Lister les indexes existants en DB / List existing indexes in DB
        if _is_sqlite:
            result = await conn.execute(text(
                "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
            ))
            existing_indexes = {row[0] for row in result.fetchall()}
        else:
            result = await conn.execute(text(
                "SELECT indexname FROM pg_indexes WHERE schemaname='public'"
            ))
            existing_indexes = {row[0] for row in result.fetchall()}

        # Pour chaque index defini dans les modeles, le creer s'il manque /
        # For each model-defined index, create if missing
        for table in Base.metadata.sorted_tables:
            for index in table.indexes:
                if index.name and index.name not in existing_indexes:
                    cols = ", ".join(f'"{c.name}"' for c in index.columns)
                    unique = "UNIQUE " if index.unique else ""
                    try:
                        await conn.execute(text(
                            f'CREATE {unique}INDEX IF NOT EXISTS "{index.name}" '
                            f'ON "{table.name}" ({cols})'
                        ))
                        print(f"[migrate] Added index {index.name} on {table.name}({cols})")
                    except Exception as e:
                        # Ne pas bloquer le demarrage si un index pose probleme /
                        # Don't block startup on index issue
                        print(f"[migrate] WARN: failed to create index {index.name}: {e}")


async def _migrate_missing_foreign_keys():
    """Ajouter les contraintes FK definies dans les modeles mais absentes en DB /
    Add FK constraints defined in models but missing in DB.

    PostgreSQL uniquement : SQLite ne supporte pas ALTER TABLE ADD CONSTRAINT.
    En SQLite (dev), les FK sont creees a la creation de la table par create_all,
    et l'absence de FK sur colonnes ajoutees a posteriori est acceptee (FK pas
    enforcees par defaut).
    """
    if _is_sqlite:
        return

    # 1. Lister les FK existantes (lecture seule) / List existing FK constraints
    async with engine.connect() as conn:
        result = await conn.execute(text("""
            SELECT tc.table_name, kcu.column_name, tc.constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema = 'public'
        """))
        existing_fks = {(row[0], row[1]) for row in result.fetchall()}

    # 2. Construire la liste des FK manquantes / Build list of missing FKs
    to_add: list[tuple[str, str, str, str, str]] = []
    for table in Base.metadata.sorted_tables:
        for col in table.columns:
            for fk in col.foreign_keys:
                if (table.name, col.name) in existing_fks:
                    continue
                to_add.append((
                    table.name, col.name,
                    fk.column.table.name, fk.column.name, fk.ondelete or "NO ACTION",
                ))

    # 3. Ajouter CHAQUE FK dans SA PROPRE transaction : un échec (ex. donnée
    #    orpheline) ne doit pas annuler les autres / one tx per FK so a single
    #    failure (e.g. orphan row) doesn't abort the rest.
    for tname, cname, target_table, target_col, on_delete in to_add:
        constraint_name = f"fk_{tname}_{cname}"
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    f'ALTER TABLE "{tname}" '
                    f'ADD CONSTRAINT "{constraint_name}" '
                    f'FOREIGN KEY ("{cname}") '
                    f'REFERENCES "{target_table}" ("{target_col}") '
                    f'ON DELETE {on_delete}'
                ))
            print(
                f"[migrate] Added FK {constraint_name}: "
                f"{tname}.{cname} -> {target_table}.{target_col} (ON DELETE {on_delete})"
            )
        except Exception as e:
            # Donnée orpheline ou contrainte déjà présente sous un autre nom /
            # Orphan data or constraint already present under another name
            print(f"[migrate] WARN: failed to add FK on {tname}.{cname}: {e}")
