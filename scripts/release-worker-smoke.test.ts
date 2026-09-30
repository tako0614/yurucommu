import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, stop } from "esbuild";

import { createEntrySource } from "./build-yurucommu-worker.ts";

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

function runSmoke(artifactPath: string) {
  return Bun.spawnSync(
    ["bun", "scripts/smoke-release-worker.mjs", artifactPath],
    {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("release Worker smoke", () => {
  test("verifies the generated artifact's native queue/DLQ and story/media retention", async () => {
    const artifactPath = await buildGeneratedFixture();
    const result = runSmoke(artifactPath);
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
      ],
      status: "PASSED",
    });
  }, 30_000);

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
