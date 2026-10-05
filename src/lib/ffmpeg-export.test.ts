import { describe, expect, test } from "bun:test";

type Result = {
  status: "resolved" | "rejected" | "pending";
  name?: string;
  message?: string;
  bytes?: number[];
};

// Keep Bun module mocks in a fresh process for each observation. The target
// remains the real ffmpeg.ts module; only FFmpeg and fetch/download seams are
// controlled here.
const childSource = String.raw`
const config = __CONFIG__;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = (callback, delay, ...args) =>
  nativeSetTimeout(callback, Number(delay) > 10_000 ? 15 : delay, ...args);
const settleWithin = async (promise, ms = 100) => {
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = nativeSetTimeout(() => resolve({ status: "pending" }), ms);
  });
  const observed = Promise.resolve(promise).then(
    async (value) => ({
      status: "resolved",
      bytes: value?.blob ? Array.from(new Uint8Array(await value.blob.arrayBuffer())) : undefined,
    }),
    (error) => ({ status: "rejected", name: error?.name, message: String(error?.message ?? error) }),
  );
  const result = await Promise.race([observed, watchdog]);
  clearTimeout(timer);
  return result;
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const loadReached = deferred();
const operationReached = deferred();
const gate = deferred();
const state = { instances: [], exports: 0, canvasReached: deferred(), revocations: [] };

class StubFFmpeg {
  constructor() {
    this.id = state.instances.length + 1;
    this.calls = [];
    this.terminateCalls = 0;
    this.listeners = new Map();
    state.instances.push(this);
  }
  async load() {
    loadReached.resolve(this.id);
    if (config.holdLoad && this.id === 1) return gate.promise;
  }
  on(name, callback) { this.listeners.set(name, callback); }
  off(name) { this.listeners.delete(name); }
  terminate() { this.terminateCalls += 1; }
  async writeFile(path) { return this.perform("writeFile", path); }
  async exec() {
    await this.perform("exec", "exec");
    return config.mode === "nonzero" && this.id === 1 ? 1 : 0;
  }
  async readFile(path) {
    await this.perform("readFile", path);
    if (this.id === 1 && config.mode === "string-output") return "not binary";
    if (this.id === 1 && config.mode === "empty-output") return new Uint8Array();
    return new Uint8Array([7, 0, 255]);
  }
  async deleteFile(path) { return this.perform("deleteFile", path); }
  async perform(operation, detail) {
    this.calls.push([operation, detail]);
    if (this.id === 1 && config.mode === operation) {
      operationReached.resolve({ id: this.id, operation });
      return gate.promise;
    }
  }
}

const { mock } = await import("bun:test");
mock.module("@ffmpeg/ffmpeg", () => ({ FFmpeg: StubFFmpeg }));
mock.module("@ffmpeg/util", () => ({
  fetchFile: async () => new Uint8Array([1, 2, 3]),
  toBlobURL: async (url) => url,
}));
const revoked = state.revocations;
globalThis.URL.createObjectURL = () => "blob:story-video";
globalThis.URL.revokeObjectURL = (url) => revoked.push(url);
globalThis.document = {
  createElement: () => {
    const video = {
      duration: 12,
      onloadedmetadata: null,
      onerror: null,
      preload: "",
      _src: "",
      set src(value) {
        this._src = value;
        queueMicrotask(() => this.onloadedmetadata?.());
      },
      get src() { return this._src; },
      removeAttribute(name) { if (name === "src") this._src = ""; },
      load() {},
    };
    return video;
  },
};
const ffmpeg = await import(config.target);
const file = new Blob(["video"], { type: "video/mp4" });
const makeCanvas = (hang = false) => ({
  toBlob(callback) {
    if (hang) {
      state.canvasReached.resolve();
      return;
    }
    callback(new Blob(["overlay"]));
  },
});
const exportVideo = (signal, hangCanvas = false) =>
  ffmpeg.exportCanvasWithVideo(makeCanvas(hangCanvas), file, undefined, undefined, signal);

const describe = async (promise, watchdogMs = 100) => settleWithin(promise, watchdogMs);
let result;

if (config.case === "concurrent-abort-init") {
  const controller = new AbortController();
  const first = exportVideo(controller.signal);
  const firstObserved = describe(first, 60);
  await Promise.race([loadReached.promise, new Promise((resolve) => nativeSetTimeout(resolve, 60))]);
  const second = exportVideo();
  const secondResult = await describe(second, 8);
  controller.abort();
  gate.resolve();
  const firstResult = await firstObserved;
  const retry = await describe(exportVideo());
  result = {
    first: firstResult,
    second: secondResult,
    retry,
    instanceCount: state.instances.length,
    terminations: state.instances.map((instance) => instance.terminateCalls),
  };
} else if (config.case === "operation-timeout") {
  const first = exportVideo();
  const firstObserved = describe(first, 100);
  const entered = await Promise.race([
    operationReached.promise,
    new Promise((resolve) => nativeSetTimeout(() => resolve(null), 80)),
  ]);
  const firstResult = await firstObserved;
  const firstWorker = state.instances[0];
  const callsBeforeLate = firstWorker?.calls.length ?? 0;
  const retry = await describe(exportVideo());
  gate.resolve();
  await new Promise((resolve) => nativeSetTimeout(resolve, 10));
  const callsAfterLate = firstWorker?.calls.length ?? 0;
  const stillCached = await describe(exportVideo());
  result = {
    entered,
    first: firstResult,
    retry,
    stillCached,
    instanceCount: state.instances.length,
    firstTerminateCount: firstWorker?.terminateCalls,
    callsBeforeLate,
    callsAfterLate,
  };
} else if (config.case === "preparation-timeout") {
  const first = exportVideo(undefined, true);
  const firstObserved = describe(first, 100);
  await Promise.race([
    state.canvasReached.promise,
    new Promise((resolve) => nativeSetTimeout(resolve, 80)),
  ]);
  const firstResult = await firstObserved;
  const firstWorker = state.instances[0];
  const retry = await describe(exportVideo());
  result = {
    first: firstResult,
    retry,
    instanceCount: state.instances.length,
    firstTerminateCount: firstWorker?.terminateCalls,
    firstCalls: firstWorker?.calls,
  };
} else {
  const observation = await describe(exportVideo());
  result = {
    observation,
    instanceCount: state.instances.length,
    calls: state.instances[0]?.calls,
    terminations: state.instances.map((instance) => instance.terminateCalls),
    revocations: revoked,
  };
}
process.stdout.write(JSON.stringify(result));
`;

