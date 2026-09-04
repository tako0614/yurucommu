import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createCloudflareWorkerProvider,
  deployYurucommuWorker,
  loadYurucommuWorkerTarget,
  ownerGateEnvironment,
  YurucommuWorkerReleaseFailure,
} from "./release-yurucommu-worker.mjs";

const COMMIT = "c".repeat(40);
const REMOTE_MAIN = "d".repeat(40);
const ACCOUNT_ID = "a".repeat(32);
const OLD_VERSION = "11111111-1111-4111-8111-111111111111";
const UNSERVED_VERSION = "22222222-2222-4222-8222-222222222222";
const NEW_VERSION = "33333333-3333-4333-8333-333333333333";
const OLD_DEPLOYMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEW_DEPLOYMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONCURRENT_DEPLOYMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BUNDLE = "export default { fetch() { return new Response('ok') } };\n";
const BUNDLE_ETAG = createHash("sha256").update(BUNDLE).digest("hex");

const VERSION_CLOSURE = {
  bindings: {
    DB: { type: "d1", id: "d1-production" },
    DELIVERY_QUEUE: { type: "queue", queue_name: "delivery" },
  },
  vars: {
    DELIVERY_QUEUE_NAME: "delivery",
  },
  script_runtime: {
    compatibility_date: "2026-07-16T00:00:00Z",
    compatibility_flags: ["nodejs_compat"],
    limits: { cpu_ms: 50 },
    usage_model: "standard",
    exports: {},
  },
};

function sha256(bytes: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "yurucommu-worker-publisher-"));
  const privateDir = await mkdtemp(
    join(tmpdir(), "yurucommu-worker-publisher-private-"),
  );
  await chmod(privateDir, 0o700);
  await mkdir(join(repo, "dist"), { recursive: true });
  const config = `{
  // The production adapter accepts Wrangler's documented JSONC format.
  "name": "yurucommu",
  "account_id": "${ACCOUNT_ID}",
  "main": "./dist/yurucommu-worker.js",
  "compatibility_date": "2026-07-16",
}\n`;
  const configPath = join(privateDir, "production.wrangler.jsonc");
  await writeFile(join(repo, "dist", "yurucommu-worker.js"), BUNDLE);
  await writeFile(configPath, config);
  await chmod(configPath, 0o600);
  return {
    repo,
    privateDir,
    target: {
      kind: "yurucommu.worker-deploy-target@v1" as const,
      environment: "production" as const,
      accountId: ACCOUNT_ID,
      workerName: "yurucommu" as const,
      publicOrigin: "https://test.yurucommu.com" as const,
      route: {
        kind: "custom-domain" as const,
        hostname: "test.yurucommu.com" as const,
      },
      config: { path: configPath, sha256: sha256(config) },
    },
  };
}

async function cleanFixture<T>(
  callback: (value: Awaited<ReturnType<typeof fixture>>) => Promise<T>,
) {
  const value = await fixture();
  try {
    return await callback(value);
  } finally {
    await rm(value.repo, { recursive: true, force: true });
    await rm(value.privateDir, { recursive: true, force: true });
  }
}

