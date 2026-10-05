import { describe, expect, test } from "bun:test";

type Observation = {
  status: "resolved" | "rejected" | "pending";
  value?: unknown;
  error?: string;
};

const childHarness = String.raw`
import { mock } from "bun:test";
const config = __CONFIG__;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = ((callback, delay, ...args) =>
  nativeSetTimeout(callback, Number(delay) > 10_000 ? 15 : delay, ...args)
);

const settleWithin = async (promise, limit = 150) => {
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = nativeSetTimeout(() => resolve({ status: "pending" }), limit);
  });
  const observed = Promise.resolve(promise).then(
    (value) => ({ status: "resolved", value }),
    (error) => ({ status: "rejected", error: String(error?.message ?? error) }),
  );
  const result = await Promise.race([observed, watchdog]);
  clearTimeout(timer);
  return result;
};

let result;

if (config.case === "init") {
  let releaseFirstLoad;
  let instanceCount = 0;
  let firstTerminateCount = 0;
  class StubFFmpeg {
    constructor() {
      this.instance = ++instanceCount;
    }
    load() {
      if (this.instance === 1) {
        return new Promise((resolve) => { releaseFirstLoad = resolve; });
      }
      return Promise.resolve();
    }
    terminate() {
      if (this.instance === 1) firstTerminateCount += 1;
    }
  }
  mock.module("@ffmpeg/ffmpeg", () => ({ FFmpeg: StubFFmpeg }));
  mock.module("@ffmpeg/util", () => ({
    fetchFile: async () => new Uint8Array(),
    toBlobURL: async (url) => url,
  }));
  // The production module itself is the real file under test and lives in
  // this isolated child process, so dependency mocks cannot leak to other suites.
  const ffmpegModule = await import(config.target);
  const first = ffmpegModule.initFFmpeg();
  await Promise.resolve();
  await Promise.resolve();
  const joiner = ffmpegModule.initFFmpeg();
  const [firstResult, joinerResult] = await Promise.all([
    settleWithin(first),
    settleWithin(joiner),
  ]);
  const retry = await settleWithin(ffmpegModule.initFFmpeg());
  releaseFirstLoad?.();
  await new Promise((resolve) => nativeSetTimeout(resolve, 20));
  const afterLateCompletion = await settleWithin(ffmpegModule.initFFmpeg());
  result = {
    first: firstResult,
    joiner: joinerResult,
    retry,
    afterLateCompletion,
    instanceCount,
    firstTerminateCount,
  };
} else if (config.case === "lateDownload") {
  let releaseDownload;
  let instanceCount = 0;
  let downloadCount = 0;
  const loads = [];
  const terminated = [];
  const revocations = [];
  globalThis.URL.revokeObjectURL = (url) => revocations.push(url);
  class StubFFmpeg {
    constructor() { this.instance = ++instanceCount; }
    load() { loads.push(this.instance); return Promise.resolve(); }
    terminate() { terminated.push(this.instance); }
  }
  mock.module("@ffmpeg/ffmpeg", () => ({ FFmpeg: StubFFmpeg }));
  mock.module("@ffmpeg/util", () => ({
    fetchFile: async () => new Uint8Array(),
    toBlobURL: () => {
      const url = "blob:download-" + ++downloadCount;
      if (downloadCount === 1) {
        return new Promise((resolve) => { releaseDownload = () => resolve(url); });
      }
      return Promise.resolve(url);
    },
  }));
  const target = await import(config.target);
  const first = await settleWithin(target.initFFmpeg());
  const retry = await settleWithin(target.initFFmpeg());
  releaseDownload();
  await new Promise((resolve) => nativeSetTimeout(resolve, 20));
  const cached = await settleWithin(target.initFFmpeg());
  result = { first, retry, cached, instanceCount, loads, terminated, revocations };
} else {
  const target = await import(config.target);
  const revocations = [];
  const removals = [];
  const video = {
    duration: config.duration === "NaN" ? Number.NaN : config.duration,
    onloadedmetadata: null,
    onerror: null,
    preload: "",
    src: "",
    removeAttribute(name) { removals.push(name); this.src = ""; },
    load() {},
  };
  globalThis.document = { createElement: () => video };
  globalThis.URL.createObjectURL = () => "blob:duration-test";
  globalThis.URL.revokeObjectURL = (url) => revocations.push(url);

  const file = new Blob(["video"], { type: "video/mp4" });
  const controller = new AbortController();
  const call = config.case === "abort"
    ? target.getVideoDuration(file, controller.signal)
    : target.getVideoDuration(file);
  const lateMetadata = video.onloadedmetadata;
  if (config.case === "abort") controller.abort();
  if (config.case === "metadata") video.onloadedmetadata?.();
  if (config.case === "error") video.onerror?.();
  const observation = await settleWithin(call);
  if (config.case === "timeout" || config.case === "abort") {
    lateMetadata?.();
  }
  result = { observation, revocations, removals };
}

process.stdout.write(JSON.stringify(result));
`;

