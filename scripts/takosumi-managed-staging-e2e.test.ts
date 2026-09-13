import { describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  assertManagedLauncher,
  assertManagedLauncherAbsent,
  assertExactDestroyedProjection,
  assertManagedResourceInventory,
  assertManagedResourceInventoryEmpty,
  assertDestroyRequiresApproval,
  assertInstallPlanProviderPin,
  assertRunProviderPin,
  assertRunType,
  assertReviewableRun,
  assertSourceSnapshotRunConsistency,
  decideCleanup,
  deriveManagedProviderBindings,
  assertTakoserverEvidenceCapabilityResponse,
  assertTakoserverOwnerDiscovery,
  assertTakoserverOwnerOpenApi,
  assertTakoserverNativeCapabilityResponse,
  assertTakoserverNativeAbsenceResponse,
  assertResourceExecutionEvidenceSequence,
  parseResourceExecutionEvidenceResponse,
  proveTakoserverEvidenceCapability,
  ManagedBrowserCleanupUncertainError,
  invokeManagedAppSessionOperation,
  readLiveAccountsSubject,
  readManagedResourceIdentities,
  MANAGED_MODULE_PATH,
  parseConfigurationPlanResponse,
  parseInstallPlanResponse,
  parseApprovedRunResponse,
  parseRunMutationResponse,
  readManagedStagingConfig,
  readTakosumiDeployReceipt,
  readPrivateFile,
  readPrivateFileForTest,
  validateManagedSessionCookie,
  STAGING_ENVIRONMENT,
  TAKOFORM_PROVIDER_SOURCE,
  type DestroyAcknowledgementInterval,
  runRequiresApproval,
} from "./takosumi-managed-staging-e2e.ts";
import { CURRENT_RESOURCE_GRAPH } from "./takoform-v1-e2e-full.ts";

const YURUCOMMU_REPOSITORY_URL = "https://github.com/tako0614/yurucommu.git";

const BASE_ENV = {
  TAKOSUMI_STAGING_URL: "https://app.example.test",
  TAKOSUMI_STAGING_DEPLOY_RECEIPT_FILE: "/run/private/takosumi-receipt.json",
  TAKOSUMI_STAGING_WORKSPACE_ID: "ws_staging",
  TAKOSUMI_STAGING_SESSION_TOKEN_FILE: "/run/private/takosumi-session",
  TAKOSERVER_STAGING_URL: "https://api.takoserver.example.test",
  TAKOSERVER_STAGING_ORGANIZATION_ID: "org_staging",
  TAKOSERVER_STAGING_EVIDENCE_CREDENTIAL_FILE:
    "/run/private/takoserver-evidence-token",
  TAKOSUMI_STAGING_SOURCE_URL: YURUCOMMU_REPOSITORY_URL,
  TAKOSUMI_STAGING_SOURCE_REF: "refs/heads/main",
  TAKOSUMI_STAGING_MODULE_PATH: MANAGED_MODULE_PATH,
  TAKOSUMI_STAGING_PROVIDER_CONNECTION_ID: "conn_takoform",
};

test("the managed staging sample names the canonical repository", async () => {
  const documentation = await readFile(
    new URL("../deploy/takoform/README.md", import.meta.url),
    "utf8",
  );
  const sourceUrl = documentation.match(
    /^TAKOSUMI_STAGING_SOURCE_URL=(\S+)/mu,
  )?.[1];
  if (!sourceUrl) {
    throw new Error("managed staging documentation is missing its source URL");
  }
  expect(sourceUrl).toBe(YURUCOMMU_REPOSITORY_URL);
  expect(BASE_ENV.TAKOSUMI_STAGING_SOURCE_URL).toBe(sourceUrl);
});

const TAKOSERVER_OWNER_ORIGIN = "https://api.takoserver.example.test";
const TAKOSERVER_EXECUTION_EVIDENCE_PATH =
  "/v1/organizations/{organizationId}/resources/{resourceUid}/execution-evidence";
const TAKOSERVER_NATIVE_RESIDUAL_PATH =
  "/v1/organizations/{organizationId}/resources/{resourceUid}/native-residual";

function ownerDiscovery(overrides: Record<string, unknown> = {}) {
  return {
    product: "takoserver",
    apiVersion: "v1",
    endpoints: {
      api: TAKOSERVER_OWNER_ORIGIN,
      openapi: `${TAKOSERVER_OWNER_ORIGIN}/openapi.json`,
      takoform: `${TAKOSERVER_OWNER_ORIGIN}/apis/forms.takoform.com/v1`,
    },
    ...overrides,
  };
}

function ownerOpenApi(overrides: Record<string, unknown> = {}) {
  const identifier = { type: "string", minLength: 1, maxLength: 128 };
  const errorRef = { $ref: "#/components/schemas/Error" };
  const evidenceRef = {
    $ref: "#/components/schemas/ResourceExecutionEvidenceResponse",
  };
  const executionOperation = {
    parameters: [
      {
        name: "organizationId",
        in: "path",
        required: true,
        schema: identifier,
      },
      { name: "resourceUid", in: "path", required: true, schema: identifier },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: {
          type: "string",
          minLength: 1,
          maxLength: 1024,
          pattern: "^[A-Za-z0-9_-]+$",
        },
      },
    ],
    responses: {
      "200": {
        content: { "application/json": { schema: evidenceRef } },
      },
      "400": { content: { "application/json": { schema: errorRef } } },
      "401": { content: { "application/json": { schema: errorRef } } },
      "403": { content: { "application/json": { schema: errorRef } } },
      "404": { content: { "application/json": { schema: errorRef } } },
      "503": { content: { "application/json": { schema: errorRef } } },
    },
  };
  const nativeOperation = {
    parameters: [
      {
        name: "space",
        in: "query",
        required: true,
        schema: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          pattern: "^space$",
        },
      },
      {
        name: "name",
        in: "query",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 128 },
      },
    ],
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["residual"],
              additionalProperties: false,
              properties: {
                residual: {
                  type: "object",
                  required: [
                    "status",
                    "source",
                    "effectCount",
                    "deploymentCount",
                    "checkedAt",
                  ],
                  additionalProperties: false,
                  properties: {
                    status: {
                      type: "string",
                      enum: ["absent", "present", "indeterminate"],
                    },
                    source: { type: "string", enum: ["intrinsic", "provider"] },
                    effectCount: { type: "integer", minimum: 0 },
                    deploymentCount: { type: "integer", minimum: 0 },
                    checkedAt: { type: "string", format: "date-time" },
                    evidenceRef: {
                      type: "string",
                      pattern: "^sha256:[a-f0-9]{64}$",
                    },
                    reason: {
                      type: "string",
                      enum: [
                        "closure_pending",
                        "effect_unresolved",
                        "deployment_active",
                        "deployment_unmarked",
                        "provider_unavailable",
                        "provider_readback_failed",
                        "provider_identity_missing",
                        "legacy_unattested",
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      "400": { content: { "application/json": { schema: errorRef } } },
      "401": { content: { "application/json": { schema: errorRef } } },
      "404": { content: { "application/json": { schema: errorRef } } },
      "503": { content: { "application/json": { schema: errorRef } } },
    },
  };
  return {
    openapi: "3.1.0",
    info: { title: "Takoserver API", version: "1.0.0", summary: "owner" },
    servers: [{ url: TAKOSERVER_OWNER_ORIGIN }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Error: { type: "object" },
        ResourceExecutionCommit: {
          type: "object",
          required: [
            "sequence",
            "operationId",
            "action",
            "outcome",
            "resourceVersion",
            "committedAt",
          ],
          additionalProperties: false,
          properties: {
            sequence: { type: "integer", minimum: 1 },
            operationId: { type: "string", minLength: 3, maxLength: 128 },
            action: { type: "string", enum: ["create", "update", "delete"] },
            outcome: { const: "committed" },
            resourceVersion: {
              type: "object",
              required: ["generation", "revision"],
              additionalProperties: false,
              properties: {
                generation: {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                  pattern: "^[0-9]+$",
                },
                revision: {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                  pattern: "^[0-9]+$",
                },
              },
            },
            committedAt: { type: "string", format: "date-time" },
          },
        },
        ResourceExecutionEvidence: {
          type: "object",
          required: [
            "format",
            "organizationId",
            "resource",
            "coverage",
            "snapshotFence",
            "commits",
          ],
          additionalProperties: false,
          properties: {
            format: { const: "takoserver.resource-execution-evidence/v1" },
            organizationId: identifier,
            resource: {
              type: "object",
              required: ["uid", "address", "formRef"],
              additionalProperties: false,
              properties: {
                uid: identifier,
                address: {
                  type: "object",
                  required: ["space", "apiVersion", "kind", "name"],
                  additionalProperties: false,
                  properties: {
                    space: {
                      type: "string",
                      minLength: 1,
                      maxLength: 255,
                      pattern: "^space$",
                    },
                    apiVersion: {
                      type: "string",
                      minLength: 1,
                      maxLength: 320,
                    },
                    kind: { type: "string", minLength: 1, maxLength: 128 },
                    name: {
                      type: "string",
                      minLength: 1,
                      maxLength: 128,
                      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
                    },
                  },
                },
                formRef: {
                  type: "object",
                  required: [
                    "apiVersion",
                    "kind",
                    "definitionVersion",
                    "schemaDigest",
                  ],
                  additionalProperties: false,
                  properties: {
                    apiVersion: {
                      type: "string",
                      minLength: 1,
                      maxLength: 320,
                    },
                    kind: { type: "string", minLength: 1, maxLength: 128 },
                    definitionVersion: {
                      type: "string",
                      minLength: 1,
                      maxLength: 128,
                    },
                    schemaDigest: {
                      type: "string",
                      pattern: "^sha256:[a-f0-9]{64}$",
                    },
                  },
                },
              },
            },
            coverage: { type: "string", enum: ["complete", "partial"] },
            snapshotFence: { type: "integer", minimum: 0 },
            commits: {
              type: "array",
              maxItems: 200,
              items: { $ref: "#/components/schemas/ResourceExecutionCommit" },
            },
          },
        },
        ResourceExecutionEvidenceResponse: {
          type: "object",
          required: ["executionEvidence"],
          additionalProperties: false,
          properties: {
            executionEvidence: {
              $ref: "#/components/schemas/ResourceExecutionEvidence",
            },
            cursor: {
              type: "string",
              minLength: 1,
              maxLength: 1024,
              pattern: "^[A-Za-z0-9_-]+$",
            },
          },
        },
      },
    },
    paths: {
      [TAKOSERVER_EXECUTION_EVIDENCE_PATH]: { get: executionOperation },
      [TAKOSERVER_NATIVE_RESIDUAL_PATH]: { get: nativeOperation },
    },
    ...overrides,
  };
}

const INVENTORY_LINEAGE = {
  capsuleId: "capsule_1",
  workspaceId: "ws_staging",
  environment: "staging",
  stateVersionId: "state_1",
  generation: 1,
  applyRunId: "apply_1",
  planRunId: "plan_1",
};

function inventoryProjection(
  resources = CURRENT_RESOURCE_GRAPH.map(({ address, type }) => ({
    address,
    type,
    providerSource: TAKOFORM_PROVIDER_SOURCE,
  })),
  overrides: Record<string, unknown> = {},
) {
  return {
    inventory: {
      kind: "takosumi.capsule-current-resource-inventory@v1",
      ...INVENTORY_LINEAGE,
      recordedAt: "2026-09-04T00:00:00.000Z",
      availability: "recorded",
      resources,
      ...overrides,
    },
  };
}

function outputProjection(
  workspaceOutputs: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    output: {
      id: "output_1",
      workspaceId: INVENTORY_LINEAGE.workspaceId,
      capsuleId: INVENTORY_LINEAGE.capsuleId,
      stateGeneration: INVENTORY_LINEAGE.generation,
      publicOutputs: { launch_url: "https://yurucommu.example.test/" },
      workspaceOutputs,
      outputDigest: `sha256:${"a".repeat(64)}`,
      createdAt: "2026-09-04T00:00:00.000Z",
      ...overrides,
    },
  };
}

