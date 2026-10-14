import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEDIA_DELETION_SCHEMA_QUERY,
  validateMediaDeletionQueryResults,
} from "./media-deletion-schema.mjs";
import {
  CORE_UPGRADE_MIGRATIONS,
  CORE_UPGRADE_SCHEMA_QUERY,
  validateCoreUpgradeQueryResults,
} from "./core-upgrade-schema.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = /^[0-9a-f]{40}$/u;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TARGET_KIND = "yurucommu.worker-deploy-target@v1";
const WORKER = "yurucommu";
const PUBLIC_ORIGIN = "https://test.yurucommu.com";
const INTEGRATION_WORKER = "yurucommu-ga-20261012-0938";
const INTEGRATION_ORIGIN = "https://ga-commu-20261012.yurucommu.com";
const BUNDLE = "dist/yurucommu-worker.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const VERSION_CONTENT_TIMEOUT_MS = 15_000;
const VERSION_CONTENT_OVERHEAD = 64 * 1024;
const DOMAIN_PAGE_SIZE = 100;
const MAX_DOMAIN_PAGES = 8;
const CORE_SCHEMA_TERM_SEPARATOR = "\nUNION ALL\n";
const CORE_SCHEMA_TERM_COUNT = 25;
const CORE_SCHEMA_TERMS_PER_READ = 5;
const SESSION_HASH_SALT_BINDING = "YURUCOMMU_SESSION_HASH_SALT";
const SESSION_HASH_SALT_REQUIRED_ERROR =
  "active predecessor Version must expose exactly one YURUCOMMU_SESSION_HASH_SALT secret_text binding; stop and have the operator review existing secret custody before retrying. If no salt was previously configured, adding the first one changes session hashes and existing users will need to log in again.";
const AUTH_HASH_BINDING = "AUTH_PASSWORD_HASH";

function coreSchemaReadQueries() {
  const terms = CORE_UPGRADE_SCHEMA_QUERY.split(CORE_SCHEMA_TERM_SEPARATOR);
  if (
    terms.length !== CORE_SCHEMA_TERM_COUNT ||
    terms.some((term) => !/^SELECT\s/iu.test(term)) ||
    terms.join(CORE_SCHEMA_TERM_SEPARATOR) !== CORE_UPGRADE_SCHEMA_QUERY
  ) {
    throw new Error("canonical Core schema preflight query terms changed");
  }
  const queries = [];
  for (
    let index = 0;
    index < terms.length;
    index += CORE_SCHEMA_TERMS_PER_READ
  ) {
    queries.push(
      terms
        .slice(index, index + CORE_SCHEMA_TERMS_PER_READ)
        .join(CORE_SCHEMA_TERM_SEPARATOR),
    );
  }
  return queries;
}

const asText = (value) =>
  typeof value === "string" ? value : Buffer.from(value ?? "").toString("utf8");

function outputOf(result) {
  if (typeof result === "string" || result instanceof Uint8Array) {
    return { exitCode: 0, stdout: asText(result), stderr: "" };
  }
  const exitCode = result?.exitCode ?? result?.status;
  return {
    exitCode: Number.isInteger(exitCode) ? exitCode : 1,
    stdout: asText(result?.stdout),
    stderr: asText(result?.stderr),
  };
}

function defaultGit(args, { cwd = REPO } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: subprocessBaseEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return result;
}

export class YurucommuWorkerReleaseFailure extends Error {
  constructor(message, { phase, evidence = {}, provider = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "YurucommuWorkerReleaseFailure";
    this.phase = phase;
    this.evidence = evidence;
    this.provider = provider;
  }
}

class ProviderFailure extends Error {
  constructor(message, { stdout = "", stderr = "", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProviderFailure";
    this.provider = { stdout: asText(stdout), stderr: asText(stderr) };
  }
}

async function gitResult(git, args, repo) {
  return outputOf(await git(args, { cwd: repo }));
}

async function checkedGit(git, args, repo, label) {
  const result = await gitResult(git, args, repo);
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${result.exitCode})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
    );
  }
  return result.stdout;
}

async function qualifyProductionSource({ repo, commit, git }) {
  if (!COMMIT.test(commit)) {
    throw new Error("--commit must be one exact lowercase 40-hex commit");
  }
  const head = (
    await checkedGit(git, ["rev-parse", "HEAD"], repo, "git rev-parse HEAD")
  ).trim();
  if (head !== commit) {
    throw new Error(
      `selected commit ${commit} does not equal worktree HEAD ${head}`,
    );
  }
  const dirty = await checkedGit(
    git,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    repo,
    "git status",
  );
  if (dirty)
    throw new Error("production publication requires a clean worktree");
  const branch = (
    await checkedGit(
      git,
      ["branch", "--show-current"],
      repo,
      "git branch --show-current",
    )
  ).trim();
  await checkedGit(
    git,
    ["fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main"],
    repo,
    "fresh origin/main",
  );
  const remote = (
    await checkedGit(
      git,
      ["rev-parse", "refs/remotes/origin/main"],
      repo,
      "origin/main commit",
    )
  ).trim();
  if (branch === "main") {
    if (head !== remote) {
      throw new Error(
        `production main ${head} does not equal freshly fetched origin/main ${remote}`,
      );
    }
  } else {
    const ancestor = await gitResult(
      git,
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      repo,
    );
    if (ancestor.exitCode !== 0) {
      throw new Error(
        `selected production commit ${head} is not in freshly fetched origin/main`,
      );
    }
  }
  return {
    branch: branch || "detached",
    commit: head,
    remoteRef: "origin/main",
  };
}