async function runHarness(
  scenario: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const target = new URL("./ffmpeg.ts", import.meta.url).href;
  const source = childHarness.replace(
    "__CONFIG__",
    JSON.stringify({ case: scenario, target, ...extra }),
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
  if (exitCode !== 0) throw new Error(`FFmpeg harness failed: ${stderr}`);
  return JSON.parse(stdout);
}

describe("Story FFmpeg timeouts", () => {
  test("bounds the first initializer and joiner, then permits a fresh retry", async () => {
    const result = await runHarness("init");

    expect((result.first as Observation).status).toBe("rejected");
    expect((result.joiner as Observation).status).toBe("rejected");
    expect((result.retry as Observation).status).toBe("resolved");
    expect((result.afterLateCompletion as Observation).status).toBe("resolved");
    expect(result.instanceCount).toBe(2);
    expect(result.firstTerminateCount).toBe(1);
  });

  test("clips usable metadata duration to the Story limit", async () => {
    const result = await runHarness("metadata", { duration: 75 });

    expect(result.observation).toEqual({ status: "resolved", value: 60 });
    expect(result.revocations).toEqual(["blob:duration-test"]);
  });

  test("revokes a retired download's late Blob URL without loading or resetting the retry", async () => {
    const result = await runHarness("lateDownload");

    expect((result.first as Observation).status).toBe("rejected");
    expect((result.retry as Observation).status).toBe("resolved");
    expect((result.cached as Observation).status).toBe("resolved");
    expect(result.instanceCount).toBe(2);
    expect(result.loads).toEqual([2]);
    expect(result.terminated).toEqual([1]);
    expect(result.revocations.sort()).toEqual([
      "blob:download-1",
      "blob:download-2",
      "blob:download-3",
      "blob:download-4",
    ]);
  });

  test("uses the short fallback when metadata reports an error", async () => {
    const result = await runHarness("error", { duration: 12 });

    expect(result.observation).toEqual({ status: "resolved", value: 5 });
    expect(result.revocations).toEqual(["blob:duration-test"]);
  });

  test("uses the short fallback for invalid metadata", async () => {
    const result = await runHarness("metadata", { duration: "NaN" });

    expect(result.observation).toEqual({ status: "resolved", value: 5 });
    expect(result.revocations).toEqual(["blob:duration-test"]);
  });

  test("rejects when metadata never arrives and releases the object URL once", async () => {
    const result = await runHarness("timeout");

    expect((result.observation as Observation).status).toBe("rejected");
    expect(result.revocations).toEqual(["blob:duration-test"]);
    expect(result.removals).toContain("src");
  });

  test("aborts duration inspection and ignores a late metadata event", async () => {
    const result = await runHarness("abort");

    expect((result.observation as Observation).status).toBe("rejected");
    expect(result.revocations).toEqual(["blob:duration-test"]);
    expect(result.removals).toContain("src");
  });
});
