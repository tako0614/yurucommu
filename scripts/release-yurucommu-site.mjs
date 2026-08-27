import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const MAX_PAGES_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_PAGES_ASSET_COUNT = 20_000;
const MAX_TEXT_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_AUTH_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROJECT_RESPONSE_BYTES = 8 * 1024 * 1024;
const SAFE_FILE_MODE = 0o400;
const SAFE_DIRECTORY_MODE = 0o500;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const PROJECT = "yurucommu-website";
const PRODUCTION_BRANCH = "main";
const PUBLIC_ORIGIN = "https://yurucommu.com";
const INSTALL_CTA_URL =
  "https://app.takosumi.com/install?kind=capsule-source-options&git=https%3A%2F%2Fgithub.com%2Ftako0614%2Fyurucommu.git&path=install-options.json";
const SURFACE = "yurucommu-site";
const TARGET = `cloudflare-pages:${PROJECT}`;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deploymentUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid Pages deployment URL: ${JSON.stringify(value)}`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== "" ||
    !new RegExp(`^[0-9a-f]{8}\\.${PROJECT}\\.pages\\.dev$`, "u").test(
      url.hostname,
    )
  ) {
    throw new Error(`unsafe Pages deployment URL: ${JSON.stringify(value)}`);
  }
  return url.origin;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function parseCanonicalProductionProject(rawResponse) {
  const raw = String(rawResponse);
  if (Buffer.byteLength(raw) > MAX_PROJECT_RESPONSE_BYTES) {
    throw new Error(
      "Cloudflare Pages project response exceeded the safe bound",
    );
  }
  const envelope = parseJson(raw, "Cloudflare Pages project response");
  if (
    envelope?.success !== true ||
    !Array.isArray(envelope.errors) ||
    envelope.errors.length !== 0
  ) {
    throw new Error("Cloudflare Pages project authority read was unsuccessful");
  }
  const project = envelope.result;
  if (
    project?.name !== PROJECT ||
    !UUID.test(project?.id) ||
    project?.production_branch !== PRODUCTION_BRANCH ||
    !Array.isArray(project?.domains) ||
    !project.domains.includes(new URL(PUBLIC_ORIGIN).hostname)
  ) {
    throw new Error(
      "Cloudflare Pages project identity, production branch, or custom domain is not the owner target",
    );
  }
  if (
    project.source !== null &&
    project.source !== undefined &&
    (project.source?.config?.production_deployments_enabled !== false ||
      project.source?.config?.production_branch !== PRODUCTION_BRANCH)
  ) {
    throw new Error(
      "Cloudflare Pages automatic production deployments must be authoritatively disabled before origin/main can be the release source",
    );
  }
  const canonical = project.canonical_deployment;
  if (!canonical || typeof canonical !== "object") {
    throw new Error(
      "Cloudflare Pages project has no canonical_deployment production authority",
    );
  }
  if (
    !UUID.test(canonical.id) ||
    canonical.project_id !== project.id ||
    canonical.project_name !== PROJECT ||
    canonical.environment !== "production" ||
    canonical.latest_stage?.name !== "deploy" ||
    canonical.latest_stage?.status !== "success" ||
    canonical.is_skipped !== false ||
    canonical.deployment_trigger?.metadata?.branch !== PRODUCTION_BRANCH
  ) {
    throw new Error(
      "Cloudflare canonical_deployment is not a successful production deployment for the owner project",
    );
  }
  const source = canonical.deployment_trigger?.metadata?.commit_hash;
  return {
    authority: "cloudflare-pages-project.canonical_deployment",
    project: PROJECT,
    projectId: project.id,
    deploymentId: canonical.id,
    deploymentUrl: deploymentUrl(canonical.url),
    branch: PRODUCTION_BRANCH,
    source: /^[0-9a-f]{7,64}$/u.test(source ?? "") ? source : null,
    publicOrigin: PUBLIC_ORIGIN,
    automaticProductionDeployments:
      project.source === null || project.source === undefined
        ? "not-configured"
        : "disabled",
  };
}

export function parseWranglerReleaseAuthority(whoamiOutput, tokenOutput) {
  const whoamiRaw = String(whoamiOutput);
  const tokenRaw = String(tokenOutput);
  if (
    Buffer.byteLength(whoamiRaw) > MAX_AUTH_OUTPUT_BYTES ||
    Buffer.byteLength(tokenRaw) > MAX_AUTH_OUTPUT_BYTES
  ) {
    throw new Error("Wrangler authentication output exceeded the safe bound");
  }
  const whoami = parseJson(whoamiRaw, "Wrangler whoami output");
  if (
    whoami?.loggedIn !== true ||
    whoami?.authType !== "OAuth Token" ||
    !Array.isArray(whoami?.accounts)
  ) {
    throw new Error(
      "Wrangler is not authenticated with an owner OAuth profile",
    );
  }
  if (whoami.accounts.length !== 1) {
    throw new Error(
      "Wrangler owner authentication must resolve to exactly one account",
    );
  }
  const [account] = whoami.accounts;
  if (
    !ACCOUNT_ID.test(account?.id) ||
    typeof account?.name !== "string" ||
    account.name.length < 1 ||
    account.name.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(account.name)
  ) {
    throw new Error("Wrangler returned an unsafe owner account identity");
  }

  const credential = parseJson(tokenRaw, "Wrangler auth token output");
  if (
    !credential ||
    typeof credential !== "object" ||
    Array.isArray(credential)
  ) {
    throw new Error("Wrangler did not return an OAuth token object");
  }
  if (
    JSON.stringify(Object.keys(credential).sort()) !==
    JSON.stringify(["token", "type"])
  ) {
    throw new Error("Wrangler OAuth token output has unexpected fields");
  }
  if (
    credential.type !== "oauth" ||
    typeof credential.token !== "string" ||
    credential.token.length < 16 ||
    Buffer.byteLength(credential.token) > 8192 ||
    !/^[\x21-\x7e]+$/u.test(credential.token)
  ) {
    throw new Error("Wrangler did not return a safe OAuth token");
  }
  return { accountId: account.id, token: credential.token };
}

export function parsePagesDeployIdentity(rawOutput, { commit }) {
  const entries = String(rawOutput)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseJson(line, "Wrangler structured output line"));
  const summaries = entries.filter((entry) => entry?.type === "pages-deploy");
  const details = entries.filter(
    (entry) => entry?.type === "pages-deploy-detailed",
  );
  if (summaries.length !== 1 || details.length !== 1) {
    throw new Error(
      "Wrangler structured output did not contain exactly one Pages deployment identity",
    );
  }
  const [summary] = summaries;
  const [detail] = details;
  const deploymentId = detail.deployment_id;
  if (!UUID.test(deploymentId) || summary.deployment_id !== deploymentId) {
    throw new Error("Wrangler Pages deployment id is absent or inconsistent");
  }
  if (summary.pages_project !== PROJECT || detail.pages_project !== PROJECT) {
    throw new Error(
      "Wrangler Pages project identity does not match the owner target",
    );
  }
  const url = deploymentUrl(detail.url);
  if (deploymentUrl(summary.url) !== url) {
    throw new Error("Wrangler Pages deployment URLs are inconsistent");
  }
  if (
    detail.environment !== "production" ||
    detail.production_branch !== PRODUCTION_BRANCH
  ) {
    throw new Error(
      "Wrangler Pages deployment is not the main production target",
    );
  }
  const outputCommit = detail.deployment_trigger?.metadata?.commit_hash;
  if (outputCommit !== commit) {
    throw new Error(
      "Wrangler Pages deployment commit identity does not match the reviewed source",
    );
  }
  return {
    deploymentId,
    deploymentUrl: url,
    commit,
    environment: "production",
    productionBranch: PRODUCTION_BRANCH,
  };
}

export function requireCanonicalPublishedDeployment(authority, identity) {
  if (
    authority?.authority !== "cloudflare-pages-project.canonical_deployment" ||
    authority?.project !== PROJECT ||
    authority?.deploymentId !== identity.deploymentId ||
    authority?.deploymentUrl !== identity.deploymentUrl ||
    authority?.branch !== identity.productionBranch ||
    authority?.source !== identity.commit ||
    authority?.publicOrigin !== PUBLIC_ORIGIN
  ) {
    throw new Error(
      "published identity is not the canonical production deployment",
    );
  }
  return authority;
}

function assertSafeSitePath(path) {
  if (
    path === "" ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`unsafe committed site path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`unsafe committed site path: ${JSON.stringify(path)}`);
  }
}

