#!/usr/bin/env bun
/**
 * Build-only owner entry. No provider, Host, secret, publication or cleanup port.
 * The private stage owner must call emitHostedStagingArtifacts directly and
 * assertOwnedHostedStagingBuild on the returned object. JSON is not a witness.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = resolve(fileURLToPath(new URL("../", import.meta.url)));
const EMITTER = "scripts/emit-hosted-staging-artifacts.ts";
const GIT = "/usr/bin/git";
export const HOSTED_STAGING_BUN_VERSION = "1.4.0";
export const HOSTED_STAGING_BUILD_COMMANDS = Object.freeze([
  Object.freeze(["install", "--frozen-lockfile"]),
  Object.freeze(["run", "build:worker"]),
  Object.freeze(["scripts/prepare-takoform-v1-source.ts"]),
]);
const SOURCE_FILES = [
  EMITTER,
  "package.json",
  "bun.lock",
  ".well-known/takosumi.json",
  "scripts/build-yurucommu-worker.ts",
  "scripts/yurucommu-worker-bindings.ts",
  "scripts/prepare-takoform-v1-source.ts",
  "scripts/generate-schema-bundle.ts",
  "deploy/product-resources.json",
  "deploy/takoform/migrations/schema-bundle.json",
] as const;
const SQL_BUNDLE = "deploy/takoform/migrations/schema-bundle.json";
const PRODUCT_CONTRACT = "deploy/product-resources.json";
const MAX_MODULE = 8 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_AGGREGATE = 128 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MIGRATION = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;
const issued = new WeakSet<object>();
type ObjectValue = Record<string, unknown>;
export class HostedArtifactEmitterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostedArtifactEmitterError";
  }
}
function need(value: unknown, code: string): asserts value {
  if (!value) throw new HostedArtifactEmitterError(code);
}
function object(value: unknown): ObjectValue {
  need(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_INPUT",
  );
  const prototype = Object.getPrototypeOf(value);
  need(prototype === Object.prototype || prototype === null, "INVALID_INPUT");
  return value as ObjectValue;
}
function exact(value: ObjectValue, names: readonly string[]): void {
  need(
    Reflect.ownKeys(value).length === names.length &&
      names.every((name) => {
        const item = Object.getOwnPropertyDescriptor(value, name);
        return item?.enumerable && "value" in item;
      }),
    "INVALID_INPUT",
  );
}
function string(value: unknown): string {
  need(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 4096 &&
      !/[\x00-\x1f\x7f]/.test(value),
    "INVALID_INPUT",
  );
  return value;
}
export interface HostedStagingEmitterInput {
  readonly commit: string;
  readonly outputParent: string;
  /** An existing supply's selected namespace; this entry never publishes a URL. */
  readonly artifactBaseUrl: string;
}
export function parseHostedStagingEmitterInput(
  value: unknown,
): HostedStagingEmitterInput {
  const input = object(value);
  exact(input, ["commit", "outputParent", "artifactBaseUrl"]);
  const commit = string(input.commit);
  const outputParent = string(input.outputParent);
  const artifactBaseUrl = string(input.artifactBaseUrl);
  need(
    COMMIT.test(commit) &&
      isAbsolute(outputParent) &&
      resolve(outputParent) === outputParent,
    "INVALID_INPUT",
  );
  let base: URL;
  try {
    base = new URL(artifactBaseUrl);
  } catch {
    throw new HostedArtifactEmitterError("INVALID_ARTIFACT_NAMESPACE");
  }
  need(
    base.protocol === "https:" &&
      base.href === artifactBaseUrl &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash &&
      artifactBaseUrl.endsWith("/") &&
      artifactBaseUrl.length < 1024,
    "INVALID_ARTIFACT_NAMESPACE",
  );
  return Object.freeze({ commit, outputParent, artifactBaseUrl });
}
function optionalStat(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw new HostedArtifactEmitterError("PATH_UNCONFIRMED");
  }
}
/** Metadata-only, fail-closed guard. Runs before any subprocess or filesystem writer. */
export function assertHostedStagingOutputParent(directory: string): string {
  need(
    isAbsolute(directory) && resolve(directory) === directory,
    "OUTPUT_PARENT_REFUSED",
  );
  const status = optionalStat(directory);
  need(
    status?.isDirectory() &&
      !status.isSymbolicLink() &&
      status.uid === BigInt(process.getuid?.() ?? -1) &&
      (status.mode & 0o777n) === 0o700n,
    "OUTPUT_PARENT_REFUSED",
  );
  const actual = realpathSync(directory);
  for (const start of new Set([directory, actual])) {
    for (let ancestor = start; ; ancestor = dirname(ancestor)) {
      need(!optionalStat(join(ancestor, ".git")), "OUTPUT_PARENT_IN_GIT");
      const head = optionalStat(join(ancestor, "HEAD"));
      const objects = optionalStat(join(ancestor, "objects"));
      const refs = optionalStat(join(ancestor, "refs"));
      const packed = optionalStat(join(ancestor, "packed-refs"));
      need(!(head && objects && (refs || packed)), "OUTPUT_PARENT_IN_GIT");
      if (dirname(ancestor) === ancestor) break;
    }
  }
  need(actual === directory, "OUTPUT_PARENT_SYMLINK_REFUSED");
  return actual;
}
function sha(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.uid === after.uid &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}
function bytes(path: string, maximum = MAX_FILE): Uint8Array {
  need(realpathSync(path) === path, "SOURCE_PATH_REFUSED");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    need(
      before.isFile() && before.size >= 0n && before.size <= BigInt(maximum),
      "SOURCE_FILE_REFUSED",
    );
    const result = new Uint8Array(Number(before.size));
    let offset = 0;
    while (offset < result.length) {
      const count = readSync(fd, result, offset, result.length - offset, null);
      need(count > 0, "SOURCE_FILE_CHANGED");
      offset += count;
    }
    need(
      readSync(fd, new Uint8Array(1), 0, 1, null) === 0 &&
        sameFile(before, fstatSync(fd, { bigint: true })) &&
        sameFile(before, lstatSync(path, { bigint: true })),
      "SOURCE_FILE_CHANGED",
    );
    return result;
  } finally {
    closeSync(fd);
  }
}
function json(path: string): ObjectValue {
  try {
    return object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(path))),
    );
  } catch {
    throw new HostedArtifactEmitterError("SOURCE_JSON_REFUSED");
  }
}
const GIT_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
});
const GIT_FLAGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.sparseCheckout=false",
  "-c",
  "core.sparseCheckoutCone=false",
];
function git(repository: string, args: readonly string[]): string {
  try {
    return execFileSync(GIT, [...GIT_FLAGS, "-C", repository, ...args], {
      env: GIT_ENV,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new HostedArtifactEmitterError("OWNING_SOURCE_UNCONFIRMED");
  }
}
function assertGitSource(
  root: string,
  commit: string,
  untracked: boolean,
): string {
  need(
    realpathSync(root) === root &&
      git(root, ["rev-parse", "--show-toplevel"]).trim() === root &&
      git(root, ["rev-parse", "HEAD"]).trim() === commit,
    "OWNING_SOURCE_UNCONFIRMED",
  );
  const attributes = git(root, [
    "rev-parse",
    "--git-path",
    "info/attributes",
  ]).trim();
  need(!optionalStat(resolve(root, attributes)), "CHECKOUT_ATTRIBUTES_REFUSED");
  need(
    git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      untracked ? "--untracked-files=all" : "--untracked-files=no",
    ]) === "",
    "OWNING_SOURCE_DIRTY",
  );
  return git(root, ["rev-parse", "HEAD^{tree}"]).trim();
}
function assertNoAmbientBuildFiles(root: string): void {
  const entries = readdirSync(root);
  need(
    !entries.some(
      (name) =>
        (name.startsWith(".env") && name !== ".env.example") ||
        [
          ".npmrc",
          "bunfig.toml",
          ".bunfig.toml",
          ".yarnrc",
          ".yarnrc.yml",
        ].includes(name),
    ),
    "AMBIENT_BUILD_FILE_REFUSED",
  );
}
function assertSourceContract(root: string): void {
  const pkg = json(join(root, "package.json"));
  const scripts = object(pkg.scripts);
  need(
    pkg.name === "@takosjp/yurucommu" &&
      scripts["build:worker"] === "bun scripts/build-yurucommu-worker.ts" &&
      scripts["build:client"] === "bunx vite build --config vite.config.ts",
    "OWNING_BUILD_CONTRACT_CHANGED",
  );
  const repository = json(join(root, ".well-known/takosumi.json"));
  const source = object(
    object(object(object(repository.install).modules)["deploy/takoform"])
      .sourceBuild,
  );
  const commands = (source.commands as ObjectValue[])?.map((item) => item.argv);
  need(
    JSON.stringify(commands) ===
      JSON.stringify(
        HOSTED_STAGING_BUILD_COMMANDS.map((args) => ["bun", ...args]),
      ) &&
      JSON.stringify(source.outputs) ===
        JSON.stringify([
          "deploy/takoform/.generated/yurucommu-worker.js",
          "deploy/takoform/migrations/sql",
        ]),
    "OWNING_BUILD_CONTRACT_CHANGED",
  );
  need(
    json(join(root, PRODUCT_CONTRACT)).product === "yurucommu",
    "PRODUCT_CONTRACT_REFUSED",
  );
}
function privateWrite(
  path: string,
  content: Uint8Array | string,
  mode = 0o600,
): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
/** All Bun children, including the existing builder's nested `bun run`, disable env files. */
function createBuildEnvironment(
  run: string,
  checkout: string,
  bun: string,
): Readonly<Record<string, string>> {
  const tools = join(run, "tools");
  const config = join(run, "config");
  mkdirSync(tools, { mode: 0o700 });
  mkdirSync(config, { mode: 0o700 });
  privateWrite(join(config, "npmrc"), "");
  privateWrite(join(config, "bunfig.toml"), "");
  const flags = `--no-env-file --config=${quote(join(config, "bunfig.toml"))}`;
  privateWrite(
    join(tools, "bun"),
    `#!/bin/sh\nexec ${quote(bun)} ${flags} "$@"\n`,
    0o500,
  );
  // Resolve the owning pinned local Vite only; bunx must not auto-download a substitute.
  privateWrite(
    join(tools, "bunx"),
    `#!/bin/sh\n[ "$1" = "vite" ] || exit 64\nshift\nexec ${quote(bun)} ${flags} ${quote(join(checkout, "node_modules/vite/bin/vite.js"))} "$@"\n`,
    0o500,
  );
  return Object.freeze({
    PATH: `${tools}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    CI: "1",
    NODE_ENV: "production",
    YURUCOMM_WORKER_ENTRY_PROFILE: "default",
    BUN_INSTALL_CACHE_DIR: join(run, "cache"),
    XDG_CONFIG_HOME: config,
    NPM_CONFIG_USERCONFIG: join(config, "npmrc"),
  });
}
function runOwned(
  bun: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      bun,
      [
        "--no-env-file",
        `--config=${join(env.XDG_CONFIG_HOME!, "bunfig.toml")}`,
        ...args,
      ],
      { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let outputBytes = 0;
    let refused = false;
    const kill = () => {
      if (refused) return;
      refused = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
    };
    const timer = setTimeout(kill, 10 * 60_000);
    const consume = (part: Uint8Array) => {
      outputBytes += part.byteLength;
      if (outputBytes > 1024 * 1024) kill();
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", () => {
      clearTimeout(timer);
      kill();
      reject(new HostedArtifactEmitterError("OWNING_BUILD_FAILED"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !refused) resolveRun();
      else reject(new HostedArtifactEmitterError("OWNING_BUILD_FAILED"));
    });
  });
}
interface Migration {
  readonly name: string;
  readonly digest: string;
  readonly sql: string;
}
function migrations(root: string): readonly Migration[] {
  const schema = json(join(root, SQL_BUNDLE));
  need(
    schema.apiVersion === "takosumi.resource-migrations/v1" &&
      schema.engine === "sqlite" &&
      Array.isArray(schema.entries) &&
      schema.entries.length > 0 &&
      schema.entries.length <= 512,
    "SQL_CONTRACT_REFUSED",
  );
  let previous = "";
  return Object.freeze(
    schema.entries.map((value): Migration => {
      const entry = object(value);
      exact(entry, ["name", "sha256", "sql"]);
      const name = string(entry.name);
      const sql = typeof entry.sql === "string" ? entry.sql : "";
      const digest = string(entry.sha256).replace(/^sha256:/, "");
      need(
        MIGRATION.test(name) &&
          name > previous &&
          sql.length > 0 &&
          DIGEST.test(digest) &&
          sha(sql) === digest,
        "SQL_CONTRACT_REFUSED",
      );
      previous = name;
      return Object.freeze({ name, digest, sql });
    }),
  );
}
export interface ManifestFile {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly mediaType: "application/javascript+module" | "application/sql";
}
/** Deterministic serialization only. This helper cannot issue an owning build witness. */
export function hostedStagingManifest(
  form: "WorkerBundle" | "SQLiteMigrationSet",
  files: readonly ManifestFile[],
): Uint8Array {
  need(files.length > 0 && files.length <= 512, "MANIFEST_REFUSED");
  let previous = "";
  const selected = files.map((entry) => {
    need(
      DIGEST.test(entry.sha256) && entry.path > previous,
      "MANIFEST_REFUSED",
    );
    previous = entry.path;
    const url = new URL(entry.url);
    need(
      url.protocol === "https:" &&
        url.href === entry.url &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "MANIFEST_REFUSED",
    );
    need(
      form === "WorkerBundle"
        ? entry.path === "yurucommu-worker.js" &&
            entry.mediaType === "application/javascript+module"
        : MIGRATION.test(entry.path) && entry.mediaType === "application/sql",
      "MANIFEST_REFUSED",
    );
    return {
      path: entry.path,
      url: entry.url,
      sha256: entry.sha256,
      mediaType: entry.mediaType,
    };
  });
  need(form !== "WorkerBundle" || selected.length === 1, "MANIFEST_REFUSED");
  const value =
    form === "WorkerBundle"
      ? { entrypoint: "yurucommu-worker.js", files: selected }
      : { files: selected };
  const result = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  need(result.byteLength <= 1024 * 1024, "MANIFEST_REFUSED");
  return result;
}
export interface HostedStagingBuildInventory {
  readonly form: "WorkerBundle" | "SQLiteMigrationSet";
  readonly artifact: { readonly url: string; readonly sha256: string };
  readonly manifestPath: string;
  readonly files: readonly {
    readonly path: string;
    readonly url: string;
    readonly sha256: string;
    readonly sourcePath: string;
  }[];
}
interface Seal {
  readonly root: string;
  readonly digest: string;
  readonly bytes: number;
  readonly files: number;
  assertUnchanged(): void;
}
function sealPayload(root: string): Seal {
  const snapshots = new Map<string, { stat: BigIntStats; digest?: string }>();
  const walk = (
    path: string,
    sealing: boolean,
  ): { digest: string; bytes: number; files: number } => {
    const hash = createHash("sha256");
    let total = 0;
    let count = 0;
    const seen = new Set<string>();
    const visit = (directory: string) => {
      need(realpathSync(directory) === directory, "PAYLOAD_CHANGED");
      const names = readdirSync(directory).sort();
      for (const name of names) {
        const selected = join(directory, name);
        const status = lstatSync(selected, { bigint: true });
        need(
          status.uid === BigInt(process.getuid?.() ?? -1) &&
            !status.isSymbolicLink(),
          "PAYLOAD_CHANGED",
        );
        if (status.isDirectory()) visit(selected);
        else {
          need(
            status.isFile() && status.nlink === 1n && ++count <= 1024,
            "PAYLOAD_CHANGED",
          );
          const content = bytes(selected);
          total += content.length;
          need(total <= MAX_AGGREGATE, "PAYLOAD_TOO_LARGE");
          const child = relative(root, selected).split(sep).join("/");
          hash.update(child);
          hash.update("\0");
          hash.update(String(content.length));
          hash.update("\0");
          hash.update(content);
          if (sealing) {
            chmodSync(selected, 0o400);
            snapshots.set(selected, {
              stat: lstatSync(selected, { bigint: true }),
              digest: sha(content),
            });
          } else {
            const before = snapshots.get(selected);
            need(
              before &&
                sameFile(before.stat, status) &&
                before.digest === sha(content),
              "PAYLOAD_CHANGED",
            );
          }
          seen.add(selected);
        }
      }
      if (sealing) {
        chmodSync(directory, 0o500);
        snapshots.set(directory, {
          stat: lstatSync(directory, { bigint: true }),
        });
        syncDirectory(directory);
      } else
        need(
          snapshots.has(directory) &&
            sameFile(
              snapshots.get(directory)!.stat,
              lstatSync(directory, { bigint: true }),
            ),
          "PAYLOAD_CHANGED",
        );
      seen.add(directory);
    };
    visit(path);
    need(sealing || seen.size === snapshots.size, "PAYLOAD_CHANGED");
    return {
      digest: `sha256:${hash.digest("hex")}`,
      bytes: total,
      files: count,
    };
  };
  const identity = walk(root, true);
  return Object.freeze({
    root,
    ...identity,
    assertUnchanged() {
      const now = walk(root, false);
      need(JSON.stringify(now) === JSON.stringify(identity), "PAYLOAD_CHANGED");
    },
  });
}
export interface OwnedHostedStagingBuild {
  readonly appRepository: string;
  readonly appCommit: string;
  readonly output: Seal;
  readonly inventory: readonly HostedStagingBuildInventory[];
  readonly receiptPath: string;
  readonly provenancePath: string;
  readonly retention: "retain-until-owning-stage-custody-settles";
  assertBuiltFromSource(): Promise<void>;
}
export function assertOwnedHostedStagingBuild(
  value: unknown,
): asserts value is OwnedHostedStagingBuild {
  need(
    typeof value === "object" && value !== null && issued.has(value),
    "OWNING_BUILD_WITNESS_REQUIRED",
  );
}
function lockedPackages(root: string): readonly ObjectValue[] {
  const lock = new TextDecoder().decode(bytes(join(root, "bun.lock")));
  return [
    "@takosjp/yurucommu-core",
    "@takosjp/yurucommu-api",
    "esbuild",
    "vite",
  ].map((name) => {
    const prefix = `"${name}": ["${name}@`;
    const row = lock
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(prefix));
    need(row, "OWNING_LOCK_REFUSED");
    const version = row.slice(prefix.length).split('"')[0]!;
    const integrity = row.match(/"(sha512-[A-Za-z0-9+/=]+)"\],?$/)?.[1];
    const metadata = json(join(root, "node_modules", name, "package.json"));
    need(integrity && metadata.version === version, "INSTALLED_LOCK_MISMATCH");
    return { name, version, integrity };
  });
}
/** Only this fixed owning execution can mint the in-memory witness. No runner test seam. */
export async function emitHostedStagingArtifacts(
  value: HostedStagingEmitterInput,
): Promise<OwnedHostedStagingBuild> {
  const input = parseHostedStagingEmitterInput(value);
  const parent = assertHostedStagingOutputParent(input.outputParent);
  need(
    process.platform === "linux" &&
      typeof Bun !== "undefined" &&
      Bun.version === HOSTED_STAGING_BUN_VERSION,
    "PINNED_BUN_REQUIRED",
  );
  need(realpathSync(OWNER) === OWNER, "OWNING_SOURCE_UNCONFIRMED");
  const sourceTree = assertGitSource(OWNER, input.commit, false);
  assertSourceContract(OWNER);
  // No caller worktree bytes enter the build; tracked edits are refused and
  // ignored/untracked files (including borrowed node_modules) stay untouched.
  const tree = git(OWNER, ["ls-tree", "-r", input.commit]).trim().split("\n");
  need(
    !tree.some(
      (entry) =>
        entry.startsWith("120000 ") ||
        entry.startsWith("160000 ") ||
        entry.split("\t")[1] === ".gitmodules" ||
        entry.split("\t")[1]?.split("/").at(-1) === ".gitattributes",
    ),
    "CHECKOUT_FILTER_LINK_OR_SUBMODULE_REFUSED",
  );
  const infoAttributes = git(OWNER, [
    "rev-parse",
    "--git-path",
    "info/attributes",
  ]).trim();
  need(
    !optionalStat(resolve(OWNER, infoAttributes)),
    "CHECKOUT_ATTRIBUTES_REFUSED",
  );
  need(
    !tree.some((entry) => {
      const path = entry.split("\t")[1] ?? "";
      return (
        !path.includes("/") &&
        ((path.startsWith(".env") && path !== ".env.example") ||
          [
            ".npmrc",
            "bunfig.toml",
            ".bunfig.toml",
            ".yarnrc",
            ".yarnrc.yml",
          ].includes(path))
      );
    }),
    "AMBIENT_BUILD_FILE_REFUSED",
  );
  const bun = realpathSync(process.execPath);
  const bunStatus = lstatSync(bun, { bigint: true });
  const bunDigest = sha(bytes(bun, 256 * 1024 * 1024));
  const gitStatus = lstatSync(realpathSync(GIT), { bigint: true });
  const gitDigest = sha(bytes(realpathSync(GIT), 32 * 1024 * 1024));
  // Every guard above precedes the first writer and the fresh worktree registration.
  const run = mkdtempSync(join(parent, "yurucommu-owning-build-"));
  chmodSync(run, 0o700);
  const checkout = join(run, "source");
  const payload = join(run, "payload");
  const evidence = join(run, "evidence");
  mkdirSync(payload, { mode: 0o700 });
  mkdirSync(evidence, { mode: 0o700 });
  git(OWNER, [
    "worktree",
    "add",
    "--detach",
    "--no-checkout",
    checkout,
    input.commit,
  ]);
  git(checkout, ["checkout", "--detach", "--force", input.commit]);
  chmodSync(checkout, 0o700);
  need(
    assertGitSource(checkout, input.commit, true) === sourceTree,
    "OWNING_SOURCE_UNCONFIRMED",
  );
  assertSourceContract(checkout);
  assertNoAmbientBuildFiles(checkout);
  need(
    !optionalStat(join(checkout, "dist")) &&
      !optionalStat(join(checkout, "node_modules")),
    "FRESH_BUILD_REQUIRED",
  );
  const sources = Object.fromEntries(
    SOURCE_FILES.map((name) => [name, sha(bytes(join(checkout, name)))]),
  );
  const sql = migrations(checkout);
  const env = createBuildEnvironment(run, checkout, bun);
  const support = [
    "tools/bun",
    "tools/bunx",
    "config/bunfig.toml",
    "config/npmrc",
  ].map((name) => ({
    name,
    path: join(run, name),
    stat: lstatSync(join(run, name), { bigint: true }),
    digest: sha(bytes(join(run, name))),
  }));
  const assertSupport = () => {
    for (const item of support)
      need(
        sameFile(item.stat, lstatSync(item.path, { bigint: true })) &&
          sha(bytes(item.path)) === item.digest,
        "BUILD_ENVIRONMENT_CHANGED",
      );
  };
  for (const args of HOSTED_STAGING_BUILD_COMMANDS) {
    assertNoAmbientBuildFiles(checkout);
    assertSupport();
    need(
      sameFile(bunStatus, lstatSync(bun, { bigint: true })) &&
        sameFile(gitStatus, lstatSync(realpathSync(GIT), { bigint: true })),
      "BUILD_TOOL_CHANGED",
    );
    // Install the owning dev tools too. Production is fixed only for compilation.
    await runOwned(
      bun,
      args,
      checkout,
      args[0] === "install" ? { ...env, NODE_ENV: "development" } : env,
    );
    assertNoAmbientBuildFiles(checkout);
    assertSupport();
  }
  await runOwned(
    bun,
    ["scripts/generate-schema-bundle.ts", "--check"],
    checkout,
    env,
  );
  assertSupport();
  const packages = lockedPackages(checkout);
  need(
    assertGitSource(checkout, input.commit, true) === sourceTree,
    "OWNING_SOURCE_UNCONFIRMED",
  );
  for (const [name, digest] of Object.entries(sources))
    need(sha(bytes(join(checkout, name))) === digest, "OWNING_SOURCE_CHANGED");
  const moduleBytes = bytes(
    join(checkout, "dist/yurucommu-worker.js"),
    MAX_MODULE,
  );
  need(
    moduleBytes.length > 0 &&
      sha(moduleBytes) ===
        sha(
          bytes(
            join(checkout, "deploy/takoform/.generated/yurucommu-worker.js"),
            MAX_MODULE,
          ),
        ),
    "OWNING_MODULE_CHANGED",
  );
  const preparedSql = join(checkout, "deploy/takoform/migrations/sql");
  need(
    JSON.stringify(readdirSync(preparedSql).sort()) ===
      JSON.stringify(sql.map((item) => item.name)),
    "PREPARED_SQL_CHANGED",
  );
  mkdirSync(join(payload, "worker"), { mode: 0o700 });
  mkdirSync(join(payload, "sqlite"), { mode: 0o700 });
  const moduleDigest = sha(moduleBytes);
  const workerFile = {
    path: "yurucommu-worker.js",
    url: `${input.artifactBaseUrl}worker/${moduleDigest}/yurucommu-worker.js`,
    sha256: moduleDigest,
    mediaType: "application/javascript+module" as const,
  };
  privateWrite(join(payload, "worker/yurucommu-worker.js"), moduleBytes);
  const sqlFiles = sql.map((item) => {
    const body = bytes(join(preparedSql, item.name));
    need(
      sha(body) === item.digest && sha(item.sql) === item.digest,
      "PREPARED_SQL_CHANGED",
    );
    privateWrite(join(payload, "sqlite", item.name), body);
    return {
      path: item.name,
      url: `${input.artifactBaseUrl}sqlite/${item.digest}/${item.name}`,
      sha256: item.digest,
      mediaType: "application/sql" as const,
    };
  });
  const artifacts = (
    [
      ["WorkerBundle", "worker", [workerFile]],
      ["SQLiteMigrationSet", "sqlite", sqlFiles],
    ] as const
  ).map(([form, folder, files]): HostedStagingBuildInventory => {
    const manifest = hostedStagingManifest(form, files);
    const digest = sha(manifest);
    const manifestPath = `${folder}/manifest.json`;
    privateWrite(join(payload, manifestPath), manifest);
    return Object.freeze({
      form,
      artifact: Object.freeze({
        url: `${input.artifactBaseUrl}${folder}/${digest}/manifest.json`,
        sha256: digest,
      }),
      manifestPath,
      files: Object.freeze(
        files.map((item) =>
          Object.freeze({
            path: item.path,
            url: item.url,
            sha256: item.sha256,
            sourcePath: `${folder}/${item.path}`,
          }),
        ),
      ),
    });
  });
  const output = sealPayload(payload);
  need(output.files === sql.length + 3, "PAYLOAD_CLOSURE_MISMATCH");
  const receipt = {
    kind: "yurucommu.hosted-artifacts@v2",
    sourceCommit: input.commit,
    productResourcesSha256: sources[PRODUCT_CONTRACT],
    schemaBundleSha256: sources[SQL_BUNDLE],
    workerBundle: {
      artifact: artifacts[0]!.artifact,
      manifestFile: join(payload, artifacts[0]!.manifestPath),
    },
    migrationSet: {
      artifact: artifacts[1]!.artifact,
      manifestFile: join(payload, artifacts[1]!.manifestPath),
    },
  };
  const receiptPath = join(evidence, "yurucommu-hosted-artifacts.json");
  const provenancePath = join(evidence, "owning-build-provenance.json");
  privateWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  privateWrite(
    provenancePath,
    `${JSON.stringify(
      {
        app: "yurucommu",
        commit: input.commit,
        sourceTree,
        checkout,
        sources,
        commands: HOSTED_STAGING_BUILD_COMMANDS,
        additionalReadOnlyCheck: [
          "scripts/generate-schema-bundle.ts",
          "--check",
        ],
        bun: {
          version: HOSTED_STAGING_BUN_VERSION,
          executable: bun,
          sha256: bunDigest,
        },
        git: { executable: realpathSync(GIT), sha256: gitDigest },
        packages,
        environmentKeys: Object.keys(env).sort(),
        environmentSha256: sha(JSON.stringify(env)),
        supportFiles: support.map(({ name, digest }) => ({
          name,
          sha256: digest,
        })),
        installNodeEnv: "development",
        compileNodeEnv: "production",
        envFilesAbsent: true,
        nestedBunNoEnvFile: true,
        viteEnvFilesAbsent: true,
        artifactBaseUrl: input.artifactBaseUrl,
        payload: {
          digest: output.digest,
          files: output.files,
          bytes: output.bytes,
        },
        receiptSha256: sha(bytes(receiptPath)),
        publicationPerformed: false,
      },
      null,
      2,
    )}\n`,
  );
  syncDirectory(evidence);
  syncDirectory(run);
  const metadata = [receiptPath, provenancePath].map((path) => {
    const stat = lstatSync(path, { bigint: true });
    need(
      stat.isFile() &&
        stat.nlink === 1n &&
        stat.uid === BigInt(process.getuid?.() ?? -1) &&
        (stat.mode & 0o777n) === 0o600n,
      "BUILD_WITNESS_CHANGED",
    );
    return { path, stat, digest: sha(bytes(path)) };
  });
  const evidenceStatus = lstatSync(evidence, { bigint: true });
  const witness: OwnedHostedStagingBuild = Object.freeze({
    appRepository: checkout,
    appCommit: input.commit,
    output,
    inventory: Object.freeze(artifacts),
    receiptPath,
    provenancePath,
    retention: "retain-until-owning-stage-custody-settles" as const,
    async assertBuiltFromSource() {
      assertOwnedHostedStagingBuild(witness);
      need(
        assertGitSource(checkout, input.commit, true) === sourceTree,
        "OWNING_SOURCE_CHANGED",
      );
      assertNoAmbientBuildFiles(checkout);
      assertSupport();
      for (const [name, digest] of Object.entries(sources))
        need(
          sha(bytes(join(checkout, name))) === digest,
          "OWNING_SOURCE_CHANGED",
        );
      need(
        sameFile(bunStatus, lstatSync(bun, { bigint: true })) &&
          sameFile(gitStatus, lstatSync(realpathSync(GIT), { bigint: true })),
        "BUILD_TOOL_CHANGED",
      );
      need(
        sha(bytes(join(checkout, "dist/yurucommu-worker.js"), MAX_MODULE)) ===
          moduleDigest,
        "OWNING_MODULE_CHANGED",
      );
      for (const item of metadata)
        need(
          sameFile(item.stat, lstatSync(item.path, { bigint: true })) &&
            sha(bytes(item.path)) === item.digest,
          "BUILD_WITNESS_CHANGED",
        );
      need(
        sameFile(evidenceStatus, lstatSync(evidence, { bigint: true })),
        "BUILD_WITNESS_CHANGED",
      );
      output.assertUnchanged();
    },
  });
  // No serialization, caller callback, reconstructed seal, or test fixture can add this brand.
  issued.add(witness);
  await witness.assertBuiltFromSource();
  return witness;
}

if (import.meta.main) {
  try {
    const flags = new Map<string, string>();
    for (const argument of process.argv.slice(2)) {
      const match = /^--(commit|output-parent|artifact-base-url)=(.+)$/.exec(
        argument,
      );
      need(match && !flags.has(match[1]!), "ARGUMENT_REFUSED");
      flags.set(match[1]!, match[2]!);
    }
    need(flags.size === 3, "ARGUMENT_REFUSED");
    const result = await emitHostedStagingArtifacts({
      commit: flags.get("commit")!,
      outputParent: flags.get("output-parent")!,
      artifactBaseUrl: flags.get("artifact-base-url")!,
    });
    console.log(
      JSON.stringify({
        status: "LOCAL_BUILD_ONLY",
        commit: result.appCommit,
        files: result.output.files,
        payloadSha256: result.output.digest,
        receiptPath: result.receiptPath,
        provenancePath: result.provenancePath,
        publicationPerformed: false,
        runnable: false,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "BUILD_UNQUALIFIED",
        code:
          error instanceof HostedArtifactEmitterError
            ? error.code
            : "OWNING_BUILD_UNCONFIRMED",
      }),
    );
    process.exitCode = 1;
  }
}
