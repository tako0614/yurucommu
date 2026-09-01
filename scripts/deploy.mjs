#!/usr/bin/env bun

// yurucommu の唯一の deploy entrypoint です。
//
// 共通の obligation と trigger は takos-control の
// `engineering.policy.json` → `deploy` が正本です。
//
//   bun run deploy -- yurucommu-worker
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
  config: "wrangler.jsonc",
  bundle: "dist/yurucommu-worker.js",
  build: ["bun", "run", "build:worker"],
  url: "https://test.yurucommu.com",
  smoke: ["bun", "run", "smoke:postdeploy"],
};

const R = {
  surface: "yurucommu-worker-release",
  repository: "tako0614/yurucommu",
  bundle: W.bundle,
  manifest: "takosumi-artifact.json",
  checksum: "yurucommu-worker.js.sha256",
};

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: W.surface,
      target: `cloudflare-worker:${W.worker}`,
      covers: [
        "package.json",
        "bun.lock",
        "scripts/build-yurucommu-worker.ts",
        "scripts/runtime-ports.ts",
        "dist/yurucommu-worker.js",
        "wrangler.jsonc",
      ],
      requiresScripts: ["check", "build:worker", "smoke:postdeploy"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: ["YURUCOMMU_WRANGLER_CONFIG"],
      // code だけを差し替えます。直前の version がそのまま戻し先として残るので
      // irreversible は立ちません。durable store の schema を変える作業は
      // この surface ではなく、別の deliberate な手順です。
      triggers: [],
      obligations: {
        provenance: `refuses a dirty worktree, runs \`${OWNER_GATE}\`, builds ${W.bundle} from that worktree with \`bun run build\`, and records the commit and the bundle sha256 It takes the operator's realized deploy config from YURUCOMMU_WRANGLER_CONFIG and refuses to publish a config that still holds a self-host template placeholder.`,
        "post-conditions": `runs \`bun run smoke:postdeploy\`, which exercises real HTTP request paths against the deployed Worker plus the built artifact's queue and scheduled entrypoints (including portable media and producer bindings)`,
        reversal: `the current version id is read and printed before publishing; restore it with \`wrangler versions list --name ${W.worker}\` and \`wrangler versions deploy <previous-id>@100%\``,
        "failure-handling":
          "prints the provider's own stdout and stderr, names whether the failure was before or after publication, and on a failed post-condition exits non-zero naming the previous version instead of retrying",
      },
    },
    {
      surface: R.surface,
      target: `github-release:${R.repository}/v<package-version>`,
      covers: [
        "package.json",
        "bun.lock",
        "scripts/build-yurucommu-worker.ts",
        "scripts/runtime-ports.ts",
        "dist/yurucommu-worker.js",
      ],
      requiresScripts: ["check", "build:worker"],
      requiresTools: ["git", "bun", "gh"],
      requiresEnv: [],
      triggers: ["published-identity"],
      obligations: {
        provenance:
          "refuses a dirty, detached, non-main, or unpushed worktree; runs `bun run check`; builds the embedded Worker from that exact commit; and records the source commit plus SHA-256 in the release manifest",
        "post-conditions":
          "reads the create-only tag and GitHub Release back, requires the tag to resolve to the source commit, downloads all three assets, and requires their exact SHA-256 digests",
        reversal:
          "the release identity is never replaced or deleted by this entrypoint; consumers remain able to pin the preceding release, and a defect is repaired by publishing a higher version",
        "failure-handling":
          "fails before mutation when the tag or release already exists; after release creation starts it reports an indeterminate publication and requires authoritative tag/release readback before any retry",
        "no-overwrite":
          "derives one SemVer tag from package.json, refuses any existing local/remote tag or GitHub Release, and uses GitHub create-only release publication without update or delete paths",
      },
    },
  ],
};

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
  process.exit(0);
}

const requestedSurface = process.argv[2];
if (![W.surface, R.surface].includes(requestedSurface)) {
  process.stderr.write(
    `usage: bun run deploy -- ${W.surface}\n` +
      `       bun run deploy -- ${R.surface} [--execute]\n`,
  );
  process.exit(1);
}

function die(message, detail = []) {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const line of detail) process.stderr.write(`- ${line}\n`);
  process.exit(1);
}

function parseWranglerJsonc(source, configPath) {
  try {
    // Bun's JSONC parser handles comments and trailing commas while retaining
    // JSON's strict string/number semantics. The deploy entrypoint is Bun-only
    // (see the shebang and package script), so no permissive ad-hoc parser is
    // needed here.
    return Bun.JSONC.parse(source);
  } catch (error) {
    die(`deploy config ${configPath} is not valid JSONC`, [error.message]);
  }
}

