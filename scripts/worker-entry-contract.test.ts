import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { createEntrySource } from "./build-yurucommu-worker.ts";

const entrySource = createEntrySource({});

const wranglerConfig = await readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);

const moduleSource = await readFile(
  new URL("../main.tf", import.meta.url),
  "utf8",
);

describe("generated worker entry", () => {
  // The cron trigger fires whatever the deployed module exports. This entry
  // builds its own default object rather than re-exporting the core one, so a
  // missing scheduled() here means the retention sweep never runs anywhere.
  test("exports a scheduled handler that forwards to the core retention sweep", () => {
    expect(entrySource).toContain("async scheduled(");
    expect(entrySource).toContain("yurucommuCore");
    expect(entrySource).toContain("runRetention(controller, env, ctx)");
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
      'resource "cloudflare_workers_cron_trigger" "retention"',
    );
  });
});

describe("managed bootstrap authentication", () => {
  test("fails closed instead of generating an undisclosed login credential", () => {
    expect(moduleSource).not.toContain(
      'resource "random_id" "bootstrap_auth_token"',
    );
    expect(moduleSource).toContain(
      'local.provided_auth_password_hash != "" || local.has_takosumi_accounts_oidc',
    );
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
