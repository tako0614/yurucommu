#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_PACKAGE_NAME = "@takosjp/yurucommu-core";
export const BUNDLE_RELATIVE_PATH =
  "deploy/takoform/migrations/schema-bundle.json";
export const MIGRATION_NAME_RE = /^[0-9]{4}_[A-Za-z0-9_-]+\.sql$/u;

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

export type SchemaBundleEntry = {
  readonly name: string;
  readonly sha256: string;
  readonly sql: string;
};

export type SchemaBundle = {
  readonly apiVersion: "takosumi.resource-migrations/v1";
  readonly engine: "sqlite";
  readonly entries: readonly SchemaBundleEntry[];
};

export type SchemaBundleProvenance = {
  readonly packageName: typeof CORE_PACKAGE_NAME;
  readonly declaredVersionSpec: string;
  readonly lockedVersionSpec: string;
  readonly lockedVersion: string;
  readonly lockIntegrity: string;
  readonly installedVersion: string;
  readonly migrationDirectory: string;
};

type PackageJson = {
  readonly dependencies?: Readonly<Record<string, unknown>>;
};

type InstalledPackageJson = {
  readonly version?: unknown;
};

function lockWorkspaceDependency(
  lockText: string,
  packageName: string,
): string {
  const prefix = '"' + packageName + '": "';
  const line = lockText
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  const versionSpec = line?.slice(prefix.length).replace(/",?\s*$/u, "");
  if (!versionSpec) {
    throw new Error(
      "bun.lock is missing the workspace dependency for " + packageName,
    );
  }
  return versionSpec;
}

function lockPackageRecord(
  lockText: string,
  packageName: string,
): { version: string; integrity: string } {
  const prefix = '"' + packageName + '": ["' + packageName + "@";
  const line = lockText
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    throw new Error(
      "bun.lock is missing the package record for " + packageName,
    );
  }
  const remainder = line.slice(prefix.length);
  const versionEnd = remainder.indexOf('"');
  const integrity = remainder.match(/,\s*"(sha512-[^"]+)"\],?\s*$/u)?.[1];
  if (versionEnd < 1 || !integrity) {
    throw new Error(
      "bun.lock has an invalid package record for " + packageName,
    );
  }
  return { version: remainder.slice(0, versionEnd), integrity };
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(label + " must be a non-empty string");
  }
  return value;
}

export async function readSchemaBundleProvenance(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<SchemaBundleProvenance> {
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as PackageJson;
  const declaredVersionSpec = assertNonEmptyString(
    packageJson.dependencies?.[CORE_PACKAGE_NAME],
    "package.json dependency " + CORE_PACKAGE_NAME,
  );
  const lockText = await readFile(join(repositoryRoot, "bun.lock"), "utf8");
  const lockedVersionSpec = lockWorkspaceDependency(
    lockText,
    CORE_PACKAGE_NAME,
  );
  if (lockedVersionSpec !== declaredVersionSpec) {
    throw new Error(
      "package.json and bun.lock disagree for " +
        CORE_PACKAGE_NAME +
        ": " +
        declaredVersionSpec +
        " !== " +
        lockedVersionSpec,
    );
  }
  const locked = lockPackageRecord(lockText, CORE_PACKAGE_NAME);
  const installedPackagePath = join(
    repositoryRoot,
    "node_modules",
    ...CORE_PACKAGE_NAME.split("/"),
    "package.json",
  );
  const installedPackage = JSON.parse(
    await readFile(installedPackagePath, "utf8"),
  ) as InstalledPackageJson;
  const installedVersion = assertNonEmptyString(
    installedPackage.version,
    "installed " + CORE_PACKAGE_NAME + " version",
  );
  if (installedVersion !== locked.version) {
    throw new Error(
      "installed " +
        CORE_PACKAGE_NAME +
        " does not match bun.lock: " +
        installedVersion +
        " !== " +
        locked.version,
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(locked.version)) {
    throw new Error(
      "bun.lock has an invalid " + CORE_PACKAGE_NAME + " version",
    );
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(locked.integrity)) {
    throw new Error(
      "bun.lock has an invalid " + CORE_PACKAGE_NAME + " integrity",
    );
  }
  const migrationDirectory = join(
    repositoryRoot,
    "node_modules",
    ...CORE_PACKAGE_NAME.split("/"),
    "migrations",
  );
  return {
    packageName: CORE_PACKAGE_NAME,
    declaredVersionSpec,
    lockedVersionSpec,
    lockedVersion: locked.version,
    lockIntegrity: locked.integrity,
    installedVersion,
    migrationDirectory,
  };
}

function sha256(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array, name: string): string {
  let sql: string;
  try {
    sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("migration " + name + " is not valid UTF-8");
  }
  const roundTripped = new TextEncoder().encode(sql);
  if (
    roundTripped.byteLength !== bytes.byteLength ||
    roundTripped.some((byte, index) => byte !== bytes[index])
  ) {
    throw new Error("migration " + name + " changed when decoded as UTF-8");
  }
  return sql;
}

export async function buildSchemaBundle(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<SchemaBundle> {
  const provenance = await readSchemaBundleProvenance(repositoryRoot);
  const entries = (
    await readdir(provenance.migrationDirectory, {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (entries.length === 0) {
    throw new Error(
      "no SQL migration files found in " + provenance.migrationDirectory,
    );
  }
  for (let index = 0; index < entries.length; index += 1) {
    const name = entries[index];
    if (!MIGRATION_NAME_RE.test(name)) {
      throw new Error("migration name is invalid: " + name);
    }
    if (index > 0 && entries[index - 1] >= name) {
      throw new Error("migration names are not strictly ascending: " + name);
    }
  }

  const bundleEntries: SchemaBundleEntry[] = [];
  for (const name of entries) {
    const bytes = await readFile(join(provenance.migrationDirectory, name));
    bundleEntries.push({
      name,
      sha256: sha256(bytes),
      sql: decodeUtf8(bytes, name),
    });
  }
  return {
    apiVersion: "takosumi.resource-migrations/v1",
    engine: "sqlite",
    entries: bundleEntries,
  };
}

export function serializeSchemaBundle(bundle: SchemaBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

export async function generateSchemaBundle(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<string> {
  return serializeSchemaBundle(await buildSchemaBundle(repositoryRoot));
}

async function writeOrCheckBundle(checkOnly: boolean): Promise<void> {
  const expected = await generateSchemaBundle(REPOSITORY_ROOT);
  const bundlePath = join(REPOSITORY_ROOT, BUNDLE_RELATIVE_PATH);
  let actual: string | undefined;
  try {
    actual = await readFile(bundlePath, "utf8");
  } catch (error) {
    if (!checkOnly && (error as NodeJS.ErrnoException).code === "ENOENT") {
      actual = undefined;
    } else {
      throw error;
    }
  }
  if (checkOnly) {
    if (actual !== expected) {
      throw new Error(
        BUNDLE_RELATIVE_PATH + " is stale; run bun run generate:schema-bundle",
      );
    }
    console.log(BUNDLE_RELATIVE_PATH + " is up to date");
    return;
  }
  if (actual !== expected) {
    await writeFile(bundlePath, expected, "utf8");
    console.log("wrote " + BUNDLE_RELATIVE_PATH);
  } else {
    console.log(BUNDLE_RELATIVE_PATH + " is already up to date");
  }
}

if (import.meta.main) {
  await writeOrCheckBundle(process.argv.includes("--check"));
}