export function parseCommittedSiteTree(rawTree) {
  const bytes = Buffer.isBuffer(rawTree) ? rawTree : Buffer.from(rawTree);
  if (bytes.length === 0 || bytes.at(-1) !== 0) {
    throw new Error("committed site tree is empty or not NUL-delimited");
  }

  const entries = [];
  const seen = new Set();
  let offset = 0;
  while (offset < bytes.length - 1) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw new Error("committed site tree is not NUL-delimited");
    let record;
    try {
      record = UTF8.decode(bytes.subarray(offset, end));
    } catch {
      throw new Error("committed site tree contains a non-UTF-8 path");
    }
    offset = end + 1;

    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.+)$/u.exec(record);
    if (!match) throw new Error("committed site tree has an invalid record");
    const [, mode, type, oid, committedPath] = match;
    if (mode !== "100644" || type !== "blob") {
      throw new Error(
        `committed site entry ${JSON.stringify(committedPath)} is ${mode} ${type}; only regular non-executable blobs are publishable`,
      );
    }
    if (!committedPath.startsWith("site/")) {
      throw new Error(
        `committed site entry escaped site/: ${JSON.stringify(committedPath)}`,
      );
    }
    const path = committedPath.slice("site/".length);
    assertSafeSitePath(path);
    if (seen.has(path)) {
      throw new Error(
        `committed site path is duplicated: ${JSON.stringify(path)}`,
      );
    }
    seen.add(path);
    entries.push({ oid, path });
  }

  if (entries.length === 0) throw new Error("committed site tree has no files");
  if (entries.length > MAX_PAGES_ASSET_COUNT) {
    throw new Error(
      `committed site tree has ${entries.length} files, exceeding the Pages limit ${MAX_PAGES_ASSET_COUNT}`,
    );
  }
  return entries.sort((left, right) => comparePaths(left.path, right.path));
}

function confinedPath(root, path) {
  assertSafeSitePath(path);
  const target = resolve(root, ...path.split("/"));
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`site path escaped custody: ${JSON.stringify(path)}`);
  }
  return target;
}

function writeExclusiveFile(path, bytes, mode = 0o600) {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    if (fstatSync(fd).nlink !== 1) {
      throw new Error(`${path} has multiple hard links during creation`);
    }
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    if (fstatSync(fd).nlink !== 1) {
      throw new Error(`${path} has multiple hard links after creation`);
    }
  } finally {
    closeSync(fd);
  }
}

function directoryPaths(files) {
  const directories = new Set([""]);
  for (const file of files) {
    let current = posix.dirname(file.path);
    while (current !== ".") {
      directories.add(current);
      current = posix.dirname(current);
    }
  }
  return [...directories].sort(
    (left, right) => right.split("/").length - left.split("/").length,
  );
}

