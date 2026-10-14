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
  resetYurucommuIntegrationAuth,
  YurucommuWorkerReleaseFailure,
} from "./release-yurucommu-worker.mjs";
import { MEDIA_DELETION_SCHEMA_QUERY } from "./media-deletion-schema.mjs";
import {
  CORE_UPGRADE_MIGRATIONS,
  CORE_UPGRADE_SCHEMA_QUERY,
} from "./core-upgrade-schema.mjs";

const COMMIT = "c".repeat(40);
const REMOTE_MAIN = "d".repeat(40);
const ACCOUNT_ID = "a".repeat(32);
const D1_DATABASE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION_HASH_SALT_BINDING = "YURUCOMMU_SESSION_HASH_SALT";
const CORE_UPGRADE_SCHEMA_QUALIFICATION = {
  kind: "yurucommu.core-upgrade-schema@v1" as const,
  migrations: [...CORE_UPGRADE_MIGRATIONS],
  scope: "migration-0031-through-0036-prerequisites" as const,
};
const UPGRADE_SCHEMA_PROVIDER = {
  latestVersion: async () => OLD_VERSION,
  assertCoreUpgradeSchema: async ({ databaseId }: { databaseId: string }) => {
    expect(databaseId).toBe(D1_DATABASE_ID);
    return CORE_UPGRADE_SCHEMA_QUALIFICATION;
  },
};
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

