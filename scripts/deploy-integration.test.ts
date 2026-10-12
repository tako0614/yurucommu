import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertCreateOnlyPlan,
  assertDomainChangeset,
  assertDomainInventoryPage,
  assertPinnedRootDefaults,
  assertStateAddresses,
  assertSingleSuccessfulQuery,
  assertWorkerScriptAbsent,
  deployIntegration,
  isApiSuccess,
  loadIntegrationTarget,
  listFilteredDomains,
  parseIntegrationArgs,
} from "./deploy-integration.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function target(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "commu-integration-test-"));
  dirs.push(dir);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const pin = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../release.lock.json"), "utf8"),
  ).releases["v2.4.1"];
  const file = join(dir, "target.json");
  writeFileSync(
    file,
    JSON.stringify({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      origin: "https://ga-commu-20261012.yurucommu.com",
      prefix: "yurucommu-ga-20261012-0938",
      releaseTag: "v2.4.1",
      artifactSha256: pin.artifact.sha256.slice(7),
      sourceCommit: "c".repeat(40),
      stateDir,
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return { file, dir };
}

test("only the explicit integration phase syntax is accepted", () => {
  expect(
    parseIntegrationArgs(["--environment=integration", "--phase=resources"]),
  ).toBe("resources");
  expect(
    parseIntegrationArgs([
      "--environment=integration",
      "--phase=recover-prefix32",
    ]),
  ).toBe("recover-prefix32");
  for (const args of [
    ["--environment=production", "--phase=resources"],
    ["--environment=integration", "--phase=destroy"],
    ["--environment=integration", "--phase=resources1"],
    ["--environment=integration", "--phase=1resources"],
    ["--environment=integration", "--phase=resources", "--auto-approve"],
  ])
    expect(() => parseIntegrationArgs(args)).toThrow();
});

test("target binds exact origin, resource prefix, source and published artifact", () => {
  const good = target();
  const root = readFileSync(resolve(import.meta.dir, "../main.tf"), "utf8");
  const pin = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../release.lock.json"), "utf8"),
  ).releases["v2.4.1"].artifact.sha256.slice(7);
  const url =
    "https://github.com/tako0614/yurucommu/releases/download/v2.4.1/yurucommu-worker.js";
  expect(() =>
    assertPinnedRootDefaults(root, "v2.4.1", url, pin),
  ).not.toThrow();
  for (const [name, bad] of [
    ["worker_release_tag", "v2.4.0"],
    ["worker_bundle_url", "https://example.invalid/worker.js"],
    ["worker_bundle_sha256", `sha256:${"0".repeat(64)}`],
  ] as const) {
    const changed = root.replace(
      new RegExp(
        `(variable "${name}" \\{[\\s\\S]*?default\\s*=\\s*")[^"]+(")`,
        "u",
      ),
      (_, before: string, after: string) => `${before}${bad}${after}`,
    );
    expect(changed).not.toBe(root);
    // An unrelated correct-looking default cannot repair this variable block.
    const decoy = `${changed}\nvariable "decoy" {\n  default = "v2.4.1"\n}\n`;
    expect(() => assertPinnedRootDefaults(decoy, "v2.4.1", url, pin)).toThrow();
  }
  expect(loadIntegrationTarget(good.file).prefix).toBe(
    "yurucommu-ga-20261012-0938",
  );
  for (const wrong of [
    { origin: "https://test.yurucommu.com" },
    { prefix: "yurucommu" },
    { releaseTag: "v2.4.0" },
    { artifactSha256: "0".repeat(64) },
    { sourceCommit: "HEAD" },
  ])
    expect(() => loadIntegrationTarget(target(wrong).file)).toThrow();
});

test("private target refuses broad permissions and state outside its private tree", () => {
  const loose = target();
  chmodSync(loose.file, 0o644);
  expect(() => loadIntegrationTarget(loose.file)).toThrow();
  const escape = target({ stateDir: "/tmp" });
  expect(() => loadIntegrationTarget(escape.file)).toThrow();
  const aliasedTarget = target();
  const aliasParent = mkdtempSync(join(tmpdir(), "commu-integration-alias-"));
  dirs.push(aliasParent);
  symlinkSync(aliasedTarget.dir, join(aliasParent, "alias"), "dir");
  expect(() =>
    loadIntegrationTarget(join(aliasParent, "alias", "target.json")),
  ).toThrow();
  const aliasedState = target();
  mkdirSync(join(aliasedState.dir, "real-state"), { mode: 0o700 });
  mkdirSync(join(aliasedState.dir, "real-state", "inner"), {
    mode: 0o700,
  });
  symlinkSync(
    join(aliasedState.dir, "real-state"),
    join(aliasedState.dir, "state-alias"),
    "dir",
  );
  const payload = JSON.parse(readFileSync(aliasedState.file, "utf8"));
  payload.stateDir = join(aliasedState.dir, "state-alias", "inner");
  writeFileSync(aliasedState.file, JSON.stringify(payload));
  expect(() => loadIntegrationTarget(aliasedState.file)).toThrow();
});

test("prefix32 phase refuses a target pinned to a different or dirty source before provider access", async () => {
  const selected = target({ sourceCommit: "d".repeat(40) });
  const previous = process.env.YURUCOMMU_INTEGRATION_TARGET;
  process.env.YURUCOMMU_INTEGRATION_TARGET = selected.file;
  try {
    await expect(
      deployIntegration([
        "--environment=integration",
        "--phase=recover-prefix32",
      ]),
    ).rejects.toThrow("source must be the exact clean reviewed commit");
  } finally {
    if (previous === undefined) delete process.env.YURUCOMMU_INTEGRATION_TARGET;
    else process.env.YURUCOMMU_INTEGRATION_TARGET = previous;
  }
});

test("OpenTofu plan accepts only exact creates and unchanged predecessors", () => {
  const create = (address: string, actions = ["create"], mode = "managed") => ({
    address,
    mode,
    change: { actions },
  });
  const allowed = new Set(["cloudflare_d1_database.database[0]"]);
  const old = new Set(["random_id.encryption_key"]);
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [
          create("cloudflare_d1_database.database[0]"),
          create("random_id.encryption_key", ["no-op"]),
        ],
      },
      allowed,
      old,
    ),
  ).not.toThrow();
  for (const actions of [["delete"], ["update"], ["delete", "create"]]) {
    expect(() =>
      assertCreateOnlyPlan(
        {
          resource_changes: [
            create("cloudflare_d1_database.database[0]", actions),
          ],
        },
        allowed,
        old,
      ),
    ).toThrow();
  }
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [
          create("cloudflare_d1_database.database[0]"),
          create("cloudflare_workers_script.worker[0]"),
        ],
      },
      allowed,
    ),
  ).toThrow();
});