function exactKeys(value, required) {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `deploy target keys differ: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function parseJsonc(source, label) {
  try {
    return Bun.JSONC.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON/JSONC`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function pathWithin(base, candidate) {
  const relativePath = relative(base, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function gitContext(start) {
  let cursor = realpathSync(resolve(start));
  while (true) {
    const marker = join(cursor, ".git");
    if (existsSync(marker)) {
      const markerStatus = lstatSync(marker);
      if (markerStatus.isDirectory()) {
        return { root: cursor, commonDir: realpathSync(marker) };
      }
      if (markerStatus.isFile()) {
        const contents = readFileSync(marker, "utf8");
        const match = /^gitdir:\s*(.+?)\s*$/mu.exec(contents);
        if (match) {
          const gitDir = resolve(cursor, match[1]);
          const commondirPath = join(gitDir, "commondir");
          const commonDir = existsSync(commondirPath)
            ? resolve(gitDir, readFileSync(commondirPath, "utf8").trim())
            : gitDir;
          return {
            root: cursor,
            commonDir: existsSync(commonDir)
              ? realpathSync(commonDir)
              : resolve(commonDir),
          };
        }
      }
      return { root: cursor, commonDir: null };
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function assertOutsideDiscoveredGitRepository(filePath, label) {
  let cursor = dirname(filePath);
  while (true) {
    if (existsSync(join(cursor, ".git"))) {
      throw new Error(
        `${label} must be outside any Git repository or worktree`,
      );
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function assertPrivateFile(path, label, { repo } = {}) {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be one absolute path`);
  }
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`${label} must be one link-free regular file`);
  }
  if ((status.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must have mode 0600`);
  }
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${label} parent directory must have mode 0700`);
  }
  const filePath = realpathSync(path);
  if (repo) {
    const repositoryPath = realpathSync(resolve(repo));
    const context = gitContext(repo);
    const boundaries = [repositoryPath];
    if (context?.root) boundaries.push(realpathSync(context.root));
    if (context?.commonDir) boundaries.push(context.commonDir);
    if (boundaries.some((boundary) => pathWithin(boundary, filePath))) {
      throw new Error(`${label} must be outside the repository`);
    }
  }
  assertOutsideDiscoveredGitRepository(filePath, label);
}

const CODE_ONLY_CONFIG_KEYS = new Set([
  "$schema",
  "name",
  "account_id",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "limits",
  "usage_model",
]);

function validateWorkerConfig(config, target) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("selected Wrangler config must be an object");
  }
  const unsupported = Object.keys(config).filter(
    (key) => !CODE_ONLY_CONFIG_KEYS.has(key),
  );
  if (unsupported.length > 0) {
    if (unsupported.includes("env")) {
      throw new Error(
        "selected Wrangler config includes environment indirection; the production target must be fully realized",
      );
    }
    if (unsupported.includes("migrations")) {
      throw new Error(
        "selected Wrangler config includes Durable Object migrations; schema/data changes require a separate surface",
      );
    }
    const externalArtifactKey = unsupported.find((key) =>
      [
        "assets",
        "build",
        "data_blobs",
        "site",
        "text_blobs",
        "wasm_modules",
      ].includes(key),
    );
    if (externalArtifactKey) {
      throw new Error(
        `selected Wrangler config includes external artifact input ${externalArtifactKey}; this surface publishes only the digest-bound Worker bundle`,
      );
    }
    throw new Error(
      `selected Wrangler config has authority fields outside the code-only surface: ${unsupported.join(", ")}`,
    );
  }
  if (config.name !== target.workerName) {
    throw new Error("selected Wrangler config names a different Worker script");
  }
  if (
    config.account_id !== undefined &&
    config.account_id !== target.accountId
  ) {
    throw new Error("selected Wrangler config names a different account");
  }
  if (config.main !== `./${BUNDLE}` && config.main !== BUNDLE) {
    throw new Error(`selected Wrangler config main must identify ${BUNDLE}`);
  }
  if (
    typeof config.compatibility_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(config.compatibility_date)
  ) {
    throw new Error(
      "selected Wrangler config must pin one compatibility_date for the code-only upload",
    );
  }
  if (
    config.compatibility_flags !== undefined &&
    (!Array.isArray(config.compatibility_flags) ||
      config.compatibility_flags.some((flag) => typeof flag !== "string"))
  ) {
    throw new Error(
      "selected Wrangler config compatibility_flags must be an array of strings",
    );
  }
  if (
    config.limits !== undefined &&
    (typeof config.limits !== "object" ||
      config.limits === null ||
      Array.isArray(config.limits))
  ) {
    throw new Error("selected Wrangler config limits must be an object");
  }
  if (
    config.usage_model !== undefined &&
    !["standard", "bundled", "unbound"].includes(config.usage_model)
  ) {
    throw new Error("selected Wrangler config usage_model is invalid");
  }
  return config;
}

function validateTarget(value, environment, { repo } = {}) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("deploy target descriptor must be an object");
  }
  if (value.environment !== environment) {
    throw new Error("deploy target environment does not match the selection");
  }
  exactKeys(value, [
    "kind",
    "environment",
    "accountId",
    "workerName",
    "publicOrigin",
    "route",
    "config",
    ...(environment === "integration" ? ["resources"] : []),
  ]);
  if (value.kind !== TARGET_KIND) {
    throw new Error(`deploy target kind must be ${TARGET_KIND}`);
  }
  if (
    typeof value.accountId !== "string" ||
    !ACCOUNT_ID.test(value.accountId)
  ) {
    throw new Error(
      "deploy target accountId must be exactly 32 lowercase hex characters",
    );
  }
  const expectedWorker =
    environment === "integration" ? INTEGRATION_WORKER : WORKER;
  const expectedOrigin =
    environment === "integration" ? INTEGRATION_ORIGIN : PUBLIC_ORIGIN;
  if (value.workerName !== expectedWorker) {
    throw new Error(`deploy target workerName must be ${expectedWorker}`);
  }
  if (value.publicOrigin !== expectedOrigin) {
    throw new Error(`deploy target publicOrigin must be ${expectedOrigin}`);
  }
  if (environment === "integration") {
    const resources = value.resources;
    if (
      typeof resources !== "object" ||
      resources === null ||
      Array.isArray(resources)
    ) {
      throw new Error("integration deploy target resources must be an object");
    }
    exactKeys(resources, [
      "databaseId",
      "kvNamespaceId",
      "mediaBucketName",
      "deliveryQueueName",
      "deliveryDlqName",
    ]);
    if (
      typeof resources.databaseId !== "string" ||
      !UUID.test(resources.databaseId) ||
      typeof resources.kvNamespaceId !== "string" ||
      !ACCOUNT_ID.test(resources.kvNamespaceId) ||
      resources.mediaBucketName !== `${INTEGRATION_WORKER}-media` ||
      resources.deliveryQueueName !== `${INTEGRATION_WORKER}-delivery` ||
      resources.deliveryDlqName !== `${INTEGRATION_WORKER}-delivery-dlq`
    ) {
      throw new Error(
        "integration deploy target resources are not the pinned isolated resources",
      );
    }
  }
  if (
    typeof value.route !== "object" ||
    value.route === null ||
    Array.isArray(value.route)
  ) {
    throw new Error("deploy target route must be an object");
  }
  exactKeys(value.route, ["kind", "hostname"]);
  if (
    value.route.kind !== "custom-domain" ||
    value.route.hostname !== new URL(expectedOrigin).hostname
  ) {
    throw new Error(
      `deploy target route must be the ${new URL(expectedOrigin).hostname} custom domain`,
    );
  }
  if (
    typeof value.config !== "object" ||
    value.config === null ||
    Array.isArray(value.config)
  ) {
    throw new Error("deploy target config must be an object");
  }
  exactKeys(value.config, ["path", "sha256"]);
  if (typeof value.config.path !== "string" || !isAbsolute(value.config.path)) {
    throw new Error("deploy target config path must be absolute");
  }
  if (
    typeof value.config.sha256 !== "string" ||
    !SHA256.test(value.config.sha256)
  ) {
    throw new Error("deploy target config sha256 is invalid");
  }
  assertPrivateFile(value.config.path, "deploy target config", { repo });
  const bytes = readFileSync(value.config.path);
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== value.config.sha256) {
    throw new Error(
      `deploy config digest ${actual} does not equal selected ${value.config.sha256}`,
    );
  }
  const config = validateWorkerConfig(
    parseJsonc(bytes.toString("utf8"), "selected Wrangler config"),
    value,
  );
  return { ...value, configBytes: bytes, configValues: config };
}

function rawTargetDescriptor(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !(value.configBytes instanceof Uint8Array) ||
    typeof value.configValues !== "object" ||
    value.configValues === null ||
    Array.isArray(value.configValues)
  ) {
    return value;
  }
  const {
    configBytes: _configBytes,
    configValues: _configValues,
    ...raw
  } = value;
  return raw;
}

export function loadYurucommuWorkerTarget({ path, environment, repo } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("YURUCOMMU_WORKER_DEPLOY_TARGET must be one absolute path");
  }
  assertPrivateFile(path, "YURUCOMMU_WORKER_DEPLOY_TARGET", { repo });
  const source = readFileSync(path, "utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error("Worker deploy target descriptor is not valid JSON", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return rawTargetDescriptor(validateTarget(value, environment, { repo }));
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function deployment(value, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    typeof value.created_on !== "string" ||
    !Number.isFinite(Date.parse(value.created_on)) ||
    value.strategy !== "percentage" ||
    !Array.isArray(value.versions) ||
    value.versions.length !== 1
  ) {
    throw new Error(`${label} is not one canonical Cloudflare Deployment`);
  }
  const selected = value.versions[0];
  if (
    typeof selected !== "object" ||
    selected === null ||
    Array.isArray(selected) ||
    typeof selected.version_id !== "string" ||
    !UUID.test(selected.version_id) ||
    selected.percentage !== 100
  ) {
    throw new Error(`${label} must serve exactly one Version at 100 percent`);
  }
  const message =
    typeof value.annotations === "object" &&
    value.annotations !== null &&
    !Array.isArray(value.annotations) &&
    typeof value.annotations["workers/message"] === "string"
      ? value.annotations["workers/message"]
      : null;
  return {
    id: value.id,
    versionId: selected.version_id,
    createdOn: value.created_on,
    message,
  };
}

function assertSameDeployment(expected, actual, label) {
  if (
    actual.id !== expected.id ||
    actual.versionId !== expected.versionId ||
    actual.createdOn !== expected.createdOn
  ) {
    throw new Error(`${label} changed concurrently`);
  }
}

function assertDomains(entries, target, label) {
  if (!Array.isArray(entries)) {
    throw new Error(`${label} returned no canonical custom-domain inventory`);
  }
  const expected = [target.route.hostname];
  const owners = new Map();
  const owned = [];
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry.hostname !== "string" ||
      typeof entry.service !== "string" ||
      (entry.environment !== undefined && typeof entry.environment !== "string")
    ) {
      throw new Error(`${label} contains a malformed custom-domain record`);
    }
    if (
      entry.hostname !== target.route.hostname ||
      entry.service !== target.workerName ||
      // Cloudflare records custom domains on separately named Workers as
      // "production" even when our deployment selection is "integration".
      entry.environment !== "production"
    ) {
      throw new Error(
        `${label} returned a record outside the exact hostname, service, and environment filters`,
      );
    }
    const values = owners.get(entry.hostname) ?? [];
    values.push(entry.service);
    owners.set(entry.hostname, values);
    if (entry.service === target.workerName) owned.push(entry.hostname);
  }
  const routeOwners = owners.get(target.route.hostname) ?? [];
  if (
    routeOwners.length !== 1 ||
    routeOwners[0] !== target.workerName ||
    JSON.stringify([...new Set(owned)].sort()) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `${label} does not bind exactly ${target.route.hostname} to ${target.workerName}`,
    );
  }
}

function canonicalDomainValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => canonicalDomainValue(entry))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalDomainValue(entry)]),
  );
}

function canonicalDomainSnapshot(entries) {
  return canonicalDomainValue(entries);
}

function acknowledged(value, field, label, workerName) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value[field] !== "string" ||
    !UUID.test(value[field]) ||
    value.workerName !== workerName
  ) {
    throw new Error(
      `${label} did not acknowledge the selected Worker identity`,
    );
  }
  return value[field];
}

function assertVersionIdentity(value, versionId, message, expectedScriptEtag) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.id !== versionId ||
    typeof value.annotations !== "object" ||
    value.annotations === null ||
    Array.isArray(value.annotations) ||
    value.annotations["workers/message"] !== message
  ) {
    throw new Error(
      `Worker Version ${versionId} does not identify the selected source, bundle, and config`,
    );
  }
  const actualScriptEtag = value.resources?.script?.etag;
  if (
    typeof actualScriptEtag !== "string" ||
    actualScriptEtag.length === 0 ||
    actualScriptEtag.length > 256 ||
    (expectedScriptEtag !== undefined &&
      actualScriptEtag !== expectedScriptEtag)
  ) {
    throw new Error(
      `Worker Version ${versionId} lacks a stable bounded opaque script etag (resources.script.etag)`,
    );
  }
  return actualScriptEtag;
}

function assertVersionCodeProof(
  proof,
  versionId,
  bundleDigest,
  bundleByteLength,
) {
  if (
    typeof proof !== "object" ||
    proof === null ||
    Array.isArray(proof) ||
    Object.keys(proof).sort().join(",") !== "kind,sha256,size,versionId" ||
    proof.kind !== "yurucommu.worker-version-code@v1" ||
    proof.versionId !== versionId ||
    !SHA256.test(proof.sha256) ||
    !Number.isSafeInteger(proof.size) ||
    proof.size < 1 ||
    proof.sha256 !== bundleDigest ||
    proof.size !== bundleByteLength
  ) {
    throw new Error(
      `Worker Version ${versionId} code readback did not prove the selected bundle bytes`,
    );
  }
}

const VOLATILE_VERSION_KEYS = new Set([
  "annotations",
  "created_on",
  "hasPreview",
  "metadata",
  "modified_on",
  "number",
  "source",
  "startup_time_ms",
]);

function canonicalVersionClosure(value, path = []) {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalVersionClosure(entry, [...path, index]),
    );
  }
  if (typeof value !== "object" || value === null) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (path.length === 0 && (key === "id" || VOLATILE_VERSION_KEYS.has(key))) {
      continue;
    }
    if (key === "annotations") continue;
    if (path[0] === "resources" && path[1] === "script") continue;
    const childPath = [...path, key];
    if (path.length === 0 && key === "resources") {
      const resources = {};
      for (const resourceKey of Object.keys(value[key]).sort()) {
        if (resourceKey === "script") continue;
        resources[resourceKey] = canonicalVersionClosure(
          value[key][resourceKey],
          [...childPath, resourceKey],
        );
      }
      result[key] = resources;
      continue;
    }
    result[key] = canonicalVersionClosure(value[key], childPath);
  }
  return result;
}

function closureHasAuthoritativeFields(closure) {
  if (typeof closure !== "object" || closure === null) return false;
  return Object.keys(closure).length > 0;
}

function firstClosureDifference(left, right, path = []) {
  if (Object.is(left, right)) return null;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path;
    if (left.length !== right.length) return [...path, "length"];
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstClosureDifference(left[index], right[index], [
        ...path,
        String(index),
      ]);
      if (difference) return difference;
    }
    return null;
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return path;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort()) {
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
      return [...path, key];
    }
    const difference = firstClosureDifference(left[key], right[key], [
      ...path,
      key,
    ]);
    if (difference) return difference;
  }
  return null;
}

function assertVersionClosure(value, label) {
  const closure = canonicalVersionClosure(value);
  if (!closureHasAuthoritativeFields(closure)) {
    throw new Error(
      `${label} did not expose an authoritative non-code Version closure (bindings, compatibility/runtime settings, limits, vars, or lifecycle fields)`,
    );
  }
  return closure;
}

function activeDatabaseId(version) {
  const bindings = versionRuntime(version).bindings;
  let databaseBindings;
  if (Array.isArray(bindings)) {
    databaseBindings = bindings.filter(
      (binding) =>
        typeof binding === "object" &&
        binding !== null &&
        !Array.isArray(binding) &&
        binding.name === "DB",
    );
  } else if (typeof bindings === "object" && bindings !== null) {
    databaseBindings = Object.hasOwn(bindings, "DB") ? [bindings.DB] : [];
  } else {
    databaseBindings = [];
  }
  if (databaseBindings.length !== 1) {
    throw new Error(
      "active predecessor Version must expose exactly one DB binding",
    );
  }
  const database = databaseBindings[0];
  if (
    typeof database !== "object" ||
    database === null ||
    Array.isArray(database) ||
    database.type !== "d1" ||
    typeof database.id !== "string" ||
    !UUID.test(database.id)
  ) {
    throw new Error(
      "active predecessor Version DB binding must be one D1 binding with a UUID database id",
    );
  }
  return database.id;
}

function assertActiveSessionHashSaltBinding(version) {
  const bindings = versionRuntime(version).bindings;
  let saltBindings;
  if (Array.isArray(bindings)) {
    if (
      bindings.some(
        (binding) =>
          typeof binding !== "object" ||
          binding === null ||
          Array.isArray(binding) ||
          typeof binding.name !== "string" ||
          binding.name.length === 0,
      )
    ) {
      throw new Error(SESSION_HASH_SALT_REQUIRED_ERROR);
    }
    saltBindings = bindings.filter(
      (binding) => binding.name === SESSION_HASH_SALT_BINDING,
    );
  } else if (typeof bindings === "object" && bindings !== null) {
    if (!Object.hasOwn(bindings, SESSION_HASH_SALT_BINDING)) {
      throw new Error(SESSION_HASH_SALT_REQUIRED_ERROR);
    }
    const salt = bindings[SESSION_HASH_SALT_BINDING];
    if (
      typeof salt !== "object" ||
      salt === null ||
      Array.isArray(salt) ||
      (salt.name !== undefined && salt.name !== SESSION_HASH_SALT_BINDING)
    ) {
      throw new Error(SESSION_HASH_SALT_REQUIRED_ERROR);
    }
    saltBindings = [{ name: SESSION_HASH_SALT_BINDING, type: salt.type }];
  } else {
    throw new Error(SESSION_HASH_SALT_REQUIRED_ERROR);
  }

  if (
    saltBindings.length !== 1 ||
    saltBindings[0]?.name !== SESSION_HASH_SALT_BINDING ||
    saltBindings[0]?.type !== "secret_text"
  ) {
    throw new Error(SESSION_HASH_SALT_REQUIRED_ERROR);
  }
}

function assertIntegrationAppUrl(version, origin) {
  const bindings = versionRuntime(version).bindings;
  const candidates = Array.isArray(bindings)
    ? bindings.filter((binding) => binding?.name === "APP_URL")
    : typeof bindings === "object" &&
        bindings !== null &&
        Object.hasOwn(bindings, "APP_URL")
      ? [bindings.APP_URL]
      : [];
  if (
    candidates.length !== 1 ||
    candidates[0]?.type !== "plain_text" ||
    candidates[0]?.text !== origin
  ) {
    throw new Error(
      "isolated integration predecessor must expose exactly one plain_text APP_URL equal to its pinned origin before code upload",
    );
  }
}

function assertIntegrationResources(version, target) {
  const bindings = versionRuntime(version).bindings;
  let entries;
  if (Array.isArray(bindings)) {
    entries = bindings.map((binding) => [binding?.name, binding]);
  } else if (
    typeof bindings === "object" &&
    bindings !== null &&
    !Array.isArray(bindings)
  ) {
    entries = Object.entries(bindings);
  } else {
    throw new Error(
      "isolated integration Version has no authoritative resource bindings",
    );
  }
  const byName = new Map();
  for (const [name, binding] of entries) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      typeof binding !== "object" ||
      binding === null ||
      Array.isArray(binding) ||
      (binding.name !== undefined && binding.name !== name) ||
      byName.has(name)
    ) {
      throw new Error(
        "isolated integration Version bindings are malformed or duplicated",
      );
    }
    byName.set(name, binding);
  }
  const expected = [
    ["DB", "d1", ["id", "database_id"], target.resources.databaseId],
    [
      "KV",
      "kv_namespace",
      ["id", "namespace_id"],
      target.resources.kvNamespaceId,
    ],
    ["MEDIA", "r2_bucket", ["bucket_name"], target.resources.mediaBucketName],
    [
      "DELIVERY_QUEUE",
      "queue",
      ["queue_name"],
      target.resources.deliveryQueueName,
    ],
    ["DELIVERY_DLQ", "queue", ["queue_name"], target.resources.deliveryDlqName],
  ];
  const targetFields = [
    "id",
    "database_id",
    "namespace_id",
    "bucket_name",
    "queue_name",
  ];
  for (const [name, type, allowedFields, value] of expected) {
    const binding = byName.get(name);
    const present = targetFields.filter((field) =>
      binding === undefined ? false : Object.hasOwn(binding, field),
    );
    if (
      binding?.type !== type ||
      present.length < 1 ||
      (name !== "DB" && present.length !== 1) ||
      present.some(
        (field) =>
          !allowedFields.includes(field) ||
          typeof binding[field] !== "string" ||
          binding[field] !== value,
      )
    ) {
      throw new Error(
        `isolated integration ${name} binding differs from the private target`,
      );
    }
  }
  for (const [name, binding] of byName) {
    if (
      !["DB", "KV", "MEDIA", "DELIVERY_QUEUE", "DELIVERY_DLQ"].includes(name) &&
      (!["plain_text", "secret_text", "json"].includes(binding.type) ||
        targetFields.some((field) => binding[field] !== undefined))
    ) {
      throw new Error(
        `isolated integration ${name} has an unapproved binding type`,
      );
    }
  }
  return target.resources.databaseId;
}

function assertIntegrationAuthBinding(version) {
  const bindings = versionRuntime(version).bindings;
  const candidates = Array.isArray(bindings)
    ? bindings.filter((binding) => binding?.name === AUTH_HASH_BINDING)
    : typeof bindings === "object" &&
        bindings !== null &&
        Object.hasOwn(bindings, AUTH_HASH_BINDING)
      ? [bindings[AUTH_HASH_BINDING]]
      : [];
  if (candidates.length !== 1 || candidates[0]?.type !== "secret_text") {
    throw new Error(
      "isolated integration predecessor must expose exactly one AUTH_PASSWORD_HASH secret_text binding",
    );
  }
}

function versionRuntime(value) {
  const resources =
    typeof value?.resources === "object" && value.resources !== null
      ? value.resources
      : {};
  const runtime =
    typeof resources.script_runtime === "object" &&
    resources.script_runtime !== null
      ? resources.script_runtime
      : typeof value?.script_runtime === "object" &&
          value.script_runtime !== null
        ? value.script_runtime
        : typeof value?.runtime === "object" && value.runtime !== null
          ? value.runtime
          : (value ?? {});
  return {
    bindings: resources.bindings ?? value?.bindings,
    vars: resources.vars ?? value?.vars,
    compatibility_date: runtime.compatibility_date ?? value?.compatibility_date,
    compatibility_flags:
      runtime.compatibility_flags ?? value?.compatibility_flags,
    limits: runtime.limits ?? value?.limits,
    usage_model: runtime.usage_model ?? value?.usage_model,
  };
}

function normalizedRuntimeValue(field, value) {
  if (value === undefined) return undefined;
  if (field === "compatibility_date" && typeof value === "string") {
    return value.slice(0, 10);
  }
  if (field === "compatibility_flags" && Array.isArray(value)) {
    return [...value].sort();
  }
  return value;
}

function assertConfigMatchesVersion(config, version, label) {
  const runtime = versionRuntime(version);
  for (const field of [
    "compatibility_date",
    "compatibility_flags",
    "limits",
    "usage_model",
  ]) {
    if (config[field] === undefined) continue;
    const expected = normalizedRuntimeValue(field, config[field]);
    const actual = normalizedRuntimeValue(field, runtime[field]);
    if (
      actual === undefined ||
      JSON.stringify(actual) !== JSON.stringify(expected)
    ) {
      throw new Error(
        `${label} ${field} differs from the authoritative active Version`,
      );
    }
  }
}

export function assertCodeOnlyVersion(previous, candidate) {
  const previousClosure = assertVersionClosure(
    previous,
    "active predecessor Version",
  );
  const candidateClosure = assertVersionClosure(candidate, "uploaded Version");
  const difference = firstClosureDifference(previousClosure, candidateClosure);
  if (difference) {
    throw new Error(
      `uploaded Version changes the authoritative non-code closure at ${difference.join(".")}; bindings, compatibility/runtime settings, limits, vars, and lifecycle fields are not code-only`,
    );
  }
  return candidateClosure;
}

function commandOutput(result) {
  return {
    exitCode: result?.exitCode ?? result?.status,
    stdout: asText(result?.stdout),
    stderr: asText(result?.stderr),
  };
}

function defaultRun(command, args, { cwd = REPO, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

async function invoke(run, command, args, options) {
  let result;
  try {
    result = await run(command, args, options);
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure(
      error instanceof Error
        ? error.message
        : `${command} did not complete cleanly`,
      {
        stdout: error?.stdout,
        stderr: error?.stderr,
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
  const output = commandOutput(result);
  if (output.exitCode !== undefined && output.exitCode !== 0) {
    throw new ProviderFailure(
      `${command} ${args.slice(0, 2).join(" ")} exited ${output.exitCode}`,
      output,
    );
  }
  return output;
}

function subprocessBaseEnv() {
  const result = {};
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TERM",
    "TMPDIR",
    "TZ",
  ]) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
}

export function ownerGateEnvironment() {
  return {
    ...subprocessBaseEnv(),
    CI: "1",
    FORCE_COLOR: "0",
    NODE_ENV: "test",
    NO_COLOR: "1",
  };
}

function defaultCheck({ repo }) {
  execFileSync("bun", ["run", "check"], {
    cwd: repo,
    env: ownerGateEnvironment(),
    stdio: "inherit",
  });
}

async function inTemporaryDirectory(prefix, callback) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writePrivate(path, value) {
  writeFileSync(path, value, { mode: 0o600, flag: "wx" });
}

function cloudflareApiError(message, output = {}, secrets = []) {
  const safeText = (value) =>
    redactProviderText(value, secrets).slice(0, 4_000);
  return new ProviderFailure(safeText(message), {
    ...output,
    stdout: safeText(output.stdout ?? ""),
    stderr: safeText(output.stderr ?? ""),
    cause: redactProviderCause(output.cause, safeText),
  });
}

function redactProviderText(value, secrets) {
  let text = asText(value);
  const candidates = secrets
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])
    .filter((candidate) => candidate.length > 0);
  for (const candidate of [...new Set(candidates)].sort(
    (left, right) => right.length - left.length,
  )) {
    text = text.replaceAll(candidate, "[REDACTED]");
  }
  return text;
}

function redactProviderCause(cause, safeText, depth = 0) {
  if (!(cause instanceof Error) || depth >= 5) return undefined;
  const safeCause = new Error(safeText(cause.message));
  safeCause.name = safeText(cause.name);
  safeCause.cause = redactProviderCause(cause.cause, safeText, depth + 1);
  return safeCause;
}

function bindingNamesForInheritance(previousVersion) {
  const versionId = previousVersion?.id;
  if (typeof versionId !== "string" || !UUID.test(versionId)) {
    throw new Error(
      "active predecessor Version id is required to pin inherited bindings",
    );
  }
  const bindings = versionRuntime(previousVersion ?? {}).bindings;
  if (Array.isArray(bindings)) {
    if (
      bindings.some(
        (binding) =>
          typeof binding !== "object" ||
          binding === null ||
          typeof binding.name !== "string" ||
          binding.name.length === 0,
      )
    ) {
      throw new Error(
        "active predecessor Version exposes a malformed binding name",
      );
    }
    return bindings.map((binding) => ({
      name: binding.name,
      type: "inherit",
      version_id: "latest",
    }));
  }
  if (typeof bindings === "object" && bindings !== null) {
    return Object.keys(bindings)
      .sort()
      .map((name) => ({ name, type: "inherit", version_id: "latest" }));
  }
  return [];
}

export function createCloudflareWorkerProvider({
  repo = REPO,
  target,
  token = process.env.CLOUDFLARE_API_TOKEN,
  smokePassword = process.env.YURUCOMMU_E2E_PASSWORD,
  fetcher = globalThis.fetch,
  runSmoke = defaultRun,
  createAuthLoginTransport,
} = {}) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN is required before provider access");
  }
  if (typeof smokePassword !== "string" || !smokePassword) {
    throw new Error(
      "YURUCOMMU_E2E_PASSWORD is required before provider access",
    );
  }
  const selectedTarget = validateTarget(
    rawTargetDescriptor(target),
    target?.environment,
    { repo },
  );
  if (!["production", "integration"].includes(selectedTarget.environment)) {
    throw new Error("Worker provider requires an exact deployment environment");
  }
  const account = encodeURIComponent(selectedTarget.accountId);
  const worker = encodeURIComponent(selectedTarget.workerName);
  const providerError = (message, output = {}) =>
    cloudflareApiError(message, output, [token, smokePassword]);

  async function request(path, { method = "GET", body, headers = {} } = {}) {
    let response;
    try {
      response = await fetcher(`${CLOUDFLARE_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        cache: "no-store",
        redirect: "error",
      });
    } catch (error) {
      throw providerError(
        error instanceof Error
          ? `Cloudflare readback failed: ${error.message}`
          : "Cloudflare readback failed",
        { cause: error instanceof Error ? error : undefined },
      );
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw providerError(
        `Cloudflare readback response body could not be read: ${error instanceof Error ? error.message : "unknown body-read error"}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    let responseBody;
    try {
      responseBody = JSON.parse(text);
    } catch (error) {
      throw providerError(
        `Cloudflare readback returned non-JSON HTTP ${response.status}`,
        {
          stderr: text,
          cause: error instanceof Error ? error : undefined,
        },
      );
    }
    if (!response.ok || responseBody?.success !== true) {
      throw providerError(
        `Cloudflare readback returned HTTP ${response.status}`,
        { stderr: text },
      );
    }
    return responseBody;
  }

  async function assertVersionContent({
    versionId,
    bundleDigest,
    bundleByteLength,
  }) {
    const hasExpectedBundle =
      bundleDigest !== undefined || bundleByteLength !== undefined;
    if (
      typeof versionId !== "string" ||
      !UUID.test(versionId) ||
      (hasExpectedBundle &&
        (typeof bundleDigest !== "string" ||
          !SHA256.test(bundleDigest) ||
          !Number.isSafeInteger(bundleByteLength) ||
          bundleByteLength < 1 ||
          bundleByteLength >
            Number.MAX_SAFE_INTEGER - VERSION_CONTENT_OVERHEAD))
    ) {
      throw new Error("invalid Worker Version code readback input");
    }
    const path = `/accounts/${account}/workers/scripts/${worker}/content/v2?version=${versionId}`;
    const maximumBytes = hasExpectedBundle
      ? bundleByteLength + VERSION_CONTENT_OVERHEAD
      : 20 * 1024 * 1024;
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(providerError("Worker Version content readback timed out"));
      }, VERSION_CONTENT_TIMEOUT_MS);
    });
    const read = async () => {
      let response;
      try {
        response = await fetcher(`${CLOUDFLARE_API}${path}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        throw providerError("Worker Version content readback request failed");
      }
      if (
        !response ||
        response.status !== 200 ||
        response.redirected ||
        response.headers?.get("location")
      ) {
        throw providerError(
          `Worker Version content readback returned HTTP ${response?.status ?? "unknown"} or a redirect`,
        );
      }
      const contentType = response.headers?.get("content-type");
      const boundaryMatch =
        typeof contentType === "string"
          ? /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^;\s\r\n]+))$/iu.exec(
              contentType,
            )
          : null;
      const entrypoint = response.headers.get("cf-entrypoint");
      if (
        !boundaryMatch ||
        (hasExpectedBundle
          ? entrypoint !== "worker.mjs"
          : !["worker.js", "worker.mjs"].includes(entrypoint))
      ) {
        throw providerError(
          "Worker Version content readback lacks the reviewed multipart entrypoint",
        );
      }
      const boundary = boundaryMatch[1] ?? boundaryMatch[2];
      if (boundary.length > 200) {
        throw providerError(
          "Worker Version content multipart boundary is too long",
        );
      }
      const declaredLength = response.headers.get("content-length");
      if (
        declaredLength !== null &&
        (!/^\d+$/u.test(declaredLength) ||
          Number(declaredLength) > maximumBytes)
      ) {
        throw providerError(
          "Worker Version content readback exceeds the size bound",
        );
      }
      let raw;
      try {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("missing response body");
        const chunks = [];
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maximumBytes) {
            void reader.cancel().catch(() => {});
            throw new Error("oversize response body");
          }
          chunks.push(Buffer.from(chunk.value));
        }
        raw = Buffer.concat(chunks, size);
      } catch {
        throw providerError(
          "Worker Version content response body is unavailable or exceeds the size bound",
        );
      }
      const opening = Buffer.from(`--${boundary}\r\n`);
      const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
      const headerEnd = raw.indexOf("\r\n\r\n", opening.length);
      if (
        !raw.subarray(0, opening.length).equals(opening) ||
        !raw.subarray(-closing.length).equals(closing) ||
        headerEnd < opening.length ||
        headerEnd - opening.length > 8192
      ) {
        throw providerError(
          "Worker Version content multipart headers are malformed",
        );
      }
      const partHeaders = raw
        .subarray(opening.length, headerEnd)
        .toString("utf8")
        .split("\r\n");
      if (
        partHeaders.length !== 2 ||
        !partHeaders.some(
          (line) =>
            line.toLowerCase() ===
            `content-disposition: form-data; name="${entrypoint}"; filename="${entrypoint}"`,
        ) ||
        !partHeaders.some((line) =>
          hasExpectedBundle
            ? /^content-type: application\/javascript\+module$/iu.test(line)
            : /^content-type: application\/javascript(?:\+module)?$/iu.test(
                line,
              ),
        )
      ) {
        throw providerError(
          "Worker Version content main module has an unexpected disposition or media type",
        );
      }
      let form;
      try {
        form = await new Response(raw, {
          headers: { "Content-Type": contentType },
        }).formData();
      } catch {
        throw providerError(
          "Worker Version content readback is malformed multipart data",
        );
      }
      const parts = [...form.entries()];
      if (
        parts.length !== 1 ||
        parts[0][0] !== entrypoint ||
        !(parts[0][1] instanceof Blob) ||
        parts[0][1].name !== entrypoint
      ) {
        throw providerError(
          "Worker Version content contains unexpected module parts",
        );
      }
      const moduleBytes = new Uint8Array(await parts[0][1].arrayBuffer());
      const actualDigest = digest(moduleBytes);
      if (
        moduleBytes.byteLength < 1 ||
        (hasExpectedBundle &&
          (moduleBytes.byteLength !== bundleByteLength ||
            actualDigest !== bundleDigest))
      ) {
        throw providerError(
          "Worker Version content differs from the reviewed Worker bundle bytes",
        );
      }
      return {
        kind: "yurucommu.worker-version-code@v1",
        versionId,
        sha256: actualDigest,
        size: moduleBytes.byteLength,
      };
    };
    try {
      return await Promise.race([read(), timedOut]);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw providerError("Worker Version content readback failed");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async domains() {
      const basePath = `/accounts/${account}/workers/domains`;
      const readSnapshot = async () => {
        const entries = [];
        let page = 1;
        let totalPages = 1;
        let paginationMode = null;
        while (page <= totalPages) {
          const query = new URLSearchParams({
            hostname: selectedTarget.route.hostname,
            service: selectedTarget.workerName,
            environment: "production",
            page: String(page),
            per_page: String(DOMAIN_PAGE_SIZE),
          });
          const body = await request(`${basePath}?${query}`);
          if (!Array.isArray(body.result)) {
            throw providerError(
              "Cloudflare custom-domain readback did not return result[]",
            );
          }
          const info = body.result_info;
          if (info === undefined) {
            if (page !== 1 || body.result.length >= DOMAIN_PAGE_SIZE) {
              throw providerError(
                "Cloudflare custom-domain readback omitted bounded pagination metadata",
              );
            }
            totalPages = 1;
          } else {
            if (
              typeof info !== "object" ||
              info === null ||
              !Number.isInteger(info.page) ||
              info.page !== page ||
              body.result.length > DOMAIN_PAGE_SIZE ||
              (info.per_page !== undefined &&
                (!Number.isInteger(info.per_page) ||
                  info.per_page !== DOMAIN_PAGE_SIZE)) ||
              (info.count !== undefined &&
                (!Number.isInteger(info.count) || info.count < 0)) ||
              (info.total_count !== undefined &&
                (!Number.isInteger(info.total_count) || info.total_count < 0))
            ) {
              throw providerError(
                "Cloudflare custom-domain readback returned invalid pagination metadata",
              );
            }
            const mode =
              info.total_pages === undefined ? "page-length" : "total-pages";
            if (paginationMode !== null && paginationMode !== mode) {
              throw providerError(
                "Cloudflare custom-domain pagination mode changed while reading",
              );
            }
            paginationMode = mode;
            if (mode === "page-length") {
              if (info.per_page !== DOMAIN_PAGE_SIZE) {
                throw providerError(
                  "Cloudflare custom-domain readback omitted bounded page size",
                );
              }
              if (body.result.length === DOMAIN_PAGE_SIZE) {
                if (page >= MAX_DOMAIN_PAGES) {
                  throw providerError(
                    `Cloudflare custom-domain readback exceeds the ${MAX_DOMAIN_PAGES}-page stability bound`,
                  );
                }
                totalPages = page + 1;
              } else {
                totalPages = page;
              }
            } else if (
              !Number.isInteger(info.total_pages) ||
              info.total_pages < 1
            ) {
              throw providerError(
                "Cloudflare custom-domain readback returned invalid pagination metadata",
              );
            } else if (page === 1) {
              totalPages = info.total_pages;
              if (totalPages > MAX_DOMAIN_PAGES) {
                throw providerError(
                  `Cloudflare custom-domain readback exceeds the ${MAX_DOMAIN_PAGES}-page stability bound`,
                );
              }
            } else if (info.total_pages !== totalPages) {
              throw providerError(
                "Cloudflare custom-domain pagination changed while reading",
              );
            }
          }
          entries.push(...body.result);
          page += 1;
        }
        return entries;
      };
      const first = await readSnapshot();
      const second = await readSnapshot();
      if (
        JSON.stringify(canonicalDomainSnapshot(first)) !==
        JSON.stringify(canonicalDomainSnapshot(second))
      ) {
        throw providerError(
          "Cloudflare custom-domain inventory changed between stable readbacks",
        );
      }
      return first;
    },

    async activeDeployment() {
      const body = await request(
        `/accounts/${account}/workers/scripts/${worker}/deployments`,
      );
      if (
        typeof body.result !== "object" ||
        body.result === null ||
        !Array.isArray(body.result.deployments) ||
        body.result.deployments.length === 0
      ) {
        throw providerError(
          "Cloudflare active Deployment readback did not return result.deployments[0]",
        );
      }
      return body.result.deployments[0];
    },

    async version({ versionId }) {
      if (!UUID.test(versionId)) throw new Error("invalid Worker Version id");
      const body = await request(
        `/accounts/${account}/workers/scripts/${worker}/versions/${encodeURIComponent(versionId)}`,
      );
      return body.result;
    },

    async latestVersion() {
      const body = await request(
        `/accounts/${account}/workers/scripts/${worker}/versions?page=1&per_page=1`,
      );
      const items = body?.result?.items;
      if (
        !Array.isArray(items) ||
        items.length !== 1 ||
        typeof items[0]?.id !== "string" ||
        !UUID.test(items[0].id)
      ) {
        throw providerError(
          "Cloudflare latest Worker Version list is malformed or empty",
        );
      }
      return items[0].id;
    },

    assertVersionCode: assertVersionContent,
    snapshotVersionCode: assertVersionContent,

    async assertMediaDeletionSchema({ databaseId }) {
      if (typeof databaseId !== "string" || !UUID.test(databaseId)) {
        throw new Error("invalid active Worker D1 database id");
      }
      const body = await request(
        `/accounts/${account}/d1/database/${encodeURIComponent(databaseId)}/query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: MEDIA_DELETION_SCHEMA_QUERY }),
        },
      );
      try {
        return validateMediaDeletionQueryResults(body?.result);
      } catch (error) {
        throw providerError(
          error instanceof Error
            ? error.message
            : "Cloudflare D1 migration 0030 metadata response was invalid",
          {
            stderr: JSON.stringify(body),
            cause: error instanceof Error ? error : undefined,
          },
        );
      }
    },

    async assertCoreUpgradeSchema({ databaseId }) {
      if (typeof databaseId !== "string" || !UUID.test(databaseId)) {
        throw new Error("invalid active Worker D1 database id");
      }
      const rows = [];
      for (const sql of coreSchemaReadQueries()) {
        const body = await request(
          `/accounts/${account}/d1/database/${encodeURIComponent(databaseId)}/query`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sql }),
          },
        );
        try {
          if (!Array.isArray(body?.result) || body.result.length !== 1) {
            throw new Error(
              "D1 API must return exactly one Core schema query result",
            );
          }
          const result = body.result[0];
          const meta = result?.meta;
          if (
            typeof result !== "object" ||
            result === null ||
            Array.isArray(result) ||
            result.success !== true ||
            !Array.isArray(result.results) ||
            typeof meta !== "object" ||
            meta === null ||
            Array.isArray(meta) ||
            meta.changed_db !== false ||
            meta.rows_written !== 0
          ) {
            throw new Error(
              "D1 Core schema query returned malformed or write-reported results",
            );
          }
          rows.push(...result.results);
        } catch (error) {
          throw providerError(
            error instanceof Error
              ? error.message
              : "Cloudflare D1 Core schema chunk response was invalid",
            {
              stderr: JSON.stringify(body),
              cause: error instanceof Error ? error : undefined,
            },
          );
        }
      }
      try {
        return validateCoreUpgradeQueryResults([
          {
            success: true,
            results: rows,
            meta: { changed_db: false, rows_written: 0 },
          },
        ]);
      } catch (error) {
        throw providerError(
          error instanceof Error
            ? error.message
            : "Cloudflare D1 Core 4.1.12 metadata response was invalid",
          {
            cause: error instanceof Error ? error : undefined,
          },
        );
      }
    },

    async upload({ bundleBytes, configBytes, message, previousVersion }) {
      if (!(bundleBytes instanceof Uint8Array)) {
        throw new Error("the selected Worker bundle bytes are unavailable");
      }
      if (!(configBytes instanceof Uint8Array)) {
        throw new Error("the selected Wrangler config bytes are unavailable");
      }
      const config = validateWorkerConfig(
        parseJsonc(configBytes.toString("utf8"), "selected Wrangler config"),
        selectedTarget,
      );
      const metadata = {
        main_module: "worker.mjs",
        annotations: { "workers/message": message },
        compatibility_date: config.compatibility_date,
        ...(config.compatibility_flags === undefined
          ? {}
          : { compatibility_flags: config.compatibility_flags }),
        ...(config.limits === undefined ? {} : { limits: config.limits }),
        ...(config.usage_model === undefined
          ? {}
          : { usage_model: config.usage_model }),
      };
      const bindingNames = bindingNamesForInheritance(previousVersion);
      if (bindingNames.length > 0) metadata.bindings = bindingNames;
      const form = new FormData();
      form.set("metadata", JSON.stringify(metadata));
      form.append(
        "worker.mjs",
        new Blob([bundleBytes], { type: "application/javascript+module" }),
        "worker.mjs",
      );
      const body = await request(
        `/accounts/${account}/workers/scripts/${worker}/versions?bindings_inherit=strict`,
        {
          method: "POST",
          body: form,
        },
      );
      const versionId = body?.result?.id;
      if (typeof versionId !== "string" || !UUID.test(versionId)) {
        throw providerError(
          "Cloudflare Version upload acknowledgement names no valid Version",
        );
      }
      return {
        versionId,
        workerName: selectedTarget.workerName,
      };
    },

    async deployVersion({ versionId, message }) {
      if (!UUID.test(versionId)) throw new Error("invalid Worker Version id");
      const body = await request(
        `/accounts/${account}/workers/scripts/${worker}/deployments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            strategy: "percentage",
            versions: [{ version_id: versionId, percentage: 100 }],
            annotations: { "workers/message": message },
          }),
        },
      );
      const deploymentId = body?.result?.id;
      if (
        typeof deploymentId !== "string" ||
        !UUID.test(deploymentId) ||
        body.result.strategy !== "percentage" ||
        !Array.isArray(body.result.versions) ||
        body.result.versions.length !== 1 ||
        body.result.versions[0]?.version_id !== versionId ||
        body.result.versions[0]?.percentage !== 100
      ) {
        throw providerError(
          "Cloudflare Deployment acknowledgement does not bind the selected Version at 100 percent",
        );
      }
      return {
        deploymentId,
        workerName: selectedTarget.workerName,
      };
    },

    async putAuthSecret({ hash }) {
      if (
        selectedTarget.environment !== "integration" ||
        !/^[a-f0-9]{64}:[a-f0-9]{64}$/u.test(hash)
      ) {
        throw new Error("isolated integration auth hash is invalid");
      }
      let response;
      try {
        response = await fetcher(
          `${CLOUDFLARE_API}/accounts/${account}/workers/scripts/${worker}/secrets`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              name: AUTH_HASH_BINDING,
              text: hash,
              type: "secret_text",
            }),
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (response.status !== 200 || response.redirected) {
          throw new Error("secret write acknowledgement is unavailable");
        }
        const body = await response.json();
        if (
          body?.success !== true ||
          body?.result?.name !== AUTH_HASH_BINDING ||
          body.result.type !== "secret_text"
        ) {
          throw new Error("secret write acknowledgement is malformed");
        }
      } catch {
        // The response may echo the new hash. Never include provider bytes,
        // body, or an exception cause in the caller-visible diagnostic.
        throw new ProviderFailure(
          "isolated integration auth write is indeterminate; read active Version before any retry",
        );
      }
      return { name: AUTH_HASH_BINDING, type: "secret_text" };
    },

    async verifyAuthLogin({ password }) {
      if (selectedTarget.environment !== "integration") {
        throw new Error("isolated auth login requires integration target");
      }
      let stage = "transport_init";
      let httpStatus = "none";
      let ackSuccess = false;
      let cookiePresent = false;
      let sessionCookiePrefix = false;
      try {
        const transportFactory =
          createAuthLoginTransport ??
          (await import("./post-deploy-smoke.ts")).createPinnedHttpTransport;
        const transport = await transportFactory(
          new URL(selectedTarget.publicOrigin),
        );
        stage = "request";
        const response = await transport.request(
          new URL("/api/auth/login", selectedTarget.publicOrigin),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Origin: selectedTarget.publicOrigin,
            },
            body: JSON.stringify({ password }),
          },
        );
        stage = "response_status";
        if (
          Number.isInteger(response.status) &&
          response.status >= 100 &&
          response.status <= 599
        ) {
          httpStatus = response.status;
        }
        if (response.status !== 200) {
          throw new Error("password login rejected");
        }
        stage = "response_json";
        const body = await response.json();
        stage = "acknowledgement";
        ackSuccess = body?.success === true;
        const cookie = response.headers.get("set-cookie") ?? "";
        cookiePresent = cookie.length > 0;
        sessionCookiePrefix = /^session=[^;\s]+/u.test(cookie);
        if (!ackSuccess || !sessionCookiePrefix) {
          throw new Error("password login acknowledgement invalid");
        }
      } catch {
        throw new ProviderFailure(
          `isolated integration password login proof failed (stage=${stage}, http_status=${httpStatus}, ack_success=${ackSuccess}, cookie_present=${cookiePresent}, session_cookie_prefix=${sessionCookiePrefix}); inspect active Version and login state without replaying the secret write`,
        );
      }
      return { status: "passed" };
    },

    async smoke() {
      return inTemporaryDirectory(
        "yurucommu-worker-smoke-",
        async (directory) => {
          const outputsPath = join(directory, "capsule-outputs.json");
          writePrivate(
            outputsPath,
            `${JSON.stringify({ launch_url: selectedTarget.publicOrigin })}\n`,
          );
          const output = await invoke(
            runSmoke,
            "bun",
            ["run", "smoke:postdeploy"],
            {
              cwd: repo,
              env: {
                ...subprocessBaseEnv(),
                TAKOSUMI_CAPSULE_OUTPUTS_FILE: outputsPath,
                YURUCOMMU_E2E_PASSWORD: smokePassword,
                ...(selectedTarget.environment === "integration"
                  ? { YURUCOMMU_PROBE_RETAIN_POST: "1" }
                  : {}),
              },
            },
          );
          const lines = output.stdout
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean);
          let result;
          try {
            result = JSON.parse(lines.at(-1) ?? "");
          } catch (error) {
            throw new ProviderFailure(
              "post-deploy smoke did not return its structured result",
              {
                ...output,
                cause: error instanceof Error ? error : undefined,
              },
            );
          }
          if (
            result?.kind !== "takosumi.capsule-functional-probe@v1" ||
            result.status !== "passed" ||
            result.product !== "yurucommu" ||
            (selectedTarget.environment === "integration"
              ? result.postRetained !== true ||
                !result.checks?.some(
                  (check) => check.name === "posts.readback",
                ) ||
                !result.checks?.some((check) => check.name === "unread.polling")
              : result.cleanupVerified !== true)
          ) {
            throw new ProviderFailure(
              "post-deploy smoke did not prove the selected Yurucommu behavior",
              output,
            );
          }
          return result;
        },
      );
    },
  };
}

