import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../", import.meta.url).pathname;

function baseConfig() {
  return {
    name: "yurucommu",
    main: "./dist/yurucommu-worker.js",
    vars: {
      APP_URL: "https://yurucommu.example.test",
      DELIVERY_QUEUE_NAME: "yurucommu-delivery",
      DELIVERY_DLQ_NAME: "yurucommu-delivery-dlq",
    },
    queues: {
      producers: [
        { binding: "DELIVERY_QUEUE", queue: "yurucommu-delivery" },
        { binding: "DELIVERY_DLQ", queue: "yurucommu-delivery-dlq" },
      ],
      consumers: [
        {
          queue: "yurucommu-delivery",
          dead_letter_queue: "yurucommu-delivery-dlq",
        },
        { queue: "yurucommu-delivery-dlq" },
      ],
    },
  };
}

async function runWithConfig(configSource: string) {
  const root = await mkdtemp(join(tmpdir(), "yurucommu-deploy-preflight-"));
  const path = join(root, "wrangler.jsonc");
  await writeFile(path, configSource);
  const result = spawnSync("bun", ["scripts/deploy.mjs", "yurucommu-worker"], {
    cwd: repo,
    env: { ...process.env, YURUCOMMU_WRANGLER_CONFIG: path },
    encoding: "utf8",
  });
  await rm(root, { recursive: true, force: true });
  return `${result.stdout}\n${result.stderr}`;
}

describe("direct Wrangler deploy preflight", () => {
  test("parses JSONC and accepts an exact origin/queue topology before the dirty gate", async () => {
    const source = `// operator config\n${JSON.stringify(
      baseConfig(),
      null,
      2,
    ).replace(/\n\}/gu, ",\n}")}\n`;
    const output = await runWithConfig(source);
    expect(output).toContain("the worktree is not clean");
    expect(output).not.toContain("APP_URL");
    expect(output).not.toContain(
      "queue producer/consumer identities do not match",
    );
  });

  test("rejects a non-canonical APP_URL before any owner gate or upload", async () => {
    const config = baseConfig();
    config.vars.APP_URL = "http://yurucommu.example.test/path";
    const output = await runWithConfig(JSON.stringify(config));
    expect(output).toContain("vars.APP_URL must be an exact HTTPS origin");
    expect(output).not.toContain("the worktree is not clean");
  });

  test("rejects producer/consumer drift before any owner gate or upload", async () => {
    const config = baseConfig();
    config.queues.consumers[1] = { queue: "other-dlq" };
    const output = await runWithConfig(JSON.stringify(config));
    expect(output).toContain("queue producer/consumer identities do not match");
    expect(output).not.toContain("the worktree is not clean");
  });
});
