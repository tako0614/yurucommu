import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  readBundledD1Migrations,
  splitMigrationStatements,
} from "./bundled-d1-migrations.ts";
import { createEntrySource } from "./build-yurucommu-worker.ts";
import {
  APPLY_BUNDLED_MIGRATIONS_VAR,
  BundledMigrationError,
  BundledSchemaConfigError,
  MIGRATION_LEDGER_DDL,
  applyBundledD1Migrations,
  assertBundledMigrations,
  createBundledSchemaGate,
  resolveApplyBundledMigrations,
  type BundledD1Migration,
  type D1MigrationDatabase,
  type D1MigrationStatement,
} from "./yurucommu-d1-migrations.ts";

const bundled = await readBundledD1Migrations();
const schemaBundle = (await Bun.file(
  new URL("../deploy/takoform/migrations/schema-bundle.json", import.meta.url),
).json()) as { entries: Array<{ name: string; sql: string }> };

type FakeStatement = D1MigrationStatement & {
  readonly sql: string;
  readonly params: unknown[];
};

/**
 * A native-D1-shaped adapter over SQLite: one statement per prepare, and a
 * batch that is one transaction, which is the D1 contract the runner relies
 * on. Foreign keys are enforced, as on D1.
 */
function sqliteD1(db: Database, hooks: { ledgerReads?: () => unknown[] } = {}) {
  const calls = { prepare: 0, batch: 0 };
  const statement = (sql: string, params: unknown[] = []): FakeStatement => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    run: async () => {
      db.query(sql).run(...(params as never[]));
      return { success: true };
    },
    all: async <T>() => {
      if (hooks.ledgerReads && sql.startsWith("SELECT name FROM")) {
        return { results: hooks.ledgerReads() as T[] };
      }
      return { results: db.query(sql).all(...(params as never[])) as T[] };
    },
  });
  const adapter: D1MigrationDatabase & {
    exec(sql: string): Promise<unknown>;
  } = {
    prepare(sql: string) {
      calls.prepare += 1;
      return statement(sql);
    },
    async batch(statements: D1MigrationStatement[]) {
      calls.batch += 1;
      db.run("BEGIN");
      try {
        for (const item of statements as FakeStatement[]) {
          db.query(item.sql).run(...(item.params as never[]));
        }
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ success: true }));
    },
    async exec() {
      throw new Error("the runner must not use exec()");
    },
  };
  return { adapter, calls };
}

