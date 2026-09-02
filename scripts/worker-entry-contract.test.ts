import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { wrapRuntimeMessageBatch } from "@takosjp/yurucommu-core/server";

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

  // The lane names the BINDING SHAPE the host projects, and the entry has to
  // apply that one declaration to both halves of a queue event: the bindings
  // and the batch. Wrapping only the bindings would hand a facade batch
  // (acknowledgeAll) to code that calls ackAll.
  test("resolves the declared lane once and adapts both bindings and batch with it", () => {
    expect(entrySource).toContain("resolveYurucommuRuntimeLane");
    expect(entrySource).toContain(
      "const lane = resolveYurucommuRuntimeLane(env);",
    );
    expect(entrySource).toContain(
      "wrapRuntimeMessageBatch<DeliveryMessage>(batch, lane)",
    );
    expect(entrySource).toContain(
      "return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env)",
    );
    // fetch, queue, and scheduled all compose through the same call.
    expect(
      entrySource.match(/wrapYurucommuWorkerBindings\(env\)/g),
    ).toHaveLength(3);
    // Retired composition: an external S3 seam and a lane value the core
    // refuses outright.
    expect(entrySource).not.toContain("adaptSealedS3ObjectStore");
    expect(entrySource).not.toContain("takoform-v1");
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

    // One exact build is enough to prove this source survives bundling.
    // Building twice made this test race its 20s deadline on shared CI runners;
    // release-byte identity belongs to the separate release guard/smoke lane.
    buildWorker("test");
    const workerSource = await readFile(
      new URL("../dist/yurucommu-worker.js", import.meta.url),
      "utf8",
    );
    expect(workerSource).toContain(
      "function configuredSubjectMatches(configuredSubject, providerUserId)",
    );
    expect(workerSource).toContain(
      "configuredSubject === providerUserId.slice(namespaceSeparator + 1)",
    );
    expect(workerSource).not.toContain("providerUserId !== ownerSub");
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

// A queue event arrives in one of two shapes, and `withDeliveryConsumerIdentity`
// reads `batch.queue` off the WRAPPED batch. These prove that field survives
// both wrappers identically, which is what makes that read lane-independent.
describe("queue batch wrapping per lane", () => {
  function cloudflareBatch(queue: string, settled: string[]) {
    return {
      queue,
      messages: [
        {
          id: "m1",
          timestamp: new Date("2026-09-01T00:00:00.000Z"),
          attempts: 1,
          body: { type: "deliver_endpoint" },
          ack: () => settled.push("ack:m1"),
          retry: () => settled.push("retry:m1"),
        },
      ],
      ackAll: () => settled.push("ackAll"),
      retryAll: () => settled.push("retryAll"),
    };
  }

  function facadeBatch(queue: string, settled: string[]) {
    return {
      batchId: "b1",
      queue,
      messages: [
        {
          id: "m1",
          timestampMillis: Date.parse("2026-09-01T00:00:00.000Z"),
          attempts: 1,
          // The facade carries bodies as bytes; the producer's JSON encoding is
          // what the consumer side undoes.
          body: {
            encoding: "base64",
            data: btoa(JSON.stringify({ type: "deliver_endpoint" })),
          },
          acknowledge: () => settled.push("ack:m1"),
          retry: () => settled.push("retry:m1"),
        },
      ],
      acknowledgeAll: () => settled.push("ackAll"),
      retryAll: () => settled.push("retryAll"),
    };
  }

  test("carries the queue identity and settles through Cloudflare's batch", () => {
    const settled: string[] = [];
    const wrapped = wrapRuntimeMessageBatch(
      cloudflareBatch("yurucommu-delivery", settled) as never,
      "cloudflare",
    );
    expect(wrapped.queue).toBe("yurucommu-delivery");
    expect(wrapped.messages[0]?.body).toEqual({ type: "deliver_endpoint" });
    wrapped.ackAll();
    expect(settled).toEqual(["ackAll"]);
  });

  test("carries the same queue identity and settles through the facade batch", () => {
    const settled: string[] = [];
    const wrapped = wrapRuntimeMessageBatch(
      facadeBatch("yurucommu-delivery", settled) as never,
      "portable",
    );
    expect(wrapped.queue).toBe("yurucommu-delivery");
    expect(wrapped.messages[0]?.body).toEqual({ type: "deliver_endpoint" });
    wrapped.ackAll();
    expect(settled).toEqual(["ackAll"]);
  });

  test("refuses a batch whose shape contradicts the declared lane", () => {
    expect(() =>
      wrapRuntimeMessageBatch(cloudflareBatch("q", []) as never, "portable"),
    ).toThrow(/MessageBatch/);
    expect(() =>
      wrapRuntimeMessageBatch(facadeBatch("q", []) as never, "cloudflare"),
    ).toThrow(/acknowledgeAll/);
  });
});

describe("generated entry lane behavior", () => {
  const entryFile = new URL(
    "../dist/yurucommu-entry.lane-test.ts",
    import.meta.url,
  );
  let entry: {
    default: {
      queue(batch: unknown, env: unknown, ctx: unknown): Promise<void>;
    };
  };

  afterAll(async () => {
    await rm(entryFile, { force: true });
  });

  async function loadEntry() {
    if (entry) return entry;
    await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
    await writeFile(entryFile, createEntrySource({}));
    entry = (await import(
      pathToFileURL(entryFile.pathname).href
    )) as typeof entry;
    return entry;
  }

  // Neither of these can be told apart from its counterpart by shape, which is
  // exactly why the lane is declared: `edge.kv` and a KV namespace expose the
  // same five methods.
  const kv = () => ({
    get: async () => null,
    getWithMetadata: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, listComplete: true }),
  });
  const nativeD1 = () => ({
    prepare: () => ({}),
    batch: async () => [],
    exec: async () => ({}),
  });
  const edgeSql = () => ({
    execute: async () => ({ rows: [], rowsWritten: 0 }),
    query: async () => ({ rows: [], rowsWritten: 0 }),
    transaction: async () => [],
  });

  function env(overrides: Record<string, unknown> = {}) {
    return {
      DB: nativeD1(),
      KV: kv(),
      APP_URL: "https://yurucommu.example.test",
      // Configured on both sides, so the entry keeps the direct identities and
      // an unrecognised queue name settles instead of reaching the database.
      DELIVERY_QUEUE_NAME: "configured-delivery",
      DELIVERY_DLQ_NAME: "configured-delivery-dlq",
      ...overrides,
    };
  }

  function cloudflareBatch(settled: string[], queue = "some-other-queue") {
    return {
      queue,
      messages: [],
      ackAll: () => settled.push("ackAll"),
      retryAll: () => settled.push("retryAll"),
    };
  }

  function facadeBatch(settled: string[], queue = "some-other-queue") {
    return {
      batchId: "b1",
      queue,
      messages: [],
      acknowledgeAll: () => settled.push("ackAll"),
      retryAll: () => settled.push("retryAll"),
    };
  }

  test("an undeclared lane is the raw Cloudflare bindings", async () => {
    const { default: worker } = await loadEntry();
    const settled: string[] = [];
    await worker.queue(cloudflareBatch(settled), env(), {});
    expect(settled).toEqual(["ackAll"]);
  });

  test("portable takes the facade bindings and the facade batch", async () => {
    const { default: worker } = await loadEntry();
    const settled: string[] = [];
    await worker.queue(
      facadeBatch(settled),
      env({ YURUCOMMU_RUNTIME_LANE: "portable", DB: edgeSql() }),
      {},
    );
    expect(settled).toEqual(["ackAll"]);
  });

  test("refuses a lane the build does not know rather than defaulting", async () => {
    const { default: worker } = await loadEntry();
    await expect(
      worker.queue(
        cloudflareBatch([]),
        env({ YURUCOMMU_RUNTIME_LANE: "takoform-v1" }),
        {},
      ),
    ).rejects.toThrow("YURUCOMMU_RUNTIME_LANE");
  });

  test("refuses a declaration the arriving bindings or batch contradict", async () => {
    const { default: worker } = await loadEntry();
    // Facade batch, undeclared lane.
    await expect(worker.queue(facadeBatch([]), env(), {})).rejects.toThrow(
      /acknowledgeAll/,
    );
    // Portable declared, raw D1 binding.
    await expect(
      worker.queue(
        facadeBatch([]),
        env({ YURUCOMMU_RUNTIME_LANE: "portable" }),
        {},
      ),
    ).rejects.toThrow(/D1Database/);
  });

  // The queue identity is read off the wrapped batch, so a host that invokes
  // the consumer without one fails closed on either lane rather than falling
  // back to a guessed delivery-queue name.
  test("fails closed when a facade invocation carries no queue identity", async () => {
    const { default: worker } = await loadEntry();
    await expect(
      worker.queue(
        facadeBatch([], " "),
        {
          DB: edgeSql(),
          KV: kv(),
          APP_URL: "https://yurucommu.example.test",
          YURUCOMMU_RUNTIME_LANE: "portable",
        },
        {},
      ),
    ).rejects.toThrow("Queue invocation has no native identity");
  });
});
