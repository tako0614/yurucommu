#!/usr/bin/env node

// Worker-applied schema on the real workerd D1 runtime (Miniflare): the
// deploy/cloudflare lane's only schema path. Proves, on these exact Worker
// bytes, that an opted-in Worker brings an empty D1 database to the locked
// schema bundle before it serves, that concurrent first requests apply each
// file once, that the result equals the bundle applied whole-file, that the
// opt-in is required, and that the migrated database serves a real sign-in.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
import { unstable_readConfig } from "wrangler";
import { createManagedNativeRuntime } from "./native-runtime-stdio.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ORIGIN = "https://d1-schema-smoke.yurucommu.invalid";
const BOOTSTRAP_PASSWORD = "d1-schema-smoke-only";
const SCHEMA_QUERY =
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' AND name <> 'yurucommu_migrations' ORDER BY type, name";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function phase(name, state) {
  process.stderr.write(`[d1-schema-smoke] phase=${name} state=${state}\n`);
}

function assertSmoke(condition, message) {
  if (!condition) throw new Error(`d1-schema-smoke: ${message}`);
}

function readSchemaBundle() {
  const bundle = JSON.parse(
    readFileSync(
      resolve(repo, "deploy/takoform/migrations/schema-bundle.json"),
      "utf8",
    ),
  );
  assertSmoke(
    bundle.apiVersion === "takosumi.resource-migrations/v1" &&
      Array.isArray(bundle.entries) &&
      bundle.entries.length > 0,
    "schema bundle is missing",
  );
  return bundle;
}

