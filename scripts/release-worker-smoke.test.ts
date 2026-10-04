import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { build, stop } from "esbuild";

import { createEntrySource } from "./build-yurucommu-worker.ts";
import { createManagedNativeRuntime } from "./native-runtime-stdio.mjs";
import { runSupervisedCommand } from "./native-smoke-supervisor.mjs";

const repo = new URL("../", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

async function buildGeneratedFixture(transform = (source: string) => source) {
  const directory = await mkdtemp(join(tmpdir(), "yurucommu-event-smoke-"));
  temporaryDirectories.push(directory);
  const artifactPath = join(directory, "worker.js");
  const source = createEntrySource({
    "index.html": {
      contentType: "text/html; charset=utf-8",
      body: btoa('<title>Yurucommu</title><div id="root"></div>'),
    },
  });
  try {
    await build({
      stdin: {
        contents: transform(source),
        resolveDir: join(repo, "scripts"),
        loader: "ts",
      },
      outfile: artifactPath,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
    });
  } finally {
    stop();
  }
  return artifactPath;
}

function requireSmokeProcessExit(
  result: Bun.ReadableSyncSubprocess,
  elapsedMs: number,
) {
  if (result.exitCode === null || result.signalCode != null) {
    throw new Error(
      `Native smoke child did not complete after ${elapsedMs}ms: exit=${result.exitCode}, signal=${result.signalCode ?? "none"}; ${result.stderr.toString()}`,
    );
  }
  return result;
}

function runSmoke(artifactPath: string, timeoutMs = 20_000) {
  const started = performance.now();
  const result = Bun.spawnSync(
    ["node", "scripts/smoke-release-worker.mjs", artifactPath],
    {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    },
  );
  return requireSmokeProcessExit(
    result,
    Math.round(performance.now() - started),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const pipeEvents = ["unpipe", "error", "close", "finish"] as const;

function pipeListenerCounts(destination: PassThrough) {
  return pipeEvents.map((event) => destination.listenerCount(event));
}

function runtimeChannel() {
  const upstream = new PassThrough();
  const buffered = new Transform({
    transform(chunk, _encoding, done) {
      done(null, chunk);
    },
  });
  upstream.pipe(buffered);
  return { upstream, buffered };
}

describe("native runtime stdio cleanup", () => {
  test("returns shared stderr listeners to baseline across six runtimes and rebuild callbacks", async () => {
    const destination = new PassThrough();
    let diagnostics = "";
    destination.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const baseline = pipeListenerCounts(destination);
    let expected = "";

    for (let index = 0; index < 6; index += 1) {
      const first = [runtimeChannel(), runtimeChannel()];
      const rebuilt = index === 2 ? [runtimeChannel(), runtimeChannel()] : [];
      const managed = createManagedNativeRuntime(
        (handleRuntimeStdio) => {
          handleRuntimeStdio(first[0]!.buffered, first[1]!.buffered);
          if (rebuilt.length) {
            handleRuntimeStdio(rebuilt[0]!.buffered, rebuilt[1]!.buffered);
          }
          return {
            async dispose() {
              for (const channel of [...first, ...rebuilt]) {
                channel.upstream.destroy();
              }
            },
          };
        },
        { destination },
      );

      for (const [channelIndex, channel] of [...first, ...rebuilt].entries()) {
        const message = `runtime-${index}-channel-${channelIndex}\n`;
        channel.upstream.write(message);
        expected += message;
      }
      expect(diagnostics).toBe(expected);
      expect(pipeListenerCounts(destination)).toEqual(
        baseline.map((count) => count + first.length + rebuilt.length),
      );

      await managed.dispose();
      for (const channel of [...first, ...rebuilt]) {
        expect(channel.buffered.destroyed).toBe(true);
      }
      expect(pipeListenerCounts(destination)).toEqual(baseline);
      expect(destination.destroyed).toBe(false);
      expect(destination.writableEnded).toBe(false);
    }

    destination.write("destination-still-usable\n");
    expect(diagnostics).toBe(`${expected}destination-still-usable\n`);
    destination.destroy();
  });

  test("preserves the exact disposal error, cleans every stream, and never disposes twice", async () => {
    const destination = new PassThrough();
    destination.resume();
    const baseline = pipeListenerCounts(destination);
    const channels = [runtimeChannel(), runtimeChannel()];
    const disposalError = new Error("original disposal failure");
    const cleanupError = new Error("first stream unpipe failure");
    const originalUnpipe = channels[0]!.buffered.unpipe.bind(
      channels[0]!.buffered,
    );
    Object.defineProperty(channels[0]!.buffered, "unpipe", {
      value: (target: PassThrough) => {
        originalUnpipe(target);
        throw cleanupError;
      },
    });
    let disposeCalls = 0;
    const managed = createManagedNativeRuntime(
      (handleRuntimeStdio) => {
        handleRuntimeStdio(channels[0]!.buffered, channels[1]!.buffered);
        return {
          async dispose() {
            disposeCalls += 1;
            for (const channel of channels) channel.upstream.destroy();
            throw disposalError;
          },
        };
      },
      { destination },
    );

    await expect(managed.dispose()).rejects.toBe(disposalError);
    await expect(managed.dispose()).rejects.toBe(disposalError);
    expect(disposeCalls).toBe(1);
    expect(channels.every((channel) => channel.buffered.destroyed)).toBe(true);
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    expect(destination.destroyed).toBe(false);
    destination.destroy();
  });

  test("reports cleanup failure after an otherwise successful disposal", async () => {
    const destination = new PassThrough();
    destination.resume();
    const baseline = pipeListenerCounts(destination);
    const channels = [runtimeChannel(), runtimeChannel()];
    const cleanupError = new Error("stdio cleanup failed");
    const originalUnpipe = channels[0]!.buffered.unpipe.bind(
      channels[0]!.buffered,
    );
    Object.defineProperty(channels[0]!.buffered, "unpipe", {
      value: (target: PassThrough) => {
        originalUnpipe(target);
        throw cleanupError;
      },
    });
    const managed = createManagedNativeRuntime(
      (handleRuntimeStdio) => {
        handleRuntimeStdio(channels[0]!.buffered, channels[1]!.buffered);
        return {
          dispose: () =>
            channels.forEach((channel) => channel.upstream.destroy()),
        };
      },
      { destination },
    );

    await expect(managed.dispose()).rejects.toBe(cleanupError);
    expect(channels.every((channel) => channel.buffered.destroyed)).toBe(true);
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    expect(destination.writableEnded).toBe(false);
    destination.destroy();
  });

  test("cleans constructor failure and rejects late callbacks without reattaching", async () => {
    const destination = new PassThrough();
    destination.resume();
    const baseline = pipeListenerCounts(destination);
    const constructed = [runtimeChannel(), runtimeChannel()];
    const constructorError = new Error("original constructor failure");
    const originalUnpipe = constructed[0]!.buffered.unpipe.bind(
      constructed[0]!.buffered,
    );
    Object.defineProperty(constructed[0]!.buffered, "unpipe", {
      value: (target: PassThrough) => {
        originalUnpipe(target);
        throw new Error("constructor stream cleanup failed");
      },
    });
    let caught;
    try {
      createManagedNativeRuntime(
        (handleRuntimeStdio) => {
          handleRuntimeStdio(
            constructed[0]!.buffered,
            constructed[1]!.buffered,
          );
          throw constructorError;
        },
        { destination },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(constructorError);
    expect(constructed.every((channel) => channel.buffered.destroyed)).toBe(
      true,
    );
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    for (const channel of constructed) channel.upstream.destroy();

    let callback: (stdout: Readable, stderr: Readable) => void = () => {
      throw new Error("stdio callback not registered");
    };
    let finishDispose!: () => void;
    const pendingDisposal = new Promise<void>((resolve) => {
      finishDispose = resolve;
    });
    const managed = createManagedNativeRuntime(
      (handleRuntimeStdio) => {
        callback = handleRuntimeStdio;
        return {
          async dispose() {
            await pendingDisposal;
          },
        };
      },
      { destination },
    );
    const closing = managed.dispose();
    const late = [runtimeChannel(), runtimeChannel()];
    callback(late[0]!.buffered, late[1]!.buffered);
    expect(late.every((channel) => channel.buffered.destroyed)).toBe(true);
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    finishDispose();
    await closing;
    const afterClose = [runtimeChannel(), runtimeChannel()];
    callback(afterClose[0]!.buffered, afterClose[1]!.buffered);
    expect(afterClose.every((channel) => channel.buffered.destroyed)).toBe(
      true,
    );
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    expect(destination.destroyed).toBe(false);
    for (const channel of [...late, ...afterClose]) channel.upstream.destroy();
    destination.destroy();
  });

  test("releases both late channels when the first release throws during disposal and after close", async () => {
    const destination = new PassThrough();
    let diagnostics = "";
    destination.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const baseline = pipeListenerCounts(destination);
    const closingChannels = [runtimeChannel(), runtimeChannel()];
    const closingError = new Error("first closing release failed");

    function failUnpipe(buffered: Transform, error: Error) {
      const originalUnpipe = buffered.unpipe.bind(buffered);
      Object.defineProperty(buffered, "unpipe", {
        value: (target: PassThrough) => {
          originalUnpipe(target);
          throw error;
        },
      });
    }

    failUnpipe(closingChannels[0]!.buffered, closingError);
    failUnpipe(
      closingChannels[1]!.buffered,
      new Error("second closing release failed"),
    );
    const managed = createManagedNativeRuntime(
      (handleRuntimeStdio) => ({
        dispose() {
          handleRuntimeStdio(
            closingChannels[0]!.buffered,
            closingChannels[1]!.buffered,
          );
        },
      }),
      { destination },
    );

    await expect(managed.dispose()).rejects.toBe(closingError);
    await expect(managed.dispose()).rejects.toBe(closingError);
    expect(closingChannels.every((channel) => channel.buffered.destroyed)).toBe(
      true,
    );
    expect(pipeListenerCounts(destination)).toEqual(baseline);

    let lateCallback: (stdout: Readable, stderr: Readable) => void = () => {
      throw new Error("stdio callback not registered");
    };
    const closed = createManagedNativeRuntime(
      (handleRuntimeStdio) => {
        lateCallback = handleRuntimeStdio;
        return { dispose() {} };
      },
      { destination },
    );
    await closed.dispose();
    const closedChannels = [runtimeChannel(), runtimeChannel()];
    const closedError = new Error("first closed release failed");
    failUnpipe(closedChannels[0]!.buffered, closedError);
    let caught;
    try {
      lateCallback(closedChannels[0]!.buffered, closedChannels[1]!.buffered);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(closedError);
    expect(closedChannels.every((channel) => channel.buffered.destroyed)).toBe(
      true,
    );
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    destination.write("destination-still-usable\n");
    expect(diagnostics).toBe("destination-still-usable\n");
    expect(destination.destroyed).toBe(false);
    expect(destination.writableEnded).toBe(false);
    for (const channel of [...closingChannels, ...closedChannels]) {
      channel.upstream.destroy();
    }
    destination.destroy();
  });
});

describe("release Worker smoke", () => {
  function streamCapture() {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    return {
      stream,
      bytes: () => Buffer.concat(chunks),
    };
  }

  async function runSupervisedFixture(
    source: string,
    options: {
      timeoutMs?: number;
      termGraceMs?: number;
      killWaitMs?: number;
      stdoutLimitBytes?: number;
    } = {},
  ) {
    const stdout = streamCapture();
    const stderr = streamCapture();
    let error: unknown;
    const startedAt = performance.now();
    try {
      await runSupervisedCommand([process.execPath, "-e", source], {
        cwd: repo,
        stdoutTarget: stdout.stream,
        stderrTarget: stderr.stream,
        timeoutMs: 500,
        termGraceMs: 100,
        killWaitMs: 300,
        ...options,
      });
    } catch (caught) {
      error = caught;
    }
    return {
      error,
      stdout: stdout.bytes(),
      stderr: stderr.bytes(),
      elapsedMs: performance.now() - startedAt,
      close() {
        stdout.stream.destroy();
        stderr.stream.destroy();
      },
    };
  }

  test("releases exact child stdout only after a successful closed process", async () => {
    const success = Buffer.from('{"kind":"smoke","status":"PASSED"}\n');
    const source = `process.stdout.write(Buffer.from(${JSON.stringify(success.toString())})); process.stderr.write(Buffer.from([0x72, 0x61, 0x77, 0xff]));`;
    const result = await runSupervisedFixture(source);
    try {
      expect(result.error).toBeUndefined();
      expect(result.stdout).toEqual(success);
      expect(result.stderr).toEqual(Buffer.from([0x72, 0x61, 0x77, 0xff]));
    } finally {
      result.close();
    }
  });

  test("withholds a success-looking line when the child exceeds its deadline", async () => {
    const result = await runSupervisedFixture(
      'process.stdout.write("{\\"status\\":\\"PASSED\\"}\\n"); process.stderr.write(Buffer.from([0x72, 0x61, 0x77, 0xff])); setInterval(() => {}, 1000);',
      { timeoutMs: 100, termGraceMs: 80 },
    );
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        "exceeded its deadline",
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.stderr).toEqual(Buffer.from([0x72, 0x61, 0x77, 0xff]));
      expect(result.elapsedMs).toBeLessThan(1000);
    } finally {
      result.close();
    }
  });

  test("withholds partial stdout on nonzero exit and signal termination", async () => {
    const nonzero = await runSupervisedFixture(
      'process.stdout.write("partial-success.json\\n"); process.stderr.write("raw failure bytes\\n", () => process.exit(7));',
    );
    try {
      expect(nonzero.error).toBeInstanceOf(Error);
      expect((nonzero.error as Error).message).toContain("exitCode=7");
      expect(nonzero.stdout).toEqual(Buffer.alloc(0));
      expect(nonzero.stderr).toEqual(Buffer.from("raw failure bytes\n"));
    } finally {
      nonzero.close();
    }

    const signaled = await runSupervisedFixture(
      'process.stdout.write("{\\"status\\":\\"PASSED\\"}\\n"); process.stderr.write("raw signal bytes\\n", () => process.kill(process.pid, "SIGTERM"));',
    );
    try {
      expect(signaled.error).toBeInstanceOf(Error);
      expect((signaled.error as Error).message).toContain("child was signaled");
      expect(signaled.stdout).toEqual(Buffer.alloc(0));
      expect(signaled.stderr).toEqual(Buffer.from("raw signal bytes\n"));
    } finally {
      signaled.close();
    }
  });

  test("reports nonzero exit before inherited pipe EOF and kills the owned descendant", async () => {
    const result = await runSupervisedFixture(
      'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000);"], { stdio: ["ignore", "inherit", "inherit"] }); process.stdout.write("candidate manifest\\n", () => process.exit(7));',
      { timeoutMs: 500, termGraceMs: 60, killWaitMs: 200 },
    );
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain("exitCode=7");
      expect((result.error as Error).message).not.toContain(
        "exceeded its deadline",
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.elapsedMs).toBeLessThan(450);
    } finally {
      result.close();
    }
  });

  test("preserves a large delayed stderr tail on nonzero exit", async () => {
    const expected = Buffer.alloc(256 * 1024);
    for (let index = 0; index < expected.length; index += 1) {
      expected[index] = index % 251;
    }
    const result = await runSupervisedFixture(
      "const tail = Buffer.alloc(256 * 1024); for (let index = 0; index < tail.length; index += 1) tail[index] = index % 251; setTimeout(() => process.stderr.write(tail, () => process.exit(7)), 30);",
      { timeoutMs: 1500, termGraceMs: 100, killWaitMs: 500 },
    );
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain("exitCode=7");
      expect((result.error as Error).message).toContain("stderrDrain=complete");
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.stderr).toEqual(expected);
    } finally {
      result.close();
    }
  });

  test("terminates an owned descendant holding inherited output pipes", async () => {
    const result = await runSupervisedFixture(
      'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000);"], { stdio: ["ignore", "inherit", "inherit"] }); process.stdout.write("candidate manifest\\n", () => process.exit(0));',
      { timeoutMs: 100, termGraceMs: 60, killWaitMs: 250 },
    );
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        "exceeded its deadline",
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.stderr).toEqual(Buffer.alloc(0));
      expect(result.elapsedMs).toBeLessThan(1000);
    } finally {
      result.close();
    }
  });

  test("a supervisor SIGTERM terminates only its smoke child group", async () => {
    const moduleUrl = new URL("./native-smoke-supervisor.mjs", import.meta.url)
      .href;
    const nestedSource =
      "process.stderr.write(`nested-pid=${process.pid}\\n`); setInterval(() => {}, 1000);";
    const wrapperSource = [
      `import { runSupervisedCommand } from ${JSON.stringify(moduleUrl)};`,
      `try { await runSupervisedCommand([process.execPath, "-e", ${JSON.stringify(nestedSource)}], { timeoutMs: 5000, termGraceMs: 200, killWaitMs: 500 }); }`,
      `catch (error) { process.stderr.write("caught=" + error.message + "\\n"); process.exitCode = 1; }`,
    ].join("\n");
    const supervisor = spawn(process.execPath, ["-e", wrapperSource], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    let stdout = "";
    let nestedPid: number | undefined;
    let resolveNestedPid!: () => void;
    const nestedPidSeen = new Promise<void>((resolve) => {
      resolveNestedPid = resolve;
    });
    supervisor.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/nested-pid=(\d+)/);
      if (match) {
        nestedPid = Number(match[1]);
        resolveNestedPid();
      }
    });
    supervisor.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const stdoutEnded = new Promise<void>((resolve) =>
      supervisor.stdout!.once("end", resolve),
    );
    const stderrEnded = new Promise<void>((resolve) =>
      supervisor.stderr!.once("end", resolve),
    );

    function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    }

    try {
      await withTimeout(
        nestedPidSeen,
        2000,
        "nested smoke child did not start",
      );
      supervisor.kill("SIGTERM");
      const exitCode = await withTimeout(
        new Promise<number | null>((resolve) =>
          supervisor.once("exit", (code) => resolve(code)),
        ),
        2000,
        "supervisor did not stop after SIGTERM",
      );
      await Promise.all([stdoutEnded, stderrEnded]);
      expect(exitCode).toBe(1);
      expect(supervisor.signalCode).toBeNull();
      expect(stdout).toBe("");
      expect(stderr).toContain("supervisor received a termination signal");
      if (nestedPid) {
        let alive = true;
        try {
          process.kill(nestedPid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
          else throw error;
        }
        expect(alive).toBe(false);
      }
    } finally {
      try {
        if (supervisor.pid) process.kill(-supervisor.pid, "SIGKILL");
      } catch {
        // The wrapper's process group is expected to be gone after completion.
      }
      if (nestedPid) {
        try {
          process.kill(nestedPid, "SIGKILL");
        } catch {
          // The smoke child is expected to be gone after group termination.
        }
      }
    }
  });

  test("terminates the owned group and withholds stdout when the byte cap is exceeded", async () => {
    const result = await runSupervisedFixture(
      "process.stdout.write(Buffer.alloc(4096, 0x61)); setInterval(() => {}, 1000);",
      { timeoutMs: 500, termGraceMs: 80, stdoutLimitBytes: 64 },
    );
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        "stdout exceeded its limit",
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
    } finally {
      result.close();
    }
  });

  test("cleans up a child when stream setup fails after spawn", async () => {
    let spawnedPid: number | undefined;
    const result = await runSupervisedCommand(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      {
        timeoutMs: 500,
        termGraceMs: 100,
        killWaitMs: 200,
        spawn: ((command: string, args: string[], options: object) => {
          const child = spawn(command, args, options);
          spawnedPid = child.pid;
          Object.defineProperty(child, "stdout", { value: undefined });
          return child;
        }) as typeof spawn,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain(
      "child stdio pipes were not created",
    );
    const pid = spawnedPid;
    if (typeof pid !== "number") {
      throw new Error("Fixture child did not provide a PID");
    }
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("a stalled stdout destination fails within the overall deadline", async () => {
    const destination = new PassThrough();
    Object.defineProperty(destination, "write", { value: () => false });
    const startedAt = performance.now();
    try {
      const result = await runSupervisedCommand(
        [
          process.execPath,
          "-e",
          'process.stdout.write("{\\"status\\":\\"PASSED\\"}\\n");',
        ],
        {
          cwd: repo,
          timeoutMs: 150,
          termGraceMs: 50,
          killWaitMs: 100,
          stdoutTarget: destination,
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("stdout destination failed");
      expect(performance.now() - startedAt).toBeLessThan(1000);
    } finally {
      destination.destroy();
    }
  });

  test("a destination error while the child runs terminates its group", async () => {
    const stdout = streamCapture();
    const stderr = new PassThrough();
    const pending = runSupervisedCommand(
      [
        process.execPath,
        "-e",
        'process.stdout.write("candidate manifest\\n"); setInterval(() => {}, 1000);',
      ],
      {
        cwd: repo,
        timeoutMs: 500,
        termGraceMs: 50,
        killWaitMs: 100,
        stdoutTarget: stdout.stream,
        stderrTarget: stderr,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    stderr.emit("error", new Error("broken stderr sink"));
    const result = await pending;
    try {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("stderr destination failed");
      expect(stdout.bytes()).toEqual(Buffer.alloc(0));
    } finally {
      stdout.stream.destroy();
      stderr.destroy();
    }
  });

  test("an early stdout cap aborts a pending stderr write callback", async () => {
    const stdout = streamCapture();
    const stderr = new PassThrough();
    let releaseWrite: ((error?: Error) => void) | undefined;
    let outputWrites = 0;
    Object.defineProperty(stderr, "write", {
      value: (_chunk: Buffer, callback: (error?: Error) => void) => {
        outputWrites += 1;
        releaseWrite = callback;
        return false;
      },
    });
    const startedAt = performance.now();
    try {
      const result = await runSupervisedCommand(
        [
          process.execPath,
          "-e",
          'process.stderr.write("phase started\\n"); setTimeout(() => process.stdout.write(Buffer.alloc(4096)), 20); setInterval(() => {}, 1000);',
        ],
        {
          cwd: repo,
          timeoutMs: 500,
          termGraceMs: 50,
          killWaitMs: 100,
          stdoutLimitBytes: 64,
          stdoutTarget: stdout.stream,
          stderrTarget: stderr,
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("stdout exceeded its limit");
      expect(performance.now() - startedAt).toBeLessThan(450);
      expect(outputWrites).toBe(1);
      expect(stdout.bytes()).toEqual(Buffer.alloc(0));
      expect(stderr.listenerCount("drain")).toBe(0);
      expect(stderr.listenerCount("error")).toBe(0);
      expect(stderr.listenerCount("close")).toBe(0);
      // Releasing a stale callback must not publish buffered success bytes.
      releaseWrite?.();
      expect(stdout.bytes()).toEqual(Buffer.alloc(0));
    } finally {
      stdout.stream.destroy();
      stderr.destroy();
    }
  });

  test("withholds a complete manifest while an owned child keeps serving with closed pipes", async () => {
    const result = await runSupervisedFixture(
      'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "process.stdout.end(); process.stderr.end(); setInterval(() => {}, 1000);"], { stdio: ["ignore", "ignore", "ignore"] }); process.stdout.write("{\\"status\\":\\"PASSED\\"}\\n", () => process.exit(0));',
      { timeoutMs: 120, termGraceMs: 60, killWaitMs: 200 },
    );
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        "exceeded its deadline",
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.elapsedMs).toBeLessThan(1000);
    } finally {
      result.close();
    }
  });

  test("refuses a signaled child even if it printed the expected refusal marker", () => {
    const result = Bun.spawnSync(
      [
        "bun",
        "-e",
        'process.stderr.write("first-owner-persona-switch\\n"); process.kill(process.pid, "SIGTERM");',
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 20_000 },
    );
    expect(result.signalCode).toBe("SIGTERM");
    expect(result.stderr.toString()).toContain("first-owner-persona-switch");
    expect(() => requireSmokeProcessExit(result, 0)).toThrow(
      "Native smoke child did not complete",
    );
  });

  test("verifies the generated artifact's native queue/DLQ and story/media retention", async () => {
    const artifactPath = await buildGeneratedFixture();
    // Let the native supervisor enforce its 120s deadline and finish bounded
    // cleanup before this outer guard intervenes. Mutation fixtures stay at 20s.
    const result = runSmoke(artifactPath, 130_000);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      kind: "yurucommu.release-worker-smoke@v1",
      runtime: "workerd",
      substrate: "runtime-native-bindings",
      checks: [
        "readyz",
        "discovery",
        "embedded-ui",
        "queue-fanout",
        "queue-dlq",
        "scheduled-retention",
        "scheduled-retention-idempotence",
        "password-login",
        "session-rotation",
        "invalid-password-refusal",
        "authenticated-dm",
        "dm-isolation",
        "media-upload",
        "media-readback",
        "private-media-read-refusal",
        "invalid-media-refusal",
        "unauthenticated-api-refusal",
        "post-write-refusal",
        "public-post-persistence",
        "public-post-readback",
        "public-post-media-visibility",
        "followers-post-persistence",
        "followers-post-readback",
        "followers-post-media-visibility",
        "public-post-activitypub",
        "followers-post-activitypub-refusal",
        "logout-revocation",
      ],
      authentication: { passwordMethods: ["pbkdf2-sha256", "bootstrap"] },
      onboarding: {
        substrate: "fresh-native-bindings",
        cases: ["pbkdf2-sha256", "bootstrap"].flatMap((passwordMethod) =>
          ["browser", "mobile"].map((firstTransport) => ({
            passwordMethod,
            firstTransport,
            owners: 1,
            personas: 1,
            checks: [
              "first-owner-invalid-password-refusal",
              "first-owner-password-creation",
              "first-owner-session-persistence",
              "first-owner-cookie-and-bearer",
              "first-owner-relogin",
              "first-owner-anonymous-create-refusal",
              "first-owner-persona-linkage",
              "first-owner-persona-switch",
            ],
          })),
        ),
      },
      status: "PASSED",
    });
  }, 140_000);

  const fetchAnchor = "    // No origin handling here.";
  for (const [name, injected, error] of [
    [
      "personal profile switch stripping cookie protection",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/switch") {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      const headers = new Headers(response.headers);
      const active = response.headers.get("set-cookie").match(/session=[^;,]+/g).at(-1);
      headers.delete("set-cookie");
      headers.set("set-cookie", active + "; Max-Age=2592000");
      return new Response(response.body, { status: response.status, headers });
    }
`,
      "first-owner-persona-switch",
    ],
    [
      "personal profile list duplicating root instead of returning persona",
      `    if (request.method === "GET" && new URL(request.url).pathname === "/api/auth/accounts") {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      const body = await response.json();
      if (body.accounts?.length === 2) {
        const root = body.accounts.find((account) => account.ap_id.endsWith("/tako"));
        body.accounts = [root, root];
      }
      return Response.json(body, { status: response.status, headers: response.headers });
    }
`,
      "first-owner-persona-linkage",
    ],
    [
      "fresh browser login success without owner or session persistence",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only" && (await env.DB.prepare("SELECT COUNT(*) AS count FROM actors").first()).count === 0) {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=fake-fresh-login; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }
`,
      "first-owner-",
    ],
    [
      "fresh mobile login success without owner or session persistence",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/mobile/login" && (await request.clone().json()).password === "release-smoke-only" && (await env.DB.prepare("SELECT COUNT(*) AS count FROM actors").first()).count === 0) {
      return Response.json({ access_token: "fake-fresh-login", token_type: "Bearer", expires_in: 2592000 });
    }
`,
      "first-owner-",
    ],
    [
      "fresh password login creating a member instead of an owner",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only" && (await env.DB.prepare("SELECT COUNT(*) AS count FROM actors").first()).count === 0) {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      await env.DB.prepare("UPDATE actors SET role = 'member'").run();
      return response;
    }
`,
      "first-owner-",
    ],
    [
      "personal profile promoted to an independent owner",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/accounts") {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      await env.DB.prepare("UPDATE actors SET role = 'owner', owner_actor_ap_id = NULL WHERE preferred_username = 'onboarding_persona'").run();
      return response;
    }
`,
      "first-owner-persona-linkage",
    ],
    [
      "personal profile switch without session rotation",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/switch") {
      return Response.json({ success: true }, { headers: { "set-cookie": request.headers.get("cookie") + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }
`,
      "first-owner-persona-switch",
    ],
    [
      "post attachment followers ActivityPub leaked",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/ap/objects/")) {
      const row = await env.DB.prepare("SELECT * FROM objects WHERE ap_id = ?").bind(env.APP_URL + new URL(request.url).pathname).first();
      if (row?.visibility === "followers") {
        const attachment = JSON.parse(row.attachments_json)[0];
        return Response.json({ id: row.ap_id, type: "Note", attributedTo: row.attributed_to, content: row.content, attachment: [{ type: "Document", mediaType: attachment.content_type, url: env.APP_URL + attachment.url, name: attachment.name }] }, { headers: { "content-type": "application/activity+json" } });
      }
    }
`,
      "followers-post-activitypub-refusal exposed",
    ],
    [
      "post attachment success without persistence",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && request.headers.get("cookie")) {
      const body = await request.clone().json();
      const origin = env.APP_URL;
      return Response.json({ post: { ap_id: origin + "/ap/objects/no-write", type: "Note", author: { ap_id: origin + "/ap/users/release-smoke-sender" }, content: body.content, visibility: body.visibility || "public", attachments: body.attachments } });
    }
`,
      "post-persistence did not persist",
    ],
    [
      "post attachment missing durable fanout",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && request.headers.get("cookie")) {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      if (response.status === 200) {
        const body = await response.clone().json();
        await env.DB.prepare("DELETE FROM delivery_fanouts WHERE activity_ap_id IN (SELECT ap_id FROM activities WHERE object_ap_id = ?)").bind(body.post.ap_id).run();
      }
      return response;
    }
`,
      "post-fanout did not persist",
    ],
    [
      "post attachment readback losing attachments",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/api/posts/")) {
      const id = decodeURIComponent(new URL(request.url).pathname.slice("/api/posts/".length));
      const row = await env.DB.prepare("SELECT * FROM objects WHERE ap_id = ?").bind(id).first();
      return Response.json({ post: { ap_id: row.ap_id, type: row.type, author: { ap_id: row.attributed_to }, content: row.content, visibility: row.visibility, attachments: [] } });
    }
`,
      "post-readback disagrees",
    ],
    [
      "post attachment public media bytes changed",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND visibility = 'public' AND instr(attachments_json, ?) > 0").bind(new URL(request.url).pathname).first()).count > 0) {
      return new Response(new Uint8Array([0]), { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000" } });
    }
`,
      "public-post-media-readback disagrees",
    ],
    [
      "post attachment followers media leaked",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && !request.headers.get("cookie") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND visibility = 'followers' AND instr(attachments_json, ?) > 0").bind(new URL(request.url).pathname).first()).count > 0) {
      return new Response(Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000" } });
    }
`,
      "followers-post-media-refusal exposed",
    ],
    [
      "post attachment ActivityPub internal storage key leaked",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/ap/objects/")) {
      const row = await env.DB.prepare("SELECT * FROM objects WHERE ap_id = ?").bind(env.APP_URL + new URL(request.url).pathname).first();
      const attachment = JSON.parse(row.attachments_json)[0];
      return Response.json({ id: row.ap_id, type: "Note", attributedTo: row.attributed_to, content: row.content, attachment: [{ type: "Document", mediaType: attachment.content_type, url: env.APP_URL + attachment.url, name: attachment.name, r2_key: attachment.r2_key }] }, { headers: { "content-type": "application/activity+json" } });
    }
`,
      "post-activitypub disagrees",
    ],
    [
      "post attachment accepted anonymous write",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && !request.headers.get("cookie")) {
      return Response.json({ success: true });
    }
`,
      "post-write-refusal accepted",
    ],
    [
      "post attachment accepted revoked write",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && request.headers.get("cookie") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).count === 2) {
      return Response.json({ success: true });
    }
`,
      "logout-revocation accepted a post write",
    ],
    [
      "private media denial with image bytes",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && !request.headers.get("cookie")) {
      return Response.json({ error: "Authentication required", bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==" }, { status: 403, headers: { "cache-control": "no-store" } });
    }\n`,
      "private-media-refusal included non-error content",
    ],
    [
      "revoked private media denial with image bytes",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && request.headers.get("cookie") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).count === 2) {
      return Response.json({ error: "Authentication required", bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==" }, { status: 403, headers: { "cache-control": "no-store" } });
    }\n`,
      "logout-revocation included non-error content",
    ],
    [
      "bootstrap login success without a session row",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && !env.AUTH_PASSWORD_HASH.includes(":") && (await request.clone().json()).password === "release-smoke-only") {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=fake-native-login-session; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }\n`,
      "password-login did not persist",
    ],
    [
      "an accepted invalid password",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only-incorrect") {
      return Response.json({ success: true });
    }\n`,
      "invalid-password-refusal",
    ],
    [
      "login success without a session row",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only") {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=fake-native-login-session; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }\n`,
      "password-login did not persist",
    ],
    [
      "logout success without session revocation",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/logout") {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=; Path=/; Max-Age=0" } });
    }\n`,
      "logout-revocation left",
    ],
    [
      "DM success without durable recipient records",
      `    if (request.method === "POST" && new URL(request.url).pathname.startsWith("/api/dm/user/")) {
      const origin = new URL(request.url).origin;
      return Response.json({ message: { id: origin + "/ap/objects/no-write", content: "release-smoke-dm" }, conversation_id: origin + "/ap/conversations/no-write" }, { status: 201 });
    }\n`,
      "authenticated-dm did not persist",
    ],
    [
      "media success without a stored upload",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/media/upload") {
      return Response.json({ id: "abcdef", url: "/media/abcdef.png", r2_key: "uploads/abcdef.png", content_type: "image/png" });
    }\n`,
      "media-upload did not persist",
    ],
    [
      "DM read by an unrelated session",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/api/dm/user/") && request.headers.get("cookie") === "session=release-smoke-session-unrelated-ecf49f83") {
      const headers = new Headers(request.headers);
      headers.set("cookie", "session=release-smoke-session-recipient-a108328f");
      request = new Request(request, { headers });
    }\n`,
      "DM isolation exposed a message to an unrelated actor",
    ],
  ] as const) {
    test(`rejects ${name}`, async () => {
      const result = runSmoke(
        await buildGeneratedFixture((source) => {
          expect(source).toContain(fetchAnchor);
          return source.replace(fetchAnchor, injected + fetchAnchor);
        }),
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(error);
    }, 30_000);
  }

  for (const [name, transform, error] of [
    [
      "acknowledged queue without an outbox effect",
      (source: string) =>
        source.replace(
          "return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env);",
          "for (const message of queueBatch.messages) message.ack(); return;",
        ),
      "queue-fanout did not persist",
    ],
    [
      "DLQ acknowledgment without its terminal outbox effect",
      (source: string) =>
        source.replace(
          "return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env);",
          'if (queueBatch.queue.endsWith("-dlq")) { for (const message of queueBatch.messages) message.ack(); return; } return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env);',
        ),
      "queue-dlq did not persist",
    ],
    [
      "queue retry",
      (source: string) =>
        source.replace(
          "return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env);",
          "for (const message of queueBatch.messages) message.retry(); return;",
        ),
      "queue-fanout was not explicitly acknowledged",
    ],
    [
      "missing scheduled handler",
      (source: string) =>
        source.replace("async scheduled(", "async disabledScheduled("),
      "scheduled",
    ],
    [
      "scheduled handler without retention effects",
      (source: string) =>
        source.replace("await runRetention(runtimeEnv);", "void runtimeEnv;"),
      "scheduled retention did not preserve",
    ],
  ] as const) {
    test(`rejects ${name}`, async () => {
      const result = runSmoke(await buildGeneratedFixture(transform));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(error);
    }, 30_000);
  }

  test("rejects an HTTP-healthy artifact without background handlers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurucommu-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "yurucommu-worker.js");
    const artifact = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const native =
      typeof env.DB?.prepare === "function" &&
      typeof env.KV?.get === "function" &&
      typeof env.MEDIA?.put === "function";
    if (url.pathname === "/readyz") {
      return Response.json({
        status: native ? "ok" : "misconfigured",
        service: "yurucommu",
        missingBindings: native ? [] : ["DB", "KV", "MEDIA"],
      }, { status: native ? 200 : 503 });
    }
    if (url.pathname === "/.well-known/yurucommu") {
      return Response.json({
        product: "yurucommu",
        server: { canonicalOrigin: env.APP_URL },
      });
    }
    return new Response("<title>Yurucommu</title><div id=\\\"root\\\"></div>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
`;
    await writeFile(artifactPath, artifact);
    const sha256 = createHash("sha256").update(artifact).digest("hex");

    const result = Bun.spawnSync(
      [
        "node",
        "scripts/smoke-release-worker.mjs",
        artifactPath,
        `sha256:${sha256}`,
      ],
      {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("queue");
  }, 30_000);

  test("rejects bytes that do not match the release digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurucommu-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "yurucommu-worker.js");
    await writeFile(
      artifactPath,
      'export default { fetch() { return new Response("changed"); } };\n',
    );

    const result = Bun.spawnSync(
      [
        "node",
        "scripts/smoke-release-worker.mjs",
        artifactPath,
        `sha256:${"0".repeat(64)}`,
      ],
      {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("does not equal sha256:");
  });
});
