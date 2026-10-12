#!/usr/bin/env bun
// Fresh-schema-only integration adapter. This module is intentionally not used
// by the product's ordinary Worker publisher or activation path.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const API = "https://api.cloudflare.com/client/v4";
const DATABASE_NAME = "yurucommu-ga-20261012-0938-db";
const WORKER_NAME = "yurucommu-ga-20261012-0938";
const CORE_VERSION = "4.1.14";
const CORE_RUNNER_SHA256 =
  "f5bb782ed83dccd0a4240ad6e813c651b39edf76d10587ed4ea0789572aa139d";
const LEDGER = "yurucommu_migrations";
const PROBE_TABLE = "__yurucommu_ga_atomic_probe";
const RESERVED_D1_TABLES_SQL = "'_cf_METADATA', '_cf_KV'";
const LEDGER_CREATE_SQL = `CREATE TABLE IF NOT EXISTS ${LEDGER} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  applied_at TEXT NOT NULL
);`;
const LEDGER_INIT_SQL = `CREATE TABLE IF NOT EXISTS ${LEDGER} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )`;

// This map pins the SQL bytes admitted by the published Core 4.1.14 package.
const MIGRATIONS = Object.freeze({
  "0001_init.sql":
    "5f79b32320d842914891f21b0589a3e4e88fe3286a252ce541f2535680641651",
  "0002_social_remote_actor_edges.sql":
    "14dae6bc3277ff4d9bb075d1e345f07d7fc962b23f16af6cea1acdebb746662e",
  "0003_activity_remote_object_edges.sql":
    "fca8d640cc0b16a61e9513abc251a52b351b42620db71edb2a3880dc0e743c14",
  "0004_blocklist.sql":
    "587188e6928751cc78a7bb4d03b56269c941c8f7a890e4a149cd6fe0ec098eb6",
  "0005_story_community_scope.sql":
    "4790c0de5fac9b88dddeec792650da3f8314c9b261e24759fdf7bebe2a18be5c",
  "0006_dm_community_read_status.sql":
    "e274879865d14d409f04638c73564bab0d0695a0182d8042c22b99d5abc1e37b",
  "0007_moderation_reports.sql":
    "324bbeebd2553659bcdaefae2ac46ca972f9adbdea70cc0975284ccf965e652a",
  "0008_actor_fields_aka.sql":
    "5c096107751f466f907fa1420cfc88e7e4b0b53ac86ba0d08a9e767eb9ec6ab0",
  "0009_object_tags.sql":
    "8556a4dd862edf0f140b8a5b3c8be89f6bef060e6241b47d57b4eb00a25dd000",
  "0010_object_recipients_drop_actor_fk.sql":
    "b0973e9dcca0f1284c99828c73fe20272e79e9d71265dc4f6b1eeaad0f2a6414",
  "0011_drop_remote_actor_fks.sql":
    "3a343fc9b018af934a32f1879041513cfb1088ed63fb5803daba4f93fbd73a0d",
  "0012_objects_content_fts.sql":
    "c9c758b1a5b1e74d13d3e38a81feb6de8257cb161bc62e4b4b26f9e909eb9c74",
  "0013_efficiency_indexes.sql":
    "8bfe9308edec8a8bb153701a9e202660e615d3120086843ae1f0bf8b78323abc",
  "0014_inbox_actor_created_idx.sql":
    "f6076eeecbc82325fa5717d91011a117985aaff573111f7044148860eb1fac9b",
  "0015_community_bans.sql":
    "5740a6783d9868faf804edbf5809421f99fe1af279fb505543b539429e9dd848",
  "0016_namespace_takos_oidc_subject.sql":
    "bc012eda991e7c50eb12a70172e4cc8905d70e91174faf41f6024f3ebefa4f50",
  "0017_mobile_push_registrations.sql":
    "1b29da39effea07d60f1d0cead5d88e3695604ca56113a819f5f218c79c284a4",
  "0018_actor_notes.sql":
    "9d60b00428d461c5cdac37d4a72c00e1f30bd8e885938e16bb09544e7bcb4f86",
  "0019_notification_push_delivery.sql":
    "97c3accaf2657cc65af2b1bd1bbb593b7d063c27ceeb7b100e031c654b403354",
  "0020_call_sessions.sql":
    "8f09b9d0a83c06e428d084e27f7bc9aba47a17d0970d0fabb0a960920fbf7e76",
  "0022_inbound_dispatch_claims.sql":
    "08cbea8fbd4a4f87e4348dc883785fdaeedb91424ffd04704b34964cee903d6d",
  "0023_delivery_resolution_outbox.sql":
    "5a0500594b535e097ed13cd368fa49017e1afd46d059dcc5aad562930715a57c",
  "0024_delivery_fanout_outbox.sql":
    "b706b5f68f32d11cdd97c800bd694ae7535f7c0d258a8d3171393eb016c71d7b",
  "0025_delivery_endpoint_terminal_retention.sql":
    "85eefc48da28fab14830126e95f4b3a2a5650f8e4bac811f3d6e9252568fdd4b",
  "0026_remote_actor_fetch_failures.sql":
    "dec904c2d0fabfa5a1fca79ca73fcbe074ff321550f32d9068f98958932c5e89",
  "0027_remote_actor_tombstones.sql":
    "69656d3291b0103014af2c603812f2760a47cc5b3a11a2a2274298254e544d8a",
  "0028_remote_actor_delivery_fence.sql":
    "a5542482320826212ede489fcab0db9043bdf1e2265fbb0870040261f64ba99e",
  "0029_delivery_endpoint_recipients.sql":
    "0d10017dc54a0ed8cb5d287a115983c3e522ea4b4deabc6b4e8f7923cc77eb78",
  "0030_media_blob_deletion_jobs.sql":
    "8750ebe686d6b6a6330a49873e9ec6358881fdf76b6a1a47444618bbd9464a9d",
  "0031_account_deletion_reservations.sql":
    "a066f4387ac09e902783d2c4ca988cb06efe43f50e0f3b2e35e5a62f4af69442",
  "0032_outbox_revocations.sql":
    "84b4e762f1d45d77f89d0b012f662a96b7ff40562f358a4c43d07b7e621be6fd",
  "0033_delivery_reconciliation.sql":
    "213d149ad8bced79628be7ce37cce5b7ee6953a78e60d1688f00a434b1f1d63e",
  "0034_staged_media_retention.sql":
    "7acfe6567af5c4d569f3e523167a29f44370b9c0b207bc2365d4b49849c53d61",
  "0035_published_media_deletion_claims.sql":
    "6a817184d23485cb9521cce3b089e9ad5fe56d634287dab7b9deb49e8de1ce02",
  "0036_notification_push_actor_fk_repair.sql":
    "42d29c6367e7e8aaaf363d344284b6bd7c701dc6341bd47a98f36b634bc8025b",
});
const MIGRATION_NAMES = Object.freeze(Object.keys(MIGRATIONS).sort());
const MIGRATION_MAP_SHA256 =
  "ac5d5c0da5ba84d94339f45fc5d1a61103ac65d36add75d9703c2201386b1b50";
