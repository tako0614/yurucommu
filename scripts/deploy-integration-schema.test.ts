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
import { unstable_splitSqlQuery } from "wrangler";
import {
  applyFreshIntegrationSchema,
  integrationSchemaTestSupport,
  recoverPrefix32IntegrationSchema,
} from "./deploy-integration-schema.mjs";

const repo = resolve(import.meta.dir, "..");
const accountId = "a".repeat(32);
const databaseId = "11111111-2222-4333-8444-555555555555";
const token = "synthetic-test-token";
const expectedDatabaseName = "yurucommu-ga-20261012-0938-db";
const expectedWorkerName = "yurucommu-ga-20261012-0938";
const names = integrationSchemaTestSupport.migrationNames;
const coreLedgerInitSql = `CREATE TABLE IF NOT EXISTS yurucommu_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )`;
const ledgerCreateSql = `CREATE TABLE IF NOT EXISTS yurucommu_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  applied_at TEXT NOT NULL
);`;
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

function writeStatements(call: { body?: any }): string[] {
  if (Array.isArray(call.body?.batch))
    return call.body.batch.map((entry: { sql: string }) => entry.sql);
  return typeof call.body?.sql === "string" ? [call.body.sql] : [];
}

function isWriteCall(call: { method: string; body?: any }) {
  return (
    call.method === "POST" &&
    writeStatements(call).some(
      (sql: string) => !/^(?:SELECT|PRAGMA)\b/i.test(sql),
    )
  );
}