function freshDatabase(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

function ledger(db: Database): string[] {
  return (
    db.query("SELECT name FROM yurucommu_migrations ORDER BY id").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function schemaOf(db: Database): unknown[] {
  return db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'yurucommu_migrations' ORDER BY type, name",
    )
    .all();
}

function migration(name: string, statements: string[]): BundledD1Migration {
  return {
    name,
    sha256: "sha256:" + "0".repeat(64),
    statements,
  };
}

describe("splitMigrationStatements", () => {
  test("ends statements only outside strings, names, comments, and trigger bodies", () => {
    expect(
      splitMigrationStatements(`-- leading; comment
CREATE TABLE "semi;colon" (v TEXT DEFAULT 'a;b', [odd;name] INTEGER, \`x;y\` INTEGER);
/* block; comment */
INSERT INTO "semi;colon" (v) VALUES ('it''s; fine');
CREATE TEMP TRIGGER t1 AFTER INSERT ON "semi;colon"
WHEN CASE WHEN NEW.v = 'end' THEN 1 ELSE 0 END
BEGIN
  -- a comment; inside the body
  UPDATE "semi;colon" SET v = CASE WHEN NEW.v IS NULL THEN 'x' ELSE 'y' END;
  SELECT CASE WHEN 1 THEN (CASE WHEN 2 THEN 3 END) END;
END;
CREATE TRIGGER t2 BEFORE DELETE ON "semi;colon" BEGIN SELECT RAISE(ABORT,'no; deletes'); END;
-- trailing comment only`),
    ).toEqual([
      `CREATE TABLE "semi;colon" (v TEXT DEFAULT 'a;b', [odd;name] INTEGER, \`x;y\` INTEGER);`,
      `INSERT INTO "semi;colon" (v) VALUES ('it''s; fine');`,
      `CREATE TEMP TRIGGER t1 AFTER INSERT ON "semi;colon"
WHEN CASE WHEN NEW.v = 'end' THEN 1 ELSE 0 END
BEGIN
  -- a comment; inside the body
  UPDATE "semi;colon" SET v = CASE WHEN NEW.v IS NULL THEN 'x' ELSE 'y' END;
  SELECT CASE WHEN 1 THEN (CASE WHEN 2 THEN 3 END) END;
END;`,
      `CREATE TRIGGER t2 BEFORE DELETE ON "semi;colon" BEGIN SELECT RAISE(ABORT,'no; deletes'); END;`,
    ]);
  });

  test("refuses unterminated input instead of guessing a boundary", () => {
    expect(() => splitMigrationStatements("SELECT 'open")).toThrow();
    expect(() => splitMigrationStatements("SELECT 1 /* open")).toThrow();
    expect(() =>
      splitMigrationStatements(
        "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1;",
      ),
    ).toThrow();
  });
});

describe("bundled schema source", () => {
  test("embeds every locked schema-bundle file in order", () => {
    expect(bundled.map((entry) => entry.name)).toEqual(
      schemaBundle.entries.map((entry) => entry.name),
    );
    expect(bundled.length).toBeGreaterThan(30);
    for (const entry of bundled) {
      expect(entry.statements.length).toBeGreaterThan(0);
    }
    // The D1-safe 0003 rebuild, not the core file whose FK disable D1 ignores.
    const rebuild = bundled.find((entry) => entry.name.startsWith("0003_"))!;
    expect(rebuild.statements[0]).toBe("PRAGMA defer_foreign_keys = TRUE;");
    expect(rebuild.statements.join("\n")).not.toContain("foreign_keys = OFF");
  });

  test("every piece is exactly one statement and together they equal whole-file execution", () => {
    // A prepared statement compiles only its first statement, like a native
    // D1 prepare; exec() runs them all. Any piece holding two statements makes
    // the two databases diverge.
    const prepared = freshDatabase();
    const executed = freshDatabase();
    const wholeFile = freshDatabase();
    for (const [index, entry] of bundled.entries()) {
      prepared.transaction(() => {
        for (const statement of entry.statements) {
          prepared.query(statement).run();
        }
      })();
      executed.transaction(() => {
        for (const statement of entry.statements) executed.run(statement);
      })();
      wholeFile.transaction(() =>
        wholeFile.run(schemaBundle.entries[index]!.sql),
      )();
      expect(schemaOf(prepared)).toEqual(schemaOf(executed));
    }
    expect(schemaOf(prepared)).toEqual(schemaOf(wholeFile));
    expect(schemaOf(prepared).length).toBeGreaterThan(50);
  });
});

describe("applyBundledD1Migrations", () => {
  test("brings a fresh database to the bundle in order and is then a no-op", async () => {
    const db = freshDatabase();
    const { adapter, calls } = sqliteD1(db);
    const first = await applyBundledD1Migrations(adapter, bundled);
    expect(first.applied).toEqual(bundled.map((entry) => entry.name));
    expect(first.alreadyApplied).toBe(0);
    expect(ledger(db)).toEqual(bundled.map((entry) => entry.name));
    expect(calls.batch).toBe(bundled.length);

    const reference = freshDatabase();
    for (const entry of schemaBundle.entries) {
      reference.transaction(() => reference.run(entry.sql))();
    }
    expect(schemaOf(db)).toEqual(schemaOf(reference));

    const second = await applyBundledD1Migrations(adapter, bundled);
    expect(second).toEqual({
      applied: [],
      appliedConcurrently: [],
      alreadyApplied: bundled.length,
    });
    expect(calls.batch).toBe(bundled.length);
  });

  test("a racing writer that read a stale ledger changes nothing and records no duplicate", async () => {
    const db = freshDatabase();
    await applyBundledD1Migrations(sqliteD1(db).adapter, bundled);
    const before = schemaOf(db);
    const { adapter: stale } = sqliteD1(db, { ledgerReads: () => [] });
    const raced = await applyBundledD1Migrations(stale, bundled);
    expect(raced.applied).toEqual([]);
    expect(raced.appliedConcurrently).toEqual(
      bundled.map((entry) => entry.name),
    );
    expect(ledger(db)).toEqual(bundled.map((entry) => entry.name));
    expect(schemaOf(db)).toEqual(before);
  });

  test("a failing file rolls back whole, stops the run, and resumes once fixed", async () => {
    const db = freshDatabase();
    const { adapter } = sqliteD1(db);
    const ok = migration("0001_ok.sql", [
      "CREATE TABLE first_table (id INTEGER)",
    ]);
    const broken = migration("0002_broken.sql", [
      "CREATE TABLE partial_table (id INTEGER)",
      "INSERT INTO table_that_does_not_exist VALUES (1)",
    ]);
    const later = migration("0003_later.sql", [
      "CREATE TABLE later_table (id INTEGER)",
    ]);

    const failure = await applyBundledD1Migrations(adapter, [
      ok,
      broken,
      later,
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BundledMigrationError);
    expect((failure as BundledMigrationError).migration).toBe(
      "0002_broken.sql",
    );
    expect(ledger(db)).toEqual(["0001_ok.sql"]);
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toContain("first_table");
    expect(tables).not.toContain("partial_table");
    expect(tables).not.toContain("later_table");

    const fixed = migration("0002_broken.sql", [
      "CREATE TABLE partial_table (id INTEGER)",
    ]);
    const resumed = await applyBundledD1Migrations(adapter, [ok, fixed, later]);
    expect(resumed.applied).toEqual(["0002_broken.sql", "0003_later.sql"]);
    expect(resumed.alreadyApplied).toBe(1);
  });

  test("shares the wrangler/core ledger and leaves rows it does not know alone", async () => {
    const db = freshDatabase();
    // The shape `wrangler d1 migrations apply` creates for migrations_table.
    db.run(
      "CREATE TABLE yurucommu_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    for (const entry of bundled.slice(0, 3)) {
      db.transaction(() => {
        for (const statement of entry.statements) db.run(statement);
        db.query("INSERT INTO yurucommu_migrations (name) VALUES (?)").run(
          entry.name,
        );
      })();
    }
    db.query("INSERT INTO yurucommu_migrations (name) VALUES (?)").run(
      "9999_from_a_newer_release.sql",
    );
    const result = await applyBundledD1Migrations(
      sqliteD1(db).adapter,
      bundled,
    );
    expect(result.alreadyApplied).toBe(3);
    expect(result.applied).toEqual(bundled.slice(3).map((entry) => entry.name));
    expect(ledger(db)).toContain("9999_from_a_newer_release.sql");
    expect(ledger(db).length).toBe(bundled.length + 1);
  });

  test("a ledger that cannot be created or read is a migration failure", async () => {
    const failing: D1MigrationDatabase = {
      prepare: () => ({
        bind() {
          return this;
        },
        run: async () => {
          throw new Error("D1_ERROR: storage unavailable");
        },
        all: async () => ({ results: [] }),
      }),
      batch: async () => [],
    };
    const error = await applyBundledD1Migrations(failing, bundled).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BundledMigrationError);
    expect((error as BundledMigrationError).migration).toBeNull();
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  test("uses the core runner's ledger DDL", () => {
    expect(MIGRATION_LEDGER_DDL).toContain(
      "CREATE TABLE IF NOT EXISTS yurucommu_migrations",
    );
    expect(MIGRATION_LEDGER_DDL).toContain("name TEXT UNIQUE NOT NULL");
  });
});

describe("opt-in and bundle validation", () => {
  test("only an explicit true opts in; an unknown value refuses", () => {
    for (const off of [undefined, null, "", "false", " false "]) {
      expect(resolveApplyBundledMigrations(off)).toBe(false);
    }
    expect(resolveApplyBundledMigrations("true")).toBe(true);
    expect(resolveApplyBundledMigrations(" true ")).toBe(true);
    for (const bad of ["yes", "1", "TRUE", true, 1]) {
      expect(() => resolveApplyBundledMigrations(bad)).toThrow(
        BundledSchemaConfigError,
      );
    }
  });

  test("a malformed or empty embedded bundle is a configuration error", () => {
    expect(() => assertBundledMigrations([])).toThrow(BundledSchemaConfigError);
    const good = bundled[0]!;
    expect(() => assertBundledMigrations([bundled[1]!, good])).toThrow(
      BundledSchemaConfigError,
    );
    expect(() =>
      assertBundledMigrations([{ ...good, statements: [] }]),
    ).toThrow(BundledSchemaConfigError);
    expect(() =>
      assertBundledMigrations([{ ...good, sha256: "sha256:nope" }]),
    ).toThrow(BundledSchemaConfigError);
    expect(() => assertBundledMigrations(bundled)).not.toThrow();
  });
});

describe("createBundledSchemaGate", () => {
  test("concurrent callers share one attempt and later callers touch nothing", async () => {
    const db = freshDatabase();
    const { adapter, calls } = sqliteD1(db);
    const gate = createBundledSchemaGate(bundled, { log: () => undefined });
    await Promise.all([
      gate.ensure(adapter),
      gate.ensure(adapter),
      gate.ensure(adapter),
    ]);
    expect(calls.batch).toBe(bundled.length);
    const prepares = calls.prepare;
    await gate.ensure(adapter);
    expect(calls.prepare).toBe(prepares);
  });

  test("a configuration error is never cached as a retryable failure", async () => {
    const events: Record<string, unknown>[] = [];
    const gate = createBundledSchemaGate([], {
      now: () => 1_000,
      log: (event) => events.push(event),
    });
    const { adapter } = sqliteD1(freshDatabase());
    await expect(gate.ensure(adapter)).rejects.toBeInstanceOf(
      BundledSchemaConfigError,
    );
    await expect(gate.ensure(adapter)).rejects.toBeInstanceOf(
      BundledSchemaConfigError,
    );
    // Evaluated (and logged) again on the second call, not served from cache.
    expect(events.length).toBe(2);
  });

  test("a failure is retried only after the retry window", async () => {
    const db = freshDatabase();
    const { adapter, calls } = sqliteD1(db);
    let clock = 1_000;
    const events: Record<string, unknown>[] = [];
    const broken = [
      migration("0001_broken.sql", ["INSERT INTO missing_table VALUES (1)"]),
    ];
    const gate = createBundledSchemaGate(broken, {
      retryAfterMs: 5_000,
      now: () => clock,
      log: (event) => events.push(event),
    });
    await expect(gate.ensure(adapter)).rejects.toBeInstanceOf(
      BundledMigrationError,
    );
    const batches = calls.batch;
    clock += 4_999;
    await expect(gate.ensure(adapter)).rejects.toBeInstanceOf(
      BundledMigrationError,
    );
    expect(calls.batch).toBe(batches);
    clock += 1;
    await expect(gate.ensure(adapter)).rejects.toBeInstanceOf(
      BundledMigrationError,
    );
    expect(calls.batch).toBe(batches + 1);
    expect(events[0]).toMatchObject({
      level: "error",
      event: "yurucommu.schema.failed",
      migration: "0001_broken.sql",
    });
  });
});

describe("generated entry", () => {
  const files: URL[] = [];
  afterAll(async () => {
    await Promise.all(files.map((file) => rm(file, { force: true })));
  });

  async function loadEntry(
    migrations: readonly BundledD1Migration[],
    label: string,
  ) {
    await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
    const file = new URL(
      `../dist/yurucommu-entry.d1-schema-${label}.generated.ts`,
      import.meta.url,
    );
    files.push(file);
    await writeFile(file, createEntrySource({}, "default", migrations));
    return (await import(pathToFileURL(file.pathname).href)) as {
      default: {
        fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
        queue(batch: unknown, env: unknown, ctx: unknown): Promise<void>;
        scheduled(
          controller: unknown,
          env: unknown,
          ctx: unknown,
        ): Promise<void>;
      };
    };
  }

  const kv = () => ({
    get: async () => null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, listComplete: true }),
  });
  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };

  function env(db: unknown, overrides: Record<string, unknown> = {}) {
    return {
      DB: db,
      KV: kv(),
      APP_URL: "https://yurucommu.example.test",
      YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
      AUTH_PASSWORD_HASH: "synthetic-bootstrap",
      ENCRYPTION_KEY: "00".repeat(32),
      DELIVERY_QUEUE_NAME: "configured-delivery",
      DELIVERY_DLQ_NAME: "configured-delivery-dlq",
      ...overrides,
    };
  }

  test("an opted-in cloudflare Worker migrates its own D1 before serving", async () => {
    const { default: worker } = await loadEntry(bundled, "apply");
    const db = freshDatabase();
    const { adapter } = sqliteD1(db);
    const response = await worker.fetch(
      new Request("https://yurucommu.example.test/healthz"),
      env(adapter, { [APPLY_BUNDLED_MIGRATIONS_VAR]: "true" }),
      ctx,
    );
    expect(response.status).not.toBe(503);
    expect(ledger(db)).toEqual(bundled.map((entry) => entry.name));
  });

  test("queue and scheduled work also run only against the bundled schema", async () => {
    const { default: worker } = await loadEntry(bundled, "background");
    const queueDb = freshDatabase();
    const settled: string[] = [];
    await worker.queue(
      {
        queue: "configured-delivery",
        messages: [],
        ackAll: () => settled.push("ackAll"),
        retryAll: () => settled.push("retryAll"),
      },
      env(sqliteD1(queueDb).adapter, {
        [APPLY_BUNDLED_MIGRATIONS_VAR]: "true",
      }),
      ctx,
    );
    expect(ledger(queueDb)).toEqual(bundled.map((entry) => entry.name));
  });

  test("without the opt-in the Worker never touches the schema", async () => {
    const { default: worker } = await loadEntry(bundled, "off");
    const db = freshDatabase();
    const { adapter, calls } = sqliteD1(db);
    await worker.fetch(
      new Request("https://yurucommu.example.test/healthz"),
      env(adapter),
      ctx,
    );
    expect(calls.batch).toBe(0);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name = 'yurucommu_migrations'",
        )
        .all(),
    ).toEqual([]);
  });

  test("a failed migration answers 503 without the SQL error, and background work is retried", async () => {
    const { default: worker } = await loadEntry(
      [migration("0001_broken.sql", ["INSERT INTO missing_table VALUES (1)"])],
      "broken",
    );
    const db = freshDatabase();
    const { adapter } = sqliteD1(db);
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const response = await worker.fetch(
        new Request("https://yurucommu.example.test/healthz"),
        env(adapter, { [APPLY_BUNDLED_MIGRATIONS_VAR]: "true" }),
        ctx,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      const body = await response.text();
      expect(body).toContain("schema_unavailable");
      expect(body).not.toContain("missing_table");
      await expect(
        worker.scheduled(
          {},
          env(adapter, { [APPLY_BUNDLED_MIGRATIONS_VAR]: "true" }),
          ctx,
        ),
      ).rejects.toBeInstanceOf(BundledMigrationError);
      // The batch is handed back with a growing delay, never acknowledged and
      // never thrown into an immediate retry that would exhaust max_retries.
      for (const [attempts, delaySeconds] of [
        [1, 60],
        [2, 240],
        [3, 960],
        [9, 3600],
      ] as const) {
        const settled: unknown[] = [];
        await worker.queue(
          {
            queue: "configured-delivery",
            messages: [
              {
                id: `m${attempts}`,
                timestamp: new Date(0),
                body: {},
                attempts,
                ack: () => settled.push("ack"),
                retry: () => settled.push("retry"),
              },
            ],
            ackAll: () => settled.push("ackAll"),
            retryAll: (options?: { delaySeconds?: number }) =>
              settled.push(["retryAll", options?.delaySeconds]),
          },
          env(adapter, { [APPLY_BUNDLED_MIGRATIONS_VAR]: "true" }),
          ctx,
        );
        expect(settled).toEqual([["retryAll", delaySeconds]]);
      }
    } finally {
      console.error = originalError;
    }
  });

  test("an unreadable ledger is a 503, not an uncaught 500", async () => {
    const { default: worker } = await loadEntry(bundled, "unreadable");
    const unreachable = {
      prepare: () => ({
        bind() {
          return this;
        },
        run: async () => {
          throw new Error("D1_ERROR: storage unavailable");
        },
        all: async () => {
          throw new Error("D1_ERROR: storage unavailable");
        },
      }),
      batch: async () => {
        throw new Error("D1_ERROR: storage unavailable");
      },
      exec: async () => {
        throw new Error("D1_ERROR: storage unavailable");
      },
    };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const response = await worker.fetch(
        new Request("https://yurucommu.example.test/healthz"),
        env(unreachable, { [APPLY_BUNDLED_MIGRATIONS_VAR]: "true" }),
        ctx,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.text()).not.toContain("storage unavailable");
    } finally {
      console.error = originalError;
    }
  });

  test("the opt-in is refused on the portable lane and for unknown values", async () => {
    const { default: worker } = await loadEntry(bundled, "refuse");
    const edgeSql = {
      execute: async () => ({ rows: [], rowsWritten: 0 }),
      query: async () => ({ rows: [], rowsWritten: 0 }),
      transaction: async () => [],
    };
    await expect(
      worker.fetch(
        new Request("https://yurucommu.example.test/healthz"),
        env(edgeSql, {
          YURUCOMMU_RUNTIME_LANE: "portable",
          [APPLY_BUNDLED_MIGRATIONS_VAR]: "true",
        }),
        ctx,
      ),
    ).rejects.toThrow(/requires the cloudflare runtime lane/);
    const { adapter } = sqliteD1(freshDatabase());
    await expect(
      worker.fetch(
        new Request("https://yurucommu.example.test/healthz"),
        env(adapter, { [APPLY_BUNDLED_MIGRATIONS_VAR]: "yes" }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});
