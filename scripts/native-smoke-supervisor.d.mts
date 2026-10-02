import type { spawn } from "node:child_process";
import type { Writable } from "node:stream";

export declare const DEFAULT_NATIVE_SMOKE_TIMEOUT_MS: number;

export declare function runSupervisedCommand(
  command: string[],
  options?: {
    cwd?: string;
    timeoutMs?: number;
    termGraceMs?: number;
    killWaitMs?: number;
    stdoutLimitBytes?: number;
    stdoutTarget?: Writable;
    stderrTarget?: Writable;
    spawn?: typeof spawn;
  },
): Promise<{
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  elapsedMs: number;
  stdoutBytes: number;
}>;
