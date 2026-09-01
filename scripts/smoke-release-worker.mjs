#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  applyMigrations,
  MIGRATION_LEDGER_TABLE,
} from "@takosjp/yurucommu-core/migrations";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_readConfig } from "wrangler";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const APP_ORIGIN = "https://release-smoke.yurucommu.invalid";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_LANES = ["direct-cloudflare", "hosted"];
const CORE_MIGRATIONS_DIR = resolve(
  dirname(
    dirname(
      fileURLToPath(import.meta.resolve("@takosjp/yurucommu-core/migrations")),
    ),
  ),
  "migrations",
);
const MEDIA_CONTENT_TYPE = "image/gif";
const AUTH_PASSWORD = "release-smoke-only";
const AUTH_PASSWORD_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000:" +
  "6efa1ed8f4f7e9690f944861a78d34a1d7d984d7043ca110811949f22c9216c7";
const MEDIA_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
  0x01, 0x00, 0x00, 0x02, 0x01, 0x4c, 0x00, 0x3b,
]);
const MAX_RUNTIME_DIAGNOSTICS = 16;
const MAX_RUNTIME_DIAGNOSTIC_BYTES = 8 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function boundedDiagnostic(value) {
  return String(value).slice(0, MAX_RUNTIME_DIAGNOSTIC_BYTES);
}

async function boundedBytes(response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel("release smoke response exceeded its byte limit");
        throw new Error(
          `release smoke response exceeds ${MAX_RESPONSE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function boundedText(response) {
  return new TextDecoder().decode(await boundedBytes(response));
}

async function requireJson(response, label) {
  const text = await boundedText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 200)}`);
  }
}

