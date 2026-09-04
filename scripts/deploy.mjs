#!/usr/bin/env bun

// yurucommu の唯一の deploy entrypoint です。
//
// 共通の obligation と trigger は takos-control の
// `engineering.policy.json` → `deploy` が正本です。
//
//   bun run deploy -- yurucommu-worker --environment=production --commit=<40-hex>
//
// この surface が publish するのは **Worker の code だけ** です。durable store
// (D1 DB / KV / R2 MEDIA) には触れません。schema 変更は `irreversible` な別の作業で、
// この entrypoint の副作用として起きてはいけないからです。
// ⚠ yurucommu 系の live D1 は `_cf_migrations` 台帳が実態とずれています。
// `wrangler d1 migrations apply` を絶対に走らせないこと。schema 変更は
// 直接 `d1 execute` で行う operator 手順です。この script は D1 に触れません。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_GATE = "bun run check";

const W = {
  surface: "yurucommu-worker",
  worker: "yurucommu",
  bundle: "dist/yurucommu-worker.js",
};

const R = {
  surface: "yurucommu-worker-release",
  repository: "tako0614/yurucommu",
  bundle: W.bundle,
  manifest: "takosumi-artifact.json",
  checksum: "yurucommu-worker.js.sha256",
  smokeScript: "smoke:release-artifact",
};

