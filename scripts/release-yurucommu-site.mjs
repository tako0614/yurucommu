import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "site";
const PROJECT = "yurucommu-website";
const PUBLIC_ORIGIN = "https://yurucommu.com";
const SURFACE = "yurucommu-site";
const CHECK = ["bun", "run", "check:site"];
const ENVIRONMENTS = new Set(["integration", "production"]);
const IMMUTABLE_HOST = new RegExp(
  `^[a-z0-9-]+\\.${PROJECT}\\.pages\\.dev$`,
  "u",
);

const bytesDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asText = (value) =>
  typeof value === "string" ? value : Buffer.from(value ?? "").toString("utf8");
const statusOf = (result) => result?.status ?? result?.exitCode;

class CommandFailure extends Error {
  constructor(command, result) {
    super(
      `${command.join(" ")} exited ${statusOf(result) ?? "without a status"}`,
    );
    this.stdout = asText(result.stdout);
    this.stderr = asText(result.stderr);
  }
}

export class YurucommuSiteReleaseFailure extends Error {
  constructor(message, { phase, evidence = {}, provider = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "YurucommuSiteReleaseFailure";
    this.phase = phase;
    this.evidence = evidence;
    this.provider = provider;
  }
}

function defaultRun(command, args, { cwd = REPO, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new CommandFailure([command, ...args], result);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function outputOf(result) {
  if (typeof result === "string" || result instanceof Uint8Array) {
    return { stdout: asText(result), stderr: "" };
  }
  return {
    stdout: asText(result?.stdout),
    stderr: asText(result?.stderr),
  };
}

async function invoke(run, command, args, options) {
  const result = await run(command, args, options);
  const output = outputOf(result);
  const status = statusOf(result);
  if (status !== undefined && status !== 0) {
    throw new CommandFailure([command, ...args], {
      ...output,
      status,
    });
  }
  return output;
}

async function gitText(git, args) {
  return outputOf(await git(args)).stdout.trim();
}

async function sourceIdentity(environment, git) {
  if (environment === "production") {
    const dirty = await gitText(git, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (dirty) throw new Error("production requires a clean worktree");
    const branch = await gitText(git, ["branch", "--show-current"]);
    if (branch !== "main")
      throw new Error(
        `production requires main, found ${branch || "detached HEAD"}`,
      );
    await git([
      "fetch",
      "--quiet",
      "origin",
      "refs/heads/main:refs/remotes/origin/main",
    ]);
    const commit = await gitText(git, ["rev-parse", "HEAD"]);
    const remote = await gitText(git, [
      "rev-parse",
      "refs/remotes/origin/main",
    ]);
    if (commit !== remote)
      throw new Error("HEAD is not equal to freshly fetched origin/main");
    return { branch, commit };
  }

  let branch = "integration";
  let commit = null;
  try {
    branch =
      (await gitText(git, ["branch", "--show-current"])) || "integration";
  } catch {
    // A provider-only harness may not have a Git checkout.
  }
  try {
    commit = await gitText(git, ["rev-parse", "HEAD"]);
  } catch {
    // Dirty integration bytes are intentionally identified as the worktree.
  }
  return { branch, commit };
}

function deploymentUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("Wrangler did not return a deployment URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !IMMUTABLE_HOST.test(url.hostname) ||
    url.hostname.startsWith("main.")
  ) {
    throw new Error(`unsafe Pages deployment URL: ${url}`);
  }
  return url.origin;
}

export function parsePagesDeploymentUrl(result) {
  if (result && typeof result === "object" && result.url)
    return deploymentUrl(result.url);
  const text = `${outputOf(result).stdout}\n${outputOf(result).stderr}`;
  const matches = [
    ...text.matchAll(
      new RegExp(
        `https://[a-z0-9-]+\\.${PROJECT}\\.pages\\.dev[^\\s"'<>]*`,
        "gu",
      ),
    ),
  ];
  for (const match of matches.reverse()) {
    const candidate = match[0].replace(/[,;!?)]{1,}$/u, "");
    try {
      return deploymentUrl(candidate);
    } catch {
      // A malformed Pages-looking token must not hide a later valid URL.
    }
  }
  throw new Error("Wrangler output did not contain an immutable Pages URL");
}

async function readback(fetchImpl, origin, expected, providerReadback) {
  if (providerReadback) {
    const result = await providerReadback({ origin, path: "/", expected });
    if (
      result?.status !== 200 ||
      result.bytes !== expected.bytes ||
      result.sha256 !== expected.sha256
    ) {
      throw new Error(`${origin}/ did not serve the uploaded index.html bytes`);
    }
    return result;
  }
  const response = await fetchImpl(`${origin}/`);
  if (response.status !== 200)
    throw new Error(`${origin}/ returned HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const digest = bytesDigest(body);
  if (body.length !== expected.bytes || digest !== expected.sha256) {
    throw new Error(`${origin}/ did not serve the uploaded index.html bytes`);
  }
  return {
    origin,
    path: "/",
    status: response.status,
    bytes: body.length,
    sha256: digest,
  };
}

function releaseEvidence({
  environment,
  source,
  siteDigest,
  deploymentUrl: url,
}) {
  return {
    environment,
    ...(source.commit ? { commit: source.commit } : {}),
    branch: source.branch,
    site: SITE,
    siteSha256: siteDigest,
    ...(url ? { deploymentUrl: url } : {}),
  };
}

export async function deployYurucommuSite({
  repo = REPO,
  environment,
  run = defaultRun,
  git,
  fetchImpl = fetch,
  provider = {},
} = {}) {
  if (!ENVIRONMENTS.has(environment)) {
    throw new YurucommuSiteReleaseFailure(
      "site deployment requires --environment=integration or --environment=production",
      {
        phase: "PRE_UPLOAD_FAILURE",
        evidence: { environment: environment ?? null },
      },
    );
  }
  const command = provider.run ?? run;
  const gitRun = git ?? ((args) => command("git", args, { cwd: repo }));
  const source = { branch: "integration", commit: null };
  let siteDigest = null;
  let uploaded = false;
  let url = null;
  let providerOutput = null;
  try {
    Object.assign(source, await sourceIdentity(environment, gitRun));
    const siteRoot = resolve(repo, SITE);
    if (!existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) {
      throw new Error(`${SITE}/ is missing or is not a directory`);
    }
    if (provider.check) await provider.check({ repo, environment, siteRoot });
    else await invoke(command, CHECK[0], CHECK.slice(1), { cwd: repo });

    const index = readFileSync(join(siteRoot, "index.html"));
    siteDigest = bytesDigest(index);

    const uploadArgs = [
      "pages",
      "deploy",
      siteRoot,
      "--project-name",
      PROJECT,
      "--branch",
      source.branch,
      `--commit-dirty=${environment === "integration" ? "true" : "false"}`,
    ];
    uploaded = true;
    const raw = provider.upload
      ? await provider.upload({
          repo,
          environment,
          siteRoot,
          branch: source.branch,
          commit: source.commit,
        })
      : await invoke(command, "wrangler", uploadArgs, { cwd: repo });
    providerOutput = outputOf(raw);
    url = parsePagesDeploymentUrl(raw);

    const expected = { bytes: index.length, sha256: siteDigest };
    const immutable = await readback(
      fetchImpl,
      url,
      expected,
      provider.readback,
    );
    const publicReadback =
      environment === "production"
        ? await readback(fetchImpl, PUBLIC_ORIGIN, expected, provider.readback)
        : null;
    const result = {
      kind: "takos.deploy-result@v1",
      surface: SURFACE,
      target: `cloudflare-pages:${PROJECT}`,
      ...releaseEvidence({
        environment,
        source,
        siteDigest,
        deploymentUrl: url,
      }),
      immutableReadback: immutable,
      ...(publicReadback ? { publicReadback } : {}),
      status: "PUBLISHED",
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    const phase = uploaded ? "POST_UPLOAD_INDETERMINATE" : "PRE_UPLOAD_FAILURE";
    if (error instanceof YurucommuSiteReleaseFailure) throw error;
    throw new YurucommuSiteReleaseFailure(
      error instanceof Error ? error.message : "site publication failed",
      {
        phase,
        evidence: releaseEvidence({
          environment,
          source,
          siteDigest,
          deploymentUrl: url,
        }),
        provider:
          providerOutput ??
          (error instanceof CommandFailure
            ? { stdout: error.stdout, stderr: error.stderr }
            : null),
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
}

export function reportYurucommuSiteReleaseFailure(error) {
  const failure =
    error instanceof YurucommuSiteReleaseFailure
      ? error
      : new YurucommuSiteReleaseFailure(String(error), {
          phase: "PRE_UPLOAD_FAILURE",
        });
  process.stderr.write(
    `deploy blocked [${failure.phase}]: ${failure.message}\n`,
  );
  if (failure.phase !== "PRE_UPLOAD_FAILURE") {
    process.stderr.write(
      "Upload may have completed; reconcile the immutable URL before retrying.\n",
    );
  }
  const result = {
    kind: "takos.deploy-result@v1",
    surface: SURFACE,
    target: `cloudflare-pages:${PROJECT}`,
    ...failure.evidence,
    failurePhase: failure.phase,
    status:
      failure.phase === "PRE_UPLOAD_FAILURE" ? "BLOCKED" : "INDETERMINATE",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