test("activation plan admits zero or one exact bundle observation and rejects every foreign or duplicate change", () => {
  const worker = "cloudflare_workers_script.worker[0]";
  const bundle = "data.http.worker_bundle[0]";
  const manifest = "data.http.worker_release_manifest[0]";
  const allowed = new Set([worker]);
  const expectedReads = new Set([bundle]);
  const entry = (address: string, actions: string[], mode = "managed") => ({
    address,
    mode,
    change: { actions },
  });
  const create = entry(worker, ["create"]);
  const check = (changes: unknown[], reads = expectedReads) =>
    assertCreateOnlyPlan(
      { resource_changes: changes },
      allowed,
      new Set(),
      reads,
    );
  expect(() => check([create])).not.toThrow();
  expect(() => check([create, entry(bundle, ["read"], "data")])).not.toThrow();
  expect(() => check([create, entry(bundle, ["no-op"], "data")])).not.toThrow();
  for (const changes of [
    [create, entry(bundle, ["read"], "data"), entry(bundle, ["no-op"], "data")],
    [create, entry(manifest, ["read"], "data")],
    [create, entry(manifest, ["no-op"], "data")],
    [create, entry(bundle, ["create"], "data")],
    [entry(worker, ["create"], "data")],
    [create, entry(worker, ["no-op"])],
    [create, entry("other.worker", ["no-op"])],
    [create, entry(bundle, ["read"], "managed")],
  ])
    expect(() => check(changes)).toThrow();
  expect(() =>
    check([create, entry(bundle, ["read"], "data")], new Set()),
  ).toThrow();
});