export function sealCommittedSite({
  baseDirectory,
  commit,
  entries,
  readBlob,
}) {
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error(`invalid source commit: ${JSON.stringify(commit)}`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("cannot seal an empty committed site tree");
  }

  const releaseRoot = mkdtempSync(
    resolve(baseDirectory, "yurucommu-site-release-"),
  );
  const custodyRoot = join(releaseRoot, "custody");
  const siteRoot = join(custodyRoot, "site");
  const wranglerCwd = join(releaseRoot, "wrangler-cwd");
  const outputPath = join(releaseRoot, "wrangler-output.ndjson");
  mkdirSync(siteRoot, { recursive: true, mode: 0o700 });
  mkdirSync(wranglerCwd, { mode: 0o700 });

  try {
    const files = [];
    const seen = new Set();
    for (const entry of [...entries].sort((left, right) =>
      comparePaths(left.path, right.path),
    )) {
      assertSafeSitePath(entry.path);
      if (!/^[0-9a-f]{40,64}$/u.test(entry.oid)) {
        throw new Error(`invalid blob id for ${JSON.stringify(entry.path)}`);
      }
      if (seen.has(entry.path)) {
        throw new Error(`committed site path is duplicated: ${entry.path}`);
      }
      seen.add(entry.path);
      const bytes = Buffer.from(readBlob(entry.oid));
      if (bytes.length > MAX_PAGES_ASSET_BYTES) {
        throw new Error(
          `${entry.path} is ${bytes.length} bytes, exceeding the Pages per-file limit`,
        );
      }
      const target = confinedPath(siteRoot, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeExclusiveFile(target, bytes);
      chmodSync(target, SAFE_FILE_MODE);
      files.push({
        path: entry.path,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }

    const siteTree = { kind: "yurucommu.site-tree@v1", files };
    const treeDigest = sha256(canonicalJson(siteTree));
    const manifest = {
      kind: "yurucommu.site-release-manifest@v1",
      commit,
      treeDigest,
      files,
    };
    const manifestBytes = canonicalJson(manifest);
    const manifestDigest = sha256(manifestBytes);
    const manifestPath = join(releaseRoot, "site-release-manifest.json");
    writeExclusiveFile(manifestPath, manifestBytes);
    chmodSync(manifestPath, SAFE_FILE_MODE);

    for (const directory of directoryPaths(files)) {
      chmodSync(
        directory === "" ? siteRoot : confinedPath(siteRoot, directory),
        SAFE_DIRECTORY_MODE,
      );
    }
    chmodSync(custodyRoot, SAFE_DIRECTORY_MODE);

    const candidate = {
      releaseRoot,
      custodyRoot,
      siteRoot,
      wranglerCwd,
      outputPath,
      manifestPath,
      manifest,
      manifestDigest,
      treeDigest,
      directoryFd: null,
    };
    verifySealedSite(candidate);
    return candidate;
  } catch (error) {
    const incomplete = { releaseRoot, directoryFd: null };
    disposeSealedSite(incomplete);
    throw error;
  }
}

function stableRead(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`${path} is not a regular file`);
    if (before.nlink !== 1) {
      throw new Error(`${path} has multiple hard links`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.nlink !== 1) {
      throw new Error(`${path} has multiple hard links`);
    }
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) {
      if (before[field] !== after[field]) {
        throw new Error(`${path} changed while it was being read`);
      }
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function inspectCustodyTree(root, relativeRoot = "") {
  const found = [];
  const directory =
    relativeRoot === "" ? root : confinedPath(root, relativeRoot);
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(
      `sealed candidate changed: ${relativeRoot || "."} is not a directory`,
    );
  }
  if ((directoryStat.mode & 0o777) !== SAFE_DIRECTORY_MODE) {
    throw new Error(
      `sealed candidate changed: ${relativeRoot || "."} directory mode is not read-only`,
    );
  }
  for (const name of readdirSync(directory).sort()) {
    const path = relativeRoot === "" ? name : `${relativeRoot}/${name}`;
    assertSafeSitePath(path);
    const target = confinedPath(root, path);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `sealed candidate changed: ${path} became a symbolic link`,
      );
    }
    if (stat.isDirectory()) found.push(...inspectCustodyTree(root, path));
    else if (stat.isFile()) found.push(path);
    else throw new Error(`sealed candidate changed: ${path} is a special file`);
  }
  return found;
}

export function verifySealedSite(candidate) {
  const actualPaths = inspectCustodyTree(candidate.siteRoot);
  const expectedPaths = candidate.manifest.files.map((file) => file.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      "sealed candidate changed: file inventory no longer matches",
    );
  }

  const verifiedFiles = [];
  for (const expected of candidate.manifest.files) {
    const path = confinedPath(candidate.siteRoot, expected.path);
    const stat = lstatSync(path);
    if (stat.nlink !== 1) {
      throw new Error(
        `sealed candidate changed: ${expected.path} has multiple hard links`,
      );
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== SAFE_FILE_MODE
    ) {
      throw new Error(
        `sealed candidate changed: ${expected.path} is not a read-only regular file`,
      );
    }
    const bytes = stableRead(path);
    const actual = {
      path: expected.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `sealed candidate changed: ${expected.path} bytes no longer match`,
      );
    }
    verifiedFiles.push(actual);
  }
  const treeDigest = sha256(
    canonicalJson({ kind: "yurucommu.site-tree@v1", files: verifiedFiles }),
  );
  if (treeDigest !== candidate.treeDigest) {
    throw new Error("sealed candidate changed: tree digest no longer matches");
  }
  const manifestBytes = stableRead(candidate.manifestPath);
  if (sha256(manifestBytes) !== candidate.manifestDigest) {
    throw new Error(
      "sealed candidate changed: release manifest no longer matches",
    );
  }
  return { files: verifiedFiles.length, treeDigest };
}

function candidateBytes(candidate, path) {
  const expected = candidate.manifest.files.find((file) => file.path === path);
  if (!expected) throw new Error(`required site file is missing: ${path}`);
  const bytes = stableRead(confinedPath(candidate.siteRoot, path));
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw new Error(`sealed candidate changed: ${path} bytes no longer match`);
  }
  return bytes;
}

function parsePagesHeaders(source) {
  const routes = new Map();
  let route = null;
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(rawLine)) {
      route = rawLine.trim();
      if (!route.startsWith("/") || route.includes("\\")) {
        throw new Error(
          `unsafe route in site/_headers: ${JSON.stringify(route)}`,
        );
      }
      if (routes.has(route)) {
        throw new Error(`duplicate route in site/_headers: ${route}`);
      }
      routes.set(route, new Map());
      continue;
    }
    if (!route) throw new Error("site/_headers starts with an orphan header");
    const match = /^\s+([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s*(.+?)\s*$/u.exec(
      rawLine,
    );
    if (!match) throw new Error(`invalid header under ${route}`);
    const name = match[1].toLowerCase();
    const headers = routes.get(route);
    if (headers.has(name)) {
      throw new Error(`duplicate ${name} header under ${route}`);
    }
    headers.set(name, match[2]);
  }
  return routes;
}

function requiredJsonLdHeaders(routes, route) {
  const headers = routes.get(route);
  if (!headers) throw new Error(`site/_headers has no ${route} rule`);
  const expected = {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=3600",
    "content-type": "application/ld+json",
  };
  for (const [name, value] of Object.entries(expected)) {
    if (headers.get(name) !== value) {
      throw new Error(`site/_headers ${route} must set ${name}: ${value}`);
    }
  }
  return expected;
}

function resolvedInternalPath(fromPath, reference) {
  const decoded = reference.replaceAll("&amp;", "&").trim();
  if (decoded === "" || decoded.startsWith("#")) return null;
  if (/^(?:data|mailto|tel):/iu.test(decoded)) return null;
  if (/^javascript:/iu.test(decoded)) {
    throw new Error(`unsafe javascript URL in ${fromPath}`);
  }
  let url;
  try {
    url = new URL(decoded, `https://yurucommu.com/${fromPath}`);
  } catch {
    throw new Error(`invalid internal reference in ${fromPath}`);
  }
  if (url.origin !== "https://yurucommu.com") return null;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new Error(`invalid escaped internal reference in ${fromPath}`);
  }
  const relativePath = pathname.replace(/^\/+/, "");
  const target = pathname.endsWith("/")
    ? `${relativePath}index.html`
    : relativePath;
  assertSafeSitePath(target);
  return target;
}

