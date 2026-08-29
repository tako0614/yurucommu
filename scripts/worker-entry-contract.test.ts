import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
const takoformModuleSource = await readFile(
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
      "await runYurucommuRetention(runtimeEnv as Env)",
    );
  });

  test("pins a request-derived canonical origin for native queue work", () => {
    expect(entrySource).toContain("CANONICAL_ORIGIN_KV_KEY");
    expect(entrySource).toContain("withRequestAppUrl");
    expect(entrySource).toContain("withRequiredQueueAppUrl");
    expect(entrySource).toContain(
      "canonical request origin has not been observed; make one successful fetch before queue delivery",
    );
    expect(entrySource).not.toContain("worker_endpoint");
  });

  test("preserves direct delivery and DLQ identities and synthesizes only the single-consumer Host identity", () => {
    expect(entrySource).toContain("withDeliveryConsumerIdentity");
    expect(entrySource).toContain("Queue invocation has no native identity");
    expect(entrySource).toContain("The Provider is free to replace");
    expect(entrySource).toContain("env.DELIVERY_QUEUE_NAME?.trim()");
    expect(entrySource).toContain("env.DELIVERY_DLQ_NAME?.trim()");
    expect(entrySource).toContain(
      "return env; // The direct adapter already declares both distinct queue identities.",
    );
    expect(entrySource).toContain(
      "await withRequiredQueueAppUrl(wrapYurucommuWorkerBindings(env))",
    );
  });

  test("uses only stable native event handlers in the Provider lane", () => {
    expect(entrySource).toContain("handleYurucommuQueueBatch");
    expect(entrySource).not.toContain(
      "handleTakosumiBackgroundEventInvocation",
    );
    expect(entrySource).not.toContain("background-events");
    expect(entrySource).not.toContain("TAKOSUMI_MANAGED_RUNTIME");
  });

  test("built Worker keeps namespace-compatible OIDC owner pin matching", async () => {
    const buildWorker = (nodeEnv?: string) => {
      const env = { ...process.env };
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
      const build = Bun.spawnSync([process.execPath, "run", "build:worker"], {
        cwd: new URL("../", import.meta.url).pathname,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (build.exitCode !== 0) {
        throw new Error(
          `build:worker failed:\n${build.stderr.toString() || build.stdout.toString()}`,
        );
      }
    };

    // One exact build is enough here: the release digest below is the
    // environment-independent byte authority. Building twice made this test
    // race its 20s deadline on shared CI runners without adding a stronger
    // assertion.
    buildWorker("test");
    const workerSource = await readFile(
      new URL("../dist/yurucommu-worker.js", import.meta.url),
      "utf8",
    );
    const workerDigest = createHash("sha256")
      .update(workerSource)
      .digest("hex");
    expect(workerSource).toContain(
      "function configuredSubjectMatches(configuredSubject, providerUserId)",
    );
    expect(workerSource).toContain(
      "configuredSubject === providerUserId.slice(namespaceSeparator + 1)",
    );
    expect(workerSource).not.toContain("providerUserId !== ownerSub");
    const configuredDigest = moduleSource.match(
      /variable\s+"worker_bundle_sha256"[\s\S]*?default\s+=\s+"(sha256:[^"]+)"/u,
    )?.[1];
    expect(configuredDigest).toBe(`sha256:${workerDigest}`);
  }, 20_000);
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
    expect(takoformModuleSource).toContain(
      'resource "takoform_worker_cron_trigger" "retention"',
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
