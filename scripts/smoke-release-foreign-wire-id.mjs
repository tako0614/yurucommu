#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runSupervisedCommand } from "./native-smoke-supervisor.mjs";

const child = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "release-foreign-wire-id-smoke-child.mjs",
);
try {
  await runSupervisedCommand(
    [process.execPath, child, ...process.argv.slice(2)],
    { timeoutMs: 180_000 },
  );
} catch (error) {
  process.stderr.write(`[native-smoke-supervisor] ${error}\n`);
  process.exitCode = 1;
}