const EMPTY_SCHEMA_SQL = `SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND NOT (type = 'table' AND name IN (${RESERVED_D1_TABLES_SQL})) ORDER BY type, name`;

function insist(ok, message) {
  if (!ok) throw new Error(message);
}

function hasNoApiErrors(value) {
  return (
    (value?.errors === undefined ||
      (Array.isArray(value.errors) && value.errors.length === 0)) &&
    (value?.error === undefined || value.error === null || value.error === "")
  );
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateDiagnosticsDir(path, repo) {
  insist(
    typeof path === "string" && isAbsolute(path),
    "private diagnostics directory path is required",
  );
  const stat = lstatSync(path);
  insist(
    !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      (stat.mode & 0o777) === 0o700,
    "private diagnostics directory must be a link-free 0700 directory",
  );
  const actual = realpathSync(path);
  insist(
    resolve(path) === actual,
    "private diagnostics directory has a symlinked path",
  );
  const root = realpathSync(repo);
  const rel = relative(root, actual);
  insist(
    rel.startsWith("..") || isAbsolute(rel),
    "private diagnostics must be outside the source repository",
  );
  for (let at = actual; at !== resolve(at, ".."); at = resolve(at, "..")) {
    insist(
      !existsSync(join(at, ".git")),
      "private diagnostics must be outside Git worktrees",
    );
  }
  return actual;
}

function recordDiagnostic(context, label, raw) {
  const safeLabel = String(label)
    .replace(/[^a-z0-9-]/giu, "-")
    .slice(0, 48);
  const path = join(
    context.diagnosticsDir,
    `d1-schema-${safeLabel}-${randomUUID()}.log`,
  );
  const evidence = String(raw).split(context.token).join("[REDACTED]");
  writeFileSync(path, `${evidence}\n`, { flag: "wx", mode: 0o600 });
  const stat = lstatSync(path);
  insist(
    !stat.isSymbolicLink() &&
      stat.isFile() &&
      stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600,
    "private D1 diagnostics file did not meet the 0600 contract",
  );
  return path;
}

function validIdentity(accountId, databaseId, token) {
  insist(
    /^[a-f0-9]{32}$/u.test(accountId ?? ""),
    "exact integration account ID required",
  );
  insist(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
      databaseId ?? "",
    ),
    "exact D1 UUID required",
  );
  insist(
    typeof token === "string" && token.length > 0,
    "ephemeral Cloudflare API token required",
  );
}

