import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  access,
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAuthoritativeAbsence,
  assertCurrentResourceOutputIds,
  assertResourceIdentity,
  assertReadyResource,
  assertLifecycleNotTerminated,
  buildSafeChildEnvironment,
  buildResourceReadUrl,
  buildTofuCommand,
  buildLiveCheckpointEvidence,
  buildLiveCheckpointReleaseSignal,
  cleanupTakoformV1E2E,
  copyCapsuleToWorkdir,
  CURRENT_RESOURCE_TYPES,
  extractAppliedResourceIdentities,
  parseProviderSchemaProof,
  prepareLiveCheckpointTarget,
  parseStableHostDiscovery,
  prepareProviderDevOverride,
  PROVIDER_SCHEMA_OUTPUT_MAX_BYTES,
  readProviderVersion,
  readLiveCheckpointConfig,
  readTakoformV1E2EConfig,
  responseJson,
  runLiveCheckpointGate,
  runBoundedChild,
  digestLiveCheckpointEvidence,
  installLifecycleSignalHandlers,
  waitForLiveCheckpointRelease,
  writeLiveCheckpoint,
} from "./takoform-v1-e2e-full.ts";

const provider = {
  TAKOFORM_PROVIDER_BINARY: "/tmp/terraform-provider-takoform",
  TAKOFORM_PROVIDER_SHA256:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const discoveryFeatures = {
  service_forms: true,
  exact_form_ref: true,
  optimistic_concurrency: true,
  idempotent_lifecycle: true,
  operations: true,
  artifact_upload: true,
  support_profiles: true,
};

const sha256Fixture = (digit: string): `sha256:${string}` =>
  `sha256:${digit.repeat(64)}`;

function liveCheckpointEvidenceInput() {
  return {
    runId: "yurucommu-e2e-proof1",
    nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    createdAt: "2026-08-30T10:00:00.000Z",
    capsule: {
      source: {
        sourceHead: "0123456789abcdef0123456789abcdef01234567",
        workspaceDirty: false,
        workspaceStateDigest: sha256Fixture("1"),
        module: { "main.tf": sha256Fixture("2") },
        moduleFiles: [
          {
            path: "main.tf",
            bytes: 12,
            sha256: sha256Fixture("2"),
          },
        ],
        worker: {
          path: ".generated/yurucommu-worker.js",
          bytes: 99,
          sha256: sha256Fixture("3"),
        },
        migrations: [
          {
            path: "migrations/sql/0001_init.sql",
            bytes: 42,
            sha256: sha256Fixture("4"),
          },
        ],
        providerConstraint: "= 3.0.0" as const,
      },
      provider: {
        source: "registry.terraform.io/tako0614/takoform",
        sha256: sha256Fixture("5"),
        schema: {
          source: "registry.terraform.io/tako0614/takoform",
          providerVersion: "3.0.0" as const,
          versionConstraint: "= 3.0.0" as const,
          protocolSchemaVersion: 0,
          resourceKinds: ["takoform_worker_endpoint"],
        },
      },
    },
    run: { resourceCount: 13, screenshotExpected: false },
    runtime: {
      launchUrl: "https://worker.example.test/",
      apiUrl: "https://worker.example.test/api",
      probeUrl: "https://worker.example.test/",
      endpointClassification: "assigned-worker-endpoint" as const,
    },
  };
}

function runtimeProbeEvidenceFixture() {
  return {
    healthz: { status: "ok", missingBindings: [] },
    readyz: { status: "ok", missingBindings: [] },
    socialServer: { product: "yurucommu" },
    nodeinfo: {
      software: "yurucommu",
      users: 3,
      localPosts: 4,
    },
  } as const;
}

describe("Takoform stable-v1 full lifecycle E2E helpers", () => {
  test("requires a bare caller-supplied Host origin", () => {
    const config = readTakoformV1E2EConfig({
      ...provider,
      TAKOFORM_ENDPOINT: "https://forms.example.test/",
      TAKOFORM_SPACE: "e2e-space",
      TAKOFORM_TOKEN: "operator-token",
      TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
    });
    expect(config.endpoint).toBe("https://forms.example.test");
    expect(() =>
      readTakoformV1E2EConfig({
        ...provider,
        TAKOFORM_ENDPOINT: "https://forms.example.test/v1",
        TAKOFORM_SPACE: "e2e-space",
        TAKOFORM_TOKEN: "operator-token",
        TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
      }),
    ).toThrow("must be a bare origin");
  });

  test("separates the Provider writer token from direct evidence readback", () => {
    const config = readTakoformV1E2EConfig({
      ...provider,
      TAKOFORM_ENDPOINT: "https://forms.example.test",
      TAKOFORM_SPACE: "e2e-space",
      TAKOFORM_TOKEN: "writer-token",
      TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
    });
    expect(config.writerToken).toBe("writer-token");
    expect(config.evidenceToken).toBe("evidence-token");
    const child = buildSafeChildEnvironment(
      {
        PATH: "/safe/bin",
        TAKOFORM_TOKEN: "inherited-writer-token",
        TAKOFORM_EVIDENCE_TOKEN: "inherited-evidence-token",
      },
      config,
    );
    expect(child.TAKOFORM_TOKEN).toBe("writer-token");
    expect(child).not.toHaveProperty("TAKOFORM_EVIDENCE_TOKEN");
    expect(() =>
      readTakoformV1E2EConfig({
        ...provider,
        TAKOFORM_ENDPOINT: "https://forms.example.test",
        TAKOFORM_SPACE: "e2e-space",
        TAKOFORM_TOKEN: "writer-token",
      }),
    ).toThrow("TAKOFORM_EVIDENCE_TOKEN");
  });

  test("bounds child commands with an operator-selected hard timeout", () => {
    const config = readTakoformV1E2EConfig({
      ...provider,
      TAKOFORM_ENDPOINT: "https://forms.example.test",
      TAKOFORM_SPACE: "e2e-space",
      TAKOFORM_TOKEN: "operator-token",
      TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
      TAKOFORM_E2E_TIMEOUT_SECONDS: "7",
    });
    expect(config.commandTimeoutMs).toBe(7_000);
    expect(() =>
      readTakoformV1E2EConfig({
        ...provider,
        TAKOFORM_ENDPOINT: "https://forms.example.test",
        TAKOFORM_SPACE: "e2e-space",
        TAKOFORM_TOKEN: "operator-token",
        TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
        TAKOFORM_E2E_TIMEOUT_SECONDS: "0",
      }),
    ).toThrow("must be between");
    expect(() =>
      readTakoformV1E2EConfig({
        ...provider,
        TAKOFORM_ENDPOINT: "https://forms.example.test",
        TAKOFORM_SPACE: "e2e-space",
        TAKOFORM_TOKEN: "operator-token",
        TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
        TAKOFORM_E2E_TIMEOUT_SECONDS: "1.5",
      }),
    ).toThrow("integer");
  });

  test("passes only the allowlisted child environment", () => {
    const child = buildSafeChildEnvironment(
      {
        PATH: "/safe/bin",
        HOME: "/safe/home",
        TAKOFORM_TOKEN: "canary-token",
        TAKOFORM_ENDPOINT: "https://attacker.invalid",
        TF_LOG: "TRACE",
        TF_LOG_PATH: "/tmp/canary.log",
        TF_CLI_ARGS: "-plugin-dir=/tmp/canary",
        AWS_SECRET_ACCESS_KEY: "canary-secret",
        GITHUB_TOKEN: "canary-github-token",
      },
      {
        endpoint: "https://forms.example.test",
        space: "e2e-space",
        writerToken: "operator-token",
      },
      "/tmp/e2e-workdir",
    );
    expect(child).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      TAKOFORM_ENDPOINT: "https://forms.example.test",
      TAKOFORM_SPACE: "e2e-space",
      TAKOFORM_TOKEN: "operator-token",
      TF_DATA_DIR: "/tmp/e2e-workdir/.tofu-data",
      TF_IN_AUTOMATION: "1",
    });
    expect(child).not.toHaveProperty("TF_LOG");
    expect(child).not.toHaveProperty("TF_LOG_PATH");
    expect(child).not.toHaveProperty("TF_CLI_ARGS");
    expect(child).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(child).not.toHaveProperty("GITHUB_TOKEN");
  });

  test("builds apply and destroy without secret or fixture arguments", () => {
    expect(buildTofuCommand("apply", "yurucommu-e2e-abc")).toEqual([
      "apply",
      "-auto-approve",
      "-input=false",
      "-no-color",
      "-var=project_name=yurucommu-e2e-abc",
    ]);
    expect(buildTofuCommand("destroy", "yurucommu-e2e-abc")[0]).toBe("destroy");
    expect(() => buildTofuCommand("apply", "bad_name")).toThrow(
      "projectName is not a valid",
    );
  });

  test("negotiates only the stable same-origin Host API", () => {
    const result = parseStableHostDiscovery("https://forms.example.test", {
      api_versions: ["forms.takoform.com/v1"],
      features: discoveryFeatures,
      endpoints: {
        api: "https://forms.example.test/apis/forms.takoform.com/v1",
      },
    });
    expect(result.apiBase).toBe(
      "https://forms.example.test/apis/forms.takoform.com/v1",
    );
    expect(() =>
      parseStableHostDiscovery("https://forms.example.test", {
        api_versions: ["forms.takoform.com/v1"],
        features: discoveryFeatures,
        endpoints: {
          api: "https://other.example.test/apis/forms.takoform.com/v1",
        },
      }),
    ).toThrow("same-origin");
  });

  test("uses every exact FormRef member for resource readback", () => {
    const url = new URL(
      buildResourceReadUrl(
        "https://forms.example.test/apis/forms.takoform.com/v1",
        {
          name: "yurucommu-e2e-abc-db",
          space: "space-a",
          form: {
            apiVersion: "edge.forms.takoform.com",
            kind: "SQLiteDatabase",
            definitionVersion: "0.1.0",
            schemaDigest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        },
      ),
    );
    expect(url.pathname).toBe(
      "/apis/forms.takoform.com/v1/resources/edge.forms.takoform.com/SQLiteDatabase/yurucommu-e2e-abc-db",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      space: "space-a",
      group: "edge.forms.takoform.com",
      kind: "SQLiteDatabase",
      definitionVersion: "0.1.0",
      schemaDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  test("extracts and requires the current 13 managed resources", () => {
    const kinds: Record<string, string> = {
      takoform_module_worker: "ModuleWorker",
      takoform_sqlite_database: "SQLiteDatabase",
      takoform_sqlite_migration_set: "SQLiteMigrationSet",
      takoform_sqlite_migration_application: "SQLiteMigrationApplication",
      takoform_edge_kv_namespace: "EdgeKVNamespace",
      takoform_at_least_once_queue: "AtLeastOnceQueue",
      takoform_worker_bundle: "WorkerBundle",
      takoform_worker_version: "WorkerVersion",
      takoform_worker_deployment: "WorkerDeployment",
      takoform_worker_endpoint: "WorkerEndpoint",
      takoform_queue_consumer: "QueueConsumer",
      takoform_worker_cron_trigger: "WorkerCronTrigger",
    };
    const resources = CURRENT_RESOURCE_TYPES.map((type, index) => ({
      address: `module.${type}.${index}`,
      mode: "managed",
      type,
      name: type,
      values: {
        name: `e2e-resource-${index}`,
        space: "e2e-space",
        uid: `uid-${index}`,
        generation: "1",
        form_api_version: "edge.forms.takoform.com",
        form_kind: kinds[type],
        form_definition_version: "0.1.0",
        form_schema_digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }));
    const identities = extractAppliedResourceIdentities({
      values: { root_module: { resources } },
    });
    expect(identities).toHaveLength(13);
    expect(identities[3]?.form.kind).toBe("SQLiteMigrationApplication");
    expect(() =>
      extractAppliedResourceIdentities({
        values: { root_module: { resources: resources.slice(0, 12) } },
      }),
    ).toThrow("current 13-resource graph");
  });

  test("prepares migrations from a fresh source archive before tofu", async () => {
    const archiveRoot = await mkdtemp(
      join(tmpdir(), "yurucommu-archive-test-"),
    );
    const archivePath = join(archiveRoot, "source.tar");
    const sourceRoot = join(archiveRoot, "source");
    const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
    try {
      const archive = Bun.spawnSync({
        // Exercise the exact tracked inputs consumed by sourceBuild without
        // paying to inflate unrelated product assets into this focused
        // archive. A full repository archive can take tens of seconds on a
        // cold checkout and made the portable gate depend on filesystem
        // timing rather than on the Capsule contract under test.
        cmd: [
          "git",
          "archive",
          "--format=tar",
          "HEAD",
          "--",
          ".well-known/takosumi.json",
          "release.lock.json",
          "scripts/prepare-takoform-v1-source.ts",
          "deploy/takoform/migrations",
        ],
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(archive.exitCode).toBe(0);
      await writeFile(archivePath, archive.stdout);
      await mkdir(sourceRoot, { recursive: true });
      const extraction = Bun.spawnSync({
        cmd: ["tar", "-xf", archivePath, "-C", sourceRoot],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(extraction.exitCode).toBe(0);

      const manifest = JSON.parse(
        await readFile(join(sourceRoot, ".well-known/takosumi.json"), "utf8"),
      ) as {
        install: {
          modules: {
            "deploy/takoform": {
              sourceBuild: {
                commands: Array<{ argv: string[] }>;
                outputs: string[];
              };
            };
          };
        };
      };
      const sourceBuild =
        manifest.install.modules["deploy/takoform"].sourceBuild;
      expect(sourceBuild.commands.map((command) => command.argv)).toEqual([
        ["bun", "install", "--frozen-lockfile"],
        ["bun", "run", "build:worker"],
        ["bun", "scripts/prepare-takoform-v1-source.ts"],
      ]);
      expect(sourceBuild.outputs).toEqual([
        "deploy/takoform/.generated/yurucommu-worker.js",
        "deploy/takoform/migrations/sql",
      ]);
      const releaseLock = JSON.parse(
        await readFile(join(sourceRoot, "release.lock.json"), "utf8"),
      ) as { releases?: Record<string, { commit?: string }> };
      expect(releaseLock.releases?.["v2.1.8"]?.commit).toBe(
        "c2f6e50747f8bc2a3c4e80305c04b78aea1b505b",
      );
      await access(join(sourceRoot, "deploy/takoform/migrations/sql"));

      // The runner's build command supplies the Worker. The migration inputs
      // are already in the archive, while the final sourceBuild command
      // verifies and refreshes them from the repository bundle.
      await mkdir(join(sourceRoot, "dist"), { recursive: true });
      await writeFile(
        join(sourceRoot, "dist/yurucommu-worker.js"),
        "export default { fetch() { return new Response('ok') } };\n",
      );
      const preparation = Bun.spawnSync({
        cmd: sourceBuild.commands[2]?.argv ?? [],
        cwd: sourceRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(preparation.exitCode).toBe(0);

      const migrationRoot = join(sourceRoot, "deploy/takoform/migrations/sql");
      const migrations = (await readdir(migrationRoot)).sort();
      const schemaBundle = JSON.parse(
        await readFile(
          join(sourceRoot, "deploy/takoform/migrations/schema-bundle.json"),
          "utf8",
        ),
      ) as { entries?: Array<{ name: string }> };
      expect(migrations.length).toBeGreaterThanOrEqual(1);
      expect(migrations).toEqual(
        (schemaBundle.entries ?? []).map((entry) => entry.name).sort(),
      );
      await access(
        join(sourceRoot, "deploy/takoform/.generated/yurucommu-worker.js"),
      );
    } finally {
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });

  test("requires Ready=True status and the exact absence error", async () => {
    const ready = {
      metadata: { name: "resource", space: "space", uid: "uid" },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
      },
    };
    expect(() => assertReadyResource(ready, "resource")).not.toThrow();
    expect(() =>
      assertReadyResource(
        {
          ...ready,
          status: { conditions: [{ type: "Ready", status: "False" }] },
        },
        "resource",
      ),
    ).toThrow("Ready=True");
    await expect(
      assertAuthoritativeAbsence(
        Response.json(
          { error: { code: "resource_not_found" } },
          { status: 404 },
        ),
        "resource",
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertAuthoritativeAbsence(
        Response.json({}, { status: 404 }),
        "resource",
      ),
    ).rejects.toThrow("resource_not_found");
  });

  test("never copies a Host body into protocol errors", async () => {
    const canary = "host-secret-canary-token";
    await expect(
      responseJson(
        Response.json({ error: canary }, { status: 502 }),
        "Host readback",
        200,
      ),
    ).rejects.toThrow("HTTP 502");
    try {
      await responseJson(
        Response.json({ error: canary }, { status: 502 }),
        "Host readback",
        200,
      );
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  });

  test("requires every exact state identity on Host readback", () => {
    const identity = {
      address: "takoform_sqlite_database.database",
      type: "takoform_sqlite_database",
      name: "e2e-db",
      space: "e2e-space",
      uid: "uid-db",
      generation: "4",
      form: {
        apiVersion: "edge.forms.takoform.com",
        kind: "SQLiteDatabase",
        definitionVersion: "0.1.0",
        schemaDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    } as const;
    const body = {
      apiVersion: identity.form.apiVersion,
      kind: identity.form.kind,
      form: { formRef: identity.form },
      metadata: {
        name: identity.name,
        space: identity.space,
        uid: identity.uid,
        generation: identity.generation,
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    };
    expect(() => assertResourceIdentity(body, identity)).not.toThrow();
    expect(() =>
      assertResourceIdentity(
        { ...body, metadata: { ...body.metadata, uid: "other-uid" } },
        identity,
      ),
    ).toThrow("exact identity");
  });

  test("runs destroy and absence readback even when destroy fails", async () => {
    const calls: string[] = [];
    const result = await cleanupTakoformV1E2E({
      mutationAttempted: true,
      destroy: async () => {
        calls.push("destroy");
        throw new Error("destroy failed");
      },
      verifyAbsence: async () => {
        calls.push("absence");
      },
      removeWorkdir: async () => {
        calls.push("remove");
      },
      workdir: "/tmp/e2e-recovery",
    });
    expect(calls).toEqual(["destroy", "absence"]);
    expect(result.cleanupVerified).toBe(false);
    expect(result.preservedWorkdir).toBe(true);
    expect(result.error).toBeInstanceOf(AggregateError);

    const successCalls: string[] = [];
    const success = await cleanupTakoformV1E2E({
      mutationAttempted: true,
      destroy: async () => {
        successCalls.push("destroy");
      },
      verifyAbsence: async () => {
        successCalls.push("absence");
      },
      removeWorkdir: async () => {
        successCalls.push("remove");
      },
      workdir: "/tmp/e2e-recovery",
    });
    expect(successCalls).toEqual(["destroy", "absence", "remove"]);
    expect(success.cleanupVerified).toBe(true);
    expect(success.preservedWorkdir).toBe(false);
  });

  test("does not allow termination during cleanup to look like a pass", async () => {
    const removeSignalHandlers = installLifecycleSignalHandlers();
    const calls: string[] = [];
    try {
      const result = await cleanupTakoformV1E2E({
        mutationAttempted: true,
        destroy: async () => {
          calls.push("destroy");
        },
        verifyAbsence: async () => {
          calls.push("absence");
          process.emit("SIGTERM");
        },
        removeWorkdir: async () => {
          calls.push("remove");
        },
        workdir: "/tmp/e2e-recovery",
      });
      expect(calls).toEqual(["destroy", "absence", "remove"]);
      expect(result.cleanupVerified).toBe(true);
      expect(() => assertLifecycleNotTerminated()).toThrow(
        "received SIGTERM; cleanup requested",
      );
    } finally {
      removeSignalHandlers();
    }
  });

  test("removes a pre-mutation workdir without claiming lifecycle cleanup", async () => {
    let removed = false;
    const result = await cleanupTakoformV1E2E({
      mutationAttempted: false,
      destroy: async () => {
        throw new Error("must not run");
      },
      verifyAbsence: async () => {
        throw new Error("must not run");
      },
      removeWorkdir: async () => {
        removed = true;
      },
      workdir: "/tmp/e2e-recovery",
    });
    expect(removed).toBe(true);
    expect(result.cleanupVerified).toBe(false);
    expect(result.preservedWorkdir).toBe(false);
  });

  test("checks all 13 output identity keys", () => {
    const ids = Object.fromEntries(
      [
        "worker",
        "worker_bundle",
        "worker_version",
        "worker_deployment",
        "worker_endpoint",
        "database",
        "migration_set",
        "migration_application",
        "kv",
        "delivery",
        "delivery_dlq",
        "delivery_consumer",
        "retention",
      ].map((key) => [key, `uid-${key}`]),
    );
    expect(() => assertCurrentResourceOutputIds(ids)).not.toThrow();
    expect(() =>
      assertCurrentResourceOutputIds({ ...ids, unexpected: "uid" }),
    ).toThrow("all 13 current resources");
  });

  test("binds output UID map to the corresponding tofu state UID", () => {
    const identities = [
      ["takoform_module_worker", "worker", "uid-worker"],
      ["takoform_sqlite_database", "database", "uid-database"],
      ["takoform_sqlite_migration_set", "migration-set", "uid-migration-set"],
      [
        "takoform_sqlite_migration_application",
        "migration-application",
        "uid-migration-application",
      ],
      ["takoform_edge_kv_namespace", "kv", "uid-kv"],
      ["takoform_at_least_once_queue", "e2e-delivery", "uid-delivery"],
      ["takoform_at_least_once_queue", "e2e-delivery-dlq", "uid-delivery-dlq"],
      ["takoform_worker_bundle", "worker-bundle", "uid-worker-bundle"],
      ["takoform_worker_version", "worker-version", "uid-worker-version"],
      [
        "takoform_worker_deployment",
        "worker-deployment",
        "uid-worker-deployment",
      ],
      ["takoform_worker_endpoint", "worker-endpoint", "uid-worker-endpoint"],
      ["takoform_queue_consumer", "delivery-consumer", "uid-delivery-consumer"],
      ["takoform_worker_cron_trigger", "retention", "uid-retention"],
    ].map(([type, name, uid], index) => ({
      address: `resource.${index}`,
      type,
      name,
      space: "e2e-space",
      uid,
      generation: "1",
      form: {
        apiVersion: "edge.forms.takoform.com",
        kind: "Resource",
        definitionVersion: "0.1.0",
        schemaDigest: "sha256:" + "a".repeat(64),
      },
    }));
    const outputIds = {
      worker: "uid-worker",
      worker_bundle: "uid-worker-bundle",
      worker_version: "uid-worker-version",
      worker_deployment: "uid-worker-deployment",
      worker_endpoint: "uid-worker-endpoint",
      database: "uid-database",
      migration_set: "uid-migration-set",
      migration_application: "uid-migration-application",
      kv: "uid-kv",
      delivery: "uid-delivery",
      delivery_dlq: "uid-delivery-dlq",
      delivery_consumer: "uid-delivery-consumer",
      retention: "uid-retention",
    };
    expect(() =>
      assertCurrentResourceOutputIds(outputIds, identities),
    ).not.toThrow();
    expect(() =>
      assertCurrentResourceOutputIds(
        { ...outputIds, worker: "wrong-uid" },
        identities,
      ),
    ).toThrow("state UID");
  });

  test("copies only tracked module inputs and generated artifacts", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "takoform-source-test-"));
    const destination = await mkdtemp(join(tmpdir(), "takoform-copy-test-"));
    try {
      await mkdir(join(sourceRoot, ".generated"), { recursive: true });
      await mkdir(join(sourceRoot, "migrations", "sql"), { recursive: true });
      await mkdir(join(sourceRoot, "migrations", "takoform-overrides"));
      await mkdir(join(sourceRoot, "e2e"));
      await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
      await writeFile(join(sourceRoot, "outputs.tf"), 'output "x" {}\n');
      await writeFile(join(sourceRoot, "README.md"), "docs\n");
      await writeFile(
        join(sourceRoot, "migrations", "schema-bundle.json"),
        '{"entries":[]}\n',
      );
      await writeFile(
        join(sourceRoot, ".generated", "yurucommu-worker.js"),
        "export default {}\n",
      );
      await writeFile(
        join(sourceRoot, "migrations", "sql", "0001_init.sql"),
        "create table test (id integer);\n",
      );
      await writeFile(join(sourceRoot, "unexpected-secret.txt"), "canary\n");
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow("unexpected Takoform module source entry");
      await rm(join(sourceRoot, "unexpected-secret.txt"));
      await copyCapsuleToWorkdir(sourceRoot, destination);
      expect(await readFile(join(destination, "main.tf"), "utf8")).toContain(
        "terraform",
      );
      expect(
        await readFile(
          join(destination, "migrations", "sql", "0001_init.sql"),
          "utf8",
        ),
      ).toContain("create table");
      expect(await readdir(destination)).not.toContain("README.md");

      await writeFile(
        join(sourceRoot, "migrations", "unexpected-entry.txt"),
        "canary\n",
      );
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow(
        "unexpected Takoform migration source entry: unexpected-entry.txt",
      );
      await rm(join(sourceRoot, "migrations", "unexpected-entry.txt"));

      const migrationPath = join(
        sourceRoot,
        "migrations",
        "sql",
        "0001_init.sql",
      );
      await rm(migrationPath);
      await symlink(join(sourceRoot, "outputs.tf"), migrationPath);
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow(
        "tracked migration 0001_init.sql must be a regular file",
      );
      await rm(migrationPath);
      await writeFile(migrationPath, "create table test (id integer);\n");

      const migrationsDirectory = join(sourceRoot, "migrations", "sql");
      await rm(migrationsDirectory, { recursive: true, force: true });
      await symlink(
        join(sourceRoot, "migrations", "takoform-overrides"),
        migrationsDirectory,
      );
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow("tracked migration source must be a regular directory");
      await rm(migrationsDirectory, { force: true });
      await mkdir(migrationsDirectory);
      await writeFile(migrationPath, "create table test (id integer);\n");

      await rm(join(sourceRoot, "main.tf"));
      await symlink(
        join(sourceRoot, "outputs.tf"),
        join(sourceRoot, "main.tf"),
      );
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow("must be a regular file");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("rejects an untracked migration SQL file when repositoryRoot is supplied", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "takoform-source-test-"));
    const destination = await mkdtemp(join(tmpdir(), "takoform-copy-test-"));
    const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
    const untrackedMigration = join(
      sourceRoot,
      "migrations",
      "sql",
      "9999_untracked.sql",
    );
    try {
      await mkdir(join(sourceRoot, ".generated"), { recursive: true });
      await mkdir(join(sourceRoot, "migrations", "sql"), {
        recursive: true,
      });
      await mkdir(join(sourceRoot, "migrations", "takoform-overrides"));
      await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
      await writeFile(join(sourceRoot, "outputs.tf"), 'output "x" {}\n');
      await writeFile(
        join(sourceRoot, "migrations", "schema-bundle.json"),
        '{"entries":[]}\n',
      );
      await writeFile(
        join(sourceRoot, ".generated", "yurucommu-worker.js"),
        "export default {}\n",
      );
      await writeFile(untrackedMigration, "create table test (id integer);\n");

      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination, {
          repositoryRoot,
          environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("git ls-files failed with exit 1");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("terminates a child that ignores TERM within the hard timeout", async () => {
    await expect(
      runBoundedChild(
        [
          "bun",
          "-e",
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
        ],
        {
          cwd: process.cwd(),
          environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
          timeoutMs: 30,
          termGraceMs: 20,
          label: "hang-child",
        },
      ),
    ).rejects.toThrow("hang-child exceeded 30ms and was terminated");
  });

  test("bounds a descendant that keeps inherited pipes open and still permits cleanup", async () => {
    const startedAt = performance.now();
    await expect(
      runBoundedChild(["sh", "-c", "sleep 2 & exit 0"], {
        cwd: process.cwd(),
        environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
        timeoutMs: 100,
        termGraceMs: 50,
        label: "descendant-held-pipe",
      }),
    ).rejects.toThrow("descendant-held-pipe exceeded 100ms and was terminated");
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    const calls: string[] = [];
    const cleanup = await cleanupTakoformV1E2E({
      mutationAttempted: true,
      destroy: async () => {
        calls.push("destroy");
      },
      verifyAbsence: async () => {
        calls.push("absence");
      },
      removeWorkdir: async () => {
        calls.push("remove");
      },
      workdir: "/tmp/e2e-recovery",
    });
    expect(cleanup.cleanupVerified).toBe(true);
    expect(calls).toEqual(["destroy", "absence", "remove"]);
  });

  test("drains bounded child output after the capture cap without canceling pipes", async () => {
    const result = await runBoundedChild(
      [
        "bun",
        "-e",
        'const value = "x".repeat(300000); process.stdout.write(value); process.stderr.write(value);',
      ],
      {
        cwd: process.cwd(),
        environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
        timeoutMs: 5_000,
        maxOutputBytes: 64,
        label: "large-output-child",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputTruncated).toBe(true);
    expect(new TextEncoder().encode(result.stdout).byteLength).toBe(64);
    expect(new TextEncoder().encode(result.stderr).byteLength).toBe(64);
  });

  test("keeps the provider schema cap above the real v3 schema size", () => {
    const resourceSchemas = Object.fromEntries(
      [...new Set(CURRENT_RESOURCE_TYPES)].map((kind) => [kind, {}]),
    );
    const value = {
      provider_schemas: {
        "registry.terraform.io/tako0614/takoform": {
          version: 1,
          resource_schemas: resourceSchemas,
          filler: "x".repeat(232_998),
        },
      },
    };
    const payload = JSON.stringify(value);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(
      232_998,
    );
    expect(PROVIDER_SCHEMA_OUTPUT_MAX_BYTES).toBeGreaterThan(
      new TextEncoder().encode(payload).byteLength,
    );
    expect(
      parseProviderSchemaProof(JSON.parse(payload), "3.0.0").resourceKinds,
    ).toEqual([...new Set(CURRENT_RESOURCE_TYPES)].sort());
  });

  test("uses the verified Provider copy for the -version handshake", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "takoform-provider-source-"),
    );
    const workdir = await mkdtemp(join(tmpdir(), "takoform-provider-copy-"));
    const providerPath = join(sourceRoot, "terraform-provider-takoform");
    const original =
      '#!/bin/sh\nif [ "$1" = "-version" ]; then printf "3.0.0\\n"; else exit 9; fi\n';
    try {
      await writeFile(providerPath, original, { mode: 0o755 });
      await chmod(providerPath, 0o755);
      const providerSha256 = `sha256:${createHash("sha256").update(original).digest("hex")}`;
      const override = await prepareProviderDevOverride(
        { providerBinary: providerPath, providerSha256 },
        workdir,
      );
      expect(override.providerBinary).not.toBe(providerPath);
      expect(override.providerBinary).toContain("provider-dev-override");

      await writeFile(providerPath, '#!/bin/sh\nprintf "9.9.9\\n"\n', {
        mode: 0o755,
      });
      await chmod(providerPath, 0o755);
      await expect(
        readProviderVersion(
          override.providerBinary,
          buildSafeChildEnvironment({ PATH: process.env.PATH }),
          workdir,
          2_000,
        ),
      ).resolves.toBe("3.0.0");
      await expect(
        readProviderVersion(
          providerPath,
          buildSafeChildEnvironment({ PATH: process.env.PATH }),
          workdir,
          2_000,
        ),
      ).rejects.toThrow("did not report version 3.0.0");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("leaves the default lifecycle configuration unchanged without a checkpoint", () => {
    const config = readTakoformV1E2EConfig({
      ...provider,
      TAKOFORM_ENDPOINT: "https://forms.example.test",
      TAKOFORM_SPACE: "e2e-space",
      TAKOFORM_TOKEN: "writer-token",
      TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
    });
    expect(config).not.toHaveProperty("liveCheckpoint");
    expect(readLiveCheckpointConfig({})).toBeUndefined();
  });

  test("binds release to canonical full evidence and rejects a same-run URL rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    try {
      await chmod(root, 0o700);
      const target = await prepareLiveCheckpointTarget({
        checkpointPath: root,
        waitSeconds: 1,
      });
      const evidence = buildLiveCheckpointEvidence(
        liveCheckpointEvidenceInput(),
      );
      expect(digestLiveCheckpointEvidence(evidence)).toBe(
        "sha256:acf91f1e5a3b5760604ec7b06be632e08e8177acb4080e9b900609f0a9e52f23",
      );
      await writeLiveCheckpoint(target, evidence);
      const waiting = waitForLiveCheckpointRelease(target, {
        expectedEvidence: evidence,
        timeoutMs: 100,
        pollIntervalMs: 5,
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      const originalInput = liveCheckpointEvidenceInput();
      await writeLiveCheckpoint(
        target,
        buildLiveCheckpointEvidence({
          ...originalInput,
          runtime: {
            ...originalInput.runtime,
            launchUrl: "https://rewritten.example.test/",
            apiUrl: "https://rewritten.example.test/api",
            probeUrl: "https://rewritten.example.test/",
          },
        }),
      );
      await writeFile(
        target.releasePath,
        `${JSON.stringify(buildLiveCheckpointReleaseSignal(evidence))}\n`,
        { mode: 0o600 },
      );
      await expect(waiting).rejects.toThrow("checkpoint bytes changed");
      await expect(access(target.releasePath)).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns a sanitized screenshot and post-release runtime attestation", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    const screenshotPath = join(root, "owner-browser.png");
    try {
      await chmod(root, 0o700);
      expect(() =>
        readLiveCheckpointConfig({
          TAKOFORM_E2E_SCREENSHOT_PATH: screenshotPath,
        }),
      ).toThrow("requires TAKOFORM_E2E_CHECKPOINT_PATH");
      const checkpointConfig = readLiveCheckpointConfig({
        TAKOFORM_E2E_CHECKPOINT_PATH: root,
        TAKOFORM_E2E_SCREENSHOT_PATH: screenshotPath,
        TAKOFORM_E2E_CHECKPOINT_WAIT_SECONDS: "1",
      });
      expect(checkpointConfig?.screenshotPath).toBe(screenshotPath);
      const target = await prepareLiveCheckpointTarget(checkpointConfig!);
      const input = liveCheckpointEvidenceInput();
      const evidence = buildLiveCheckpointEvidence({
        ...input,
        run: { ...input.run, screenshotExpected: true },
      });
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(screenshotPath, png, { mode: 0o600 });
      await chmod(screenshotPath, 0o600);
      const release = buildLiveCheckpointReleaseSignal(evidence);
      await writeFile(target.releasePath, `${JSON.stringify(release)}\n`, {
        mode: 0o600,
      });
      const readbacks: string[] = [];
      const runtimeReadback = runtimeProbeEvidenceFixture();
      const attestation = await runLiveCheckpointGate(target, evidence, {
        timeoutMs: 100,
        pollIntervalMs: 5,
        postReleaseRuntimeReadback: async () => {
          readbacks.push("post-release");
          return { ...runtimeReadback, token: "must-not-be-attested" };
        },
      });
      expect(readbacks).toEqual(["post-release"]);
      expect(attestation).toMatchObject({
        kind: "yurucommu.takoform-v1-e2e-live-attestation@v1",
        state: "released-and-reprobed",
        checkpoint: {
          evidence,
          evidenceSha256:
            "sha256:127f66484f8a95f728655658ad5a3d71b4389bd35d254fd0ca22f5560599e498",
        },
        release: { signal: release },
        screenshot: {
          kind: "external-owner-png@v1",
          sha256:
            "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
          bytes: 68,
          width: 1,
          height: 1,
        },
        postReleaseRuntimeReadback: { evidence: runtimeReadback },
      });
      expect(JSON.stringify(attestation)).not.toContain(screenshotPath);
      expect(JSON.stringify(attestation)).not.toContain("must-not-be-attested");
      await expect(access(target.releasePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes sanitized checkpoint evidence and consumes the owner release once", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    try {
      await chmod(root, 0o700);
      const config = {
        checkpointPath: root,
        waitSeconds: 1,
      } as const;
      const target = await prepareLiveCheckpointTarget(config);
      const evidence = buildLiveCheckpointEvidence({
        ...liveCheckpointEvidenceInput(),
        runId: "yurucommu-e2e-abc123",
      });
      await writeLiveCheckpoint(target, {
        ...evidence,
        token: "must-not-be-written",
        environment: { TAKOFORM_TOKEN: "must-not-be-written" },
        terraformState: { credential: "must-not-be-written" },
        credentials: ["must-not-be-written"],
      } as typeof evidence & Record<string, unknown>);
      const checkpoint = JSON.parse(
        await readFile(target.checkpointPath, "utf8"),
      ) as Record<string, unknown>;
      expect(checkpoint).toEqual(
        evidence as unknown as Record<string, unknown>,
      );
      expect((await stat(target.checkpointPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(target.checkpointPath, "utf8")).not.toContain(
        "must-not-be-written",
      );
      expect(checkpoint).not.toHaveProperty("token");
      expect(checkpoint).not.toHaveProperty("environment");
      expect(checkpoint.state).toBe("awaiting-owner-release");
      expect(checkpoint).not.toHaveProperty("terraformState");
      expect(checkpoint).not.toHaveProperty("credentials");

      await writeFile(
        target.releasePath,
        `${JSON.stringify(buildLiveCheckpointReleaseSignal(evidence))}\n`,
        { mode: 0o600 },
      );
      await waitForLiveCheckpointRelease(target, {
        timeoutMs: 250,
        pollIntervalMs: 5,
        expectedEvidence: evidence,
      });
      await expect(access(target.releasePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        waitForLiveCheckpointRelease(target, {
          timeoutMs: 20,
          pollIntervalMs: 5,
          expectedEvidence: evidence,
        }),
      ).rejects.toThrow("release signal was not received");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects stale or malformed release content without consuming it", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    try {
      await chmod(root, 0o700);
      const target = await prepareLiveCheckpointTarget({
        checkpointPath: root,
        waitSeconds: 1,
      });
      const currentEvidence = buildLiveCheckpointEvidence({
        ...liveCheckpointEvidenceInput(),
        runId: "yurucommu-e2e-stale1",
      });
      const stale = buildLiveCheckpointReleaseSignal(
        buildLiveCheckpointEvidence({
          ...liveCheckpointEvidenceInput(),
          runId: "yurucommu-e2e-stale1",
          nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      );
      await writeFile(target.releasePath, `${JSON.stringify(stale)}\n`, {
        mode: 0o600,
      });
      await expect(
        runLiveCheckpointGate(target, currentEvidence, {
          timeoutMs: 100,
          pollIntervalMs: 5,
          postReleaseRuntimeReadback: async () => runtimeProbeEvidenceFixture(),
        }),
      ).rejects.toThrow("stale or for a different run");
      await expect(access(target.releasePath)).resolves.toBeNull();

      await writeFile(target.releasePath, "release\n", { mode: 0o600 });
      await expect(
        waitForLiveCheckpointRelease(target, {
          expectedEvidence: currentEvidence,
          timeoutMs: 100,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow("malformed");
      await expect(access(target.releasePath)).resolves.toBeNull();

      await rm(target.checkpointPath, { force: true });
      await expect(
        waitForLiveCheckpointRelease(target, {
          expectedEvidence: currentEvidence,
          timeoutMs: 100,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow("checkpoint file is missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects relative, linked, non-owner-only, and hard-linked checkpoint paths", async () => {
    expect(() =>
      readLiveCheckpointConfig({
        TAKOFORM_E2E_CHECKPOINT_PATH: "relative/checkpoint",
      }),
    ).toThrow("absolute");

    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    const linked = join(root, "linked");
    const regular = join(root, "regular.json");
    const hardlink = join(root, "hardlink.json");
    try {
      await chmod(root, 0o700);
      await mkdir(join(root, "owner-only"));
      await chmod(join(root, "owner-only"), 0o700);
      await symlink(join(root, "owner-only"), linked);
      await expect(
        prepareLiveCheckpointTarget({
          checkpointPath: linked,
          waitSeconds: 1,
        }),
      ).rejects.toThrow("symbolic link");

      await writeFile(regular, "existing\n", { mode: 0o600 });
      await chmod(regular, 0o644);
      await expect(
        prepareLiveCheckpointTarget({
          checkpointPath: regular,
          waitSeconds: 1,
        }),
      ).rejects.toThrow("owner-only");

      await chmod(regular, 0o600);
      const hardlinkSource = join(root, "hardlink-source.json");
      await writeFile(hardlinkSource, "existing\n", { mode: 0o600 });
      await link(hardlinkSource, hardlink);
      await expect(
        prepareLiveCheckpointTarget({
          checkpointPath: hardlink,
          waitSeconds: 1,
        }),
      ).rejects.toThrow("hard-linked");

      expect(() =>
        readLiveCheckpointConfig({
          TAKOFORM_E2E_CHECKPOINT_PATH: root,
          TAKOFORM_E2E_CHECKPOINT_WAIT_SECONDS: "901",
        }),
      ).toThrow("between 0 and 900");
      expect(() =>
        readLiveCheckpointConfig({
          TAKOFORM_E2E_CHECKPOINT_PATH: root,
          TAKOFORM_E2E_CHECKPOINT_WAIT_SECONDS: "3600",
        }),
      ).toThrow("between 0 and 900");

      const fakeWorktree = join(root, "fake-worktree");
      const worktreeTarget = join(fakeWorktree, "checkpoint");
      await mkdir(fakeWorktree);
      await writeFile(join(fakeWorktree, ".git"), "gitdir: /tmp\n", {
        mode: 0o600,
      });
      await mkdir(worktreeTarget);
      await chmod(worktreeTarget, 0o700);
      await expect(
        prepareLiveCheckpointTarget({
          checkpointPath: worktreeTarget,
          waitSeconds: 1,
        }),
      ).rejects.toThrow("outside every Git worktree");
      await expect(
        prepareLiveCheckpointTarget({
          checkpointPath: root,
          waitSeconds: 1,
          screenshotPath: join(fakeWorktree, "owner-browser.png"),
        }),
      ).rejects.toThrow("outside every Git worktree");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects linked screenshot evidence after post-release readback", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    const screenshotPath = join(root, "owner-browser.png");
    try {
      await chmod(root, 0o700);
      const target = await prepareLiveCheckpointTarget({
        checkpointPath: root,
        waitSeconds: 1,
        screenshotPath,
      });
      const pngSource = join(root, "source.png");
      await writeFile(
        pngSource,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
        { mode: 0o600 },
      );
      await link(pngSource, screenshotPath);
      const input = liveCheckpointEvidenceInput();
      const evidence = buildLiveCheckpointEvidence({
        ...input,
        run: { ...input.run, screenshotExpected: true },
      });
      await writeFile(
        target.releasePath,
        `${JSON.stringify(buildLiveCheckpointReleaseSignal(evidence))}\n`,
        { mode: 0o600 },
      );
      const readbacks: string[] = [];
      await expect(
        runLiveCheckpointGate(target, evidence, {
          timeoutMs: 100,
          pollIntervalMs: 5,
          postReleaseRuntimeReadback: async () => {
            readbacks.push("unexpected");
            return runtimeProbeEvidenceFixture();
          },
        }),
      ).rejects.toThrow("must not be hard-linked");
      expect(readbacks).toEqual(["unexpected"]);

      await rm(screenshotPath, { force: true });
      await rm(pngSource, { force: true });
      await writeFile(screenshotPath, Buffer.alloc(68), { mode: 0o600 });
      await writeFile(
        target.releasePath,
        `${JSON.stringify(buildLiveCheckpointReleaseSignal(evidence))}\n`,
        { mode: 0o600 },
      );
      await expect(
        runLiveCheckpointGate(target, evidence, {
          timeoutMs: 100,
          pollIntervalMs: 5,
          postReleaseRuntimeReadback: async () => {
            readbacks.push("invalid-png");
            return runtimeProbeEvidenceFixture();
          },
        }),
      ).rejects.toThrow("complete PNG");
      expect(readbacks).toEqual(["unexpected", "invalid-png"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an unsafe release signal and still runs existing cleanup after a timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    try {
      await chmod(root, 0o700);
      const target = await prepareLiveCheckpointTarget({
        checkpointPath: root,
        waitSeconds: 1,
      });
      const evidence = buildLiveCheckpointEvidence({
        ...liveCheckpointEvidenceInput(),
        runId: "yurucommu-e2e-unsafe1",
      });
      await writeLiveCheckpoint(target, evidence);
      const outside = join(root, "outside-release");
      await writeFile(outside, "do-not-consume\n", { mode: 0o600 });
      await rm(target.releasePath, { force: true });
      await symlink(outside, target.releasePath);
      await expect(
        waitForLiveCheckpointRelease(target, {
          expectedEvidence: evidence,
          timeoutMs: 25,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow("symbolic link");

      await rm(target.releasePath, { force: true });
      await expect(
        waitForLiveCheckpointRelease(target, {
          expectedEvidence: evidence,
          timeoutMs: 20,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow("release signal was not received");
      const calls: string[] = [];
      const cleanup = await cleanupTakoformV1E2E({
        mutationAttempted: true,
        destroy: async () => {
          calls.push("destroy");
        },
        verifyAbsence: async () => {
          calls.push("absence");
        },
        removeWorkdir: async () => {
          calls.push("remove");
        },
        workdir: "/tmp/live-checkpoint-recovery",
      });
      expect(cleanup.cleanupVerified).toBe(true);
      expect(calls).toEqual(["destroy", "absence", "remove"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("caps the exported checkpoint wait helper at 900 seconds", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    try {
      await chmod(root, 0o700);
      const target = await prepareLiveCheckpointTarget({
        checkpointPath: root,
        waitSeconds: 900,
      });
      const evidence = buildLiveCheckpointEvidence({
        ...liveCheckpointEvidenceInput(),
        runId: "yurucommu-e2e-cap900",
      });
      await writeLiveCheckpoint(target, evidence);
      await expect(
        waitForLiveCheckpointRelease(target, {
          expectedEvidence: evidence,
          timeoutMs: 900_001,
        }),
      ).rejects.toThrow("between 0 and 900000ms");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes checkpoint timeout through the existing cleanup path", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    try {
      await chmod(root, 0o700);
      const target = await prepareLiveCheckpointTarget({
        checkpointPath: root,
        waitSeconds: 1,
      });
      const calls: string[] = [];
      await expect(
        runLiveCheckpointGate(
          target,
          buildLiveCheckpointEvidence({
            ...liveCheckpointEvidenceInput(),
            runId: "yurucommu-e2e-timeout1",
          }),
          {
            timeoutMs: 20,
            pollIntervalMs: 5,
            postReleaseRuntimeReadback: async () =>
              runtimeProbeEvidenceFixture(),
          },
        ),
      ).rejects.toThrow("release signal was not received");
      const cleanup = await cleanupTakoformV1E2E({
        mutationAttempted: true,
        destroy: async () => {
          calls.push("destroy");
        },
        verifyAbsence: async () => {
          calls.push("absence");
        },
        removeWorkdir: async () => {
          calls.push("remove");
        },
        workdir: "/tmp/live-checkpoint-timeout-recovery",
      });
      expect(cleanup.cleanupVerified).toBe(true);
      expect(calls).toEqual(["destroy", "absence", "remove"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes checkpoint SIGTERM through the existing cleanup path", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    const removeSignalHandlers = installLifecycleSignalHandlers();
    try {
      await chmod(root, 0o700);
      const target = await prepareLiveCheckpointTarget({
        checkpointPath: root,
        waitSeconds: 900,
      });
      const calls: string[] = [];
      const waiting = runLiveCheckpointGate(
        target,
        buildLiveCheckpointEvidence({
          ...liveCheckpointEvidenceInput(),
          runId: "yurucommu-e2e-sigterm2",
        }),
        {
          timeoutMs: 900_000,
          pollIntervalMs: 10_000,
          postReleaseRuntimeReadback: async () => runtimeProbeEvidenceFixture(),
        },
      );
      setTimeout(() => process.emit("SIGTERM"), 5);
      await expect(waiting).rejects.toThrow("received SIGTERM");
      const cleanup = await cleanupTakoformV1E2E({
        mutationAttempted: true,
        destroy: async () => {
          calls.push("destroy");
        },
        verifyAbsence: async () => {
          calls.push("absence");
        },
        removeWorkdir: async () => {
          calls.push("remove");
        },
        workdir: "/tmp/live-checkpoint-sigterm-recovery",
      });
      expect(cleanup.cleanupVerified).toBe(true);
      expect(calls).toEqual(["destroy", "absence", "remove"]);
    } finally {
      removeSignalHandlers();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("aborts post-release runtime readback on SIGTERM before cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    const removeSignalHandlers = installLifecycleSignalHandlers();
    try {
      await chmod(root, 0o700);
      const target = await prepareLiveCheckpointTarget({
        checkpointPath: root,
        waitSeconds: 900,
      });
      const evidence = buildLiveCheckpointEvidence({
        ...liveCheckpointEvidenceInput(),
        runId: "yurucommu-e2e-sigterm3",
      });
      await writeFile(
        target.releasePath,
        `${JSON.stringify(buildLiveCheckpointReleaseSignal(evidence))}\n`,
        { mode: 0o600 },
      );
      const startedAt = performance.now();
      const waiting = runLiveCheckpointGate(target, evidence, {
        timeoutMs: 900_000,
        pollIntervalMs: 10_000,
        postReleaseRuntimeReadback: (signal) =>
          new Promise((_, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      });
      setTimeout(() => process.emit("SIGTERM"), 10);
      await expect(waiting).rejects.toThrow("received SIGTERM");
      expect(performance.now() - startedAt).toBeLessThan(500);
      const calls: string[] = [];
      const cleanup = await cleanupTakoformV1E2E({
        mutationAttempted: true,
        destroy: async () => {
          calls.push("destroy");
        },
        verifyAbsence: async () => {
          calls.push("absence");
        },
        removeWorkdir: async () => {
          calls.push("remove");
        },
        workdir: "/tmp/live-checkpoint-post-release-sigterm-recovery",
      });
      expect(cleanup.cleanupVerified).toBe(true);
      expect(calls).toEqual(["destroy", "absence", "remove"]);
    } finally {
      removeSignalHandlers();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("interrupts the checkpoint wait immediately when SIGTERM requests cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoform-live-checkpoint-"));
    const removeSignalHandlers = installLifecycleSignalHandlers();
    try {
      await chmod(root, 0o700);
      const target = await prepareLiveCheckpointTarget({
        checkpointPath: root,
        waitSeconds: 900,
      });
      const evidence = buildLiveCheckpointEvidence({
        ...liveCheckpointEvidenceInput(),
        runId: "yurucommu-e2e-sigterm1",
      });
      await writeLiveCheckpoint(target, evidence);
      const startedAt = performance.now();
      const waiting = waitForLiveCheckpointRelease(target, {
        expectedEvidence: evidence,
        timeoutMs: 60_000,
        pollIntervalMs: 10_000,
      });
      setTimeout(() => process.emit("SIGTERM"), 5);
      await expect(waiting).rejects.toThrow("received SIGTERM");
      expect(performance.now() - startedAt).toBeLessThan(500);
    } finally {
      removeSignalHandlers();
      await rm(root, { recursive: true, force: true });
    }
  });
});
