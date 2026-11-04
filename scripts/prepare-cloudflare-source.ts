#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readBundledD1Migrations } from "./bundled-d1-migrations.ts";
import { APPLY_BUNDLED_MIGRATIONS_VAR } from "./yurucommu-d1-migrations.ts";

/**
 * Stage the source-built Worker for deploy/cloudflare (`sourceBuild` in
 * .well-known/takosumi.json). The module uploads exactly this file, and its
 * D1 database receives its schema from nothing but the migrations this file
 * embeds, so a Worker built without them is refused here, before any plan.
 */
export const WORKER_INPUT_RELATIVE_PATH = "dist/yurucommu-worker.js";
export const WORKER_OUTPUT_RELATIVE_PATH =
  "deploy/cloudflare/.generated/yurucommu-worker.js";

const MAX_WORKER_BYTES = 8 * 1024 * 1024;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

function sha256(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

export async function prepareCloudflareSource(
  options: {
    readonly repositoryRoot?: string;
    readonly workerInputRelativePath?: string;
  } = {},
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
  const workerBytes = new Uint8Array(await readFile(workerInput));
  if (workerBytes.length < 1 || workerBytes.length > MAX_WORKER_BYTES) {
    throw new Error("worker artifact size is outside the accepted range");
  }
  const workerText = new TextDecoder().decode(workerBytes);
  const migrations = await readBundledD1Migrations(repositoryRoot);
  if (!workerText.includes(APPLY_BUNDLED_MIGRATIONS_VAR)) {
    throw new Error("worker artifact has no bundled schema gate");
  }
  for (const migration of migrations) {
    if (!workerText.includes(JSON.stringify(migration.sha256))) {
      throw new Error(
        "worker artifact does not embed migration " +
          migration.name +
          "; rebuild it with `bun run build:worker`",
      );
    }
  }
  const workerSha256 = sha256(workerBytes);
  const workerOutput = join(repositoryRoot, WORKER_OUTPUT_RELATIVE_PATH);
  await mkdir(resolve(workerOutput, ".."), { recursive: true });
  await copyFile(workerInput, workerOutput);
  if (sha256(new Uint8Array(await readFile(workerOutput))) !== workerSha256) {
    throw new Error("prepared Worker artifact digest mismatch");
  }
  return {
    workerBytes: workerBytes.length,
    workerSha256,
    migrationCount: migrations.length,
  };
}

if (import.meta.main) {
  if (process.argv.length > 2) throw new Error("expected no arguments");
  const result = await prepareCloudflareSource();
  process.stdout.write(
    JSON.stringify({ kind: "yurucommu.cloudflare-source@v1", ...result }) +
      "\n",
  );
}
