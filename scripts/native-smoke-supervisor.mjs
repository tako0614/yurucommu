import { spawn as nodeSpawn } from "node:child_process";
import process from "node:process";
import { performance } from "node:perf_hooks";

export const DEFAULT_NATIVE_SMOKE_TIMEOUT_MS = 120_000;
const DEFAULT_TERM_GRACE_MS = 1_000;
const DEFAULT_KILL_WAIT_MS = 1_000;
const DEFAULT_STDOUT_LIMIT_BYTES = 4 * 1024 * 1024;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pid) {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForGroupExit(pid, durationMs) {
  const deadline = performance.now() + durationMs;
  do {
    if (!groupAlive(pid)) return true;
    await delay(Math.min(20, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  return !groupAlive(pid);
}

function signalGroup(child, signal) {
  if (!child) return "not-started";
  if (
    process.platform !== "win32" &&
    Number.isInteger(child.pid) &&
    child.pid > 1
  ) {
    try {
      process.kill(-child.pid, signal);
      return "process-group";
    } catch (error) {
      if (error?.code === "ESRCH") return "already-exited";
    }
  }
  try {
    return child.kill(signal) ? "child" : "signal-failed";
  } catch {
    return "signal-failed";
  }
}

function closePipe(child, name) {
  try {
    child?.[name]?.destroy();
  } catch {
    // The group has already been signaled; keep releasing the other pipe.
  }
}

function failure(reason, startedAt, details = {}) {
  const context = Object.entries({ stage: "native-smoke-child", ...details })
    .map(([key, value]) => `${key}=${String(value).slice(0, 160)}`)
    .join(" ");
  return new Error(
    `native smoke ${reason} after ${Math.round(performance.now() - startedAt)}ms (${context})`,
  );
}

function abortError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason));
}

function aborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    signal.addEventListener("abort", () => reject(abortError(signal)), {
      once: true,
    });
  });
}

// A write callback proves that Node accepted the bytes. A destination that
// closes, errors, or never drains cannot hold the supervisor past its deadline.
function writeBytes(target, bytes, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    let callbackDone = false;
    let drainDone = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      target.off("error", onError);
      target.off("close", onClose);
      target.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const maybeFinish = () => {
      if (callbackDone && drainDone) finish();
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("output destination closed"));
    const onAbort = () => finish(abortError(signal));
    const onDrain = () => {
      drainDone = true;
      maybeFinish();
    };
    target.once("error", onError);
    target.once("close", onClose);
    target.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
    if (target.destroyed || target.writableEnded) {
      finish(new Error("output destination is closed"));
      return;
    }
    try {
      const accepted = target.write(bytes, (error) => {
        if (error) finish(error);
        else {
          callbackDone = true;
          maybeFinish();
        }
      });
      if (accepted) {
        drainDone = true;
        target.off("drain", onDrain);
        maybeFinish();
      }
    } catch (error) {
      finish(error);
    }
  });
}

function exitResult(child, startedAt) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signalCode) => {
      if (signalCode !== null) {
        reject(
          failure("child was signaled", startedAt, { signal: signalCode }),
        );
      } else if (exitCode !== 0) {
        reject(failure("child exited unsuccessfully", startedAt, { exitCode }));
      } else {
        resolve({ exitCode, signalCode });
      }
    });
  });
}

/**
 * Run a disposable native smoke child in a detached process group. Only the
 * fixed public CLI supplies the real qualification command; this exported seam
 * lets tests exercise process supervision with synthetic children.
 */