test("single-page Worker script inventory requires every entry to have an id", () => {
  expect(() => assertWorkerScriptAbsent({ result: [] })).not.toThrow();
  expect(() =>
    assertWorkerScriptAbsent({ result: [{ id: "unrelated-worker" }] }),
  ).not.toThrow();
  for (const result of [
    [{ id: "yurucommu-ga-20261012-0938" }],
    [null],
    [{}],
    [{ id: null }],
    [{ id: "" }],
  ])
    expect(() => assertWorkerScriptAbsent({ result })).toThrow();
});

test("custom domain changeset never accepts replacement or DNS conflict", () => {
  const added = [{ hostname: "ga-commu-20261012.yurucommu.com" }];
  const clean = { added, updated: [], deleted: [], conflicting: [] };
  expect(() => assertDomainChangeset(clean)).not.toThrow();
  for (const key of ["updated", "deleted", "conflicting"] as const) {
    expect(() => assertDomainChangeset({ ...clean, [key]: added })).toThrow();
  }
  expect(() =>
    assertDomainChangeset({ ...clean, added: [{ hostname: "yurucommu.com" }] }),
  ).toThrow();
});

test("filtered custom-domain inventory refuses an unseen later page", () => {
  const hostname = "ga-commu-20261012.yurucommu.com";
  const first = {
    result: [{ id: "first", hostname }],
    result_info: { page: 1, per_page: 20, count: 1, total_count: 2 },
  };
  expect(
    assertDomainInventoryPage(first, 1, "hostname", hostname).totalCount,
  ).toBe(2);
  expect(() =>
    assertDomainInventoryPage(first, 2, "hostname", hostname),
  ).toThrow();
  const second = {
    result: [{ id: "second", hostname, service: "another-worker" }],
    result_info: { page: 2, per_page: 20, count: 1, total_count: 2 },
  };
  expect(
    assertDomainInventoryPage(second, 2, "hostname", hostname).rows,
  ).toHaveLength(1);
  expect(() =>
    assertDomainInventoryPage(
      second,
      2,
      "service",
      "yurucommu-ga-20261012-0938",
    ),
  ).toThrow();
  const empty = {
    result: [],
    result_info: { page: 1, per_page: 0, count: 0, total_count: 0 },
  };
  expect(
    assertDomainInventoryPage(empty, 1, "hostname", hostname).totalCount,
  ).toBe(0);
});

test("filtered domain query actually reads the page containing a late collision", async () => {
  const host = "ga-commu-20261012.yurucommu.com";
  const requested: string[] = [];
  const rows = await listFilteredDomains(
    "a".repeat(32),
    "hostname",
    host,
    async (path) => {
      requested.push(path);
      return new URL(path, "https://api.cloudflare.com").searchParams.get(
        "page",
      ) === "1"
        ? {
            result: [{ id: "first", hostname: host }],
            result_info: { page: 1, per_page: 100, count: 1, total_count: 2 },
          }
        : {
            result: [
              { id: "second", hostname: host, service: "foreign-worker" },
            ],
            result_info: { page: 2, per_page: 100, count: 1, total_count: 2 },
          };
    },
  );
  expect(requested).toHaveLength(2);
  expect(rows).toHaveLength(2);
});