const S = {
  surface: "yurucommu-site",
  project: "yurucommu-website",
  productionBranch: "main",
  source: "site",
  publicOrigin: "https://yurucommu.com",
};

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: W.surface,
      target: `cloudflare-worker:${W.worker}`,
      covers: [
        "wrangler.jsonc",
        "scripts/build-yurucommu-worker.ts",
        "scripts/post-deploy-smoke.ts",
        "scripts/release-yurucommu-worker.mjs",
      ],
      requiresScripts: ["check", "build:worker", "smoke:postdeploy"],
      requiresTools: ["git", "bun", "tofu"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "YURUCOMMU_E2E_PASSWORD",
        "YURUCOMMU_WORKER_DEPLOY_TARGET",
      ],
      // code だけを差し替えます。直前の Version は manual reversal の候補として
      // 残りますが、read/write の CAS がないためこの surface は自動 rollback しません。
      // durable store の schema を変える作業はこの surface ではなく、別の deliberate な
      // 手順です。
      triggers: [],
      obligations: {
        provenance: `requires exactly --environment=production and --commit=<40-hex>; requires a clean HEAD equal to that commit and either freshly pushed main or an exact commit contained by freshly fetched origin/main; uses CLOUDFLARE_API_TOKEN only for provider authentication, reads the operator-private target/config from YURUCOMMU_WORKER_DEPLOY_TARGET as link-free 0600 regular files under 0700 directories outside every discovered Git repository, common directory, and linked worktree, and uses YURUCOMMU_E2E_PASSWORD only for the post-deploy application smoke; runs \`${OWNER_GATE}\` once; and binds the commit, ${W.bundle} sha256, and selected config digest into the uploaded Version annotation`,
        "post-conditions": `uses one direct Cloudflare API Version upload and one direct Cloudflare API Deployment write; binds each acknowledgement to the exact Version and Deployment ids; verifies the selected Version's authoritative resources.script.etag against the uploaded ${W.bundle} bytes and compares its full non-code closure with the active predecessor; re-reads the active Deployment and exact hostname/service/environment custom-domain filters across bounded stable pages; runs \`bun run smoke:postdeploy\` through the selected public origin; then requires a final route and active Deployment readback before PUBLISHED`,
        reversal: `reads the pre-upload active Deployment and its exact one-Version 100 percent version set rather than Version-list order; a failed smoke never writes an automatic rollback because Cloudflare exposes no compare-and-swap across the read/write boundary, and instead reports that exact predecessor for manual reversal after an authoritative concurrency readback`,
        "failure-handling":
          "prints provider diagnostics without credentials, reports PRE_UPLOAD_FAILURE, POST_UPLOAD_INDETERMINATE, POST_DEPLOY_INDETERMINATE, or POST_CONDITION_INDETERMINATE, and never retries an upload or deployment whose acknowledgement was lost",
      },
    },
    {
      surface: R.surface,
      target: `github-release:${R.repository}/v<package-version>`,
      covers: [
        "bun.lock",
        ".well-known/takosumi.json",
        "deploy/takoform/main.tf",
        "main.tf",
        "package.json",
        "scripts/build-yurucommu-worker.ts",
        "scripts/smoke-release-worker.mjs",
        "scripts/yurucommu-worker-bindings.ts",
      ],
      requiresScripts: ["check", "build:worker", R.smokeScript],
      requiresTools: ["git", "bun", "gh"],
      requiresEnv: [],
      triggers: ["published-identity"],
      obligations: {
        provenance:
          "refuses a dirty, detached, or unpushed worktree; requires main for publication; runs `bun run check`; builds and boots the embedded Worker from that exact commit; requires the repository manifest's default deploy/takoform module and sourceBuild-generated Worker/migration assets, plus direct-Cloudflare module release pins, to align with the same tag and artifact digest; and records the source commit plus SHA-256 in the release manifest",
        "post-conditions":
          "reads the create-only tag and GitHub Release back, requires the tag to resolve to the source commit and the Release to report isImmutable:true, downloads all three assets, requires their exact SHA-256 digests, and boots the downloaded Worker in workerd with runtime-native DB/KV/MEDIA/queue bindings",
        reversal:
          "the release identity is never replaced or deleted by this entrypoint; consumers remain able to pin the preceding release, and a defect is repaired by publishing a higher version",
        "failure-handling":
          "fails before mutation when the tag or release already exists; after release creation starts it reports an indeterminate publication and requires authoritative tag/release readback before any retry",
        "no-overwrite":
          "derives one SemVer tag from package.json, refuses any existing local/remote tag or GitHub Release, reads repos/tako0614/yurucommu/immutable-releases immediately before create and requires enabled:true, requires post-readback isImmutable:true, and uses GitHub create-only release publication without update or delete paths",
      },
    },
    {
      surface: S.surface,
      target: `cloudflare-pages:${S.project}`,
      covers: [S.source, "scripts/release-yurucommu-site.mjs"],
      requiresScripts: ["check:site"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: [],
      productionBranch: S.productionBranch,
      triggers: [],
      obligations: {
        provenance: `integration accepts the exact worktree (including dirty, non-main work) and production requires a clean main equal to freshly fetched origin/${S.productionBranch}; both run bun run check:site once and record the source commit when available plus the site/index.html digest`,
        "post-conditions": `performs one Wrangler Pages upload to ${S.project}, then GETs the immutable deployment URL; production also GETs ${S.publicOrigin} and requires the uploaded home-page bytes`,
        reversal: `use the Pages provider deployment history to roll back the published deployment, or publish a corrected higher commit through this surface`,
        "failure-handling":
          "reports PRE_UPLOAD_FAILURE before Wrangler is invoked or POST_UPLOAD_INDETERMINATE after upload begins; it never retries or rolls back automatically",
      },
    },
  ],
};

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
  process.exit(0);
}

const requestedSurface = process.argv[2];
if (![W.surface, R.surface, S.surface].includes(requestedSurface)) {
  process.stderr.write(
    `usage: bun run deploy -- ${W.surface} --environment=production --commit=<40-hex>\n` +
      `       bun run deploy -- ${R.surface} [--dry-run|--execute]\n` +
      `       bun run deploy -- ${S.surface} --environment=integration|production\n`,
  );
  process.exit(1);
}

