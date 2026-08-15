#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_ARTIFACT_URL =
  "https://github.com/tako0614/yurucommu/releases/download/v2.1.6/yurucommu-worker.js";
export const WORKER_ARTIFACT_SHA256 =
  "sha256:6e39a18ea95172affd2d4b12d24f2e59ab9f5f1af7a14a80ec3989275bed66bd";
export const SCHEMA_BUNDLE_RELATIVE_PATH =
  "deploy/takoform/migrations/schema-bundle.json";
export const WORKER_OUTPUT_RELATIVE_PATH =
  "deploy/takoform-current/.generated/yurucommu-worker.js";
export const MIGRATION_OUTPUT_RELATIVE_PATH =
  "deploy/takoform-current/.generated/migrations";

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

export type MaterializeTakoformCurrentOptions = {
  readonly repositoryRoot?: string;
  readonly workerArtifactUrl?: string;
  readonly workerArtifactSha256?: string;
  readonly fetchImpl?: typeof fetch;
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

export async function materializeTakoformCurrent(
  options: MaterializeTakoformCurrentOptions = {},
): Promise<{ workerBytes: number; migrationCount: number }> {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const artifactUrl = options.workerArtifactUrl ?? WORKER_ARTIFACT_URL;
  const expectedArtifactDigest =
    options.workerArtifactSha256 ?? WORKER_ARTIFACT_SHA256;
  const fetchImpl = options.fetchImpl ?? fetch;
  const bundle = parseSchemaBundle(
    await readFile(join(repositoryRoot, SCHEMA_BUNDLE_RELATIVE_PATH), "utf8"),
  );

  const response = await fetchImpl(artifactUrl, {
    headers: { accept: "application/javascript" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      "worker artifact request failed with status " + response.status,
    );
  }
  const workerBytes = new Uint8Array(await response.arrayBuffer());
  if (workerBytes.length < 1 || workerBytes.length > MAX_WORKER_BYTES) {
    throw new Error("worker artifact size is outside the accepted range");
  }
  if (sha256(workerBytes) !== expectedArtifactDigest) {
    throw new Error("worker artifact digest mismatch");
  }

  const workerOutput = join(repositoryRoot, WORKER_OUTPUT_RELATIVE_PATH);
  const migrationOutput = join(repositoryRoot, MIGRATION_OUTPUT_RELATIVE_PATH);
  await rm(migrationOutput, { force: true, recursive: true });
  await mkdir(migrationOutput, { recursive: true });
  await mkdir(resolve(workerOutput, ".."), { recursive: true });
  await writeFile(workerOutput, workerBytes, { mode: 0o644 });
  for (const entry of bundle.entries) {
    await writeFile(join(migrationOutput, entry.name), entry.sql, {
      encoding: "utf8",
      mode: 0o644,
    });
  }
  return {
    workerBytes: workerBytes.length,
    migrationCount: bundle.entries.length,
  };
}

if (import.meta.main) {
  const result = await materializeTakoformCurrent();
  process.stdout.write(
    JSON.stringify({
      kind: "yurucommu.takoform-current-source@v1",
      ...result,
    }) + "\n",
  );
}