function gitSource({
  branch = "main",
  remoteMain = COMMIT,
  ancestor = true,
}: {
  branch?: string;
  remoteMain?: string;
  ancestor?: boolean;
} = {}) {
  return async (args: string[]) => {
    const command = args.join(" ");
    if (command === "rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (command === "branch --show-current") return ok(`${branch}\n`);
    if (command === "status --porcelain=v1 -z --untracked-files=all") {
      return ok("");
    }
    if (
      command ===
      "fetch --quiet origin refs/heads/main:refs/remotes/origin/main"
    ) {
      return ok("");
    }
    if (command === "rev-parse refs/remotes/origin/main") {
      return ok(`${remoteMain}\n`);
    }
    if (
      command === `merge-base --is-ancestor ${COMMIT} refs/remotes/origin/main`
    ) {
      return { exitCode: ancestor ? 0 : 1, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected git ${command}`);
  };
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

function failureOf(error: unknown) {
  expect(error).toBeInstanceOf(YurucommuWorkerReleaseFailure);
  return error as InstanceType<typeof YurucommuWorkerReleaseFailure>;
}

function deployment(id: string, versionId: string, message?: string) {
  return {
    id,
    created_on: "2026-09-03T12:00:00.000Z",
    source: "wrangler",
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
    ...(message ? { annotations: { "workers/message": message } } : {}),
  };
}

function versionDetails(
  id: string,
  message = "previous",
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    annotations: { "workers/message": message },
    resources: {
      ...structuredClone(VERSION_CLOSURE),
      script: { etag: BUNDLE_ETAG },
    },
    ...overrides,
  };
}

describe("production yurucommu Worker publisher", () => {
  test("rejects arbitrary clean feature and detached commits before provider mutation", () =>
    cleanFixture(async ({ repo, target }) => {
      let uploads = 0;
      for (const branch of ["feature/not-in-main", ""]) {
        const failure = await deployYurucommuWorker({
          repo,
          environment: "production",
          commit: COMMIT,
          target,
          git: gitSource({
            branch,
            remoteMain: REMOTE_MAIN,
            ancestor: false,
          }),
          check: async () => {},
          provider: {
            upload: async () => {
              uploads += 1;
              throw new Error("must not upload");
            },
          },
        }).catch((error) => error);

        expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
        expect(failure.message).toContain("origin/main");
      }
      expect(uploads).toBe(0);
    }));

  test("fails closed when git cannot attest that a selected commit is on origin/main", () =>
    cleanFixture(async ({ repo, target }) => {
      const normalGit = gitSource({
        branch: "feature/unknown-result",
        remoteMain: REMOTE_MAIN,
      });
      let providerReads = 0;
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: async (args) => {
          if (
            args.join(" ") ===
            `merge-base --is-ancestor ${COMMIT} refs/remotes/origin/main`
          ) {
            return { stdout: "", stderr: "" };
          }
          return normalGit(args);
        },
        check: async () => {},
        provider: {
          domains: async () => {
            providerReads += 1;
            return [];
          },
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(failure.message).toContain("origin/main");
      expect(providerReads).toBe(0);
    }));

  test("rejects realized config outside the exact selected target", () =>
    cleanFixture(async ({ repo, target }) => {
      await writeFile(
        target.config.path,
        `${JSON.stringify({
          name: "another-worker",
          account_id: "b".repeat(32),
          main: "./dist/yurucommu-worker.js",
          compatibility_date: "2026-07-16",
        })}\n`,
      );
      let checks = 0;
      let uploads = 0;
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {
          checks += 1;
        },
        provider: {
          upload: async () => {
            uploads += 1;
            throw new Error("must not upload");
          },
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(failure.message).toContain("config digest");
      expect(checks).toBe(0);
      expect(uploads).toBe(0);
    }));

  test("rejects a digest-pinned config for a different Worker and account", () =>
    cleanFixture(async ({ repo, target }) => {
      const wrongConfig = `${JSON.stringify({
        name: "another-worker",
        account_id: "b".repeat(32),
        main: "./dist/yurucommu-worker.js",
        compatibility_date: "2026-07-16",
      })}\n`;
      await writeFile(target.config.path, wrongConfig);
      target.config.sha256 = sha256(wrongConfig);
      let uploads = 0;
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          upload: async () => {
            uploads += 1;
            throw new Error("must not upload");
          },
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(failure.message).toContain("different Worker script");
      expect(uploads).toBe(0);
    }));

  test("keeps environment indirection and schema migration out of the code surface", () =>
    cleanFixture(async ({ repo, target }) => {
      for (const [field, value, message] of [
        [
          "env",
          { production: { name: "another-worker" } },
          "environment indirection",
        ],
        [
          "migrations",
          [{ tag: "v2", new_classes: ["State"] }],
          "schema/data changes",
        ],
        [
          "build",
          { command: "replace-the-selected-bundle" },
          "external artifact",
        ],
        ["assets", { directory: "./public" }, "external artifact"],
      ] as const) {
        const config = `${JSON.stringify({
          name: "yurucommu",
          account_id: ACCOUNT_ID,
          main: "./dist/yurucommu-worker.js",
          compatibility_date: "2026-07-16",
          [field]: value,
        })}\n`;
        await writeFile(target.config.path, config);
        target.config.sha256 = sha256(config);
        let uploads = 0;
        const failure = await deployYurucommuWorker({
          repo,
          environment: "production",
          commit: COMMIT,
          target,
          git: gitSource(),
          check: async () => {},
          provider: {
            upload: async () => {
              uploads += 1;
              throw new Error("must not upload");
            },
          },
        }).catch((error) => error);

        expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
        expect(failure.message).toContain(message);
        expect(uploads).toBe(0);
      }
    }));

  test("uses the active Deployment as predecessor when a newer Version is unserved", () =>
    cleanFixture(async ({ repo, target }) => {
      let checks = 0;
      let latestVersionReads = 0;
      let activeReads = 0;
      let domainsRead = 0;
      let uploadMessage = "";
      let deployMessage = "";
      const provider = {
        domains: async () => {
          domainsRead += 1;
          return [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ];
        },
        activeDeployment: async () => {
          activeReads += 1;
          if (activeReads <= 2) {
            return deployment(OLD_DEPLOYMENT, OLD_VERSION);
          }
          return deployment(NEW_DEPLOYMENT, NEW_VERSION, deployMessage);
        },
        latestVersion: async () => {
          latestVersionReads += 1;
          return UNSERVED_VERSION;
        },
        version: async ({ versionId }: { versionId: string }) =>
          versionDetails(versionId, uploadMessage),
        upload: async ({ message }: { message: string }) => {
          uploadMessage = message;
          return { versionId: NEW_VERSION, workerName: "yurucommu" };
        },
        deployVersion: async ({
          versionId,
          message,
        }: {
          versionId: string;
          message: string;
        }) => {
          expect(versionId).toBe(NEW_VERSION);
          deployMessage = message;
          return { deploymentId: NEW_DEPLOYMENT, workerName: "yurucommu" };
        },
        smoke: async () => ({ status: "passed" }),
      };

      const result = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource({ branch: "", remoteMain: REMOTE_MAIN, ancestor: true }),
        check: async () => {
          checks += 1;
        },
        provider,
      });

      expect(result).toMatchObject({
        status: "PUBLISHED",
        accountId: ACCOUNT_ID,
        workerName: "yurucommu",
        route: "https://test.yurucommu.com",
        previousVersionId: OLD_VERSION,
        versionId: NEW_VERSION,
        deploymentId: NEW_DEPLOYMENT,
      });
      expect(checks).toBe(1);
      expect(activeReads).toBe(4);
      expect(domainsRead).toBe(3);
      expect(latestVersionReads).toBe(0);
    }));

  test("does not deploy a Version whose remote annotation has the wrong identity", () =>
    cleanFixture(async ({ repo, target }) => {
      let deploys = 0;
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          upload: async () => ({
            versionId: UNSERVED_VERSION,
            workerName: "yurucommu",
          }),
          version: async ({ versionId }: { versionId: string }) =>
            versionId === OLD_VERSION
              ? versionDetails(OLD_VERSION)
              : versionDetails(UNSERVED_VERSION, "somebody else's upload"),
          deployVersion: async () => {
            deploys += 1;
            return {
              deploymentId: NEW_DEPLOYMENT,
              workerName: "yurucommu",
            };
          },
          smoke: async () => ({ status: "passed" }),
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("POST_UPLOAD_INDETERMINATE");
      expect(failure.message).toContain("selected source, bundle, and config");
      expect(deploys).toBe(0);
    }));

  test("requires the authoritative Version script etag to match the uploaded bytes", () =>
    cleanFixture(async ({ repo, target }) => {
      for (const mismatch of ["missing", "wrong"] as const) {
        let uploadMessage = "";
        let deploys = 0;
        const failure = await deployYurucommuWorker({
          repo,
          environment: "production",
          commit: COMMIT,
          target,
          git: gitSource(),
          check: async () => {},
          provider: {
            domains: async () => [
              {
                hostname: "test.yurucommu.com",
                service: "yurucommu",
                environment: "production",
              },
            ],
            activeDeployment: async () =>
              deployment(OLD_DEPLOYMENT, OLD_VERSION),
            upload: async ({ message }: { message: string }) => {
              uploadMessage = message;
              return { versionId: NEW_VERSION, workerName: "yurucommu" };
            },
            version: async ({ versionId }: { versionId: string }) => {
              if (versionId === OLD_VERSION) return versionDetails(OLD_VERSION);
              const candidate = versionDetails(versionId, uploadMessage);
              if (mismatch === "missing") {
                delete (candidate.resources as Record<string, unknown>).script;
              } else {
                (candidate.resources as Record<string, any>).script = {
                  etag: "0".repeat(64),
                };
              }
              return candidate;
            },
            deployVersion: async () => {
              deploys += 1;
              throw new Error("must not deploy an etag mismatch");
            },
          },
        }).catch((error) => error);

        expect(failureOf(failure).phase, mismatch).toBe(
          "POST_UPLOAD_INDETERMINATE",
        );
        expect(failure.message, mismatch).toContain("script etag");
        expect(deploys, mismatch).toBe(0);
      }
    }));

  test("rejects an annotation-only Version readback instead of treating it as code-only", () =>
    cleanFixture(async ({ repo, target }) => {
      let uploads = 0;
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          version: async ({ versionId }: { versionId: string }) => ({
            id: versionId,
            annotations: { "workers/message": "identity only" },
          }),
          upload: async () => {
            uploads += 1;
            throw new Error("must not upload without closure readback");
          },
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(failure.message).toContain(
        "authoritative non-code Version closure",
      );
      expect(uploads).toBe(0);
    }));

  test("halts before Deployment when authoritative Version closure changes", () =>
    cleanFixture(async ({ repo, target }) => {
      const changed = [
        [
          "bindings",
          (version: ReturnType<typeof versionDetails>) => {
            version.resources.bindings.DB.id = "another-d1";
          },
        ],
        [
          "runtime",
          (version: ReturnType<typeof versionDetails>) => {
            version.resources.script_runtime.compatibility_flags = ["changed"];
          },
        ],
        [
          "limits",
          (version: ReturnType<typeof versionDetails>) => {
            version.resources.script_runtime.limits.cpu_ms = 100;
          },
        ],
        [
          "vars",
          (version: ReturnType<typeof versionDetails>) => {
            version.resources.vars.DELIVERY_QUEUE_NAME = "other-queue";
          },
        ],
      ] as const;

      for (const [label, mutate] of changed) {
        let uploadMessage = "";
        let deploys = 0;
        const failure = await deployYurucommuWorker({
          repo,
          environment: "production",
          commit: COMMIT,
          target,
          git: gitSource(),
          check: async () => {},
          provider: {
            domains: async () => [
              {
                hostname: "test.yurucommu.com",
                service: "yurucommu",
                environment: "production",
              },
            ],
            activeDeployment: async () =>
              deployment(OLD_DEPLOYMENT, OLD_VERSION),
            version: async ({ versionId }: { versionId: string }) => {
              if (versionId === OLD_VERSION) return versionDetails(OLD_VERSION);
              const candidate = versionDetails(versionId, uploadMessage);
              mutate(candidate);
              return candidate;
            },
            upload: async ({ message }: { message: string }) => {
              uploadMessage = message;
              return { versionId: NEW_VERSION, workerName: "yurucommu" };
            },
            deployVersion: async () => {
              deploys += 1;
              throw new Error("must not deploy a changed closure");
            },
          },
        }).catch((error) => error);

        expect(failureOf(failure).phase, label).toBe(
          "POST_UPLOAD_INDETERMINATE",
        );
        expect(failure.message, label).toContain(
          "authoritative non-code closure",
        );
        expect(deploys, label).toBe(0);
      }
    }));

  test("does not deploy when Version readback differs from the upload acknowledgement", () =>
    cleanFixture(async ({ repo, target }) => {
      let uploadMessage = "";
      let deploys = 0;
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          upload: async ({ message }: { message: string }) => {
            uploadMessage = message;
            return { versionId: NEW_VERSION, workerName: "yurucommu" };
          },
          version: async ({ versionId }: { versionId: string }) =>
            versionId === OLD_VERSION
              ? versionDetails(OLD_VERSION)
              : versionDetails(UNSERVED_VERSION, uploadMessage),
          deployVersion: async () => {
            deploys += 1;
            return {
              deploymentId: NEW_DEPLOYMENT,
              workerName: "yurucommu",
            };
          },
          smoke: async () => ({ status: "passed" }),
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("POST_UPLOAD_INDETERMINATE");
      expect(failure.message).toContain("selected source, bundle, and config");
      expect(deploys).toBe(0);
    }));

  test("halts when the active Deployment changes after the Version upload", () =>
    cleanFixture(async ({ repo, target }) => {
      let activeReads = 0;
      let deploys = 0;
      let uploadMessage = "";
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => {
            activeReads += 1;
            return activeReads === 1
              ? deployment(OLD_DEPLOYMENT, OLD_VERSION)
              : deployment(CONCURRENT_DEPLOYMENT, UNSERVED_VERSION);
          },
          upload: async ({ message }: { message: string }) => {
            uploadMessage = message;
            return { versionId: NEW_VERSION, workerName: "yurucommu" };
          },
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(versionId, uploadMessage),
          deployVersion: async () => {
            deploys += 1;
            return {
              deploymentId: NEW_DEPLOYMENT,
              workerName: "yurucommu",
            };
          },
          smoke: async () => ({ status: "passed" }),
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("POST_UPLOAD_INDETERMINATE");
      expect(failure.message).toContain("changed concurrently");
      expect(deploys).toBe(0);
    }));

  test("reports a lost upload acknowledgement without retrying or moving traffic", () =>
    cleanFixture(async ({ repo, target }) => {
      let uploads = 0;
      let deploys = 0;
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          upload: async () => {
            uploads += 1;
            throw new Error("lost upload acknowledgement");
          },
          version: async ({ versionId }: { versionId: string }) => {
            if (versionId === OLD_VERSION) return versionDetails(OLD_VERSION);
            throw new Error("must not inspect an unknown Version");
          },
          deployVersion: async () => {
            deploys += 1;
            throw new Error("must not deploy");
          },
          smoke: async () => ({ status: "passed" }),
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("POST_UPLOAD_INDETERMINATE");
      expect(failure.message).toContain("lost upload acknowledgement");
      expect(uploads).toBe(1);
      expect(deploys).toBe(0);
    }));

  test("reports a lost Deployment acknowledgement without retrying", () =>
    cleanFixture(async ({ repo, target }) => {
      let uploads = 0;
      let deploys = 0;
      let uploadMessage = "";
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          upload: async ({ message }: { message: string }) => {
            uploads += 1;
            uploadMessage = message;
            return { versionId: NEW_VERSION, workerName: "yurucommu" };
          },
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(versionId, uploadMessage),
          deployVersion: async () => {
            deploys += 1;
            throw new Error("lost Deployment acknowledgement");
          },
          smoke: async () => ({ status: "passed" }),
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("POST_DEPLOY_INDETERMINATE");
      expect(failure.message).toContain("lost Deployment acknowledgement");
      expect(uploads).toBe(1);
      expect(deploys).toBe(1);
    }));

  test("does not report PUBLISHED when another Version is serving after deploy", () =>
    cleanFixture(async ({ repo, target }) => {
      let activeReads = 0;
      let uploadMessage = "";
      let deployMessage = "";
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => {
            activeReads += 1;
            if (activeReads <= 2) {
              return deployment(OLD_DEPLOYMENT, OLD_VERSION);
            }
            return deployment(
              CONCURRENT_DEPLOYMENT,
              UNSERVED_VERSION,
              deployMessage,
            );
          },
          upload: async ({ message }: { message: string }) => {
            uploadMessage = message;
            return { versionId: NEW_VERSION, workerName: "yurucommu" };
          },
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(versionId, uploadMessage),
          deployVersion: async ({ message }: { message: string }) => {
            deployMessage = message;
            return {
              deploymentId: NEW_DEPLOYMENT,
              workerName: "yurucommu",
            };
          },
          smoke: async () => ({ status: "passed" }),
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("POST_DEPLOY_INDETERMINATE");
      expect(failure.message).toContain("active Deployment does not match");
      expect(JSON.stringify(failure.evidence)).not.toContain("PUBLISHED");
    }));

  test("does not report PUBLISHED when a concurrent Deployment lands during smoke", () =>
    cleanFixture(async ({ repo, target }) => {
      let activeReads = 0;
      let uploadMessage = "";
      let deployMessage = "";
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => {
            activeReads += 1;
            if (activeReads <= 2) {
              return deployment(OLD_DEPLOYMENT, OLD_VERSION);
            }
            if (activeReads === 3) {
              return deployment(NEW_DEPLOYMENT, NEW_VERSION, deployMessage);
            }
            return deployment(
              CONCURRENT_DEPLOYMENT,
              UNSERVED_VERSION,
              "concurrent release",
            );
          },
          upload: async ({ message }: { message: string }) => {
            uploadMessage = message;
            return { versionId: NEW_VERSION, workerName: "yurucommu" };
          },
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(versionId, uploadMessage),
          deployVersion: async ({ message }: { message: string }) => {
            deployMessage = message;
            return {
              deploymentId: NEW_DEPLOYMENT,
              workerName: "yurucommu",
            };
          },
          smoke: async () => ({ status: "passed" }),
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("POST_CONDITION_INDETERMINATE");
      expect(failure.message).toContain("changed concurrently during smoke");
      expect(activeReads).toBe(4);
    }));

  test("reports the exact predecessor for manual reversal after a failed smoke", () =>
    cleanFixture(async ({ repo, target }) => {
      let activeReads = 0;
      let uploadMessage = "";
      let candidateDeploymentMessage = "";
      const deployedVersions: string[] = [];
      const provider = {
        domains: async () => [
          {
            hostname: "test.yurucommu.com",
            service: "yurucommu",
            environment: "production",
          },
        ],
        activeDeployment: async () => {
          activeReads += 1;
          if (activeReads <= 2) {
            return deployment(OLD_DEPLOYMENT, OLD_VERSION);
          }
          if (activeReads <= 4) {
            return deployment(
              NEW_DEPLOYMENT,
              NEW_VERSION,
              candidateDeploymentMessage,
            );
          }
          return deployment(
            NEW_DEPLOYMENT,
            NEW_VERSION,
            candidateDeploymentMessage,
          );
        },
        upload: async ({ message }: { message: string }) => {
          uploadMessage = message;
          return { versionId: NEW_VERSION, workerName: "yurucommu" };
        },
        version: async ({ versionId }: { versionId: string }) =>
          versionDetails(versionId, uploadMessage),
        deployVersion: async ({
          versionId,
          message,
        }: {
          versionId: string;
          message: string;
        }) => {
          deployedVersions.push(versionId);
          if (versionId === NEW_VERSION) {
            candidateDeploymentMessage = message;
            return {
              deploymentId: NEW_DEPLOYMENT,
              workerName: "yurucommu",
            };
          }
          throw new Error("automatic rollback must not be attempted");
        },
        smoke: async () => {
          throw new Error("real request path failed");
        },
      };

      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider,
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("POST_CONDITION_INDETERMINATE");
      expect(deployedVersions).toEqual([NEW_VERSION]);
      expect(failure.evidence).toMatchObject({
        previousVersionId: OLD_VERSION,
        manualReversal: {
          deploymentId: OLD_DEPLOYMENT,
          versionId: OLD_VERSION,
        },
      });
      expect(activeReads).toBe(4);
    }));

  test("does not overwrite a concurrent Deployment while handling a failed smoke", () =>
    cleanFixture(async ({ repo, target }) => {
      let activeReads = 0;
      let uploadMessage = "";
      let deployMessage = "";
      const deployedVersions: string[] = [];
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => {
            activeReads += 1;
            if (activeReads <= 2) {
              return deployment(OLD_DEPLOYMENT, OLD_VERSION);
            }
            if (activeReads === 3) {
              return deployment(NEW_DEPLOYMENT, NEW_VERSION, deployMessage);
            }
            return deployment(
              CONCURRENT_DEPLOYMENT,
              UNSERVED_VERSION,
              "concurrent release",
            );
          },
          upload: async ({ message }: { message: string }) => {
            uploadMessage = message;
            return { versionId: NEW_VERSION, workerName: "yurucommu" };
          },
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(versionId, uploadMessage),
          deployVersion: async ({
            versionId,
            message,
          }: {
            versionId: string;
            message: string;
          }) => {
            deployedVersions.push(versionId);
            deployMessage = message;
            return {
              deploymentId: NEW_DEPLOYMENT,
              workerName: "yurucommu",
            };
          },
          smoke: async () => {
            throw new Error("real request path failed");
          },
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("POST_CONDITION_INDETERMINATE");
      expect(failure.message).toContain("no rollback was attempted");
      expect(deployedVersions).toEqual([NEW_VERSION]);
      expect(activeReads).toBe(4);
    }));

  test("loads one absolute digest-pinned production target descriptor", () =>
    cleanFixture(async ({ repo, privateDir, target }) => {
      const descriptorPath = join(repo, "production-target.json");
      await writeFile(descriptorPath, `${JSON.stringify(target, null, 2)}\n`);

      expect(() =>
        loadYurucommuWorkerTarget({
          environment: "production",
          path: descriptorPath,
        }),
      ).toThrow("0600");
      await chmod(descriptorPath, 0o600);

      expect(() =>
        loadYurucommuWorkerTarget({
          environment: "production",
          path: descriptorPath,
          repo,
        }),
      ).toThrow("outside the repository");

      const privateDescriptorPath = join(privateDir, "production-target.json");
      await writeFile(
        privateDescriptorPath,
        `${JSON.stringify(target, null, 2)}\n`,
        { mode: 0o600 },
      );

      const loaded = loadYurucommuWorkerTarget({
        environment: "production",
        path: privateDescriptorPath,
        repo,
      });

      expect(loaded).toMatchObject(target);
      expect(loaded).not.toHaveProperty("configBytes");
      expect(() =>
        loadYurucommuWorkerTarget({
          environment: "production",
          path: "relative-target.json",
        }),
      ).toThrow("absolute");

      await chmod(target.config.path, 0o644);
      expect(() =>
        loadYurucommuWorkerTarget({
          environment: "production",
          path: privateDescriptorPath,
          repo,
        }),
      ).toThrow("0600");
    }));

  test("rejects private target descriptors discovered inside any Git repository or linked worktree", () =>
    cleanFixture(async ({ repo, privateDir, target }) => {
      const repositoryDir = join(privateDir, "other-repository");
      await mkdir(join(repositoryDir, ".git"), { recursive: true });
      await chmod(repositoryDir, 0o700);
      const repositoryDescriptor = join(repositoryDir, "target.json");
      await writeFile(repositoryDescriptor, `${JSON.stringify(target)}\n`, {
        mode: 0o600,
      });
      expect(() =>
        loadYurucommuWorkerTarget({
          environment: "production",
          path: repositoryDescriptor,
          repo,
        }),
      ).toThrow("Git repository");

      const linkedWorktreeDir = join(privateDir, "linked-worktree");
      await mkdir(linkedWorktreeDir, { recursive: true });
      await chmod(linkedWorktreeDir, 0o700);
      await writeFile(
        join(linkedWorktreeDir, ".git"),
        "gitdir: /tmp/other-repository/.git/worktrees/linked-worktree\n",
      );
      const linkedDescriptor = join(linkedWorktreeDir, "target.json");
      await writeFile(linkedDescriptor, `${JSON.stringify(target)}\n`, {
        mode: 0o600,
      });
      expect(() =>
        loadYurucommuWorkerTarget({
          environment: "production",
          path: linkedDescriptor,
          repo,
        }),
      ).toThrow("Git repository");

      const commonDir = join(privateDir, "external-git-common");
      await mkdir(commonDir, { recursive: true });
      await chmod(commonDir, 0o700);
      await writeFile(join(repo, ".git"), `gitdir: ${commonDir}\n`);
      const commonDescriptor = join(commonDir, "target.json");
      await writeFile(commonDescriptor, `${JSON.stringify(target)}\n`, {
        mode: 0o600,
      });
      expect(() =>
        loadYurucommuWorkerTarget({
          environment: "production",
          path: commonDescriptor,
          repo,
        }),
      ).toThrow("outside the repository");
    }));

  test("uses Cloudflare's current API shape with one-request Version and Deployment writes", () =>
    cleanFixture(async ({ repo, target }) => {
      const apiCalls: string[] = [];
      let writeCalls = 0;
      const fetcher = async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        apiCalls.push(url);
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer test-token",
          Accept: "application/json",
        });
        const method = init?.method ?? "GET";
        if (method === "POST") writeCalls += 1;
        if (method === "GET" && url.includes("/workers/domains?")) {
          const query = new URL(url).searchParams;
          expect(query.get("hostname")).toBe("test.yurucommu.com");
          expect(query.get("service")).toBe("yurucommu");
          expect(query.get("environment")).toBe("production");
          expect(query.get("page")).toBe("1");
          expect(query.get("per_page")).toBe("100");
          return Response.json({
            success: true,
            result: [
              {
                hostname: "test.yurucommu.com",
                service: "yurucommu",
                environment: "production",
              },
            ],
            result_info: { page: 1, per_page: 100, total_pages: 1 },
          });
        }
        if (method === "GET" && url.endsWith("/deployments")) {
          return Response.json({
            success: true,
            result: {
              deployments: [deployment(OLD_DEPLOYMENT, OLD_VERSION)],
            },
          });
        }
        if (method === "GET" && url.endsWith(`/versions/${NEW_VERSION}`)) {
          return Response.json({
            success: true,
            result: versionDetails(NEW_VERSION, "candidate identity"),
          });
        }
        if (
          method === "POST" &&
          url.endsWith(
            `/accounts/${ACCOUNT_ID}/workers/scripts/yurucommu/versions?bindings_inherit=strict`,
          )
        ) {
          const form = init?.body as FormData;
          const metadata = JSON.parse(
            await (form.get("metadata") as Blob).text(),
          );
          expect(metadata).toMatchObject({
            main_module: "worker.mjs",
            compatibility_date: "2026-07-16",
            annotations: { "workers/message": "candidate identity" },
          });
          expect(metadata.bindings).toEqual([
            { name: "DB", type: "inherit", version_id: OLD_VERSION },
            {
              name: "DELIVERY_QUEUE",
              type: "inherit",
              version_id: OLD_VERSION,
            },
          ]);
          expect(metadata.bindings).not.toContainEqual(
            expect.objectContaining({ version_id: UNSERVED_VERSION }),
          );
          expect(await (form.get("worker.mjs") as Blob).text()).toBe(
            "candidate",
          );
          return Response.json({
            success: true,
            result: { id: NEW_VERSION },
          });
        }
        if (
          method === "POST" &&
          url.endsWith(
            `/accounts/${ACCOUNT_ID}/workers/scripts/yurucommu/deployments`,
          )
        ) {
          expect(init?.headers).toMatchObject({
            "Content-Type": "application/json",
          });
          expect(JSON.parse(String(init?.body))).toEqual({
            strategy: "percentage",
            versions: [{ version_id: NEW_VERSION, percentage: 100 }],
            annotations: { "workers/message": "deployment identity" },
          });
          return Response.json({
            success: true,
            result: deployment(
              NEW_DEPLOYMENT,
              NEW_VERSION,
              "deployment identity",
            ),
          });
        }
        throw new Error(`unexpected Cloudflare request ${method} ${url}`);
      };
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher,
        runSmoke: async () => ({
          exitCode: 0,
          stdout: `${JSON.stringify({
            kind: "takosumi.capsule-functional-probe@v1",
            status: "passed",
            product: "yurucommu",
            cleanupVerified: true,
          })}\n`,
          stderr: "",
        }),
      });

      expect(await provider.domains()).toHaveLength(1);
      expect(await provider.activeDeployment()).toMatchObject({
        id: OLD_DEPLOYMENT,
      });
      expect(await provider.version({ versionId: NEW_VERSION })).toMatchObject({
        id: NEW_VERSION,
      });
      expect(
        await provider.upload({
          target,
          bundleBytes: Buffer.from("candidate"),
          configBytes: await readFile(target.config.path),
          previousVersion: versionDetails(OLD_VERSION),
          message: "candidate identity",
        }),
      ).toEqual({
        versionId: NEW_VERSION,
        workerName: "yurucommu",
      });
      expect(
        await provider.deployVersion({
          target,
          versionId: NEW_VERSION,
          message: "deployment identity",
        }),
      ).toEqual({
        deploymentId: NEW_DEPLOYMENT,
        workerName: "yurucommu",
      });
      expect(await provider.smoke({ target })).toMatchObject({
        status: "passed",
        cleanupVerified: true,
      });

      expect(apiCalls).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `/accounts/${ACCOUNT_ID}/workers/scripts/yurucommu/deployments`,
          ),
          expect.stringContaining(
            `/accounts/${ACCOUNT_ID}/workers/scripts/yurucommu/versions/${NEW_VERSION}`,
          ),
        ]),
      );
      expect(writeCalls).toBe(2);
    }));

  test("does not retry a lost Cloudflare Version upload acknowledgement", () =>
    cleanFixture(async ({ repo, target }) => {
      let requests = 0;
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async () => {
          requests += 1;
          throw new Error("lost Version upload acknowledgement");
        },
      });

      await expect(
        provider.upload({
          target,
          bundleBytes: Buffer.from("candidate"),
          configBytes: await readFile(target.config.path),
          previousVersion: versionDetails(OLD_VERSION),
          message: "candidate identity",
        }),
      ).rejects.toThrow("lost Version upload acknowledgement");
      expect(requests).toBe(1);
    }));

  test("reads exact custom-domain filters across bounded pages and proves a stable snapshot", () =>
    cleanFixture(async ({ repo, target }) => {
      const domain = {
        hostname: "test.yurucommu.com",
        service: "yurucommu",
        environment: "production",
      };
      let requests = 0;
      const fetcher = async (input: string | URL) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("hostname")).toBe("test.yurucommu.com");
        expect(url.searchParams.get("service")).toBe("yurucommu");
        expect(url.searchParams.get("environment")).toBe("production");
        expect(url.searchParams.get("per_page")).toBe("100");
        const page = Number(url.searchParams.get("page"));
        requests += 1;
        if (page === 1) {
          return Response.json({
            success: true,
            result: [],
            result_info: { page: 1, per_page: 100, total_pages: 2 },
          });
        }
        expect(page).toBe(2);
        return Response.json({
          success: true,
          result: [domain],
          result_info: { page: 2, per_page: 100, total_pages: 2 },
        });
      };
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher,
      });

      await expect(provider.domains()).resolves.toEqual([domain]);
      expect(requests).toBe(4);
    }));

  test("rejects a custom-domain inventory that changes between bounded snapshots", () =>
    cleanFixture(async ({ repo, target }) => {
      let requests = 0;
      const fetcher = async (input: string | URL) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get("page"));
        requests += 1;
        if (page === 1) {
          return Response.json({
            success: true,
            result: [],
            result_info: { page: 1, per_page: 100, total_pages: 2 },
          });
        }
        return Response.json({
          success: true,
          result:
            requests <= 2
              ? [
                  {
                    hostname: "test.yurucommu.com",
                    service: "yurucommu",
                    environment: "production",
                  },
                ]
              : [],
          result_info: { page: 2, per_page: 100, total_pages: 2 },
        });
      };
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher,
      });

      await expect(provider.domains()).rejects.toThrow(
        "custom-domain inventory changed",
      );
      expect(requests).toBe(4);
    }));

  test("does not pass provider, smoke, or target credentials into the owner gate subprocess", () =>
    cleanFixture(async ({ repo, privateDir, target }) => {
      const capturePath = join(privateDir, "owner-gate-env.txt");
      const binDir = join(privateDir, "bin");
      await mkdir(binDir, { recursive: true });
      await chmod(binDir, 0o700);
      const fakeBun = join(binDir, "bun");
      await writeFile(
        fakeBun,
        `#!/bin/sh\n/usr/bin/env > ${JSON.stringify(capturePath)}\n`,
        { mode: 0o700 },
      );
      await chmod(fakeBun, 0o700);

      const original = {
        PATH: process.env.PATH,
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
        YURUCOMMU_E2E_PASSWORD: process.env.YURUCOMMU_E2E_PASSWORD,
        YURUCOMMU_WORKER_DEPLOY_TARGET:
          process.env.YURUCOMMU_WORKER_DEPLOY_TARGET,
      };
      process.env.PATH = `${binDir}:${original.PATH ?? ""}`;
      process.env.CLOUDFLARE_API_TOKEN = "token-presence-only";
      process.env.YURUCOMMU_E2E_PASSWORD = "password-presence-only";
      process.env.YURUCOMMU_WORKER_DEPLOY_TARGET = target.config.path;
      try {
        await deployYurucommuWorker({
          repo,
          environment: "production",
          commit: COMMIT,
          target,
          git: gitSource(),
          provider: {
            domains: async () => [
              {
                hostname: "test.yurucommu.com",
                service: "yurucommu",
                environment: "production",
              },
            ],
            activeDeployment: async () =>
              deployment(OLD_DEPLOYMENT, OLD_VERSION),
            version: async ({ versionId }: { versionId: string }) =>
              versionDetails(versionId),
            upload: async () => {
              throw new Error("stop after owner gate");
            },
          },
        }).catch(() => undefined);
      } finally {
        for (const [name, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }

      const captured = await readFile(capturePath, "utf8");
      for (const name of [
        "CLOUDFLARE_API_TOKEN",
        "YURUCOMMU_E2E_PASSWORD",
        "YURUCOMMU_WORKER_DEPLOY_TARGET",
        "YURUCOMMU_WRANGLER_CONFIG",
      ]) {
        expect(captured).not.toContain(`${name}=`);
      }
      expect(ownerGateEnvironment().CLOUDFLARE_API_TOKEN).toBeUndefined();
    }));

  test("does not pass provider, smoke, or private-path credentials into default git subprocesses", () =>
    cleanFixture(async ({ repo, privateDir, target }) => {
      const capturePath = join(privateDir, "git-env.txt");
      const binDir = join(privateDir, "bin");
      await mkdir(binDir, { recursive: true });
      await chmod(binDir, 0o700);
      const fakeGit = join(binDir, "git");
      await writeFile(
        fakeGit,
        `#!/bin/sh\n/usr/bin/env > ${JSON.stringify(capturePath)}\nexit 1\n`,
        { mode: 0o700 },
      );
      await chmod(fakeGit, 0o700);

      const original = {
        PATH: process.env.PATH,
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
        YURUCOMMU_E2E_PASSWORD: process.env.YURUCOMMU_E2E_PASSWORD,
        YURUCOMMU_WORKER_DEPLOY_TARGET:
          process.env.YURUCOMMU_WORKER_DEPLOY_TARGET,
        YURUCOMMU_WRANGLER_CONFIG: process.env.YURUCOMMU_WRANGLER_CONFIG,
      };
      process.env.PATH = `${binDir}:${original.PATH ?? ""}`;
      process.env.CLOUDFLARE_API_TOKEN = "token-presence-only";
      process.env.YURUCOMMU_E2E_PASSWORD = "password-presence-only";
      process.env.YURUCOMMU_WORKER_DEPLOY_TARGET = target.config.path;
      process.env.YURUCOMMU_WRANGLER_CONFIG = target.config.path;
      try {
        await deployYurucommuWorker({
          repo,
          environment: "production",
          commit: COMMIT,
          target,
          check: async () => {
            throw new Error("owner gate must not run after git failure");
          },
          provider: {
            upload: async () => {
              throw new Error("must not upload");
            },
          },
        }).catch(() => undefined);
      } finally {
        for (const [name, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }

      const captured = await readFile(capturePath, "utf8");
      for (const name of [
        "CLOUDFLARE_API_TOKEN",
        "YURUCOMMU_E2E_PASSWORD",
        "YURUCOMMU_WORKER_DEPLOY_TARGET",
        "YURUCOMMU_WRANGLER_CONFIG",
      ]) {
        expect(captured).not.toContain(`${name}=`);
      }
    }));
});
