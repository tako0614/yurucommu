import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyFreshIntegrationSchema,
  integrationSchemaTestSupport,
} from "./deploy-integration-schema.mjs";

const repo = resolve(import.meta.dir, "..");
const accountId = "a".repeat(32);
const databaseId = "11111111-2222-4333-8444-555555555555";
const token = "synthetic-test-token";
const expectedDatabaseName = "yurucommu-ga-20261012-0938-db";
const expectedWorkerName = "yurucommu-ga-20261012-0938";
const names = integrationSchemaTestSupport.migrationNames;
const privateDirs: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of privateDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function diagnosticsDir() {
  const path = mkdtempSync(join(tmpdir(), "commu-d1-diagnostics-"));
  chmodSync(path, 0o700);
  privateDirs.push(path);
  return path;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function queryResult(results: unknown[] = [], success = true) {
  return { success: true, result: [{ success, results }] };
}

// SQLite executes the actual immutable scripts, including nested CASE triggers.
// Its explicit transaction is a portable fixture only; live REST atomicity must
// still be qualified by the identical whole-script duplicate-key probe.
function fixture(
  options: {
    wrongDatabase?: boolean;
    workerPresent?: boolean;
    workerRows?: unknown[];
    workerError?: boolean;
    identityErrors?: boolean;
    existingTables?: string[];
    initialSql?: string;
    probe?: "atomic" | "partial" | "success" | "wrong-error" | "transport";
    migrationFailureAt?: number;
    migrationTimeoutAt?: number;
    contradictoryErrors?: "top" | "row";
    emptyMigrationResults?: boolean;
    ledgerPrefixMismatchAt?: number;
    readResultCount?: number;
  } = {},
) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  if (options.initialSql) db.exec(options.initialSql);
  for (const name of options.existingTables ?? []) {
    db.exec(`CREATE TABLE "${name}" (id TEXT)`);
  }
  let migrationScripts = 0;
  const fetchImpl: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch> = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.includes("/workers/scripts")) {
      return json({
        success: true,
        result:
          options.workerRows ??
          (options.workerPresent ? [{ id: expectedWorkerName }] : []),
        ...(options.workerError ? { error: "inventory denied" } : {}),
      });
    }
    if (!url.includes(`/d1/database/${databaseId}`))
      throw new Error("unknown fixture URL");
    if (method === "GET") {
      return json({
        success: true,
        ...(options.identityErrors
          ? { errors: [{ message: "identity denied" }] }
          : {}),
        result: {
          uuid: options.wrongDatabase
            ? "99999999-2222-4333-8444-555555555555"
            : databaseId,
          name: expectedDatabaseName,
          ...(options.wrongDatabase ? { diagnosticEcho: token } : {}),
        },
      });
    }
    if (
      method !== "POST" ||
      !url.endsWith("/query") ||
      typeof body?.sql !== "string" ||
      "batch" in body
    ) {
      throw new Error("fixture accepts only whole-script sql requests");
    }
    const sql: string = body.sql;
    if (/^SELECT\b/i.test(sql)) {
      let rows = db.query(sql).all();
      if (
        sql === "SELECT name FROM yurucommu_migrations ORDER BY id" &&
        options.ledgerPrefixMismatchAt === migrationScripts
      )
        rows = [];
      if (options.readResultCount !== undefined) {
        return json({
          success: true,
          result: Array.from({ length: options.readResultCount }, () => ({
            success: true,
            results: rows,
          })),
        });
      }
      return json(queryResult(rows));
    }
    if (
      sql.startsWith(`CREATE TABLE ${integrationSchemaTestSupport.probeTable}`)
    ) {
      if (options.probe === "success") return json(queryResult());
      if (options.probe === "wrong-error") {
        return json(
          {
            success: false,
            errors: [{ message: "temporary unavailable" }],
            result: [],
          },
          503,
        );
      }
      try {
        if (options.probe === "partial") db.exec(sql);
        else db.transaction(() => db.exec(sql))();
        throw new Error("duplicate-key SQL unexpectedly succeeded");
      } catch (error) {
        if (options.probe === "transport")
          throw new Error("probe acknowledgement lost");
        return json(
          { success: false, errors: [{ message: String(error) }], result: [] },
          400,
        );
      }
    }
    if (!/^\s*CREATE TABLE IF NOT EXISTS yurucommu_migrations\b/.test(sql)) {
      throw new Error("unknown fixture mutation");
    }
    const isMigration = sql.includes("INSERT INTO yurucommu_migrations");
    if (isMigration) {
      migrationScripts += 1;
      if (options.contradictoryErrors) {
        return json({
          success: true,
          errors:
            options.contradictoryErrors === "top"
              ? [{ message: "query failed" }]
              : [],
          result: [
            {
              success: true,
              errors:
                options.contradictoryErrors === "row"
                  ? [{ message: "query failed" }]
                  : [],
            },
          ],
        });
      }
      if (options.migrationFailureAt === migrationScripts) {
        return json({
          success: true,
          result: [{ success: true }, { success: false }],
        });
      }
      if (options.emptyMigrationResults)
        return json({ success: true, result: [] });
    }
    db.transaction(() => db.exec(sql))();
    if (isMigration && options.migrationTimeoutAt === migrationScripts)
      throw new Error("migration acknowledgement lost");
    // Whole-script REST responses need not have a source-invented statement count.
    return isMigration
      ? json({
          success: true,
          result: [{ success: true }, { success: true, results: [] }],
        })
      : json(queryResult());
  };
  return {
    fetchImpl,
    calls,
    db,
    get ledger() {
      const exists = db
        .query(
          "SELECT name FROM sqlite_master WHERE name='yurucommu_migrations'",
        )
        .get();
      return exists
        ? (
            db
              .query("SELECT name FROM yurucommu_migrations ORDER BY id")
              .all() as Array<{ name: string }>
          ).map((row) => row.name)
        : [];
    },
    get migrationScripts() {
      return migrationScripts;
    },
  };
}

