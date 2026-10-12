#!/usr/bin/env bun
// Isolated integration bootstrap. The production Worker publisher never calls this module.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://ga-commu-20261012.yurucommu.com";
const PREFIX = "yurucommu-ga-20261012-0938";
const TAG = "v2.4.1";
const PHASES = new Set([
  "preflight",
  "resources",
  "fresh-schema",
  "recover-prefix32",
  "activate",
  "domain",
  "test-owner-auth",
]);
const RESOURCE_ADDRESSES = new Set([
  "random_id.encryption_key",
  "cloudflare_d1_database.database[0]",
  "cloudflare_r2_bucket.media[0]",
  "cloudflare_workers_kv_namespace.kv[0]",
  "cloudflare_queue.delivery[0]",
  "cloudflare_queue.delivery_dlq[0]",
]);
const ACTIVATE_ADDRESSES = new Set([
  "cloudflare_workers_script.worker[0]",
  "cloudflare_queue_consumer.delivery[0]",
  "cloudflare_queue_consumer.delivery_dlq[0]",
  "cloudflare_workers_cron_trigger.retention[0]",
]);
const ACTIVATION_DATA_ADDRESSES = new Set(["data.http.worker_bundle[0]"]);
let diagnosticsDir;

function insist(ok, message) {
  if (!ok) throw new Error(message);
}
function own(value, keys, label) {
  insist(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  insist(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} has unexpected keys`,
  );
}
function within(base, path) {
  const p = relative(base, path);
  return p === "" || (!p.startsWith("..") && !isAbsolute(p));
}
function rootVariableDefault(source, name) {
  const marker = new RegExp(`^variable\\s+"${name}"\\s*\\{`, "mu");
  const found = marker.exec(source);
  insist(found, `root module lacks variable ${name}`);
  const tail = source.slice(found.index + found[0].length);
  const end = tail.search(/^\}/mu);
  insist(end >= 0, `root variable ${name} has no closing block`);
  const defaults = [
    ...tail.slice(0, end).matchAll(/^\s*default\s*=\s*"([^"]*)"\s*$/gmu),
  ];
  insist(
    defaults.length === 1,
    `root variable ${name} has no unique string default`,
  );
  return defaults[0][1];
}
export function assertPinnedRootDefaults(
  source,
  releaseTag,
  expectedUrl,
  expectedSha256,
) {
  insist(
    rootVariableDefault(source, "worker_release_tag") === releaseTag &&
      rootVariableDefault(source, "worker_bundle_url") === expectedUrl,
    "root module default release identity differs from target",
  );
  const configuredDigest = rootVariableDefault(source, "worker_bundle_sha256");
  const normalizedDigest = configuredDigest.replace(/^sha256:/u, "");
  insist(
    /^[a-f0-9]{64}$/u.test(normalizedDigest) &&
      normalizedDigest === expectedSha256,
    "root module default Worker digest differs from target",
  );
}
function privatePath(path, kind) {
  insist(
    typeof path === "string" && isAbsolute(path),
    `${kind} must be an absolute path`,
  );
  const s = lstatSync(path);
  insist(
    !s.isSymbolicLink() &&
      (s.mode & 0o777) === (kind === "target" ? 0o600 : 0o700),
    `${kind} mode must be ${kind === "target" ? "0600" : "0700"}`,
  );
  insist(
    kind === "target" ? s.isFile() && s.nlink === 1 : s.isDirectory(),
    `${kind} must be a link-free ${kind === "target" ? "regular file" : "directory"}`,
  );
  const actual = realpathSync(path);
  insist(resolve(path) === actual, `${kind} has a symbolic-link ancestor`);
  insist(!within(REPO, actual), `${kind} must be outside source worktree`);
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: REPO,
    encoding: "utf8",
  });
  insist(common.status === 0, "cannot resolve source Git common directory");
  insist(
    !within(resolve(REPO, common.stdout.trim()), actual),
    `${kind} must be outside source Git common directory`,
  );
  for (let at = dirname(actual); at !== dirname(at); at = dirname(at)) {
    insist(
      !existsSync(join(at, ".git")),
      `${kind} must be outside every Git worktree`,
    );
  }
  return actual;
}
export function parseIntegrationArgs(args) {
  insist(
    args.length === 2 &&
      args[0] === "--environment=integration" &&
      /^--phase=[a-z][a-z0-9-]*$/u.test(args[1]),
    "requires exactly --environment=integration --phase=<phase>",
  );
  const phase = args[1].slice(8);
  insist(PHASES.has(phase), `unsupported integration phase ${phase}`);
  return phase;
}
export function loadIntegrationTarget(
  path = process.env.YURUCOMMU_INTEGRATION_TARGET,
) {
  const file = privatePath(path, "target");
  privatePath(dirname(file), "directory");
  const t = JSON.parse(readFileSync(file, "utf8"));
  own(
    t,
    [
      "accountId",
      "zoneId",
      "origin",
      "prefix",
      "releaseTag",
      "artifactSha256",
      "sourceCommit",
      "stateDir",
    ],
    "integration target",
  );
  insist(
    /^[a-f0-9]{32}$/u.test(t.accountId) && /^[a-f0-9]{32}$/u.test(t.zoneId),
    "target accountId/zoneId must be exact Cloudflare ids",
  );
  insist(
    t.origin === ORIGIN && t.prefix === PREFIX && t.releaseTag === TAG,
    "target differs from the isolated integration identity",
  );
  insist(
    /^[a-f0-9]{40}$/u.test(t.sourceCommit),
    "target needs one exact source commit",
  );
  const pin = JSON.parse(readFileSync(join(REPO, "release.lock.json"), "utf8"))
    .releases?.[TAG];
  const expectedUrl = `https://github.com/tako0614/yurucommu/releases/download/${TAG}/yurucommu-worker.js`;
  insist(
    pin?.artifact?.url === expectedUrl &&
      pin.artifact.sha256 === `sha256:${t.artifactSha256}` &&
      /^[a-f0-9]{64}$/u.test(t.artifactSha256),
    "target artifact differs from the published release lock",
  );
  const source = readFileSync(join(REPO, "main.tf"), "utf8");
  assertPinnedRootDefaults(source, TAG, expectedUrl, t.artifactSha256);
  const dir = privatePath(t.stateDir, "directory");
  insist(
    dirname(dir) === dirname(file) || within(dirname(file), dir),
    "stateDir must be under target's private directory",
  );
  return { ...t, stateDir: dir, expectedUrl };
}
function sourceIsExact(t) {
  const head = invoke("git", ["rev-parse", "HEAD"], REPO).trim();
  const dirty = invoke("git", ["status", "--porcelain"], REPO).trim();
  insist(
    head === t.sourceCommit && dirty === "",
    "source must be the exact clean reviewed commit",
  );
}
function safeEnv() {
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "SSL_CERT_FILE",
    "CLOUDFLARE_API_TOKEN",
    "TF_VAR_encryption_key",
    "TF_VAR_session_hash_salt",
    "TF_VAR_auth_password_hash",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
function privateDiagnostic(label, output) {
  if (!diagnosticsDir) return "private diagnostics unavailable";
  const path = join(diagnosticsDir, `${label}-${randomUUID()}.log`);
  writeFileSync(path, output, { flag: "wx", mode: 0o600 });
  return path;
}
function invoke(command, args, cwd, env = safeEnv()) {
  const r = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    const log = privateDiagnostic(
      command,
      `${String(r.error?.message ?? "")}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`,
    );
    throw new Error(
      `${command} ${args[0] ?? ""} failed; raw diagnostics: ${log}; inspect authoritative target before retry`,
    );
  }
  return r.stdout;
}
function hasNoApiErrors(value) {
  return (
    (value?.errors === undefined ||
      value.errors === null ||
      (Array.isArray(value.errors) && value.errors.length === 0)) &&
    (value?.error === undefined || value.error === null || value.error === "")
  );
}
export function isApiSuccess(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.success === true &&
    hasNoApiErrors(value)
  );
}
async function api(t, method, path, body) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  insist(
    typeof token === "string" && token.length > 0,
    "ephemeral CLOUDFLARE_API_TOKEN is required",
  );
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  if (!response.ok || !isApiSuccess(value)) {
    const log = privateDiagnostic("cloudflare", raw);
    throw new Error(
      `${method} ${path.split("?")[0]} denied or failed (${response.status}); raw diagnostics: ${log}; no blind retry`,
    );
  }
  return value;
}
async function pages(t, endpoint, key, field, name) {
  let totalCount;
  let seen = 0;
  for (let page = 1; page <= 100; page++) {
    const sep = endpoint.includes("?") ? "&" : "?";
    const body = await api(
      t,
      "GET",
      `${endpoint}${sep}page=${page}&per_page=100`,
    );
    insist(Array.isArray(body.result), `malformed ${key} inventory`);
    const info = body.result_info;
    insist(
      info &&
        info.page === page &&
        Number.isInteger(info.count) &&
        info.count === body.result.length &&
        Number.isInteger(info.total_count) &&
        info.total_count >= 0 &&
        Number.isInteger(info.per_page) &&
        info.per_page >= 0,
      `incomplete ${key} inventory pagination`,
    );
    if (totalCount !== undefined)
      insist(
        info.total_count === totalCount,
        `${key} inventory total changed while paginating`,
      );
    totalCount = info.total_count;
    insist(
      totalCount === 0 || (info.per_page > 0 && body.result.length > 0),
      `${key} inventory stopped before its final page`,
    );
    if (body.result.some((item) => item?.[field] === name))
      throw new Error(
        `${key} ${name} already exists; import/takeover is forbidden`,
      );
    seen += body.result.length;
    insist(
      seen <= totalCount,
      `${key} inventory returned more rows than total_count`,
    );
    if (seen === totalCount) return;
  }
  throw new Error(`${key} inventory exceeded pagination bound`);
}
async function r2Absent(t) {
  let cursor;
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const p = `/accounts/${t.accountId}/r2/buckets?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const value = await api(t, "GET", p);
    insist(
      Array.isArray(value.result?.buckets),
      "malformed R2 bucket inventory",
    );
    insist(
      !value.result.buckets.some((b) => b?.name === `${PREFIX}-media`),
      "R2 bucket already exists",
    );
    cursor = value.result_info?.cursor;
    if (!cursor) return;
    insist(!seen.has(cursor), "R2 inventory cursor loop");
    seen.add(cursor);
  }
  throw new Error("R2 inventory exceeded cursor bound");
}
export function assertDomainInventoryPage(value, page, filter, expected) {
  const rows = value?.result;
  const info = value?.result_info;
  insist(Array.isArray(rows), "malformed Worker domain inventory");
  insist(
    info &&
      info.page === page &&
      Number.isInteger(info.per_page) &&
      info.per_page >= 0 &&
      Number.isInteger(info.total_count) &&
      info.total_count >= 0 &&
      Number.isInteger(info.count) &&
      info.count === rows.length,
    "incomplete Worker domain inventory pagination",
  );
  insist(
    info.total_count === 0
      ? page === 1 && rows.length === 0
      : info.per_page > 0 && rows.length > 0,
    "Worker domain inventory stopped before its final page",
  );
  if (info.total_pages !== undefined)
    insist(
      Number.isInteger(info.total_pages) && info.total_pages >= page,
      "Worker domain inventory total_pages is inconsistent",
    );
  insist(
    rows.every((row) => row && row[filter] === expected),
    "Worker domain filter did not return exact matches",
  );
  return { rows, totalCount: info.total_count, totalPages: info.total_pages };
}
export async function listFilteredDomains(
  accountId,
  filter,
  expected,
  request,
) {
  const rows = [];
  const ids = new Set();
  let totalCount;
  let totalPages;
  for (let page = 1; page <= 100; page++) {
    const value = await request(
      `/accounts/${accountId}/workers/domains?${filter}=${encodeURIComponent(expected)}&page=${page}&per_page=100`,
    );
    const parsed = assertDomainInventoryPage(value, page, filter, expected);
    if (totalCount !== undefined)
      insist(
        parsed.totalCount === totalCount,
        "Worker domain inventory total changed while paginating",
      );
    totalCount = parsed.totalCount;
    if (totalPages !== undefined)
      insist(
        parsed.totalPages === totalPages,
        "Worker domain inventory total_pages changed while paginating",
      );
    totalPages = parsed.totalPages;
    for (const row of parsed.rows) {
      insist(
        typeof row.id === "string" && row.id.length > 0,
        "Worker domain inventory entry lacks an id",
      );
      insist(
        !ids.has(row.id),
        "Worker domain inventory repeated an entry on another page",
      );
      ids.add(row.id);
    }
    rows.push(...parsed.rows);
    insist(
      rows.length <= totalCount,
      "Worker domain inventory exceeded total_count",
    );
    if (rows.length === totalCount) {
      if (totalPages !== undefined)
        insist(
          page === totalPages,
          "Worker domain inventory ended before total_pages",
        );
      return rows;
    }
    if (totalPages !== undefined)
      insist(
        page < totalPages,
        "Worker domain inventory ended before total_count",
      );
  }
  throw new Error("Worker domain inventory exceeded pagination bound");
}
async function domainsBy(t, filter, expected) {
  return listFilteredDomains(t.accountId, filter, expected, (path) =>
    api(t, "GET", path),
  );
}
async function exactDomainAbsent(t) {
  const hostname = new URL(ORIGIN).hostname;
  insist(
    (await domainsBy(t, "hostname", hostname)).length === 0,
    "hostname already has a Worker custom domain",
  );
  insist(
    (await domainsBy(t, "service", PREFIX)).length === 0,
    "target Worker already owns a custom domain; replace_state could detach it",
  );
}
export function assertTestOwnerDomainSnapshot(
  hostnameRows,
  serviceRows,
  zoneId,
) {
  insist(
    /^[a-f0-9]{32}$/u.test(zoneId ?? "") &&
      Array.isArray(hostnameRows) &&
      Array.isArray(serviceRows),
    "test-owner custom-domain inventories are malformed",
  );
  if (hostnameRows.length === 0 && serviceRows.length === 0) return "ABSENT";
  insist(
    hostnameRows.length === 1 && serviceRows.length === 1,
    "test-owner custom-domain inventories are incomplete or contain extra domains",
  );
  const hostname = new URL(ORIGIN).hostname;
  for (const row of [hostnameRows[0], serviceRows[0]])
    insist(
      row !== null &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        typeof row.id === "string" &&
        row.id.trim().length > 0 &&
        row.hostname === hostname &&
        row.zone_id === zoneId &&
        row.service === PREFIX &&
        row.environment === "production",
      "test-owner custom domain differs from the exact isolated Worker",
    );
  insist(
    hostnameRows[0].id === serviceRows[0].id,
    "test-owner custom-domain inventories disagree on domain id",
  );
  return "EXACT_BOUND";
}
async function noTakeover(t) {
  const zone = await api(t, "GET", `/zones/${t.zoneId}`);
  insist(
    zone.result?.name === "yurucommu.com" &&
      zone.result?.account?.id === t.accountId,
    "selected zone does not belong to the exact account and product domain",
  );
  await pages(
    t,
    `/accounts/${t.accountId}/d1/database?name=${PREFIX}-db`,
    "D1",
    "name",
    `${PREFIX}-db`,
  );
  await r2Absent(t);
  await pages(
    t,
    `/accounts/${t.accountId}/storage/kv/namespaces`,
    "KV",
    "title",
    `${PREFIX}-kv`,
  );
  for (const queue of [`${PREFIX}-delivery`, `${PREFIX}-delivery-dlq`])
    await pages(
      t,
      `/accounts/${t.accountId}/queues`,
      "Queue",
      "queue_name",
      queue,
    );
  assertWorkerScriptAbsent(
    await api(t, "GET", `/accounts/${t.accountId}/workers/scripts`),
  );
  await exactDomainAbsent(t);
}
export function assertWorkerScriptAbsent(value) {
  const scripts = value?.result;
  insist(
    Array.isArray(scripts) &&
      scripts.every(
        (script) => typeof script?.id === "string" && script.id.length > 0,
      ),
    "Worker script inventory malformed",
  );
  insist(
    !scripts.some((script) => script.id === PREFIX),
    "Worker already exists; import/takeover is forbidden",
  );
}
function moduleDir(t) {
  const dir = join(t.stateDir, "module");
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  privatePath(dir, "directory");
  for (const name of [
    "main.tf",
    "outputs.tf",
    "release.lock.json",
    ".terraform.lock.hcl",
  ]) {
    const src = readFileSync(join(REPO, name));
    const dst = join(dir, name);
    if (existsSync(dst))
      insist(
        createHash("sha256").update(readFileSync(dst)).digest("hex") ===
          createHash("sha256").update(src).digest("hex"),
        `private module ${name} differs from this source`,
      );
    else copyFileSync(join(REPO, name), dst);
  }
  return dir;
}
async function tofu(t, phase) {
  const dir = moduleDir(t);
  invoke(
    "tofu",
    [
      "init",
      "-backend=false",
      "-input=false",
      "-lockfile=readonly",
      "-no-color",
    ],
    dir,
  );
  const state = join(dir, "terraform.tfstate");
  const expectedBefore = phase === "resources" ? new Set() : RESOURCE_ADDRESSES;
  const before = existsSync(state)
    ? invoke("tofu", ["state", "list", "-no-color"], dir)
        .trim()
        .split("\n")
        .filter(Boolean)
    : [];
  assertStateAddresses(before, expectedBefore, false);
  const plan = join(t.stateDir, `${phase}.tfplan`);
  insist(
    !existsSync(plan),
    "a private plan already exists; inspect it before any retry",
  );
  const vars = [
    "-var=enable_cloudflare_resources=true",
    `-var=cloudflare_account_id=${t.accountId}`,
    `-var=project_name=${PREFIX}`,
    `-var=worker_name=${PREFIX}`,
    `-var=app_url=${ORIGIN}`,
    `-var=enable_cloudflare_worker_script=${phase === "activate"}`,
    "-var=enable_workers_dev_subdomain=false",
    "-var=cloudflare_route_zone_id=",
    "-var=cloudflare_route_pattern=",
  ];
  if (phase === "activate") {
    for (const name of [
      "TF_VAR_encryption_key",
      "TF_VAR_session_hash_salt",
      "TF_VAR_auth_password_hash",
    ])
      insist(
        typeof process.env[name] === "string" && process.env[name].length > 0,
        `${name} must be supplied ephemerally before activation`,
      );
    insist(
      /^[a-f0-9]{64}$/u.test(process.env.TF_VAR_encryption_key) &&
        /^[a-f0-9]{64}$/u.test(process.env.TF_VAR_session_hash_salt),
      "encryption key and session salt must be distinct 64-hex values",
    );
    insist(
      process.env.TF_VAR_encryption_key !==
        process.env.TF_VAR_session_hash_salt,
      "encryption key and session salt must differ",
    );
    insist(
      !/^\s*$/u.test(process.env.TF_VAR_auth_password_hash),
      "test-owner password hash must be nonblank",
    );
  }
  invoke(
    "tofu",
    [
      "plan",
      "-input=false",
      "-lock=true",
      "-no-color",
      `-out=${plan}`,
      ...vars,
    ],
    dir,
  );
  const shown = JSON.parse(invoke("tofu", ["show", "-json", plan], dir));
  const allowed =
    phase === "resources" ? RESOURCE_ADDRESSES : ACTIVATE_ADDRESSES;
  assertCreateOnlyPlan(
    shown,
    allowed,
    expectedBefore,
    phase === "activate" ? ACTIVATION_DATA_ADDRESSES : new Set(),
  );
  if (phase === "activate")
    assertWorkerScriptAbsent(
      await api(t, "GET", `/accounts/${t.accountId}/workers/scripts`),
    );
  try {
    invoke(
      "tofu",
      ["apply", "-input=false", "-lock=true", "-no-color", plan],
      dir,
    );
    const after = invoke("tofu", ["state", "list", "-no-color"], dir)
      .trim()
      .split("\n")
      .filter(Boolean);
    const expectedAfter = new Set([...expectedBefore, ...allowed]);
    assertStateAddresses(after, expectedAfter, phase === "activate");
    insist(
      (statSync(state).mode & 0o077) === 0 &&
        (statSync(plan).mode & 0o077) === 0,
      "private state and plan must be 0600 or stricter",
    );
    return { phase, status: "APPLIED", resourceCount: after.length };
  } catch (error) {
    error.phase = "POST_APPLY_INDETERMINATE";
    throw error;
  }
}
export function assertStateAddresses(addresses, expectedManaged, activated) {
  insist(
    Array.isArray(addresses) && new Set(addresses).size === addresses.length,
    "private OpenTofu state addresses are malformed or duplicated",
  );
  const managed = addresses.filter((address) => !address.startsWith("data."));
  const data = addresses.filter((address) => address.startsWith("data."));
  insist(
    managed.length === expectedManaged.size &&
      managed.every((address) => expectedManaged.has(address)),
    "private OpenTofu state has missing or foreign managed resources",
  );
  insist(
    (activated || data.length === 0) &&
      data.every((address) => ACTIVATION_DATA_ADDRESSES.has(address)),
    "private OpenTofu state has foreign data sources",
  );
  insist(
    !activated || data.includes("data.http.worker_bundle[0]"),
    "activated state lacks the explicit published Worker bundle data source",
  );
}
export function assertCreateOnlyPlan(
  shown,
  allowed,
  existing = new Set(),
  expectedReads = new Set(),
) {
  const changes = shown?.resource_changes;
  insist(Array.isArray(changes), "OpenTofu plan lacks resource changes");
  insist(
    changes.every((change) => typeof change?.address === "string") &&
      new Set(changes.map((change) => change.address)).size === changes.length,
    "OpenTofu plan has malformed or duplicate addresses",
  );
  const creates = changes.filter(
    (c) => JSON.stringify(c.change?.actions) === '["create"]',
  );
  const unchanged = changes.filter(
    (c) => JSON.stringify(c.change?.actions) === '["no-op"]',
  );
  const reads = changes.filter(
    (c) => JSON.stringify(c.change?.actions) === '["read"]',
  );
  const dataObservations = [
    ...reads,
    ...unchanged.filter((change) => change.mode === "data"),
  ];
  insist(
    creates.length === allowed.size &&
      creates.every((c) => c.mode === "managed" && allowed.has(c.address)),
    "plan has unexpected resource creation",
  );
  insist(
    changes.length === creates.length + reads.length + unchanged.length &&
      unchanged
        .filter((change) => change.mode !== "data")
        .every(
          (change) => change.mode === "managed" && existing.has(change.address),
        ) &&
      dataObservations.length <= expectedReads.size &&
      dataObservations.every(
        (change) => change.mode === "data" && expectedReads.has(change.address),
      ),
    "plan updates, deletes, replaces, or reads unapproved resources",
  );
}
function databaseFromState(t, exactAddresses) {
  const dir = moduleDir(t);
  const addresses = invoke("tofu", ["state", "list", "-no-color"], dir)
    .trim()
    .split("\n")
    .filter(Boolean);
  assertStateAddresses(
    addresses,
    exactAddresses,
    exactAddresses.has("cloudflare_workers_script.worker[0]"),
  );
  const output = JSON.parse(invoke("tofu", ["output", "-json"], dir));
  const db = output.cloudflare_d1_database_id?.value;
  insist(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      db ?? "",
    ),
    "private state lacks a D1 database UUID",
  );
  insist(
    output.cloudflare_account_id?.value === t.accountId &&
      output.worker_name?.value === PREFIX &&
      output.launch_url?.value === ORIGIN,
    "private state outputs differ from exact target",
  );
  return db;
}
export function testOwnerAuthPayload(hash) {
  insist(
    typeof hash === "string" && /^[a-f0-9]{64}:[a-f0-9]{64}$/u.test(hash),
    "ephemeral test-owner password hash must be canonical PBKDF2 salt:hash",
  );
  return { name: "AUTH_PASSWORD_HASH", text: hash, type: "secret_text" };
}
export function assertEmptyOwnerTables(body) {
  assertSingleSuccessfulQuery(body);
  const rows = body.result[0].results;
  insist(
    rows.length === 1 && rows[0]?.actors === 0 && rows[0]?.sessions === 0,
    "isolated test-owner auth requires zero actors and sessions",
  );
}
export async function withTestOwnerAuthPreflight(preflight, put, readback) {
  await preflight();
  try {
    await put();
    return await readback();
  } catch {
    const error = new Error(
      "test-owner secret write or active Version readback indeterminate; reconcile without replay",
    );
    error.phase = "POST_AUTH_INDETERMINATE";
    throw error;
  }
}
function testOwnerStateBindings(t) {
  const path = join(moduleDir(t), "terraform.tfstate");
  const stat = lstatSync(path);
  insist(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (stat.mode & 0o077) === 0 &&
      realpathSync(path) === path,
    "test-owner private state file must be link-free and 0600 or stricter",
  );
  const state = JSON.parse(readFileSync(path, "utf8"));
  insist(
    state.version === 4 && Array.isArray(state.resources),
    "test-owner state is malformed",
  );
  const one = (type, name, mode) => {
    const found = state.resources.filter(
      (resource) =>
        resource.type === type &&
        resource.name === name &&
        resource.mode === mode,
    );
    insist(
      found.length === 1 && found[0].instances?.length === 1,
      "test-owner state resource is not unique",
    );
    return found[0].instances[0].attributes;
  };
  const worker = one("cloudflare_workers_script", "worker", "managed");
  const bundle = one("http", "worker_bundle", "data");
  const digest = createHash("sha256")
    .update(Buffer.from(bundle.response_body ?? "", "utf8"))
    .digest("hex");
  insist(
    worker.script_name === PREFIX &&
      worker.main_module === "worker.js" &&
      (worker.content_sha256 === digest ||
        worker.content_sha256 === `sha256:${digest}`) &&
      digest === t.artifactSha256 &&
      Array.isArray(worker.bindings),
    "test-owner state Worker differs from the exact published artifact",
  );
  return worker.bindings;
}
export function assertTestOwnerBindings(expected, actual) {
  const fields = [
    "text",
    "database_id",
    "namespace_id",
    "bucket_name",
    "queue_name",
  ];
  const targetField = {
    plain_text: "text",
    d1: "database_id",
    kv_namespace: "namespace_id",
    r2_bucket: "bucket_name",
    queue: "queue_name",
  };
  insist(
    Array.isArray(expected) &&
      expected.every(
        (binding) =>
          binding !== null &&
          typeof binding === "object" &&
          !Array.isArray(binding) &&
          typeof binding.name === "string" &&
          binding.name.length > 0 &&
          (binding.type === "secret_text" ||
            Object.hasOwn(targetField, binding.type)),
      ) &&
      new Set(expected.map((binding) => binding?.name)).size ===
        expected.length &&
      Array.isArray(actual) &&
      actual.length === expected.length,
    "test-owner Worker binding count differs from state",
  );
  const byName = new Map();
  for (const binding of actual) {
    insist(
      binding !== null &&
        typeof binding === "object" &&
        !Array.isArray(binding) &&
        typeof binding.name === "string" &&
        binding.name.length > 0 &&
        typeof binding.type === "string" &&
        !byName.has(binding.name),
      "test-owner Worker bindings are malformed or duplicated",
    );
    byName.set(binding.name, binding);
  }
  const safe = [];
  for (const want of expected) {
    const got = byName.get(want?.name);
    insist(
      got?.type === want?.type,
      "test-owner Worker binding identity differs from state",
    );
    const selected = { name: got.name, type: got.type };
    if (want.type !== "secret_text") {
      const required = targetField[want.type];
      for (const key of fields) {
        const stateValue = want[key];
        const providerValue = got[key];
        if (key === required) {
          insist(
            typeof stateValue === "string" &&
              stateValue.length > 0 &&
              providerValue === stateValue,
            "test-owner Worker binding target differs from state",
          );
          selected[key] = providerValue;
        } else {
          insist(
            stateValue == null && providerValue == null,
            "test-owner Worker binding has unexpected optional target",
          );
        }
      }
    }
    safe.push(selected);
  }
  insist(
    [
      "AUTH_PASSWORD_HASH",
      "ENCRYPTION_KEY",
      "YURUCOMMU_SESSION_HASH_SALT",
    ].every((name) => byName.get(name)?.type === "secret_text"),
    "test-owner Worker secret binding closure differs from state",
  );
  return JSON.stringify(safe.sort((a, b) => a.name.localeCompare(b.name)));
}
async function testOwnerRequest(t, method, path, payload) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  insist(
    typeof token === "string" && token.length > 0,
    "ephemeral Cloudflare token is required",
  );
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    insist(
      response.status === 200 &&
        !response.redirected &&
        !response.headers.get("location"),
      "test-owner provider response failed",
    );
  } catch {
    throw new Error(
      "test-owner provider request failed; reconcile without replay",
    );
  }
  return response;
}
async function testOwnerJson(t, method, path, payload) {
  const response = await testOwnerRequest(t, method, path, payload);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "test-owner provider JSON response is malformed; reconcile without replay",
    );
  }
  insist(
    isApiSuccess(body),
    "test-owner provider rejected request; reconcile without replay",
  );
  return body.result;
}
async function activeTestOwnerWorker(t, expectedBindings) {
  const script = `/accounts/${t.accountId}/workers/scripts/${PREFIX}`;
  const deployments = await testOwnerJson(t, "GET", `${script}/deployments`);
  const deployment = deployments?.deployments?.[0];
  const version = deployment?.versions?.[0];
  insist(
    /^[a-f0-9-]{36}$/iu.test(deployment?.id ?? "") &&
      deployment.strategy === "percentage" &&
      deployment.versions.length === 1 &&
      /^[a-f0-9-]{36}$/iu.test(version?.version_id ?? "") &&
      version.percentage === 100,
    "test-owner Worker has no single active Version at 100 percent",
  );
  const versionId = version.version_id;
  const detail = await testOwnerJson(
    t,
    "GET",
    `${script}/versions/${encodeURIComponent(versionId)}`,
  );
  insist(
    detail?.id === versionId,
    "test-owner active Version identity changed",
  );
  const settings = await testOwnerJson(t, "GET", `${script}/settings`);
  const bindings = assertTestOwnerBindings(
    expectedBindings,
    settings?.bindings,
  );
  const content = await testOwnerRequest(
    t,
    "GET",
    `${script}/content/v2?version=${encodeURIComponent(versionId)}`,
  );
  let parts;
  try {
    parts = await content.formData();
  } catch {
    throw new Error("test-owner active Worker multipart response is malformed");
  }
  const modules = parts.getAll("worker.js");
  insist(
    [...parts.keys()].length === 1 &&
      modules.length === 1 &&
      modules[0]?.name === "worker.js" &&
      content.headers.get("cf-entrypoint") === "worker.js",
    "test-owner active Worker module response is malformed",
  );
  const digest = createHash("sha256")
    .update(Buffer.from(await modules[0].arrayBuffer()))
    .digest("hex");
  insist(
    digest === t.artifactSha256,
    "test-owner active Worker code differs from published artifact",
  );
  return { deploymentId: deployment.id, versionId, bindings };
}
async function testOwnerAuth(t) {
  const payload = testOwnerAuthPayload(process.env.TF_VAR_auth_password_hash);
  let before;
  let expectedBindings;
  return withTestOwnerAuthPreflight(
    async () => {
      const db = await schemaReady(t, true);
      expectedBindings = testOwnerStateBindings(t);
      insist(
        expectedBindings.find(
          (binding) => binding?.name === "AUTH_PASSWORD_HASH",
        )?.text !== payload.text,
        "test-owner password hash must differ from activated state",
      );
      assertTestOwnerDomainSnapshot(
        await domainsBy(t, "hostname", new URL(ORIGIN).hostname),
        await domainsBy(t, "service", PREFIX),
        t.zoneId,
      );
      const counts = await api(
        t,
        "POST",
        `/accounts/${t.accountId}/d1/database/${db}/query`,
        {
          sql: "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
        },
      );
      assertEmptyOwnerTables(counts);
      before = await activeTestOwnerWorker(t, expectedBindings);
    },
    async () => {
      const result = await testOwnerJson(
        t,
        "PUT",
        `/accounts/${t.accountId}/workers/scripts/${PREFIX}/secrets`,
        payload,
      );
      insist(
        result?.name === "AUTH_PASSWORD_HASH" && result?.type === "secret_text",
        "test-owner secret acknowledgement is malformed",
      );
    },
    async () => {
      const after = await activeTestOwnerWorker(t, expectedBindings);
      insist(
        after.versionId !== before.versionId &&
          after.bindings === before.bindings,
        "test-owner secret Version is not the sole active Deployment with unchanged bindings",
      );
      return { phase: "test-owner-auth", status: "ACTIVE_VERSION_READ_BACK" };
    },
  );
}
async function schemaReady(t, activated = false) {
  const db = databaseFromState(
    t,
    activated
      ? new Set([...RESOURCE_ADDRESSES, ...ACTIVATE_ADDRESSES])
      : RESOURCE_ADDRESSES,
  );
  const body = await api(
    t,
    "POST",
    `/accounts/${t.accountId}/d1/database/${db}/query`,
    { sql: "SELECT name FROM yurucommu_migrations ORDER BY id" },
  );
  assertSingleSuccessfulQuery(body);
  const rows = body.result?.[0]?.results;
  const expected = readdirSync(
    join(REPO, "node_modules/@takosjp/yurucommu-core/migrations"),
  )
    .filter((name) => /^\d{4}_[^/]+\.sql$/u.test(name))
    .sort();
  insist(
    expected.length === 35,
    "published Core package does not have exactly 35 migrations",
  );
  insist(
    Array.isArray(rows) &&
      JSON.stringify(rows.map((row) => row?.name).sort()) ===
        JSON.stringify(expected),
    "fresh D1 ledger differs from the exact published Core 35 migrations",
  );
  return db;
}
export function assertSingleSuccessfulQuery(body) {
  insist(
    hasNoApiErrors(body) &&
      Array.isArray(body?.result) &&
      body.result.length === 1 &&
      body.result[0]?.success === true &&
      hasNoApiErrors(body.result[0]) &&
      Array.isArray(body.result[0].results),
    "D1 ledger query did not return exactly one successful result",
  );
}
export function assertDomainChangeset(changeset) {
  const host = new URL(ORIGIN).hostname;
  insist(
    Array.isArray(changeset?.added) &&
      changeset.added.length === 1 &&
      changeset.added[0]?.hostname === host,
    "custom-domain changeset does not add only the exact hostname",
  );
  for (const key of ["updated", "removed", "conflicting"]) {
    insist(
      Array.isArray(changeset[key]),
      `custom-domain changeset lacks ${key} array; no overwrite/removal allowed`,
    );
    insist(
      changeset[key].length === 0,
      `custom-domain changeset has ${key} entries; no overwrite/removal allowed`,
    );
  }
}
async function attachDomain(t) {
  const dir = moduleDir(t);
  const addresses = invoke("tofu", ["state", "list", "-no-color"], dir)
    .trim()
    .split("\n")
    .filter(Boolean);
  const expected = new Set([...RESOURCE_ADDRESSES, ...ACTIVATE_ADDRESSES]);
  assertStateAddresses(addresses, expected, true);
  await exactDomainAbsent(t);
  const origin = { hostname: new URL(ORIGIN).hostname, zone_id: t.zoneId };
  const workerUrl = `/accounts/${t.accountId}/workers/scripts/${PREFIX}`;
  // Wrangler 4.103 uses this read-only changeset, but its non-TTY deploy path
  // sets both override flags true. Keep the exact no-overwrite request here.
  const change = await api(
    t,
    "POST",
    `${workerUrl}/domains/changeset?replace_state=true`,
    [origin],
  );
  assertDomainChangeset(change.result);
  await exactDomainAbsent(t);
  try {
    await api(t, "PUT", `${workerUrl}/domains/records`, {
      override_scope: true,
      override_existing_origin: false,
      override_existing_dns_record: false,
      origins: [origin],
    });
    const selected = await domainsBy(t, "hostname", origin.hostname);
    insist(
      selected.length === 1 &&
        selected[0]?.service === PREFIX &&
        selected[0]?.zone_id === t.zoneId,
      "domain write is indeterminate; inspect authoritative Worker domain before retry",
    );
    const publicResponse = await fetch(ORIGIN, {
      signal: AbortSignal.timeout(15000),
    });
    insist(
      publicResponse.ok,
      `public origin returned ${publicResponse.status} after attachment; inspect TLS/domain propagation before retry`,
    );
    return {
      phase: "domain",
      status: "ATTACHED_AND_PUBLIC",
      target: ORIGIN,
      worker: PREFIX,
    };
  } catch (error) {
    error.phase = "POST_DOMAIN_INDETERMINATE";
    throw error;
  }
}
export async function deployIntegration(args) {
  const phase = parseIntegrationArgs(args);
  const t = loadIntegrationTarget();
  process.umask(0o077);
  diagnosticsDir = join(t.stateDir, "diagnostics");
  if (!existsSync(diagnosticsDir)) mkdirSync(diagnosticsDir, { mode: 0o700 });
  privatePath(diagnosticsDir, "directory");
  sourceIsExact(t);
  if (phase === "preflight") {
    await noTakeover(t);
    return { phase, status: "READY", target: ORIGIN, releaseTag: TAG };
  }
  if (phase === "resources") {
    await noTakeover(t);
    return tofu(t, phase);
  }
  if (phase === "fresh-schema") {
    const db = databaseFromState(t, RESOURCE_ADDRESSES);
    const { applyFreshIntegrationSchema } =
      await import("./deploy-integration-schema.mjs");
    try {
      return await applyFreshIntegrationSchema({
        accountId: t.accountId,
        databaseId: db,
        token: process.env.CLOUDFLARE_API_TOKEN,
        repo: REPO,
        diagnosticsDir,
      });
    } catch (error) {
      error.phase = "POST_SCHEMA_INDETERMINATE";
      throw error;
    }
  }
  if (phase === "recover-prefix32") {
    const db = databaseFromState(t, RESOURCE_ADDRESSES);
    const { recoverPrefix32IntegrationSchema } =
      await import("./deploy-integration-schema.mjs");
    return recoverPrefix32IntegrationSchema({
      accountId: t.accountId,
      databaseId: db,
      token: process.env.CLOUDFLARE_API_TOKEN,
      repo: REPO,
      diagnosticsDir,
    });
  }
  if (phase === "activate") {
    await schemaReady(t);
    assertWorkerScriptAbsent(
      await api(t, "GET", `/accounts/${t.accountId}/workers/scripts`),
    );
    return tofu(t, phase);
  }
  if (phase === "test-owner-auth") return testOwnerAuth(t);
  await schemaReady(t, true);
  return attachDomain(t);
}
