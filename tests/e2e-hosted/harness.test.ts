import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API,
  APP_SUFFIX,
  FORMS,
  ORDER,
  PRIVATE_NAMES,
  appOrigin,
  form,
  record,
  type Fixture,
  type Operation,
  type Resource,
  type Role,
  type Target,
} from "./contracts.ts";
import { runHarness, readConfig } from "./harness.ts";
import { PRODUCT_ROOT, loadFixture, parseTarget, sha256 } from "./inputs.ts";
import { JOURNAL_FILENAME, openJournal } from "./journal.ts";
import { runLifecycle } from "./lifecycle.ts";
import { HttpV2Port } from "./v2-port.ts";

const runId = "yurucommu-e2e-123456789abc";
const target: Target = {
  hostOrigin: "https://host-staging.unit.takos.jp",
  space: "org_test_staging",
  qualifiedHostCommit: "1".repeat(40),
  qualificationReceiptSha256: "2".repeat(64),
};
const origin = `https://local-reference${APP_SUFFIX}`;
const writer = "writer-secret-canary";
const evidence = "evidence-secret-canary";
const privateInputs = Object.fromEntries(
  PRIVATE_NAMES.map((name) => [name, `${name}-secret-canary`]),
);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "yuru-hosted-local-"));
  await chmod(path, 0o700);
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
  Response.json(value, { status, headers });

type Failure =
  | "create-ack"
  | "delete-ack"
  | "operation-drift"
  | "resource-drift"
  | "reconciling"
  | "health"
  | "html-health"
  | "collision"
  | "unsupported"
  | "artifact"
  | "absence"
  | "route"
  | "redirect"
  | "writer-echo"
  | "private-echo"
  | "nonsettling"
  | "none";
