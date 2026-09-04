import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  deployYurucommuSite,
  parsePagesDeploymentUrl,
  YurucommuSiteReleaseFailure,
} from "./release-yurucommu-site.mjs";

const commit = "c".repeat(40);
const immutableUrl = "https://0123456789abcdef.yurucommu-website.pages.dev";

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "yurucommu-site-publisher-"));
  await mkdir(join(repo, "site"), { recursive: true });
  const index = Buffer.from("<!doctype html><title>fixture</title>\n");
  await writeFile(join(repo, "site", "index.html"), index);
  return { repo, index };
}

function failureOf(error: unknown) {
  expect(error).toBeInstanceOf(YurucommuSiteReleaseFailure);
  return error as InstanceType<typeof YurucommuSiteReleaseFailure>;
}

async function cleanFixture<T>(
  callback: (value: Awaited<ReturnType<typeof fixture>>) => Promise<T>,
) {
  const value = await fixture();
  try {
    return await callback(value);
  } finally {
    await rm(value.repo, { recursive: true, force: true });
  }
}

describe("small yurucommu Pages publisher", () => {
  test("accepts a dirty non-main integration worktree and uploads once", () =>
    cleanFixture(async ({ repo, index }) => {
      let checks = 0;
      let uploads = 0;
      const readbacks: string[] = [];
      const result = await deployYurucommuSite({
        repo,
        environment: "integration",
        git: async (args) => {
          if (args[0] === "branch") return "feature/site";
          if (args[0] === "rev-parse") return commit;
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        run: async (command, args) => {
          if (command === "bun" && args.join(" ") === "run check:site") {
            checks += 1;
            return "site ok";
          }
          throw new Error(`unexpected process ${command} ${args.join(" ")}`);
        },
        provider: {
          upload: async (input) => {
            uploads += 1;
            expect(input.environment).toBe("integration");
            expect(input.branch).toBe("feature/site");
            expect(input.siteRoot).toBe(join(repo, "site"));
            return { url: immutableUrl };
          },
          readback: async ({ origin, expected }) => {
            readbacks.push(origin);
            expect(expected.bytes).toBe(index.length);
            return {
              origin,
              path: "/",
              status: 200,
              bytes: index.length,
              sha256: resultDigest(index),
            };
          },
        },
      });
      expect(checks).toBe(1);
      expect(uploads).toBe(1);
      expect(readbacks).toEqual([immutableUrl]);
      expect(result.environment).toBe("integration");
      expect(result.deploymentUrl).toBe(immutableUrl);
      expect(result.status).toBe("PUBLISHED");
    }));

  test("refuses a dirty production worktree before check or upload", () =>
    cleanFixture(async ({ repo }) => {
      let checks = 0;
      let uploads = 0;
      const failure = await deployYurucommuSite({
        repo,
        environment: "production",
        git: async (args) => {
          if (args[0] === "status") return " M site/index.html";
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        run: async () => {
          checks += 1;
          return "";
        },
        provider: {
          upload: async () => {
            uploads += 1;
            return { url: immutableUrl };
          },
        },
      }).catch((error) => error);
      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(checks).toBe(0);
      expect(uploads).toBe(0);
    }));

  test("classifies a scoped check failure as pre-upload", () =>
    cleanFixture(async ({ repo }) => {
      let uploads = 0;
      const failure = await deployYurucommuSite({
        repo,
        environment: "integration",
        git: async (args) => (args[0] === "branch" ? "feature/site" : commit),
        provider: {
          check: async () => {
            throw new Error("site validation failed");
          },
          upload: async () => {
            uploads += 1;
            return { url: immutableUrl };
          },
        },
      }).catch((error) => error);
      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(failure.message).toContain("site validation failed");
      expect(uploads).toBe(0);
    }));

  test("classifies a Wrangler startup failure before child start as pre-upload", () =>
    cleanFixture(async ({ repo }) => {
      let wranglerAttempts = 0;
      const failure = await deployYurucommuSite({
        repo,
        environment: "integration",
        git: async (args) => (args[0] === "branch" ? "feature/site" : commit),
        run: async (command) => {
          if (command === "bun") return "site ok";
          if (command === "wrangler") {
            wranglerAttempts += 1;
            throw Object.assign(new Error("spawn wrangler ENOENT"), {
              code: "ENOENT",
            });
          }
          throw new Error(`unexpected process ${command}`);
        },
      }).catch((error) => error);
      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(failure.message).toContain("spawn wrangler ENOENT");
      expect(wranglerAttempts).toBe(1);
    }));

  test("classifies a Wrangler failure after child start as indeterminate", () =>
    cleanFixture(async ({ repo }) => {
      let wranglerAttempts = 0;
      const failure = await deployYurucommuSite({
        repo,
        environment: "integration",
        git: async (args) => (args[0] === "branch" ? "feature/site" : commit),
        run: async (command, _args, options) => {
          if (command === "bun") return "site ok";
          if (command === "wrangler") {
            wranglerAttempts += 1;
            (options as { onSpawn?: () => void } | undefined)?.onSpawn?.();
            throw new Error("provider request failed");
          }
          throw new Error(`unexpected process ${command}`);
        },
      }).catch((error) => error);
      expect(failureOf(failure).phase).toBe("POST_UPLOAD_INDETERMINATE");
      expect(failure.message).toContain("provider request failed");
      expect(wranglerAttempts).toBe(1);
    }));

  test("classifies a provider error after upload begins as indeterminate", () =>
    cleanFixture(async ({ repo }) => {
      let uploads = 0;
      const failure = await deployYurucommuSite({
        repo,
        environment: "integration",
        git: async (args) => (args[0] === "branch" ? "feature/site" : commit),
        provider: {
          check: async () => {},
          upload: async () => {
            uploads += 1;
            throw new Error("lost provider acknowledgement");
          },
        },
      }).catch((error) => error);
      expect(failureOf(failure).phase).toBe("POST_UPLOAD_INDETERMINATE");
      expect(failure.message).toContain("lost provider acknowledgement");
      expect(uploads).toBe(1);
    }));

  test("reads immutable and production origins without cache bypass", () =>
    cleanFixture(async ({ repo, index }) => {
      const requests: Array<{ input: string; init?: RequestInit }> = [];
      const fetchImpl = async (input: string | URL, init?: RequestInit) => {
        requests.push({ input: String(input), init });
        return new Response(index, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      };
      const result = await deployYurucommuSite({
        repo,
        environment: "production",
        git: async (args) => {
          if (args[0] === "status") return "";
          if (args[0] === "branch") return "main";
          if (args[0] === "fetch") return "";
          return commit;
        },
        provider: {
          check: async () => {},
          upload: async ({ environment, branch, commit: source }) => {
            expect(environment).toBe("production");
            expect(branch).toBe("main");
            expect(source).toBe(commit);
            return { url: immutableUrl };
          },
        },
        fetchImpl,
      });
      expect(result.publicReadback?.origin).toBe("https://yurucommu.com");
      expect(requests.map(({ input }) => input)).toEqual([
        `${immutableUrl}/`,
        "https://yurucommu.com/",
      ]);
      expect(requests.every(({ init }) => init === undefined)).toBe(true);
    }));

  test("accepts only an immutable Pages URL", () => {
    expect(parsePagesDeploymentUrl({ url: immutableUrl })).toBe(immutableUrl);
    expect(parsePagesDeploymentUrl(`uploaded ${immutableUrl}/`)).toBe(
      immutableUrl,
    );
    expect(() =>
      parsePagesDeploymentUrl({
        url: "https://main.yurucommu-website.pages.dev",
      }),
    ).toThrow();
    expect(() =>
      parsePagesDeploymentUrl(
        `uploaded ${immutableUrl}.attacker.example.invalid`,
      ),
    ).toThrow();
  });
});

function resultDigest(bytes: Uint8Array) {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}
