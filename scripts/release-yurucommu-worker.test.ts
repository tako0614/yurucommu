import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
import { MEDIA_DELETION_SCHEMA_QUERY } from "./media-deletion-schema.mjs";

const COMMIT = "c".repeat(40);
const REMOTE_MAIN = "d".repeat(40);
const ACCOUNT_ID = "a".repeat(32);
const D1_DATABASE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION_HASH_SALT_BINDING = "YURUCOMMU_SESSION_HASH_SALT";
const MEDIA_DELETION_SCHEMA_QUALIFICATION = {
  kind: "yurucommu.core-media-deletion-schema@v1" as const,
  table: "media_blob_deletion_jobs" as const,
  index: "media_blob_deletion_jobs_due_idx" as const,
  scope: "migration-0030-only" as const,
};
const OLD_VERSION = "11111111-1111-4111-8111-111111111111";
const UNSERVED_VERSION = "22222222-2222-4222-8222-222222222222";
const NEW_VERSION = "33333333-3333-4333-8333-333333333333";
const OLD_DEPLOYMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEW_DEPLOYMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONCURRENT_DEPLOYMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BUNDLE = "export default { fetch() { return new Response('ok') } };\n";
const BUNDLE_ETAG = "opaque-worker-etag-not-a-script-hash";

