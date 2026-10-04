#!/usr/bin/env node

import { createHash, pbkdf2Sync } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { unstable_readConfig, unstable_splitSqlQuery } from "wrangler";
import { qualifyProductJourneys } from "./release-product-journeys.mjs";
import { qualifyOwnerOnboarding } from "./release-owner-onboarding.mjs";
import { createManagedNativeRuntime } from "./native-runtime-stdio.mjs";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TEST_PASSWORD = "release-smoke-only";
const TEST_PASSWORD_SALT = Buffer.alloc(32, 0xa1);
const PASSWORD_FIXTURES = [
  {
    method: "pbkdf2-sha256",
    hash: `${TEST_PASSWORD_SALT.toString("hex")}:${pbkdf2Sync(TEST_PASSWORD, TEST_PASSWORD_SALT, 100000, 32, "sha256").toString("hex")}`,
  },
  { method: "bootstrap", hash: TEST_PASSWORD },
];
const APP_ORIGIN = "https://release-smoke.yurucommu.invalid";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DELIVERY_QUEUE = "yurucommu-delivery";
const DELIVERY_DLQ = "yurucommu-delivery-dlq";
const SESSION_SALT = "release-smoke-only-session-salt";
const smokeStartedAt = performance.now();

function phase(lane, name, state) {
  const elapsedMs = Math.round(performance.now() - smokeStartedAt);
  process.stderr.write(
    `[native-smoke] lane=${lane} phase=${name} state=${state} elapsed_ms=${elapsedMs}\n`,
  );
}

async function runPhase(lane, name, action) {
  phase(lane, name, "start");
  try {
    const result = await action();
    phase(lane, name, "done");
    return result;
  } catch (error) {
    phase(lane, name, "failed");
    throw error;
  }
}

async function applyProductSchema(worker) {
  const schemaBytes = readFileSync(
    resolve(repo, "deploy/takoform/migrations/schema-bundle.json"),
  );
  const schema = JSON.parse(schemaBytes);
  if (
    schema.apiVersion !== "takosumi.resource-migrations/v1" ||
    schema.engine !== "sqlite" ||
    !Array.isArray(schema.entries) ||
    schema.entries.length === 0
  ) {
    throw new Error("release smoke requires the product migration bundle");
  }
  const db = await worker.getD1Database("DB");
  for (const entry of schema.entries) {
    if (
      typeof entry.sql !== "string" ||
      entry.sha256 !== `sha256:${sha256(entry.sql)}`
    ) {
      throw new Error(`migration digest mismatch: ${entry.name}`);
    }
    // Each product-owned migration is one atomic native D1 batch, including
    // the bundled foreign-key-safe table-rebuild override.
    await db.batch(
      unstable_splitSqlQuery(entry.sql).map((sql) => db.prepare(sql)),
    );
  }
  return {
    db,
    schemaSha256: `sha256:${sha256(schemaBytes)}`,
    migrationCount: schema.entries.length,
  };
}

