import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API,
  APP_SUFFIX,
  FORMS,
  ORDER,
  ORIGIN_RESERVATION_FORMAT,
  PRIVATE_NAMES,
  appOrigin,
  form,
  originReservation,
  record,
  resourceName,
  type Artifact,
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
import { HttpV2Port, type HostedArtifactBytePort } from "./v2-port.ts";

const runId = "staging-yuru-123456789abc";
const target: Target = {
  hostOrigin: "https://host-staging.unit.takos.jp",
  space: "org_test_staging",
  qualifiedHostCommit: "1".repeat(40),
  qualificationReceiptSha256: "2".repeat(64),
};
const origin = `https://staging-local-reference${APP_SUFFIX}`;
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
  | "unprefixed-route"
  | "nonsettling"
  | "none";
type ReservationFailure =
  | "lost-ack"
  | "unsupported"
  | "missing-offering"
  | "ambiguous-offering"
  | "wrong-status-code"
  | "extra-field"
  | "missing-field"
  | "wrong-format"
  | "wrong-id"
  | "wrong-name"
  | "wrong-origin"
  | "wrong-status"
  | "invalid-revision"
  | "invalid-expiry"
  | "credential-echo"
  | "endpoint-mismatch";
async function localHost(
  failure: Failure = "none",
  queued = false,
  shared?: {
    failure?: ReservationFailure;
    beforePut?: () => Promise<void>;
  },
) {
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
  const reservations = new Map<string, ReturnType<typeof originReservation>>();
  const appUrl = shared
    ? originReservation(runId).canonicalPublicOrigin
    : origin;
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
            server: { canonicalOrigin: appUrl },
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
      if (
        shared &&
        request.method === "PUT" &&
        url.pathname.startsWith("/v1/worker-endpoint-origin-reservations/")
      ) {
        await shared.beforePut?.();
        expect(request.headers.get("authorization")).toBe(`Bearer ${writer}`);
        const reservation = originReservation(runId);
        expect(url.pathname).toBe(
          `/v1/worker-endpoint-origin-reservations/${reservation.reservationId}`,
        );
        const body = await request.json();
        expect(body).toEqual({
          format: ORIGIN_RESERVATION_FORMAT,
          requestedSubdomain: reservation.requestedSubdomain,
          expiresInSeconds: 600,
        });
        if (shared.failure === "unsupported") return json({}, 404);
        if (shared.failure === "missing-offering") return json({}, 422);
        if (shared.failure === "ambiguous-offering") return json({}, 409);
        // Protocol fixture only: this map is not the owning Core's custody proof.
        reservations.set(reservation.reservationId, reservation);
        if (shared.failure === "lost-ack") return json({}, 503);
        const response: Record<string, unknown> = {
          format: ORIGIN_RESERVATION_FORMAT,
          ...reservation,
          revision: "local-opaque-revision",
          expiresAt: "2030-01-01T00:10:00.000Z",
          status: "prepared",
        };
        switch (shared.failure) {
          case "extra-field":
            response.binding = {};
            break;
          case "missing-field":
            delete response.revision;
            break;
          case "wrong-format":
            response.format =
              "takoserver.worker-endpoint-origin-reservation.v1";
            break;
          case "wrong-id":
            response.reservationId = `${runId}-other`;
            break;
          case "wrong-name":
            response.requestedSubdomain = `${runId}-other`;
            break;
          case "wrong-origin":
            response.canonicalPublicOrigin = origin;
            break;
          case "wrong-status":
            response.status = "activated";
            break;
          case "invalid-revision":
            response.revision = 1;
            break;
          case "invalid-expiry":
            response.expiresAt = "";
            break;
          case "credential-echo":
            response.revision = writer;
            break;
        }
        return json(
          response,
          shared.failure === "wrong-status-code" ? 200 : 201,
        );
      }
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
            resourceName(runId, candidate) === body.name,
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
          output:
            role === "endpoint"
              ? {
                  url:
                    failure === "unprefixed-route"
                      ? `https://local-reference${APP_SUFFIX}/`
                      : `${shared?.failure === "endpoint-mismatch" ? origin : appUrl}/`,
                }
              : {},
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
  const loopbackFetch = fetch;
  const transport = async (input: string, init: RequestInit) => {
    // ONLY tests rewrite declared HTTPS targets onto this ephemeral loopback server.
    const declared = new URL(input);
    const local = new URL(`${declared.pathname}${declared.search}`, server.url);
    const headers = new Headers(init.headers);
    headers.set(
      "x-local-source",
      declared.origin === target.hostOrigin
        ? "host"
        : declared.origin === appUrl || declared.origin === origin
          ? "app"
          : "artifact",
    );
    return loopbackFetch(local, { ...init, headers });
  };
  const port = new HttpV2Port(target, writer, evidence, transport);
  return { port, fixture, resources, specs, events, transport, reservations };
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
async function executeShared(
  failure?: ReservationFailure,
  journalFailure?: "origin-reservation-intent" | "origin-reservation-ack",
) {
  const host = await localHost("none", false, { failure });
  const dir = await directory();
  const journal = await openJournal(dir, runId);
  let result;
  try {
    result = await runLifecycle({
      target,
      fixture: host.fixture,
      runId,
      privateInputs,
      sharedOrigin: { kind: "form-v2@1" },
      port: host.port,
      journal: {
        async append(entry) {
          if (entry.kind === journalFailure)
            throw new Error("local journal device unavailable");
          await journal.append(entry);
        },
        close: () => journal.close(),
      },
    });
  } finally {
    await journal.close();
  }
  const log = await readFile(join(dir, JOURNAL_FILENAME), "utf8");
  return { ...host, result, log, dir };
}
describe("selected shared-origin reservation through existing owning HTTP shape", () => {
  test("only Endpoint is shortened to 28 characters with the original 12-hex entropy", () => {
    expect(resourceName(runId, "endpoint")).toBe(`${runId}-ep`);
    expect(resourceName(runId, "endpoint")).toHaveLength(28);
    expect(resourceName(runId, "endpoint")).toMatch(
      /^staging-yuru-[0-9a-f]{12}-ep$/,
    );
    for (const role of ORDER.filter((item) => item !== "endpoint"))
      expect(resourceName(runId, role)).toBe(
        role === "app" ? runId : `${runId}-${role}`,
      );
    const reservation = originReservation(runId);
    expect(reservation.reservationId).toBe(`${runId}-origin`);
    expect(reservation.reservationId).toHaveLength(32);
    expect(appOrigin(`${reservation.canonicalPublicOrigin}/`)).toBe(
      `https://${runId}-ep${APP_SUFFIX}`,
    );
    expect(`${runId}-endpoint`).toHaveLength(34);
    expect(() => appOrigin(`https://${runId}-endpoint${APP_SUFFIX}/`)).toThrow(
      "APP_ORIGIN_REFUSED",
    );
  });
  test("generic Host retains its independently assigned endpoint URL without reserving a name", async () => {
    const { result, events } = await execute();
    expect(result.status).toBe("passed");
    expect(origin).not.toBe(originReservation(runId).canonicalPublicOrigin);
    expect(events.some((event) => event.source === "app")).toBe(true);
    expect(events.some((event) => event.method === "PUT")).toBe(false);
  });
  test("syncs original reservation intent before PUT and its ACK before any Resource create", async () => {
    const dir = await directory();
    const path = join(dir, JOURNAL_FILENAME);
    const host = await localHost("none", false, {
      async beforePut() {
        const entries = (await readFile(path, "utf8"))
          .trim()
          .split("\n")
          .map((line) => record(JSON.parse(line)));
        expect(entries.at(-1)).toEqual({
          kind: "origin-reservation-intent",
          ...originReservation(runId),
        });
        expect(host.resources.size).toBe(0);
      },
    });
    const journal = await openJournal(dir, runId);
    let firstCreate = true;
    const port = new HttpV2Port(target, writer, evidence, async (url, init) => {
      if (init.method === "POST" && firstCreate) {
        firstCreate = false;
        expect(await readFile(path, "utf8")).toContain(
          '"kind":"origin-reservation-ack"',
        );
      }
      return host.transport(url, init);
    });
    try {
      const result = await runLifecycle({
        target,
        fixture: host.fixture,
        runId,
        privateInputs,
        port,
        journal,
        sharedOrigin: { kind: "form-v2@1" },
      });
      expect(result).toMatchObject({
        status: "passed",
        resourceCount: 15,
        authoritativeAbsence: true,
        routeAbsent: true,
      });
    } finally {
      await journal.close();
    }
    const putIndex = host.events.findIndex((event) => event.method === "PUT");
    expect(putIndex).toBeGreaterThan(0);
    expect(
      host.events.slice(0, putIndex).every((event) => event.method === "GET"),
    ).toBe(true);
    expect(host.events.filter((event) => event.method === "PUT")).toHaveLength(
      1,
    );
    expect(host.events.filter((event) => event.method === "POST")).toHaveLength(
      15,
    );
    expect(host.resources.size).toBe(0);
    expect(host.reservations.size).toBe(1);
    expect(
      host.events.some(
        (event) => event.method === "DELETE" && event.path.startsWith("/v1/"),
      ),
    ).toBe(false);
    const log = await readFile(path, "utf8");
    expect(log).not.toContain("secret-canary");
    expect(log).not.toContain("local-opaque-revision");
    expect(log).not.toContain("2030-01-01");
    expect(log.indexOf('"kind":"origin-reservation-intent"')).toBeLessThan(
      log.indexOf('"kind":"origin-reservation-ack"'),
    );
    expect(log.indexOf('"kind":"origin-reservation-ack"')).toBeLessThan(
      log.indexOf('"kind":"intent"'),
    );
  });
  test("committed reservation with lost ACK retains one original name and sends zero Resource mutations", async () => {
    const { result, events, reservations, resources, log } =
      await executeShared("lost-ack");
    expect(result).toMatchObject({
      status: "halted",
      resourceCount: 0,
      authoritativeAbsence: false,
    });
    expect([...reservations.keys()]).toEqual([`${runId}-origin`]);
    expect(resources.size).toBe(0);
    expect(events.filter((event) => event.method === "PUT")).toHaveLength(1);
    expect(
      events.some((event) => ["POST", "DELETE"].includes(event.method)),
    ).toBe(false);
    expect(log).toContain('"kind":"origin-reservation-intent"');
    expect(log).not.toContain('"kind":"origin-reservation-ack"');
  });
  for (const kind of [
    "origin-reservation-intent",
    "origin-reservation-ack",
  ] as const)
    test(`${kind} journal failure halts without creating Resources, retrying or releasing`, async () => {
      const { result, events, reservations, resources, log } =
        await executeShared(undefined, kind);
      expect(result).toMatchObject({ status: "halted", resourceCount: 0 });
      expect(events.filter((event) => event.method === "PUT")).toHaveLength(
        kind === "origin-reservation-intent" ? 0 : 1,
      );
      expect(reservations.size).toBe(
        kind === "origin-reservation-intent" ? 0 : 1,
      );
      expect(resources.size).toBe(0);
      expect(
        events.some((event) => ["POST", "DELETE"].includes(event.method)),
      ).toBe(false);
      expect(log).not.toContain('"kind":"origin-reservation-ack"');
    });
  for (const failure of [
    "unsupported",
    "missing-offering",
    "ambiguous-offering",
  ] as const)
    test(`${failure} is decided by the existing reservation route and cannot trigger a guessed Offering or fallback`, async () => {
      const { result, events, reservations, resources } =
        await executeShared(failure);
      expect(result).toMatchObject({ status: "halted", resourceCount: 0 });
      expect(reservations.size).toBe(0);
      expect(resources.size).toBe(0);
      expect(events.filter((event) => event.method === "PUT")).toHaveLength(1);
      expect(
        events.some((event) => ["POST", "DELETE"].includes(event.method)),
      ).toBe(false);
    });
  for (const failure of [
    "wrong-status-code",
    "extra-field",
    "missing-field",
    "wrong-format",
    "wrong-id",
    "wrong-name",
    "wrong-origin",
    "wrong-status",
    "invalid-revision",
    "invalid-expiry",
    "credential-echo",
  ] as const)
    test(`${failure} cannot acknowledge the original reservation or authorize Resource creation`, async () => {
      const { result, events, reservations, resources, log } =
        await executeShared(failure);
      expect(result).toMatchObject({ status: "halted", resourceCount: 0 });
      expect(reservations.size).toBe(1);
      expect(resources.size).toBe(0);
      expect(events.filter((event) => event.method === "PUT")).toHaveLength(1);
      expect(
        events.some((event) => ["POST", "DELETE"].includes(event.method)),
      ).toBe(false);
      expect(log).not.toContain('"kind":"origin-reservation-ack"');
      expect(log).not.toContain("secret-canary");
    });
  test("an accepted Endpoint with a different valid staging origin halts before later Resources, application HTTP or teardown", async () => {
    const { result, resources, reservations, events } =
      await executeShared("endpoint-mismatch");
    expect(result).toMatchObject({ status: "halted", resourceCount: 12 });
    expect(resources.size).toBe(12);
    expect(events.filter((event) => event.method === "POST")).toHaveLength(12);
    expect(reservations.size).toBe(1);
    expect(events.some((event) => event.source === "app")).toBe(false);
    expect(events.some((event) => event.method === "DELETE")).toBe(false);
  });
  for (const failure of ["collision", "unsupported", "artifact"] as const)
    test(`${failure} preflight still refuses before the selected reservation PUT`, async () => {
      const host = await localHost(failure, false, {});
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
            sharedOrigin: { kind: "form-v2@1" },
          }),
        ).rejects.toThrow();
      } finally {
        await journal.close();
      }
      expect(host.events.every((event) => event.method === "GET")).toBe(true);
      expect(host.reservations.size).toBe(0);
      expect(host.resources.size).toBe(0);
    });
  for (const priorRunId of [
    "yurucommu-e2e-123456789abc",
    "staging-yuru-abcdefabcdef",
  ])
    test(`existing ${priorRunId} journal blocks selected reservation before HTTP without changing file identity`, async () => {
      const input = await receiptFixture();
      const dir = await directory();
      const targetFile = join(await directory(), "target.json");
      await writeFile(
        targetFile,
        JSON.stringify({
          kind: "yurucommu.hosted-staging-target@v2",
          environment: "staging",
          api: API,
          appSuffix: APP_SUFFIX,
          ...target,
        }),
      );
      const path = join(dir, JOURNAL_FILENAME);
      const bytes = `${JSON.stringify({ kind: "prepared", runId: priorRunId })}\n`;
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      const before = await lstat(path, { bigint: true });
      const network = spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("unexpected external request"),
      );
      try {
        await expect(
          runHarness(
            {
              mode: "execute",
              runId,
              targetFile,
              fixtureFile: input.path,
              journalDirectory: dir,
              writer,
              evidence,
              privateInputs,
            },
            { sharedOrigin: { kind: "form-v2@1" } },
          ),
        ).rejects.toThrow();
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
      }
      const after = await lstat(path, { bigint: true });
      for (const field of [
        "dev",
        "ino",
        "mode",
        "size",
        "mtimeNs",
        "ctimeNs",
      ] as const)
        expect(after[field]).toBe(before[field]);
      expect(await readFile(path, "utf8")).toBe(bytes);
    });
  test("runHarness forwards the code-only selection alongside verified held bytes into the actual HTTP phase engine", async () => {
    const input = await receiptFixture();
    const host = await localHost("none", false, {});
    const dir = await directory();
    const targetFile = join(await directory(), "target.json");
    await writeFile(
      targetFile,
      JSON.stringify({
        kind: "yurucommu.hosted-staging-target@v2",
        environment: "staging",
        api: API,
        appSuffix: APP_SUFFIX,
        ...target,
      }),
    );
    const forwardFetch: typeof fetch = Object.assign(
      (url: string | URL | Pick<Request, "url">, init?: RequestInit) =>
        host.transport(
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
          init ?? {},
        ),
      { preconnect: globalThis.fetch.preconnect },
    );
    const network = spyOn(globalThis, "fetch").mockImplementation(forwardFetch);
    try {
      const result = await runHarness(
        {
          mode: "execute",
          runId,
          targetFile,
          fixtureFile: input.path,
          journalDirectory: dir,
          writer,
          evidence,
          privateInputs,
        },
        {
          sharedOrigin: { kind: "form-v2@1" },
          artifactBytes: {
            async readArtifacts(required) {
              expect(required).toHaveLength(38);
              return input.artifactBytes;
            },
          },
        },
      );
      expect(result).toMatchObject({ status: "passed", resourceCount: 15 });
    } finally {
      network.mockRestore();
    }
    expect(host.events.some((event) => event.source === "artifact")).toBe(
      false,
    );
    expect(host.events.filter((event) => event.method === "PUT")).toHaveLength(
      1,
    );
    expect(host.resources.size).toBe(0);
    expect(host.reservations.size).toBe(1);
  });
});
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
  test("an unprefixed endpoint URL halts without inventing a replacement or destroying the graph", async () => {
    const { result, resources, events } = await execute("unprefixed-route");
    expect(result.status).toBe("halted");
    expect(resources.size).toBe(15);
    expect(events.some((event) => event.method === "DELETE")).toBe(false);
    expect(events.some((event) => event.source === "app")).toBe(false);
  });
  test("an old unprefixed run id is refused before any Host request", async () => {
    const host = await localHost();
    let appended = false;
    await expect(
      runLifecycle({
        target,
        fixture: host.fixture,
        runId: "yurucommu-e2e-123456789abc",
        privateInputs,
        port: host.port,
        journal: {
          async append() {
            appended = true;
          },
          async close() {},
        },
      }),
    ).rejects.toThrow("RUN_ID_REFUSED");
    expect(host.events).toHaveLength(0);
    expect(appended).toBe(false);
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
    if (config.mode !== "execute") throw new Error("expected execute config");
    expect(config.runId).toMatch(/^staging-yuru-[0-9a-f]{12}$/);
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
      openJournal(dir, "staging-yuru-abcdefabcdef"),
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
    expect(form("database")).toBe(
      "https://edge.forms.takoform.com/forms/SQLiteDatabase/0.2.0/",
    );
    expect(form("schema")).toBe(
      "https://edge.forms.takoform.com/forms/SQLiteMigrationSet/0.4.0/",
    );
    expect(form("schema-application")).toBe(
      "https://edge.forms.takoform.com/forms/SQLiteMigrationApplication/0.4.0/",
    );
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
  const moduleBytes = new TextEncoder().encode(
    "// synthetic module for local HTTP protocol tests only",
  );
  const worker = {
    entrypoint: "yurucommu-worker.js",
    files: [
      {
        path: "yurucommu-worker.js",
        url: "https://fixture-staging.unit.takos.jp/immutable/yurucommu-worker.js",
        sha256: sha256(moduleBytes),
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
  const artifactBytes = [
    new TextEncoder().encode(workerBytes),
    new TextEncoder().encode(migrationBytes),
    moduleBytes,
    ...entries.map((entry) => new TextEncoder().encode(String(entry.sql))),
  ];
  return {
    path,
    receipt,
    worker,
    migrations,
    workerFile,
    migrationFile,
    artifactBytes,
  };
}
describe("held artifact byte transport retains complete verification", () => {
  test("consumes all 38 ordered actual bytes before the ordinary HTTP graph without artifact GETs", async () => {
    const input = await receiptFixture();
    const fixture = await loadFixture(input.path);
    expect(fixture.files).toHaveLength(38);
    const host = await localHost();
    let reads = 0;
    const artifactBytes: HostedArtifactBytePort = {
      async readArtifacts(required) {
        reads++;
        expect(required).toEqual(fixture.files);
        expect(Object.isFrozen(required)).toBe(true);
        expect(required.every(Object.isFrozen)).toBe(true);
        return input.artifactBytes;
      },
    };
    const journal = await openJournal(await directory(), runId);
    try {
      const result = await runLifecycle({
        target,
        fixture,
        runId,
        privateInputs,
        port: new HttpV2Port(
          target,
          writer,
          evidence,
          host.transport,
          artifactBytes,
        ),
        journal,
      });
      expect(result).toMatchObject({
        status: "passed",
        resourceCount: 15,
        authoritativeAbsence: true,
        routeAbsent: true,
      });
    } finally {
      await journal.close();
    }
    expect(reads).toBe(1);
    expect(host.resources.size).toBe(0);
    expect(host.events.some((event) => event.source === "artifact")).toBe(
      false,
    );
    expect(host.events.filter((event) => event.method === "POST")).toHaveLength(
      15,
    );
    expect(
      host.events.filter((event) => event.method === "DELETE"),
    ).toHaveLength(15);
    expect(
      host.events.filter((event) => event.path === "/v2/support"),
    ).toHaveLength(13);
  });
  const invalid = {
    empty: () => [],
    missing: (bytes: Uint8Array[]) => bytes.slice(1),
    extra: (bytes: Uint8Array[]) => [...bytes, bytes[0]!],
    reordered: (bytes: Uint8Array[]) => [
      bytes[1]!,
      bytes[0]!,
      ...bytes.slice(2),
    ],
    corrupt: (bytes: Uint8Array[]) => [new Uint8Array([0]), ...bytes.slice(1)],
    "empty-file": (bytes: Uint8Array[]) => [
      new Uint8Array(),
      ...bytes.slice(1),
    ],
    "non-byte": (bytes: Uint8Array[]) => [
      { byteLength: bytes[0]!.byteLength },
      ...bytes.slice(1),
    ],
    sparse: (bytes: Uint8Array[]) => new Array(bytes.length),
    "non-array": () => ({ length: 38 }),
    oversize: (bytes: Uint8Array[]) => [
      new Uint8Array(16_777_217),
      ...bytes.slice(1),
    ],
  };
  for (const [name, change] of Object.entries(invalid))
    test(`${name} byte batch refuses before any Host HTTP request`, async () => {
      const input = await receiptFixture();
      const fixture = await loadFixture(input.path);
      const host = await localHost();
      const port = new HttpV2Port(target, writer, evidence, host.transport, {
        async readArtifacts() {
          return change(
            input.artifactBytes,
          ) as unknown as readonly Uint8Array[];
        },
      });
      await expect(port.preflight([], fixture.files)).rejects.toThrow(
        "ARTIFACT_PUBLICATION_UNCONFIRMED",
      );
      expect(host.events).toHaveLength(0);
      expect(host.resources.size).toBe(0);
    });
  test("recomputes every manifest, module and SQL digest rather than accepting batch metadata", async () => {
    const input = await receiptFixture();
    const fixture = await loadFixture(input.path);
    const host = await localHost();
    for (let index = 0; index < input.artifactBytes.length; index++) {
      const batch = [...input.artifactBytes];
      const corrupt = batch[index]!.slice();
      corrupt[0] = corrupt[0]! ^ 1;
      batch[index] = corrupt;
      const port = new HttpV2Port(target, writer, evidence, host.transport, {
        async readArtifacts() {
          return batch;
        },
      });
      await expect(port.preflight([], fixture.files)).rejects.toThrow(
        "ARTIFACT_PUBLICATION_UNCONFIRMED",
      );
    }
    expect(host.events).toHaveLength(0);
  });
  test("a byte subclass cannot hide an oversized actual view", async () => {
    class HiddenSize extends Uint8Array {
      get byteLength() {
        return 1;
      }
    }
    const bytes = new HiddenSize(16_777_217);
    const host = await localHost();
    const port = new HttpV2Port(target, writer, evidence, host.transport, {
      async readArtifacts() {
        return [bytes];
      },
    });
    await expect(
      port.preflight(
        [],
        [
          {
            url: host.fixture.files[0]!.url,
            sha256: sha256(bytes),
          },
        ],
      ),
    ).rejects.toThrow("ARTIFACT_PUBLICATION_UNCONFIRMED");
    expect(host.events).toHaveLength(0);
  });
  test("aggregate overflow refuses even when all individual bytes and digests match", async () => {
    const chunk = new Uint8Array(16_777_216);
    const tail = new Uint8Array([1]);
    const bytes = [...Array<Uint8Array>(8).fill(chunk), tail];
    const required: Artifact[] = bytes.map((value, index) => ({
      url: `https://fixture-staging.unit.takos.jp/immutable/${index}`,
      sha256: sha256(value),
    }));
    const host = await localHost();
    const port = new HttpV2Port(target, writer, evidence, host.transport, {
      async readArtifacts() {
        return bytes;
      },
    });
    await expect(port.preflight([], required)).rejects.toThrow(
      "ARTIFACT_PUBLICATION_UNCONFIRMED",
    );
    expect(host.events).toHaveLength(0);
  });
  test("reader failure is sanitized and never falls back to anonymous HTTP", async () => {
    const host = await localHost();
    const port = new HttpV2Port(target, writer, evidence, host.transport, {
      async readArtifacts() {
        throw new Error(
          `reader failed ${writer} ${privateInputs.ENCRYPTION_KEY}`,
        );
      },
    });
    await expect(port.preflight([], host.fixture.files)).rejects.toThrow(
      /^ARTIFACT_PUBLICATION_UNCONFIRMED$/,
    );
    expect(host.events).toHaveLength(0);
  });
  test("runHarness forwards only the code byte port and keeps the journal on refusal", async () => {
    const input = await receiptFixture();
    const dir = await directory();
    const journalDirectory = await directory();
    const targetFile = join(dir, "target.json");
    await writeFile(
      targetFile,
      JSON.stringify({
        kind: "yurucommu.hosted-staging-target@v2",
        environment: "staging",
        api: API,
        appSuffix: APP_SUFFIX,
        ...target,
      }),
    );
    const network = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("unexpected external request"),
    );
    let reads = 0;
    try {
      await expect(
        runHarness(
          {
            mode: "execute",
            runId,
            targetFile,
            fixtureFile: input.path,
            journalDirectory,
            writer,
            evidence,
            privateInputs,
          },
          {
            artifactBytes: {
              async readArtifacts(required) {
                reads++;
                expect(required).toHaveLength(38);
                return [];
              },
            },
          },
        ),
      ).rejects.toThrow("ARTIFACT_PUBLICATION_UNCONFIRMED");
      expect(reads).toBe(1);
      expect(network).not.toHaveBeenCalled();
      expect(
        await readFile(join(journalDirectory, JOURNAL_FILENAME), "utf8"),
      ).toBe("");
    } finally {
      network.mockRestore();
    }
  });
});
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