function validateDirectWranglerConfig(config, configPath) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    die(`deploy config ${configPath} must contain a JSON object`);
  }
  const vars = config.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    die(
      `deploy config ${configPath} must declare vars.APP_URL and queue identities`,
    );
  }
  const appUrl = vars.APP_URL;
  if (typeof appUrl !== "string" || appUrl.length === 0) {
    die(`deploy config ${configPath} must declare an exact HTTPS vars.APP_URL`);
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(appUrl);
  } catch {
    die(`deploy config ${configPath} vars.APP_URL is not a valid URL`);
  }
  if (
    parsedOrigin.protocol !== "https:" ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.search ||
    parsedOrigin.hash ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.origin !== appUrl
  ) {
    die(
      `deploy config ${configPath} vars.APP_URL must be an exact HTTPS origin without path, query, fragment, userinfo, or trailing slash`,
    );
  }

  const deliveryQueue = vars.DELIVERY_QUEUE_NAME;
  const deliveryDlq = vars.DELIVERY_DLQ_NAME;
  if (
    typeof deliveryQueue !== "string" ||
    typeof deliveryDlq !== "string" ||
    deliveryQueue.length === 0 ||
    deliveryDlq.length === 0 ||
    deliveryQueue === deliveryDlq
  ) {
    die(
      `deploy config ${configPath} vars.DELIVERY_QUEUE_NAME and vars.DELIVERY_DLQ_NAME must be distinct non-empty names`,
    );
  }

  const queues = config.queues;
  const producers = Array.isArray(queues?.producers) ? queues.producers : [];
  const consumers = Array.isArray(queues?.consumers) ? queues.consumers : [];
  const producerByBinding = new Map();
  for (const producer of producers) {
    if (
      !producer ||
      typeof producer !== "object" ||
      typeof producer.binding !== "string" ||
      typeof producer.queue !== "string"
    ) {
      die(`deploy config ${configPath} contains an invalid queue producer`);
    }
    if (producerByBinding.has(producer.binding)) {
      die(
        `deploy config ${configPath} repeats queue producer ${producer.binding}`,
      );
    }
    producerByBinding.set(producer.binding, producer.queue);
  }
  const expectedProducers = new Map([
    ["DELIVERY_QUEUE", deliveryQueue],
    ["DELIVERY_DLQ", deliveryDlq],
  ]);
  if (
    producerByBinding.size !== expectedProducers.size ||
    [...expectedProducers].some(
      ([binding, queue]) => producerByBinding.get(binding) !== queue,
    )
  ) {
    die(
      `deploy config ${configPath} queue producers must bind DELIVERY_QUEUE/DELIVERY_DLQ to the declared queue identities`,
    );
  }

  const consumerByQueue = new Map();
  for (const consumer of consumers) {
    if (
      !consumer ||
      typeof consumer !== "object" ||
      typeof consumer.queue !== "string" ||
      consumer.queue.length === 0
    ) {
      die(`deploy config ${configPath} contains an invalid queue consumer`);
    }
    if (consumerByQueue.has(consumer.queue)) {
      die(
        `deploy config ${configPath} repeats queue consumer ${consumer.queue}`,
      );
    }
    consumerByQueue.set(consumer.queue, consumer);
  }
  const producerQueues = new Set(producerByBinding.values());
  const consumerQueues = new Set(consumerByQueue.keys());
  if (
    producerQueues.size !== consumerQueues.size ||
    [...producerQueues].some((queue) => !consumerQueues.has(queue))
  ) {
    die(
      `deploy config ${configPath} queue producer/consumer identities do not match`,
    );
  }
  const deliveryConsumer = consumerByQueue.get(deliveryQueue);
  const dlqConsumer = consumerByQueue.get(deliveryDlq);
  if (!deliveryConsumer || !dlqConsumer) {
    die(
      `deploy config ${configPath} must consume both the delivery queue and its distinct DLQ`,
    );
  }
  if (deliveryConsumer.dead_letter_queue !== deliveryDlq) {
    die(
      `deploy config ${configPath} delivery consumer must dead-letter to vars.DELIVERY_DLQ_NAME`,
    );
  }
  if (dlqConsumer.dead_letter_queue !== undefined) {
    die(
      `deploy config ${configPath} DLQ consumer must not declare another dead-letter queue`,
    );
  }
}
const git = (...a) =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const run = (c, a) =>
  execFileSync(c, a, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const digest = (b) => createHash("sha256").update(b).digest("hex");

function requireCleanPushedMain() {
  const dirty = git("status", "--porcelain");
  if (dirty !== "") {
    die(
      "the worktree is not clean; the published bytes must belong to one commit",
      dirty.split("\n").slice(0, 20),
    );
  }
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") {
    die(`release publication requires main, found ${branch}`);
  }
  const commit = git("rev-parse", "HEAD");
  execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: repo });
  const remoteMain = git("rev-parse", "origin/main");
  if (commit !== remoteMain) {
    die(`local main ${commit} does not equal origin/main ${remoteMain}`);
  }
  return commit;
}