// SQLite executes the actual immutable scripts, including nested CASE triggers.
// Its explicit transaction is fixture behavior only; it does not establish REST
// batch atomicity, which the live pre-migration probe must qualify separately.
function fixture(
  options: {
    wrongDatabase?: boolean;
    workerPresent?: boolean;
    workerRows?: unknown[];
    workerError?: boolean;
    identityErrors?: boolean;
    existingTables?: string[];
    initialSql?: string;
    prefix32?: boolean;
    wrongPrefixLedgerDefinition?: boolean;
    corruptPrefixLedger?: boolean;
    appendPrefixLedger?: boolean;
    corruptPrefixSequence?: boolean;
    corruptPrefixFtsSeed?: boolean;
    addPrefix32View?: boolean;
    insertPrefix32ApplicationRow?: boolean;
    wrongDatabaseName?: boolean;
    returnForeignKeyViolation?: boolean;
    remove0034TriggerAfterRecovery?: boolean;
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
  if (options.prefix32) {
    db.exec(
      options.wrongPrefixLedgerDefinition
        ? coreLedgerInitSql.replace(
            "applied_at TEXT NOT NULL",
            "applied_at TEXT NOT NULL DEFAULT ''",
          )
        : coreLedgerInitSql,
    );
    for (const migration of names.slice(0, 32)) {
      const raw = readFileSync(
        resolve(
          repo,
          "node_modules/@takosjp/yurucommu-core/migrations",
          migration,
        ),
        "utf8",
      );
      const script = `${ledgerCreateSql}\n${raw.trim()}\nINSERT INTO yurucommu_migrations (name, applied_at) VALUES ('${migration}', '2026-10-12T00:00:00.000Z');`;
      db.transaction(() => db.exec(script)).immediate();
    }
    if (options.corruptPrefixLedger) {
      db.exec(
        "UPDATE yurucommu_migrations SET name='unexpected-prefix-row' WHERE id=32",
      );
    }
    if (options.appendPrefixLedger) {
      db.exec(
        "INSERT INTO yurucommu_migrations (name, applied_at) VALUES ('0037_unpinned.sql', '2026-10-12T00:00:00.000Z')",
      );
    }
    if (options.corruptPrefixSequence) {
      db.exec(
        "UPDATE sqlite_sequence SET seq=99 WHERE name='yurucommu_migrations'",
      );
    }
    if (options.addPrefix32View) {
      db.exec("CREATE VIEW unexpected_prefix_view AS SELECT 1 AS value");
    }
    if (options.insertPrefix32ApplicationRow) {
      db.exec(
        "INSERT INTO instance_actor (ap_id, preferred_username, public_key_pem, private_key_pem) VALUES ('https://example.invalid/actor', 'fixture', 'public', 'private')",
      );
    }
  }
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
          name: options.wrongDatabaseName
            ? "different-integration-database"
            : expectedDatabaseName,
          ...(options.wrongDatabase ? { diagnosticEcho: token } : {}),
        },
      });
    }
    if (method !== "POST" || !url.endsWith("/query")) {
      throw new Error("fixture accepts only D1 query POST requests");
    }
    const sql = typeof body?.sql === "string" ? body.sql.trim() : undefined;
    const batch = Array.isArray(body?.batch) ? body.batch : undefined;
    if (sql && batch) throw new Error("fixture rejects mixed query transports");
    if (sql && /^(?:SELECT|PRAGMA)\b/i.test(sql)) {
      let rows = db.query(sql).all();
      if (
        options.corruptPrefixFtsSeed &&
        sql ===
          "SELECT k, typeof(v) AS valueType, hex(CAST(v AS BLOB)) AS valueHex FROM objects_fts_config ORDER BY k"
      ) {
        rows = rows.map((row) => ({
          ...(row as Record<string, unknown>),
          valueHex: "999",
        }));
      }
      if (
        sql === "PRAGMA foreign_key_check" &&
        options.returnForeignKeyViolation
      ) {
        rows = [{ table: "follows", rowid: 1, parent: "actors", fkid: 0 }];
      }
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
      !batch ||
      batch.length === 0 ||
      !batch.every(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { sql?: unknown }).sql === "string" &&
          (entry as { sql: string }).sql.trim().length > 0,
      )
    ) {
      if (
        sql &&
        /^CREATE TABLE IF NOT EXISTS yurucommu_migrations\b/.test(sql)
      ) {
        db.exec(sql);
        return json(queryResult());
      }
      throw new Error(
        "fixture accepts reads, ledger init, or explicit SQL batches",
      );
    }
    const statements: string[] = batch.map(
      (entry: { sql: string }) => entry.sql,
    );
    const isProbe = statements[0].startsWith(
      `CREATE TABLE ${integrationSchemaTestSupport.probeTable}`,
    );
    if (isProbe) {
      if (options.probe === "success") {
        return json({
          success: true,
          result: statements.map(() => ({ success: true, results: [] })),
        });
      }
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
        if (options.probe === "partial") {
          for (const statement of statements) db.exec(statement);
        } else {
          db.transaction(() => {
            for (const statement of statements) db.exec(statement);
          })();
        }
        throw new Error("duplicate-key batch unexpectedly succeeded");
      } catch (error) {
        if (options.probe === "transport")
          throw new Error("probe acknowledgement lost");
        return json(
          {
            success: false,
            errors: [{ message: String(error) }],
            result: statements.map((_, index) => ({
              success: index !== statements.length - 1,
              ...(index === statements.length - 1
                ? { errors: [{ message: String(error) }] }
                : {}),
            })),
          },
          400,
        );
      }
    }
    if (
      !/^\s*CREATE TABLE IF NOT EXISTS yurucommu_migrations\b/.test(
        statements[0],
      ) ||
      !/\bINSERT INTO yurucommu_migrations\b/.test(statements.at(-1) ?? "")
    ) {
      throw new Error("unknown fixture mutation");
    }
    migrationScripts += 1;
    if (options.contradictoryErrors) {
      return json({
        success: true,
        errors:
          options.contradictoryErrors === "top"
            ? [{ message: "query failed" }]
            : [],
        result: statements.map((_, index) => ({
          success: true,
          results: [],
          ...(options.contradictoryErrors === "row" && index === 0
            ? { errors: [{ message: "query failed" }] }
            : {}),
        })),
      });
    }
    if (options.migrationFailureAt === migrationScripts) {
      return json({
        success: true,
        result: statements.map((_, index) => ({
          success: index !== 1,
          results: [],
        })),
      });
    }
    if (options.emptyMigrationResults)
      return json({ success: true, result: [] });
    db.transaction(() => {
      for (const statement of statements) db.exec(statement);
    })();
    if (
      options.remove0034TriggerAfterRecovery &&
      statements.at(-1)?.includes("0036_notification_push_actor_fk_repair.sql")
    ) {
      db.exec("DROP TRIGGER media_staged_process_input");
    }
    if (options.migrationTimeoutAt === migrationScripts)
      throw new Error("migration acknowledgement lost");
    return json({
      success: true,
      result: statements.map(() => ({ success: true, results: [] })),
    });
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
  expect(
    integrationSchemaTestSupport.buildMigrationBatch(script, migration),
  ).toEqual(unstable_splitSqlQuery(script).map((sql) => ({ sql })));
  expect(() =>
    integrationSchemaTestSupport.buildMigrationBatch(
      script.replace(mark, "SELECT 1;"),
      migration,
    ),
  ).toThrow("exactly one matching ledger mark");
  expect(() =>
    integrationSchemaTestSupport.buildMigrationBatch(
      `${script}${mark}\n`,
      migration,
    ),
  ).toThrow("exactly one matching ledger mark");
  expect(() =>
    integrationSchemaTestSupport.buildMigrationBatch(
      `${script}BEGIN TRANSACTION;`,
      migration,
    ),
  ).toThrow("explicit transaction control");
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