async function request(context, method, suffix, body) {
  const { accountId, databaseId, token, fetchImpl } = context;
  let response;
  try {
    response = await fetchImpl(
      `${API}/accounts/${accountId}/d1/database/${databaseId}${suffix}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    const path = recordDiagnostic(
      context,
      "transport",
      JSON.stringify({
        method,
        suffix,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      }),
    );
    throw new Error(
      `D1 request outcome is indeterminate; private diagnostics: ${path}; stop and reconcile by read-only inspection`,
    );
  }
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    const path = recordDiagnostic(
      context,
      "response-read",
      JSON.stringify({
        method,
        suffix,
        status: response.status,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      }),
    );
    throw new Error(
      `D1 response could not be read; private diagnostics: ${path}; stop and reconcile by read-only inspection`,
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    const path = recordDiagnostic(
      context,
      "malformed-json",
      JSON.stringify({ method, suffix, status: response.status, raw }),
    );
    throw new Error(
      `D1 returned malformed JSON; private diagnostics: ${path}; stop and reconcile by read-only inspection`,
    );
  }
  const diagnosticPath =
    !response.ok || value?.success !== true
      ? recordDiagnostic(
          context,
          "api-failure",
          JSON.stringify({ method, suffix, status: response.status, raw }),
        )
      : undefined;
  return { response, value, raw, diagnosticPath };
}

function assertEnvelope(
  result,
  expectedCount,
  label,
  context,
  requireRows = true,
) {
  const fail = (message) => {
    const path =
      result.diagnosticPath ??
      recordDiagnostic(
        context,
        "invalid-envelope",
        JSON.stringify({
          label,
          status: result.response.status,
          raw: result.raw,
        }),
      );
    throw new Error(
      `${message}; private diagnostics: ${path}; stop without retry`,
    );
  };
  if (!result.response.ok || result.value?.success !== true) {
    fail(`${label} failed`);
  }
  if (
    (typeof result.value.error === "string" && result.value.error.length > 0) ||
    (Array.isArray(result.value.errors) && result.value.errors.length > 0)
  ) {
    fail(`${label} returned an unsuccessful query result`);
  }
  if (
    !Array.isArray(result.value.result) ||
    (expectedCount === undefined
      ? result.value.result.length === 0
      : result.value.result.length !== expectedCount)
  ) {
    fail(`${label} returned a mismatched result count`);
  }
  if (hasFailedResult(result.value.result)) {
    fail(`${label} returned an unsuccessful query result`);
  }
  for (const row of result.value.result) {
    if (!(
      row?.success === true &&
      (!requireRows || Array.isArray(row.results)) &&
      (row.results === undefined || Array.isArray(row.results))
    )) {
      fail(`${label} returned an unsuccessful query result`);
    }
  }
  return result.value.result;
}

async function query(context, sql) {
  const response = await request(context, "POST", "/query", { sql });
  return assertEnvelope(response, 1, "D1 read query", context)[0].results;
}

async function writeMigration(context, sql, migration) {
  const response = await request(context, "POST", "/query", { sql });
  return assertEnvelope(
    response,
    undefined,
    `Core migration ${migration}`,
    context,
    false,
  );
}

async function assertExactD1Identity(context) {
  const result = await request(context, "GET", "?fields=uuid,name");
  const { response, value } = result;
  if (
    response.ok &&
    value?.success === true &&
    hasNoApiErrors(value) &&
    typeof value.result?.uuid === "string" &&
    value.result?.uuid?.toLowerCase() === context.databaseId.toLowerCase() &&
    value.result?.name === DATABASE_NAME
  ) {
    return;
  }
  const path =
    result.diagnosticPath ??
    recordDiagnostic(
      context,
      "identity-mismatch",
      JSON.stringify({ status: response.status, raw: result.raw }),
    );
  throw new Error(
    `D1 identity does not match the exact new integration database; private diagnostics: ${path}`,
  );
}

async function assertNoTargetWorker(context) {
  let response;
  try {
    response = await context.fetchImpl(
      `${API}/accounts/${context.accountId}/workers/scripts`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${context.token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    const path = recordDiagnostic(
      context,
      "worker-inventory-transport",
      JSON.stringify({
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      }),
    );
    throw new Error(
      `Worker inventory failed; private diagnostics: ${path}; cannot prove writers are closed`,
    );
  }
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    const path = recordDiagnostic(
      context,
      "worker-inventory-read",
      JSON.stringify({
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      }),
    );
    throw new Error(
      `Worker inventory could not be read; private diagnostics: ${path}; cannot prove writers are closed`,
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    const path = recordDiagnostic(context, "worker-inventory-json", raw);
    throw new Error(
      `Worker inventory was malformed; private diagnostics: ${path}; cannot prove writers are closed`,
    );
  }
  if (
    !response.ok ||
    value?.success !== true ||
    !Array.isArray(value.result) ||
    !value.result.every(
      (script) => typeof script?.id === "string" && script.id.length > 0,
    ) ||
    !hasNoApiErrors(value)
  ) {
    const path = recordDiagnostic(
      context,
      "worker-inventory-api",
      JSON.stringify({ status: response.status, raw }),
    );
    throw new Error(
      `Worker inventory failed; private diagnostics: ${path}; cannot prove writers are closed`,
    );
  }
  insist(
    !value.result.some((script) => script?.id === WORKER_NAME),
    "integration Worker already exists; schema writes refused",
  );
}

async function assertEmptySchema(context) {
  const rows = await query(context, EMPTY_SCHEMA_SQL);
  insist(
    Array.isArray(rows) && rows.length === 0,
    "D1 is not empty; schema migration refused",
  );
}

async function assertProbeAbsent(context, diagnosticPath) {
  const rows = await query(
    context,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${PROBE_TABLE}'`,
  );
  if (!Array.isArray(rows) || rows.length !== 0) {
    throw new Error(
      `atomicity probe left D1 state; stop without cleanup or retry${diagnosticPath ? `; private diagnostics: ${diagnosticPath}` : ""}`,
    );
  }
}

function errorText(value) {
  const messages = [];
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    if (typeof entry.error === "string") messages.push(entry.error);
    if (typeof entry.message === "string") messages.push(entry.message);
    for (const key of ["errors", "result", "results"]) visit(entry[key]);
  };
  visit(value);
  return messages.join("\n");
}