const VERSION_CLOSURE = {
  bindings: {
    DB: { type: "d1", id: D1_DATABASE_ID },
    DELIVERY_QUEUE: { type: "queue", queue_name: "delivery" },
    [SESSION_HASH_SALT_BINDING]: { type: "secret_text" },
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

function sha256(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function codeProof({
  versionId,
  bundleDigest,
  bundleByteLength,
}: {
  versionId: string;
  bundleDigest: `sha256:${string}`;
  bundleByteLength: number;
}) {
  expect(versionId).toBe(NEW_VERSION);
  expect(bundleDigest).toBe(sha256(BUNDLE));
  expect(bundleByteLength).toBe(Buffer.byteLength(BUNDLE));
  return {
    kind: "yurucommu.worker-version-code@v1" as const,
    versionId,
    sha256: bundleDigest,
    size: bundleByteLength,
  };
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

function moduleContentResponse(
  content: string | Uint8Array,
  {
    entrypoint = "worker.mjs",
    partName = "worker.mjs",
    filename = "worker.mjs",
    mediaType = "application/javascript+module",
    extraPart = false,
    status = 200,
  }: {
    entrypoint?: string;
    partName?: string;
    filename?: string;
    mediaType?: string;
    extraPart?: boolean;
    status?: number;
  } = {},
) {
  const boundary = "yurucommu-version-content-test";
  const moduleBytes = Buffer.from(content);
  const firstHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${partName}"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`,
  );
  const additional = extraPart
    ? Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="other.mjs"; filename="other.mjs"\r\nContent-Type: application/javascript+module\r\n\r\nexport default {};`,
      )
    : Buffer.alloc(0);
  return new Response(
    Buffer.concat([
      firstHeader,
      moduleBytes,
      additional,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    {
      status,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "cf-entrypoint": entrypoint,
      },
    },
  );
}

async function mediaDeletionMetadataRows() {
  const database = new Database(":memory:");
  try {
    const migration = await readFile(
      new URL(
        "../deploy/takoform/migrations/sql/0030_media_blob_deletion_jobs.sql",
        import.meta.url,
      ),
      "utf8",
    );
    database.exec(migration);
    return database.query(MEDIA_DELETION_SCHEMA_QUERY).all();
  } finally {
    database.close();
  }
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
            assertVersionCode: codeProof,
            assertMediaDeletionSchema: async ({
              databaseId,
            }: {
              databaseId: string;
            }) => {
              expect(databaseId).toBe(D1_DATABASE_ID);
              return MEDIA_DELETION_SCHEMA_QUALIFICATION;
            },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
            assertVersionCode: codeProof,
            assertMediaDeletionSchema: async ({
              databaseId,
            }: {
              databaseId: string;
            }) => {
              expect(databaseId).toBe(D1_DATABASE_ID);
              return MEDIA_DELETION_SCHEMA_QUALIFICATION;
            },
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
      let codeReads = 0;
      const uploadSequence: string[] = [];
      let uploadMessage = "";
      let deployMessage = "";
      const provider = {
        assertVersionCode: async (input: Parameters<typeof codeProof>[0]) => {
          codeReads += 1;
          return codeProof(input);
        },
        assertMediaDeletionSchema: async ({
          databaseId,
        }: {
          databaseId: string;
        }) => {
          uploadSequence.push("schema");
          expect(databaseId).toBe(D1_DATABASE_ID);
          return MEDIA_DELETION_SCHEMA_QUALIFICATION;
        },
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
        version: async ({ versionId }: { versionId: string }) => {
          const version = versionDetails(versionId, uploadMessage);
          return {
            ...version,
            resources: {
              ...version.resources,
              bindings: Object.entries(
                structuredClone(VERSION_CLOSURE.bindings),
              ).map(([name, binding]) => ({ name, ...binding })),
            },
          };
        },
        upload: async ({ message }: { message: string }) => {
          uploadSequence.push("upload");
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
          uploadSequence.push("deploy");
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
        providerReadback:
          "EXACT_ACTIVE_DEPLOYMENT_VERSION_METADATA_AND_CODE_BYTES",
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
      expect(codeReads).toBe(3);
      expect(uploadSequence).toEqual(["schema", "upload", "deploy"]);
    }));

  test("refuses a provider without exact Version code readback before upload", () =>
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
          upload: async () => {
            uploads += 1;
            throw new Error("must not upload without byte proof");
          },
        },
      }).catch((error: unknown) => error);
      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect((failure as Error).message).toContain(
        "missing the required exact Version code readback",
      );
      expect(uploads).toBe(0);
    }));

  test("rejects an invalid Version code proof after one upload and before promotion", () =>
    cleanFixture(async ({ repo, target }) => {
      for (const variant of ["digest", "version", "size", "extra"] as const) {
        let uploads = 0;
        let deploys = 0;
        let uploadMessage = "";
        const provider = {
          assertVersionCode: async (input: Parameters<typeof codeProof>[0]) => {
            const proof = await codeProof(input);
            if (variant === "digest")
              return { ...proof, sha256: sha256("different") };
            if (variant === "version")
              return { ...proof, versionId: UNSERVED_VERSION };
            if (variant === "size") return { ...proof, size: proof.size + 1 };
            return { ...proof, unexpected: true };
          },
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(
              versionId,
              versionId === OLD_VERSION ? "previous" : uploadMessage,
            ),
          assertMediaDeletionSchema: async () =>
            MEDIA_DELETION_SCHEMA_QUALIFICATION,
          upload: async ({ message }: { message: string }) => {
            uploads += 1;
            uploadMessage = message;
            return { versionId: NEW_VERSION, workerName: "yurucommu" };
          },
          deployVersion: async () => {
            deploys += 1;
            throw new Error("must not promote an invalid code proof");
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
        }).catch((error: unknown) => error);
        expect(failureOf(failure).phase, variant).toBe(
          "POST_UPLOAD_INDETERMINATE",
        );
        expect((failure as Error).message, variant).toContain(
          "did not prove the selected bundle bytes",
        );
        expect(uploads, variant).toBe(1);
        expect(deploys, variant).toBe(0);
      }
    }));

  test("requires the code proof again immediately before promotion and after smoke", () =>
    cleanFixture(async ({ repo, target }) => {
      for (const failedRead of [2, 3]) {
        let codeReads = 0;
        let activeReads = 0;
        let deploys = 0;
        let smokes = 0;
        let uploadMessage = "";
        let deployMessage = "";
        const provider = {
          assertVersionCode: async (input: Parameters<typeof codeProof>[0]) => {
            codeReads += 1;
            if (codeReads === failedRead) {
              throw new Error("selected Version code bytes changed");
            }
            return codeProof(input);
          },
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => {
            activeReads += 1;
            return activeReads <= 2
              ? deployment(OLD_DEPLOYMENT, OLD_VERSION)
              : deployment(NEW_DEPLOYMENT, NEW_VERSION, deployMessage);
          },
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(
              versionId,
              versionId === OLD_VERSION ? "previous" : uploadMessage,
            ),
          assertMediaDeletionSchema: async () =>
            MEDIA_DELETION_SCHEMA_QUALIFICATION,
          upload: async ({ message }: { message: string }) => {
            uploadMessage = message;
            return { versionId: NEW_VERSION, workerName: "yurucommu" };
          },
          deployVersion: async ({ message }: { message: string }) => {
            deploys += 1;
            deployMessage = message;
            return { deploymentId: NEW_DEPLOYMENT, workerName: "yurucommu" };
          },
          smoke: async () => {
            smokes += 1;
            return { status: "passed" };
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
        }).catch((error: unknown) => error);
        expect(failureOf(failure).phase).toBe(
          failedRead === 2
            ? "POST_UPLOAD_INDETERMINATE"
            : "POST_CONDITION_INDETERMINATE",
        );
        expect((failure as Error).message).toContain(
          "selected Version code bytes changed",
        );
        expect(codeReads).toBe(failedRead);
        expect(deploys).toBe(failedRead === 2 ? 0 : 1);
        expect(smokes).toBe(failedRead === 2 ? 0 : 1);
        expect(JSON.stringify(failureOf(failure).evidence)).not.toContain(
          "PUBLISHED",
        );
      }
    }));

  test("requires exactly one UUID D1 DB binding on the active Version before schema query or upload", () =>
    cleanFixture(async ({ repo, target }) => {
      const validSalt = { type: "secret_text" };
      const invalidCases = [
        { bindings: { [SESSION_HASH_SALT_BINDING]: validSalt } },
        {
          bindings: {
            DB: { type: "kv", id: D1_DATABASE_ID },
            [SESSION_HASH_SALT_BINDING]: validSalt,
          },
        },
        {
          bindings: {
            DB: { type: "d1", id: "not-a-database-uuid" },
            [SESSION_HASH_SALT_BINDING]: validSalt,
          },
        },
        {
          bindings: [
            { name: "DB", type: "d1", id: D1_DATABASE_ID },
            { name: "DB", type: "d1", id: D1_DATABASE_ID },
            { name: SESSION_HASH_SALT_BINDING, type: "secret_text" },
          ],
        },
      ];

      for (const { bindings } of invalidCases) {
        let schemaChecks = 0;
        let uploads = 0;
        let deployments = 0;
        const previousVersion = versionDetails(OLD_VERSION);
        const activeVersion = {
          ...previousVersion,
          resources: {
            ...previousVersion.resources,
            bindings,
          },
        };
        const failure = await deployYurucommuWorker({
          repo,
          environment: "production",
          commit: COMMIT,
          target,
          git: gitSource(),
          check: async () => {},
          provider: {
            assertVersionCode: codeProof,
            domains: async () => [
              {
                hostname: "test.yurucommu.com",
                service: "yurucommu",
                environment: "production",
              },
            ],
            activeDeployment: async () =>
              deployment(OLD_DEPLOYMENT, OLD_VERSION),
            version: async () => activeVersion,
            assertMediaDeletionSchema: async () => {
              schemaChecks += 1;
              return MEDIA_DELETION_SCHEMA_QUALIFICATION;
            },
            upload: async () => {
              uploads += 1;
              throw new Error("invalid DB binding must block upload");
            },
            deployVersion: async () => {
              deployments += 1;
              throw new Error("invalid DB binding must block deployment");
            },
          },
        }).catch((error) => error);

        expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
        expect(failure.message).toMatch(/DB binding|database id/u);
        expect(schemaChecks).toBe(0);
        expect(uploads).toBe(0);
        expect(deployments).toBe(0);
      }
    }));

  test("requires one inherited secret_text session salt before schema query or upload", () =>
    cleanFixture(async ({ repo, target }) => {
      const { [SESSION_HASH_SALT_BINDING]: _salt, ...bindingsWithoutSalt } =
        VERSION_CLOSURE.bindings;
      const validSaltEntry = {
        name: SESSION_HASH_SALT_BINDING,
        type: "secret_text",
      };
      const invalidCases = [
        {
          label: "missing",
          bindings: bindingsWithoutSalt,
        },
        {
          label: "duplicate array name",
          bindings: [
            ...Object.entries(bindingsWithoutSalt).map(([name, binding]) => ({
              name,
              ...binding,
            })),
            validSaltEntry,
            validSaltEntry,
          ],
        },
        {
          label: "plaintext variable",
          bindings: bindingsWithoutSalt,
          vars: {
            ...VERSION_CLOSURE.vars,
            [SESSION_HASH_SALT_BINDING]: "must-not-count-as-a-secret-binding",
          },
        },
        {
          label: "wrong binding kind",
          bindings: {
            ...VERSION_CLOSURE.bindings,
            [SESSION_HASH_SALT_BINDING]: { type: "plain_text" },
          },
        },
        {
          label: "null array element",
          bindings: [
            ...Object.entries(VERSION_CLOSURE.bindings).map(
              ([name, binding]) => ({
                name,
                ...binding,
              }),
            ),
            null,
          ],
        },
        {
          label: "array metadata value",
          bindings: {
            ...bindingsWithoutSalt,
            [SESSION_HASH_SALT_BINDING]: [{ type: "secret_text" }],
          },
        },
        {
          label: "primitive array element",
          bindings: [
            ...Object.entries(VERSION_CLOSURE.bindings).map(
              ([name, binding]) => ({
                name,
                ...binding,
              }),
            ),
            SESSION_HASH_SALT_BINDING,
          ],
        },
      ];

      for (const { label, bindings, vars } of invalidCases) {
        let schemaChecks = 0;
        let uploads = 0;
        let deployments = 0;
        const previousVersion = versionDetails(OLD_VERSION);
        const activeVersion = {
          ...previousVersion,
          resources: {
            ...previousVersion.resources,
            bindings,
            ...(vars === undefined ? {} : { vars }),
          },
        };
        const failure = await deployYurucommuWorker({
          repo,
          environment: "production",
          commit: COMMIT,
          target,
          git: gitSource(),
          check: async () => {},
          provider: {
            assertVersionCode: codeProof,
            domains: async () => [
              {
                hostname: "test.yurucommu.com",
                service: "yurucommu",
                environment: "production",
              },
            ],
            activeDeployment: async () =>
              deployment(OLD_DEPLOYMENT, OLD_VERSION),
            version: async () => activeVersion,
            assertMediaDeletionSchema: async () => {
              schemaChecks += 1;
              return MEDIA_DELETION_SCHEMA_QUALIFICATION;
            },
            upload: async () => {
              uploads += 1;
              throw new Error("invalid session salt binding must block upload");
            },
            deployVersion: async () => {
              deployments += 1;
              throw new Error(
                "invalid session salt binding must block deployment",
              );
            },
          },
        }).catch((error) => error);

        expect(failureOf(failure).phase, label).toBe("PRE_UPLOAD_FAILURE");
        expect(failure.message, label).toContain(
          "YURUCOMMU_SESSION_HASH_SALT secret_text binding",
        );
        expect(failure.message, label).toContain("operator review");
        expect(failure.message, label).toContain("log in again");
        expect(schemaChecks, label).toBe(0);
        expect(uploads, label).toBe(0);
        expect(deployments, label).toBe(0);
      }
    }));

  test("fails closed when an injected provider omits the required schema check", () =>
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
          assertVersionCode: codeProof,
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(versionId),
          upload: async () => {
            uploads += 1;
            throw new Error("missing schema check must block upload");
          },
        },
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(failure.message).toContain(
        "missing the required read-only migration 0030 D1 preflight",
      );
      expect(uploads).toBe(0);
    }));

  test("keeps D1 permission denial as PRE_UPLOAD_FAILURE without leaking token or smoke password", () =>
    cleanFixture(async ({ repo, target }) => {
      const apiToken = "known-cloudflare-test-token";
      const smokePassword = `${apiToken}"\\known-yurucommu-smoke-password`;
      const deniedProvider = createCloudflareWorkerProvider({
        repo,
        target,
        token: apiToken,
        smokePassword,
        fetcher: async (input) => {
          expect(String(input)).toBe(
            `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
          );
          return Response.json(
            {
              success: false,
              errors: [
                {
                  code: 10000,
                  message: `D1 Read denied for ${apiToken} and ${smokePassword}`,
                },
              ],
            },
            { status: 403 },
          );
        },
      });
      let uploads = 0;
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          assertVersionCode: codeProof,
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(versionId),
          assertMediaDeletionSchema: ({ databaseId }) =>
            deniedProvider.assertMediaDeletionSchema({ databaseId }),
          upload: async () => {
            uploads += 1;
            throw new Error("D1 permission denial must block upload");
          },
        },
      }).catch((error) => error);

      const releaseFailure = failureOf(failure);
      expect(releaseFailure.phase).toBe("PRE_UPLOAD_FAILURE");
      expect(releaseFailure.message).toContain("HTTP 403");
      expect(releaseFailure.provider?.stderr).toContain("D1 Read denied");
      expect(releaseFailure.provider?.stderr).not.toContain(apiToken);
      expect(releaseFailure.provider?.stderr).not.toContain(smokePassword);
      expect(releaseFailure.provider?.stderr).not.toContain(
        JSON.stringify(smokePassword).slice(1, -1),
      );
      expect(uploads).toBe(0);

      const badPrimaryKeyRows = (await mediaDeletionMetadataRows()).map(
        (row) => {
          const metadata = row as Record<string, unknown>;
          return metadata.kind === "column" && metadata.name === "r2_key"
            ? { ...metadata, position: 0 }
            : metadata;
        },
      );
      const wrongSchemaProvider = createCloudflareWorkerProvider({
        repo,
        target,
        token: apiToken,
        smokePassword,
        fetcher: async () =>
          Response.json({
            success: true,
            result: [
              {
                success: true,
                results: badPrimaryKeyRows,
                meta: { changed_db: false, rows_written: 0 },
              },
            ],
          }),
      });
      let wrongSchemaUploads = 0;
      const wrongSchemaFailure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider: {
          assertVersionCode: codeProof,
          domains: async () => [
            {
              hostname: "test.yurucommu.com",
              service: "yurucommu",
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          version: async ({ versionId }: { versionId: string }) =>
            versionDetails(versionId),
          assertMediaDeletionSchema: ({ databaseId }) =>
            wrongSchemaProvider.assertMediaDeletionSchema({ databaseId }),
          upload: async () => {
            wrongSchemaUploads += 1;
            throw new Error("wrong primary key must block upload");
          },
        },
      }).catch((error) => error);
      const wrongSchemaReleaseFailure = failureOf(wrongSchemaFailure);
      expect(wrongSchemaReleaseFailure.phase).toBe("PRE_UPLOAD_FAILURE");
      expect(wrongSchemaReleaseFailure.message).toContain(
        "columns or primary key",
      );
      expect(wrongSchemaReleaseFailure.provider?.stderr).not.toContain(
        apiToken,
      );
      expect(wrongSchemaReleaseFailure.provider?.stderr).not.toContain(
        smokePassword,
      );
      expect(wrongSchemaUploads).toBe(0);
    }));

  test("redacts known credentials from thrown fetch and invalid-success diagnostics", () =>
    cleanFixture(async ({ repo, target }) => {
      const apiToken = "known-cloudflare-test-token";
      const smokePassword = `${apiToken}"\\known-yurucommu-smoke-password`;
      const fetchFailureProvider = createCloudflareWorkerProvider({
        repo,
        target,
        token: apiToken,
        smokePassword,
        fetcher: async () => {
          throw new Error(`fetch failed for ${apiToken} with ${smokePassword}`);
        },
      });
      const fetchFailure = await fetchFailureProvider
        .assertMediaDeletionSchema({ databaseId: D1_DATABASE_ID })
        .catch((error) => error);
      expect(fetchFailure.message).toContain("fetch failed for [REDACTED]");
      expect(fetchFailure.message).not.toContain(apiToken);
      expect(fetchFailure.message).not.toContain(smokePassword);

      const malformedProvider = createCloudflareWorkerProvider({
        repo,
        target,
        token: apiToken,
        smokePassword,
        fetcher: async () =>
          Response.json({
            success: true,
            diagnostic: `${apiToken} ${smokePassword}`,
            result: [{ success: true, results: [], meta: {} }],
          }),
      });
      const malformed = await malformedProvider
        .assertMediaDeletionSchema({ databaseId: D1_DATABASE_ID })
        .catch((error) => error);
      expect(malformed.message).toContain("columns or primary key");
      expect(malformed.provider.stderr).toContain("[REDACTED] [REDACTED]");
      expect(malformed.provider.stderr).not.toContain(apiToken);
      expect(malformed.provider.stderr).not.toContain(smokePassword);
      expect(malformed.provider.stderr).not.toContain(
        JSON.stringify(smokePassword).slice(1, -1),
      );

      const bodyReadProvider = createCloudflareWorkerProvider({
        repo,
        target,
        token: apiToken,
        smokePassword,
        fetcher: async () => {
          const response = new Response("ignored");
          response.text = async () => {
            throw new Error(
              `body read failed for ${apiToken} / ${smokePassword}`,
            );
          };
          return response;
        },
      });
      const bodyReadFailure = await bodyReadProvider
        .assertMediaDeletionSchema({ databaseId: D1_DATABASE_ID })
        .catch((error) => error);
      expect(bodyReadFailure.message).toContain(
        "response body could not be read",
      );
      expect(bodyReadFailure.message).toContain(
        "body read failed for [REDACTED]",
      );
      expect(bodyReadFailure.message).not.toContain(apiToken);
      expect(bodyReadFailure.message).not.toContain(smokePassword);
      expect(bodyReadFailure.cause?.message).not.toContain(apiToken);
      expect(bodyReadFailure.cause?.message).not.toContain(smokePassword);
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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

  test("requires a bounded opaque etag and rejects its drift before promotion", () =>
    cleanFixture(async ({ repo, target }) => {
      for (const mismatch of ["missing", "empty", "long", "drift"] as const) {
        let uploadMessage = "";
        let deploys = 0;
        let candidateReads = 0;
        const failure = await deployYurucommuWorker({
          repo,
          environment: "production",
          commit: COMMIT,
          target,
          git: gitSource(),
          check: async () => {},
          provider: {
            assertVersionCode: codeProof,
            assertMediaDeletionSchema: async ({
              databaseId,
            }: {
              databaseId: string;
            }) => {
              expect(databaseId).toBe(D1_DATABASE_ID);
              return MEDIA_DELETION_SCHEMA_QUALIFICATION;
            },
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
              candidateReads += 1;
              const candidate = versionDetails(versionId, uploadMessage);
              if (mismatch === "missing") {
                delete (candidate.resources as Record<string, unknown>).script;
              } else if (mismatch === "empty") {
                candidate.resources.script.etag = "";
              } else if (mismatch === "long") {
                candidate.resources.script.etag = "x".repeat(257);
              } else if (candidateReads > 1) {
                candidate.resources.script.etag = "different-opaque-etag";
              }
              return candidate;
            },
            deployVersion: async () => {
              deploys += 1;
              throw new Error("must not deploy a malformed or drifting etag");
            },
          },
        }).catch((error) => error);

        expect(failureOf(failure).phase, mismatch).toBe(
          "POST_UPLOAD_INDETERMINATE",
        );
        expect(failure.message, mismatch).toContain("opaque script etag");
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
            assertVersionCode: codeProof,
            assertMediaDeletionSchema: async ({
              databaseId,
            }: {
              databaseId: string;
            }) => {
              expect(databaseId).toBe(D1_DATABASE_ID);
              return MEDIA_DELETION_SCHEMA_QUALIFICATION;
            },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
        assertVersionCode: codeProof,
        assertMediaDeletionSchema: async ({
          databaseId,
        }: {
          databaseId: string;
        }) => {
          expect(databaseId).toBe(D1_DATABASE_ID);
          return MEDIA_DELETION_SCHEMA_QUALIFICATION;
        },
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
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async ({
            databaseId,
          }: {
            databaseId: string;
          }) => {
            expect(databaseId).toBe(D1_DATABASE_ID);
            return MEDIA_DELETION_SCHEMA_QUALIFICATION;
          },
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
      // The rejected fixture must be insecure even under an operator's umask 077.
      await chmod(descriptorPath, 0o644);

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
      const schemaRows = await mediaDeletionMetadataRows();
      let writeCalls = 0;
      const fetcher = async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        apiCalls.push(url);
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer test-token",
          Accept: "application/json",
        });
        const method = init?.method ?? "GET";
        if (method === "POST" && !url.includes("/d1/database/")) {
          writeCalls += 1;
        }
        if (
          method === "POST" &&
          url ===
            `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`
        ) {
          expect(init?.headers).toMatchObject({
            "Content-Type": "application/json",
          });
          expect(JSON.parse(String(init?.body))).toEqual({
            sql: MEDIA_DELETION_SCHEMA_QUERY,
          });
          return Response.json({
            success: true,
            result: [
              {
                success: true,
                results: schemaRows,
                meta: { changed_db: false, rows_written: 0 },
              },
            ],
          });
        }
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
          expect(typeof form.get("metadata")).toBe("string");
          const metadata = JSON.parse(form.get("metadata") as string);
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
            {
              name: SESSION_HASH_SALT_BINDING,
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
        await provider.assertMediaDeletionSchema({
          databaseId: D1_DATABASE_ID,
        }),
      ).toEqual(MEDIA_DELETION_SCHEMA_QUALIFICATION);
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

  test("reads the exact selected Version module bytes through the fixed content endpoint", () =>
    cleanFixture(async ({ repo, target }) => {
      const calls: string[] = [];
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async (input, init) => {
          calls.push(String(input));
          expect(init?.method).toBe("GET");
          expect(init?.redirect).toBe("manual");
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return moduleContentResponse("candidate");
        },
      });
      expect(
        await provider.assertVersionCode({
          versionId: NEW_VERSION,
          bundleDigest: sha256("candidate"),
          bundleByteLength: Buffer.byteLength("candidate"),
        }),
      ).toEqual({
        kind: "yurucommu.worker-version-code@v1",
        versionId: NEW_VERSION,
        sha256: sha256("candidate"),
        size: Buffer.byteLength("candidate"),
      });
      expect(calls).toEqual([
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/yurucommu/content/v2?version=${NEW_VERSION}`,
      ]);
    }));

  test("blocks Deployment when the real content reader sees wrong uploaded bytes", () =>
    cleanFixture(async ({ repo, target }) => {
      const schemaRows = await mediaDeletionMetadataRows();
      let uploadMessage = "";
      let versionWrites = 0;
      let deploymentWrites = 0;
      let contentReads = 0;
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (method === "GET" && url.includes("/workers/domains?")) {
            return Response.json({
              success: true,
              result: [
                {
                  hostname: "test.yurucommu.com",
                  service: "yurucommu",
                  environment: "production",
                },
              ],
              result_info: { page: 1, total_pages: 1 },
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
          if (method === "GET" && url.endsWith(`/versions/${OLD_VERSION}`)) {
            return Response.json({
              success: true,
              result: versionDetails(OLD_VERSION),
            });
          }
          if (method === "GET" && url.endsWith(`/versions/${NEW_VERSION}`)) {
            return Response.json({
              success: true,
              result: versionDetails(NEW_VERSION, uploadMessage),
            });
          }
          if (
            method === "POST" &&
            url.includes(`/d1/database/${D1_DATABASE_ID}/query`)
          ) {
            return Response.json({
              success: true,
              result: [
                {
                  success: true,
                  results: schemaRows,
                  meta: { changed_db: false, rows_written: 0 },
                },
              ],
            });
          }
          if (
            method === "POST" &&
            url.endsWith("/versions?bindings_inherit=strict")
          ) {
            versionWrites += 1;
            const form = init?.body as FormData;
            uploadMessage = JSON.parse(form.get("metadata") as string)
              .annotations["workers/message"];
            expect(await (form.get("worker.mjs") as Blob).text()).toBe(BUNDLE);
            return Response.json({
              success: true,
              result: { id: NEW_VERSION },
            });
          }
          if (
            method === "GET" &&
            url.endsWith(`/content/v2?version=${NEW_VERSION}`)
          ) {
            contentReads += 1;
            return moduleContentResponse("different Worker code");
          }
          if (method === "POST" && url.endsWith("/deployments")) {
            deploymentWrites += 1;
            throw new Error("Deployment must not be called for wrong code");
          }
          throw new Error(`unexpected Cloudflare request ${method} ${url}`);
        },
      });
      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource(),
        check: async () => {},
        provider,
      }).catch((error: unknown) => error);
      expect(failureOf(failure).phase).toBe("POST_UPLOAD_INDETERMINATE");
      expect((failure as Error).message).toContain(
        "differs from the reviewed Worker bundle bytes",
      );
      expect(versionWrites).toBe(1);
      expect(contentReads).toBe(1);
      expect(deploymentWrites).toBe(0);
    }));

  test("refuses wrong, malformed, extra, redirected, and oversized Version content without retry", () =>
    cleanFixture(async ({ repo, target }) => {
      const malformed = () =>
        new Response("malformed multipart", {
          headers: {
            "Content-Type": "multipart/form-data; boundary=broken",
            "cf-entrypoint": "worker.mjs",
          },
        });
      const redirected = () =>
        new Response("redirect", {
          status: 302,
          headers: { Location: "https://other.invalid/content" },
        });
      const cases: Array<[string, () => Response, RegExp]> = [
        ["wrong bytes", () => moduleContentResponse("wrongbyte"), /differs/u],
        [
          "extra part",
          () => moduleContentResponse("candidate", { extraPart: true }),
          /parts/u,
        ],
        [
          "wrong entrypoint",
          () => moduleContentResponse("candidate", { entrypoint: "other.mjs" }),
          /entrypoint/u,
        ],
        [
          "wrong part name",
          () => moduleContentResponse("candidate", { partName: "other.mjs" }),
          /disposition/u,
        ],
        [
          "wrong filename",
          () => moduleContentResponse("candidate", { filename: "other.mjs" }),
          /disposition/u,
        ],
        [
          "wrong MIME",
          () =>
            moduleContentResponse("candidate", {
              mediaType: "application/octet-stream",
            }),
          /media type/u,
        ],
        ["malformed body", malformed, /malformed/u],
        [
          "oversized body",
          () => moduleContentResponse("x".repeat(70_000)),
          /size bound/u,
        ],
        ["redirect", redirected, /redirect/u],
      ];
      for (const [label, response, message] of cases) {
        let calls = 0;
        const provider = createCloudflareWorkerProvider({
          repo,
          target,
          token: "test-token",
          smokePassword: "test-password",
          fetcher: async () => {
            calls += 1;
            return response();
          },
        });
        const failure = await provider
          .assertVersionCode({
            versionId: NEW_VERSION,
            bundleDigest: sha256("candidate"),
            bundleByteLength: Buffer.byteLength("candidate"),
          })
          .catch((error: unknown) => error);
        expect(failure, label).toBeInstanceOf(Error);
        expect((failure as Error).message, label).toMatch(message);
        expect(calls, label).toBe(1);
      }
    }));

  test("suppresses credential-bearing content transport and body-read errors", () =>
    cleanFixture(async ({ repo, target }) => {
      const token = 'token"\\private';
      const password = 'password"\\private';
      for (const mode of ["network", "body", "denied"] as const) {
        let calls = 0;
        const provider = createCloudflareWorkerProvider({
          repo,
          target,
          token,
          smokePassword: password,
          fetcher: async () => {
            calls += 1;
            if (mode === "network") {
              throw new Error(`${token} ${password}`);
            }
            if (mode === "denied") {
              return Response.json(
                {
                  success: false,
                  errors: [{ message: `${token} ${password}` }],
                },
                { status: 403 },
              );
            }
            return new Response(
              new ReadableStream({
                pull(controller) {
                  controller.error(new Error(`${token} ${password}`));
                },
              }),
              {
                headers: {
                  "Content-Type": "multipart/form-data; boundary=error",
                  "cf-entrypoint": "worker.mjs",
                },
              },
            );
          },
        });
        const failure = await provider
          .assertVersionCode({
            versionId: NEW_VERSION,
            bundleDigest: sha256("candidate"),
            bundleByteLength: Buffer.byteLength("candidate"),
          })
          .catch((error: unknown) => error);
        const diagnostic = JSON.stringify(failure);
        expect(String(failure), mode).not.toContain(token);
        expect(String(failure), mode).not.toContain(password);
        expect(diagnostic, mode).not.toContain(token);
        expect(diagnostic, mode).not.toContain(password);
        expect(diagnostic, mode).not.toContain(
          JSON.stringify(token).slice(1, -1),
        );
        expect(diagnostic, mode).not.toContain(
          JSON.stringify(password).slice(1, -1),
        );
        expect(calls, mode).toBe(1);
      }
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
            assertVersionCode: codeProof,
            assertMediaDeletionSchema: async ({
              databaseId,
            }: {
              databaseId: string;
            }) => {
              expect(databaseId).toBe(D1_DATABASE_ID);
              return MEDIA_DELETION_SCHEMA_QUALIFICATION;
            },
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
            assertVersionCode: codeProof,
            assertMediaDeletionSchema: async ({
              databaseId,
            }: {
              databaseId: string;
            }) => {
              expect(databaseId).toBe(D1_DATABASE_ID);
              return MEDIA_DELETION_SCHEMA_QUALIFICATION;
            },
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
