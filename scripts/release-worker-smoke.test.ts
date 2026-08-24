import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("release Worker smoke", () => {
  test("boots the exact artifact with runtime-native bindings", async () => {
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
        "bun",
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

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      kind: "yurucommu.release-worker-smoke@v1",
      artifact: "yurucommu-worker.js",
      sha256: `sha256:${sha256}`,
      runtime: "workerd",
      substrate: "runtime-native-bindings",
      checks: ["readyz", "discovery", "embedded-ui"],
      status: "PASSED",
    });
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
        "bun",
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
