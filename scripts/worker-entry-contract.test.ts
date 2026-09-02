import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  CANONICAL_ORIGIN_KV_KEY,
  PublicOriginError,
  resetObservedPublicOrigin,
  wrapRuntimeMessageBatch,
} from "@takosjp/yurucommu-core/server";

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

  // The origin every actor id, delivery signature, and `.well-known` document
  // is built from is ONE rule, and it belongs to the package that mints those
  // ids. This entry used to carry a second copy that also inferred an origin on
  // the cloudflare lane — a Worker there answers on workers.dev and on every
  // custom domain the account holds, so that copy let the first hostname to
  // arrive name the instance for good.
  test("owns no public-origin rule of its own", () => {
    expect(entrySource).not.toContain("__yurucommu/runtime/canonical-origin");
    expect(entrySource).not.toContain("CANONICAL_ORIGIN_KV_KEY");
    expect(entrySource).not.toContain("withRequestAppUrl");
    expect(entrySource).not.toContain("withRequiredQueueAppUrl");
    expect(entrySource).not.toContain("function canonicalPublicOrigin");
    expect(entrySource).not.toContain("worker_endpoint");
  });

  // The request path calls nothing: `createYurucommuBackendApp` registers the
  // core's public-origin middleware ahead of every route, including /readyz and
  // the discovery documents. A call here would run after it and could only
  // disagree with it.
  test("delegates the request path to the core's middleware and the queue path to its background helper", () => {
    expect(entrySource).toContain("withRequiredBackgroundPublicOrigin");
    expect(entrySource).toContain(
      "await withRequiredBackgroundPublicOrigin(\n        wrapYurucommuWorkerBindings(env) as Env,\n      )",
    );
    expect(entrySource).not.toContain("establishRequestPublicOrigin");
    const fetchHandler = entrySource
      .slice(
        entrySource.indexOf("export default {"),
        entrySource.indexOf("  async queue("),
      )
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(fetchHandler).toContain("wrapYurucommuWorkerBindings(env)");
    expect(fetchHandler).not.toContain("APP_URL");
    // One await, and it is the app itself. Anything else here would be a second
    // origin rule running after the core's middleware had already decided.
    expect(fetchHandler.match(/await /g)).toHaveLength(1);
    expect(fetchHandler).toContain("await backendApp.fetch(");
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
    expect(entrySource).toContain("await withRequiredBackgroundPublicOrigin(");
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

// What the entry does about the public origin, run rather than read. The
// generated module and this file resolve `@takosjp/yurucommu-core/server` to
// the same module instance, so the isolate-level observation the core caches is
// shared and has to be cleared between cases.
describe("public origin per lane", () => {
  const entryFile = new URL(
    "../dist/yurucommu-entry.origin-test.ts",
    import.meta.url,
  );
  let entry: {
    default: {
      fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
      queue(batch: unknown, env: unknown, ctx: unknown): Promise<void>;
    };
  };

  beforeEach(() => {
    resetObservedPublicOrigin();
  });

  afterAll(async () => {
    resetObservedPublicOrigin();
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

  // The `edge.kv` facade carries bytes, which is what makes an observed origin
  // a real round trip through the binding rather than a string handed back.
  function edgeKv() {
    const store = new Map<string, Uint8Array>();
    const writes: string[] = [];
    return {
      writes,
      read(key: string): string | undefined {
        const value = store.get(key);
        return value === undefined
          ? undefined
          : new TextDecoder().decode(value);
      },
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async (key: string) => {
        const value = store.get(key);
        return value === undefined ? null : { value };
      },
      // `edge.kv` is a byte store, but its `put` also accepts a string — and
      // that is the shape the core hands it. A fake that echoed the string back
      // from `get` would never exercise the decode the real binding forces.
      put: async (key: string, value: string | Uint8Array) => {
        writes.push(key);
        store.set(
          key,
          typeof value === "string" ? new TextEncoder().encode(value) : value,
        );
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async () => ({ keys: [], listComplete: true }),
    };
  }

  function nativeKv() {
    const store = new Map<string, string>();
    const writes: string[] = [];
    return {
      writes,
      read: (key: string) => store.get(key),
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async () => null,
      put: async (key: string, value: string) => {
        writes.push(key);
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async () => ({ keys: [], list_complete: true, listComplete: true }),
    };
  }

  const edgeSql = () => ({
    execute: async () => ({ rows: [], rowsWritten: 0 }),
    query: async () => ({ rows: [], rowsWritten: 0 }),
    transaction: async () => [],
  });
  const nativeD1 = () => ({
    prepare: () => ({}),
    batch: async () => [],
    exec: async () => ({}),
  });

  async function health(response: Response): Promise<string[]> {
    const body = (await response.json()) as { missingBindings: string[] };
    return body.missingBindings;
  }

  // The whole reason the rule exists: a Takoform `WorkerEndpoint` allocates the
  // public origin after the `WorkerVersion` that would have carried `APP_URL` is
  // already immutable, so the only place the origin is ever spoken is on the
  // requests the Host routes here.
  test("portable without APP_URL establishes the origin from the request and pins it", async () => {
    const { default: worker } = await loadEntry();
    const kv = edgeKv();
    const response = await worker.fetch(
      new Request("https://pinned.example.test/healthz"),
      {
        DB: edgeSql(),
        KV: kv,
        YURUCOMMU_RUNTIME_LANE: "portable",
      },
      {},
    );

    expect(await health(response)).not.toContain("APP_URL");
    expect(kv.writes).toEqual([CANONICAL_ORIGIN_KV_KEY]);
    expect(kv.read(CANONICAL_ORIGIN_KV_KEY)).toBe(
      "https://pinned.example.test",
    );
  });

  // First writer wins, whatever `Host` a later request carries.
  test("portable keeps the pinned origin against a request from another host", async () => {
    const { default: worker } = await loadEntry();
    const kv = edgeKv();
    await kv.put(
      CANONICAL_ORIGIN_KV_KEY,
      new TextEncoder().encode("https://first.example.test"),
    );
    kv.writes.length = 0;

    await worker.fetch(
      new Request("https://second.example.test/healthz"),
      { DB: edgeSql(), KV: kv, YURUCOMMU_RUNTIME_LANE: "portable" },
      {},
    );

    expect(kv.writes).toEqual([]);
    expect(kv.read(CANONICAL_ORIGIN_KV_KEY)).toBe("https://first.example.test");
  });

  // The lane wrangler deploys to. `APP_URL` is authoritative and nothing is
  // observed, cached, or written — this is exactly the previous behavior.
  test("cloudflare with APP_URL is untouched", async () => {
    const { default: worker } = await loadEntry();
    const kv = nativeKv();
    const bindings = {
      DB: nativeD1(),
      KV: kv,
      APP_URL: "https://configured.example.test",
    };

    expect(
      await health(
        await worker.fetch(
          new Request("https://workers-dev.example.test/healthz"),
          bindings,
          {},
        ),
      ),
    ).not.toContain("APP_URL");

    const discovery = (await (
      await worker.fetch(
        new Request("https://workers-dev.example.test/.well-known/yurucommu"),
        bindings,
        {},
      )
    ).json()) as { server: { canonicalOrigin: string } };
    expect(discovery.server.canonicalOrigin).toBe(
      "https://configured.example.test",
    );
    expect(kv.writes).toEqual([]);
  });

  // The rule does not depend on the lane (core >= 4.1.3). A Takoform Host
  // allocates exactly one endpoint whichever lane the Worker runs on, so the
  // first https request already carries the right name; an operator who wants
  // a different hostname among several sets `APP_URL`, which always wins.
  test("cloudflare without APP_URL establishes the origin from the request and pins it", async () => {
    const { default: worker } = await loadEntry();
    const kv = nativeKv();
    const response = await worker.fetch(
      new Request("https://workers-dev.example.test/healthz"),
      { DB: nativeD1(), KV: kv },
      {},
    );

    expect(await health(response)).not.toContain("APP_URL");
    expect(kv.writes).toEqual([CANONICAL_ORIGIN_KV_KEY]);
    expect(kv.read(CANONICAL_ORIGIN_KV_KEY)).toBe(
      "https://workers-dev.example.test",
    );
  });

  // Only an https request URL may name the instance. A proxy that terminates
  // TLS and speaks plain http to the Worker establishes nothing and must set
  // `APP_URL`; the readiness report says so instead of pinning "http://".
  test("cloudflare on plain http from a routable host establishes nothing and says so", async () => {
    const { default: worker } = await loadEntry();
    const kv = nativeKv();
    const response = await worker.fetch(
      new Request("http://workers-dev.example.test/healthz"),
      { DB: nativeD1(), KV: kv },
      {},
    );

    expect(await health(response)).toContain("APP_URL");
    expect(kv.writes).toEqual([]);
  });

  function facadeBatch(queue: string) {
    return {
      batchId: "b1",
      queue,
      messages: [],
      acknowledgeAll: () => undefined,
      retryAll: () => undefined,
    };
  }

  // Delivery signs from this instance's own actor ids. Throwing retries the
  // batch after traffic has established an origin; the alternative is
  // `undefined/ap/users/...` cached by every peer it reached.
  test("queue with no origin at all fails closed", async () => {
    const { default: worker } = await loadEntry();
    await expect(
      worker.queue(
        facadeBatch("yurucommu-delivery"),
        {
          DB: edgeSql(),
          KV: edgeKv(),
          YURUCOMMU_RUNTIME_LANE: "portable",
        },
        {},
      ),
    ).rejects.toBeInstanceOf(PublicOriginError);
  });

  test("queue reads the origin a request already pinned", async () => {
    const { default: worker } = await loadEntry();
    const kv = edgeKv();
    await worker.fetch(
      new Request("https://pinned.example.test/healthz"),
      { DB: edgeSql(), KV: kv, YURUCOMMU_RUNTIME_LANE: "portable" },
      {},
    );
    resetObservedPublicOrigin();

    // An unrecognised queue name settles the batch instead of reaching the
    // database, so reaching this point at all is the assertion: the origin
    // resolved without an `APP_URL` and without a request.
    await worker.queue(
      facadeBatch("some-other-queue"),
      { DB: edgeSql(), KV: kv, YURUCOMMU_RUNTIME_LANE: "portable" },
      {},
    );
    expect(kv.read(CANONICAL_ORIGIN_KV_KEY)).toBe(
      "https://pinned.example.test",
    );
  });
});