async function observe(
  scenario: string,
  mode?: string,
): Promise<Record<string, any>> {
  const target = new URL("./ffmpeg.ts", import.meta.url).href;
  const source = childSource.replace(
    "__CONFIG__",
    JSON.stringify({
      case: scenario,
      mode,
      holdLoad: scenario === "concurrent-abort-init",
      target,
    }),
  );
  const child = Bun.spawn([process.execPath, "--eval", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout);
}

describe("Story FFmpeg export lifecycle", () => {
  test("admits one export before shared init, rejects a concurrent export, and lets an aborting waiter leave init alive", async () => {
    const result = await observe("concurrent-abort-init");

    expect((result.first as Result).status).toBe("rejected");
    expect((result.second as Result).status).toBe("rejected");
    expect((result.retry as Result).status).toBe("resolved");
    expect(result.instanceCount).toBe(1);
    expect(result.terminations).toEqual([0]);
  });

  for (const operation of ["writeFile", "exec", "readFile", "deleteFile"]) {
    test(`bounds a stalled ${operation}, retires that worker, and recovers after its late completion`, async () => {
      const result = await observe("operation-timeout", operation);

      expect(result.entered).toEqual({ id: 1, operation });
      expect((result.first as Result).status).toBe("rejected");
      expect((result.retry as Result).status).toBe("resolved");
      expect((result.stillCached as Result).status).toBe("resolved");
      expect(result.instanceCount).toBe(2);
      expect(result.firstTerminateCount).toBe(1);
      expect(result.callsAfterLate).toBe(result.callsBeforeLate);
    });
  }

  test("includes canvas preparation in the export deadline and recovers", async () => {
    const result = await observe("preparation-timeout");

    expect((result.first as Result).status).toBe("rejected");
    expect((result.retry as Result).status).toBe("resolved");
    expect(result.instanceCount).toBe(2);
    expect(result.firstTerminateCount).toBe(1);
  });

  test("does not read output after a nonzero FFmpeg exit and terminates that worker", async () => {
    const result = await observe("single", "nonzero");

    expect((result.observation as Result).status).toBe("rejected");
    expect((result.observation as Result).name).toBe("FFmpegError");
    expect(
      (result.calls as unknown[][]).some(([name]) => name === "readFile"),
    ).toBe(false);
    expect(result.terminations).toEqual([1]);
  });

  for (const mode of ["empty-output", "string-output"]) {
    test(`rejects ${mode} from FFmpeg instead of returning an unusable blob`, async () => {
      const result = await observe("single", mode);

      expect((result.observation as Result).status).toBe("rejected");
      expect((result.observation as Result).name).toBe("FFmpegError");
    });
  }

  test("returns binary output, cleans all work files, and keeps the loaded worker reusable", async () => {
    const result = await observe("single");

    expect((result.observation as Result).status).toBe("resolved");
    expect((result.observation as Result).bytes).toEqual([7, 0, 255]);
    expect(result.instanceCount).toBe(1);
    expect(
      (result.calls as unknown[][]).filter(([name]) => name === "deleteFile"),
    ).toHaveLength(3);
  });
});