function die(message, detail = []) {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const line of detail) process.stderr.write(`- ${line}\n`);
  process.exit(1);
}
function gitSubprocessEnvironment() {
  const env = {};
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TERM",
    "TMPDIR",
    "TZ",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
const git = (...a) =>
  execFileSync("git", a, {
    cwd: repo,
    env: gitSubprocessEnvironment(),
    encoding: "utf8",
  }).trim();
const run = (c, a) =>
  execFileSync(c, a, {
    cwd: repo,
    env: c === "git" ? gitSubprocessEnvironment() : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const digest = (b) => createHash("sha256").update(b).digest("hex");

function terraformStringDefault(source, variable) {
  return source
    .match(
      new RegExp(`variable\\s+"${variable}"\\s*\\{([\\s\\S]*?)\\n\\}`, "u"),
    )?.[1]
    ?.match(/default\s+=\s+"([^"]*)"/u)?.[1];
}

function requireReleaseIdentity(tag, artifactUrl, bundleDigest) {
  const expectedDigest = `sha256:${bundleDigest}`;
  const failures = [];

  for (const modulePath of ["main.tf"]) {
    const source = readFileSync(resolve(repo, modulePath), "utf8");
    const actual = {
      tag: terraformStringDefault(source, "worker_release_tag"),
      url: terraformStringDefault(source, "worker_bundle_url"),
      digest: terraformStringDefault(source, "worker_bundle_sha256"),
    };
    for (const [field, value, expected] of [
      ["worker_release_tag", actual.tag, tag],
      ["worker_bundle_url", actual.url, artifactUrl],
      ["worker_bundle_sha256", actual.digest, expectedDigest],
    ]) {
      if (value !== expected) {
        failures.push(
          `${modulePath} ${field} is ${value ?? "<missing>"}, expected ${expected}`,
        );
      }
    }
  }

  const repository = JSON.parse(
    readFileSync(resolve(repo, ".well-known/takosumi.json"), "utf8"),
  );
  const install = repository?.install;
  const modules = install?.modules;
  if (
    repository?.apiVersion !== "takosumi.com/v2.4" ||
    repository?.kind !== "Repository"
  ) {
    failures.push(
      ".well-known/takosumi.json has an unexpected repository kind",
    );
  }
  const rootModule = modules?.["."];
  const takoformModule = modules?.["deploy/takoform"];
  const pinInputs = new Map(
    (Array.isArray(rootModule?.inputs) ? rootModule.inputs : []).map(
      (input) => [input?.name, input],
    ),
  );
  for (const name of [
    "worker_release_tag",
    "worker_bundle_url",
    "worker_bundle_sha256",
  ]) {
    if (pinInputs.get(name)?.source?.kind !== "module_default") {
      failures.push(
        `.well-known/takosumi.json root module does not declare ${name} as a module_default pin`,
      );
    }
  }
  const sourceBuildCommands = Array.isArray(
    takoformModule?.sourceBuild?.commands,
  )
    ? takoformModule.sourceBuild.commands.map((command) => command?.argv)
    : undefined;
  if (
    JSON.stringify(sourceBuildCommands) !==
    JSON.stringify([
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "run", "build:worker"],
      ["bun", "scripts/prepare-takoform-v1-source.ts"],
    ])
  ) {
    failures.push(
      "deploy/takoform sourceBuild does not build and prepare the selected source worktree",
    );
  }
  if (
    JSON.stringify(takoformModule?.sourceBuild?.outputs) !==
    JSON.stringify([
      "deploy/takoform/.generated/yurucommu-worker.js",
      "deploy/takoform/migrations/sql",
    ])
  ) {
    failures.push(
      "deploy/takoform sourceBuild does not pin the generated Worker and migration assets",
    );
  }
  const takoformSource = readFileSync(
    resolve(repo, "deploy/takoform/main.tf"),
    "utf8",
  );
  if (
    !takoformSource.includes(
      'worker_bundle_path  = "${path.module}/.generated/yurucommu-worker.js"',
    )
  ) {
    failures.push(
      "deploy/takoform does not consume the Worker prepared from its selected source worktree",
    );
  }

  if (failures.length > 0) {
    die(
      "package, repository manifest module/asset pins, deployment sourceBuild, and built Worker do not identify one release",
      failures,
    );
  }
}

function smokeReleaseArtifact(artifactPath, expectedDigest, publishedTag) {
  process.stdout.write(
    `\n==> bun run ${R.smokeScript} -- ${artifactPath} sha256:${expectedDigest}\n`,
  );
  try {
    const output = run("bun", [
      "run",
      R.smokeScript,
      "--",
      artifactPath,
      `sha256:${expectedDigest}`,
    ]);
    process.stdout.write(output);
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    if (publishedTag) {
      die(
        `publication of ${publishedTag} completed but the downloaded Worker failed its runtime-native smoke; inspect the immutable Release before any new-version repair`,
        detail ? detail.split("\n").slice(0, 40) : [],
      );
    }
    die(
      "the candidate Worker failed its runtime-native smoke before publication",
      detail ? detail.split("\n").slice(0, 40) : [],
    );
  }
}

function requireCleanPushedSource(execute) {
  const dirty = git("status", "--porcelain");
  if (dirty !== "") {
    die(
      "the worktree is not clean; the published bytes must belong to one commit",
      dirty.split("\n").slice(0, 20),
    );
  }
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "HEAD") {
    die("release verification requires a branch, found detached HEAD");
  }
  if (execute && branch !== "main") {
    die(`release publication requires main, found ${branch}`);
  }
  const commit = git("rev-parse", "HEAD");
  let upstream;
  try {
    upstream = git(
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    );
  } catch {
    die(`branch ${branch} has no pushed upstream`);
  }
  if (upstream !== `origin/${branch}`) {
    die(`branch ${branch} must track origin/${branch}, found ${upstream}`);
  }
  execFileSync(
    "git",
    [
      "fetch",
      "--quiet",
      "origin",
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    { cwd: repo, env: gitSubprocessEnvironment() },
  );
  const remoteCommit = git("rev-parse", upstream);
  if (commit !== remoteCommit) {
    die(`local ${branch} ${commit} does not equal ${upstream} ${remoteCommit}`);
  }
  return { branch, commit };
}

function requireRepositoryImmutableReleases() {
  const endpoint = `repos/${R.repository}/immutable-releases`;
  let body;
  try {
    body = run("gh", ["api", endpoint]);
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    die(
      `cannot read ${endpoint} immediately before release creation; refusing to publish without authoritative immutable-release settings`,
      detail ? detail.split("\n").slice(0, 20) : [],
    );
  }

  let settings;
  try {
    settings = JSON.parse(body);
  } catch (error) {
    die(
      `${endpoint} returned invalid JSON; refusing to publish without authoritative immutable-release settings`,
      [String(error.message)],
    );
  }
  if (settings?.enabled !== true) {
    die(
      `${endpoint} is not enabled (enabled=${String(settings?.enabled)}); refusing to create a mutable Release`,
    );
  }
  process.stdout.write(`${endpoint} enabled:true\n`);
}

function publishWorkerRelease() {
  if (
    process.argv.includes("--execute") &&
    process.argv.includes("--dry-run")
  ) {
    die("choose exactly one of --dry-run or --execute");
  }
  const execute = process.argv.includes("--execute");
  const { branch, commit } = requireCleanPushedSource(execute);
  const packageJson = JSON.parse(
    readFileSync(resolve(repo, "package.json"), "utf8"),
  );
  const version = String(packageJson.version ?? "");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    die(`package.json version ${JSON.stringify(version)} is not SemVer`);
  }
  const tag = `v${version}`;
  const localTag = git("tag", "--list", tag);
  if (localTag !== "") die(`local tag ${tag} already exists`);
  const remoteTag = run("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ]).trim();
  if (remoteTag !== "") die(`remote tag ${tag} already exists`);
  try {
    run("gh", ["release", "view", tag, "--repo", R.repository]);
    die(`GitHub Release ${tag} already exists`);
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (!/release not found|HTTP 404/iu.test(stderr)) {
      die(`cannot prove GitHub Release ${tag} is absent: ${stderr.trim()}`);
    }
  }

  process.stdout.write(`source ${commit} (${branch})\n`);
  process.stdout.write(`\n==> ${OWNER_GATE}\n`);
  execFileSync("bun", ["run", "check"], { cwd: repo, stdio: "inherit" });

  const bundlePath = resolve(repo, R.bundle);
  if (!existsSync(bundlePath)) die(`${R.bundle} is missing after the build`);
  const bundleBytes = readFileSync(bundlePath);
  const bundleDigest = digest(bundleBytes);
  const assetUrl = `https://github.com/${R.repository}/releases/download/${tag}/yurucommu-worker.js`;
  const manifestUrl = `https://github.com/${R.repository}/releases/download/${tag}/${R.manifest}`;
  requireReleaseIdentity(tag, assetUrl, bundleDigest);
  const manifest = {
    kind: "takosumi.worker-artifact@v1",
    app: "yurucommu",
    commit,
    ref: tag,
    releaseTag: tag,
    artifact: {
      filename: "yurucommu-worker.js",
      url: assetUrl,
      sha256: bundleDigest,
      sha256Prefixed: `sha256:${bundleDigest}`,
      contentType: "application/javascript",
    },
    manifestUrl,
  };

  const releaseDir = mkdtempSync(resolve(tmpdir(), "yurucommu-release-"));
  const artifactPath = resolve(releaseDir, "yurucommu-worker.js");
  const manifestPath = resolve(releaseDir, R.manifest);
  const checksumPath = resolve(releaseDir, R.checksum);
  copyFileSync(bundlePath, artifactPath);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(checksumPath, `${bundleDigest}  yurucommu-worker.js\n`);
  const expectedDigests = {
    "yurucommu-worker.js": bundleDigest,
    [R.manifest]: digest(readFileSync(manifestPath)),
    [R.checksum]: digest(readFileSync(checksumPath)),
  };

  smokeReleaseArtifact(artifactPath, bundleDigest);
  process.stdout.write(`candidate ${tag} ${R.bundle} sha256:${bundleDigest}\n`);
  if (!execute) {
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: "takos.deploy-result@v1",
          surface: R.surface,
          target: `github-release:${R.repository}/${tag}`,
          commit,
          tag,
          sourceIdentity: "PACKAGE_REPOSITORY_MODULE_ARTIFACT_ALIGNED",
          assetDigests: expectedDigests,
          status: "DRY_RUN_VERIFIED",
        },
        null,
        2,
      )}\n`,
    );
    rmSync(releaseDir, { recursive: true, force: true });
    return;
  }

  process.stdout.write(`\n==> create-only GitHub Release ${tag}\n`);
  requireRepositoryImmutableReleases();
  try {
    const output = run("gh", [
      "release",
      "create",
      tag,
      artifactPath,
      manifestPath,
      checksumPath,
      "--repo",
      R.repository,
      "--target",
      commit,
      "--title",
      `Yurucommu ${tag}`,
      "--notes",
      `Worker release built from ${commit}.`,
    ]);
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
    die(
      `publication of ${tag} started but did not complete cleanly; inspect the remote tag and Release before retrying`,
    );
  }

  const publishedTag = run("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ])
    .trim()
    .split(/\s+/u)[0];
  if (publishedTag !== commit) {
    die(
      `published tag ${tag} resolves to ${publishedTag || "<missing>"}, expected ${commit}`,
    );
  }
  const release = JSON.parse(
    run("gh", [
      "release",
      "view",
      tag,
      "--repo",
      R.repository,
      "--json",
      "isDraft,isPrerelease,isImmutable,tagName,url,assets",
    ]),
  );
  if (
    release.isDraft ||
    release.isPrerelease ||
    release.isImmutable !== true ||
    release.tagName !== tag
  ) {
    die(
      `published Release ${tag} has unexpected state (isImmutable=${String(release.isImmutable)})`,
    );
  }
  const remoteAssets = new Map(
    release.assets.map((asset) => [asset.name, asset.digest]),
  );
  for (const [name, expected] of Object.entries(expectedDigests)) {
    if (remoteAssets.get(name) !== `sha256:${expected}`) {
      die(
        `published asset ${name} digest ${remoteAssets.get(name) ?? "<missing>"} does not equal sha256:${expected}`,
      );
    }
  }

  const downloadDir = resolve(releaseDir, "readback");
  mkdirSync(downloadDir);
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    R.repository,
    "--dir",
    downloadDir,
  ]);
  for (const [name, expected] of Object.entries(expectedDigests)) {
    const actual = digest(readFileSync(resolve(downloadDir, name)));
    if (actual !== expected) {
      die(
        `downloaded asset ${name} digest ${actual} does not equal ${expected}`,
      );
    }
  }
  smokeReleaseArtifact(
    resolve(downloadDir, "yurucommu-worker.js"),
    bundleDigest,
    tag,
  );

  process.stdout.write(
    `\n${JSON.stringify(
      {
        kind: "takos.deploy-result@v1",
        surface: R.surface,
        target: `github-release:${R.repository}/${tag}`,
        commit,
        tag,
        sourceIdentity: "PACKAGE_REPOSITORY_MODULE_ARTIFACT_ALIGNED",
        releaseUrl: release.url,
        assetDigests: expectedDigests,
        postConditions: "EXACT_RELEASE_READBACK_AND_RUNTIME_NATIVE_SMOKE",
        status: "PUBLISHED",
      },
      null,
      2,
    )}\n`,
  );
  rmSync(releaseDir, { recursive: true, force: true });
}

if (requestedSurface === R.surface) {
  publishWorkerRelease();
  process.exit(0);
}

if (requestedSurface === S.surface) {
  const args = process.argv.slice(3);
  if (
    args.length !== 1 ||
    !/^--environment=(?:integration|production)$/u.test(args[0])
  ) {
    die(
      `${S.surface} requires exactly one --environment=integration|production flag`,
    );
  }
  const environment = args[0].slice("--environment=".length);
  const { deployYurucommuSite, reportYurucommuSiteReleaseFailure } =
    await import("./release-yurucommu-site.mjs");
  try {
    await deployYurucommuSite({ environment });
  } catch (error) {
    reportYurucommuSiteReleaseFailure(error);
    process.exit(1);
  }
  process.exit(0);
}

const workerArgs = process.argv.slice(3);
const environmentArgument = workerArgs.find((argument) =>
  argument.startsWith("--environment="),
);
const commitArgument = workerArgs.find((argument) =>
  argument.startsWith("--commit="),
);
if (
  workerArgs.length !== 2 ||
  environmentArgument !== "--environment=production" ||
  !/^--commit=[0-9a-f]{40}$/u.test(commitArgument ?? "") ||
  new Set(workerArgs).size !== 2
) {
  die(
    `${W.surface} requires exactly --environment=production and --commit=<40-hex>`,
  );
}

const {
  deployYurucommuWorker,
  loadYurucommuWorkerTarget,
  reportYurucommuWorkerReleaseFailure,
} = await import("./release-yurucommu-worker.mjs");
try {
  const target = loadYurucommuWorkerTarget({
    environment: "production",
    path: process.env.YURUCOMMU_WORKER_DEPLOY_TARGET,
    repo,
  });
  const result = await deployYurucommuWorker({
    environment: "production",
    commit: commitArgument.slice("--commit=".length),
    target,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  reportYurucommuWorkerReleaseFailure(error);
  process.exit(1);
}