async function localHost(failure: Failure = "none", queued = false) {
  const bytes = new TextEncoder().encode(
    "// synthetic module for local HTTP protocol tests only",
  );
  const file = {
    url: "https://fixture-staging.unit.takos.jp/immutable/module.js",
    sha256: sha256(bytes),
  };
  const fixture: Fixture = {
    sourceCommit: "3".repeat(40),
    receiptSha256: "4".repeat(64),
    workerBundle: file,
    migrationSet: {
      url: "https://fixture-staging.unit.takos.jp/immutable/migrations.json",
      sha256: "5".repeat(64),
    },
    files: [file],
  };
  const resources = new Map<string, Resource>();
  const operations = new Map<string, Operation>();
  const events: {
    method: string;
    path: string;
    token: string | null;
    source: string;
    expectedGeneration: string | null;
    key: string | null;
  }[] = [];
  const specs = new Map<string, Record<string, unknown>>();
  let next = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const source = request.headers.get("x-local-source")!;
      events.push({
        method: request.method,
        path: url.pathname,
        token: request.headers.get("authorization"),
        source,
        expectedGeneration: request.headers.get("takoform-expected-generation"),
        key: request.headers.get("idempotency-key"),
      });
      if (source === "artifact")
        return new Response(failure === "artifact" ? "different" : bytes);
      if (source === "app") {
        if (
          ![...resources.values()].some(
            (value) => value.form === form("endpoint"),
          )
        )
          return new Response(null, {
            status: failure === "route" ? 503 : 404,
          });
        if (failure === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://outside.takos.jp/" },
          });
        if (failure === "html-health")
          return new Response("<html>OK</html>", {
            headers: { "content-type": "text/html" },
          });
        if (url.pathname === "/healthz" || url.pathname === "/readyz")
          return json({
            service: "yurucommu",
            status: failure === "health" ? "degraded" : "ok",
            missingBindings: failure === "health" ? ["DB"] : [],
          });
        if (url.pathname === "/.well-known/social-server")
          return json({
            product: "yurucommu",
            server: { canonicalOrigin: origin },
          });
        if (url.pathname === "/nodeinfo/2.0")
          return json({
            software: { name: "yurucommu" },
            usage: { users: { total: 0 }, localPosts: 0 },
          });
        return new Response(null, { status: 404 });
      }
      if (url.pathname === "/.well-known/takoform/v2")
        return json({
          api: API,
          baseUrl: `${target.hostOrigin}/v2`,
          capabilities: { privateInputs: true },
        });
      if (request.method === "GET" && url.pathname === "/v2/support")
        return json({
          form: url.searchParams.get("form"),
          supported: failure !== "unsupported",
          operations: ["create", "read", "update", "delete"],
          privateInputs: true,
        });
      if (request.method === "GET" && url.pathname === "/v2/resources")
        return json({
          items: failure === "collision" ? [{ uid: "foreign-resource" }] : [],
          nextCursor: null,
        });
      if (request.method === "POST" && url.pathname === "/v2/resources") {
        expect(request.headers.get("authorization")).toBe(`Bearer ${writer}`);
        const body = record(await request.json());
        const role = ORDER.find(
          (candidate) =>
            form(candidate) === body.form &&
            (candidate === "app" ? runId : `${runId}-${candidate}`) ===
              body.name,
        )!;
        expect(role).toBeDefined();
        expect(body.space).toBe(target.space);
        expect(body).not.toHaveProperty("schemaDigest");
        expect(body).not.toHaveProperty("offering");
        if (role === "version")
          expect(body.privateInputs).toEqual(privateInputs);
        else expect(body).not.toHaveProperty("privateInputs");
        const uid = `resource-${++next}`;
        const id = `create-${next}`;
        const spec = record(body.spec);
        specs.set(role, spec);
        resources.set(uid, {
          uid,
          form: form(role),
          space: target.space,
          name: body.name as string,
          generation: 1,
          observedGeneration: 1,
          phase: "idle",
          spec,
          observed: {},
          output: role === "endpoint" ? { url: `${origin}/` } : {},
          lastOperation: id,
        });
        const op: Operation = {
          id,
          resourceUid: uid,
          action: "create",
          generation: 1,
          status: "succeeded",
          effect: "complete",
        };
        operations.set(id, op);
        if (failure === "writer-echo" || failure === "private-echo") {
          const echoed =
            failure === "writer-echo" ? writer : privateInputs.ENCRYPTION_KEY!;
          return json({ ...op, id: echoed }, 200, {
            location: `${target.hostOrigin}/v2/operations/${echoed}`,
          });
        }
        if (failure === "create-ack")
          return new Response(`ACK lost ${writer}`, { status: 503 });
        if (failure === "reconciling")
          return json(
            { ...op, status: "reconciling", effect: "unknown" },
            202,
            { location: `${target.hostOrigin}/v2/operations/${id}` },
          );
        return json(
          queued ? { ...op, status: "queued", effect: "none" } : op,
          queued ? 202 : 200,
          { location: `${target.hostOrigin}/v2/operations/${id}` },
        );
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/v2/operations/")
      ) {
        const op = operations.get(url.pathname.split("/").at(-1)!)!;
        if (failure === "nonsettling")
          return json({ ...op, status: "running", effect: "unknown" });
        return json(
          failure === "operation-drift"
            ? { ...op, resourceUid: "foreign-resource" }
            : op,
        );
      }
      const uid = url.pathname.split("/").at(-1)!;
      if (
        request.method === "DELETE" &&
        url.pathname.startsWith("/v2/resources/")
      ) {
        const previous = resources.get(uid)!;
        expect(previous).toBeDefined();
        expect(request.headers.get("authorization")).toBe(`Bearer ${writer}`);
        expect(request.headers.get("takoform-expected-generation")).toBe(
          String(previous.generation),
        );
        expect(await request.text()).toBe("");
        resources.delete(uid);
        const id = `delete-${uid}`;
        const op: Operation = {
          id,
          resourceUid: uid,
          action: "delete",
          generation: previous.generation + 1,
          status: "succeeded",
          effect: "complete",
        };
        operations.set(id, op);
        if (failure === "delete-ack")
          return new Response("lost delete ACK", { status: 503 });
        return json(op, 200, {
          location: `${target.hostOrigin}/v2/operations/${id}`,
        });
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/v2/resources/")
      ) {
        const value = resources.get(uid);
        if (!value)
          return new Response(null, {
            status: failure === "absence" ? 403 : 410,
          });
        return json(
          failure === "resource-drift"
            ? { ...value, space: "foreign-space" }
            : value,
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  cleanup.push(async () => {
    await server.stop(true);
  });
  const port = new HttpV2Port(target, writer, evidence, async (input, init) => {
    // ONLY tests rewrite declared HTTPS targets onto this ephemeral loopback server.
    const declared = new URL(input);
    const local = new URL(`${declared.pathname}${declared.search}`, server.url);
    const headers = new Headers(init.headers);
    headers.set(
      "x-local-source",
      declared.origin === target.hostOrigin
        ? "host"
        : declared.origin === origin
          ? "app"
          : "artifact",
    );
    return fetch(local, { ...init, headers });
  });
  return { port, fixture, resources, specs, events };
}
async function execute(failure: Failure = "none", queued = false) {
  const host = await localHost(failure, queued);
  const dir = await directory();
  const journal = await openJournal(dir, runId);
  let result;
  try {
    result = await runLifecycle({
      target,
      fixture: host.fixture,
      runId,
      privateInputs,
      port: host.port,
      journal,
      operationTimeoutMs: 100,
      pause: async () => {},
    });
  } finally {
    await journal.close();
  }
  const log = await readFile(join(dir, JOURNAL_FILENAME), "utf8");
  return { ...host, result, log, dir };
}
describe("current v2 hosted lifecycle through actual loopback HTTP effects", () => {
  test("deploys all real product roles, reads strict health, removes reverse graph and proves absence", async () => {
    const { result, resources, specs, events, log } = await execute(
      "none",
      true,
    );
    expect(result).toMatchObject({
      status: "passed",
      resourceCount: 15,
      authoritativeAbsence: true,
      routeAbsent: true,
    });
    expect(resources.size).toBe(0);
    expect(specs.get("version")).toMatchObject({
      handlers: ["fetch", "queue", "scheduled"],
      vars: {
        YURUCOMMU_RUNTIME_LANE: "portable",
        DELIVERY_QUEUE_NAME: `${runId}-delivery`,
        DELIVERY_DLQ_NAME: `${runId}-delivery-dlq`,
      },
      requiredSensitiveVars: [...PRIVATE_NAMES].sort(),
      sqliteBindings: [{ name: "DB", resource: { resourceUid: "resource-1" } }],
    });
    expect(specs.get("delivery-consumer")).toMatchObject({
      maxConcurrency: 4,
      deadLetterQueue: { resourceUid: "resource-7" },
    });
    expect(specs.get("retention")).toMatchObject({ cron: "0 * * * *" });
    const deletes = events.filter((event) => event.method === "DELETE");
    expect(deletes.map((event) => event.path.split("/").at(-1))).toEqual(
      Array.from({ length: 15 }, (_, index) => `resource-${15 - index}`),
    );
    expect(
      new Set(
        events
          .filter((event) => event.method !== "GET")
          .map((event) => event.key),
      ).size,
    ).toBe(30);
    for (const event of events.filter((event) => event.source !== "host"))
      expect(event.token).toBeNull();
    for (const event of events.filter(
      (event) =>
        event.source === "host" &&
        event.method === "GET" &&
        event.path !== "/.well-known/takoform/v2",
    ))
      expect(event.token).toBe(`Bearer ${evidence}`);
    expect(log).not.toContain("secret-canary");
    const entries = log
      .trim()
      .split("\n")
      .map((line) => record(JSON.parse(line)));
    expect(entries.filter((entry) => entry.kind === "intent")).toHaveLength(30);
    expect(entries.filter((entry) => entry.kind === "ack")).toHaveLength(30);
    expect(entries.filter((entry) => entry.kind === "absent")).toHaveLength(15);
    expect(entries.at(-1)).toEqual({ kind: "complete", passed: true });
  });
  test("committed create plus lost ACK halts without replay or automatic destroy", async () => {
    const { result, resources, events, log } = await execute("create-ack");
    expect(result).toMatchObject({
      status: "halted",
      code: "UNKNOWN_ACK_OR_EFFECT",
      authoritativeAbsence: false,
    });
    expect(resources.size).toBe(1);
    expect(events.filter((event) => event.method === "POST")).toHaveLength(1);
    expect(events.some((event) => event.method === "DELETE")).toBe(false);
    expect(log).toContain('"kind":"intent"');
    expect(log).not.toContain('"kind":"ack"');
    expect(log).not.toContain(writer);
  });
  test("uncertain delete stops immediately and preserves remaining owned graph", async () => {
    const { result, resources, events, log } = await execute("delete-ack");
    expect(result.status).toBe("halted");
    expect(resources.size).toBe(14);
    expect(events.filter((event) => event.method === "DELETE")).toHaveLength(1);
    expect(log).not.toContain('"kind":"complete"');
  });
  for (const failure of ["writer-echo", "private-echo"] as const)
    test(`${failure} cannot put credentials into journal metadata`, async () => {
      const { result, resources, log, events } = await execute(failure);
      expect(result.status).toBe("halted");
      expect(resources.size).toBe(1);
      expect(log).not.toContain("secret-canary");
      expect(events.some((event) => event.method === "DELETE")).toBe(false);
    });
  test("accepted running/unknown Operation is polled only, then times out without replay", async () => {
    const { result, resources, events } = await execute("nonsettling", true);
    expect(result.status).toBe("halted");
    expect(resources.size).toBe(1);
    expect(events.filter((event) => event.method === "POST")).toHaveLength(1);
    expect(events.some((event) => event.method === "DELETE")).toBe(false);
    expect(
      events.filter((event) => event.path.startsWith("/v2/operations/")).length,
    ).toBeGreaterThan(1);
  });
  test("journal device failure after create effect cannot trigger automatic destroy", async () => {
    const host = await localHost();
    const journal = await openJournal(await directory(), runId);
    let result;
    try {
      result = await runLifecycle({
        target,
        fixture: host.fixture,
        runId,
        privateInputs,
        port: host.port,
        journal: {
          append: async (entry) => {
            if (entry.kind === "ack" || entry.kind === "halted")
              throw new Error("local device unavailable");
            await journal.append(entry);
          },
          close: () => journal.close(),
        },
      });
    } finally {
      await journal.close();
    }
    expect(result).toMatchObject({
      status: "halted",
      code: "UNKNOWN_ACK_OR_EFFECT",
    });
    expect(host.resources.size).toBe(1);
    expect(host.events.some((event) => event.method === "DELETE")).toBe(false);
  });
  for (const failure of [
    "operation-drift",
    "resource-drift",
    "reconciling",
  ] as const)
    test(`${failure} does not authorize teardown`, async () => {
      const { result, events, resources } = await execute(
        failure,
        failure === "operation-drift",
      );
      expect(result.status).toBe("halted");
      expect(resources.size).toBe(1);
      expect(events.some((event) => event.method === "DELETE")).toBe(false);
    });
  for (const failure of ["health", "html-health", "redirect"] as const)
    test(`${failure} fails even after acknowledged safe teardown`, async () => {
      const { result, resources } = await execute(failure);
      expect(result).toMatchObject({
        status: "failed",
        code: "HEALTH_FAILED",
        authoritativeAbsence: true,
        routeAbsent: true,
      });
      expect(resources.size).toBe(0);
    });
  for (const failure of ["absence", "route"] as const)
    test(`${failure} refuses a successful result`, async () => {
      const { result } = await execute(failure);
      expect(result).toMatchObject({
        status: "halted",
        authoritativeAbsence: false,
        routeAbsent: false,
      });
    });
  for (const failure of ["collision", "unsupported", "artifact"] as const)
    test(`${failure} refuses before first mutation`, async () => {
      const host = await localHost(failure);
      const journal = await openJournal(await directory(), runId);
      try {
        await expect(
          runLifecycle({
            target,
            fixture: host.fixture,
            runId,
            privateInputs,
            port: host.port,
            journal,
          }),
        ).rejects.toThrow();
      } finally {
        await journal.close();
      }
      expect(host.events.every((event) => event.method === "GET")).toBe(true);
      expect(host.resources.size).toBe(0);
    });
});
describe("private local journal and runtime guards", () => {
  test("execute configuration takes only explicit credentials and refuses proxy/debug/alternate argument paths", () => {
    const env = {
      YURUCOMMU_HOSTED_E2E_ENVIRONMENT: "staging",
      YURUCOMMU_HOSTED_E2E_TARGET_FILE: "/operator/target.json",
      YURUCOMMU_HOSTED_E2E_FIXTURE_FILE: "/operator/fixture.json",
      YURUCOMMU_HOSTED_E2E_JOURNAL_DIRECTORY: "/operator/journal",
      TAKOFORM_TOKEN: writer,
      TAKOFORM_EVIDENCE_TOKEN: evidence,
      ENCRYPTION_KEY: "a".repeat(64),
      YURUCOMMU_SESSION_HASH_SALT: "b".repeat(64),
      TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts-staging.unit.takos.jp/",
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "local-client",
      TAKOSUMI_ACCOUNTS_OWNER_SUB: "local-owner",
      TAKOSUMI_ACCOUNTS_REDIRECT_URI: `${origin}/api/auth/callback/takos`,
      CLOUDFLARE_API_TOKEN: "ignored-provider-secret-canary",
    };
    const config = readConfig(["--execute"], env);
    expect(config.mode).toBe("execute");
    expect(config).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(() =>
      readConfig(["--execute"], {
        ...env,
        HTTPS_PROXY: "http://proxy.invalid",
      }),
    ).toThrow("PROXY_REFUSED");
    expect(() =>
      readConfig(["--execute"], { ...env, BUN_CONFIG_VERBOSE_FETCH: "true" }),
    ).toThrow("DIAGNOSTICS_REFUSED");
    expect(() =>
      readConfig(["--execute"], { ...env, TAKOFORM_EVIDENCE_TOKEN: writer }),
    ).toThrow("CREDENTIALS_NOT_DISTINCT");
    expect(() =>
      readConfig(["--execute", "--endpoint=https://api.takoserver.com"], env),
    ).toThrow("ARGUMENT_REFUSED");
  });
  test("exclusive journal refuses an existing run before any remote work", async () => {
    const dir = await directory();
    const first = await openJournal(dir, runId);
    await first.close();
    const host = await localHost();
    await expect(
      openJournal(dir, "yurucommu-e2e-abcdefabcdef"),
    ).rejects.toThrow();
    expect(host.events).toHaveLength(0);
    const stat = await Bun.file(join(dir, JOURNAL_FILENAME)).stat();
    expect(stat.mode & 0o777).toBe(0o600);
  });
  test("refuses non-private journal directories", async () => {
    const dir = await directory();
    await chmod(dir, 0o755);
    await expect(openJournal(dir, runId)).rejects.toThrow("JOURNAL_REFUSED");
  });
  test("default is side-effect-free and leaves globals untouched", async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env;
    const originalLog = console.log;
    expect(await runHarness(readConfig([], {}))).toMatchObject({
      status: "dry-run",
    });
    expect(globalThis.fetch).toBe(originalFetch);
    expect(process.env).toBe(originalEnv);
    expect(console.log).toBe(originalLog);
  });
  test("CLI never prints credential canaries on default or configuration failure", async () => {
    for (const argv of [[], ["--execute"]]) {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "tests/e2e-hosted/run.ts", ...argv],
        {
          cwd: PRODUCT_ROOT,
          env: {
            TAKOFORM_TOKEN: writer,
            TAKOFORM_EVIDENCE_TOKEN: evidence,
            CLOUDFLARE_API_TOKEN: "provider-secret-canary",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(`${stdout}${stderr}`).not.toContain("secret-canary");
      expect(code).toBe(argv.length === 0 ? 0 : 1);
    }
  });
  test("staging target must be explicit and current; app URL uses exact new suffix", () => {
    const value = {
      kind: "yurucommu.hosted-staging-target@v2",
      environment: "staging",
      api: API,
      appSuffix: APP_SUFFIX,
      ...target,
    };
    expect(parseTarget(value)).toEqual(target);
    expect(() =>
      parseTarget({ ...value, environment: "production" }),
    ).toThrow();
    expect(() =>
      parseTarget({ ...value, hostOrigin: "https://api.takoserver.com" }),
    ).toThrow();
    expect(() =>
      parseTarget({ ...value, api: "forms.takoform.com/v1" }),
    ).toThrow();
    expect(() => appOrigin("https://tenant.app.staging.takos.jp/")).toThrow();
    expect(() => appOrigin("https://tenant.app.takos.jp/")).toThrow();
    expect(() => appOrigin("https://a--b.app-staging.takos.jp/")).toThrow();
    expect(() => appOrigin(`${origin}/healthz`)).toThrow();
    expect(appOrigin(`${origin}/`)).toBe(origin);
  });
  test("mapped Forms match every product role without consulting legacy profile", async () => {
    const product = record(
      JSON.parse(
        await readFile(`${PRODUCT_ROOT}deploy/product-resources.json`, "utf8"),
      ),
    );
    for (const value of product.resources as unknown[]) {
      const resource = record(value);
      expect(FORMS[resource.name as Role].split("/")[0]).toBe(
        resource.shape as string,
      );
    }
    expect(ORDER).toHaveLength(15);
    expect(new Set(ORDER.map(form)).size).toBe(13);
    expect(form("version")).toContain("/0.5.0/");
  });
});
async function receiptFixture() {
  const dir = await directory();
  const schemaBytes = await readFile(
    `${PRODUCT_ROOT}deploy/takoform/migrations/schema-bundle.json`,
  );
  const schema = record(JSON.parse(schemaBytes.toString()));
  const entries = (schema.entries as unknown[])
    .map(record)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const worker = {
    entrypoint: "yurucommu-worker.js",
    files: [
      {
        path: "yurucommu-worker.js",
        url: "https://fixture-staging.unit.takos.jp/immutable/yurucommu-worker.js",
        sha256: "a".repeat(64),
        mediaType: "application/javascript+module",
      },
    ],
  };
  const migrations = {
    files: entries.map((entry) => ({
      path: entry.name,
      url: `https://fixture-staging.unit.takos.jp/immutable/${entry.name}`,
      sha256: String(entry.sha256).replace("sha256:", ""),
      mediaType: "application/sql",
    })),
  };
  const workerBytes = JSON.stringify(worker);
  const migrationBytes = JSON.stringify(migrations);
  const workerFile = join(dir, "worker-manifest.json");
  const migrationFile = join(dir, "migration-manifest.json");
  await writeFile(workerFile, workerBytes);
  await writeFile(migrationFile, migrationBytes);
  const receipt = {
    kind: "yurucommu.hosted-artifacts@v2",
    sourceCommit: "b".repeat(40),
    productResourcesSha256: sha256(
      await readFile(`${PRODUCT_ROOT}deploy/product-resources.json`),
    ),
    schemaBundleSha256: sha256(schemaBytes),
    workerBundle: {
      artifact: {
        url: "https://fixture-staging.unit.takos.jp/immutable/worker-manifest.json",
        sha256: sha256(workerBytes),
      },
      manifestFile: workerFile,
    },
    migrationSet: {
      artifact: {
        url: "https://fixture-staging.unit.takos.jp/immutable/migration-manifest.json",
        sha256: sha256(migrationBytes),
      },
      manifestFile: migrationFile,
    },
  };
  const path = join(dir, "receipt.json");
  await writeFile(path, JSON.stringify(receipt));
  return { path, receipt, worker, migrations, workerFile, migrationFile };
}
describe("actual product manifest mapping prerequisites", () => {
  test("requires every ordered real source migration and anonymous immutable manifest identity", async () => {
    const { path, receipt, migrations } = await receiptFixture();
    const fixture = await loadFixture(path);
    expect(fixture.migrationSet).toEqual(receipt.migrationSet.artifact);
    expect(fixture.files).toHaveLength(migrations.files.length + 3);
    expect(fixture.receiptSha256).toBe(sha256(await readFile(path)));
  });
  test("source contract drift refuses the fixture", async () => {
    const { path, receipt } = await receiptFixture();
    await writeFile(
      path,
      JSON.stringify({ ...receipt, schemaBundleSha256: "0".repeat(64) }),
    );
    await expect(loadFixture(path)).rejects.toThrow("SOURCE_CONTRACT_MISMATCH");
  });
  test("generic hello manifest is not a Yurucommu bundle", async () => {
    const { path, receipt, worker, workerFile } = await receiptFixture();
    const bytes = JSON.stringify({ ...worker, entrypoint: "hello.mjs" });
    await writeFile(workerFile, bytes);
    receipt.workerBundle.artifact.sha256 = sha256(bytes);
    await writeFile(path, JSON.stringify(receipt));
    await expect(loadFixture(path)).rejects.toThrow(
      "YURUCOMMU_BUNDLE_REQUIRED",
    );
  });
  test("truncated or reordered migration receipt refuses before mutation", async () => {
    const { path, receipt, migrations, migrationFile } = await receiptFixture();
    const bytes = JSON.stringify({ files: migrations.files.slice(1) });
    await writeFile(migrationFile, bytes);
    receipt.migrationSet.artifact.sha256 = sha256(bytes);
    await writeFile(path, JSON.stringify(receipt));
    await expect(loadFixture(path)).rejects.toThrow(
      "MIGRATION_CONTRACT_MISMATCH",
    );
  });
  test("signed or credential-bearing artifact URLs are refused", async () => {
    const { path, receipt } = await receiptFixture();
    receipt.workerBundle.artifact.url += "?token=secret-canary";
    await writeFile(path, JSON.stringify(receipt));
    await expect(loadFixture(path)).rejects.toThrow("INVALID_URL");
  });
});
