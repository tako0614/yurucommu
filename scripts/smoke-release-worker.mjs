#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_NATIVE_SMOKE_TIMEOUT_MS,
  runSupervisedCommand,
} from "./native-smoke-supervisor.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = resolve(repo, "scripts/release-worker-smoke-child.mjs");

try {
  await runSupervisedCommand(
    [process.execPath, child, ...process.argv.slice(2)],
    {
      timeoutMs: DEFAULT_NATIVE_SMOKE_TIMEOUT_MS,
    },
  );
} catch (error) {
  process.stderr.write(`[native-smoke-supervisor] ${error}\n`);
  process.exitCode = 1;
}