const CREDENTIAL_FILE = /(?:^|\/)\.env(?:\.|$)|\.(?:pem|p12|pfx|key)$/iu;
const CREDENTIAL_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk_live_[0-9A-Za-z]{16,}\b/u,
  /\bgh[pousr]_[0-9A-Za-z]{30,}\b/u,
  /\b(?:CLOUDFLARE|CF)_API_(?:TOKEN|KEY)\s*[=:]\s*[^\s<]+/u,
];

export function validateSealedSiteContent(candidate) {
  verifySealedSite(candidate);
  const files = new Set(candidate.manifest.files.map((file) => file.path));
  let decodedTextBytes = 0;
  for (const path of files) {
    if (
      path === "_worker.js" ||
      path === "_routes.json" ||
      path === "functions" ||
      path.startsWith("functions/") ||
      path === ".wrangler" ||
      path.startsWith(".wrangler/") ||
      path === ".git" ||
      path.startsWith(".git/")
    ) {
      throw new Error(
        `dynamic or repository control file is not publishable: ${path}`,
      );
    }
    if (CREDENTIAL_FILE.test(path)) {
      throw new Error(`credential-shaped file is not publishable: ${path}`);
    }
    const bytes = candidateBytes(candidate, path);
    let source;
    try {
      source = UTF8.decode(bytes);
    } catch {
      continue;
    }
    decodedTextBytes += bytes.length;
    if (decodedTextBytes > MAX_TEXT_SCAN_BYTES) {
      throw new Error(
        "decodable site text exceeded the bounded credential scan budget",
      );
    }
    if (CREDENTIAL_CONTENT.some((shape) => shape.test(source))) {
      throw new Error(`credential-shaped content is not publishable: ${path}`);
    }
  }

  for (const path of files) {
    if (path.endsWith(".json") || path.endsWith(".jsonld")) {
      try {
        JSON.parse(candidateBytes(candidate, path).toString("utf8"));
      } catch {
        throw new Error(`invalid JSON in published site file: ${path}`);
      }
    }
    if (path.endsWith(".jsonl")) {
      const lines = candidateBytes(candidate, path)
        .toString("utf8")
        .split(/\r?\n/u)
        .filter((line) => line.trim() !== "");
      try {
        for (const line of lines) JSON.parse(line);
      } catch {
        throw new Error(`invalid JSONL in published site file: ${path}`);
      }
    }
  }

  const headerRoutes = parsePagesHeaders(
    candidateBytes(candidate, "_headers").toString("utf8"),
  );
  for (const path of files) {
    if (path.endsWith(".jsonld")) {
      requiredJsonLdHeaders(headerRoutes, `/${path}`);
    }
  }

  let internalReferences = 0;
  let homePageInstallCtaOccurrences = 0;
  for (const path of files) {
    if (!path.endsWith(".html")) continue;
    const html = candidateBytes(candidate, path).toString("utf8");
    for (const match of html.matchAll(
      /\b(?:href|src)\s*=\s*["']([^"']+)["']/giu,
    )) {
      if (
        path === "index.html" &&
        match[1].replaceAll("&amp;", "&") === INSTALL_CTA_URL
      ) {
        homePageInstallCtaOccurrences += 1;
      }
      const target = resolvedInternalPath(path, match[1]);
      if (target === null) continue;
      internalReferences += 1;
      if (!files.has(target)) {
        throw new Error(`missing internal reference from ${path}: ${target}`);
      }
    }
  }
  if (homePageInstallCtaOccurrences < 1) {
    throw new Error(
      "published home page is missing the repository-owned Takosumi install CTA",
    );
  }

  const representatives = [
    { urlPath: "/", file: "index.html", contentType: "text/html" },
    { urlPath: "/help/", file: "help/index.html", contentType: "text/html" },
    { urlPath: "/specs/", file: "specs/index.html", contentType: "text/html" },
    {
      urlPath: "/ns/context.jsonld",
      file: "ns/context.jsonld",
      contentType: "application/ld+json",
      headers: requiredJsonLdHeaders(headerRoutes, "/ns/context.jsonld"),
    },
  ].map((entry) => {
    const expected = candidate.manifest.files.find(
      (file) => file.path === entry.file,
    );
    if (!expected)
      throw new Error(`required site file is missing: ${entry.file}`);
    return { ...entry, bytes: expected.bytes, sha256: expected.sha256 };
  });

  return {
    representatives,
    internalReferences,
    installCta: {
      href: INSTALL_CTA_URL,
      occurrences: homePageInstallCtaOccurrences,
    },
  };
}