function args(
  fetchImpl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
  privateDiagnostics = diagnosticsDir(),
) {
  return {
    accountId,
    databaseId,
    token,
    repo,
    diagnosticsDir: privateDiagnostics,
    fetchImpl,
  };
}

test("pins the installed Core runner, all 35 SQL digests, and matching schema bundle", async () => {
  const inputs = await integrationSchemaTestSupport.verifyCoreInputs(repo);
  expect(names).toHaveLength(35);
  expect(names.at(-1)).toBe("0036_notification_push_actor_fk_repair.sql");
  expect(inputs.applyMigrations).toBeFunction();
});

test("runner script guard rejects injected SQL, altered pinned bytes, wrong names and timestamps", () => {
  const migration = "0001_init.sql";
  const raw = readFileSync(
    resolve(repo, "node_modules/@takosjp/yurucommu-core/migrations", migration),
    "utf8",
  );
  const prefix =
    "CREATE TABLE IF NOT EXISTS yurucommu_migrations (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT UNIQUE NOT NULL,\n  applied_at TEXT NOT NULL\n);";
  const mark =
    "INSERT INTO yurucommu_migrations (name, applied_at) VALUES ('0001_init.sql', '2026-10-12T10:00:00.000Z');";
  const script = `${prefix}\n${raw.trim()}\n${mark}\n`;
  expect(
    integrationSchemaTestSupport.assertMigrationScript(script, migration, raw),
  ).toBe(script);
  const changedRaw = `${raw.trim()}\n-- unpinned after preflight`;
  const changedScript = `${prefix}\n${changedRaw}\n${mark}\n`;
  expect(() =>
    integrationSchemaTestSupport.assertMigrationScript(
      changedScript,
      migration,
      changedRaw,
    ),
  ).toThrow("SQL bytes changed after preflight");
  for (const changed of [
    `DROP TABLE actors;\n${script}`,
    `${script}DELETE FROM yurucommu_migrations;`,
    script.replace(raw.trim(), "SELECT 1;"),
    script.replace("'0001_init.sql'", "'0002_social_remote_actor_edges.sql'"),
    script.replace("2026-10-12T10:00:00.000Z", "not-a-date"),
  ])
    expect(() =>
      integrationSchemaTestSupport.assertMigrationScript(
        changed,
        migration,
        raw,
      ),
    ).toThrow();
});