export async function deployYurucommuWorker({
  repo = REPO,
  environment,
  commit,
  target,
  git = defaultGit,
  check = defaultCheck,
  provider,
} = {}) {
  let phase = "PRE_UPLOAD_FAILURE";
  let source = null;
  let selectedTarget = null;
  let bundleDigest = null;
  let bundleByteLength = null;
  let previous = null;
  let versionId = null;
  let deploymentId = null;
  let releaseProvider = provider;
  try {
    if (!["production", "integration"].includes(environment)) {
      throw new Error(
        "worker deployment requires --environment=production|integration",
      );
    }
    source = await qualifyProductionSource({ repo, commit, git });
    selectedTarget = validateTarget(rawTargetDescriptor(target), environment, {
      repo,
    });
    releaseProvider ??= createCloudflareWorkerProvider({ repo, target });

    await check({ repo, environment, commit: source.commit });
    const checkedSource = await qualifyProductionSource({ repo, commit, git });
    if (
      checkedSource.commit !== source.commit ||
      checkedSource.branch !== source.branch
    ) {
      throw new Error("source identity changed during the owner gate");
    }
    const bundlePath = resolve(repo, BUNDLE);
    if (!existsSync(bundlePath)) {
      throw new Error(`${BUNDLE} is missing after the owner gate`);
    }
    const bundleBytes = readFileSync(bundlePath);
    bundleDigest = digest(bundleBytes);
    bundleByteLength = bundleBytes.byteLength;
    assertPrivateFile(selectedTarget.config.path, "deploy target config", {
      repo,
    });
    const configBytes = readFileSync(selectedTarget.config.path);
    if (digest(configBytes) !== selectedTarget.config.sha256) {
      throw new Error("deploy config digest changed during the owner gate");
    }
    const identity = [
      environment === "integration"
        ? "yurucommu-integration-worker"
        : "yurucommu-worker",
      source.commit,
      bundleDigest,
      selectedTarget.config.sha256,
    ].join(":");

    if (typeof releaseProvider.assertVersionCode !== "function") {
      throw new Error(
        "Worker provider is missing the required exact Version code readback",
      );
    }
    const proveSelectedCode = async (selectedVersionId) => {
      const proof = await releaseProvider.assertVersionCode({
        versionId: selectedVersionId,
        bundleDigest,
        bundleByteLength,
      });
      assertVersionCodeProof(
        proof,
        selectedVersionId,
        bundleDigest,
        bundleByteLength,
      );
    };

    assertDomains(
      await releaseProvider.domains(),
      selectedTarget,
      "pre-upload route readback",
    );
    previous = deployment(
      await releaseProvider.activeDeployment(),
      "pre-upload active Deployment",
    );
    const previousVersion = await releaseProvider.version({
      versionId: previous.versionId,
    });
    if (previousVersion?.id !== previous.versionId) {
      throw new Error(
        "pre-upload active Deployment points to a Version that cannot be read authoritatively",
      );
    }
    assertVersionClosure(previousVersion, "active predecessor Version");
    if (environment === "integration") {
      assertIntegrationAppUrl(previousVersion, selectedTarget.publicOrigin);
      assertIntegrationResources(previousVersion, selectedTarget);
    }
    assertConfigMatchesVersion(
      selectedTarget.configValues,
      previousVersion,
      "selected Wrangler config",
    );

    assertActiveSessionHashSaltBinding(previousVersion);
    const databaseId =
      environment === "integration"
        ? selectedTarget.resources.databaseId
        : activeDatabaseId(previousVersion);
    if (typeof releaseProvider.assertMediaDeletionSchema !== "function") {
      throw new Error(
        "Worker provider is missing the required read-only migration 0030 D1 preflight",
      );
    }
    await releaseProvider.assertMediaDeletionSchema({ databaseId });
    if (typeof releaseProvider.assertCoreUpgradeSchema !== "function") {
      throw new Error(
        "Worker provider is missing the required read-only Core 4.1.12 D1 preflight",
      );
    }
    const upgradeProof = await releaseProvider.assertCoreUpgradeSchema({
      databaseId,
    });
    if (
      upgradeProof?.kind !== "yurucommu.core-upgrade-schema@v1" ||
      upgradeProof.scope !== "migration-0031-through-0036-prerequisites" ||
      !Array.isArray(upgradeProof.migrations) ||
      upgradeProof.migrations.length !== CORE_UPGRADE_MIGRATIONS.length ||
      upgradeProof.migrations.some(
        (name, index) => name !== CORE_UPGRADE_MIGRATIONS[index],
      )
    ) {
      throw new Error(
        "Worker provider returned invalid Core 4.1.12 D1 preflight proof",
      );
    }

    if (environment === "integration") {
      const immediateDeployment = deployment(
        await releaseProvider.activeDeployment(),
        "immediate pre-upload active Deployment",
      );
      assertSameDeployment(previous, immediateDeployment, "active Deployment");
      const immediateVersion = await releaseProvider.version({
        versionId: previous.versionId,
      });
      if (immediateVersion?.id !== previous.versionId) {
        throw new Error("immediate pre-upload Version identity changed");
      }
      assertCodeOnlyVersion(previousVersion, immediateVersion);
      assertIntegrationAppUrl(immediateVersion, selectedTarget.publicOrigin);
      assertIntegrationResources(immediateVersion, selectedTarget);
    }

    if (typeof releaseProvider.latestVersion !== "function") {
      throw new Error(
        "provider lacks authoritative latest Worker Version readback",
      );
    }
    if ((await releaseProvider.latestVersion()) !== previous.versionId) {
      throw new Error(
        "latest uploaded Worker Version differs from the active predecessor; inherited bindings cannot be pinned safely",
      );
    }

    phase = "POST_UPLOAD_INDETERMINATE";
    const upload = await releaseProvider.upload({
      repo,
      environment,
      target: selectedTarget,
      bundlePath,
      bundleBytes,
      bundleDigest,
      configBytes,
      configDigest: selectedTarget.config.sha256,
      previousVersion,
      message: identity,
    });
    versionId = acknowledged(
      upload,
      "versionId",
      "Worker Version upload",
      selectedTarget.workerName,
    );
    const uploadedVersion = await releaseProvider.version({ versionId });
    const uploadedEtag = assertVersionIdentity(
      uploadedVersion,
      versionId,
      identity,
    );
    assertCodeOnlyVersion(previousVersion, uploadedVersion);
    await proveSelectedCode(versionId);

    const beforeDeploy = deployment(
      await releaseProvider.activeDeployment(),
      "pre-deploy active Deployment",
    );
    assertSameDeployment(previous, beforeDeploy, "active Deployment");
    const candidateBeforeDeploy = await releaseProvider.version({ versionId });
    assertVersionIdentity(
      candidateBeforeDeploy,
      versionId,
      identity,
      uploadedEtag,
    );
    assertCodeOnlyVersion(previousVersion, candidateBeforeDeploy);
    await proveSelectedCode(versionId);

    const deploymentMessage = `${identity}:previous:${previous.id}:${previous.versionId}`;
    phase = "POST_DEPLOY_INDETERMINATE";
    const deployed = await releaseProvider.deployVersion({
      environment,
      target: selectedTarget,
      versionId,
      message: deploymentMessage,
    });
    deploymentId = acknowledged(
      deployed,
      "deploymentId",
      "Worker Deployment",
      selectedTarget.workerName,
    );
    const active = deployment(
      await releaseProvider.activeDeployment(),
      "post-deploy active Deployment",
    );
    if (
      active.id !== deploymentId ||
      active.versionId !== versionId ||
      active.message !== deploymentMessage
    ) {
      throw new Error(
        "post-deploy active Deployment does not match the acknowledged Version and Deployment",
      );
    }
    const postDeployVersion = await releaseProvider.version({ versionId });
    assertVersionIdentity(postDeployVersion, versionId, identity, uploadedEtag);
    assertCodeOnlyVersion(previousVersion, postDeployVersion);
    assertDomains(
      await releaseProvider.domains(),
      selectedTarget,
      "post-deploy route readback",
    );
    let smoke;
    phase = "POST_CONDITION_INDETERMINATE";
    try {
      smoke = await releaseProvider.smoke({
        environment,
        target: selectedTarget,
        versionId,
        deploymentId,
      });
      if (smoke?.status !== "passed") {
        throw new Error("real request smoke did not report status passed");
      }
    } catch (smokeError) {
      const postSmokeActive = deployment(
        await releaseProvider.activeDeployment(),
        "post-smoke active Deployment",
      );
      throw new YurucommuWorkerReleaseFailure(
        postSmokeActive.id === deploymentId &&
          postSmokeActive.versionId === versionId &&
          postSmokeActive.message === deploymentMessage
          ? `the deployed Worker failed its real request smoke; no automatic rollback is safe without a Cloudflare CAS. The exact predecessor Deployment ${previous.id} / Version ${previous.versionId} is available for a manual reversal after operator review`
          : `the deployed Worker failed its real request smoke and the active Deployment changed concurrently; no rollback was attempted. The exact predecessor Deployment ${previous.id} / Version ${previous.versionId} is available for a manual reversal after operator review`,
        {
          phase: "POST_CONDITION_INDETERMINATE",
          evidence: {
            environment,
            accountId: selectedTarget.accountId,
            workerName: selectedTarget.workerName,
            route: selectedTarget.publicOrigin,
            commit: source.commit,
            bundleDigest,
            configDigest: selectedTarget.config.sha256,
            failedDeploymentId: deploymentId,
            failedVersionId: versionId,
            previousDeploymentId: previous.id,
            previousVersionId: previous.versionId,
            observedActiveDeploymentId: postSmokeActive.id,
            observedActiveVersionId: postSmokeActive.versionId,
            manualReversal: {
              deploymentId: previous.id,
              versionId: previous.versionId,
            },
          },
          provider: smokeError?.provider ?? null,
          cause: smokeError instanceof Error ? smokeError : undefined,
        },
      );
    }
    assertDomains(
      await releaseProvider.domains(),
      selectedTarget,
      "post-smoke route readback",
    );
    const finalActive = deployment(
      await releaseProvider.activeDeployment(),
      "post-smoke active Deployment",
    );
    if (
      finalActive.id !== deploymentId ||
      finalActive.versionId !== versionId ||
      finalActive.message !== deploymentMessage
    ) {
      throw new Error(
        "active Deployment changed concurrently during smoke; the selected Version is not the final serving Deployment",
      );
    }
    const finalVersion = await releaseProvider.version({ versionId });
    assertVersionIdentity(finalVersion, versionId, identity, uploadedEtag);
    assertCodeOnlyVersion(previousVersion, finalVersion);
    await proveSelectedCode(versionId);
    return {
      kind: "takos.deploy-result@v1",
      surface:
        environment === "integration"
          ? "yurucommu-integration-worker"
          : "yurucommu-worker",
      target: `cloudflare-worker:${selectedTarget.workerName}`,
      environment,
      accountId: selectedTarget.accountId,
      workerName: selectedTarget.workerName,
      commit: source.commit,
      branch: source.branch,
      remoteRef: source.remoteRef,
      bundleDigest,
      configDigest: selectedTarget.config.sha256,
      route: selectedTarget.publicOrigin,
      previousDeploymentId: previous.id,
      previousVersionId: previous.versionId,
      deploymentId,
      versionId,
      providerReadback:
        "EXACT_ACTIVE_DEPLOYMENT_VERSION_METADATA_AND_CODE_BYTES",
      smoke,
      status: "PUBLISHED",
    };
  } catch (error) {
    if (error instanceof YurucommuWorkerReleaseFailure) throw error;
    throw new YurucommuWorkerReleaseFailure(
      error instanceof Error ? error.message : "worker publication failed",
      {
        phase,
        evidence: {
          environment: environment ?? null,
          ...(selectedTarget
            ? {
                accountId: selectedTarget.accountId,
                workerName: selectedTarget.workerName,
                route: selectedTarget.publicOrigin,
              }
            : {}),
          commit: source?.commit ?? commit ?? null,
          ...(bundleDigest ? { bundleDigest } : {}),
          ...(selectedTarget?.config?.sha256
            ? { configDigest: selectedTarget.config.sha256 }
            : {}),
          ...(previous
            ? {
                previousDeploymentId: previous.id,
                previousVersionId: previous.versionId,
              }
            : {}),
          ...(versionId ? { versionId } : {}),
          ...(deploymentId ? { deploymentId } : {}),
        },
        provider: error?.provider ?? null,
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
}

export async function resetYurucommuIntegrationAuth({
  repo = REPO,
  commit,
  target,
  password = process.env.YURUCOMMU_E2E_PASSWORD,
  git = defaultGit,
  check = defaultCheck,
  provider,
} = {}) {
  let phase = "PRE_AUTH_FAILURE";
  let selectedTarget;
  let predecessor;
  let candidate;
  let secretHash;
  try {
    if (typeof password !== "string" || password.length < 24) {
      throw new Error(
        "a strong ephemeral integration test-owner password is required",
      );
    }
    const source = await qualifyProductionSource({ repo, commit, git });
    selectedTarget = validateTarget(
      rawTargetDescriptor(target),
      "integration",
      { repo },
    );
    const releaseProvider =
      provider ??
      createCloudflareWorkerProvider({
        repo,
        target: selectedTarget,
        smokePassword: password,
      });
    await check({ repo, environment: "integration", commit: source.commit });
    const checkedSource = await qualifyProductionSource({ repo, commit, git });
    if (
      checkedSource.commit !== source.commit ||
      checkedSource.branch !== source.branch
    ) {
      throw new Error("source identity changed during the owner gate");
    }
    if (typeof releaseProvider.snapshotVersionCode !== "function") {
      throw new Error("bounded Worker Version code snapshot is required");
    }
    assertDomains(
      await releaseProvider.domains(),
      selectedTarget,
      "pre-auth route readback",
    );
    predecessor = deployment(
      await releaseProvider.activeDeployment(),
      "pre-auth active Deployment",
    );
    const before = await releaseProvider.version({
      versionId: predecessor.versionId,
    });
    if (before?.id !== predecessor.versionId) {
      throw new Error("pre-auth active Version identity is invalid");
    }
    assertVersionClosure(before, "pre-auth active Version");
    assertIntegrationAppUrl(before, selectedTarget.publicOrigin);
    assertIntegrationResources(before, selectedTarget);
    assertIntegrationAuthBinding(before);
    assertActiveSessionHashSaltBinding(before);
    const predecessorCode = await releaseProvider.snapshotVersionCode({
      versionId: predecessor.versionId,
    });
    assertVersionCodeProof(
      predecessorCode,
      predecessor.versionId,
      predecessorCode?.sha256,
      predecessorCode?.size,
    );
    const proveSameCode = async (versionId) => {
      const proof = await releaseProvider.snapshotVersionCode({ versionId });
      assertVersionCodeProof(
        proof,
        versionId,
        predecessorCode.sha256,
        predecessorCode.size,
      );
    };
    // Use the installed Core implementation used by both current and next
    // Worker bundles. Finish hashing before the immediate pre-write readbacks.
    const { hashPassword, verifyPassword } =
      await import("../node_modules/@takosjp/yurucommu-core/src/backend/lib/crypto.ts");
    const hash = await hashPassword(password);
    secretHash = hash;
    if (
      !/^[a-f0-9]{64}:[a-f0-9]{64}$/u.test(hash) ||
      !(await verifyPassword(password, hash))
    ) {
      throw new Error(
        "installed Core did not self-verify a canonical password hash",
      );
    }
    if (typeof releaseProvider.putAuthSecret !== "function") {
      throw new Error("provider lacks exact integration auth secret writer");
    }
    const beforeWrite = deployment(
      await releaseProvider.activeDeployment(),
      "immediate pre-auth active Deployment",
    );
    assertSameDeployment(predecessor, beforeWrite, "active Deployment");
    const immediateVersion = await releaseProvider.version({
      versionId: predecessor.versionId,
    });
    if (immediateVersion?.id !== predecessor.versionId) {
      throw new Error("immediate pre-auth Version identity changed");
    }
    assertCodeOnlyVersion(before, immediateVersion);
    assertIntegrationAppUrl(immediateVersion, selectedTarget.publicOrigin);
    assertIntegrationResources(immediateVersion, selectedTarget);

    if (typeof releaseProvider.latestVersion !== "function") {
      throw new Error(
        "provider lacks authoritative latest Worker Version readback",
      );
    }
    if ((await releaseProvider.latestVersion()) !== predecessor.versionId) {
      throw new Error(
        "latest uploaded Worker Version differs from the active predecessor; secret update cannot be pinned safely",
      );
    }

    phase = "POST_AUTH_INDETERMINATE";
    const acknowledgedSecret = await releaseProvider.putAuthSecret({ hash });
    if (
      acknowledgedSecret?.name !== AUTH_HASH_BINDING ||
      acknowledgedSecret.type !== "secret_text"
    ) {
      throw new Error("integration auth secret acknowledgement is invalid");
    }
    candidate = deployment(
      await releaseProvider.activeDeployment(),
      "post-auth active Deployment",
    );
    if (
      candidate.id === predecessor.id ||
      candidate.versionId === predecessor.versionId
    ) {
      throw new Error("secret write did not produce a new sole active Version");
    }
    const after = await releaseProvider.version({
      versionId: candidate.versionId,
    });
    if (after?.id !== candidate.versionId) {
      throw new Error("post-auth active Version identity is invalid");
    }
    assertCodeOnlyVersion(before, after);
    assertIntegrationAppUrl(after, selectedTarget.publicOrigin);
    assertIntegrationResources(after, selectedTarget);
    assertIntegrationAuthBinding(after);
    await proveSameCode(candidate.versionId);
    assertDomains(
      await releaseProvider.domains(),
      selectedTarget,
      "post-auth route readback",
    );
    if (typeof releaseProvider.verifyAuthLogin !== "function") {
      throw new Error("provider lacks authenticated login proof");
    }
    const login = await releaseProvider.verifyAuthLogin({ password });
    if (login?.status !== "passed") {
      throw new Error("new integration credential did not pass login proof");
    }
    const finalActive = deployment(
      await releaseProvider.activeDeployment(),
      "post-login active Deployment",
    );
    assertSameDeployment(candidate, finalActive, "active Deployment");
    const finalVersion = await releaseProvider.version({
      versionId: candidate.versionId,
    });
    assertCodeOnlyVersion(before, finalVersion);
    assertIntegrationResources(finalVersion, selectedTarget);
    await proveSameCode(candidate.versionId);
    return {
      kind: "takos.deploy-result@v1",
      surface: "yurucommu-integration-auth",
      target: `cloudflare-worker:${selectedTarget.workerName}`,
      environment: "integration",
      accountId: selectedTarget.accountId,
      workerName: selectedTarget.workerName,
      route: selectedTarget.publicOrigin,
      commit: source.commit,
      bundleDigest: predecessorCode.sha256,
      previousDeploymentId: predecessor.id,
      previousVersionId: predecessor.versionId,
      deploymentId: candidate.id,
      versionId: candidate.versionId,
      login: "PASSED",
      status: "PUBLISHED",
    };
  } catch (error) {
    let message =
      error instanceof Error ? error.message : "integration auth reset failed";
    for (const secret of [password, secretHash]) {
      if (typeof secret === "string" && secret.length > 0) {
        message = message.replaceAll(secret, "[REDACTED]");
      }
    }
    throw new YurucommuWorkerReleaseFailure(message, {
      phase,
      evidence: {
        environment: "integration",
        ...(selectedTarget
          ? {
              accountId: selectedTarget.accountId,
              workerName: selectedTarget.workerName,
              route: selectedTarget.publicOrigin,
            }
          : {}),
        commit: commit ?? null,
        ...(predecessor
          ? {
              previousDeploymentId: predecessor.id,
              previousVersionId: predecessor.versionId,
            }
          : {}),
        ...(candidate
          ? {
              deploymentId: candidate.id,
              versionId: candidate.versionId,
            }
          : {}),
      },
      // In particular, never retain an exception cause or provider body
      // around the hash-bearing PUT or password-bearing login request.
      provider: null,
    });
  }
}

export function reportYurucommuWorkerReleaseFailure(error) {
  const failure =
    error instanceof YurucommuWorkerReleaseFailure
      ? error
      : new YurucommuWorkerReleaseFailure(
          error instanceof Error ? error.message : String(error),
          { phase: "PRE_UPLOAD_FAILURE", cause: error },
        );
  process.stderr.write(
    `deploy blocked [${failure.phase}]: ${failure.message}\n`,
  );
  if (failure.provider) {
    if (failure.provider.stdout) {
      process.stderr.write(`provider stdout:\n${failure.provider.stdout}\n`);
    }
    if (failure.provider.stderr) {
      process.stderr.write(`provider stderr:\n${failure.provider.stderr}\n`);
    }
  }
  if (
    failure.phase === "POST_UPLOAD_INDETERMINATE" ||
    failure.phase === "POST_DEPLOY_INDETERMINATE" ||
    failure.phase === "POST_CONDITION_INDETERMINATE" ||
    failure.phase === "POST_AUTH_INDETERMINATE"
  ) {
    process.stderr.write(
      "Provider mutation may have completed. Read the authoritative active Deployment and Version before any retry; this entrypoint did not retry.\n",
    );
  }
  const status =
    failure.phase === "PRE_UPLOAD_FAILURE" ||
    failure.phase === "PRE_AUTH_FAILURE"
      ? "BLOCKED"
      : "INDETERMINATE";
  process.stdout.write(
    `${JSON.stringify(
      {
        kind: "takos.deploy-result@v1",
        surface:
          failure.evidence.environment === "integration"
            ? failure.phase?.includes("AUTH")
              ? "yurucommu-integration-auth"
              : "yurucommu-integration-worker"
            : "yurucommu-worker",
        target: `cloudflare-worker:${failure.evidence.workerName ?? WORKER}`,
        ...failure.evidence,
        failurePhase: failure.phase,
        status,
      },
      null,
      2,
    )}\n`,
  );
}