export async function runSupervisedCommand(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_NATIVE_SMOKE_TIMEOUT_MS,
    termGraceMs = DEFAULT_TERM_GRACE_MS,
    killWaitMs = DEFAULT_KILL_WAIT_MS,
    stdoutLimitBytes = DEFAULT_STDOUT_LIMIT_BYTES,
    stdoutTarget = process.stdout,
    stderrTarget = process.stderr,
    spawn = nodeSpawn,
  } = options;
  for (const [name, value] of [
    ["timeoutMs", timeoutMs],
    ["termGraceMs", termGraceMs],
    ["killWaitMs", killWaitMs],
    ["stdoutLimitBytes", stdoutLimitBytes],
  ]) {
    if (
      !Number.isInteger(value) ||
      value < (name === "timeoutMs" || name === "stdoutLimitBytes" ? 1 : 0)
    ) {
      throw new Error(`${name} must be a valid non-negative integer`);
    }
  }
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("native smoke child command must not be empty");
  }
  if (process.platform === "win32") {
    throw new Error("native smoke supervision requires POSIX process groups");
  }

  const startedAt = performance.now();
  const controller = new AbortController();
  const drainController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      failure("exceeded its deadline", startedAt, { timeoutMs }),
    );
  }, timeoutMs);
  const interruption = aborted(controller.signal);
  void interruption.catch(() => undefined);
  let child;
  let readers;
  let requestedSignal;
  const destinationListeners = [];
  const watchDestination = (target, name) => {
    if (
      !target ||
      typeof target.write !== "function" ||
      typeof target.on !== "function" ||
      typeof target.off !== "function"
    ) {
      throw new Error(`${name} destination is not writable`);
    }
    const failDestination = (reason) => {
      controller.abort(reason);
      if (name === "stderr") drainController.abort(reason);
    };
    const onError = (error) =>
      failDestination(
        failure(`${name} destination failed`, startedAt, {
          error: error instanceof Error ? error.message : error,
        }),
      );
    const onClose = () =>
      failDestination(failure(`${name} destination closed`, startedAt));
    target.on("error", onError);
    target.on("close", onClose);
    destinationListeners.push(() => {
      target.off("error", onError);
      target.off("close", onClose);
    });
    if (target.destroyed || target.writableEnded) onClose();
  };
  const onSignal = (name) => {
    if (requestedSignal) return;
    requestedSignal = name;
    controller.abort(
      failure("supervisor received a termination signal", startedAt, {
        signal: name,
      }),
    );
    signalGroup(child, "SIGTERM");
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    watchDestination(stderrTarget, "stderr");
    watchDestination(stdoutTarget, "stdout");
    if (controller.signal.aborted) throw abortError(controller.signal);
    child = spawn(command[0], command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    if (
      !child?.stdout ||
      !child?.stderr ||
      typeof child.stdout[Symbol.asyncIterator] !== "function" ||
      typeof child.stderr[Symbol.asyncIterator] !== "function"
    ) {
      throw new Error("child stdio pipes were not created");
    }
    const exited = exitResult(child, startedAt);
    const stdoutChunks = [];
    let stdoutBytes = 0;
    const stdoutDone = (async () => {
      for await (const chunk of child.stdout) {
        const bytes = Buffer.from(chunk);
        if (stdoutBytes + bytes.length > stdoutLimitBytes) {
          throw failure("stdout exceeded its limit", startedAt, {
            stdoutLimitBytes,
          });
        }
        stdoutBytes += bytes.length;
        stdoutChunks.push(bytes);
      }
    })();
    const stderrDone = (async () => {
      for await (const chunk of child.stderr) {
        await writeBytes(
          stderrTarget,
          Buffer.from(chunk),
          drainController.signal,
        );
      }
    })();
    readers = [exited, stdoutDone, stderrDone];
    const [exit] = await Promise.race([Promise.all(readers), interruption]);
    if (controller.signal.aborted) throw abortError(controller.signal);
    // EOF and exit are insufficient when an owned descendant closed its pipes
    // but continues serving. Keep the success bytes private until the group dies.
    while (groupAlive(child.pid)) {
      await Promise.race([delay(20), interruption]);
    }
    if (controller.signal.aborted) throw abortError(controller.signal);
    const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
    if (stdout.length) {
      try {
        await writeBytes(stdoutTarget, stdout, controller.signal);
      } catch (error) {
        throw failure(
          "stdout destination failed after clean child completion",
          startedAt,
          {
            error: error instanceof Error ? error.message : error,
            publishedBytesMayBePartial: true,
          },
        );
      }
    }
    if (controller.signal.aborted) throw abortError(controller.signal);
    return {
      exitCode: exit.exitCode,
      signalCode: exit.signalCode,
      elapsedMs: Math.round(performance.now() - startedAt),
      stdoutBytes: stdout.length,
    };
  } catch (error) {
    // Stop qualification immediately, but keep accepting raw child stderr
    // during the finite group termination and pipe-drain grace.
    controller.abort(error);
    const term = signalGroup(child, "SIGTERM");
    let groupExited = await waitForGroupExit(child?.pid, termGraceMs);
    let kill = "not-needed";
    if (!groupExited) {
      kill = signalGroup(child, "SIGKILL");
      groupExited = await waitForGroupExit(child?.pid, killWaitMs);
    }
    // An unrelated process can inherit an output descriptor. Its EOF is never
    // a reason to wait indefinitely or to signal a process outside our group.
    let stderrDrain = "not-started";
    let pipes = "not-started";
    let stderrMayBeIncomplete = false;
    if (readers) {
      const stderrSettled = Promise.allSettled([readers[2]]);
      const completed = await Promise.race([
        stderrSettled.then((results) => results),
        delay(killWaitMs).then(() => null),
      ]);
      if (!completed) {
        stderrDrain = "incomplete:cutoff";
        stderrMayBeIncomplete = true;
        drainController.abort(new Error("stderr drain grace expired"));
        closePipe(child, "stdout");
        closePipe(child, "stderr");
        await Promise.race([stderrSettled, delay(20)]);
      } else {
        stderrDrain =
          completed[0]?.status === "fulfilled"
            ? "complete"
            : "incomplete:sink-or-stream";
        stderrMayBeIncomplete = stderrDrain !== "complete";
      }
      if (stderrDrain === "complete") {
        // The stderr reader finished independently, so closing stdout after
        // its own grace cannot remove already-delivered diagnostics.
        stderrMayBeIncomplete = false;
      }
      const stdoutAndExit = Promise.allSettled([readers[0], readers[1]]);
      const done = await Promise.race([
        stdoutAndExit.then(() => true),
        delay(20).then(() => false),
      ]);
      if (done) {
        pipes = "complete";
      } else {
        pipes = "closed-after-grace";
        closePipe(child, "stdout");
        closePipe(child, "stderr");
        await Promise.race([stdoutAndExit, delay(20)]);
      }
    } else {
      stderrMayBeIncomplete = true;
      closePipe(child, "stdout");
      closePipe(child, "stderr");
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw failure("failed", startedAt, {
      cause,
      term,
      kill,
      groupExited,
      stderrDrain,
      stderrMayBeIncomplete,
      pipes,
    });
  } finally {
    clearTimeout(timeoutHandle);
    for (const remove of destinationListeners) remove();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