describe("Takosumi managed staging contract", () => {
  test("is staging-only and keeps credentials in private files", () => {
    const config = readManagedStagingConfig(BASE_ENV);
    expect(config.takosumiOrigin).toBe("https://app.example.test");
    expect(config.timeoutMs).toBeGreaterThan(0);
    expect(config.sessionTokenFile).toBe("/run/private/takosumi-session");
    expect("sessionCookieFile" in config).toBe(false);
    expect("probeActorApId" in config).toBe(false);
    expect(config.takoserverOwnerOrigin).toBe(
      "https://api.takoserver.example.test",
    );
    expect(config.takoserverOrganizationId).toBe("org_staging");
    expect(config.takoserverEvidenceCredentialFile).toBe(
      "/run/private/takoserver-evidence-token",
    );
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSUMI_STAGING_ENVIRONMENT: "production",
      }),
    ).toThrow("staging-only");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSUMI_STAGING_URL: "https://app.example.test/path",
      }),
    ).toThrow("bare origin");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSUMI_STAGING_SOURCE_URL:
          "https://user:secret@example.test/yurucommu.git",
      }),
    ).toThrow("credential-free");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSUMI_STAGING_EXPECTED_VERSION_ID:
          "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("not accepted");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSUMI_STAGING_SESSION_COOKIE_FILE: "/run/private/yurucommu-session",
      }),
    ).toThrow("SESSION_COOKIE_FILE");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSUMI_STAGING_PROBE_ACTOR_AP_ID:
          "https://app.example.test/ap/users/e2e-probe",
      }),
    ).toThrow("PROBE_ACTOR_AP_ID");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSUMI_STAGING_PROBE_ACTOR_AP_ID: "",
      }),
    ).toThrow("PROBE_ACTOR_AP_ID");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSUMI_STAGING_MODULE_PATH: ".",
      }),
    ).toThrow("deploy/takoform");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSUMI_STAGING_PROVIDER_CONNECTIONS_FILE:
          "/run/private/provider-connections.json",
      }),
    ).toThrow("root module");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSERVER_STAGING_URL: "https://api.takoserver.example.test/path",
      }),
    ).toThrow("bare origin");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSERVER_STAGING_ORGANIZATION_ID: undefined,
      }),
    ).toThrow("TAKOSERVER_STAGING_ORGANIZATION_ID");
    expect(() =>
      readManagedStagingConfig({
        ...BASE_ENV,
        TAKOSERVER_STAGING_EVIDENCE_CREDENTIAL_FILE: undefined,
      }),
    ).toThrow("TAKOSERVER_STAGING_EVIDENCE_CREDENTIAL_FILE");
  });

  test("requires a canonical live Accounts session subject", () => {
    const expiresAt = Date.now() + 60_000;
    expect(
      readLiveAccountsSubject({
        subject: "tsub_live",
        createdAt: 0,
        expiresAt,
      }),
    ).toBe("tsub_live");
    expect(() =>
      readLiveAccountsSubject({
        session: null,
        createdAt: 0,
        expiresAt,
      }),
    ).toThrow("valid live subject");
    expect(() =>
      readLiveAccountsSubject({
        subject: "not-a-subject",
        createdAt: 0,
        expiresAt,
      }),
    ).toThrow("valid live subject");
    expect(() =>
      readLiveAccountsSubject({
        subject: "tsub_expired",
        createdAt: 0,
        expiresAt: Date.now() - 1,
      }),
    ).toThrow("timestamps");
    expect(() =>
      readLiveAccountsSubject({
        subject: "tsub_reversed",
        createdAt: expiresAt + 1,
        expiresAt,
      }),
    ).toThrow("timestamps");
    expect(() =>
      readLiveAccountsSubject({
        subject: "tsub_negative",
        createdAt: -1,
        expiresAt,
      }),
    ).toThrow("timestamps");
  });

  test("bounds, cancels, and sanitizes one browser operation", async () => {
    let calls = 0;
    let closeCalls = 0;
    const result = await invokeManagedAppSessionOperation(
      "Accounts identity preflight",
      100,
      async (signal) => {
        calls += 1;
        expect(signal.aborted).toBe(false);
        return "ok";
      },
      async () => {
        closeCalls += 1;
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(closeCalls).toBe(0);

    let timedOutCalls = 0;
    const timeoutEvents: string[] = [];
    await expect(
      invokeManagedAppSessionOperation(
        "application session acquisition",
        20,
        (signal) => {
          timedOutCalls += 1;
          timeoutEvents.push("operation");
          signal.addEventListener("abort", () => timeoutEvents.push("abort"), {
            once: true,
          });
          return new Promise<never>(() => undefined);
        },
        async () => {
          timeoutEvents.push("close");
        },
      ),
    ).rejects.toThrow("timed out");
    expect(timedOutCalls).toBe(1);
    expect(timeoutEvents).toEqual(["operation", "abort", "close"]);

    const sanitizedFailure = await invokeManagedAppSessionOperation(
      "application session acquisition",
      100,
      async () => {
        throw new Error("raw browser URL and token must not escape");
      },
      async () => undefined,
    ).catch((error: unknown) => error);
    expect(sanitizedFailure).toBeInstanceOf(Error);
    expect((sanitizedFailure as Error).message).toBe(
      "application session acquisition failed",
    );
    expect((sanitizedFailure as Error).message).not.toContain("token");

    const closeFailure = await invokeManagedAppSessionOperation(
      "application session acquisition",
      100,
      async () => {
        throw new Error("raw browser failure");
      },
      async () => {
        throw new Error("raw close failure");
      },
      20,
    ).catch((error: unknown) => error);
    expect(closeFailure).toBeInstanceOf(ManagedBrowserCleanupUncertainError);
    expect((closeFailure as Error).message).toBe(
      "managed browser shutdown was not confirmed",
    );

    const closeTimeout = await invokeManagedAppSessionOperation(
      "application session acquisition",
      100,
      async () => {
        throw new Error("raw browser timeout");
      },
      () => new Promise<void>(() => undefined),
      20,
    ).catch((error: unknown) => error);
    expect(closeTimeout).toBeInstanceOf(ManagedBrowserCleanupUncertainError);
  });

  test("accepts only one in-memory app session cookie header", () => {
    expect(
      validateManagedSessionCookie({ sessionCookie: "session=opaque_1" }),
    ).toBe("session=opaque_1");
    for (const value of [
      " session=opaque_1",
      "session=opaque_1 ",
      "session=opaque_1; other=value",
      "session=opaque_1\nother=value",
      "takosumi_session=opaque_1",
      "session=",
    ]) {
      expect(() =>
        validateManagedSessionCookie({ sessionCookie: value }),
      ).toThrow("invalid session cookie");
    }
  });

  test("derives an exact single Takoform binding for the managed module", () => {
    expect(
      deriveManagedProviderBindings(
        [
          {
            provider: TAKOFORM_PROVIDER_SOURCE,
            moduleLocalName: "takoform",
            version: "4.0.0",
          },
        ],
        "conn_takoform",
      ),
    ).toEqual([
      {
        provider: TAKOFORM_PROVIDER_SOURCE,
        moduleLocalName: "takoform",
        connectionId: "conn_takoform",
      },
    ]);
    expect(() =>
      deriveManagedProviderBindings(
        [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            moduleLocalName: "cloudflare",
          },
        ],
        "conn_takoform",
      ),
    ).toThrow("requires only");
    expect(() =>
      deriveManagedProviderBindings(
        [
          {
            provider: TAKOFORM_PROVIDER_SOURCE,
            moduleLocalName: "takoform",
          },
        ],
        "conn_takoform",
      ),
    ).toThrow("requires only");
  });

  test("requires the exact current fifteen-resource inventory", () => {
    const inventory = inventoryProjection();
    expect(() => assertManagedResourceInventory(inventory)).not.toThrow();
    expect(() =>
      assertManagedResourceInventory({
        inventory: {
          ...inventory.inventory,
          resources: inventory.inventory.resources.slice(1),
        },
      }),
    ).toThrow("all 15");
    expect(() =>
      assertManagedResourceInventory({
        inventory: {
          ...inventory.inventory,
          resources: inventory.inventory.resources.map(({ address, type }) => ({
            address,
            type,
          })),
        },
      }),
    ).toThrow("omitted");
    expect(() =>
      assertManagedResourceInventory({
        inventory: { ...inventory.inventory, value: "secret" },
      }),
    ).toThrow("closed");
    expect(() =>
      assertManagedResourceInventory({
        inventory: {
          ...inventory.inventory,
          resources: inventory.inventory.resources.map((resource, index) =>
            index === 0 ? { ...resource, value: "secret" } : resource,
          ),
        },
      }),
    ).toThrow("closed");
    expect(() =>
      assertManagedResourceInventory(inventory, [TAKOFORM_PROVIDER_SOURCE], {
        ...INVENTORY_LINEAGE,
        applyRunId: "apply_other",
      }),
    ).toThrow("ApplyRun identity");
  });

  test("requires an empty current inventory and no launcher after destroy", () => {
    expect(() =>
      assertManagedResourceInventoryEmpty(inventoryProjection([])),
    ).not.toThrow();
    expect(() =>
      assertManagedResourceInventoryEmpty({
        ...inventoryProjection([]),
        inventory: {
          ...inventoryProjection([]).inventory,
          resources: [
            {
              address: CURRENT_RESOURCE_GRAPH[0]!.address,
              type: CURRENT_RESOURCE_GRAPH[0]!.type,
              providerSource: TAKOFORM_PROVIDER_SOURCE,
            },
          ],
        },
      }),
    ).toThrow("not empty");
    expect(() =>
      assertManagedResourceInventoryEmpty({
        inventory: {
          ...inventoryProjection([]).inventory,
          availability: "legacy_unavailable",
        },
      }),
    ).toThrow("recorded projection");
    expect(() => assertManagedLauncherAbsent({ interfaces: [] })).not.toThrow();
    expect(() =>
      assertManagedLauncherAbsent({
        interfaces: [
          {
            spec: { type: "interface.ui.surface", version: "1" },
            status: { phase: "Resolved" },
          },
        ],
      }),
    ).toThrow("still exposed");
    expect(() =>
      assertManagedLauncherAbsent({
        interfaces: [
          {
            spec: { type: "interface.ui.surface", version: "1" },
            status: { phase: "Pending" },
          },
        ],
      }),
    ).toThrow("still exposed");
  });

  test("runs every Takosumi absence projection after Destroy Apply", async () => {
    const calls: string[] = [];
    const capsuleId = "capsule_1";
    const workspaceId = "ws_staging";
    const api = {
      origin: "https://app.example.test",
      token: "token",
      transport: {},
      async requestJson(path: string) {
        calls.push(path);
        if (path.endsWith(`/capsules/${capsuleId}`)) {
          return {
            capsule: {
              id: capsuleId,
              workspaceId,
              currentStateGeneration: 2,
              currentStateVersionId: "state_destroyed",
              status: "destroyed",
            },
          };
        }
        if (path.endsWith(`/capsules/${capsuleId}/outputs`)) {
          return { output: null };
        }
        if (path.endsWith(`/capsules/${capsuleId}/provider-bindings`)) {
          return { providerBindingSet: null };
        }
        if (
          path.endsWith(`/capsules/${capsuleId}/current-resource-inventory`)
        ) {
          return {
            inventory: {
              kind: "takosumi.capsule-current-resource-inventory@v1",
              capsuleId,
              workspaceId,
              environment: "staging",
              stateVersionId: "state_destroyed",
              generation: 2,
              applyRunId: "destroy_apply_1",
              planRunId: "destroy_plan_1",
              recordedAt: "2026-09-04T00:00:00.000Z",
              availability: "recorded",
              resources: [],
            },
          };
        }
        if (path.includes("/ui-surfaces?")) return { interfaces: [] };
        throw new Error(`unexpected path ${path}`);
      },
    } as never;
    await expect(
      assertExactDestroyedProjection(api, {
        capsuleId,
        workspaceId,
        planRunId: "destroy_plan_1",
        applyRunId: "destroy_apply_1",
      }),
    ).resolves.toBeUndefined();
    expect(calls.some((path) => path.endsWith("/outputs"))).toBe(true);
    expect(calls.some((path) => path.endsWith("/provider-bindings"))).toBe(
      true,
    );
    expect(
      calls.some((path) => path.endsWith("/current-resource-inventory")),
    ).toBe(true);
    expect(calls.some((path) => path.includes("/ui-surfaces?"))).toBe(true);
  });

  test("aggregates projection failures without short-circuiting absence reads", async () => {
    const calls: string[] = [];
    const capsuleId = "capsule_1";
    const workspaceId = "ws_staging";
    const api = {
      origin: "https://app.example.test",
      token: "token",
      transport: {},
      async requestJson(path: string) {
        calls.push(path);
        if (path.endsWith(`/capsules/${capsuleId}`)) {
          return {
            capsule: {
              id: capsuleId,
              workspaceId,
              currentStateGeneration: 2,
              currentStateVersionId: "state_destroyed",
              status: "destroyed",
            },
          };
        }
        if (path.endsWith(`/capsules/${capsuleId}/outputs`)) {
          return { output: { stale: true } };
        }
        if (path.endsWith(`/capsules/${capsuleId}/provider-bindings`)) {
          return { providerBindingSet: null };
        }
        if (
          path.endsWith(`/capsules/${capsuleId}/current-resource-inventory`)
        ) {
          return {
            inventory: {
              kind: "takosumi.capsule-current-resource-inventory@v1",
              capsuleId,
              workspaceId,
              environment: "staging",
              stateVersionId: "state_destroyed",
              generation: 2,
              applyRunId: "destroy_apply_1",
              planRunId: "destroy_plan_1",
              recordedAt: "2026-09-04T00:00:00.000Z",
              availability: "recorded",
              resources: [],
            },
          };
        }
        if (path.includes("/ui-surfaces?")) return { interfaces: [] };
        throw new Error(`unexpected path ${path}`);
      },
    } as never;
    await expect(
      assertExactDestroyedProjection(api, {
        capsuleId,
        workspaceId,
        planRunId: "destroy_plan_1",
        applyRunId: "destroy_apply_1",
      }),
    ).rejects.toThrow("projection absence failed");
    expect(calls.some((path) => path.endsWith("/provider-bindings"))).toBe(
      true,
    );
    expect(
      calls.some((path) => path.endsWith("/current-resource-inventory")),
    ).toBe(true);
    expect(calls.some((path) => path.includes("/ui-surfaces?"))).toBe(true);
  });

  test("derives every managed Resource UID from the closed output projection", () => {
    const inventory = inventoryProjection();
    const resourceIds = Object.fromEntries(
      CURRENT_RESOURCE_GRAPH.map(({ outputKey }, index) => [
        outputKey,
        `uid_${index + 1}`,
      ]),
    );
    const identities = readManagedResourceIdentities(
      inventory,
      outputProjection({ takoform_resource_ids: resourceIds }),
    );
    expect(identities).toHaveLength(CURRENT_RESOURCE_GRAPH.length);
    expect(identities[0]).toEqual({
      address: CURRENT_RESOURCE_GRAPH[0]!.address,
      type: CURRENT_RESOURCE_GRAPH[0]!.type,
      outputKey: CURRENT_RESOURCE_GRAPH[0]!.outputKey,
      uid: "uid_1",
    });
    expect(() =>
      readManagedResourceIdentities(
        inventory,
        outputProjection({ takoform_resource_ids: {} }),
      ),
    ).toThrow("all 15");
    expect(() =>
      readManagedResourceIdentities(
        inventory,
        outputProjection(
          {
            takoform_resource_ids: resourceIds,
          },
          { publicOutputs: { takoform_resource_ids: resourceIds } },
        ),
      ),
    ).not.toThrow();
    expect(() =>
      readManagedResourceIdentities(
        inventory,
        outputProjection(
          {},
          { publicOutputs: { takoform_resource_ids: resourceIds } },
        ),
      ),
    ).toThrow("workspaceOutputs");
    expect(() =>
      readManagedResourceIdentities(
        inventory,
        outputProjection(
          { takoform_resource_ids: resourceIds },
          { capsuleId: "capsule_other" },
        ),
      ),
    ).toThrow("Output capsule identity");
  });

  test("requires authenticated versioned Takoserver evidence capability", () => {
    expect(() =>
      assertTakoserverEvidenceCapabilityResponse(404, {
        error: {
          code: "not_found",
          message: "not found",
          requestId: "req_capability",
          retryable: false,
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertTakoserverEvidenceCapabilityResponse(401, {
        error: {
          code: "unauthenticated",
          message: "unauthenticated",
          requestId: "req_capability",
          retryable: false,
        },
      }),
    ).toThrow("authenticated");
    expect(() =>
      assertTakoserverEvidenceCapabilityResponse(404, {
        error: {
          code: "not_found",
          message: "not found",
          requestId: "req_capability",
          retryable: false,
          details: { owner: true },
        },
      }),
    ).toThrow("closed");
  });

  test("proves the same-Worker Takoserver owner before authenticated negative probes", async () => {
    const calls: Array<{ path: string; authenticated: boolean }> = [];
    const result = await proveTakoserverEvidenceCapability({
      origin: TAKOSERVER_OWNER_ORIGIN,
      organizationId: "org_staging",
      async request(path, options = {}) {
        calls.push({
          path,
          authenticated: options.authenticated !== false,
        });
        if (path === "/.well-known/takoserver") {
          return { status: 200, body: ownerDiscovery() };
        }
        if (path === "/openapi.json") {
          return { status: 200, body: ownerOpenApi() };
        }
        if (path.endsWith("/execution-evidence")) {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found",
                message: "not found",
                requestId: "req_capability",
                retryable: false,
              },
            },
          };
        }
        return {
          status: 404,
          body: {
            error: {
              code: "resource_not_found",
              message: "resource not found",
              requestId: "req_native",
              retryable: false,
            },
          },
        };
      },
    });
    expect(result).toBeUndefined();
    expect(calls.slice(0, 2)).toEqual([
      { path: "/.well-known/takoserver", authenticated: false },
      { path: "/openapi.json", authenticated: false },
    ]);
    expect(calls.slice(2).every(({ authenticated }) => authenticated)).toBe(
      true,
    );
  });

  test("rejects a redirected owner OpenAPI before any authenticated probe", async () => {
    const calls: string[] = [];
    await expect(
      proveTakoserverEvidenceCapability({
        origin: TAKOSERVER_OWNER_ORIGIN,
        organizationId: "org_staging",
        async request(path) {
          calls.push(path);
          if (path === "/.well-known/takoserver") {
            return { status: 200, body: ownerDiscovery() };
          }
          if (path === "/openapi.json") {
            return {
              status: 302,
              body: {
                location: "https://other-owner.example.test/openapi.json",
              },
            };
          }
          throw new Error("authenticated probe should not run after redirect");
        },
      }),
    ).rejects.toThrow("OpenAPI");
    expect(calls).toEqual(["/.well-known/takoserver", "/openapi.json"]);
  });

  test("rejects the old f109 OpenAPI and generic 404 before InstallPlan mutation", async () => {
    const oldF109 = {
      ...ownerOpenApi(),
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
      paths: {
        "/v1/organizations/{organizationId}/resources/{resourceUid}": {
          get: { responses: { "404": { description: "not found" } } },
        },
      },
    };
    expect(() =>
      assertTakoserverOwnerOpenApi(oldF109, TAKOSERVER_OWNER_ORIGIN),
    ).toThrow();
    expect(() =>
      assertTakoserverOwnerDiscovery(ownerDiscovery(), TAKOSERVER_OWNER_ORIGIN),
    ).not.toThrow();
    const calls: string[] = [];
    await expect(
      proveTakoserverEvidenceCapability({
        origin: TAKOSERVER_OWNER_ORIGIN,
        organizationId: "org_staging",
        async request(path) {
          calls.push(path);
          if (path === "/.well-known/takoserver") {
            return { status: 200, body: ownerDiscovery() };
          }
          if (path === "/openapi.json") {
            return { status: 200, body: oldF109 };
          }
          throw new Error("authenticated probe should not run for old OpenAPI");
        },
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(["/.well-known/takoserver", "/openapi.json"]);
  });

  test("fails closed for malformed, redirected, cross-origin, missing-path, schema, and format owner contracts", () => {
    expect(() =>
      assertTakoserverOwnerDiscovery(
        ownerDiscovery({ product: "old-takoserver" }),
        TAKOSERVER_OWNER_ORIGIN,
      ),
    ).toThrow("product");
    expect(() =>
      assertTakoserverOwnerDiscovery(
        ownerDiscovery({
          endpoints: {
            ...ownerDiscovery().endpoints,
            openapi: "https://old-owner.example.test/openapi.json",
          },
        }),
        TAKOSERVER_OWNER_ORIGIN,
      ),
    ).toThrow("same-origin");
    expect(() =>
      assertTakoserverOwnerDiscovery(
        ownerDiscovery({ apiVersion: "v0" }),
        TAKOSERVER_OWNER_ORIGIN,
      ),
    ).toThrow("apiVersion");
    expect(() =>
      assertTakoserverOwnerOpenApi(
        ownerOpenApi({
          paths: {
            ...ownerOpenApi().paths,
            [TAKOSERVER_EXECUTION_EVIDENCE_PATH]: undefined,
          },
        }),
        TAKOSERVER_OWNER_ORIGIN,
      ),
    ).toThrow("execution-evidence");
    expect(() =>
      assertTakoserverOwnerOpenApi(
        ownerOpenApi({
          components: {
            ...ownerOpenApi().components,
            schemas: {
              ...ownerOpenApi().components.schemas,
              ResourceExecutionEvidenceResponse: undefined,
            },
          },
        }),
        TAKOSERVER_OWNER_ORIGIN,
      ),
    ).toThrow("ResourceExecutionEvidenceResponse");
    expect(() =>
      assertTakoserverOwnerOpenApi(
        ownerOpenApi({
          components: {
            ...ownerOpenApi().components,
            schemas: {
              ...ownerOpenApi().components.schemas,
              ResourceExecutionEvidence: {
                ...ownerOpenApi().components.schemas.ResourceExecutionEvidence,
                properties: {
                  ...ownerOpenApi().components.schemas.ResourceExecutionEvidence
                    .properties,
                  format: { const: "old/v0" },
                },
              },
            },
          },
        }),
        TAKOSERVER_OWNER_ORIGIN,
      ),
    ).toThrow("format");
    expect(() =>
      assertTakoserverOwnerOpenApi(
        ownerOpenApi({
          servers: [{ url: "https://other-owner.example.test" }],
        }),
        TAKOSERVER_OWNER_ORIGIN,
      ),
    ).toThrow("server");
  });

  test("accepts only complete committed create/update or delete evidence", () => {
    const base = {
      format: "takoserver.resource-execution-evidence/v1",
      organizationId: "org_staging",
      resource: {
        uid: "uid_1",
        address: {
          space: "main",
          apiVersion: "forms.takoform.com/v1",
          kind: "takoform_module_worker",
          name: "worker",
        },
        formRef: {
          apiVersion: "forms.takoform.com/v1",
          kind: "takoform_module_worker",
          definitionVersion: "4.0.0",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
      coverage: "complete",
      snapshotFence: 3,
      commits: [
        {
          sequence: 1,
          operationId: "op_create",
          action: "create",
          outcome: "committed",
          resourceVersion: { generation: "1", revision: "1" },
          committedAt: "2026-09-04T00:00:00.000Z",
        },
      ],
    };
    expect(() =>
      parseResourceExecutionEvidenceResponse(
        { executionEvidence: base },
        "org_staging",
        "uid_1",
        "apply",
      ),
    ).not.toThrow();
    expect(() =>
      parseResourceExecutionEvidenceResponse(
        {
          executionEvidence: {
            ...base,
            coverage: "partial",
          },
        },
        "org_staging",
        "uid_1",
        "apply",
      ),
    ).toThrow("complete");
    expect(() =>
      parseResourceExecutionEvidenceResponse(
        {
          executionEvidence: {
            ...base,
            coverage: "unknown",
          },
        },
        "org_staging",
        "uid_1",
        "apply",
      ),
    ).toThrow("invalid");
    expect(() =>
      parseResourceExecutionEvidenceResponse(
        { executionEvidence: base },
        "org_staging",
        "uid_1",
        "destroy",
      ),
    ).not.toThrow();
    expect(() =>
      parseResourceExecutionEvidenceResponse(
        { executionEvidence: base },
        "org_staging",
        "uid_1",
        "apply",
        {
          address: "takoform_sqlite_database.database",
          type: "takoform_sqlite_database",
        },
      ),
    ).toThrow("managed inventory");
    expect(() =>
      parseResourceExecutionEvidenceResponse(
        {
          executionEvidence: {
            ...base,
            commits: [
              {
                ...base.commits[0],
                action: "delete",
              },
            ],
          },
        },
        "org_staging",
        "uid_1",
        "apply",
      ),
    ).not.toThrow();
    expect(() =>
      assertResourceExecutionEvidenceSequence(
        [
          {
            ...base.commits[0],
            sequence: 1,
            action: "delete",
          },
        ],
        1,
        "apply",
      ),
    ).toThrow("create/update");
    const destroyCommits = [
      {
        ...base.commits[0],
        sequence: 2,
        operationId: "op_delete",
        action: "delete",
      },
      base.commits[0],
    ];
    expect(() =>
      assertResourceExecutionEvidenceSequence(destroyCommits, 2, "destroy", 1),
    ).not.toThrow();
    expect(() =>
      assertResourceExecutionEvidenceSequence(
        [destroyCommits[0]!],
        2,
        "destroy",
        1,
      ),
    ).toThrow("sequence 1");
    expect(() =>
      assertResourceExecutionEvidenceSequence(
        [{ ...destroyCommits[0]!, sequence: 3 }, destroyCommits[1]!],
        3,
        "destroy",
        3,
      ),
    ).toThrow("did not advance");
    expect(() =>
      assertResourceExecutionEvidenceSequence(
        [
          { ...destroyCommits[0]!, sequence: 2 },
          { ...destroyCommits[1]!, sequence: 0 },
        ],
        2,
        "destroy",
        1,
      ),
    ).toThrow("contiguous");
  });

  test("requires the exact provider tuple in both configured InstallPlan and reviewed PlanRun", () => {
    const exact = {
      provider: TAKOFORM_PROVIDER_SOURCE,
      moduleLocalName: "takoform",
      version: "4.0.0",
    };
    expect(() =>
      assertInstallPlanProviderPin({ providerRequirements: [exact] }),
    ).not.toThrow();
    expect(() =>
      assertRunProviderPin({ requiredProviderRequirements: [exact] }),
    ).not.toThrow();

    for (const invalid of [
      { ...exact, moduleLocalName: "other" },
      { ...exact, childAlias: "child" },
      { ...exact, version: "3.4.5" },
      { ...exact, version: undefined },
      { ...exact, provider: "registry.opentofu.org/cloudflare/cloudflare" },
    ]) {
      expect(() =>
        assertInstallPlanProviderPin({
          providerRequirements: [invalid],
          providerVersion: "4.0.0",
        }),
      ).toThrow();
      expect(() =>
        assertRunProviderPin({
          requiredProviderRequirements: [invalid],
          providerVersion: "4.0.0",
        }),
      ).toThrow();
    }
  });

  test("requires complete Apply history and an exact one-delete Destroy suffix", () => {
    const create = {
      sequence: 1,
      operationId: "op_create",
      action: "create",
      outcome: "committed",
      resourceVersion: { generation: "1", revision: "1" },
      committedAt: "2026-09-04T00:00:00.000Z",
    };
    const update = {
      sequence: 2,
      operationId: "op_update",
      action: "update",
      outcome: "committed",
      resourceVersion: { generation: "2", revision: "2" },
      committedAt: "2026-09-04T00:00:01.000Z",
    };
    const applyHistory = [update, create];
    expect(() =>
      assertResourceExecutionEvidenceSequence(applyHistory, 2, "apply"),
    ).not.toThrow();

    const destroy = {
      sequence: 3,
      operationId: "op_delete",
      action: "delete",
      outcome: "committed",
      resourceVersion: { generation: "3", revision: "3" },
      committedAt: "2026-09-04T00:00:02.000Z",
    };
    expect(() =>
      assertResourceExecutionEvidenceSequence(
        [destroy, ...applyHistory],
        3,
        "destroy",
        2,
        applyHistory,
      ),
    ).not.toThrow();

    expect(() =>
      assertResourceExecutionEvidenceSequence(
        [destroy, { ...update, operationId: "op_replaced" }, create],
        3,
        "destroy",
        2,
        applyHistory,
      ),
    ).toThrow("prefix");

    expect(() =>
      assertResourceExecutionEvidenceSequence(
        [
          { ...destroy, sequence: 4, operationId: "op_prior_delete" },
          destroy,
          ...applyHistory,
        ],
        4,
        "destroy",
        2,
        applyHistory,
      ),
    ).toThrow("suffix");

    expect(() =>
      assertResourceExecutionEvidenceSequence(
        [destroy, ...applyHistory],
        3,
        "destroy",
        2,
        [{ ...update, action: "delete" }, create],
      ),
    ).toThrow("create/update");
  });

  test("requires closed provider-native absence evidence after destroy", () => {
    const resource = {
      outputKey: "worker",
      address: "takoform_module_worker.worker",
      type: "takoform_module_worker",
      uid: "uid_1",
    } as const;
    const absent = {
      residual: {
        status: "absent",
        source: "intrinsic",
        effectCount: 1,
        deploymentCount: 0,
        checkedAt: "2026-09-04T00:00:00.000Z",
        evidenceRef: `sha256:${"a".repeat(64)}`,
      },
    };
    const destroyInterval: DestroyAcknowledgementInterval = {
      startedAtMs: Date.parse("2026-09-04T00:00:00.000Z"),
      acknowledgedAtMs: Date.parse("2026-09-04T00:00:10.000Z"),
    };
    expect(() =>
      assertTakoserverNativeAbsenceResponse(
        200,
        absent,
        resource,
        destroyInterval,
      ),
    ).not.toThrow();
    expect(() =>
      assertTakoserverNativeAbsenceResponse(
        200,
        { residual: { ...absent.residual, status: "indeterminate" } },
        resource,
        destroyInterval,
      ),
    ).toThrow("not absent");
    expect(() =>
      assertTakoserverNativeAbsenceResponse(
        200,
        { residual: { ...absent.residual, unexpected: true } },
        resource,
        destroyInterval,
      ),
    ).toThrow("closed");
    expect(() =>
      assertTakoserverNativeAbsenceResponse(
        404,
        absent,
        resource,
        destroyInterval,
      ),
    ).toThrow("HTTP 404");
    expect(() =>
      assertTakoserverNativeAbsenceResponse(
        200,
        { residual: { ...absent.residual, reason: "closure_pending" } },
        resource,
        destroyInterval,
      ),
    ).toThrow("reason");
    expect(() =>
      assertTakoserverNativeAbsenceResponse(
        200,
        {
          residual: {
            ...absent.residual,
            evidenceRef: undefined,
          },
        },
        resource,
        destroyInterval,
      ),
    ).toThrow("evidenceRef");
    expect(() =>
      assertTakoserverNativeAbsenceResponse(
        200,
        {
          residual: {
            ...absent.residual,
            reason: undefined,
          },
        },
        resource,
        destroyInterval,
      ),
    ).toThrow("reason");
    expect(() =>
      assertTakoserverNativeAbsenceResponse(
        200,
        {
          residual: {
            ...absent.residual,
            checkedAt: "1970-01-01T00:00:00.000Z",
          },
        },
        resource,
        destroyInterval,
      ),
    ).toThrow("bounded evidence window");
    expect(() =>
      assertTakoserverNativeAbsenceResponse(
        200,
        {
          residual: {
            ...absent.residual,
            checkedAt: "2026-09-04T12:00:00.000Z",
          },
        },
        resource,
        destroyInterval,
      ),
    ).toThrow("Destroy acknowledgement interval");
  });

  test("requires both owner Takoserver capability probes before mutation", async () => {
    const source = await readFile(
      new URL("./takosumi-managed-staging-e2e.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("native-residual");
    expect(source).toContain("nonce");
    expect(() =>
      assertTakoserverNativeCapabilityResponse(404, {
        error: {
          code: "resource_not_found",
          message: "resource not found",
          requestId: "req_native",
          retryable: false,
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertTakoserverNativeCapabilityResponse(404, {
        error: {
          code: "not_found",
          message: "not found",
          requestId: "req_native",
          retryable: false,
        },
      }),
    ).toThrow("native residual");
  });

  test("separates reviewable waiting_approval from succeeded and fences cleanup", () => {
    const succeeded = { status: "succeeded" };
    const waiting = { status: "waiting_approval" };
    expect(() => assertReviewableRun(succeeded, "config plan")).not.toThrow();
    expect(() => assertReviewableRun(waiting, "destroy plan")).not.toThrow();
    expect(runRequiresApproval(succeeded)).toBe(false);
    expect(runRequiresApproval(waiting)).toBe(true);
    expect(() => assertDestroyRequiresApproval(waiting)).not.toThrow();
    expect(() => assertDestroyRequiresApproval(succeeded)).toThrow(
      "unreviewed destroy",
    );
    expect(decideCleanup("capsule-created", false, "capsule_1")).toBe(
      "destroy",
    );
    expect(decideCleanup("apply-confirmed", false, "capsule_1")).toBe(
      "destroy",
    );
    expect(decideCleanup("apply-dispatch-started", false, "capsule_1")).toBe(
      "refuse",
    );
    expect(decideCleanup("apply-confirmed", true, "capsule_1")).toBe("refuse");
    // Boundary table: pre-create, post-create-before-snapshot, post-plan,
    // apply dispatch/confirmed, functional probe, and destroy stages.
    expect(decideCleanup("none", false, "")).toBe("none");
    expect(decideCleanup("capsule-created", false, "capsule_1")).toBe(
      "destroy",
    );
    expect(decideCleanup("plan-reviewed", false, "capsule_1")).toBe("destroy");
    expect(decideCleanup("functional-probe", false, "capsule_1")).toBe(
      "destroy",
    );
    expect(
      decideCleanup("destroy-plan-dispatch-started", false, "capsule_1"),
    ).toBe("refuse");
    expect(decideCleanup("destroy-plan-confirmed", false, "capsule_1")).toBe(
      "none",
    );
    expect(
      decideCleanup("destroy-apply-dispatch-started", false, "capsule_1"),
    ).toBe("refuse");
    expect(decideCleanup("destroy-confirmed", false, "capsule_1")).toBe("none");
  });

  test("requires exact owner Run types for every lifecycle operation", () => {
    expect(() =>
      assertRunType({ type: "plan" }, "PlanRun", "plan"),
    ).not.toThrow();
    expect(() =>
      assertRunType({ type: "apply" }, "ApplyRun", "apply"),
    ).not.toThrow();
    expect(() =>
      assertRunType({ type: "destroy_plan" }, "DestroyPlanRun", "destroy_plan"),
    ).not.toThrow();
    expect(() =>
      assertRunType(
        { type: "destroy_apply" },
        "DestroyApplyRun",
        "destroy_apply",
      ),
    ).not.toThrow();
    expect(() => assertRunType({}, "PlanRun", "plan")).toThrow("type");
    expect(() => assertRunType({ type: "apply" }, "PlanRun", "plan")).toThrow(
      "type",
    );
    expect(() =>
      assertRunType(
        { type: "destroy_apply" },
        "DestroyPlanRun",
        "destroy_plan",
      ),
    ).toThrow("type");
  });

  test("rejects malformed configuration-plan response bodies after POST dispatch", () => {
    const response = {
      capsule: { id: "capsule_1" },
      configurationPlan: {
        replayed: false,
        previousInstallConfigId: "icfg_old",
        targetInstallConfigId: "icfg_new",
        sourceSnapshotId: "snapshot_1",
        planRunId: "plan_1",
      },
      links: { run: "/api/v1/runs/plan_1" },
    };
    expect(() => parseConfigurationPlanResponse(response)).not.toThrow();
    expect(() => parseConfigurationPlanResponse({})).toThrow("closed");
    expect(() =>
      parseConfigurationPlanResponse({ ...response, unexpected: true }),
    ).toThrow("closed");
    expect(() =>
      parseConfigurationPlanResponse({
        ...response,
        configurationPlan: {
          ...response.configurationPlan,
          planRunId: undefined,
        },
      }),
    ).toThrow("planRunId");
    expect(() =>
      parseConfigurationPlanResponse({
        ...response,
        links: { run: "/api/v1/runs/other" },
      }),
    ).toThrow("links.run");
  });

  test("requires closed, operation-bound install action responses", () => {
    const response = {
      installPlan: {
        id: "gip_1",
        phase: "reviewable",
        generation: 1,
        planRunId: "plan_1",
      },
      nextAction: "review_run",
      links: {
        self: "/api/v1/install-plans/gip_1",
        run: "/api/v1/runs/plan_1",
      },
    };
    expect(() => parseInstallPlanResponse(response, "gip_1")).not.toThrow();
    expect(() => parseInstallPlanResponse({}, "gip_1")).toThrow("closed");
    expect(() =>
      parseInstallPlanResponse({ ...response, unexpected: true }, "gip_1"),
    ).toThrow("closed");
    expect(() =>
      parseInstallPlanResponse(
        {
          ...response,
          installPlan: { ...response.installPlan, id: "gip_other" },
        },
        "gip_1",
      ),
    ).toThrow("id");
    expect(() =>
      parseInstallPlanResponse(
        {
          ...response,
          links: { ...response.links, extra: "/unexpected" },
        },
        "gip_1",
      ),
    ).toThrow("closed");
    expect(() =>
      parseInstallPlanResponse(
        {
          ...response,
          links: {
            ...response.links,
            self: "/api/v1/install-plans/gip_other",
          },
        },
        "gip_1",
      ),
    ).toThrow("self");

    const chooseResponse = {
      installPlan: {
        id: "gip_1",
        phase: "awaiting_module",
        generation: 1,
      },
      nextAction: "choose_module",
      action: {
        id: "gipa_module_gip_1_1",
        generation: 1,
        method: "POST",
        href: "/api/v1/install-plans/gip_1/actions",
        kind: "choose_module",
        modules: [
          {
            path: "deploy/takoform",
            providerPackages: [
              { source: TAKOFORM_PROVIDER_SOURCE, version: "4.0.0" },
            ],
            rootProviderRequirements: [
              { source: TAKOFORM_PROVIDER_SOURCE, moduleLocalName: "takoform" },
            ],
          },
        ],
      },
      links: { self: "/api/v1/install-plans/gip_1" },
    };
    expect(() =>
      parseInstallPlanResponse(chooseResponse, "gip_1", "choose_module"),
    ).not.toThrow();
    expect(() =>
      parseInstallPlanResponse(
        {
          ...chooseResponse,
          action: {
            ...chooseResponse.action,
            modules: [{ path: "deploy/takoform" }],
          },
        },
        "gip_1",
        "choose_module",
      ),
    ).toThrow("providerPackages");

    const configureResponse = {
      ...chooseResponse,
      installPlan: {
        ...chooseResponse.installPlan,
        phase: "awaiting_configuration",
      },
      nextAction: "configure",
      action: {
        id: "gipa_config_gip_1_1",
        generation: 1,
        method: "POST",
        href: "/api/v1/install-plans/gip_1/actions",
        kind: "configure",
        installConfigId: "icfg_1",
        compatibilityReportId: "caprep_1",
        providerRequirements: [
          { provider: TAKOFORM_PROVIDER_SOURCE, moduleLocalName: "takoform" },
        ],
      },
    };
    expect(() =>
      parseInstallPlanResponse(configureResponse, "gip_1", "configure"),
    ).not.toThrow();
    expect(() =>
      parseInstallPlanResponse(
        {
          ...configureResponse,
          action: {
            ...configureResponse.action,
            providerRequirements: [{}],
          },
        },
        "gip_1",
        "configure",
      ),
    ).toThrow("providerRequirements");
  });

  test("rejects malformed approval responses instead of clearing mutation uncertainty", () => {
    expect(() => parseApprovedRunResponse({}, "plan_1")).toThrow("closed");
    expect(() =>
      parseApprovedRunResponse(
        { run: { id: "other", status: "succeeded" } },
        "plan_1",
      ),
    ).toThrow("did not match");
    expect(() =>
      parseApprovedRunResponse(
        { run: { id: "plan_1", status: "waiting_approval" } },
        "plan_1",
      ),
    ).toThrow("applyable");
    expect(() =>
      parseApprovedRunResponse(
        { run: { id: "plan_1", status: "succeeded", extra: true } },
        "plan_1",
      ),
    ).not.toThrow();
    expect(() =>
      parseApprovedRunResponse(
        { run: { id: "plan_1", type: "plan", status: "succeeded" } },
        "plan_1",
        "plan",
      ),
    ).not.toThrow();
    expect(() =>
      parseApprovedRunResponse(
        { run: { id: "plan_1", type: "apply", status: "succeeded" } },
        "plan_1",
        "plan",
      ),
    ).toThrow("type");
  });

  test("rejects empty plan/apply mutation acknowledgements", () => {
    expect(() => parseRunMutationResponse({}, "apply")).toThrow("closed");
    expect(() =>
      parseRunMutationResponse({ run: { status: "succeeded" } }, "apply"),
    ).toThrow("response.run.id");
    expect(() =>
      parseRunMutationResponse(
        { run: { id: "run_1", status: "succeeded" } },
        "apply",
      ),
    ).not.toThrow();
    expect(() =>
      parseRunMutationResponse({ run: { id: "run_1" } }, "apply"),
    ).toThrow("status");
    expect(() =>
      parseRunMutationResponse(
        { run: { id: "run_1", status: "succeeded" }, extra: true },
        "apply",
      ),
    ).toThrow("closed");
    expect(() =>
      parseRunMutationResponse(
        { run: { id: "run_1", type: "apply", status: "succeeded" } },
        "apply",
        "apply",
      ),
    ).not.toThrow();
    expect(() =>
      parseRunMutationResponse(
        { run: { id: "run_1", status: "succeeded" } },
        "apply",
        "apply",
      ),
    ).toThrow("type");
    expect(() =>
      parseRunMutationResponse(
        { run: { id: "run_1", type: "plan", status: "succeeded" } },
        "apply",
        "apply",
      ),
    ).toThrow("type");
  });

  test("requires exact SourceSnapshot identity on PlanRun and ApplyRun", () => {
    const evidence = {
      id: "snapshot_1",
      url: YURUCOMMU_REPOSITORY_URL,
      resolvedCommit: "a".repeat(40),
      archiveDigest: `sha256:${"b".repeat(64)}`,
      ref: "refs/heads/main",
      path: "deploy/takoform",
      modulePath: "deploy/takoform",
      capsuleId: "capsule_1",
      workspaceId: "ws_1",
      baseStateGeneration: 0,
      currentStateVersionId: null,
    };
    const sourceArchive = {
      ref: "source-snapshots/snapshot_1.tar",
      digest: evidence.archiveDigest,
    };
    const planRun = {
      id: "plan_1",
      type: "plan",
      workspaceId: evidence.workspaceId,
      capsuleId: evidence.capsuleId,
      sourceSnapshotId: evidence.id,
      baseStateGeneration: evidence.baseStateGeneration,
      runEnvironmentEvidenceDigest: `sha256:${"9".repeat(64)}`,
      sourceArchive,
      source: {
        kind: "git",
        url: evidence.url,
        modulePath: evidence.modulePath,
        commit: evidence.resolvedCommit,
      },
      sourceCommit: evidence.resolvedCommit,
    };
    expect(() =>
      assertSourceSnapshotRunConsistency(planRun, evidence),
    ).not.toThrow();
    expect(() =>
      assertSourceSnapshotRunConsistency(
        {
          ...planRun,
          source: { ...planRun.source, commit: undefined },
          sourceCommit: undefined,
        },
        evidence,
      ),
    ).toThrow("source commit");

    expect(() =>
      assertSourceSnapshotRunConsistency(
        {
          ...planRun,
          source: { ...planRun.source, ref: evidence.ref },
        },
        evidence,
      ),
    ).toThrow("mutable ref");

    expect(() =>
      assertSourceSnapshotRunConsistency(
        {
          id: "apply_1",
          type: "apply",
          planRunId: "plan_1",
          workspaceId: evidence.workspaceId,
          capsuleId: evidence.capsuleId,
          sourceSnapshotId: evidence.id,
          baseStateGeneration: evidence.baseStateGeneration,
          runEnvironmentEvidenceDigest: `sha256:${"9".repeat(64)}`,
          sourceArchive,
          applyExpected: {
            planId: "plan_1",
            capsuleId: evidence.capsuleId,
            currentStateVersionId: evidence.currentStateVersionId,
            sourceDigest: `sha256:${"c".repeat(64)}`,
            variablesDigest: `sha256:${"d".repeat(64)}`,
            policyDecisionDigest: `sha256:${"e".repeat(64)}`,
            planDigest: `sha256:${"f".repeat(64)}`,
            planArtifactDigest: `sha256:${"1".repeat(64)}`,
            sourceCommit: evidence.resolvedCommit,
          },
        },
        evidence,
        "plan_1",
      ),
    ).not.toThrow();
    expect(() =>
      assertSourceSnapshotRunConsistency(
        {
          id: "apply_1",
          planRunId: "plan_1",
          workspaceId: evidence.workspaceId,
          capsuleId: evidence.capsuleId,
          sourceSnapshotId: evidence.id,
          baseStateGeneration: evidence.baseStateGeneration,
          runEnvironmentEvidenceDigest: `sha256:${"9".repeat(64)}`,
          sourceArchive,
          applyExpected: { planId: "plan_1" },
        },
        evidence,
        "plan_1",
      ),
    ).toThrow("expected Capsule");
    expect(() =>
      assertSourceSnapshotRunConsistency(
        { ...planRun, sourceArchive: undefined },
        evidence,
      ),
    ).toThrow("sourceArchive");
    expect(() =>
      assertSourceSnapshotRunConsistency(
        { ...planRun, workspaceId: "ws_other" },
        evidence,
      ),
    ).toThrow("Workspace");
    expect(() =>
      assertSourceSnapshotRunConsistency(
        { ...planRun, baseStateGeneration: 1 },
        evidence,
      ),
    ).toThrow("base state generation");
    expect(() =>
      assertSourceSnapshotRunConsistency(
        {
          ...planRun,
          sourceArchive: {
            ...sourceArchive,
            digest: `sha256:${"0".repeat(64)}`,
          },
        },
        evidence,
      ),
    ).toThrow("archive digest");
  });

  test("accepts only the closed owner staging release receipt", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "yurucommu-managed-receipt-"),
    );
    const path = join(directory, "receipt.json");
    const predecessorContainer = {
      hasActiveRollout: false,
      health: { errorCount: 0, failed: 0, scheduling: 0, starting: 0 },
      id: "container_1",
      image: `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`,
      name: "takosumi-runner",
      state: "ready",
      version: 1,
    };
    const receipt = {
      kind: "takosumi.platform-worker-release-evidence@v2",
      status: "ready",
      completedAt: "2026-09-04T00:00:00.000Z",
      environment: "staging",
      sourceCommit: "d".repeat(40),
      configPath: "/srv/takosumi/wrangler.toml",
      configSha256: `sha256:${"e".repeat(64)}`,
      sealedConfigSha256: `sha256:${"f".repeat(64)}`,
      closureSha256: `sha256:${"1".repeat(64)}`,
      dashboardAssetsSha256: `sha256:${"2".repeat(64)}`,
      dryRunSha256: `sha256:${"3".repeat(64)}`,
      secretNamesSha256: `sha256:${"4".repeat(64)}`,
      predecessorVersionId: "00000000-0000-4000-8000-000000000001",
      predecessorContainer,
      deployedVersionId: "00000000-0000-4000-8000-000000000002",
      deployedContainer: { ...predecessorContainer },
      releaseTag: "2026.09.04",
      planConfirmation: `sha256:${"5".repeat(64)}`,
      reviewer: "operator:platform-reviewer",
      lostAcknowledgement: false,
      reversal: {
        surface: "takosumi-platform-staging",
        action: "restore",
        planConfirmation: `sha256:${"5".repeat(64)}`,
        predecessorVersionId: "00000000-0000-4000-8000-000000000001",
        predecessorContainer,
      },
    };
    try {
      await writeFile(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
      const parsed = await readTakosumiDeployReceipt(path);
      expect(parsed.deployedVersionId).toBe(receipt.deployedVersionId);
      await writeFile(
        path,
        `${JSON.stringify({ ...receipt, alias: "bad" })}\n`,
        {
          mode: 0o600,
        },
      );
      await chmod(path, 0o600);
      await expect(readTakosumiDeployReceipt(path)).rejects.toThrow("closed");

      const sourceRepository = "https://github.com/tako0614/takosumi.git";
      const sourceCommit = "a".repeat(40);
      const recoverySourceCommit = "b".repeat(40);
      const v3Receipt = {
        ...receipt,
        kind: "takosumi.platform-worker-release-evidence@v3",
        sourceRepository,
        sourceCommit,
        sourceAuthoritySha256:
          "sha256:87f14252ec5ceb6cd49ab235dd6ed0a2040600e2ff72714b10f2f57cb70a503c",
        recoverySourceRepository: sourceRepository,
        recoverySourceCommit,
        recoverySourceAuthoritySha256:
          "sha256:61dcb56b59d5ed2d62b8308a4725b3dfaa827cb5d39779b3571a932e9cf1edf0",
      };
      await writeFile(path, `${JSON.stringify(v3Receipt)}\n`, {
        mode: 0o600,
      });
      await chmod(path, 0o600);
      const parsedV3 = await readTakosumiDeployReceipt(path);
      if (parsedV3.kind !== "takosumi.platform-worker-release-evidence@v3") {
        throw new Error("v3 receipt was relabeled or not preserved");
      }
      expect(parsedV3.sourceRepository).toBe(sourceRepository);
      expect(parsedV3.sourceCommit).toBe(sourceCommit);
      expect(parsedV3.recoverySourceCommit).toBe(recoverySourceCommit);
      const paddedFields = [
        { field: "sourceCommit", value: ` ${sourceCommit} ` },
        {
          field: "sourceAuthoritySha256",
          value: ` ${v3Receipt.sourceAuthoritySha256} `,
        },
        { field: "recoverySourceCommit", value: ` ${recoverySourceCommit} ` },
        {
          field: "recoverySourceAuthoritySha256",
          value: ` ${v3Receipt.recoverySourceAuthoritySha256} `,
        },
      ] as const;
      for (const { field, value } of paddedFields) {
        await writeFile(
          path,
          `${JSON.stringify({ ...v3Receipt, [field]: value })}\n`,
          { mode: 0o600 },
        );
        await chmod(path, 0o600);
        await expect(readTakosumiDeployReceipt(path)).rejects.toThrow();
      }

      const writeReceipt = async (value: unknown) => {
        await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        await chmod(path, 0o600);
      };
      const expectRejected = async (value: unknown) => {
        await writeReceipt(value);
        await expect(readTakosumiDeployReceipt(path)).rejects.toThrow();
      };

      const v3NoRecovery = { ...v3Receipt };
      for (const field of [
        "recoverySourceRepository",
        "recoverySourceCommit",
        "recoverySourceAuthoritySha256",
      ]) {
        delete (v3NoRecovery as Record<string, unknown>)[field];
      }
      await writeReceipt(v3NoRecovery);
      const parsedNoRecovery = await readTakosumiDeployReceipt(path);
      if (
        parsedNoRecovery.kind !== "takosumi.platform-worker-release-evidence@v3"
      ) {
        throw new Error("v3 receipt without recovery was not preserved");
      }
      expect(parsedNoRecovery.sourceRepository).toBe(sourceRepository);

      const sshRepository = "git@github.com:tako0614/takosumi.git";
      await writeReceipt({
        ...v3Receipt,
        sourceRepository: sshRepository,
        sourceAuthoritySha256:
          "sha256:641f62621c8ab21aaff21f6f6b6de3fc82e80d67114a0a3c9182a18f4ae69ada",
      });
      const parsedEquivalentSsh = await readTakosumiDeployReceipt(path);
      if (
        parsedEquivalentSsh.kind !==
        "takosumi.platform-worker-release-evidence@v3"
      ) {
        throw new Error("equivalent SSH repository spelling was rejected");
      }
      expect(parsedEquivalentSsh.sourceRepository).toBe(sshRepository);

      await expectRejected({ ...v3Receipt, alias: "bad" });
      await expectRejected({
        ...receipt,
        kind: "takosumi.platform-worker-release-evidence@v2",
        sourceRepository,
        sourceAuthoritySha256: v3Receipt.sourceAuthoritySha256,
      });
      const partialRecovery = { ...v3Receipt };
      delete (partialRecovery as Record<string, unknown>).recoverySourceCommit;
      await expectRejected(partialRecovery);
      await expectRejected({
        ...v3Receipt,
        sourceAuthoritySha256: `sha256:${"0".repeat(64)}`,
      });
      await expectRejected({
        ...v3Receipt,
        sourceRepository: ` ${sourceRepository} `,
      });
      await expectRejected({
        ...v3Receipt,
        recoverySourceRepository: "https://github.com/other/takosumi.git",
        recoverySourceAuthoritySha256:
          "sha256:d75cfcaf09985f50e34373ed53439c88eef1545c217afc60c8875c9b2bb002a1",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps private credential files canonical and identity-stable", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "yurucommu-managed-private-"),
    );
    const workspaceDirectory = await mkdtemp(
      join(process.cwd(), ".yurucommu-managed-private-workspace-"),
    );
    const otherRepo = await mkdtemp(join(tmpdir(), "yurucommu-other-repo-"));
    const nestedWorktree = join(otherRepo, "nested", "worktree");
    const gitFileRepo = await mkdtemp(
      join(tmpdir(), "yurucommu-git-file-repo-"),
    );
    const bareRepo = await mkdtemp(join(tmpdir(), "yurucommu-bare-repo-"));
    const ordinaryDirectory = await mkdtemp(
      join(tmpdir(), "yurucommu-head-objects-dir-"),
    );
    const path = join(directory, "token");
    const hardlinkPath = join(directory, "token-hardlink");
    const symlinkPath = join(directory, "token-link");
    const workspacePath = join(workspaceDirectory, "token");
    const otherRepoPath = join(otherRepo, "secret");
    const nestedWorktreePath = join(nestedWorktree, "secret");
    const gitFileRepoPath = join(gitFileRepo, "secret");
    const bareRepoPath = join(bareRepo, "secret");
    const ordinaryPath = join(ordinaryDirectory, "secret");
    try {
      await writeFile(path, "secret\n", { mode: 0o600 });
      await chmod(path, 0o600);
      await expect(readPrivateFile(path, "private token", false)).resolves.toBe(
        "secret",
      );
      await chmod(path, 0o644);
      await expect(
        readPrivateFile(path, "private token", false),
      ).rejects.toThrow("group/world");
      await chmod(path, 0o600);
      await link(path, hardlinkPath);
      await expect(
        readPrivateFile(path, "private token", false),
      ).rejects.toThrow("one hard link");
      await symlink(path, symlinkPath);
      await expect(
        readPrivateFile(symlinkPath, "private token", false),
      ).rejects.toThrow("canonical");
      await writeFile(workspacePath, "secret\n", { mode: 0o600 });
      await chmod(workspacePath, 0o600);
      await expect(
        readPrivateFile(workspacePath, "private token", false),
      ).rejects.toThrow("Git repositories");

      // A repository may live outside the Takos workspace root; custody must
      // reject it based on the canonical ancestor marker, not a hard-coded
      // product path.
      await mkdir(join(otherRepo, ".git"));
      await writeFile(otherRepoPath, "secret\n", { mode: 0o600 });
      await chmod(otherRepoPath, 0o600);
      await expect(
        readPrivateFile(otherRepoPath, "private token", false),
      ).rejects.toThrow("Git repositories");

      await mkdir(nestedWorktree, { recursive: true });
      await writeFile(nestedWorktreePath, "secret\n", { mode: 0o600 });
      await chmod(nestedWorktreePath, 0o600);
      await expect(
        readPrivateFile(nestedWorktreePath, "private token", false),
      ).rejects.toThrow("Git repositories");

      // Linked worktrees use a regular `.git` file pointing at the common
      // repository; lstat must classify the indirection as a source boundary.
      await writeFile(join(gitFileRepo, ".git"), "gitdir: ../common\n", {
        mode: 0o600,
      });
      await writeFile(gitFileRepoPath, "secret\n", { mode: 0o600 });
      await chmod(gitFileRepoPath, 0o600);
      await expect(
        readPrivateFile(gitFileRepoPath, "private token", false),
      ).rejects.toThrow("Git repositories");

      // A bare repository has no `.git` child; its bounded HEAD/config/
      // objects/refs structure is still a Git source boundary.
      await mkdir(join(bareRepo, "objects"));
      await mkdir(join(bareRepo, "refs"));
      await writeFile(join(bareRepo, "HEAD"), "ref: refs/heads/main\n", {
        mode: 0o600,
      });
      await writeFile(
        join(bareRepo, "config"),
        "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
        { mode: 0o600 },
      );
      await writeFile(bareRepoPath, "secret\n", { mode: 0o600 });
      await chmod(bareRepoPath, 0o600);
      await expect(
        readPrivateFile(bareRepoPath, "private token", false),
      ).rejects.toThrow("Git repositories");

      // Merely naming folders HEAD/objects/refs/config is not enough to be a
      // bare repository; ordinary operator directories remain usable.
      await mkdir(join(ordinaryDirectory, "objects"));
      await mkdir(join(ordinaryDirectory, "refs"));
      await writeFile(join(ordinaryDirectory, "HEAD"), "notes\n", {
        mode: 0o600,
      });
      await writeFile(join(ordinaryDirectory, "config"), "[app]\n", {
        mode: 0o600,
      });
      await writeFile(ordinaryPath, "secret\n", { mode: 0o600 });
      await chmod(ordinaryPath, 0o600);
      await expect(
        readPrivateFile(ordinaryPath, "private token", false),
      ).resolves.toBe("secret");

      await expect(
        readPrivateFileForTest(
          ordinaryPath,
          "private token",
          false,
          async () => {
            await chmod(ordinaryPath, 0o640);
            await chmod(ordinaryPath, 0o600);
            await chmod(ordinaryDirectory, 0o755);
            await chmod(ordinaryDirectory, 0o700);
          },
        ),
      ).rejects.toThrow("changed");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(workspaceDirectory, { recursive: true, force: true });
      await rm(otherRepo, { recursive: true, force: true });
      await rm(gitFileRepo, { recursive: true, force: true });
      await rm(bareRepo, { recursive: true, force: true });
      await rm(ordinaryDirectory, { recursive: true, force: true });
    }
  });

  test("fails closed until the versioned Takoserver Resource evidence endpoint exists", async () => {
    const source = await readFile(
      new URL("./takosumi-managed-staging-e2e.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("takoserver.resource-execution-evidence/v1");
    expect(source).toContain(
      "separate authenticated Takoserver Resource evidence endpoint",
    );
    expect(source).toContain("auth-first negative request");
    expect(source).toContain("takoform_resource_ids");
    expect(source).toContain("assertTakoserverResourceAbsent");
    expect(source).toContain("native-residual");
    expect(source).toContain("assertTakoserverNativeAbsent");
    expect(source).not.toContain("executionReceipt:");
  });

  test("requires a resolved workspace launcher whose URL came from launch_url", () => {
    const launchUrl = "https://yurucommu.example.test/";
    expect(() =>
      assertManagedLauncher(
        {
          interfaces: [
            {
              spec: {
                type: "interface.ui.surface",
                version: "1",
                access: { visibility: "workspace" },
              },
              status: {
                phase: "Resolved",
                resolvedInputs: { url: launchUrl },
              },
            },
          ],
        },
        launchUrl,
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedLauncher(
        {
          interfaces: [
            {
              spec: {
                type: "interface.ui.surface",
                version: "1",
                access: { visibility: "workspace" },
              },
              status: {
                phase: "Pending",
                resolvedInputs: { url: launchUrl },
              },
            },
          ],
        },
        launchUrl,
      ),
    ).toThrow("exactly one");
  });

  test("names the upstream install/configuration/run contracts without command hooks", async () => {
    const source = await readFile(
      new URL("./takosumi-managed-staging-e2e.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("/install-plans");
    expect(source).toContain("/configuration-plans");
    expect(source).toContain("/provider-connections");
    expect(source).toContain("/credential-recipes");
    expect(source).toContain("/provider-bindings");
    expect(source).toContain("/current-resource-inventory");
    expect(source).toContain("runFunctionalProbe");
    expect(source).toContain("requireOidc: true");
    expect(source).toContain("export async function runManagedStagingE2E");
    expect(source).toContain("export interface ManagedAppSessionOperator");
    expect(source).toContain("close(): Promise<void>");
    expect(source).toContain("ManagedBrowserCleanupUncertainError");
    expect(source).toContain("/api/v1/account/session/me");
    expect(source).toContain("preflightAccountsIdentity");
    expect(source).toContain("acquireAppSession");
    expect(source).toContain("/api/auth/callback/takos");
    expect(source).toContain("managed staging E2E is a library");
    expect(source).not.toContain("expectedActorApId:");
    expect(source).not.toContain("sessionCookieFile");
    expect(source).not.toContain("probeActorApId");
    expect(source).toContain("x-takosumi-version-id");
    expect(source).toContain("Idempotency-Key");
    expect(source).toContain("client.requestJson(path, options)");
    expect(source).toContain("runEnvironmentEvidenceDigest");
    expect(source).not.toContain("apply.completed");
    expect(source).toContain("readPrivateFile");
    expect(source).toContain("takosumi.platform-worker-release-evidence@v2");
    expect(source).toContain("createPinnedHttpTransport");
    expect(source).toContain("DNS");
    expect(source).toContain("TAKOSERVER_STAGING_URL");
    expect(source).toContain("TAKOSERVER_STAGING_ORGANIZATION_ID");
    expect(source).toContain("TAKOSERVER_STAGING_EVIDENCE_CREDENTIAL_FILE");
    expect(source).toContain(
      "Takoserver read-only execution evidence credential",
    );
    expect(source).toContain(
      "Takoserver execution evidence apply newest action was not create/update",
    );
    expect(source).toContain(
      "Takoserver execution evidence destroy newest action was not delete",
    );
    expect(source).not.toContain("providerConnectionsFile");
    expect(source).not.toContain("deriveProviderBindings");
    expect(source).toContain("ctimeMs");
    expect(source).toContain("left.uid");
    expect(source).toContain("left.mode");
    expect(source).toContain("O_NOFOLLOW");
    expect(source).toContain("realpath");
    expect(source).not.toContain("pinnedRequestUrl");
    expect(source).not.toContain("fetchBounded");
    expect(source).not.toContain("YURUCOMMU_E2E_PASSWORD");
    expect(source).not.toContain("shell: true");
  });
});