function nativeWorker(artifactPath, extraBindings) {
  const config = unstable_readConfig(
    { config: resolve(repo, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  return createManagedNativeRuntime(
    (handleRuntimeStdio) =>
      new Miniflare({
        rootPath: dirname(artifactPath),
        modules: [{ type: "ESModule", path: artifactPath }],
        modulesRoot: dirname(artifactPath),
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        cf: false,
        bindings: {
          APP_URL: APP_ORIGIN,
          AUTH_PASSWORD_HASH: BOOTSTRAP_PASSWORD,
          YURUCOMMU_SESSION_HASH_SALT: "d1-schema-smoke-only-session-salt",
          DELIVERY_QUEUE_NAME: "yurucommu-delivery",
          DELIVERY_DLQ_NAME: "yurucommu-delivery-dlq",
          ENCRYPTION_KEY: "00".repeat(32),
          YURUCOMMU_RUNTIME_LANE: "cloudflare",
          ...extraBindings,
        },
        d1Databases: ["DB"],
        kvNamespaces: ["KV"],
        r2Buckets: ["MEDIA"],
        queueProducers: ["DELIVERY_QUEUE", "DELIVERY_DLQ"],
        handleRuntimeStdio,
      }),
  );
}

async function schemaOf(db) {
  return (await db.prepare(SCHEMA_QUERY).all()).results;
}

// The whole-file reference: each bundle file executed in one transaction by
// SQLite itself, the way the core runner applies it.
function wholeFileReference(bundle) {
  const db = new DatabaseSync(":memory:");
  try {
    for (const entry of bundle.entries) {
      db.exec("BEGIN");
      db.exec(entry.sql);
      db.exec("COMMIT");
    }
    return db
      .prepare(SCHEMA_QUERY)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function ledgerOf(db) {
  return (
    await db.prepare("SELECT name FROM yurucommu_migrations ORDER BY id").all()
  ).results.map((row) => row.name);
}

async function hasLedger(db) {
  return (
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'yurucommu_migrations'",
        )
        .all()
    ).results.length === 1
  );
}

async function withWorker(artifactPath, extraBindings, action) {
  const { worker, dispose } = nativeWorker(artifactPath, extraBindings);
  try {
    await worker.ready;
    return await action(worker);
  } finally {
    await dispose();
  }
}

async function main() {
  const [artifactArgument] = process.argv.slice(2);
  if (!artifactArgument || process.argv.length > 3) {
    throw new Error(
      "usage: node scripts/smoke-release-d1-schema.mjs <worker.js>",
    );
  }
  const artifactPath = resolve(process.cwd(), artifactArgument);
  assertSmoke(
    statSync(artifactPath).isFile(),
    `${artifactArgument} is not a file`,
  );
  const artifactDigest = `sha256:${sha256(readFileSync(artifactPath))}`;
  const bundle = readSchemaBundle();
  const names = bundle.entries.map((entry) => entry.name);

  phase("opt-in-required", "start");
  await withWorker(artifactPath, {}, async (worker) => {
    const db = await worker.getD1Database("DB");
    const response = await worker.dispatchFetch(`${APP_ORIGIN}/healthz`);
    await response.arrayBuffer();
    assertSmoke(
      !(await hasLedger(db)),
      "a Worker without YURUCOMMU_APPLY_BUNDLED_MIGRATIONS touched the schema",
    );
  });
  phase("opt-in-required", "done");

  const reference = wholeFileReference(bundle);

  phase("worker-applied-schema", "start");
  const evidence = await withWorker(
    artifactPath,
    { YURUCOMMU_APPLY_BUNDLED_MIGRATIONS: "true" },
    async (worker) => {
      const db = await worker.getD1Database("DB");
      assertSmoke(!(await hasLedger(db)), "the database was not empty");
      // Concurrent first requests race the same empty database.
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          worker.dispatchFetch(`${APP_ORIGIN}/readyz`),
        ),
      );
      const statuses = [];
      for (const response of responses) {
        statuses.push(response.status);
        await response.arrayBuffer();
      }
      assertSmoke(
        statuses.every((status) => status !== 503 && status < 500),
        `first requests did not wait for the schema: ${statuses.join(",")}`,
      );
      const ledger = await ledgerOf(db);
      assertSmoke(
        JSON.stringify(ledger) === JSON.stringify(names),
        `ledger ${JSON.stringify(ledger)} is not the bundle in order`,
      );
      const schema = await schemaOf(db);
      assertSmoke(
        schema.length > 50,
        "the migrated schema is implausibly small",
      );
      const differing =
        schema.length !== reference.length
          ? ["object count"]
          : schema
              .filter(
                (row, index) =>
                  JSON.stringify(row) !== JSON.stringify(reference[index]),
              )
              .map((row) => `${row.type}:${row.name}`);
      assertSmoke(
        differing.length === 0,
        `the Worker-applied schema differs from the whole-file bundle: ${differing.slice(0, 5).join(", ")}`,
      );

      // A second request applies nothing.
      await (await worker.dispatchFetch(`${APP_ORIGIN}/healthz`)).arrayBuffer();
      assertSmoke(
        (await ledgerOf(db)).length === names.length,
        "a later request changed the ledger",
      );

      // The migrated database serves the real first-owner sign-in.
      const login = await worker.dispatchFetch(`${APP_ORIGIN}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: JSON.stringify({ password: BOOTSTRAP_PASSWORD }),
      });
      const loginStatus = login.status;
      const cookies = login.headers
        .getSetCookie()
        .filter((header) => header.startsWith("session="));
      await login.arrayBuffer();
      assertSmoke(
        loginStatus === 200 && cookies.length === 1,
        `bootstrap sign-in failed on the migrated database (${loginStatus})`,
      );
      const owners = (
        await db.prepare("SELECT count(*) AS count FROM actors").all()
      ).results[0].count;
      assertSmoke(owners === 1, `expected one owner actor, found ${owners}`);
      return {
        concurrentFirstRequests: statuses,
        ledgerEntries: ledger.length,
        schemaObjects: schema.length,
        equalsWholeFileSchema: true,
        bootstrapSignIn: loginStatus,
      };
    },
  );
  phase("worker-applied-schema", "done");

  process.stdout.write(
    `${JSON.stringify({
      kind: "yurucommu.d1-worker-applied-schema-smoke@v1",
      status: "PASSED",
      artifact: artifactDigest,
      migrations: names.length,
      ...evidence,
    })}\n`,
  );
}

await main();