test("filtered domain pagination refuses a repeated row or inconsistent page", async () => {
  const host = "ga-commu-20261012.yurucommu.com";
  const first = {
    result: [{ id: "same", hostname: host }],
    result_info: { page: 1, per_page: 100, count: 1, total_count: 2 },
  };
  const duplicate = {
    result: [{ id: "same", hostname: host }],
    result_info: { page: 2, per_page: 100, count: 1, total_count: 2 },
  };
  await expect(
    listFilteredDomains("a".repeat(32), "hostname", host, async (path) =>
      new URL(path, "https://api.cloudflare.com").searchParams.get("page") ===
      "1"
        ? first
        : duplicate,
    ),
  ).rejects.toThrow();
  await expect(
    listFilteredDomains("a".repeat(32), "hostname", host, async () => first),
  ).rejects.toThrow();
});

test("activated state requires exactly the explicit Worker bundle data source", () => {
  const managed = new Set(["cloudflare_workers_script.worker[0]"]);
  const data = [
    "data.http.worker_release_manifest[0]",
    "data.http.worker_bundle[0]",
  ];
  expect(() =>
    assertStateAddresses([...managed, ...data], managed, true),
  ).toThrow();
  expect(() =>
    assertStateAddresses([...managed, data[1]], managed, true),
  ).not.toThrow();
  expect(() =>
    assertStateAddresses([...managed, ...data], managed, false),
  ).toThrow();
  expect(() => assertStateAddresses([...managed], managed, true)).toThrow();
  expect(() =>
    assertStateAddresses([...managed, "data.http.foreign[0]"], managed, true),
  ).toThrow();
  expect(() =>
    assertStateAddresses(
      [...managed, "cloudflare_d1_database.production[0]"],
      managed,
      true,
    ),
  ).toThrow();
});

test("D1 ledger readback needs one successful result", () => {
  expect(() =>
    assertSingleSuccessfulQuery({ result: [{ success: true, results: [] }] }),
  ).not.toThrow();
  for (const result of [
    [],
    [{ success: false }],
    [{ success: true }, { success: true }],
  ]) {
    expect(() => assertSingleSuccessfulQuery({ result })).toThrow();
  }
});

test("pre-activation ledger refuses explicit errors even with success and matching rows", () => {
  for (const body of [
    {
      success: true,
      errors: [{ message: "query failed" }],
      result: [{ success: true, results: [] }],
    },
    {
      success: true,
      result: [
        { success: true, errors: [{ message: "query failed" }], results: [] },
      ],
    },
    {
      success: true,
      result: [{ success: true, error: "query failed", results: [] }],
    },
    { success: true, result: [{ success: true }] },
  ])
    expect(() => assertSingleSuccessfulQuery(body)).toThrow();
});

test("empty and malformed Worker identities refuse activation absence", () => {
  for (const result of [[null], [{}], [{ id: "" }], [{ id: 42 }]]) {
    expect(() => assertWorkerScriptAbsent({ result })).toThrow();
  }
});

// Live Queues inventory returned this nullable-error success shape before any write.
// IDs/names are disposable placeholders; response status is checked by the caller.
test("nullable Queue error field accepts explicit success and refuses contradictions", () => {
  const queuePage = {
    success: true,
    errors: null,
    messages: null,
    result: [
      { queue_id: "a".repeat(32), queue_name: "unrelated-existing-queue" },
    ],
    result_info: {
      page: 1,
      per_page: 100,
      count: 1,
      total_count: 1,
      total_pages: 1,
    },
  };
  expect(isApiSuccess(queuePage)).toBe(true);
  for (const change of [
    { success: false },
    { success: undefined },
    { errors: [{ code: 7003, message: "provider failure" }] },
    { errors: "provider failure" },
    { errors: {} },
    { error: "provider failure" },
    { error: { message: "provider failure" } },
  ])
    expect(isApiSuccess({ ...queuePage, ...change })).toBe(false);
});