function normalizedMediaType(value) {
  return String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

async function boundedResponseBytes(
  response,
  maxBytes = MAX_PAGES_ASSET_BYTES,
) {
  const declared = response.headers.get("content-length");
  if (/^\d+$/u.test(declared ?? "") && Number(declared) > maxBytes) {
    throw new Error("RESPONSE_EXCEEDED_BYTE_BOUND");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel("response exceeded byte bound");
        throw new Error("RESPONSE_EXCEEDED_BYTE_BOUND");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readCurrentProductionRepresentative({
  origin,
  representative,
  deploymentId,
  attempt,
  fetchImpl,
}) {
  const url = new URL(representative.urlPath, `${origin}/`);
  url.searchParams.set("__yurucommu_canonical", deploymentId);
  url.searchParams.set("attempt", String(attempt));
  const response = await fetchImpl(url.toString(), {
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    redirect: "manual",
  });
  if (response.status !== 200) throw new Error(`HTTP_${response.status}`);
  const contentType = normalizedMediaType(response.headers.get("content-type"));
  if (contentType !== representative.contentType) {
    throw new Error(`CONTENT_TYPE_${contentType || "MISSING"}`);
  }
  const headers = {};
  for (const [name, expected] of Object.entries(representative.headers ?? {})) {
    if (name === "content-type") continue;
    const actual = response.headers.get(name);
    if (actual !== expected) {
      throw new Error(`HEADER_${name.toUpperCase()}_MISMATCH`);
    }
    headers[name] = actual;
  }
  const body = await boundedResponseBytes(response);
  return {
    origin,
    urlPath: representative.urlPath,
    body,
    bytes: body.length,
    sha256: sha256(body),
    contentType,
    headers,
  };
}

export async function verifyCurrentProductionBinding({
  authority,
  representatives,
  fetchImpl = fetch,
  attempts = 4,
  sleep = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
}) {
  if (
    authority?.authority !== "cloudflare-pages-project.canonical_deployment" ||
    authority?.project !== PROJECT ||
    !UUID.test(authority?.deploymentId) ||
    deploymentUrl(authority?.deploymentUrl) !== authority.deploymentUrl ||
    authority?.publicOrigin !== PUBLIC_ORIGIN
  ) {
    throw new Error("invalid canonical production authority for byte binding");
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 8) {
    throw new Error(
      "current production binding attempts must be between 1 and 8",
    );
  }
  let lastFailure = "NOT_ATTEMPTED";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const readbacks = await Promise.all(
        representatives.map(async (representative) => {
          const [immutable, publicReadback] = await Promise.all(
            [authority.deploymentUrl, PUBLIC_ORIGIN].map((origin) =>
              readCurrentProductionRepresentative({
                origin,
                representative,
                deploymentId: authority.deploymentId,
                attempt,
                fetchImpl,
              }),
            ),
          );
          if (
            !immutable.body.equals(publicReadback.body) ||
            immutable.contentType !== publicReadback.contentType ||
            JSON.stringify(immutable.headers) !==
              JSON.stringify(publicReadback.headers)
          ) {
            throw new Error(
              `${representative.urlPath} public bytes do not match canonical_deployment`,
            );
          }
          return {
            urlPath: representative.urlPath,
            bytes: immutable.bytes,
            sha256: immutable.sha256,
            contentType: immutable.contentType,
            headers: immutable.headers,
            status: "CURRENT_CANONICAL_BYTES",
          };
        }),
      );
      return {
        bindingDigest: sha256(
          canonicalJson({
            kind: "yurucommu.current-production-binding@v1",
            deploymentId: authority.deploymentId,
            deploymentUrl: authority.deploymentUrl,
            publicOrigin: PUBLIC_ORIGIN,
            readbacks,
          }),
        ),
        readbacks,
      };
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      if (attempt < attempts) {
        await sleep(Math.min(2_000 * attempt, 8_000));
      }
    }
  }
  throw new Error(
    `current yurucommu.com does not match canonical_deployment (${lastFailure})`,
  );
}

async function readRepresentative({
  origin,
  representative,
  treeDigest,
  attempt,
  fetchImpl,
}) {
  const url = new URL(representative.urlPath, `${origin}/`);
  url.searchParams.set("__yurucommu_release", treeDigest.slice(0, 24));
  url.searchParams.set("attempt", String(attempt));
  const response = await fetchImpl(url.toString(), {
    headers: {
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    redirect: "manual",
  });
  if (response.status !== 200) {
    throw new Error(`HTTP_${response.status}`);
  }
  const actualType = normalizedMediaType(response.headers.get("content-type"));
  if (actualType !== representative.contentType) {
    throw new Error(`CONTENT_TYPE_${actualType || "MISSING"}`);
  }
  for (const [name, expected] of Object.entries(representative.headers ?? {})) {
    if (name === "content-type") continue;
    const actual = response.headers.get(name);
    if (actual !== expected) {
      throw new Error(`HEADER_${name.toUpperCase()}_MISMATCH`);
    }
  }
  const bytes = await boundedResponseBytes(response);
  const actualDigest = sha256(bytes);
  if (
    bytes.length !== representative.bytes ||
    actualDigest !== representative.sha256
  ) {
    throw new Error(`BYTES_SHA256_${actualDigest.slice(0, 16)}_MISMATCH`);
  }
  return {
    origin,
    urlPath: representative.urlPath,
    bytes: bytes.length,
    sha256: actualDigest,
    contentType: actualType,
    status: "EXPECTED_CANDIDATE",
  };
}

export async function verifyRepresentativeReadbacks({
  origins,
  representatives,
  treeDigest,
  fetchImpl = fetch,
  attempts = 8,
  sleep = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 12) {
    throw new Error(
      "representative readback attempts must be between 1 and 12",
    );
  }
  const pending = origins.flatMap((origin) =>
    representatives.map((representative) => ({
      key: `${origin}${representative.urlPath}`,
      origin,
      representative,
      last: "NOT_ATTEMPTED",
    })),
  );
  const verified = new Map();
  for (
    let attempt = 1;
    attempt <= attempts && pending.length > 0;
    attempt += 1
  ) {
    const round = await Promise.all(
      pending.map(async (target) => {
        try {
          const result = await readRepresentative({
            ...target,
            treeDigest,
            attempt,
            fetchImpl,
          });
          return { target, result };
        } catch (error) {
          return {
            target,
            error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
          };
        }
      }),
    );
    for (const outcome of round) {
      const index = pending.indexOf(outcome.target);
      if ("result" in outcome) {
        verified.set(outcome.target.key, outcome.result);
        if (index >= 0) pending.splice(index, 1);
      } else {
        outcome.target.last = outcome.error;
      }
    }
    if (pending.length > 0 && attempt < attempts) {
      await sleep(Math.min(2_000 * attempt, 8_000));
    }
  }
  if (pending.length > 0) {
    const failures = pending
      .map((target) => `${target.key}: ${target.last}`)
      .join(", ");
    throw new Error(
      `representative readback did not converge to the sealed candidate (${failures})`,
    );
  }
  return origins.flatMap((origin) =>
    representatives.map((representative) =>
      verified.get(`${origin}${representative.urlPath}`),
    ),
  );
}

function makeWritableWithoutFollowing(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) {
      makeWritableWithoutFollowing(join(path, entry));
    }
  } else if (stat.isFile()) {
    chmodSync(path, 0o600);
  }
}

export function disposeSealedSite(candidate) {
  if (candidate.directoryFd !== null && candidate.directoryFd !== undefined) {
    try {
      closeSync(candidate.directoryFd);
    } catch {
      // The descriptor may already have been closed after publication.
    }
    candidate.directoryFd = null;
  }
  if (!candidate.releaseRoot) return;
  makeWritableWithoutFollowing(candidate.releaseRoot);
  rmSync(candidate.releaseRoot, { recursive: true, force: true });
}

class CommandFailure extends Error {
  constructor(command, result) {
    super(`${command} exited ${result.status ?? "without a status"}`);
    this.name = "CommandFailure";
    this.stdout = Buffer.from(result.stdout ?? "").toString("utf8");
    this.stderr = Buffer.from(result.stderr ?? "").toString("utf8");
  }
}

export class YurucommuSiteReleaseFailure extends Error {
  constructor(message, { phase, evidence = {}, provider = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "YurucommuSiteReleaseFailure";
    this.phase = phase ?? "PRE_TOUCH_FAILURE";
    this.evidence = evidence;
    this.provider = provider;
  }
}

function runCommand(
  command,
  args,
  {
    cwd = REPO,
    env = process.env,
    inherit = false,
    extraFileDescriptor = null,
    maxBuffer = 32 * 1024 * 1024,
  } = {},
) {
  const stdio = inherit
    ? ["ignore", "inherit", "inherit"]
    : extraFileDescriptor === null
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe", extraFileDescriptor];
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio,
    maxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new CommandFailure(`${command} ${args.join(" ")}`, result);
  }
  return {
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? ""),
  };
}