test("empty-schema SQL ignores only the exact reserved platform tables", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID; CREATE TABLE _cf_METADATA (id TEXT)",
    );
    expect(db.query(integrationSchemaTestSupport.emptySchemaSql).all()).toEqual(
      [],
    );

    db.exec(
      "CREATE TABLE actors (id TEXT); CREATE TABLE xcfXfoo (id TEXT); CREATE TABLE sqlitexfoo (id TEXT); CREATE TABLE _cf_fake (id TEXT)",
    );
    const rows = db
      .query(integrationSchemaTestSupport.emptySchemaSql)
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual([
      "_cf_fake",
      "actors",
      "sqlitexfoo",
      "xcfXfoo",
    ]);
  } finally {
    db.close();
  }

  const nonTable = new Database(":memory:");
  try {
    nonTable.exec(
      "CREATE TABLE source_table (id TEXT); CREATE VIEW _cf_METADATA AS SELECT id FROM source_table; CREATE TRIGGER _cf_KV AFTER INSERT ON source_table BEGIN SELECT 1; END",
    );
    const rows = nonTable
      .query(integrationSchemaTestSupport.emptySchemaSql)
      .all() as Array<{ type: string; name: string }>;
    expect(rows).toEqual([
      { type: "table", name: "source_table" },
      { type: "trigger", name: "_cf_KV" },
      { type: "view", name: "_cf_METADATA" },
    ]);
  } finally {
    nonTable.close();
  }
});

test("empty-schema guard admits reserved-only D1 state and refuses foreign objects before writes", async () => {
  const reservedSql =
    "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID; CREATE TABLE _cf_METADATA (id TEXT)";
  const accepted = fixture({ initialSql: reservedSql });
  await muted(async () => {
    await applyFreshIntegrationSchema(args(accepted.fetchImpl));
  });
  expect(accepted.migrationScripts).toBe(35);

  const rejected = fixture({
    initialSql: `${reservedSql}; CREATE TABLE _cf_lookalike (id TEXT); CREATE VIEW app_view AS SELECT 1;`,
  });
  await expect(
    applyFreshIntegrationSchema(args(rejected.fetchImpl)),
  ).rejects.toThrow("D1 is not empty");
  expect(rejected.migrationScripts).toBe(0);
  expect(
    rejected.calls.some(
      (call) =>
        call.method === "POST" &&
        typeof call.body?.sql === "string" &&
        !/^SELECT\b/i.test(call.body.sql),
    ),
  ).toBe(false);
});