function hasFailedResult(value) {
  if (Array.isArray(value)) return value.some(hasFailedResult);
  if (!value || typeof value !== "object") return false;
  return (
    value.success === false ||
    (typeof value.error === "string" && value.error.length > 0) ||
    (Array.isArray(value.errors) && value.errors.length > 0) ||
    hasFailedResult(value.result) ||
    hasFailedResult(value.results)
  );
}

async function proveRestBatchAtomicity(context) {
  const sql = [
    `CREATE TABLE ${PROBE_TABLE} (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)`,
    `INSERT INTO ${PROBE_TABLE} (id, marker) VALUES (1, 'first')`,
    `INSERT INTO ${PROBE_TABLE} (id, marker) VALUES (1, 'duplicate')`,
  ].join(";\n");
  let outcome;
  let requestFailure;
  try {
    outcome = await request(context, "POST", "/query", { sql });
  } catch (error) {
    // The request may have reached D1. Read back only; never retry or clean up.
    requestFailure = error;
  }
  if (outcome) {
    outcome.diagnosticPath ??= recordDiagnostic(
      context,
      "atomicity-probe",
      JSON.stringify({ status: outcome.response.status, raw: outcome.raw }),
    );
  }
  await assertProbeAbsent(context, outcome?.diagnosticPath);
  if (!outcome) {
    throw new Error(
      `atomicity probe outcome is indeterminate; no migrations were run${requestFailure instanceof Error ? `; ${requestFailure.message}` : ""}`,
    );
  }
  const failed =
    !outcome.response.ok ||
    outcome.value?.success !== true ||
    hasFailedResult(outcome.value?.result) ||
    (Array.isArray(outcome.value?.errors) && outcome.value.errors.length > 0);
  if (!failed) {
    throw new Error(
      `atomicity probe unexpectedly succeeded; no migrations were run; private diagnostics: ${outcome.diagnosticPath}`,
    );
  }
  if (
    !/(?:unique|primary key|constraint)\s+(?:constraint\s+)?failed/i.test(
      errorText(outcome.value),
    )
  ) {
    throw new Error(
      `atomicity probe did not report its expected duplicate-key failure; no migrations were run; private diagnostics: ${outcome.diagnosticPath}`,
    );
  }
}

