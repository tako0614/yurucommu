// Miniflare owns the runtime pipes, but handleRuntimeStdio receives distinct
// intermediary streams on every runtime start/rebuild. Own those pipes here.
export function createManagedNativeRuntime(
  construct,
  { destination = process.stderr } = {},
) {
  const streams = new Set();
  let state = "active";
  let disposal;

  function release(stream) {
    let firstError;
    try {
      stream.unpipe(destination);
    } catch (error) {
      firstError = error;
    }
    try {
      stream.destroy();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  }

  function releaseAll() {
    let firstError;
    for (const stream of streams) {
      try {
        release(stream);
      } catch (error) {
        firstError ??= error;
      }
    }
    streams.clear();
    if (firstError !== undefined) throw firstError;
  }

  function handleRuntimeStdio(stdout, stderr) {
    if (state !== "active") {
      let firstError;
      let failed = false;
      for (const stream of [stdout, stderr]) {
        try {
          release(stream);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
      if (failed) throw firstError;
      return;
    }

    for (const stream of [stdout, stderr]) {
      if (!streams.has(stream)) {
        streams.add(stream);
        stream.pipe(destination, { end: false });
      }
    }
  }

  let worker;
  try {
    worker = construct(handleRuntimeStdio);
  } catch (error) {
    state = "closed";
    try {
      releaseAll();
    } catch {
      // The constructor error is the primary failure.
    }
    throw error;
  }

  return {
    worker,
    dispose() {
      if (disposal) return disposal;
      state = "closing";
      disposal = (async () => {
        let workerError;
        let workerFailed = false;
        try {
          await worker.dispose();
        } catch (error) {
          workerError = error;
          workerFailed = true;
        }

        let cleanupError;
        let cleanupFailed = false;
        try {
          releaseAll();
        } catch (error) {
          cleanupError = error;
          cleanupFailed = true;
        }
        state = "closed";
        if (workerFailed) throw workerError;
        if (cleanupFailed) throw cleanupError;
      })();
      return disposal;
    },
  };
}