test("whole-script executor applies all 35 immutable migrations and nested triggers with each exact ledger prefix", async () => {
  const f = fixture();
  await muted(async () => {
    const result = await applyFreshIntegrationSchema(args(f.fetchImpl));
    expect(result).toMatchObject({
      status: "APPLIED",
      databaseId,
      coreVersion: "4.1.14",
      migrationCount: 35,
      mapSha256: integrationSchemaTestSupport.migrationMapSha256,
    });
  });
  expect(f.ledger).toEqual([...names]);
  expect(f.migrationScripts).toBe(35);
  expect(f.calls.every((call) => !call.body || !("batch" in call.body))).toBe(
    true,
  );
  const writes = f.calls.filter(
    (call) => call.method === "POST" && !/^SELECT\b/.test(call.body.sql),
  );
  expect(writes).toHaveLength(37); // atomicity probe, ledger init, 35 scripts
  expect(writes[0].body.sql).toContain("'duplicate'");
  for (const migration of names) {
    const raw = readFileSync(
      resolve(
        repo,
        "node_modules/@takosjp/yurucommu-core/migrations",
        migration,
      ),
      "utf8",
    );
    const call = writes.find((call) =>
      call.body.sql.includes(`VALUES ('${migration}',`),
    );
    expect(call).toBeDefined();
    expect(call!.body.sql).toContain(raw.trim());
  }
  const prefixReads = f.calls.filter(
    (call) =>
      call.body?.sql === "SELECT name FROM yurucommu_migrations ORDER BY id",
  );
  expect(prefixReads).toHaveLength(36);
  const triggers = f.db
    .query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string; sql: string }>;
  expect(triggers.length).toBeGreaterThan(0);
  expect(triggers.some((row) => /CASE[\s\S]*CASE/.test(row.sql))).toBe(true);
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

async function muted(action: () => Promise<void>) {
  const oldLog = console.log;
  const oldWarn = console.warn;
  try {
    console.log = () => {};
    console.warn = () => {};
    await action();
  } finally {
    console.log = oldLog;
    console.warn = oldWarn;
  }
}

test("foreign D1 identity and pre-existing schema refuse before any write", async () => {
  const foreign = fixture({ wrongDatabase: true });
  await expect(
    applyFreshIntegrationSchema(args(foreign.fetchImpl)),
  ).rejects.toThrow("D1 identity");
  expect(foreign.calls).toHaveLength(1);
  expect(foreign.calls.some((call) => call.method === "POST")).toBe(false);

  const nonfresh = fixture({ existingTables: ["actors"] });
  await expect(
    applyFreshIntegrationSchema(args(nonfresh.fetchImpl)),
  ).rejects.toThrow("not empty");
  expect(
    nonfresh.calls.some(
      (call) => call.body?.sql && !/^SELECT\b/.test(call.body.sql),
    ),
  ).toBe(false);
  expect(nonfresh.calls.filter((call) => call.method === "POST")).toHaveLength(
    1,
  );

  const wildcardLookalike = fixture({ existingTables: ["xcfXfoo"] });
  await expect(
    applyFreshIntegrationSchema(args(wildcardLookalike.fetchImpl)),
  ).rejects.toThrow("not empty");
  expect(
    wildcardLookalike.calls.some(
      (call) => call.body?.sql && !/^SELECT\b/.test(call.body.sql),
    ),
  ).toBe(false);
});

test("raw provider failure evidence stays token-redacted in a 0600 private log", async () => {
  const f = fixture({ wrongDatabase: true });
  const privateDiagnostics = diagnosticsDir();
  await expect(
    applyFreshIntegrationSchema(args(f.fetchImpl, privateDiagnostics)),
  ).rejects.toThrow("private diagnostics:");
  const files = readdirSync(privateDiagnostics);
  expect(files).toHaveLength(1);
  const path = join(privateDiagnostics, files[0]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const evidence = readFileSync(path, "utf8");
  expect(evidence).toContain("diagnosticEcho");
  expect(evidence).toContain("[REDACTED]");
  expect(evidence).not.toContain(token);
});

test("an already-present Worker refuses the schema write phase", async () => {
  const f = fixture({ workerPresent: true });
  await expect(applyFreshIntegrationSchema(args(f.fetchImpl))).rejects.toThrow(
    "Worker already exists",
  );
  expect(f.calls.some((call) => call.method === "POST")).toBe(false);
});

test("partial whole-script probe persistence stops with no cleanup or schema migration", async () => {
  const f = fixture({ probe: "partial" });
  await expect(applyFreshIntegrationSchema(args(f.fetchImpl))).rejects.toThrow(
    "probe left D1 state",
  );
  const queryCalls = f.calls.filter((call) => call.method === "POST");
  expect(queryCalls).toHaveLength(3);
  expect(
    queryCalls.filter((call) => !/^SELECT\b/.test(call.body.sql)),
  ).toHaveLength(1);
  expect(queryCalls.some((call) => call.body.sql.includes("DROP TABLE"))).toBe(
    false,
  );
  expect(f.migrationScripts).toBe(0);
});

test("atomicity proof refuses unexpected success or a different error", async () => {
  for (const probe of ["success", "wrong-error"] as const) {
    const f = fixture({ probe });
    await expect(
      applyFreshIntegrationSchema(args(f.fetchImpl)),
    ).rejects.toThrow(
      probe === "success"
        ? "unexpectedly succeeded"
        : "expected duplicate-key failure",
    );
    expect(f.migrationScripts).toBe(0);
  }
});

test("a per-result failed migration stops once without retry", async () => {
  const f = fixture({ migrationFailureAt: 1 });
  await muted(async () => {
    await expect(
      applyFreshIntegrationSchema(args(f.fetchImpl)),
    ).rejects.toThrow("unsuccessful query result");
  });
  expect(f.migrationScripts).toBe(1);
  expect(f.ledger).toEqual([]);
});

test("empty migration result arrays stop before the next migration", async () => {
  const f = fixture({ emptyMigrationResults: true });
  await muted(async () => {
    await expect(
      applyFreshIntegrationSchema(args(f.fetchImpl)),
    ).rejects.toThrow();
  });
  expect(f.migrationScripts).toBe(1);
});

test("ledger prefix mismatch stops before applying the next file", async () => {
  const f = fixture({ ledgerPrefixMismatchAt: 1 });
  await muted(async () => {
    await expect(
      applyFreshIntegrationSchema(args(f.fetchImpl)),
    ).rejects.toThrow("ledger diverged");
  });
  expect(f.migrationScripts).toBe(1);
  expect(f.ledger).toEqual([names[0]]);
});

test("read queries retain strict single-result validation", async () => {
  const f = fixture({ readResultCount: 2 });
  await expect(applyFreshIntegrationSchema(args(f.fetchImpl))).rejects.toThrow(
    "mismatched result count",
  );
  expect(f.migrationScripts).toBe(0);
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});

test("probe transport uncertainty only reads back and never starts migrations", async () => {
  const f = fixture({ probe: "transport" });
  await expect(applyFreshIntegrationSchema(args(f.fetchImpl))).rejects.toThrow(
    "indeterminate",
  );
  expect(f.migrationScripts).toBe(0);
  expect(
    f.calls.filter(
      (call) => call.method === "POST" && !/^SELECT\b/.test(call.body.sql),
    ),
  ).toHaveLength(1);
});

test("lost migration acknowledgement never replays a committed file", async () => {
  const f = fixture({ migrationTimeoutAt: 1 });
  await muted(async () => {
    await expect(
      applyFreshIntegrationSchema(args(f.fetchImpl)),
    ).rejects.toThrow();
  });
  expect(f.migrationScripts).toBe(1);
  expect(f.ledger).toEqual([names[0]]);
});

test("contradictory success envelopes with explicit errors stop without replay", async () => {
  for (const contradictoryErrors of ["top", "row"] as const) {
    const f = fixture({ contradictoryErrors });
    await muted(async () => {
      await expect(
        applyFreshIntegrationSchema(args(f.fetchImpl)),
      ).rejects.toThrow();
    });
    expect(f.migrationScripts).toBe(1);
    expect(f.ledger).toEqual([]);
  }
});

test("malformed Worker inventory cannot prove closed writers for schema mutation", async () => {
  for (const workerRows of [[null], [{}], [{ id: "" }], [{ id: 42 }]]) {
    const f = fixture({ workerRows });
    await expect(
      applyFreshIntegrationSchema(args(f.fetchImpl)),
    ).rejects.toThrow("cannot prove writers are closed");
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  }
});

test("identity and closed-writer checks refuse contradictory explicit errors before any SQL", async () => {
  for (const options of [{ identityErrors: true }, { workerError: true }]) {
    const f = fixture(options);
    await expect(
      applyFreshIntegrationSchema(args(f.fetchImpl)),
    ).rejects.toThrow();
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  }
});
