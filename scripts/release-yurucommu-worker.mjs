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

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = /^[0-9a-f]{40}$/u;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TARGET_KIND = "yurucommu.worker-deploy-target@v1";
const WORKER = "yurucommu";
const PUBLIC_ORIGIN = "https://test.yurucommu.com";
const BUNDLE = "dist/yurucommu-worker.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const DOMAIN_PAGE_SIZE = 100;
const MAX_DOMAIN_PAGES = 8;

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
  exactKeys(value, [
    "kind",
    "environment",
    "accountId",
    "workerName",
    "publicOrigin",
    "route",
    "config",
  ]);
  if (value.kind !== TARGET_KIND) {
    throw new Error(`deploy target kind must be ${TARGET_KIND}`);
  }
  if (value.environment !== environment) {
    throw new Error("deploy target environment does not match the selection");
  }
  if (
    typeof value.accountId !== "string" ||
    !ACCOUNT_ID.test(value.accountId)
  ) {
    throw new Error(
      "deploy target accountId must be exactly 32 lowercase hex characters",
    );
  }
  if (value.workerName !== WORKER) {
    throw new Error(`deploy target workerName must be ${WORKER}`);
  }
  if (value.publicOrigin !== PUBLIC_ORIGIN) {
    throw new Error(`deploy target publicOrigin must be ${PUBLIC_ORIGIN}`);
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
    value.route.hostname !== new URL(PUBLIC_ORIGIN).hostname
  ) {
    throw new Error(
      `deploy target route must be the ${new URL(PUBLIC_ORIGIN).hostname} custom domain`,
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
  const selected = validateTarget(value, environment, { repo });
  delete selected.configBytes;
  delete selected.configValues;
  return selected;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function scriptEtag(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
      entry.environment !== target.environment
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

function acknowledged(value, field, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value[field] !== "string" ||
    !UUID.test(value[field]) ||
    value.workerName !== WORKER
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
    typeof expectedScriptEtag !== "string" ||
    typeof actualScriptEtag !== "string" ||
    actualScriptEtag !== expectedScriptEtag
  ) {
    throw new Error(
      `Worker Version ${versionId} authoritative script etag (resources.script.etag) does not match the uploaded script bytes`,
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

function cloudflareApiError(message, output = {}) {
  return new ProviderFailure(message, output);
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
      version_id: versionId,
    }));
  }
  if (typeof bindings === "object" && bindings !== null) {
    return Object.keys(bindings)
      .sort()
      .map((name) => ({ name, type: "inherit", version_id: versionId }));
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
} = {}) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN is required before provider access");
  }
  if (typeof smokePassword !== "string" || !smokePassword) {
    throw new Error(
      "YURUCOMMU_E2E_PASSWORD is required before provider access",
    );
  }
  const selectedTarget = validateTarget(target, "production", { repo });
  const account = encodeURIComponent(selectedTarget.accountId);
  const worker = encodeURIComponent(selectedTarget.workerName);

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
      throw cloudflareApiError(
        error instanceof Error
          ? `Cloudflare readback failed: ${error.message}`
          : "Cloudflare readback failed",
        { cause: error instanceof Error ? error : undefined },
      );
    }
    const text = await response.text();
    let responseBody;
    try {
      responseBody = JSON.parse(text);
    } catch (error) {
      throw cloudflareApiError(
        `Cloudflare readback returned non-JSON HTTP ${response.status}`,
        {
          stderr: text.slice(0, 4_000),
          cause: error instanceof Error ? error : undefined,
        },
      );
    }
    if (!response.ok || responseBody?.success !== true) {
      throw cloudflareApiError(
        `Cloudflare readback returned HTTP ${response.status}`,
        { stderr: text.slice(0, 4_000) },
      );
    }
    return responseBody;
  }

  return {
    async domains() {
      const basePath = `/accounts/${account}/workers/domains`;
      const readSnapshot = async () => {
        const entries = [];
        let page = 1;
        let totalPages = 1;
        while (page <= totalPages) {
          const query = new URLSearchParams({
            hostname: selectedTarget.route.hostname,
            service: selectedTarget.workerName,
            environment: selectedTarget.environment,
            page: String(page),
            per_page: String(DOMAIN_PAGE_SIZE),
          });
          const body = await request(`${basePath}?${query}`);
          if (!Array.isArray(body.result)) {
            throw cloudflareApiError(
              "Cloudflare custom-domain readback did not return result[]",
            );
          }
          const info = body.result_info;
          if (info === undefined) {
            if (page !== 1 || body.result.length >= DOMAIN_PAGE_SIZE) {
              throw cloudflareApiError(
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
              !Number.isInteger(info.total_pages) ||
              info.total_pages < 1
            ) {
              throw cloudflareApiError(
                "Cloudflare custom-domain readback returned invalid pagination metadata",
              );
            }
            if (page === 1) {
              totalPages = info.total_pages;
              if (totalPages > MAX_DOMAIN_PAGES) {
                throw cloudflareApiError(
                  `Cloudflare custom-domain readback exceeds the ${MAX_DOMAIN_PAGES}-page stability bound`,
                );
              }
            } else if (info.total_pages !== totalPages) {
              throw cloudflareApiError(
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
        throw cloudflareApiError(
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
        throw cloudflareApiError(
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
      form.append(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
        "metadata.json",
      );
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
        throw cloudflareApiError(
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
        throw cloudflareApiError(
          "Cloudflare Deployment acknowledgement does not bind the selected Version at 100 percent",
        );
      }
      return {
        deploymentId,
        workerName: selectedTarget.workerName,
      };
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
            result.cleanupVerified !== true
          ) {
            throw new ProviderFailure(
              "post-deploy smoke did not prove Yurucommu behavior and cleanup",
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
  let bundleEtag = null;
  let previous = null;
  let versionId = null;
  let deploymentId = null;
  let releaseProvider = provider;
  try {
    if (environment !== "production") {
      throw new Error("worker deployment requires --environment=production");
    }
    source = await qualifyProductionSource({ repo, commit, git });
    selectedTarget = validateTarget(target, environment, { repo });
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
    bundleEtag = scriptEtag(bundleBytes);
    assertPrivateFile(selectedTarget.config.path, "deploy target config", {
      repo,
    });
    const configBytes = readFileSync(selectedTarget.config.path);
    if (digest(configBytes) !== selectedTarget.config.sha256) {
      throw new Error("deploy config digest changed during the owner gate");
    }
    const identity = [
      "yurucommu-worker",
      source.commit,
      bundleDigest,
      selectedTarget.config.sha256,
    ].join(":");

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
    assertConfigMatchesVersion(
      selectedTarget.configValues,
      previousVersion,
      "selected Wrangler config",
    );

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
    versionId = acknowledged(upload, "versionId", "Worker Version upload");
    const uploadedVersion = await releaseProvider.version({ versionId });
    assertVersionIdentity(uploadedVersion, versionId, identity, bundleEtag);
    assertCodeOnlyVersion(previousVersion, uploadedVersion);

    const beforeDeploy = deployment(
      await releaseProvider.activeDeployment(),
      "pre-deploy active Deployment",
    );
    assertSameDeployment(previous, beforeDeploy, "active Deployment");

    const deploymentMessage = `${identity}:previous:${previous.id}:${previous.versionId}`;
    phase = "POST_DEPLOY_INDETERMINATE";
    const deployed = await releaseProvider.deployVersion({
      environment,
      target: selectedTarget,
      versionId,
      message: deploymentMessage,
    });
    deploymentId = acknowledged(deployed, "deploymentId", "Worker Deployment");
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
    assertVersionIdentity(postDeployVersion, versionId, identity, bundleEtag);
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
    return {
      kind: "takos.deploy-result@v1",
      surface: "yurucommu-worker",
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
      providerReadback: "EXACT_ACTIVE_DEPLOYMENT_AND_VERSION_IDENTITY",
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
    failure.phase === "POST_CONDITION_INDETERMINATE"
  ) {
    process.stderr.write(
      "Provider mutation may have completed. Read the authoritative active Deployment and Version before any retry; this entrypoint did not retry.\n",
    );
  }
  const status =
    failure.phase === "PRE_UPLOAD_FAILURE" ? "BLOCKED" : "INDETERMINATE";
  process.stdout.write(
    `${JSON.stringify(
      {
        kind: "takos.deploy-result@v1",
        surface: "yurucommu-worker",
        target: `cloudflare-worker:${WORKER}`,
        ...failure.evidence,
        failurePhase: failure.phase,
        status,
      },
      null,
      2,
    )}\n`,
  );
}