function createHostedMediaProbe() {
  const objects = new Map();
  const operations = [];
  let bodyPulls = 0;

  return {
    objects,
    operations,
    get bodyPulls() {
      return bodyPulls;
    },
    async fetch(request) {
      const url = new URL(request.url);
      if (
        url.origin !== "https://s3.invalid" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        request.headers.has("authorization") ||
        request.headers.has("x-amz-credential")
      ) {
        throw new Error(
          "hosted MEDIA received provider authority outside its sealed Fetcher",
        );
      }
      const key = url.pathname
        .slice(1)
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/");
      if (!key) return new Response(null, { status: 400 });

      if (request.method === "PUT") {
        const body = new Uint8Array(await request.arrayBuffer());
        const contentType = request.headers.get("content-type") ?? undefined;
        objects.set(key, {
          body: body.slice(),
          contentType,
          etag: `"${sha256(body)}"`,
        });
        operations.push({
          method: "PUT",
          key,
          body: body.slice(),
          contentType,
        });
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        const object = objects.get(key);
        operations.push({ method: "GET", key });
        if (!object) return new Response(null, { status: 404 });
        let emitted = false;
        const body = new ReadableStream({
          pull(controller) {
            if (emitted) return;
            emitted = true;
            bodyPulls += 1;
            controller.enqueue(object.body.slice());
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: {
            "content-length": String(object.body.byteLength),
            ...(object.contentType
              ? { "content-type": object.contentType }
              : {}),
            etag: object.etag,
          },
        });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        operations.push({ method: "DELETE", key });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  };
}

function recordRuntimeDiagnostic(diagnostics, value) {
  if (diagnostics.length >= MAX_RUNTIME_DIAGNOSTICS) return;
  diagnostics.push(boundedDiagnostic(value));
}

function createWorker(artifactPath, compatibility, mediaLane) {
  const runtimeDiagnostics = [];
  const hostedMediaProbe =
    mediaLane === "hosted" ? createHostedMediaProbe() : undefined;
  const mediaBinding = hostedMediaProbe
    ? { serviceBindings: { MEDIA: hostedMediaProbe.fetch } }
    : { r2Buckets: ["MEDIA"] };
  const worker = new Miniflare({
    rootPath: dirname(artifactPath),
    modules: [{ type: "ESModule", path: artifactPath }],
    modulesRoot: dirname(artifactPath),
    compatibilityDate: compatibility.compatibilityDate,
    compatibilityFlags: compatibility.compatibilityFlags,
    cf: false,
    log: new Log(LogLevel.NONE),
    logRequests: false,
    handleStructuredLogs(log) {
      const level = log.level.toLowerCase();
      if (level === "error" || level === "warn" || level === "warning") {
        recordRuntimeDiagnostic(
          runtimeDiagnostics,
          `${log.level}: ${log.message}`,
        );
      }
    },
    handleUncaughtError(error) {
      recordRuntimeDiagnostic(runtimeDiagnostics, error?.stack ?? error);
    },
    bindings: {
      APP_URL: APP_ORIGIN,
      AUTH_PASSWORD_HASH,
      DELIVERY_QUEUE_NAME: "yurucommu-delivery",
      DELIVERY_DLQ_NAME: "yurucommu-delivery-dlq",
      ENCRYPTION_KEY: "00".repeat(32),
    },
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    queueProducers: ["DELIVERY_QUEUE", "DELIVERY_DLQ"],
    ...mediaBinding,
  });
  return { worker, hostedMediaProbe, runtimeDiagnostics };
}

function flattenSqlForMiniflareD1(sql) {
  const lines = sql
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));
  const flattened = lines.join(" ");
  if (flattened.includes("--")) {
    throw new Error(
      "packaged migration contains an inline SQL comment that the Miniflare D1 smoke cannot flatten safely",
    );
  }
  return flattened;
}

async function packagedMigrationNames() {
  const entries = await readdir(CORE_MIGRATIONS_DIR, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (
    names.length === 0 ||
    names.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
  ) {
    throw new Error("packaged Core migration lineage is empty or malformed");
  }
  return names;
}

async function withCapturedMigrationOutput(operation) {
  const messages = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...values) => messages.push(values.map(String).join(" "));
  console.warn = (...values) => warnings.push(values.map(String).join(" "));
  try {
    const value = await operation();
    return { value, messages, warnings };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function applyPackagedMigrations(worker) {
  const database = await worker.getD1Database("DB");
  const migrationNames = await packagedMigrationNames();
  const {
    value: result,
    messages,
    warnings,
  } = await withCapturedMigrationOutput(() =>
    applyMigrations({
      resource: "release-smoke-d1",
      migrationsDir: CORE_MIGRATIONS_DIR,
      wrapTransactions: false,
      retryAttempts: 1,
      batchPendingMigrations: false,
      async executeSql(sql, context) {
        if (context.purpose === "ledger-read") {
          return await database.prepare(sql).all();
        }
        return await database.exec(flattenSqlForMiniflareD1(sql));
      },
    }),
  );
  if (warnings.length > 0) {
    throw new Error(
      `packaged migration runner warned: ${warnings.map(boundedDiagnostic).join(" | ")}`,
    );
  }
  if (
    result.skipped.length !== 0 ||
    JSON.stringify(result.applied) !== JSON.stringify(migrationNames) ||
    messages.length !== migrationNames.length
  ) {
    throw new Error(
      `packaged migration runner did not apply one fresh exact lineage: ${JSON.stringify(result)}`,
    );
  }

  const ledgerRows = await database
    .prepare(`SELECT name FROM ${MIGRATION_LEDGER_TABLE} ORDER BY name`)
    .all();
  const ledgerNames = ledgerRows.results.map((row) => row.name);
  if (JSON.stringify(ledgerNames) !== JSON.stringify(migrationNames)) {
    throw new Error(
      `migration ledger does not match packaged lineage: ${JSON.stringify(ledgerNames)}`,
    );
  }
  const ledgerTables = await database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) ORDER BY name",
    )
    .bind(MIGRATION_LEDGER_TABLE, "d1_migrations", "_cf_migrations")
    .all();
  if (
    JSON.stringify(ledgerTables.results.map((row) => row.name)) !==
    JSON.stringify([MIGRATION_LEDGER_TABLE])
  ) {
    throw new Error(
      `release smoke found multiple migration ledgers: ${JSON.stringify(ledgerTables.results)}`,
    );
  }
  return { database, migrationCount: migrationNames.length };
}

async function requireOppositeMediaRejection(
  artifactPath,
  compatibility,
  artifactLane,
) {
  const oppositeLane =
    artifactLane === "direct-cloudflare" ? "hosted" : "direct-cloudflare";
  const { worker, runtimeDiagnostics } = createWorker(
    artifactPath,
    compatibility,
    oppositeLane,
  );
  try {
    await worker.ready;
    const response = await worker.dispatchFetch(`${APP_ORIGIN}/readyz`, {
      headers: { accept: "application/json" },
    });
    const body = await boundedText(response);
    const expected =
      artifactLane === "direct-cloudflare"
        ? "MEDIA must be a native Cloudflare R2 binding"
        : "MEDIA must be an exact sealed S3 fetch binding";
    if (response.status < 500 || !body.includes(expected)) {
      throw new Error(
        `${artifactLane} artifact did not fail closed on ${oppositeLane} MEDIA bindings: status=${response.status} body=${body.slice(0, 200)}`,
      );
    }
    if (runtimeDiagnostics.length > 0) {
      throw new Error(
        `opposite-lane rejection emitted unexpected runtime diagnostics: ${runtimeDiagnostics.join(" | ")}`,
      );
    }
  } finally {
    await worker.dispose();
  }
}

async function requireSchemaBackedMobileLogin(worker) {
  let response;
  let payload;
  try {
    response = await worker.dispatchFetch(
      `${APP_ORIGIN}/api/auth/mobile/login`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: APP_ORIGIN,
        },
        body: JSON.stringify({ password: AUTH_PASSWORD }),
      },
    );
    payload = await requireJson(response, "/api/auth/mobile/login");
  } catch (error) {
    throw new Error(
      `schema-backed mobile login failed: ${boundedDiagnostic(error)}`,
    );
  }
  if (
    response.status !== 200 ||
    payload.token_type !== "Bearer" ||
    typeof payload.access_token !== "string" ||
    payload.access_token.length < 16
  ) {
    throw new Error(
      `schema-backed mobile login failed: status=${response.status} payload=${JSON.stringify(payload)}`,
    );
  }
  return payload.access_token;
}