async function verifyCoreInputs(repo) {
  const coreDir = join(repo, "node_modules/@takosjp/yurucommu-core");
  const corePackage = JSON.parse(
    await readFile(join(coreDir, "package.json"), "utf8"),
  );
  insist(
    corePackage.version === CORE_VERSION,
    "installed Core version is not the qualified 4.1.14 release",
  );
  const migrationsDir = join(coreDir, "migrations");
  const names = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  insist(
    JSON.stringify(names) === JSON.stringify(MIGRATION_NAMES),
    "Core migration file set differs from the qualified 35-file map",
  );
  for (const name of MIGRATION_NAMES) {
    insist(
      sha256(await readFile(join(migrationsDir, name))) === MIGRATIONS[name],
      `Core migration bytes differ: ${name}`,
    );
  }
  const mapping = MIGRATION_NAMES.map(
    (name) => `${MIGRATIONS[name]}  ${name}\n`,
  ).join("");
  insist(
    sha256(mapping) === MIGRATION_MAP_SHA256,
    "compiled migration map digest differs",
  );

  const bundlePath = join(
    repo,
    "deploy/takoform/migrations/schema-bundle.json",
  );
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  insist(
    bundle?.apiVersion === "takosumi.resource-migrations/v1" &&
      bundle.engine === "sqlite" &&
      Array.isArray(bundle.entries) &&
      bundle.entries.length === MIGRATION_NAMES.length,
    "repository schema bundle is not the exact 35-migration shape",
  );
  // The portable bundle owns one deliberate D1-safe 0003 override. Validate
  // that bundle through its owning generator; the fresh native D1 lane below
  // still executes the exact published Core migration files and ledger.
  const { buildSchemaBundle } = await import(
    pathToFileURL(join(repo, "scripts/generate-schema-bundle.ts")).href
  );
  const expectedBundle = await buildSchemaBundle(repo);
  insist(
    JSON.stringify(bundle.entries) === JSON.stringify(expectedBundle.entries),
    "repository schema bundle differs from its owning Core/portable override contract",
  );

  const runnerPath = join(coreDir, "scripts/apply-takosumi-migrations.ts");
  insist(
    sha256(await readFile(runnerPath)) === CORE_RUNNER_SHA256,
    "published Core migration runner bytes changed",
  );
  const runner = await import(pathToFileURL(resolve(runnerPath)).href);
  insist(
    typeof runner.applyMigrations === "function" &&
      runner.MIGRATION_LEDGER_TABLE === LEDGER,
    "published Core migration runner contract changed",
  );
  return { migrationsDir, applyMigrations: runner.applyMigrations };
}

function assertMigrationScript(sql, migration, migrationSql) {
  insist(
    typeof migration === "string" && MIGRATIONS[migration],
    "Core runner requested an unpinned migration",
  );
  insist(
    sha256(migrationSql) === MIGRATIONS[migration],
    `${migration} SQL bytes changed after preflight; stop before write`,
  );
  const start = `${LEDGER_CREATE_SQL}\n${migrationSql.trim()}\nINSERT INTO ${LEDGER} (name, applied_at) VALUES ('${migration}', '`;
  insist(
    sql.startsWith(start) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z'\);\n$/u.test(
        sql.slice(start.length),
      ),
    `${migration} runner script differs from the exact pinned Core assembly`,
  );
  return sql;
}

