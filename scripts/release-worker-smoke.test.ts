import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const artifacts = {
  "direct-cloudflare": "dist/yurucommu-worker.js",
  hosted: "dist/yurucommu-hosted-worker.js",
} as const;

function smokeArtifact(lane: "direct-cloudflare" | "hosted"): string {
  const mediaMatches =
    lane === "direct-cloudflare"
      ? `typeof env.MEDIA?.fetch !== "function" &&
      typeof env.MEDIA?.put === "function" &&
      typeof env.MEDIA?.get === "function" &&
      typeof env.MEDIA?.delete === "function" &&
      typeof env.MEDIA?.createMultipartUpload === "function" &&
      typeof env.MEDIA?.resumeMultipartUpload === "function"`
      : `typeof env.MEDIA?.fetch === "function"`;
  return `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const native =
      typeof env.DB?.prepare === "function" &&
      typeof env.KV?.get === "function" &&
      ${mediaMatches};
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
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

beforeAll(() => {
  const result = Bun.spawnSync([process.execPath, "run", "build:worker"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `build:worker failed:\n${result.stderr.toString() || result.stdout.toString()}`,
    );
  }
}, 60_000);

describe("release Worker smoke", () => {
  test.each(["direct-cloudflare", "hosted"] as const)(
    "applies the packaged schema and proves exact %s ObjectStore CRUD through the artifact",
    async (lane) => {
      const artifactPath = join(repo, artifacts[lane]);
      const artifact = await readFile(artifactPath);
      const sha256 = createHash("sha256").update(artifact).digest("hex");

      const result = Bun.spawnSync(
        [
          process.execPath,
          "scripts/smoke-release-worker.mjs",
          artifactPath,
          `sha256:${sha256}`,
          "--lane",
          lane,
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
        artifact: artifacts[lane].split("/").at(-1),
        sha256: `sha256:${sha256}`,
        runtime: "workerd",
        lane,
        substrate:
          lane === "direct-cloudflare"
            ? "native-cloudflare-r2"
            : "sealed-s3-fetch",
        checks: [
          "packaged-migration-lineage",
          "single-yurucommu-migration-ledger",
          "schema-backed-mobile-login",
          "media-put-exact-body-content-type",
          "media-get-lazy-body-content-type",
          "media-delete-and-absence",
          "readyz",
          "discovery",
          "embedded-ui",
          "cross-reject-opposite-media",
          "no-runtime-errors",
        ],
        status: "PASSED",
      });
    },
    60_000,
  );

  test.each(["direct-cloudflare", "hosted"] as const)(
    "rejects a readiness-only %s artifact with no schema-backed request or media CRUD",
    async (lane) => {
      const directory = await mkdtemp(join(tmpdir(), "yurucommu-smoke-test-"));
      temporaryDirectories.push(directory);
      const artifactPath = join(directory, artifacts[lane].split("/").at(-1)!);
      const artifact = smokeArtifact(lane);
      await writeFile(artifactPath, artifact);
      const sha256 = createHash("sha256").update(artifact).digest("hex");

      const result = Bun.spawnSync(
        [
          "bun",
          "scripts/smoke-release-worker.mjs",
          artifactPath,
          `sha256:${sha256}`,
          "--lane",
          lane,
        ],
        {
          cwd: repo,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("schema-backed mobile login");
    },
    30_000,
  );

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
        "--lane",
        "direct-cloudflare",
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
