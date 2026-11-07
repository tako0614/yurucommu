/**
 * Worker-applied schema for a Yurucommu Worker deployed straight to Cloudflare.
 *
 * The official `cloudflare/cloudflare` OpenTofu provider creates a D1 database
 * but has no resource that runs SQL against it, and a direct install has no
 * Takoform Host to converge a `SQLiteMigrationApplication`. So the Worker that
 * `deploy/cloudflare` publishes carries the product's locked schema bundle
 * (`deploy/takoform/migrations/schema-bundle.json`, generated from the locked
 * `@takosjp/yurucommu-core` package plus the D1-safe 0003 rebuild) and brings
 * its own database up to date before it serves anything.
 *
 * It is opt-in. Only a deployment that sets
 * `YURUCOMMU_APPLY_BUNDLED_MIGRATIONS=true` on the raw `cloudflare` lane runs
 * it. Every other deployment — wrangler self-hosts, the root OpenTofu adapter,
 * Takoform Hosts, the yurucommu.com production Worker whose ledger is operator
 * state — keeps applying migrations exactly as before. An unrecognised value
 * refuses to start rather than guessing.
 *
 * Exactly-once without a lock table:
 *
 *   - The ledger is the engine's own `yurucommu_migrations`, created with the
 *     same DDL the core runner uses and named by the same file names, so the
 *     core runner, `wrangler d1 migrations apply` (`migrations_table:
 *     yurucommu_migrations`) and this runner all read one history.
 *   - Each migration file is ONE `D1Database.batch`, which D1 executes as a
 *     single transaction. The ledger row is the batch's FIRST statement. D1
 *     serialises writes, so when two isolates race, the second batch starts
 *     after the first committed, fails on the ledger's UNIQUE name, and rolls
 *     back before any of its schema statements ran.
 *   - A batch that fails for any other reason leaves neither schema nor ledger
 *     behind. The runner re-reads the ledger, distinguishes "someone else
 *     applied it" from a real failure, and only then reports the failure.
 *
 * Forward-only, like every family runner: it applies known files that the
 * ledger lacks, in file-name order, and never rewrites or removes a ledger row.
 * Ledger rows this build does not know (a newer release already migrated the
 * database) are left alone.
 *
 * Limit for future migrations: one file is one D1 batch, and D1 stops a query
 * after 30 seconds. Every current file is DDL plus small backfills and applies
 * in a couple of seconds on a fresh database, but a future table rebuild or
 * backfill over a large production table can exceed that. Such a batch rolls
 * back as a whole and the Worker keeps answering 503, so a large rebuild must
 * be split into files that each finish well inside the limit (or shipped with
 * an operator-run path), never written as one long file.
 */

/** One schema file, already split into single statements at build time. */
export type BundledD1Migration = {
  readonly name: string;
  readonly sha256: string;
  readonly statements: readonly string[];
};

/** The subset of a `D1PreparedStatement` this runner uses. */
export interface D1MigrationStatement {
  bind(...values: unknown[]): D1MigrationStatement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

/** The subset of a native `D1Database` this runner uses. */
export interface D1MigrationDatabase {
  prepare(query: string): D1MigrationStatement;
  batch(statements: D1MigrationStatement[]): Promise<unknown[]>;
}

/** The plain variable that opts a deployment into Worker-applied schema. */
export const APPLY_BUNDLED_MIGRATIONS_VAR =
  "YURUCOMMU_APPLY_BUNDLED_MIGRATIONS";

/** The engine's ledger, shared with the core runner and wrangler. */
export const MIGRATION_LEDGER_TABLE = "yurucommu_migrations";

// Byte-for-byte the core runner's ledger (server.ts runMigrations), which is
// also the shape `wrangler d1 migrations apply` reads and writes.
export const MIGRATION_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )`;

const MIGRATION_NAME_RE = /^[0-9]{4}_[A-Za-z0-9_-]+\.sql$/u;

/**
 * The deployment or build is misconfigured; retrying will not help. The Worker
 * refuses to serve rather than answering 503 forever.
 */
export class BundledSchemaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundledSchemaConfigError";
  }
}

/** A failed migration, named so the operator can find it in the ledger. */
export class BundledMigrationError extends Error {
  readonly migration: string | null;

  constructor(message: string, migration: string | null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BundledMigrationError";
    this.migration = migration;
  }
}

/**
 * Read the opt-in. Unset, empty and "false" are off; "true" is on; anything
 * else refuses, because a typo must not silently leave a fresh database empty
 * or silently start migrating one an operator manages.
 */
export function resolveApplyBundledMigrations(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized === "true") return true;
    if (normalized === "false" || normalized === "") return false;
  }
  throw new BundledSchemaConfigError(
    `${APPLY_BUNDLED_MIGRATIONS_VAR} must be "true" or "false"; refusing to ` +
      "start rather than guess who owns this database's schema.",
  );
}

/** Reject a malformed embedded bundle before touching the database. */
export function assertBundledMigrations(
  migrations: readonly BundledD1Migration[],
): void {
  if (migrations.length === 0) {
    throw new BundledSchemaConfigError(
      `${APPLY_BUNDLED_MIGRATIONS_VAR}=true but this Worker build embeds no ` +
        "migrations; rebuild it with `bun run build:worker`.",
    );
  }
  let previous = "";
  for (const migration of migrations) {
    if (
      !MIGRATION_NAME_RE.test(migration.name) ||
      migration.name <= previous ||
      !/^sha256:[a-f0-9]{64}$/u.test(migration.sha256) ||
      migration.statements.length === 0 ||
      migration.statements.some(
        (statement) => typeof statement !== "string" || !statement.trim(),
      )
    ) {
      throw new BundledSchemaConfigError(
        "embedded migration bundle is malformed at " + String(migration.name),
      );
    }
    previous = migration.name;
  }
}

async function readLedger(db: D1MigrationDatabase): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT name FROM ${MIGRATION_LEDGER_TABLE}`)
    .all<{ name: unknown }>();
  const names = new Set<string>();
  for (const row of results ?? []) {
    if (typeof row.name === "string") names.add(row.name);
  }
  return names;
}

