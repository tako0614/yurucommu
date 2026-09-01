import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { createEntrySource } from "./build-yurucommu-worker.ts";

const entrySource = createEntrySource({});

const wranglerConfig = await readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);

const moduleSource = await readFile(
  new URL("../deploy/takoform/main.tf", import.meta.url),
  "utf8",
);

describe("generated worker entry", () => {
  // The cron trigger fires whatever the deployed module exports. This entry
  // builds its own default object rather than re-exporting the core one, so a
  // missing scheduled() here means the retention sweep never runs anywhere.
  test("exports a scheduled handler that forwards to the core retention sweep", () => {
    expect(entrySource).toContain("async scheduled(");
    expect(entrySource).toContain("runYurucommuRetention");
    expect(entrySource).toContain(
      "await runYurucommuRetention(withRequiredBackgroundAppUrl(runtimeEnv))",
    );
  });

  test("fails closed when a background invocation has no canonical app origin", () => {
    expect(entrySource).toContain("withRequiredBackgroundAppUrl");
    expect(entrySource).toContain(
      "APP_URL is required for queue and scheduled invocations",
    );
    expect(entrySource).toContain(
      "APP_URL must be an HTTPS origin for background invocations",
    );
    expect(entrySource).toContain(
      "await handleYurucommuQueueBatch(runtimeBatch, runtimeEnv as Env)",
    );
    expect(entrySource).toContain(
      "await runYurucommuRetention(withRequiredBackgroundAppUrl(runtimeEnv))",
    );
  });

  test("fails closed instead of acknowledging an unconfigured queue", () => {
    expect(entrySource).toContain("withRequiredQueueIdentity");
    expect(entrySource).toContain(
      "DELIVERY_QUEUE_NAME and DELIVERY_DLQ_NAME must identify distinct configured queues",
    );
    expect(entrySource).toContain(
      "Queue invocation does not match the configured queue identity",
    );
    expect(entrySource).toContain(
      "withRequiredBackgroundAppUrl(wrapYurucommuWorkerBindings(env))",
    );
  });

  test("does not embed a host-specific runtime or background ABI", () => {
    for (const forbidden of [
      "TAKOSUMI_MANAGED_RUNTIME",
      "managed-runtime-connections",
      "TakosumiBackgroundEvent",
      "@takosjp/takosumi-contract",
      "handleTakosumiBackgroundEventInvocation",
    ]) {
      expect(entrySource).not.toContain(forbidden);
    }
  });
});

describe("D1 migration ledger", () => {
  // Two ledgers over one non-idempotent migration set means the second runner
  // sees zero applied rows on an already-migrated database and replays 0001..
  // from the top, re-running table rebuilds against populated tables.
  // wrangler's default table is `d1_migrations`; the engine's own runners
  // (scripts/apply-takosumi-migrations.ts, src/backend/server.ts) use
  // `yurucommu_migrations`, so wrangler has to be pointed at the same one.
  test("wrangler shares the engine's ledger table", () => {
    expect(wranglerConfig).toContain(
      '"migrations_table": "yurucommu_migrations"',
    );
  });
});

describe("retention cron surface", () => {
  test("wrangler config schedules the sweep", () => {
    expect(wranglerConfig).toContain('"crons"');
  });

  // The Capsule path has no wrangler.jsonc, so the trigger must also exist as a
  // resource or an OpenTofu install silently never sweeps.
  test("the Capsule module schedules the sweep", () => {
    expect(moduleSource).toContain(
      'resource "takoform_worker_cron_trigger" "retention"',
    );
  });
});

describe("managed bootstrap authentication", () => {
  test("keeps authentication credentials in the declared sensitive binding set", () => {
    expect(moduleSource).not.toContain(
      'resource "random_id" "bootstrap_auth_token"',
    );
    expect(moduleSource).toContain('"ENCRYPTION_KEY"');
    expect(moduleSource).toContain('"TAKOSUMI_ACCOUNTS_CLIENT_ID"');
  });
});

describe("product browser media policy", () => {
  test("allows the QR camera without granting an unused microphone", () => {
    expect(entrySource).toContain('"camera": true');
    expect(entrySource).toContain('"microphone": false');
    expect(entrySource).toContain(
      '"camera=(self), microphone=(), geolocation=()"',
    );
  });
});
