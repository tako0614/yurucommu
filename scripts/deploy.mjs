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
import { existsSync, readFileSync } from "node:fs";
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

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: W.surface,
      target: `cloudflare-worker:${W.worker}`,
      covers: ["wrangler.jsonc"],
      requiresScripts: ["check", "build:worker", "smoke:postdeploy"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: ["YURUCOMMU_WRANGLER_CONFIG"],
      // code だけを差し替えます。直前の version がそのまま戻し先として残るので
      // irreversible は立ちません。durable store の schema を変える作業は
      // この surface ではなく、別の deliberate な手順です。
      triggers: [],
      obligations: {
        provenance: `refuses a dirty worktree, runs \`${OWNER_GATE}\`, builds ${W.bundle} from that worktree with \`bun run build\`, and records the commit and the bundle sha256 It takes the operator's realized deploy config from YURUCOMMU_WRANGLER_CONFIG and refuses to publish a config that still holds a self-host template placeholder.`,
        "post-conditions": `runs \`bun run smoke:postdeploy\`, which exercises real request paths against the deployed Worker rather than a health endpoint`,
        reversal: `the current version id is read and printed before publishing; restore it with \`wrangler versions list --name ${W.worker}\` and \`wrangler versions deploy <previous-id>@100%\``,
        "failure-handling":
          "prints the provider's own stdout and stderr, names whether the failure was before or after publication, and on a failed post-condition exits non-zero naming the previous version instead of retrying",
      },
    },
  ],
};

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
  process.exit(0);
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (requested.length !== 1 || requested[0] !== W.surface) {
  process.stderr.write(`usage: bun run deploy -- ${W.surface}\n`);
  process.exit(1);
}

function die(message, detail = []) {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const line of detail) process.stderr.write(`- ${line}\n`);
  process.exit(1);
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
const configValues = readFileSync(resolvedConfig, "utf8")
  .split("\n")
  .filter((line) => !/^\s*(?:#|\/\/)/u.test(line))
  .join("\n");
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