test("REST splitter closes CASE expressions before parentheses without splitting compound triggers", () => {
  const statements = integrationSchemaTestSupport.splitSqlStatements(
    "CREATE TRIGGER probe AFTER INSERT ON source BEGIN\n  SELECT (CASE WHEN NEW.id = 1 THEN 1 ELSE 0 END);\n  SELECT 'END)', [END)], \"END)\", `END)`; -- END) in comment\nEND;\nINSERT INTO yurucommu_migrations (name, applied_at) VALUES ('probe', '2026-10-12T00:00:00.000Z');",
  );
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("( CASE WHEN NEW.id = 1 THEN 1 ELSE 0 END )");
  expect(statements[0]).toContain("SELECT 'END)'");
  expect(statements[0]).toContain('[END)], "END)", `END)`');
  expect(statements[0]).not.toContain("-- END) in comment");
  expect(statements[1]).toMatch(/^INSERT INTO yurucommu_migrations/);
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
  expect(rejected.calls.some(isWriteCall)).toBe(false);
});

test("REST batch fixture applies all 35 immutable migrations and nested triggers with each exact ledger prefix", async () => {
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
  const writes = f.calls.filter(isWriteCall);
  expect(writes).toHaveLength(37); // atomicity probe, ledger init, 35 scripts
  const probe = writeStatements(writes[0]);
  expect(Array.isArray(writes[0].body.batch)).toBe(true);
  expect(probe).toHaveLength(7);
  expect(probe[3]).toMatch(
    /^CREATE TABLE IF NOT EXISTS yurucommu_migrations\b/,
  );
  expect(probe[4]).toBe(
    "INSERT INTO yurucommu_migrations (name, applied_at) VALUES ('__yurucommu_ga_atomic_probe__', '2026-10-12T00:00:00.000Z')",
  );
  expect(probe.at(-1)).toContain("'duplicate'");
  const probeTrigger = probe.find((statement) =>
    statement.startsWith(
      `CREATE TRIGGER ${integrationSchemaTestSupport.probeTrigger}`,
    ),
  );
  expect(probeTrigger).toContain("CASE WHEN");
  expect(probeTrigger?.match(/;/g)?.length).toBeGreaterThan(0);
  expect(probeTrigger).toMatch(/END\s*$/);
  expect(
    f.db
      .query(
        `SELECT name FROM sqlite_master WHERE name IN ('${integrationSchemaTestSupport.probeTable}', '${integrationSchemaTestSupport.probeLogTable}', '${integrationSchemaTestSupport.probeTrigger}')`,
      )
      .all(),
  ).toEqual([]);
  expect(f.ledger).not.toContain("__yurucommu_ga_atomic_probe__");
  expect(writes[1].body.sql).toMatch(
    /^\s*CREATE TABLE IF NOT EXISTS yurucommu_migrations\b/,
  );
  expect(writes.slice(2).every((call) => Array.isArray(call.body.batch))).toBe(
    true,
  );
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
      writeStatements(call).at(-1)?.includes(`VALUES ('${migration}',`),
    );
    expect(call).toBeDefined();
    const statements = writeStatements(call!);
    const ledgerPrefix =
      "CREATE TABLE IF NOT EXISTS yurucommu_migrations (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT UNIQUE NOT NULL,\n  applied_at TEXT NOT NULL\n);";
    const originalScript = `${ledgerPrefix}\n${raw.trim()}\n${statements.at(-1)};\n`;
    expect(statements).toEqual(
      integrationSchemaTestSupport.splitSqlStatements(originalScript),
    );
    expect(writeStatements(call!).at(-1)).toMatch(
      new RegExp(
        `^INSERT INTO yurucommu_migrations \\(name, applied_at\\) VALUES \\('${migration}',`,
      ),
    );
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

test("0034 REST batch preserves Wrangler statement order, compound CASE trigger and final ledger mark", async () => {
  const f = fixture({ migrationFailureAt: 34 });
  await muted(async () => {
    await expect(
      applyFreshIntegrationSchema(args(f.fetchImpl)),
    ).rejects.toThrow("unsuccessful query result");
  });
  const calls = f.calls.filter(
    (call) =>
      Array.isArray(call.body?.batch) &&
      writeStatements(call)
        .at(-1)
        ?.includes("VALUES ('0034_staged_media_retention.sql',"),
  );
  expect(calls).toHaveLength(1);
  const batch = writeStatements(calls[0]);
  const raw = readFileSync(
    resolve(
      repo,
      "node_modules/@takosjp/yurucommu-core/migrations/0034_staged_media_retention.sql",
    ),
    "utf8",
  );
  const ledgerPrefix =
    "CREATE TABLE IF NOT EXISTS yurucommu_migrations (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT UNIQUE NOT NULL,\n  applied_at TEXT NOT NULL\n);";
  const originalScript = `${ledgerPrefix}\n${raw.trim()}\n${batch.at(-1)};\n`;
  const expected =
    integrationSchemaTestSupport.splitSqlStatements(originalScript);
  expect(batch).toHaveLength(expected.length);
  expect(batch).toEqual(expected);
  expect(batch.at(-1)).toMatch(
    /^INSERT INTO yurucommu_migrations \(name, applied_at\) VALUES \('0034_staged_media_retention\.sql', '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z'\)$/,
  );
  const trigger = batch.filter((statement) =>
    statement.startsWith("CREATE TRIGGER media_staged_process_input"),
  );
  expect(trigger).toHaveLength(1);
  expect(trigger[0]).toContain("BEGIN");
  expect(trigger[0]).toContain("CASE WHEN");
  expect(trigger[0].match(/;/g)?.length).toBeGreaterThan(3);
});

test("prefix32 recovery skips the exact first 32 and writes only the final three batches with each ledger readback", async () => {
  const f = fixture({ prefix32: true });
  const result = await muted(() =>
    recoverPrefix32IntegrationSchema(args(f.fetchImpl)),
  );
  expect(result).toMatchObject({
    status: "APPLIED",
    phase: "recover-prefix32",
    databaseId,
    coreVersion: "4.1.14",
    prefixLength: 32,
    migrationCount: 35,
    applied: names.slice(32),
    skipped: names.slice(0, 32),
    mapSha256: integrationSchemaTestSupport.migrationMapSha256,
  });
  const writes = f.calls.filter(isWriteCall);
  expect(writes).toHaveLength(3);
  expect(writes.every((call) => Array.isArray(call.body?.batch))).toBe(true);
  expect(
    writes.map(
      (call) =>
        writeStatements(call)
          .at(-1)
          ?.match(/VALUES \('([^']+)'/)?.[1],
    ),
  ).toEqual(names.slice(32));
  expect(
    f.calls.some(
      (call) =>
        call.body?.sql &&
        !/^SELECT\b/i.test(call.body.sql) &&
        !/^PRAGMA\b/i.test(call.body.sql),
    ),
  ).toBe(false);
  expect(f.migrationScripts).toBe(3);
  expect(f.ledger).toEqual([...names]);
  expect(
    f.calls.filter(
      (call) =>
        call.body?.sql ===
        "SELECT id, name FROM yurucommu_migrations ORDER BY id",
    ),
  ).toHaveLength(6); // preflight, runner start, 33/34/35, final readback
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("fresh-schema keeps refusing a populated prefix32 database without writes", async () => {
  const f = fixture({ prefix32: true });
  await expect(applyFreshIntegrationSchema(args(f.fetchImpl))).rejects.toThrow(
    "D1 is not empty",
  );
  expect(f.calls.some(isWriteCall)).toBe(false);
  expect(f.migrationScripts).toBe(0);
  expect(f.ledger).toEqual(names.slice(0, 32));
});

test("prefix32 recovery refuses mismatched identity, competing Worker, ledger, objects, rows, sequence, and FTS seeds before writes", async () => {
  const cases = [
    {
      options: { wrongDatabase: true },
      reason: "exact new integration database",
    },
    {
      options: { wrongDatabaseName: true },
      reason: "exact new integration database",
    },
    { options: { workerPresent: true }, reason: "Worker already exists" },
    {
      options: { prefix32: true, wrongPrefixLedgerDefinition: true },
      reason: "schema objects differ",
    },
    {
      options: { prefix32: true, corruptPrefixLedger: true },
      reason: "published Core prefix",
    },
    {
      options: { prefix32: true, appendPrefixLedger: true },
      reason: "table counts differ",
    },
    {
      options: { prefix32: true, addPrefix32View: true },
      reason: "schema objects differ",
    },
    {
      options: { prefix32: true, insertPrefix32ApplicationRow: true },
      reason: "table counts differ",
    },
    {
      options: { prefix32: true, corruptPrefixSequence: true },
      reason: "sqlite_sequence differs",
    },
    {
      options: { prefix32: true, corruptPrefixFtsSeed: true },
      reason: "D1 seed rows differ from the exact published Core prefix",
    },
    {
      options: { prefix32: true, returnForeignKeyViolation: true },
      reason: "foreign-key check returned violations",
    },
  ] as const;
  for (const { options, reason } of cases) {
    const f = fixture(options);
    await expect(
      recoverPrefix32IntegrationSchema(args(f.fetchImpl)),
    ).rejects.toThrow(reason);
    expect(f.calls.some(isWriteCall)).toBe(false);
    expect(f.migrationScripts).toBe(0);
  }
});

test("prefix32 recovery stops after one failed or indeterminate suffix batch without retry", async () => {
  for (const options of [
    { migrationFailureAt: 1 },
    { migrationTimeoutAt: 1 },
  ] as const) {
    const f = fixture({ prefix32: true, ...options });
    await expect(
      recoverPrefix32IntegrationSchema(args(f.fetchImpl)),
    ).rejects.toMatchObject({ phase: "POST_SCHEMA_INDETERMINATE" });
    expect(f.migrationScripts).toBe(1);
    expect(f.calls.filter(isWriteCall)).toHaveLength(1);
  }
});

test("prefix32 recovery refuses final readback missing a 0034 trigger", async () => {
  const f = fixture({ prefix32: true, remove0034TriggerAfterRecovery: true });
  await expect(
    recoverPrefix32IntegrationSchema(args(f.fetchImpl)),
  ).rejects.toMatchObject({ phase: "POST_SCHEMA_INDETERMINATE" });
  expect(f.migrationScripts).toBe(3);
  expect(f.calls.filter(isWriteCall)).toHaveLength(3);
});

async function muted<T>(action: () => Promise<T>): Promise<T> {
  const oldLog = console.log;
  const oldWarn = console.warn;
  try {
    console.log = () => {};
    console.warn = () => {};
    return await action();
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
  expect(nonfresh.calls.some(isWriteCall)).toBe(false);
  expect(nonfresh.calls.filter((call) => call.method === "POST")).toHaveLength(
    1,
  );

  const wildcardLookalike = fixture({ existingTables: ["xcfXfoo"] });
  await expect(
    applyFreshIntegrationSchema(args(wildcardLookalike.fetchImpl)),
  ).rejects.toThrow("not empty");
  expect(wildcardLookalike.calls.some(isWriteCall)).toBe(false);
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

test("partial REST batch probe persistence stops with no cleanup or schema migration", async () => {
  const f = fixture({ probe: "partial" });
  await expect(applyFreshIntegrationSchema(args(f.fetchImpl))).rejects.toThrow(
    "probe left table, trigger, or ledger state",
  );
  const queryCalls = f.calls.filter((call) => call.method === "POST");
  expect(queryCalls).toHaveLength(3);
  const writes = queryCalls.filter(isWriteCall);
  expect(writes).toHaveLength(1);
  expect(Array.isArray(writes[0].body.batch)).toBe(true);
  expect(
    writeStatements(writes[0]).some((sql: string) =>
      /\bDROP TABLE\b/i.test(sql),
    ),
  ).toBe(false);
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
  expect(f.calls.filter(isWriteCall)).toHaveLength(1);
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
