import type { Readable, Writable } from "node:stream";

export declare function createManagedNativeRuntime<
  T extends { dispose(): Promise<unknown> | unknown },
>(
  construct: (
    handleRuntimeStdio: (stdout: Readable, stderr: Readable) => void,
  ) => T,
  options?: { destination?: Writable },
): { worker: T; dispose(): Promise<void> };