async function isRecorded(
  db: D1MigrationDatabase,
  name: string,
): Promise<boolean> {
  const { results } = await db
    .prepare(
      `SELECT 1 AS present FROM ${MIGRATION_LEDGER_TABLE} WHERE name = ?`,
    )
    .bind(name)
    .all<{ present: unknown }>();
  return (results ?? []).length > 0;
}

export type BundledSchemaResult = {
  /** Files this call committed. */
  readonly applied: readonly string[];
  /** Files another writer committed while this call was racing it. */
  readonly appliedConcurrently: readonly string[];
  /** Files already in the ledger before this call. */
  readonly alreadyApplied: number;
};

/**
 * Bring `db` up to the embedded bundle. Safe to call concurrently from many
 * isolates and safe to call again after a failure.
 */
export async function applyBundledD1Migrations(
  db: D1MigrationDatabase,
  migrations: readonly BundledD1Migration[],
): Promise<BundledSchemaResult> {
  assertBundledMigrations(migrations);
  let ledger: Set<string>;
  try {
    await db.prepare(MIGRATION_LEDGER_DDL).run();
    ledger = await readLedger(db);
  } catch (error) {
    // A database that cannot even show its ledger is as unavailable as one
    // that failed a file: answer 503 and retry, not an uncaught 500.
    throw new BundledMigrationError(
      "the schema ledger could not be read",
      null,
      error,
    );
  }
  const applied: string[] = [];
  const appliedConcurrently: string[] = [];
  let alreadyApplied = 0;
  for (const migration of migrations) {
    if (ledger.has(migration.name)) {
      alreadyApplied += 1;
      continue;
    }
    try {
      await db.batch([
        db
          .prepare(`INSERT INTO ${MIGRATION_LEDGER_TABLE} (name) VALUES (?)`)
          .bind(migration.name),
        ...migration.statements.map((statement) => db.prepare(statement)),
      ]);
      applied.push(migration.name);
    } catch (error) {
      // The batch rolled back as a whole. If the ledger now has the file,
      // another isolate won the race; otherwise this is a genuine failure and
      // nothing after it may run.
      if (await isRecorded(db, migration.name).catch(() => false)) {
        appliedConcurrently.push(migration.name);
        continue;
      }
      throw new BundledMigrationError(
        `schema migration ${migration.name} failed and was rolled back`,
        migration.name,
        error,
      );
    }
  }
  return { applied, appliedConcurrently, alreadyApplied };
}

export type BundledSchemaGate = {
  /**
   * Resolve once this isolate has seen the database at the bundled schema.
   * Concurrent callers share one attempt; after a failure the next caller
   * retries, but not sooner than `retryAfterMs`.
   */
  ensure(db: D1MigrationDatabase): Promise<void>;
};

export function createBundledSchemaGate(
  migrations: readonly BundledD1Migration[],
  options: {
    readonly retryAfterMs?: number;
    readonly now?: () => number;
    readonly log?: (event: Record<string, unknown>) => void;
  } = {},
): BundledSchemaGate {
  const retryAfterMs = options.retryAfterMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  const log =
    options.log ??
    ((event: Record<string, unknown>) => {
      const line = JSON.stringify(event);
      if (event.level === "error") console.error(line);
      else console.log(line);
    });
  let done = false;
  let inFlight: Promise<void> | null = null;
  let failure: { at: number; error: unknown } | null = null;

  return {
    ensure(db) {
      if (done) return Promise.resolve();
      if (inFlight) return inFlight;
      if (failure && now() - failure.at < retryAfterMs) {
        return Promise.reject(failure.error);
      }
      inFlight = applyBundledD1Migrations(db, migrations)
        .then((result) => {
          done = true;
          failure = null;
          if (result.applied.length || result.appliedConcurrently.length) {
            log({
              level: "info",
              event: "yurucommu.schema.applied",
              applied: result.applied,
              appliedConcurrently: result.appliedConcurrently,
              alreadyApplied: result.alreadyApplied,
            });
          }
        })
        .catch((error: unknown) => {
          // Only a database failure is worth backing off from. A configuration
          // error is rethrown on every call and cached nowhere.
          if (error instanceof BundledMigrationError) {
            failure = { at: now(), error };
          }
          log({
            level: "error",
            event: "yurucommu.schema.failed",
            migration:
              error instanceof BundledMigrationError ? error.migration : null,
            message: error instanceof Error ? error.message : String(error),
            cause:
              error instanceof Error && error.cause instanceof Error
                ? error.cause.message
                : undefined,
          });
          throw error;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
