import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API,
  APP_SUFFIX,
  PRIVATE_NAMES,
  check,
  digestPattern,
  exact,
  publicUrl,
  record,
  text,
  type Artifact,
  type Fixture,
  type Target,
} from "./contracts.ts";

export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const PRODUCT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export interface ExecuteConfig {
  mode: "execute";
  runId: string;
  targetFile: string;
  fixtureFile: string;
  journalDirectory: string;
  writer: string;
  evidence: string;
  privateInputs: Readonly<Record<string, string>>;
}
export type Config = { mode: "dry-run" } | ExecuteConfig;
export function readConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Config {
  check(
    argv.length <= 1 &&
      (argv.length === 0 || argv[0] === "--dry-run" || argv[0] === "--execute"),
    "ARGUMENT_REFUSED",
  );
  if (argv[0] !== "--execute") return { mode: "dry-run" };
  check(
    env.YURUCOMMU_HOSTED_E2E_ENVIRONMENT === "staging",
    "ENVIRONMENT_REFUSED",
  );
  check(
    !env.DEBUG && !env.TF_LOG && !env.NODE_DEBUG && !env.BUN_INSPECT,
    "DIAGNOSTICS_REFUSED",
  );
  check(!env.BUN_CONFIG_VERBOSE_FETCH, "DIAGNOSTICS_REFUSED");
  check(
    ![
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ].some((name) => env[name]),
    "PROXY_REFUSED",
  );
  const take = (name: string) => {
    const value = env[name];
    check(
      typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 8192 &&
        !/[\r\n\0]/.test(value),
      "INPUT_REQUIRED",
    );
    return value;
  };
  const writer = take("TAKOFORM_TOKEN");
  const evidence = take("TAKOFORM_EVIDENCE_TOKEN");
  check(writer !== evidence, "CREDENTIALS_NOT_DISTINCT");
  const path = (name: string) => {
    const value = take(name);
    check(isAbsolute(value), "PATH_REFUSED");
    return value;
  };
  const privateInputs = Object.fromEntries(
    PRIVATE_NAMES.map((name) => [name, take(name)]),
  );
  check(
    /^[0-9a-f]{64}$/.test(privateInputs.ENCRYPTION_KEY!) &&
      /^[0-9a-f]{64}$/.test(privateInputs.YURUCOMMU_SESSION_HASH_SALT!),
    "PRIVATE_INPUT_INVALID",
  );
  publicUrl(privateInputs.TAKOSUMI_ACCOUNTS_ISSUER_URL);
  publicUrl(privateInputs.TAKOSUMI_ACCOUNTS_REDIRECT_URI);
  return {
    mode: "execute",
    runId: `yurucommu-e2e-${randomBytes(6).toString("hex")}`,
    targetFile: path("YURUCOMMU_HOSTED_E2E_TARGET_FILE"),
    fixtureFile: path("YURUCOMMU_HOSTED_E2E_FIXTURE_FILE"),
    journalDirectory: path("YURUCOMMU_HOSTED_E2E_JOURNAL_DIRECTORY"),
    writer,
    evidence,
    privateInputs,
  };
}
export async function readBoundedFile(
  path: string,
  maximum = 1_048_576,
): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.size <= maximum, "FILE_REFUSED");
    const bytes = await handle.readFile();
    check(bytes.byteLength <= maximum, "FILE_REFUSED");
    return bytes;
  } finally {
    await handle.close();
  }
}
export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("INVALID_JSON");
  }
}
export function parseTarget(value: unknown): Target {
  const target = record(value);
  exact(target, [
    "kind",
    "environment",
    "api",
    "hostOrigin",
    "space",
    "qualifiedHostCommit",
    "qualificationReceiptSha256",
    "appSuffix",
  ]);
  check(
    target.kind === "yurucommu.hosted-staging-target@v2" &&
      target.environment === "staging" &&
      target.api === API &&
      target.appSuffix === APP_SUFFIX,
    "TARGET_REFUSED",
  );
  const url = new URL(publicUrl(`${text(target.hostOrigin)}/`));
  check(
    url.origin === target.hostOrigin &&
      /(?:^|[.-])staging(?:[.-]|$)/.test(url.hostname),
    "TARGET_REFUSED",
  );
  const space = text(target.space);
  check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(space), "TARGET_REFUSED");
  const qualifiedHostCommit = text(target.qualifiedHostCommit);
  const qualificationReceiptSha256 = text(target.qualificationReceiptSha256);
  check(
    /^[0-9a-f]{40}$/.test(qualifiedHostCommit) &&
      digestPattern.test(qualificationReceiptSha256),
    "TARGET_REFUSED",
  );
  return {
    hostOrigin: url.origin,
    space,
    qualifiedHostCommit,
    qualificationReceiptSha256,
  };
}
function artifact(value: unknown): Artifact {
  const ref = record(value);
  exact(ref, ["url", "sha256"]);
  const sha = text(ref.sha256);
  check(digestPattern.test(sha), "ARTIFACT_REFUSED");
  return { url: publicUrl(ref.url), sha256: sha };
}
export async function loadFixture(path: string): Promise<Fixture> {
  const receiptBytes = await readBoundedFile(path);
  const receipt = record(parseJson(receiptBytes));
  exact(receipt, [
    "kind",
    "sourceCommit",
    "productResourcesSha256",
    "schemaBundleSha256",
    "workerBundle",
    "migrationSet",
  ]);
  check(
    receipt.kind === "yurucommu.hosted-artifacts@v2" &&
      /^[0-9a-f]{40}$/.test(text(receipt.sourceCommit)),
    "FIXTURE_REFUSED",
  );
  const product = await readBoundedFile(
    `${PRODUCT_ROOT}deploy/product-resources.json`,
  );
  const schema = await readBoundedFile(
    `${PRODUCT_ROOT}deploy/takoform/migrations/schema-bundle.json`,
    16_777_216,
  );
  check(
    receipt.productResourcesSha256 === sha256(product) &&
      receipt.schemaBundleSha256 === sha256(schema),
    "SOURCE_CONTRACT_MISMATCH",
  );
  const ledger = record(parseJson(schema));
  check(
    Array.isArray(ledger.entries) && ledger.entries.length > 0,
    "SOURCE_CONTRACT_MISMATCH",
  );
  const expected = ledger.entries
    .map((value) => {
      const entry = record(value);
      const name = text(entry.name);
      const digest = text(entry.sha256).replace(/^sha256:/, "");
      check(
        /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name) &&
          digestPattern.test(digest) &&
          sha256(text(entry.sql)) === digest,
        "SOURCE_CONTRACT_MISMATCH",
      );
      return { name, digest };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const load = async (value: unknown, worker: boolean) => {
    const descriptor = record(value);
    exact(descriptor, ["artifact", "manifestFile"]);
    const ref = artifact(descriptor.artifact);
    const file = text(descriptor.manifestFile);
    check(isAbsolute(file), "PATH_REFUSED");
    const bytes = await readBoundedFile(file);
    check(sha256(bytes) === ref.sha256, "MANIFEST_DIGEST_MISMATCH");
    const manifest = record(parseJson(bytes));
    exact(manifest, worker ? ["entrypoint", "files"] : ["files"]);
    check(
      Array.isArray(manifest.files) &&
        manifest.files.length > 0 &&
        manifest.files.length <= 512,
      "MANIFEST_REFUSED",
    );
    const files = manifest.files.map((value) => {
      const item = record(value);
      exact(item, ["path", "url", "sha256", "mediaType"]);
      return {
        ...artifact({ url: item.url, sha256: item.sha256 }),
        path: text(item.path),
        mediaType: text(item.mediaType),
      };
    });
    if (worker) {
      check(
        manifest.entrypoint === "yurucommu-worker.js" &&
          files.length === 1 &&
          files[0]!.path === manifest.entrypoint &&
          files[0]!.mediaType === "application/javascript+module",
        "YURUCOMMU_BUNDLE_REQUIRED",
      );
    } else {
      check(
        files.length === expected.length &&
          files.every(
            (item, index) =>
              item.path === expected[index]!.name &&
              item.sha256 === expected[index]!.digest &&
              item.mediaType === "application/sql",
          ),
        "MIGRATION_CONTRACT_MISMATCH",
      );
    }
    return { ref, files: files.map(({ url, sha256 }) => ({ url, sha256 })) };
  };
  const worker = await load(receipt.workerBundle, true);
  const migrations = await load(receipt.migrationSet, false);
  const files = [
    worker.ref,
    migrations.ref,
    ...worker.files,
    ...migrations.files,
  ];
  check(
    new Set(files.map((item) => item.url)).size === files.length,
    "MANIFEST_REFUSED",
  );
  return {
    sourceCommit: text(receipt.sourceCommit),
    receiptSha256: sha256(receiptBytes),
    workerBundle: worker.ref,
    migrationSet: migrations.ref,
    files,
  };
}