function authenticatedHeaders(accessToken, contentType) {
  return {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    origin: APP_ORIGIN,
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

async function requireSuccessfulJson(response, label) {
  const payload = await requireJson(response, label);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `${label} failed with ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function requireDirectStoredObject(worker, key) {
  const bucket = await worker.getR2Bucket("MEDIA");
  const object = await bucket.get(key);
  if (!object) throw new Error("native R2 did not persist the uploaded object");
  const body = new Uint8Array(await object.arrayBuffer());
  if (
    !bytesEqual(body, MEDIA_BYTES) ||
    object.httpMetadata?.contentType !== MEDIA_CONTENT_TYPE
  ) {
    throw new Error(
      `native R2 did not preserve exact body/content type for ${key}`,
    );
  }
  return bucket;
}

function requireHostedStoredObject(hostedMediaProbe, key) {
  const object = hostedMediaProbe?.objects.get(key);
  const put = hostedMediaProbe?.operations.find(
    (operation) => operation.method === "PUT" && operation.key === key,
  );
  if (
    !object ||
    !put ||
    !bytesEqual(object.body, MEDIA_BYTES) ||
    !bytesEqual(put.body, MEDIA_BYTES) ||
    object.contentType !== MEDIA_CONTENT_TYPE ||
    put.contentType !== MEDIA_CONTENT_TYPE
  ) {
    throw new Error(
      `hosted Fetcher did not preserve exact body/content type for ${key}`,
    );
  }
}

async function exerciseMediaCrud(
  worker,
  database,
  hostedMediaProbe,
  artifactLane,
) {
  const accessToken = await requireSchemaBackedMobileLogin(worker);
  const formData = new FormData();
  formData.append(
    "file",
    new File([MEDIA_BYTES], "release-smoke.gif", {
      type: MEDIA_CONTENT_TYPE,
    }),
  );
  const uploadResponse = await worker.dispatchFetch(
    `${APP_ORIGIN}/api/media/upload`,
    {
      method: "POST",
      headers: authenticatedHeaders(accessToken),
      body: formData,
    },
  );
  const upload = await requireSuccessfulJson(
    uploadResponse,
    "/api/media/upload",
  );
  if (
    typeof upload.id !== "string" ||
    !/^[a-f0-9]+$/u.test(upload.id) ||
    upload.url !== `/media/${upload.id}.gif` ||
    upload.r2_key !== `uploads/${upload.id}.gif` ||
    upload.content_type !== MEDIA_CONTENT_TYPE
  ) {
    throw new Error(
      `media upload returned an invalid identity: ${JSON.stringify(upload)}`,
    );
  }

  const directBucket =
    artifactLane === "direct-cloudflare"
      ? await requireDirectStoredObject(worker, upload.r2_key)
      : undefined;
  if (artifactLane === "hosted") {
    requireHostedStoredObject(hostedMediaProbe, upload.r2_key);
  }

  const readResponse = await worker.dispatchFetch(
    `${APP_ORIGIN}${upload.url}`,
    { headers: authenticatedHeaders(accessToken) },
  );
  const readBody = await boundedBytes(readResponse);
  if (
    readResponse.status !== 200 ||
    readResponse.headers.get("content-type") !== MEDIA_CONTENT_TYPE ||
    !bytesEqual(readBody, MEDIA_BYTES)
  ) {
    throw new Error(
      `media GET did not preserve exact lazy body/content type: status=${readResponse.status}`,
    );
  }

  for (const iconUrl of [upload.url, ""]) {
    const updateResponse = await worker.dispatchFetch(
      `${APP_ORIGIN}/api/actors/me`,
      {
        method: "PUT",
        headers: authenticatedHeaders(accessToken, "application/json"),
        body: JSON.stringify({ icon_url: iconUrl }),
      },
    );
    const update = await requireSuccessfulJson(
      updateResponse,
      "/api/actors/me",
    );
    if (update.success !== true) {
      throw new Error(
        `profile media lifecycle did not succeed: ${JSON.stringify(update)}`,
      );
    }
  }

  if (directBucket && (await directBucket.get(upload.r2_key)) !== null) {
    throw new Error("native R2 object remained after profile replacement GC");
  }
  if (hostedMediaProbe) {
    if (hostedMediaProbe.objects.has(upload.r2_key)) {
      throw new Error(
        "hosted Fetcher object remained after profile replacement GC",
      );
    }
    const methods = hostedMediaProbe.operations
      .filter((operation) => operation.key === upload.r2_key)
      .map((operation) => operation.method);
    if (
      JSON.stringify(methods) !== JSON.stringify(["PUT", "GET", "DELETE"]) ||
      hostedMediaProbe.bodyPulls !== 1
    ) {
      throw new Error(
        `hosted Fetcher did not observe one lazy PUT/GET/DELETE lifecycle: ${JSON.stringify({ methods, bodyPulls: hostedMediaProbe.bodyPulls })}`,
      );
    }
  }

  const mediaRows = await database
    .prepare("SELECT COUNT(*) AS count FROM media_uploads")
    .first();
  const actorRows = await database
    .prepare("SELECT COUNT(*) AS count FROM actors WHERE role = ?")
    .bind("owner")
    .first();
  if (mediaRows?.count !== 0 || actorRows?.count !== 1) {
    throw new Error(
      `schema-backed media lifecycle left unexpected rows: ${JSON.stringify({ mediaRows, actorRows })}`,
    );
  }
}

function requireNoRuntimeDiagnostics(runtimeDiagnostics) {
  if (runtimeDiagnostics.length > 0) {
    throw new Error(
      `Worker emitted unexpected runtime diagnostics: ${runtimeDiagnostics.join(" | ")}`,
    );
  }
}

async function smokeWorkerLane(artifactPath, artifactDigest, artifactLane) {
  const sourceConfig = unstable_readConfig(
    { config: resolve(repo, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  if (!sourceConfig.compatibility_date) {
    throw new Error("wrangler.jsonc must declare compatibility_date");
  }
  const compatibility = {
    compatibilityDate: sourceConfig.compatibility_date,
    compatibilityFlags: sourceConfig.compatibility_flags,
  };
  const { worker, hostedMediaProbe, runtimeDiagnostics } = createWorker(
    artifactPath,
    compatibility,
    artifactLane,
  );

  try {
    await worker.ready;
    const { database, migrationCount } = await applyPackagedMigrations(worker);
    await exerciseMediaCrud(worker, database, hostedMediaProbe, artifactLane);

    const readyResponse = await worker.dispatchFetch(`${APP_ORIGIN}/readyz`, {
      headers: { accept: "application/json" },
    });
    const ready = await requireJson(readyResponse, "/readyz");
    if (
      readyResponse.status !== 200 ||
      ready.status !== "ok" ||
      ready.service !== "yurucommu" ||
      !Array.isArray(ready.missingBindings) ||
      ready.missingBindings.length !== 0
    ) {
      throw new Error(
        `/readyz did not accept the ${artifactLane} bindings: ${JSON.stringify(ready)}`,
      );
    }

    const discoveryResponse = await worker.dispatchFetch(
      `${APP_ORIGIN}/.well-known/yurucommu`,
      { headers: { accept: "application/json" } },
    );
    const discovery = await requireJson(
      discoveryResponse,
      "/.well-known/yurucommu",
    );
    if (
      discoveryResponse.status !== 200 ||
      discovery.product !== "yurucommu" ||
      discovery.server?.canonicalOrigin !== APP_ORIGIN
    ) {
      throw new Error(
        `discovery did not expose the expected identity: ${JSON.stringify(discovery)}`,
      );
    }

    const uiResponse = await worker.dispatchFetch(`${APP_ORIGIN}/`, {
      headers: { accept: "text/html" },
    });
    const ui = await boundedText(uiResponse);
    if (
      uiResponse.status !== 200 ||
      !uiResponse.headers.get("content-type")?.includes("text/html") ||
      !ui.includes("<title>Yurucommu</title>") ||
      !ui.includes('id="root"')
    ) {
      throw new Error("embedded Yurucommu UI did not boot from the artifact");
    }

    await requireOppositeMediaRejection(
      artifactPath,
      compatibility,
      artifactLane,
    );
    requireNoRuntimeDiagnostics(runtimeDiagnostics);

    return {
      kind: "yurucommu.release-worker-smoke@v1",
      artifact: basename(artifactPath),
      sha256: `sha256:${artifactDigest}`,
      runtime: "workerd",
      lane: artifactLane,
      compatibilityDate: sourceConfig.compatibility_date,
      compatibilityFlags: sourceConfig.compatibility_flags,
      substrate:
        artifactLane === "direct-cloudflare"
          ? "native-cloudflare-r2"
          : "sealed-s3-fetch",
      migrationCount,
      checks: [
        "packaged-migration-lineage",
        "single-yurucommu-migration-ledger",
        "schema-backed-mobile-login",
        "media-put-exact-body-content-type",
        "media-get-lazy-body-content-type",
        "media-delete-and-absence",
        "readyz",
        "discovery",
        "embedded-ui",
        "cross-reject-opposite-media",
        "no-runtime-errors",
      ],
      status: "PASSED",
    };
  } finally {
    await worker.dispose();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const laneFlagIndex = args.indexOf("--lane");
  const artifactLane = laneFlagIndex >= 0 ? args[laneFlagIndex + 1] : undefined;
  if (laneFlagIndex >= 0) args.splice(laneFlagIndex, 2);
  const [artifactArgument, expectedDigestArgument] = args;
  if (
    !artifactArgument ||
    args.length > 2 ||
    laneFlagIndex < 0 ||
    !ARTIFACT_LANES.includes(artifactLane)
  ) {
    throw new Error(
      "usage: bun scripts/smoke-release-worker.mjs <worker.js> [sha256:<digest>] --lane direct-cloudflare|hosted",
    );
  }
  const artifactPath = resolve(process.cwd(), artifactArgument);
  if (!statSync(artifactPath).isFile()) {
    throw new Error(`${artifactArgument} is not a Worker artifact file`);
  }
  const artifactDigest = sha256(readFileSync(artifactPath));
  if (
    expectedDigestArgument !== undefined &&
    expectedDigestArgument !== `sha256:${artifactDigest}`
  ) {
    throw new Error(
      `artifact digest sha256:${artifactDigest} does not equal ${expectedDigestArgument}`,
    );
  }
  const result = await smokeWorkerLane(
    artifactPath,
    artifactDigest,
    artifactLane,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
