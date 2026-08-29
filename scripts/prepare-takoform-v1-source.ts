#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_INPUT_RELATIVE_PATH = "dist/yurucommu-worker.js";
export const SCHEMA_BUNDLE_RELATIVE_PATH =
  "deploy/takoform/migrations/schema-bundle.json";
export const WORKER_OUTPUT_RELATIVE_PATH =
  "deploy/takoform/.generated/yurucommu-worker.js";
export const MIGRATION_OUTPUT_RELATIVE_PATH = "deploy/takoform/migrations/sql";

const MAX_WORKER_BYTES = 8 * 1024 * 1024;
const MIGRATION_NAME_RE = /^[0-9]{4}_[A-Za-z0-9_-]+\.sql$/u;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

type SchemaBundleEntry = {
  readonly name: string;
  readonly sha256: string;
  readonly sql: string;
};

type SchemaBundle = {
  readonly apiVersion: "takosumi.resource-migrations/v1";
  readonly engine: "sqlite";
  readonly entries: readonly SchemaBundleEntry[];
};

export type PrepareTakoformV1SourceOptions = {
  readonly repositoryRoot?: string;
  readonly workerInputRelativePath?: string;
};

function sha256(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function parseSchemaBundle(text: string): SchemaBundle {
  const candidate: unknown = JSON.parse(text);
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, ["apiVersion", "engine", "entries"])
  ) {
    throw new Error("schema bundle has an unexpected top-level shape");
  }
  const bundle = candidate as Partial<SchemaBundle>;
  if (
    bundle.apiVersion !== "takosumi.resource-migrations/v1" ||
    bundle.engine !== "sqlite" ||
    !Array.isArray(bundle.entries) ||
    bundle.entries.length < 1
  ) {
    throw new Error("schema bundle identity is invalid");
  }
  const names = new Set<string>();
  let previousName = "";
  for (const entry of bundle.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !exactKeys(entry, ["name", "sha256", "sql"]) ||
      typeof entry.name !== "string" ||
      !MIGRATION_NAME_RE.test(entry.name) ||
      names.has(entry.name) ||
      entry.name <= previousName ||
      typeof entry.sql !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error("schema bundle contains an invalid migration entry");
    }
    const bytes = new TextEncoder().encode(entry.sql);
    if (sha256(bytes) !== entry.sha256) {
      throw new Error("schema bundle migration digest mismatch: " + entry.name);
    }
    names.add(entry.name);
    previousName = entry.name;
  }
  return bundle as SchemaBundle;
}

export async function prepareTakoformV1Source(
  options: PrepareTakoformV1SourceOptions = {},
): Promise<{
  workerBytes: number;
  workerSha256: string;
  migrationCount: number;
}> {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const workerInput = join(
    repositoryRoot,
    options.workerInputRelativePath ?? WORKER_INPUT_RELATIVE_PATH,
  );
  const bundle = parseSchemaBundle(
    await readFile(join(repositoryRoot, SCHEMA_BUNDLE_RELATIVE_PATH), "utf8"),
  );

  const workerBytes = new Uint8Array(await readFile(workerInput));
  if (workerBytes.length < 1 || workerBytes.length > MAX_WORKER_BYTES) {
    throw new Error("worker artifact size is outside the accepted range");
  }
  const workerSha256 = sha256(workerBytes);

  const workerOutput = join(repositoryRoot, WORKER_OUTPUT_RELATIVE_PATH);
  const migrationOutput = join(repositoryRoot, MIGRATION_OUTPUT_RELATIVE_PATH);
  await rm(migrationOutput, { force: true, recursive: true });
  await mkdir(migrationOutput, { recursive: true });
  await mkdir(resolve(workerOutput, ".."), { recursive: true });
  await copyFile(workerInput, workerOutput);
  const copiedWorkerSha256 = sha256(
    new Uint8Array(await readFile(workerOutput)),
  );
  if (copiedWorkerSha256 !== workerSha256) {
    throw new Error("prepared Worker artifact digest mismatch");
  }
  for (const entry of bundle.entries) {
    await writeFile(join(migrationOutput, entry.name), entry.sql, {
      encoding: "utf8",
      mode: 0o644,
    });
  }
  return {
    workerBytes: workerBytes.length,
    workerSha256,
    migrationCount: bundle.entries.length,
  };
}

if (import.meta.main) {
  const result = await prepareTakoformV1Source();
  process.stdout.write(
    JSON.stringify({
      kind: "yurucommu.takoform-v1-source@v1",
      ...result,
    }) + "\n",
  );
}