// This checks prerequisite metadata against the actual product SQL bundle.
// Applying DDL to an empty portable SQLite fixture is not an upgrade rehearsal.
async function coreUpgradeMetadataRows(sql = CORE_UPGRADE_SCHEMA_QUERY) {
  const bundle = JSON.parse(
    await readFile(
      new URL(
        "../deploy/takoform/migrations/schema-bundle.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { entries: { name: string; sql: string }[] };
  expect(bundle.entries).toHaveLength(35);
  expect(bundle.entries.slice(-6).map((entry) => entry.name)).toEqual(
    CORE_UPGRADE_MIGRATIONS,
  );
  const database = new Database(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const entry of bundle.entries) database.exec(entry.sql);
    database.exec(
      "CREATE TABLE yurucommu_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const entry of bundle.entries) {
      database
        .query(
          "INSERT INTO yurucommu_migrations (name, applied_at) VALUES (?, ?)",
        )
        .run(entry.name, "portable-schema-fixture");
    }
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    return database.query(sql).all();
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
            ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
            ...UPGRADE_SCHEMA_PROVIDER,
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

  test("refuses upload when a newer Version is unserved", () =>
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
        ...UPGRADE_SCHEMA_PROVIDER,
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

      const failure = await deployYurucommuWorker({
        repo,
        environment: "production",
        commit: COMMIT,
        target,
        git: gitSource({ branch: "", remoteMain: REMOTE_MAIN, ancestor: true }),
        check: async () => {
          checks += 1;
        },
        provider,
      }).catch((error) => error);

      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(failure.message).toContain(
        "latest uploaded Worker Version differs",
      );
      expect(checks).toBe(1);
      expect(activeReads).toBe(1);
      expect(domainsRead).toBe(1);
      expect(latestVersionReads).toBe(1);
      expect(codeReads).toBe(0);
      expect(uploadSequence).toEqual(["schema"]);
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
            ...UPGRADE_SCHEMA_PROVIDER,
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
            ...UPGRADE_SCHEMA_PROVIDER,
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

  test("does not treat the old 0030 callback as Core 4.1.12 readiness", () =>
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
          assertMediaDeletionSchema: async () =>
            MEDIA_DELETION_SCHEMA_QUALIFICATION,
          upload: async () => {
            uploads += 1;
            throw new Error("old 0030 callback must not authorize upload");
          },
        },
      }).catch((error: unknown) => error);
      expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect((failure as Error).message).toContain(
        "required read-only Core 4.1.12 D1 preflight",
      );
      expect(uploads).toBe(0);
    }));

  test("refuses old-only, denied, and write-reported Core D1 metadata before upload", () =>
    cleanFixture(async ({ repo, target }) => {
      for (const [label, body, status] of [
        [
          "old-only",
          {
            success: true,
            result: [
              {
                success: true,
                results: [],
                meta: { changed_db: false, rows_written: 0 },
              },
            ],
          },
          200,
        ],
        [
          "denied",
          { success: false, errors: [{ message: "D1 Read denied" }] },
          403,
        ],
        [
          "write-reported",
          {
            success: true,
            result: [{ success: true, results: [], meta: { rows_written: 1 } }],
          },
          200,
        ],
      ] as const) {
        let uploads = 0;
        let coreQueries = 0;
        const realProvider = createCloudflareWorkerProvider({
          repo,
          target,
          token: "test-token",
          smokePassword: "test-password",
          fetcher: async (input, init) => {
            expect(String(input)).toBe(
              `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
            );
            expect(init?.method).toBe("POST");
            const { sql } = JSON.parse(String(init?.body));
            expect(CORE_UPGRADE_SCHEMA_QUERY.includes(sql)).toBe(true);
            expect(sql.split("\nUNION ALL\n").length).toBeLessThanOrEqual(5);
            coreQueries += 1;
            return Response.json(body, { status });
          },
        });
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
            version: async ({ versionId }: { versionId: string }) =>
              versionDetails(versionId),
            assertMediaDeletionSchema: async () =>
              MEDIA_DELETION_SCHEMA_QUALIFICATION,
            assertCoreUpgradeSchema: ({ databaseId }: { databaseId: string }) =>
              realProvider.assertCoreUpgradeSchema({ databaseId }),
            upload: async () => {
              uploads += 1;
              throw new Error("Core D1 preflight must block upload");
            },
          },
        }).catch((error: unknown) => error);
        expect(failureOf(failure).phase, label).toBe("PRE_UPLOAD_FAILURE");
        expect(coreQueries, label).toBe(label === "old-only" ? 5 : 1);
        expect(uploads, label).toBe(0);
      }
    }));

  test("queries all Core 4.1.15 schema terms within the live D1 five-term limit", () =>
    cleanFixture(async ({ repo, target }) => {
      const sqlRequests: string[] = [];
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async (input, init) => {
          expect(String(input)).toBe(
            `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
          );
          expect(init?.method).toBe("POST");
          const { sql } = JSON.parse(String(init?.body));
          const terms = sql.split("\nUNION ALL\n");
          sqlRequests.push(sql);
          if (terms.length > 5) {
            return Response.json(
              {
                success: false,
                errors: [
                  { code: 7500, message: "too many terms in compound SELECT" },
                ],
              },
              { status: 400 },
            );
          }
          return Response.json({
            success: true,
            result: [
              {
                success: true,
                results: await coreUpgradeMetadataRows(sql),
                meta: { changed_db: false, rows_written: 0 },
              },
            ],
          });
        },
      });
      await expect(
        provider.assertCoreUpgradeSchema({ databaseId: D1_DATABASE_ID }),
      ).resolves.toEqual(CORE_UPGRADE_SCHEMA_QUALIFICATION);
      expect(sqlRequests).toHaveLength(5);
      expect(
        sqlRequests.every((sql) => sql.split("\nUNION ALL\n").length === 5),
      ).toBe(true);
      expect(sqlRequests.join("\nUNION ALL\n")).toBe(CORE_UPGRADE_SCHEMA_QUERY);
    }));

  test("stops on a missing, extra, or unproven Core schema chunk", () =>
    cleanFixture(async ({ repo, target }) => {
      for (const kind of ["missing", "extra", "write", "no-meta"] as const) {
        let requests = 0;
        const provider = createCloudflareWorkerProvider({
          repo,
          target,
          token: "test-token",
          smokePassword: "test-password",
          fetcher: async (_input, init) => {
            requests += 1;
            const { sql } = JSON.parse(String(init?.body));
            const valid = {
              success: true,
              results: await coreUpgradeMetadataRows(sql),
              meta: { changed_db: false, rows_written: 0 },
            };
            return Response.json({
              success: true,
              result:
                requests !== 3
                  ? [valid]
                  : kind === "missing"
                    ? []
                    : kind === "extra"
                      ? [valid, valid]
                      : kind === "write"
                        ? [
                            {
                              ...valid,
                              meta: { changed_db: false, rows_written: 1 },
                            },
                          ]
                        : [{ success: true, results: valid.results }],
            });
          },
        });
        await expect(
          provider.assertCoreUpgradeSchema({ databaseId: D1_DATABASE_ID }),
        ).rejects.toThrow("Core schema query");
        expect(requests).toBe(3);
      }
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
            ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
            ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
        ...UPGRADE_SCHEMA_PROVIDER,
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
          ...UPGRADE_SCHEMA_PROVIDER,
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
        if (method === "GET" && url.endsWith("/versions?page=1&per_page=1")) {
          return Response.json({
            success: true,
            result: { items: [{ id: OLD_VERSION }] },
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
            { name: "DB", type: "inherit", version_id: "latest" },
            {
              name: "DELIVERY_QUEUE",
              type: "inherit",
              version_id: "latest",
            },
            {
              name: SESSION_HASH_SALT_BINDING,
              type: "inherit",
              version_id: "latest",
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
      expect(await provider.latestVersion()).toBe(OLD_VERSION);
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

  test("latest Version list rejects an absent or ambiguous first item", () =>
    cleanFixture(async ({ repo, target }) => {
      for (const items of [
        [],
        [{ id: "bad" }],
        [{ id: OLD_VERSION }, { id: NEW_VERSION }],
      ]) {
        const provider = createCloudflareWorkerProvider({
          repo,
          target,
          token: "test-token",
          smokePassword: "test-password",
          fetcher: async (input: string | URL) => {
            expect(String(input)).toContain("/versions?page=1&per_page=1");
            return Response.json({ success: true, result: { items } });
          },
        });
        await expect(provider.latestVersion()).rejects.toThrow(
          "latest Worker Version list is malformed or empty",
        );
      }
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
      let upgradeQueries = 0;
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
          if (method === "GET" && url.endsWith("/versions?page=1&per_page=1")) {
            return Response.json({
              success: true,
              result: { items: [{ id: OLD_VERSION }] },
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
            const { sql } = JSON.parse(String(init?.body));
            const isCore = sql !== MEDIA_DELETION_SCHEMA_QUERY;
            if (isCore) {
              expect(CORE_UPGRADE_SCHEMA_QUERY.includes(sql)).toBe(true);
              expect(sql.split("\nUNION ALL\n").length).toBeLessThanOrEqual(5);
              upgradeQueries += 1;
            }
            expect(versionWrites).toBe(0);
            return Response.json({
              success: true,
              result: [
                {
                  success: true,
                  results: isCore
                    ? await coreUpgradeMetadataRows(sql)
                    : schemaRows,
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
      expect(upgradeQueries).toBe(5);
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

  test("accepts Cloudflare's observed domain pagination without total_pages", () =>
    cleanFixture(async ({ repo, target }) => {
      let requests = 0;
      const domain = {
        hostname: target.route.hostname,
        service: target.workerName,
        environment: "production",
      };
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async (input: string | URL) => {
          const url = new URL(String(input));
          expect(url.searchParams.get("page")).toBe("1");
          expect(url.searchParams.get("per_page")).toBe("100");
          requests += 1;
          return Response.json({
            success: true,
            result: [domain],
            result_info: { count: 1, page: 1, per_page: 100, total_count: 1 },
          });
        },
      });
      await expect(provider.domains()).resolves.toEqual([domain]);
      expect(requests).toBe(2);
    }));

  test("uses bounded page length when total_count includes other domains", () =>
    cleanFixture(async ({ repo, target }) => {
      const fullPage = Array.from({ length: 100 }, (_, index) => ({
        hostname: `other-${index}.example`,
        service: target.workerName,
        environment: "production",
      }));
      const last = {
        hostname: target.route.hostname,
        service: target.workerName,
        environment: "production",
      };
      let requests = 0;
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async (input: string | URL) => {
          const page = Number(new URL(String(input)).searchParams.get("page"));
          requests += 1;
          expect(page).toBeLessThanOrEqual(2);
          return Response.json({
            success: true,
            result: page === 1 ? fullPage : [last],
            result_info: { count: 101, page, per_page: 100, total_count: 1000 },
          });
        },
      });
      await expect(provider.domains()).resolves.toHaveLength(101);
      expect(requests).toBe(4);
    }));

  test("rejects malformed or unbounded page-length domain metadata", () =>
    cleanFixture(async ({ repo, target }) => {
      for (const metadata of [
        { count: -1, page: 1, per_page: 100, total_count: 1 },
        { count: 1, page: 2, per_page: 100, total_count: 1 },
        { count: 1, page: 1, per_page: 50, total_count: 1 },
        { count: 1, page: 1, per_page: 100, total_count: -1 },
      ]) {
        const provider = createCloudflareWorkerProvider({
          repo,
          target,
          token: "test-token",
          smokePassword: "test-password",
          fetcher: async () =>
            Response.json({
              success: true,
              result: [{ hostname: target.route.hostname }],
              result_info: metadata,
            }),
        });
        await expect(provider.domains()).rejects.toThrow("pagination");
      }
      let requests = 0;
      const fullPage = Array.from({ length: 100 }, () => ({
        hostname: target.route.hostname,
        service: target.workerName,
        environment: "production",
      }));
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async (input: string | URL) => {
          const page = Number(new URL(String(input)).searchParams.get("page"));
          requests += 1;
          return Response.json({
            success: true,
            result: fullPage,
            result_info: {
              count: 100,
              page,
              per_page: 100,
              total_count: 1000,
            },
          });
        },
      });
      await expect(provider.domains()).rejects.toThrow(
        "8-page stability bound",
      );
      expect(requests).toBe(8);
    }));

  test("refuses a full first domain page when pagination metadata is absent", () =>
    cleanFixture(async ({ repo, target }) => {
      let requests = 0;
      const provider = createCloudflareWorkerProvider({
        repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async () => {
          requests += 1;
          return Response.json({
            success: true,
            result: Array.from({ length: 100 }, () => ({
              hostname: target.route.hostname,
              service: target.workerName,
              environment: "production",
            })),
          });
        },
      });
      await expect(provider.domains()).rejects.toThrow(
        "omitted bounded pagination metadata",
      );
      expect(requests).toBe(1);
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
            ...UPGRADE_SCHEMA_PROVIDER,
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
            ...UPGRADE_SCHEMA_PROVIDER,
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

describe("isolated integration Worker code publisher", () => {
  test("CLI rejects production selection on the integration code surface", () => {
    for (const surface of [
      "yurucommu-integration-worker",
      "yurucommu-integration-auth",
    ]) {
      for (const environment of ["production", "staging"]) {
        const result = Bun.spawnSync([
          "bun",
          "scripts/deploy.mjs",
          surface,
          `--environment=${environment}`,
          `--commit=${COMMIT}`,
        ]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(
          "requires exactly --environment=integration",
        );
      }
    }
  });

  async function integrationTarget(value: Awaited<ReturnType<typeof fixture>>) {
    const config = `{"name":"yurucommu-ga-20261012-0938","account_id":"${ACCOUNT_ID}","main":"./dist/yurucommu-worker.js","compatibility_date":"2026-07-16"}\n`;
    await writeFile(value.target.config.path, config);
    return {
      ...value.target,
      environment: "integration",
      workerName: "yurucommu-ga-20261012-0938",
      publicOrigin: "https://ga-commu-20261012.yurucommu.com",
      route: {
        kind: "custom-domain",
        hostname: "ga-commu-20261012.yurucommu.com",
      },
      resources: {
        databaseId: D1_DATABASE_ID,
        kvNamespaceId: "e".repeat(32),
        mediaBucketName: "yurucommu-ga-20261012-0938-media",
        deliveryQueueName: "yurucommu-ga-20261012-0938-delivery",
        deliveryDlqName: "yurucommu-ga-20261012-0938-delivery-dlq",
      },
      config: { path: value.target.config.path, sha256: sha256(config) },
    } as const;
  }

  function integrationResourceBindings(
    target: Awaited<ReturnType<typeof integrationTarget>>,
  ) {
    return {
      DB: { type: "d1", id: target.resources.databaseId },
      KV: {
        type: "kv_namespace",
        namespace_id: target.resources.kvNamespaceId,
      },
      MEDIA: {
        type: "r2_bucket",
        bucket_name: target.resources.mediaBucketName,
      },
      DELIVERY_QUEUE: {
        type: "queue",
        queue_name: target.resources.deliveryQueueName,
      },
      DELIVERY_DLQ: {
        type: "queue",
        queue_name: target.resources.deliveryDlqName,
      },
    };
  }

  function integrationVersionDetails(
    target: Awaited<ReturnType<typeof integrationTarget>>,
    versionId = OLD_VERSION,
    bindingsOverride: Record<string, unknown> = {},
  ) {
    const base = versionDetails(versionId);
    return {
      ...base,
      resources: {
        ...base.resources,
        bindings: {
          ...base.resources.bindings,
          ...integrationResourceBindings(target),
          APP_URL: { type: "plain_text", text: target.publicOrigin },
          AUTH_PASSWORD_HASH: { type: "secret_text" },
          ...bindingsOverride,
        },
      },
    };
  }

  test("accepts only the exact isolated target and matched environment", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      const path = join(value.privateDir, "integration-target.json");
      await writeFile(path, `${JSON.stringify(target)}\n`, { mode: 0o600 });
      expect(
        loadYurucommuWorkerTarget({
          path,
          repo: value.repo,
          environment: "integration",
        }),
      ).toMatchObject(target);
      expect(() =>
        loadYurucommuWorkerTarget({
          path,
          repo: value.repo,
          environment: "production",
        }),
      ).toThrow("environment");
      for (const mutation of [
        { workerName: "yurucommu" },
        { publicOrigin: "https://test.yurucommu.com" },
        { route: { kind: "custom-domain", hostname: "test.yurucommu.com" } },
        { resources: { ...target.resources, databaseId: "bad-id" } },
        { resources: { ...target.resources, kvNamespaceId: "f".repeat(31) } },
        {
          resources: {
            ...target.resources,
            mediaBucketName: "production-media",
          },
        },
      ]) {
        await writeFile(
          path,
          `${JSON.stringify({ ...target, ...mutation })}\n`,
        );
        expect(() =>
          loadYurucommuWorkerTarget({
            path,
            repo: value.repo,
            environment: "integration",
          }),
        ).toThrow();
      }
      const { resources: _resources, ...missingResources } = target;
      await writeFile(path, `${JSON.stringify(missingResources)}\n`);
      expect(() =>
        loadYurucommuWorkerTarget({
          path,
          repo: value.repo,
          environment: "integration",
        }),
      ).toThrow("keys differ");
    }));

  test("loaded integration descriptor survives auth, code, and provider revalidation", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      const path = join(value.privateDir, "loaded-integration-target.json");
      await writeFile(path, `${JSON.stringify(target)}\n`, { mode: 0o600 });
      const loaded = loadYurucommuWorkerTarget({
        path,
        repo: value.repo,
        environment: "integration",
      });
      const configBytes = await readFile(target.config.path);
      const enriched = {
        ...loaded,
        configBytes,
        configValues: JSON.parse(configBytes.toString("utf8")),
      };
      const provider = createCloudflareWorkerProvider({
        repo: value.repo,
        target: enriched,
        token: "test-token",
        smokePassword: "integration-test-owner-password-12345",
        fetcher: async () => {
          throw new Error("no provider request expected during validation");
        },
      });
      expect(provider).toHaveProperty("activeDeployment");

      let writes = 0;
      const readOnlyStop = {
        assertVersionCode: codeProof,
        snapshotVersionCode: async () => {
          throw new Error("unexpected code snapshot");
        },
        domains: async () => {
          throw new Error("stopped at first provider read");
        },
        upload: async () => {
          writes += 1;
          throw new Error("unexpected upload");
        },
        putAuthSecret: async () => {
          writes += 1;
          throw new Error("unexpected secret PUT");
        },
      };
      const authFailure = await resetYurucommuIntegrationAuth({
        repo: value.repo,
        commit: COMMIT,
        target: loaded,
        password: "integration-test-owner-password-12345",
        git: gitSource(),
        check: async () => {},
        provider: readOnlyStop,
      }).catch((error) => error);
      expect(failureOf(authFailure).phase).toBe("PRE_AUTH_FAILURE");
      expect(authFailure.message).toContain("stopped at first provider read");
      const codeFailure = await deployYurucommuWorker({
        repo: value.repo,
        environment: "integration",
        commit: COMMIT,
        target: loaded,
        git: gitSource(),
        check: async () => {},
        provider: readOnlyStop,
      }).catch((error) => error);
      expect(failureOf(codeFailure).phase).toBe("PRE_UPLOAD_FAILURE");
      expect(codeFailure.message).toContain("stopped at first provider read");
      expect(writes).toBe(0);

      await writeFile(
        path,
        `${JSON.stringify({ ...target, configBytes: "extra" })}\n`,
      );
      expect(() =>
        loadYurucommuWorkerTarget({
          path,
          repo: value.repo,
          environment: "integration",
        }),
      ).toThrow("keys differ");
    }));

  test("queries the provider production domain environment for the isolated Worker", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      const queries: URL[] = [];
      const provider = createCloudflareWorkerProvider({
        repo: value.repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async (input: string | URL) => {
          const url = new URL(String(input));
          queries.push(url);
          return Response.json({
            success: true,
            result: [
              {
                hostname: "ga-commu-20261012.yurucommu.com",
                service: "yurucommu-ga-20261012-0938",
                environment: "production",
              },
            ],
          });
        },
      });
      expect(await provider.domains()).toHaveLength(1);
      expect(queries).toHaveLength(2);
      for (const query of queries) {
        expect(query.searchParams.get("environment")).toBe("production");
        expect(query.searchParams.get("service")).toBe(target.workerName);
      }
    }));

  test("integration upload inherits existing bindings and sends only Version code", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      const requests: Array<{ url: URL; method: string }> = [];
      const provider = createCloudflareWorkerProvider({
        repo: value.repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async (input: string | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          requests.push({ url, method: init?.method ?? "GET" });
          expect(init?.body).toBeInstanceOf(FormData);
          const form = init?.body as FormData;
          const metadata = JSON.parse(String(form.get("metadata")));
          expect(metadata.bindings).toEqual(
            expect.arrayContaining([
              { name: "DB", type: "inherit", version_id: "latest" },
              { name: "APP_URL", type: "inherit", version_id: "latest" },
              {
                name: SESSION_HASH_SALT_BINDING,
                type: "inherit",
                version_id: "latest",
              },
            ]),
          );
          expect(metadata).not.toHaveProperty("routes");
          expect(metadata).not.toHaveProperty("migrations");
          expect([...form.keys()]).toEqual(["metadata", "worker.mjs"]);
          return Response.json({ success: true, result: { id: NEW_VERSION } });
        },
      });
      const previous = versionDetails(OLD_VERSION);
      const response = await provider.upload({
        bundleBytes: Buffer.from(BUNDLE),
        configBytes: await readFile(target.config.path),
        previousVersion: {
          ...previous,
          resources: {
            ...previous.resources,
            bindings: {
              ...previous.resources.bindings,
              ...integrationResourceBindings(target),
              APP_URL: { type: "plain_text", text: target.publicOrigin },
            },
          },
        },
        message: "integration-code-test",
      });
      expect(response).toEqual({
        versionId: NEW_VERSION,
        workerName: target.workerName,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url.pathname).toContain(
        `/workers/scripts/${target.workerName}/versions`,
      );
      expect(requests[0]?.url.searchParams.get("bindings_inherit")).toBe(
        "strict",
      );
    }));

  test("refuses wrong provider domain or missing canonical APP_URL before upload", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      for (const mismatch of ["domain", "app-url"] as const) {
        let uploads = 0;
        const failure = await deployYurucommuWorker({
          repo: value.repo,
          environment: "integration",
          commit: COMMIT,
          target,
          git: gitSource(),
          check: async () => {},
          provider: {
            assertVersionCode: codeProof,
            domains: async () => [
              {
                hostname: target.route.hostname,
                service: target.workerName,
                environment:
                  mismatch === "domain" ? "integration" : "production",
              },
            ],
            activeDeployment: async () =>
              deployment(OLD_DEPLOYMENT, OLD_VERSION),
            version: async ({ versionId }: { versionId: string }) =>
              versionDetails(versionId),
            upload: async () => {
              uploads += 1;
              throw new Error("must not upload");
            },
          },
        }).catch((error) => error);
        expect(failureOf(failure).phase).toBe("PRE_UPLOAD_FAILURE");
        expect(failure.message).toContain(
          mismatch === "domain" ? "environment filters" : "APP_URL",
        );
        expect(uploads).toBe(0);
      }
    }));

  test("refuses rebound or additional integration resources before upload or secret PUT", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      for (const bindings of [
        { DB: { type: "d1", id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } },
        { DB: { type: "d1" } },
        { KV: { type: "kv_namespace", namespace_id: "f".repeat(32) } },
        { EXTRA_DB: { type: "d1", id: target.resources.databaseId } },
        { SERVICE: { type: "service", service: "production-worker" } },
        {
          DB: {
            type: "d1",
            id: target.resources.databaseId,
            database_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          },
        },
        {
          DB: {
            type: "d1",
            id: target.resources.databaseId,
            namespace_id: target.resources.kvNamespaceId,
          },
        },
      ]) {
        for (const surface of ["code", "auth"] as const) {
          let writes = 0;
          const provider = {
            ...UPGRADE_SCHEMA_PROVIDER,
            domains: async () => [
              {
                hostname: target.route.hostname,
                service: target.workerName,
                environment: "production",
              },
            ],
            activeDeployment: async () =>
              deployment(OLD_DEPLOYMENT, OLD_VERSION),
            version: async () =>
              integrationVersionDetails(target, OLD_VERSION, bindings),
            snapshotVersionCode: async () => {
              throw new Error("unexpected code snapshot");
            },
            upload: async () => {
              writes += 1;
              throw new Error("unexpected upload");
            },
            putAuthSecret: async () => {
              writes += 1;
              throw new Error("unexpected PUT");
            },
          };
          const failure = await (
            surface === "code"
              ? deployYurucommuWorker({
                  repo: value.repo,
                  environment: "integration",
                  commit: COMMIT,
                  target,
                  git: gitSource(),
                  check: async () => {},
                  provider: {
                    ...provider,
                    assertVersionCode: codeProof,
                  },
                })
              : resetYurucommuIntegrationAuth({
                  repo: value.repo,
                  commit: COMMIT,
                  target,
                  password: "integration-test-owner-password-12345",
                  git: gitSource(),
                  check: async () => {},
                  provider,
                })
          ).catch((error) => error);
          expect(failureOf(failure).phase).toBe(
            surface === "code" ? "PRE_UPLOAD_FAILURE" : "PRE_AUTH_FAILURE",
          );
          expect(failure.message).toContain("binding");
          expect(writes).toBe(0);
        }
      }
    }));

  test("accepts the observed array D1 binding with equal id and database_id before writes", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      const base = integrationVersionDetails(target);
      const bindings = Object.entries(base.resources.bindings).map(
        ([name, binding]) => ({
          name,
          ...binding,
          ...(name === "DB"
            ? { database_id: target.resources.databaseId }
            : {}),
        }),
      );
      const version = {
        ...base,
        resources: { ...base.resources, bindings },
      };
      for (const surface of ["code", "auth"] as const) {
        let writes = 0;
        const provider = {
          domains: async () => [
            {
              hostname: target.route.hostname,
              service: target.workerName,
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          version: async () => version,
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async () => {
            throw new Error("reached D1 schema preflight");
          },
          snapshotVersionCode: async () => {
            throw new Error("reached bounded code snapshot");
          },
          upload: async () => {
            writes += 1;
            throw new Error("unexpected upload");
          },
          putAuthSecret: async () => {
            writes += 1;
            throw new Error("unexpected secret PUT");
          },
        };
        const failure = await (
          surface === "code"
            ? deployYurucommuWorker({
                repo: value.repo,
                environment: "integration",
                commit: COMMIT,
                target,
                git: gitSource(),
                check: async () => {},
                provider,
              })
            : resetYurucommuIntegrationAuth({
                repo: value.repo,
                commit: COMMIT,
                target,
                password: "integration-test-owner-password-12345",
                git: gitSource(),
                check: async () => {},
                provider,
              })
        ).catch((error) => error);
        expect(failureOf(failure).phase).toBe(
          surface === "code" ? "PRE_UPLOAD_FAILURE" : "PRE_AUTH_FAILURE",
        );
        expect(failure.message).toContain(
          surface === "code"
            ? "reached D1 schema preflight"
            : "reached bounded code snapshot",
        );
        expect(writes).toBe(0);
      }
    }));

  test("refuses stale latest Version before integration upload or secret PUT", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      for (const surface of ["code", "auth"] as const) {
        let writes = 0;
        const provider = {
          ...UPGRADE_SCHEMA_PROVIDER,
          latestVersion: async () => UNSERVED_VERSION,
          domains: async () => [
            {
              hostname: target.route.hostname,
              service: target.workerName,
              environment: "production",
            },
          ],
          activeDeployment: async () => deployment(OLD_DEPLOYMENT, OLD_VERSION),
          version: async () => integrationVersionDetails(target),
          snapshotVersionCode: async () => ({
            kind: "yurucommu.worker-version-code@v1" as const,
            versionId: OLD_VERSION,
            sha256: sha256("predecessor"),
            size: Buffer.byteLength("predecessor"),
          }),
          assertVersionCode: codeProof,
          assertMediaDeletionSchema: async () =>
            MEDIA_DELETION_SCHEMA_QUALIFICATION,
          upload: async () => {
            writes += 1;
            throw new Error("unexpected upload");
          },
          putAuthSecret: async () => {
            writes += 1;
            throw new Error("unexpected PUT");
          },
        };
        const failure = await (
          surface === "code"
            ? deployYurucommuWorker({
                repo: value.repo,
                environment: "integration",
                commit: COMMIT,
                target,
                git: gitSource(),
                check: async () => {},
                provider,
              })
            : resetYurucommuIntegrationAuth({
                repo: value.repo,
                commit: COMMIT,
                target,
                password: "integration-test-owner-password-12345",
                git: gitSource(),
                check: async () => {},
                provider,
              })
        ).catch((error) => error);
        expect(failureOf(failure).phase).toBe(
          surface === "code" ? "PRE_UPLOAD_FAILURE" : "PRE_AUTH_FAILURE",
        );
        expect(failure.message).toContain(
          "latest uploaded Worker Version differs",
        );
        expect(writes).toBe(0);
      }
    }));

  test("publishes only isolated code with predecessor and domain readbacks", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      let activeReads = 0;
      let domainReads = 0;
      let codeReads = 0;
      let message = "";
      let deploymentMessage = "";
      const result = await deployYurucommuWorker({
        repo: value.repo,
        environment: "integration",
        commit: COMMIT,
        target,
        git: gitSource({ branch: "", remoteMain: REMOTE_MAIN, ancestor: true }),
        check: async () => {},
        provider: {
          assertVersionCode: async (input: Parameters<typeof codeProof>[0]) => {
            codeReads += 1;
            return codeProof(input);
          },
          ...UPGRADE_SCHEMA_PROVIDER,
          assertMediaDeletionSchema: async () =>
            MEDIA_DELETION_SCHEMA_QUALIFICATION,
          domains: async () => {
            domainReads += 1;
            return [
              {
                hostname: target.route.hostname,
                service: target.workerName,
                environment: "production",
              },
            ];
          },
          activeDeployment: async () => {
            activeReads += 1;
            return activeReads <= 3
              ? deployment(OLD_DEPLOYMENT, OLD_VERSION)
              : deployment(NEW_DEPLOYMENT, NEW_VERSION, deploymentMessage);
          },
          latestVersion: async () => OLD_VERSION,
          version: async ({ versionId }: { versionId: string }) => {
            const version = versionDetails(versionId, message);
            return {
              ...version,
              resources: {
                ...version.resources,
                bindings: {
                  ...version.resources.bindings,
                  ...integrationResourceBindings(target),
                  APP_URL: { type: "plain_text", text: target.publicOrigin },
                },
              },
            };
          },
          upload: async ({
            previousVersion,
            message: nextMessage,
          }: {
            previousVersion: unknown;
            message: string;
          }) => {
            expect(previousVersion).toMatchObject({
              id: OLD_VERSION,
              resources: { bindings: integrationResourceBindings(target) },
            });
            message = nextMessage;
            return { versionId: NEW_VERSION, workerName: target.workerName };
          },
          deployVersion: async ({
            message: nextMessage,
          }: {
            message: string;
          }) => {
            deploymentMessage = nextMessage;
            return {
              deploymentId: NEW_DEPLOYMENT,
              workerName: target.workerName,
            };
          },
          smoke: async () => ({ status: "passed", postRetained: true }),
        },
      });
      expect(result).toMatchObject({
        surface: "yurucommu-integration-worker",
        environment: "integration",
        workerName: target.workerName,
        route: target.publicOrigin,
        previousDeploymentId: OLD_DEPLOYMENT,
        status: "PUBLISHED",
      });
      expect(activeReads).toBe(5);
      expect(domainReads).toBe(3);
      expect(codeReads).toBe(3);
    }));

  test("reset changes only isolated auth secret and proves new login", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      const password = "integration-test-owner-password-12345";
      let putCount = 0;
      let activeReads = 0;
      let codeReads = 0;
      let loginCount = 0;
      const version = (versionId: string) => {
        const base = versionDetails(versionId);
        return {
          ...base,
          resources: {
            ...base.resources,
            bindings: {
              ...base.resources.bindings,
              ...integrationResourceBindings(target),
              APP_URL: { type: "plain_text", text: target.publicOrigin },
              AUTH_PASSWORD_HASH: { type: "secret_text" },
            },
          },
        };
      };
      const result = await resetYurucommuIntegrationAuth({
        repo: value.repo,
        commit: COMMIT,
        target,
        password,
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: target.route.hostname,
              service: target.workerName,
              environment: "production",
            },
          ],
          activeDeployment: async () => {
            activeReads += 1;
            return activeReads <= 2
              ? deployment(OLD_DEPLOYMENT, OLD_VERSION)
              : deployment(NEW_DEPLOYMENT, NEW_VERSION);
          },
          latestVersion: async () => OLD_VERSION,
          version: async ({ versionId }: { versionId: string }) =>
            version(versionId),
          snapshotVersionCode: async ({ versionId }: { versionId: string }) => {
            codeReads += 1;
            return {
              kind: "yurucommu.worker-version-code@v1" as const,
              versionId,
              sha256: sha256("previous integration worker bytes"),
              size: Buffer.byteLength("previous integration worker bytes"),
            };
          },
          putAuthSecret: async ({ hash }: { hash: string }) => {
            putCount += 1;
            expect(hash).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/u);
            const { verifyPassword } =
              await import("../node_modules/@takosjp/yurucommu-core/src/backend/lib/crypto.ts");
            expect(await verifyPassword(password, hash)).toBe(true);
            return { name: "AUTH_PASSWORD_HASH", type: "secret_text" };
          },
          verifyAuthLogin: async ({
            password: supplied,
          }: {
            password: string;
          }) => {
            expect(supplied).toBe(password);
            loginCount += 1;
            return { status: "passed" };
          },
        },
      });
      expect(result).toMatchObject({
        surface: "yurucommu-integration-auth",
        status: "PUBLISHED",
        previousVersionId: OLD_VERSION,
        versionId: NEW_VERSION,
      });
      expect(putCount).toBe(1);
      expect(loginCount).toBe(1);
      expect(activeReads).toBe(4);
      expect(codeReads).toBe(3);
      expect(JSON.stringify(result)).not.toContain(password);
    }));

  test("auth reset refuses code or binding mismatch before secret write", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      for (const failureKind of ["code", "binding"] as const) {
        let writes = 0;
        const failure = await resetYurucommuIntegrationAuth({
          repo: value.repo,
          commit: COMMIT,
          target,
          password: "integration-test-owner-password-12345",
          git: gitSource(),
          check: async () => {},
          provider: {
            domains: async () => [
              {
                hostname: target.route.hostname,
                service: target.workerName,
                environment: "production",
              },
            ],
            activeDeployment: async () =>
              deployment(OLD_DEPLOYMENT, OLD_VERSION),
            version: async ({ versionId }: { versionId: string }) => {
              const base = versionDetails(versionId);
              return {
                ...base,
                resources: {
                  ...base.resources,
                  bindings: {
                    ...base.resources.bindings,
                    ...integrationResourceBindings(target),
                    APP_URL: { type: "plain_text", text: target.publicOrigin },
                    ...(failureKind === "binding"
                      ? {}
                      : { AUTH_PASSWORD_HASH: { type: "secret_text" } }),
                  },
                },
              };
            },
            snapshotVersionCode: async ({
              versionId,
            }: {
              versionId: string;
            }) => ({
              kind: "yurucommu.worker-version-code@v1" as const,
              versionId: failureKind === "code" ? NEW_VERSION : versionId,
              sha256: sha256("wrong code"),
              size: 10,
            }),
            putAuthSecret: async () => {
              writes += 1;
              throw new Error("must not write");
            },
          },
        }).catch((error) => error);
        expect(failureOf(failure).phase).toBe("PRE_AUTH_FAILURE");
        expect(writes).toBe(0);
      }
    }));

  test("auth reset reports post-write closure drift as indeterminate without replay", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      let writes = 0;
      let activeReads = 0;
      const failure = await resetYurucommuIntegrationAuth({
        repo: value.repo,
        commit: COMMIT,
        target,
        password: "integration-test-owner-password-12345",
        git: gitSource(),
        check: async () => {},
        provider: {
          domains: async () => [
            {
              hostname: target.route.hostname,
              service: target.workerName,
              environment: "production",
            },
          ],
          activeDeployment: async () => {
            activeReads += 1;
            return activeReads <= 2
              ? deployment(OLD_DEPLOYMENT, OLD_VERSION)
              : deployment(NEW_DEPLOYMENT, NEW_VERSION);
          },
          latestVersion: async () => OLD_VERSION,
          version: async ({ versionId }: { versionId: string }) => {
            const base = versionDetails(versionId);
            return {
              ...base,
              resources: {
                ...base.resources,
                bindings: {
                  ...base.resources.bindings,
                  ...integrationResourceBindings(target),
                  APP_URL: {
                    type: "plain_text",
                    text:
                      versionId === OLD_VERSION
                        ? target.publicOrigin
                        : "https://wrong.example",
                  },
                  AUTH_PASSWORD_HASH: { type: "secret_text" },
                },
              },
            };
          },
          snapshotVersionCode: async ({
            versionId,
          }: {
            versionId: string;
          }) => ({
            kind: "yurucommu.worker-version-code@v1" as const,
            versionId,
            sha256: sha256("old worker"),
            size: Buffer.byteLength("old worker"),
          }),
          putAuthSecret: async () => {
            writes += 1;
            return { name: "AUTH_PASSWORD_HASH", type: "secret_text" };
          },
          verifyAuthLogin: async () => {
            throw new Error("must not login after closure drift");
          },
        },
      }).catch((error) => error);
      expect(failureOf(failure).phase).toBe("POST_AUTH_INDETERMINATE");
      expect(failure.evidence.previousVersionId).toBe(OLD_VERSION);
      expect(failure.evidence.versionId).toBe(NEW_VERSION);
      expect(writes).toBe(1);
    }));

  test("auth secret API makes one isolated PUT and suppresses hash-bearing errors", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      const hash = `${"a".repeat(64)}:${"b".repeat(64)}`;
      const requests: Array<{ url: URL; method: string }> = [];
      const makeProvider = (status: number) =>
        createCloudflareWorkerProvider({
          repo: value.repo,
          target,
          token: "test-token",
          smokePassword: "test-password",
          fetcher: async (input: string | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            requests.push({ url, method: init?.method ?? "GET" });
            expect(JSON.parse(String(init?.body))).toEqual({
              name: "AUTH_PASSWORD_HASH",
              type: "secret_text",
              text: hash,
            });
            return Response.json(
              status === 200
                ? {
                    success: true,
                    result: { name: "AUTH_PASSWORD_HASH", type: "secret_text" },
                  }
                : { success: false, error: hash },
              { status },
            );
          },
        });
      expect(await makeProvider(200).putAuthSecret({ hash })).toEqual({
        name: "AUTH_PASSWORD_HASH",
        type: "secret_text",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("PUT");
      expect(requests[0]?.url.pathname).toBe(
        `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${target.workerName}/secrets`,
      );
      const failure = await makeProvider(403)
        .putAuthSecret({ hash })
        .catch((error) => error);
      expect(failure.message).not.toContain(hash);
      expect(requests).toHaveLength(2);
    }));

  test("auth code snapshot reads raw predecessor bytes without assuming the new bundle", () =>
    cleanFixture(async (value) => {
      const target = await integrationTarget(value);
      const oldCode =
        "export default { fetch() { return new Response('old'); } };";
      const provider = createCloudflareWorkerProvider({
        repo: value.repo,
        target,
        token: "test-token",
        smokePassword: "test-password",
        fetcher: async () =>
          moduleContentResponse(oldCode, {
            entrypoint: "worker.js",
            partName: "worker.js",
            filename: "worker.js",
            mediaType: "application/javascript",
          }),
      });
      expect(
        await provider.snapshotVersionCode({ versionId: OLD_VERSION }),
      ).toEqual({
        kind: "yurucommu.worker-version-code@v1",
        versionId: OLD_VERSION,
        sha256: sha256(oldCode),
        size: Buffer.byteLength(oldCode),
      });
    }));
});