async function applyMigrations(context, repo, inputs) {
  const resource = context.databaseId;
  let migrationsApplied = 0;
  const executeSql = async (sql, execution) => {
    insist(
      execution?.resource === resource,
      "Core runner resource differs from exact integration D1",
    );
    if (execution.purpose === "ledger-init") {
      insist(
        sql.trim() === LEDGER_INIT_SQL,
        "unexpected Core ledger initialization script",
      );
      const init = await request(context, "POST", "/query", { sql });
      assertEnvelope(init, 1, "Core ledger initialization", context, false);
      return undefined;
    }
    if (execution.purpose === "ledger-read") {
      insist(
        sql === `SELECT name FROM ${LEDGER}`,
        "unexpected Core ledger read script",
      );
      return { rows: await query(context, sql) };
    }
    insist(
      execution.purpose === "migration" && MIGRATIONS[execution.migration],
      "Core requested an unpinned migration",
    );
    const migrationSql = await readFile(
      join(inputs.migrationsDir, execution.migration),
      "utf8",
    );
    const script = assertMigrationScript(
      sql,
      execution.migration,
      migrationSql,
    );
    insist(
      execution.migration === MIGRATION_NAMES[migrationsApplied],
      "Core runner migration order differs from the exact pinned map",
    );
    await writeMigration(context, script, execution.migration);
    migrationsApplied += 1;
    const ledger = await query(
      context,
      `SELECT name FROM ${LEDGER} ORDER BY id`,
    );
    insist(
      Array.isArray(ledger) &&
        JSON.stringify(ledger.map((row) => row?.name)) ===
          JSON.stringify(MIGRATION_NAMES.slice(0, migrationsApplied)),
      `D1 migration ledger diverged after ${execution.migration}; stop without retry`,
    );
    return undefined;
  };
  return inputs.applyMigrations({
    resource,
    migrationsDir: inputs.migrationsDir,
    wrapTransactions: false,
    batchPendingMigrations: false,
    retryAttempts: 1,
    executeSql,
  });
}

async function assertFinalReadback(context, result) {
  insist(
    Array.isArray(result?.applied) &&
      JSON.stringify(result.applied) === JSON.stringify(MIGRATION_NAMES) &&
      Array.isArray(result.skipped) &&
      result.skipped.length === 0,
    "Core runner did not apply the exact 35 migrations to the fresh database",
  );
  const ledger = await query(context, `SELECT name FROM ${LEDGER} ORDER BY id`);
  insist(
    Array.isArray(ledger) &&
      JSON.stringify(ledger.map((row) => row?.name)) ===
        JSON.stringify(MIGRATION_NAMES),
    "fresh D1 ledger readback differs from the exact 35 migration map",
  );
  const tables = await query(
    context,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT IN (${RESERVED_D1_TABLES_SQL}) ORDER BY name`,
  );
  const tableNames = new Set(tables.map((row) => row?.name));
  for (const name of [
    "actors",
    "objects",
    "activities",
    "notification_pushers",
    LEDGER,
  ]) {
    insist(
      tableNames.has(name),
      `final D1 schema is missing required table ${name}`,
    );
  }
}

/** Apply the exact published Core 4.1.14 migration set to the isolated new D1. */
export async function applyFreshIntegrationSchema({
  accountId,
  databaseId,
  token,
  repo,
  diagnosticsDir,
  fetchImpl = fetch,
}) {
  validIdentity(accountId, databaseId, token);
  insist(
    typeof repo === "string" && repo.length > 0,
    "repository root required",
  );
  const root = resolve(repo);
  const privateDiagnosticsDir = validateDiagnosticsDir(diagnosticsDir, root);
  const context = {
    accountId,
    databaseId,
    token,
    fetchImpl,
    diagnosticsDir: privateDiagnosticsDir,
  };
  await assertExactD1Identity(context);
  await assertNoTargetWorker(context);
  await assertEmptySchema(context);
  const inputs = await verifyCoreInputs(root);
  await proveRestBatchAtomicity(context);
  const result = await applyMigrations(context, root, inputs);
  await assertFinalReadback(context, result);
  return {
    status: "APPLIED",
    databaseId,
    coreVersion: CORE_VERSION,
    migrationCount: MIGRATION_NAMES.length,
    migrations: [...MIGRATION_NAMES],
    mapSha256: MIGRATION_MAP_SHA256,
  };
}

export const integrationSchemaTestSupport = Object.freeze({
  migrationNames: MIGRATION_NAMES,
  migrationMapSha256: MIGRATION_MAP_SHA256,
  probeTable: PROBE_TABLE,
  assertMigrationScript,
  assertEnvelope,
  proveRestBatchAtomicity,
  verifyCoreInputs,
  emptySchemaSql: EMPTY_SCHEMA_SQL,
});