async function qualifyBackgroundEvents(worker, lane) {
  const { db, schemaSha256, migrationCount } = await runPhase(
    lane,
    "background-schema",
    () => applyProductSchema(worker),
  );

  const author = `${APP_ORIGIN}/ap/users/smoke`;
  await db
    .prepare(
      `INSERT INTO actors (ap_id, preferred_username, inbox, outbox,
        followers_url, following_url, public_key_pem, private_key_pem, post_count)
       VALUES (?, 'smoke', ?, ?, ?, ?, 'fixture', 'fixture', 2)`,
    )
    .bind(
      author,
      `${author}/inbox`,
      `${author}/outbox`,
      `${author}/followers`,
      `${author}/following`,
    )
    .run();

  const native = await worker.getWorker();
  for (const [label, queue, expectedStatus, autoDlqAttempt] of [
    ["queue-fanout", DELIVERY_QUEUE, "completed", 0],
    ["queue-dlq", DELIVERY_DLQ, "failed", 3],
  ]) {
    phase(lane, `background-${label}`, "start");
    const activity = `${APP_ORIGIN}/ap/activities/${label}`;
    const id = sha256(`fanout|followers|${activity}|${author}|`);
    await db.batch([
      db
        .prepare(
          "INSERT INTO activities (ap_id, type, actor_ap_id, raw_json) VALUES (?, 'Create', ?, '{}')",
        )
        .bind(activity, author),
      db
        .prepare(
          "INSERT INTO delivery_fanouts (id, activity_ap_id, kind, target_ap_id, status) VALUES (?, ?, 'followers', ?, 'published')",
        )
        .bind(id, activity, author),
    ]);
    const result = await native.queue(queue, [
      {
        id: label,
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1,
          type: "fanout_followers",
          activityId: activity,
          followeeApId: author,
          scheduledAt: new Date().toISOString(),
          autoDlqAttempt,
        },
      },
    ]);
    if (
      result.outcome !== "ok" ||
      result.retryBatch?.retry ||
      result.retryMessages.length !== 0 ||
      !result.explicitAcks.includes(label)
    ) {
      throw new Error(
        `${label} was not explicitly acknowledged: ${JSON.stringify(result)}`,
      );
    }
    const row = await db
      .prepare(
        "SELECT status, last_error, completed_at FROM delivery_fanouts WHERE id = ?",
      )
      .bind(id)
      .first();
    if (
      row?.status !== expectedStatus ||
      !row.completed_at ||
      (label === "queue-dlq" && !row.last_error)
    ) {
      throw new Error(
        `${label} did not persist its ${expectedStatus} outbox result`,
      );
    }
    phase(lane, `background-${label}`, "done");
  }

  const media = await worker.getR2Bucket("MEDIA");
  const fixtures = [
    { name: "expired", end: "2000-01-01T00:00:00.000Z" },
    { name: "active", end: "2999-01-01T00:00:00.000Z" },
  ];
  for (const { name, end } of fixtures) {
    const key = `uploads/release-smoke-${name}.webp`;
    await media.put(key, `release-smoke-${name}`);
    await db.batch([
      db
        .prepare(
          "INSERT INTO objects (ap_id, type, attributed_to, attachments_json, end_time) VALUES (?, 'Story', ?, ?, ?)",
        )
        .bind(
          `${APP_ORIGIN}/ap/objects/${name}`,
          author,
          JSON.stringify([{ r2_key: key }]),
          end,
        ),
      db
        .prepare(
          "INSERT INTO media_uploads (id, r2_key, uploader_ap_id, content_type, size) VALUES (?, ?, ?, 'image/webp', ?)",
        )
        .bind(name, key, author, `release-smoke-${name}`.length),
    ]);
  }

  // Repeat the exact native event to catch a missing await, a no-op export,
  // incorrect MEDIA adaptation, or double-decrementing the author's counter.
  for (let pass = 0; pass < 2; pass++) {
    phase(lane, `background-scheduled-retention-${pass + 1}`, "start");
    const result = await native.scheduled({
      cron: "0 * * * *",
      scheduledTime: new Date(),
    });
    if (result.outcome !== "ok") {
      throw new Error(`scheduled retention failed: ${JSON.stringify(result)}`);
    }
    for (const { name } of fixtures) {
      const expected = name === "active";
      const object = await db
        .prepare("SELECT ap_id FROM objects WHERE ap_id = ?")
        .bind(`${APP_ORIGIN}/ap/objects/${name}`)
        .first();
      const upload = await db
        .prepare("SELECT id FROM media_uploads WHERE id = ?")
        .bind(name)
        .first();
      const blob = await media.get(`uploads/release-smoke-${name}.webp`);
      if (
        Boolean(object) !== expected ||
        Boolean(upload) !== expected ||
        Boolean(blob) !== expected
      ) {
        throw new Error(
          `scheduled retention did not preserve the expected ${name} story/media state`,
        );
      }
      if (blob && (await blob.text()) !== `release-smoke-${name}`) {
        throw new Error("scheduled retention changed the active media bytes");
      }
    }
    const actor = await db
      .prepare("SELECT post_count FROM actors WHERE ap_id = ?")
      .bind(author)
      .first();
    if (actor?.post_count !== 1) {
      throw new Error(
        "scheduled retention did not decrement the story count exactly once",
      );
    }
    phase(lane, `background-scheduled-retention-${pass + 1}`, "done");
  }
  return {
    schemaSha256,
    migrationCount,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedText(response) {
  if (!response.body) return "";
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
  return new TextDecoder().decode(bytes);
}

async function requireJson(response, label) {
  const text = await boundedText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 200)}`);
  }
}

function nativeWorker(artifactPath, passwordFixture) {
  const sourceConfig = unstable_readConfig(
    { config: resolve(repo, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  if (!sourceConfig.compatibility_date) {
    throw new Error("wrangler.jsonc must declare compatibility_date");
  }
  return createManagedNativeRuntime(
    (handleRuntimeStdio) =>
      new Miniflare({
        rootPath: dirname(artifactPath),
        modules: [{ type: "ESModule", path: artifactPath }],
        modulesRoot: dirname(artifactPath),
        compatibilityDate: sourceConfig.compatibility_date,
        compatibilityFlags: sourceConfig.compatibility_flags,
        cf: false,
        bindings: {
          APP_URL: APP_ORIGIN,
          AUTH_PASSWORD_HASH: passwordFixture.hash,
          YURUCOMMU_SESSION_HASH_SALT: SESSION_SALT,
          DELIVERY_QUEUE_NAME: DELIVERY_QUEUE,
          DELIVERY_DLQ_NAME: DELIVERY_DLQ,
          ENCRYPTION_KEY: "00".repeat(32),
        },
        d1Databases: ["DB"],
        kvNamespaces: ["KV"],
        r2Buckets: ["MEDIA"],
        queueProducers: ["DELIVERY_QUEUE", "DELIVERY_DLQ"],
        // Application diagnostics go to stderr; stdout is one evidence document.
        handleRuntimeStdio,
      }),
  );
}

async function smokeFreshOwner(artifactPath, passwordFixture, firstTransport) {
  const lane = `fresh-owner-${passwordFixture.method}-${firstTransport}`;
  const { worker, dispose } = nativeWorker(artifactPath, passwordFixture);
  let primaryFailed = false;
  try {
    await runPhase(lane, "runtime-ready", () => worker.ready);
    // Separate disposable bindings; this lane never seeds an actor or session.
    const { db: _db, ...schema } = await runPhase(lane, "schema", () =>
      applyProductSchema(worker),
    );
    const onboarding = await runPhase(lane, "owner-onboarding", () =>
      qualifyOwnerOnboarding(worker, {
        origin: APP_ORIGIN,
        password: TEST_PASSWORD,
        sessionSalt: SESSION_SALT,
        readJson: requireJson,
        firstTransport,
      }),
    );
    return { passwordMethod: passwordFixture.method, ...schema, ...onboarding };
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    phase(lane, "dispose", "start");
    try {
      await dispose();
      phase(lane, "dispose", "done");
    } catch (error) {
      phase(lane, "dispose", "failed");
      if (!primaryFailed) throw error;
      process.stderr.write(`release-worker cleanup also failed: ${error}\n`);
    }
  }
}

async function smokeNativeWorker(
  artifactPath,
  artifactDigest,
  passwordFixture,
) {
  const lane = `native-${passwordFixture.method}`;
  const { worker, dispose } = nativeWorker(artifactPath, passwordFixture);
  let primaryFailed = false;
  try {
    const sourceConfig = unstable_readConfig(
      { config: resolve(repo, "wrangler.jsonc") },
      { hideWarnings: true },
    );
    await runPhase(lane, "runtime-ready", () => worker.ready);
    // HTTP middleware can enqueue durable outbox work. Prepare and exercise
    // the product schema before any request reaches those background tasks.
    const background = await runPhase(lane, "background-events", () =>
      qualifyBackgroundEvents(worker, lane),
    );

    const { readyResponse, ready } = await runPhase(
      lane,
      "readyz",
      async () => {
        const readyResponse = await worker.dispatchFetch(
          `${APP_ORIGIN}/readyz`,
          {
            headers: { accept: "application/json" },
          },
        );
        return {
          readyResponse,
          ready: await requireJson(readyResponse, "/readyz"),
        };
      },
    );
    if (
      readyResponse.status !== 200 ||
      ready.status !== "ok" ||
      ready.service !== "yurucommu" ||
      !Array.isArray(ready.missingBindings) ||
      ready.missingBindings.length !== 0
    ) {
      throw new Error(
        `/readyz did not accept the runtime-native bindings: ${JSON.stringify(ready)}`,
      );
    }

    const { discoveryResponse, discovery } = await runPhase(
      lane,
      "discovery",
      async () => {
        const discoveryResponse = await worker.dispatchFetch(
          `${APP_ORIGIN}/.well-known/yurucommu`,
          { headers: { accept: "application/json" } },
        );
        return {
          discoveryResponse,
          discovery: await requireJson(
            discoveryResponse,
            "/.well-known/yurucommu",
          ),
        };
      },
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

    const { uiResponse, ui } = await runPhase(lane, "embedded-ui", async () => {
      const uiResponse = await worker.dispatchFetch(`${APP_ORIGIN}/`, {
        headers: { accept: "text/html" },
      });
      return { uiResponse, ui: await boundedText(uiResponse) };
    });
    if (
      uiResponse.status !== 200 ||
      !uiResponse.headers.get("content-type")?.includes("text/html") ||
      !ui.includes("<title>Yurucommu</title>") ||
      !ui.includes('id="root"')
    ) {
      throw new Error("embedded Yurucommu UI did not boot from the artifact");
    }

    const journeys = await runPhase(lane, "product-journeys", () =>
      qualifyProductJourneys(worker, {
        origin: APP_ORIGIN,
        password: TEST_PASSWORD,
        sessionSalt: SESSION_SALT,
        readJson: requireJson,
      }),
    );

    return {
      kind: "yurucommu.release-worker-smoke@v1",
      artifact: basename(artifactPath),
      sha256: `sha256:${artifactDigest}`,
      runtime: "workerd",
      compatibilityDate: sourceConfig.compatibility_date,
      compatibilityFlags: sourceConfig.compatibility_flags,
      substrate: "runtime-native-bindings",
      ...background,
      checks: [
        "readyz",
        "discovery",
        "embedded-ui",
        "queue-fanout",
        "queue-dlq",
        "scheduled-retention",
        "scheduled-retention-idempotence",
        ...journeys,
      ],
      status: "PASSED",
    };
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    phase(lane, "dispose", "start");
    try {
      await dispose();
      phase(lane, "dispose", "done");
    } catch (error) {
      phase(lane, "dispose", "failed");
      if (!primaryFailed) throw error;
      process.stderr.write(`release-worker cleanup also failed: ${error}\n`);
    }
  }
}

async function main() {
  phase("main", "artifact-identity", "start");
  const [artifactArgument, expectedDigestArgument] = process.argv.slice(2);
  if (!artifactArgument || process.argv.length > 4) {
    throw new Error(
      "usage: node scripts/smoke-release-worker.mjs <worker.js> [sha256:<digest>]",
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
  phase("main", "artifact-identity", "done");
  const results = [];
  for (const fixture of PASSWORD_FIXTURES) {
    phase(`native-${fixture.method}`, "fixture", "start");
    // Separate disposable bindings; both auth paths must pass on these bytes.
    results.push(
      await smokeNativeWorker(artifactPath, artifactDigest, fixture),
    );
    phase(`native-${fixture.method}`, "fixture", "done");
  }
  const onboarding = [];
  for (const fixture of PASSWORD_FIXTURES) {
    for (const firstTransport of ["browser", "mobile"]) {
      phase(
        `fresh-owner-${fixture.method}-${firstTransport}`,
        "fixture",
        "start",
      );
      onboarding.push(
        await smokeFreshOwner(artifactPath, fixture, firstTransport),
      );
      phase(
        `fresh-owner-${fixture.method}-${firstTransport}`,
        "fixture",
        "done",
      );
    }
  }
  phase("main", "manifest", "start");
  process.stdout.write(
    `${JSON.stringify({
      ...results[0],
      authentication: {
        passwordMethods: PASSWORD_FIXTURES.map((fixture) => fixture.method),
        actor: "preexisting-fixture-owner",
        revocation: "salted SQL disappearance and replay refusal",
      },
      onboarding: {
        substrate: "fresh-native-bindings",
        cases: onboarding,
      },
    })}\n`,
  );
  phase("main", "manifest", "done");
}

await main();