function publishWorkerRelease() {
  const execute = process.argv.includes("--execute");
  const commit = requireCleanPushedMain();
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

  process.stdout.write(`source ${commit} (main)\n`);
  process.stdout.write(`\n==> ${OWNER_GATE}\n`);
  execFileSync("bun", ["run", "check"], { cwd: repo, stdio: "inherit" });

  const bundlePath = resolve(repo, R.bundle);
  if (!existsSync(bundlePath)) die(`${R.bundle} is missing after the build`);
  const bundleBytes = readFileSync(bundlePath);
  const bundleDigest = digest(bundleBytes);
  const assetUrl = `https://github.com/${R.repository}/releases/download/${tag}/yurucommu-worker.js`;
  const manifestUrl = `https://github.com/${R.repository}/releases/download/${tag}/${R.manifest}`;
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
      "isDraft,isPrerelease,tagName,url,assets",
    ]),
  );
  if (release.isDraft || release.isPrerelease || release.tagName !== tag) {
    die(`published Release ${tag} has unexpected state`);
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

  process.stdout.write(
    `\n${JSON.stringify(
      {
        kind: "takos.deploy-result@v1",
        surface: R.surface,
        target: `github-release:${R.repository}/${tag}`,
        commit,
        tag,
        releaseUrl: release.url,
        assetDigests: expectedDigests,
        postConditions: "EXACT_RELEASE_READBACK",
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

// operator の realized config を受け取れるようにします。repo の wrangler config が
// self-host 向け placeholder を含んだままなら止めます。本番と取り違えて publish
// しないためです。
const CONFIG_ENV = "YURUCOMMU_WRANGLER_CONFIG";
const configPath = process.env[CONFIG_ENV] ?? W.config;
const resolvedConfig = existsSync(resolve(repo, configPath))
  ? resolve(repo, configPath)
  : configPath;
if (!existsSync(resolvedConfig)) {
  die(
    `deploy config ${configPath} does not exist; set ${CONFIG_ENV} to the operator's realized config`,
  );
}
const configValues = readFileSync(resolvedConfig, "utf8");
const config = parseWranglerJsonc(configValues, configPath);
validateDirectWranglerConfig(config, configPath);
const placeholder =
  /(?:[=:]\s*["']?[^"'\n]*)(example\.com|REPLACE_[A-Z_]+|<[a-z-]+>|xxxxx)/iu.exec(
    configValues,
  );
if (placeholder) {
  die(
    `${configPath} still contains the self-host template placeholder ${JSON.stringify(placeholder[1])}; ` +
      `set ${CONFIG_ENV} to the operator's realized config instead of publishing the template`,
  );
}

// provenance
const dirty = git("status", "--porcelain");
if (dirty !== "") {
  die(
    "the worktree is not clean; the published bundle must belong to one commit",
    dirty.split("\n").slice(0, 20),
  );
}
const commit = git("rev-parse", "HEAD");
process.stdout.write(
  `source ${commit} (${git("rev-parse", "--abbrev-ref", "HEAD")})\n`,
);

process.stdout.write(`\n==> ${OWNER_GATE}\n`);
execFileSync("bun", ["run", "check"], { cwd: repo, stdio: "inherit" });

process.stdout.write(`\n==> bun run build\n`);
execFileSync(W.build[0], W.build.slice(1), { cwd: repo, stdio: "inherit" });

const bundlePath = resolve(repo, W.bundle);
if (!existsSync(bundlePath)) die(`${W.bundle} is missing after the build`);
const bundleDigest = digest(readFileSync(bundlePath));
process.stdout.write(
  `\ncandidate ${W.bundle} sha256 ${bundleDigest.slice(0, 16)}\n`,
);

// reversal: 戻し先の version を先に読む。読めなければ publish しない。
let previous = null;
try {
  const listed = run("wrangler", [
    "versions",
    "list",
    "--name",
    W.worker,
    "--config",
    configPath,
  ]);
  previous =
    listed.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u,
    )?.[1] ?? null;
} catch (error) {
  die(`cannot read the current version list: ${error.message}`);
}
if (!previous)
  die("no current version was readable, so there is no revert point");
process.stdout.write(`previous version ${previous}\n`);

process.stdout.write(`\n==> publishing ${W.worker}\n`);
let output;
try {
  output = run("wrangler", ["deploy", "--config", configPath]);
} catch (error) {
  process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
  die(
    "publication failed; production may be unchanged or partially updated. " +
      `Reconcile against version ${previous} before retrying.`,
  );
}
process.stdout.write(output);

// post-conditions: 実利用者の経路が通ることまで確認する。
let postOk = false;
let postDetail = null;
try {
  process.stdout.write(`\n==> bun run smoke:postdeploy\n`);
  postDetail = run(W.smoke[0], W.smoke.slice(1));
  process.stdout.write(postDetail);
  postOk = true;
} catch (error) {
  postDetail = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  process.stderr.write(postDetail);
  postOk = false;
}

const result = {
  kind: "takos.deploy-result@v1",
  surface: W.surface,
  target: `cloudflare-worker:${W.worker}`,
  commit,
  bundleDigest,
  previousVersion: previous,
  postConditions: postOk ? "PASSED" : "FAILED",
  status: postOk ? "PUBLISHED" : "INDETERMINATE",
};
process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);

if (!postOk) {
  process.stderr.write(
    `\nthe new version is live on ${W.worker} but the post-conditions did not pass. ` +
      `Do not retry blindly: read \`wrangler versions list --name ${W.worker}\` and decide whether to ` +
      `roll back to ${previous}.\n`,
  );
  process.exit(1);
}