function gitBytes(repo, args, maxBuffer) {
  return runCommand("git", args, { cwd: repo, maxBuffer }).stdout;
}

function gitText(repo, args) {
  return gitBytes(repo, args).toString("utf8").trim();
}

function proveReviewedPushedSource(repo, expectedCommit = null) {
  const dirty = gitText(repo, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (dirty !== "") {
    throw new Error(
      `the worktree is not clean; published bytes must belong to one reviewed commit (${dirty.split("\n").slice(0, 20).join(", ")})`,
    );
  }
  const localBranch = gitText(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const localRef = localBranch === "HEAD" ? "detached HEAD" : localBranch;
  const commit = gitText(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error("git did not return a full source commit identity");
  }
  if (expectedCommit !== null && commit !== expectedCommit) {
    throw new Error("source commit changed during release preparation");
  }
  runCommand(
    "git",
    [
      "fetch",
      "--quiet",
      "origin",
      `refs/heads/${PRODUCTION_BRANCH}:refs/remotes/origin/${PRODUCTION_BRANCH}`,
    ],
    { cwd: repo },
  );
  const remoteCommit = gitText(repo, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${PRODUCTION_BRANCH}^{commit}`,
  ]);
  if (remoteCommit !== commit) {
    throw new Error(
      `local ${PRODUCTION_BRANCH} ${commit} does not equal freshly fetched origin/${PRODUCTION_BRANCH} ${remoteCommit}`,
    );
  }
  const subject = gitText(repo, [
    "show",
    "-s",
    "--format=%s",
    "--no-show-signature",
    commit,
  ]);
  if (subject === "") throw new Error("source commit has no release message");
  return { localRef, commit, subject };
}

function sealReviewedCommit(repo, source) {
  const rawTree = gitBytes(repo, [
    "ls-tree",
    "-rz",
    "--full-tree",
    source.commit,
    "--",
    "site",
  ]);
  const entries = parseCommittedSiteTree(rawTree);
  return sealCommittedSite({
    baseDirectory: tmpdir(),
    commit: source.commit,
    entries,
    readBlob(oid) {
      return gitBytes(
        repo,
        ["cat-file", "blob", oid],
        MAX_PAGES_ASSET_BYTES + 1,
      );
    },
  });
}

function wranglerCli(repo) {
  const packageRoot = resolve(repo, "node_modules", "wrangler");
  const configured = resolve(packageRoot, "wrangler-dist", "cli.js");
  if (!existsSync(configured)) {
    throw new Error(
      "the owner-locked Wrangler CLI is missing; run the repository install before release",
    );
  }
  const actual = realpathSync(configured);
  const relativeToPackage = relative(packageRoot, actual);
  if (
    relativeToPackage === "" ||
    relativeToPackage === ".." ||
    relativeToPackage.startsWith(`..${sep}`) ||
    !statSync(actual).isFile()
  ) {
    throw new Error(
      "the owner-locked Wrangler CLI escaped its package custody",
    );
  }
  return actual;
}

function cleanWranglerEnvironment(outputPath = null) {
  const environment = { ...process.env };
  const forbiddenExact = new Set(
    [
      "BUN_OPTIONS",
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "CLOUDFLARE_API_BASE_URL",
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_EMAIL",
      "CLOUDFLARE_ACCOUNT_ID",
      "CF_API_BASE_URL",
      "CF_API_KEY",
      "CF_API_TOKEN",
      "CF_API_EMAIL",
      "CF_ACCOUNT_ID",
      "WRANGLER_API_ENVIRONMENT",
      "WRANGLER_OUTPUT_FILE_DIRECTORY",
      "WRANGLER_OUTPUT_FILE_PATH",
      "SSH_AUTH_SOCK",
      "SSH_ASKPASS",
      "GPG_AGENT_INFO",
    ].map((name) => name.toUpperCase()),
  );
  for (const name of Object.keys(environment)) {
    const canonical = name.toUpperCase();
    if (
      forbiddenExact.has(canonical) ||
      canonical.startsWith("LD_") ||
      canonical.startsWith("DYLD_") ||
      canonical.startsWith("__XPC_DYLD_") ||
      canonical === "GLIBC_TUNABLES" ||
      canonical.startsWith("GIT_CONFIG_") ||
      canonical === "GIT_CONFIG" ||
      canonical.startsWith("NPM_CONFIG_PROXY")
    ) {
      delete environment[name];
    }
  }
  environment.FORCE_COLOR = "0";
  environment.WRANGLER_LOG_SANITIZE = "true";
  if (outputPath !== null) environment.WRANGLER_OUTPUT_FILE_PATH = outputPath;
  return environment;
}

function runWrangler(
  repo,
  candidate,
  args,
  { directoryFd = null, outputPath = null, maxBuffer = 64 * 1024 * 1024 } = {},
) {
  return runCommand(process.execPath, [wranglerCli(repo), ...args], {
    cwd: candidate.wranglerCwd,
    env: cleanWranglerEnvironment(outputPath),
    extraFileDescriptor: directoryFd,
    maxBuffer,
  });
}

function acquireWranglerReleaseAuthority(repo, candidate) {
  let whoami;
  try {
    whoami = runWrangler(repo, candidate, ["whoami", "--json"], {
      maxBuffer: MAX_AUTH_OUTPUT_BYTES,
    });
  } catch {
    throw new Error(
      "Wrangler owner OAuth account discovery failed; credential output was discarded",
    );
  }

  let token;
  try {
    token = runWrangler(repo, candidate, ["auth", "token", "--json"], {
      maxBuffer: MAX_AUTH_OUTPUT_BYTES,
    });
  } catch {
    throw new Error(
      "Wrangler owner OAuth token acquisition failed; credential output was discarded",
    );
  }

  try {
    return parseWranglerReleaseAuthority(
      whoami.stdout.toString("utf8"),
      token.stdout.toString("utf8"),
    );
  } finally {
    whoami.stdout.fill(0);
    whoami.stderr.fill(0);
    token.stdout.fill(0);
    token.stderr.fill(0);
  }
}

async function readCanonicalProductionAuthority(credential, fetchImpl = fetch) {
  const endpoint = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${credential.accountId}/pages/projects/${PROJECT}`,
  );
  let response;
  try {
    response = await fetchImpl(endpoint.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential.token}`,
        "cache-control": "no-store",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      "Cloudflare Pages canonical project authority request failed",
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `Cloudflare Pages canonical project authority returned HTTP_${response.status}`,
    );
  }
  if (
    normalizedMediaType(response.headers.get("content-type")) !==
    "application/json"
  ) {
    throw new Error(
      "Cloudflare Pages canonical project authority was not JSON",
    );
  }
  let bytes;
  try {
    bytes = await boundedResponseBytes(response, MAX_PROJECT_RESPONSE_BYTES);
  } catch {
    throw new Error(
      "Cloudflare Pages canonical project authority response exceeded the safe bound",
    );
  }
  let raw;
  try {
    raw = UTF8.decode(bytes);
  } catch {
    throw new Error(
      "Cloudflare Pages canonical project authority response was not UTF-8",
    );
  }
  return parseCanonicalProductionProject(raw);
}

function requireUnchangedCanonicalAuthority(before, after) {
  const fields = [
    "authority",
    "project",
    "projectId",
    "deploymentId",
    "deploymentUrl",
    "branch",
    "source",
    "publicOrigin",
    "automaticProductionDeployments",
  ];
  if (fields.some((field) => before?.[field] !== after?.[field])) {
    throw new Error(
      "canonical production authority changed during the pre-touch byte binding",
    );
  }
  return after;
}

function openSealedDirectory(candidate) {
  const fd = openSync(
    candidate.siteRoot,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  const stat = fstatSync(fd);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== SAFE_DIRECTORY_MODE) {
    closeSync(fd);
    throw new Error("sealed candidate root is not a read-only directory");
  }
  candidate.directoryFd = fd;
  return fd;
}

function providerText(result) {
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

const MAX_PROVIDER_OUTPUT_BYTES = 64 * 1024;
const PEM_DIAGNOSTIC =
  /-----BEGIN (?<pemLabel>(?:(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?|(?:TRUSTED |X509 )?CERTIFICATE|(?:NEW )?CERTIFICATE REQUEST|X509 CRL|(?:RSA )?PUBLIC KEY|PKCS7|CMS|ATTRIBUTE CERTIFICATE))-----[\s\S]*?(?:-----END \k<pemLabel>-----|$)/gu;

function boundedProviderOutput(value) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= MAX_PROVIDER_OUTPUT_BYTES) return bytes.toString("utf8");
  let bounded = bytes.subarray(0, MAX_PROVIDER_OUTPUT_BYTES).toString("utf8");
  while (Buffer.byteLength(bounded) > MAX_PROVIDER_OUTPUT_BYTES) {
    bounded = bounded.slice(0, -1);
  }
  return bounded;
}

export function sanitizeProviderOutput(value) {
  const sanitized = boundedProviderOutput(value)
    .replace(PEM_DIAGNOSTIC, "[REDACTED PEM]")
    .replace(
      /((?:^|[\s,{;])["']?authorization["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)/gimu,
      "$1[REDACTED]",
    )
    .replace(/\bBearer[\t ]+[^\s"',;}\]]+/giu, "Bearer [REDACTED]")
    .replace(
      /((?:^|[\s,{;&?])["']?(?:(?:CLOUDFLARE|CF)_(?:API_)?(?:TOKEN|KEY)|X-AUTH-KEY|API_TOKEN)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\r\n]+)/gimu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:gh[pousr]_[0-9A-Za-z]{20,}|sk_live_[0-9A-Za-z]{16,}|AKIA[0-9A-Z]{16})\b/gu,
      "[REDACTED]",
    );
  return boundedProviderOutput(sanitized);
}

function releaseEvidence({ source, candidate, previous, identity }) {
  return {
    ...(source
      ? {
          commit: source.commit,
          sourceRef: source.localRef,
          sourceRemote: `origin/${PRODUCTION_BRANCH}`,
          productionBranch: PRODUCTION_BRANCH,
        }
      : {}),
    ...(candidate
      ? {
          siteTreeDigest: candidate.treeDigest,
          siteManifestDigest: candidate.manifestDigest,
          files: candidate.manifest.files.length,
        }
      : {}),
    previousDeployment: previous
      ? {
          authority: previous.authority,
          projectId: previous.projectId,
          deploymentId: previous.deploymentId,
          deploymentUrl: previous.deploymentUrl,
          branch: previous.branch,
          source: previous.source,
          publicOrigin: previous.publicOrigin,
          automaticProductionDeployments:
            previous.automaticProductionDeployments,
          preMutationBindingDigest: previous.preMutationBindingDigest,
        }
      : null,
    ...(identity
      ? {
          deploymentId: identity.deploymentId,
          deploymentUrl: identity.deploymentUrl,
        }
      : {}),
  };
}

function asReleaseFailure(error, phase, context, provider = null) {
  if (error instanceof YurucommuSiteReleaseFailure) return error;
  return new YurucommuSiteReleaseFailure(
    error instanceof Error ? error.message : "unknown site release failure",
    {
      phase,
      evidence: releaseEvidence(context),
      provider:
        provider ??
        (error instanceof CommandFailure
          ? { stdout: error.stdout, stderr: error.stderr }
          : null),
      cause: error instanceof Error ? error : undefined,
    },
  );
}

async function requireAuthoritativeDeployment(credential, identity, previous) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const authority = await readCanonicalProductionAuthority(credential);
      if (authority.deploymentId === identity.deploymentId) {
        return requireCanonicalPublishedDeployment(authority, identity);
      }
      if (authority.deploymentId !== previous.deploymentId) {
        throw new Error(
          "canonical production authority moved to an unexpected concurrent deployment",
        );
      }
      lastError = new Error(
        "published deployment has not become canonical production authority",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("unexpected concurrent deployment")
      ) {
        throw error;
      }
      lastError = error;
    }
    if (attempt < 4) {
      await new Promise((wake) => setTimeout(wake, 2_000 * attempt));
    }
  }
  throw lastError ?? new Error("canonical deployment readback failed");
}

export async function deployYurucommuSite({ repo = REPO } = {}) {
  let phase = "PRE_TOUCH_FAILURE";
  let source = null;
  let candidate = null;
  let credential = null;
  let previous = null;
  let identity = null;
  const context = () => ({ source, candidate, previous, identity });

  try {
    source = proveReviewedPushedSource(repo);
    process.stdout.write(
      `source ${source.commit} (${source.localRef}; verified origin/${PRODUCTION_BRANCH})\n`,
    );
    process.stdout.write("\n==> bun run check\n");
    runCommand("bun", ["run", "check"], { cwd: repo, inherit: true });
    proveReviewedPushedSource(repo, source.commit);

    candidate = sealReviewedCommit(repo, source);
    const content = validateSealedSiteContent(candidate);
    proveReviewedPushedSource(repo, source.commit);
    process.stdout.write(
      `candidate ${candidate.manifest.files.length} files, site tree sha256:${candidate.treeDigest}\n`,
    );
    process.stdout.write(
      `candidate manifest sha256:${candidate.manifestDigest}; ${content.internalReferences} internal references checked\n`,
    );

    credential = acquireWranglerReleaseAuthority(repo, candidate);
    const initialAuthority = await readCanonicalProductionAuthority(credential);
    const preMutationBinding = await verifyCurrentProductionBinding({
      authority: initialAuthority,
      representatives: content.representatives,
    });
    const confirmedAuthority = requireUnchangedCanonicalAuthority(
      initialAuthority,
      await readCanonicalProductionAuthority(credential),
    );
    previous = {
      ...confirmedAuthority,
      preMutationBindingDigest: preMutationBinding.bindingDigest,
      representativeReadbacks: preMutationBinding.readbacks,
    };
    process.stdout.write(
      `previous canonical production deployment ${previous.deploymentId} (${previous.deploymentUrl}); public binding sha256:${previous.preMutationBindingDigest}\n`,
    );

    proveReviewedPushedSource(repo, source.commit);
    verifySealedSite(candidate);
    writeExclusiveFile(candidate.outputPath, Buffer.alloc(0), 0o600);
    const directoryFd = openSealedDirectory(candidate);
    phase = "AMBIGUOUS_AFTER_TOUCH";
    process.stdout.write(`\n==> publishing sealed site/ to ${PROJECT}\n`);
    let publication;
    try {
      publication = runWrangler(
        repo,
        candidate,
        [
          "pages",
          "deploy",
          "/proc/self/fd/3",
          "--project-name",
          PROJECT,
          "--branch",
          PRODUCTION_BRANCH,
          "--commit-hash",
          source.commit,
          "--commit-message",
          source.subject,
          "--commit-dirty=false",
          "--skip-caching",
          "--no-bundle",
        ],
        { directoryFd, outputPath: candidate.outputPath },
      );
    } catch (error) {
      throw asReleaseFailure(error, phase, context());
    } finally {
      closeSync(directoryFd);
      candidate.directoryFd = null;
    }
    const provider = providerText(publication);
    if (provider.stdout !== "")
      process.stdout.write(sanitizeProviderOutput(provider.stdout));
    if (provider.stderr !== "")
      process.stderr.write(sanitizeProviderOutput(provider.stderr));

    chmodSync(candidate.outputPath, SAFE_FILE_MODE);
    try {
      identity = parsePagesDeployIdentity(
        stableRead(candidate.outputPath).toString("utf8"),
        { commit: source.commit },
      );
    } catch (error) {
      throw asReleaseFailure(error, phase, context(), provider);
    }
    phase = "POST_TOUCH_FAILURE";
    verifySealedSite(candidate);

    const authoritative = await requireAuthoritativeDeployment(
      credential,
      identity,
      previous,
    );
    const readbacks = await verifyRepresentativeReadbacks({
      origins: [identity.deploymentUrl, PUBLIC_ORIGIN],
      representatives: content.representatives,
      treeDigest: candidate.treeDigest,
      attempts: 6,
    });
    verifySealedSite(candidate);
    const publicHomeReadback = readbacks.find(
      (entry) => entry.origin === PUBLIC_ORIGIN && entry.urlPath === "/",
    );
    if (!publicHomeReadback) {
      throw new Error(
        "custom-domain home-page CTA readback evidence is missing",
      );
    }
    const finalAuthority = requireUnchangedCanonicalAuthority(
      authoritative,
      requireCanonicalPublishedDeployment(
        await readCanonicalProductionAuthority(credential),
        identity,
      ),
    );

    const result = {
      kind: "takos.deploy-result@v1",
      surface: SURFACE,
      target: TARGET,
      commit: source.commit,
      branch: PRODUCTION_BRANCH,
      sourceRef: source.localRef,
      sourceRemote: `origin/${PRODUCTION_BRANCH}`,
      siteTreeDigest: candidate.treeDigest,
      siteManifestDigest: candidate.manifestDigest,
      files: candidate.manifest.files.length,
      previousDeployment: {
        authority: previous.authority,
        projectId: previous.projectId,
        deploymentId: previous.deploymentId,
        deploymentUrl: previous.deploymentUrl,
        branch: previous.branch,
        source: previous.source,
        publicOrigin: previous.publicOrigin,
        automaticProductionDeployments: previous.automaticProductionDeployments,
        preMutationBindingDigest: previous.preMutationBindingDigest,
        representativeReadbacks: previous.representativeReadbacks,
      },
      deploymentId: identity.deploymentId,
      deploymentUrl: identity.deploymentUrl,
      authoritativeDeployment: finalAuthority,
      installCta: content.installCta,
      ctaReadback: {
        origin: PUBLIC_ORIGIN,
        urlPath: "/",
        href: INSTALL_CTA_URL,
        sha256: publicHomeReadback.sha256,
        status: "EXPECTED_CTA_BYTES",
      },
      representativeReadbacks: readbacks,
      postConditions: "EXACT_IMMUTABLE_AND_PUBLIC_BYTES_HEADERS",
      status: "PUBLISHED",
    };
    process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    throw asReleaseFailure(error, phase, context());
  } finally {
    if (credential) credential.token = "";
    if (candidate) disposeSealedSite(candidate);
  }
}

export function reportYurucommuSiteReleaseFailure(error) {
  const failure =
    error instanceof YurucommuSiteReleaseFailure
      ? error
      : asReleaseFailure(error, "PRE_TOUCH_FAILURE", {});
  if (failure.provider) {
    const stdout = sanitizeProviderOutput(failure.provider.stdout);
    const stderr = sanitizeProviderOutput(failure.provider.stderr);
    if (stdout !== "") process.stderr.write(`${stdout.trimEnd()}\n`);
    if (stderr !== "") process.stderr.write(`${stderr.trimEnd()}\n`);
  }
  process.stderr.write(
    `deploy blocked [${failure.phase}]: ${sanitizeProviderOutput(failure.message)}\n`,
  );
  if (failure.phase === "PRE_TOUCH_FAILURE") {
    process.stderr.write(
      "production was not touched by this adapter; fix the precondition before a fresh invocation.\n",
    );
  } else {
    const previous = failure.evidence?.previousDeployment?.deploymentId;
    process.stderr.write(
      `Do not retry or roll back blindly; reconcile Cloudflare Pages authority${previous ? ` against previous deployment ${previous}` : ""} first.\n`,
    );
  }
  const result = {
    kind: "takos.deploy-result@v1",
    surface: SURFACE,
    target: TARGET,
    ...failure.evidence,
    failurePhase: failure.phase,
    status: failure.phase === "PRE_TOUCH_FAILURE" ? "BLOCKED" : "INDETERMINATE",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
