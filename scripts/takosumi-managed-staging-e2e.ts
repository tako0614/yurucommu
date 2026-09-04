import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import {
  CURRENT_RESOURCE_GRAPH,
  CURRENT_RESOURCE_TYPES,
} from "./takoform-v1-e2e-full.ts";
import { TAKOFORM_PROVIDER_VERSION } from "./takoform-provider-pin.ts";
import {
  createPinnedHttpTransport,
  isFunctionalProbeMutationUncertain,
  type PinnedHttpTransport,
  runFunctionalProbe,
} from "./post-deploy-smoke.ts";

/** Canonical provider source declared by deploy/takoform/main.tf. */
export const TAKOFORM_PROVIDER_SOURCE =
  "registry.terraform.io/tako0614/takoform";
export const MANAGED_MODULE_PATH = "deploy/takoform";
export const STAGING_ENVIRONMENT = "staging" as const;
export const INSTALL_PLANS_PATH =
  "/api/v1/workspaces/{workspaceId}/install-plans";
export const CONFIGURATION_PLANS_PATH =
  "/api/v1/capsules/{capsuleId}/configuration-plans";
export const UI_SURFACES_PATH =
  "/api/v1/workspaces/{workspaceId}/ui-surfaces?capsuleId={capsuleId}";

const DEFAULT_SOURCE_PATH = ".";
const DEFAULT_TIMEOUT_SECONDS = 20 * 60;
const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const POLL_DELAY_MS = 1_000;
const MAX_SOURCE_URL_BYTES = 2_048;
const MAX_REF_BYTES = 512;
const MAX_ID_BYTES = 256;
const MAX_RESPONSE_BYTES = 1_048_576;
const WORKER_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TAKOSUMI_DEPLOY_SURFACE = "takosumi-platform-staging" as const;
export const TAKOSERVER_RESOURCE_EXECUTION_EVIDENCE_FORMAT =
  "takoserver.resource-execution-evidence/v1" as const;
const TAKOSERVER_OWNER_DISCOVERY_PATH = "/.well-known/takoserver";
const TAKOSERVER_OPENAPI_PATH = "/openapi.json";
const TAKOSERVER_RESOURCE_EXECUTION_EVIDENCE_PATH =
  "/v1/organizations/{organizationId}/resources/{resourceUid}/execution-evidence";
const TAKOSERVER_NATIVE_RESIDUAL_PATH =
  "/v1/organizations/{organizationId}/resources/{resourceUid}/native-residual";
const TAKOSERVER_NATIVE_RESIDUAL_REASONS = [
  "closure_pending",
  "effect_unresolved",
  "deployment_active",
  "deployment_unmarked",
  "provider_unavailable",
  "provider_readback_failed",
  "provider_identity_missing",
  "legacy_unattested",
] as const;
const TAKOSERVER_EVIDENCE_PAGE_LIMIT = 50;
const MAX_TAKOSERVER_EVIDENCE_PAGES = 256;
const MAX_NATIVE_ABSENCE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_DESTROY_ACKNOWLEDGEMENT_INTERVAL_MS = MAX_TIMEOUT_SECONDS * 1_000;
const MANAGED_FORM_CONTRACT: Readonly<
  Record<string, { readonly kind: string; readonly definitionVersion: string }>
> = {
  takoform_module_worker: { kind: "ModuleWorker", definitionVersion: "0.1.0" },
  takoform_sqlite_database: {
    kind: "SQLiteDatabase",
    definitionVersion: "0.1.0",
  },
  takoform_sqlite_migration_set: {
    kind: "SQLiteMigrationSet",
    definitionVersion: "0.1.0",
  },
  takoform_sqlite_migration_application: {
    kind: "SQLiteMigrationApplication",
    definitionVersion: "0.1.0",
  },
  takoform_edge_kv_namespace: {
    kind: "EdgeKVNamespace",
    definitionVersion: "0.1.0",
  },
  takoform_edge_object_bucket: {
    kind: "ObjectBucket",
    definitionVersion: "0.1.0",
  },
  takoform_at_least_once_queue: {
    kind: "AtLeastOnceQueue",
    definitionVersion: "0.1.0",
  },
  takoform_worker_bundle: { kind: "WorkerBundle", definitionVersion: "0.1.0" },
  takoform_worker_version: {
    kind: "WorkerVersion",
    definitionVersion: "0.3.0",
  },
  takoform_worker_deployment: {
    kind: "WorkerDeployment",
    definitionVersion: "0.2.0",
  },
  takoform_worker_endpoint: {
    kind: "WorkerEndpoint",
    definitionVersion: "0.1.0",
  },
  takoform_queue_consumer: {
    kind: "QueueConsumer",
    definitionVersion: "0.1.0",
  },
  takoform_worker_cron_trigger: {
    kind: "WorkerCronTrigger",
    definitionVersion: "0.1.0",
  },
};
const PLATFORM_READY_RECEIPT_KEYS = [
  "closureSha256",
  "completedAt",
  "configPath",
  "configSha256",
  "dashboardAssetsSha256",
  "deployedContainer",
  "deployedVersionId",
  "dryRunSha256",
  "environment",
  "kind",
  "lostAcknowledgement",
  "planConfirmation",
  "predecessorContainer",
  "predecessorVersionId",
  "releaseTag",
  "reversal",
  "reviewer",
  "sealedConfigSha256",
  "secretNamesSha256",
  "sourceCommit",
  "status",
] as const;
/** Bound private-file ancestor inspection so a malformed path cannot force an unbounded walk. */
const MAX_PRIVATE_PATH_ANCESTORS = 256;
const MAX_GIT_MARKER_BYTES = 64 * 1024;
const CAPSULE_CURRENT_RESOURCE_INVENTORY_KIND =
  "takosumi.capsule-current-resource-inventory@v1" as const;
const INVENTORY_KEYS = [
  "applyRunId",
  "availability",
  "capsuleId",
  "environment",
  "generation",
  "kind",
  "planRunId",
  "recordedAt",
  "resources",
  "stateVersionId",
  "workspaceId",
] as const;
const OUTPUT_KEYS = [
  "capsuleId",
  "createdAt",
  "id",
  "outputDigest",
  "publicOutputs",
  "stateGeneration",
  "workspaceId",
  "workspaceOutputs",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;
type MutationReconciler = (api: ApiClient) => Promise<JsonRecord | undefined>;
type MutationValidator<T> = (value: JsonRecord) => T;

export type LifecyclePhase =
  | "none"
  | "capsule-created"
  | "plan-reviewed"
  | "apply-dispatch-started"
  | "apply-confirmed"
  | "functional-probe"
  | "destroy-plan-dispatch-started"
  | "destroy-plan-confirmed"
  | "destroy-apply-dispatch-started"
  | "destroy-confirmed";

export interface ManagedStagingConfig {
  readonly takosumiOrigin: string;
  readonly takosumiDeployReceiptFile: string;
  readonly takoserverOwnerOrigin: string;
  readonly takoserverOrganizationId: string;
  readonly takoserverEvidenceCredentialFile: string;
  readonly workspaceId: string;
  readonly sessionTokenFile: string;
  readonly sessionCookieFile: string;
  readonly probeActorApId: string;
  readonly sourceUrl: string;
  readonly sourceRef: string;
  readonly sourcePath: string;
  readonly modulePath: string;
  readonly capsuleName: string;
  readonly providerConnectionId: string;
  readonly timeoutMs: number;
}

export interface TakosumiDeployReceipt {
  readonly kind: "takosumi.platform-worker-release-evidence@v2";
  readonly status: "ready";
  readonly environment: "staging";
  readonly sourceCommit: string;
  readonly predecessorVersionId: string;
  readonly deployedVersionId: string;
  readonly planConfirmation: string;
  readonly reviewer: string;
  readonly reversal: {
    readonly surface: "takosumi-platform-staging";
    readonly action: "restore";
    readonly planConfirmation: string;
    readonly predecessorVersionId: string;
  };
  /** Digest of the private receipt file, never the receipt body itself. */
  readonly fileDigest: string;
}

export interface TakosumiDeploymentProof {
  readonly receipt: TakosumiDeployReceipt;
  readonly transport: PinnedHttpTransport;
}

export interface SourceSnapshotEvidence {
  readonly id: string;
  readonly url: string;
  readonly resolvedCommit: string;
  readonly archiveDigest: string;
  readonly ref: string;
  readonly path: string;
  /** Module coordinate selected from the immutable SourceSnapshot archive. */
  readonly modulePath: string;
  /** Capsule/Workspace and state cursor that the PlanRun was created against. */
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly baseStateGeneration: number;
  readonly currentStateVersionId: string | null;
}

export interface RunIdentityContext {
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly baseStateGeneration: number;
  readonly currentStateVersionId: string | null;
}

export interface ProviderRequirement {
  readonly provider: string;
  /** Run projections call the same field `source`; both are accepted. */
  readonly source?: string;
  readonly moduleLocalName: string;
  readonly childAlias?: string;
  readonly version?: string;
}

export interface ProviderBindingSelection {
  readonly provider: string;
  readonly moduleLocalName: string;
  readonly childAlias?: string;
  /** Generated-root alias; install-plan actions derive it from childAlias. */
  readonly rootAlias?: string;
  readonly connectionId: string;
}

interface ApiClient {
  readonly origin: string;
  readonly token: string;
  readonly transport: PinnedHttpTransport;
  requestJson(
    path: string,
    options: {
      readonly method?: string;
      readonly body?: unknown;
      readonly expectedStatus?: number | readonly number[];
      readonly headers?: Record<string, string>;
    },
  ): Promise<JsonRecord>;
}

export interface TakoserverEvidenceRequestOptions {
  /** Public owner-discovery/OpenAPI probes must not carry the evidence token. */
  readonly authenticated?: boolean;
}

export interface TakoserverEvidenceClient {
  readonly origin: string;
  readonly organizationId: string;
  readonly token?: string;
  readonly transport?: PinnedHttpTransport;
  request(
    path: string,
    options?: TakoserverEvidenceRequestOptions,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
}

interface TakoserverResourceAddress {
  readonly space: string;
  readonly name: string;
}

export interface ManagedResourceLineage {
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly environment?: string;
  readonly stateVersionId: string;
  readonly generation: number;
  readonly applyRunId: string;
  readonly planRunId: string;
}

interface TakoserverEvidenceReadback {
  readonly addresses: ReadonlyMap<string, TakoserverResourceAddress>;
  readonly identityFingerprints: ReadonlyMap<string, string>;
  readonly snapshotFences: ReadonlyMap<string, number>;
  /** Every committed row from the Apply fence through sequence 1. */
  readonly historyFingerprints: ReadonlyMap<string, readonly string[]>;
  /** The immutable sequence-1 prefix must survive a later destroy history. */
  readonly prefixFingerprints: ReadonlyMap<string, string>;
}

interface DestroyProjectionExpectation {
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly planRunId: string;
  readonly applyRunId: string;
}

export interface ManagedResourceIdentity {
  readonly outputKey: string;
  readonly address: string;
  readonly type: string;
  readonly uid: string;
}

/** Local interval in which the owner acknowledged the one Destroy Apply. */
export interface DestroyAcknowledgementInterval {
  readonly startedAtMs: number;
  readonly acknowledgedAtMs: number;
}

interface InstallPlanResponse {
  readonly installPlan: JsonRecord;
  readonly nextAction: string;
  readonly action?: JsonRecord;
  readonly links?: JsonRecord;
}

class ApiRequestError extends Error {
  readonly uncertain: boolean;

  constructor(message: string, uncertain: boolean) {
    super(message);
    this.name = "ApiRequestError";
    this.uncertain = uncertain;
  }
}

class MutationUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationUncertainError";
  }
}

function isMutationUncertain(value: unknown): boolean {
  return (
    value instanceof MutationUncertainError ||
    (value instanceof ApiRequestError && value.uncertain)
  );
}

/**
 * Parse owner-supplied staging inputs without ever reading a credential value.
 * The environment intentionally contains paths to private files, not tokens.
 */
export function readManagedStagingConfig(
  environment: Environment,
): ManagedStagingConfig {
  const takosumiOrigin = readOrigin(
    environment.TAKOSUMI_STAGING_URL,
    "TAKOSUMI_STAGING_URL",
  );
  const takosumiDeployReceiptFile = requiredAbsolutePath(
    environment.TAKOSUMI_STAGING_DEPLOY_RECEIPT_FILE,
    "TAKOSUMI_STAGING_DEPLOY_RECEIPT_FILE",
  );
  const takoserverOwnerOrigin = readOrigin(
    environment.TAKOSERVER_STAGING_URL,
    "TAKOSERVER_STAGING_URL",
  );
  const takoserverOrganizationId = requiredIdentifier(
    environment.TAKOSERVER_STAGING_ORGANIZATION_ID,
    "TAKOSERVER_STAGING_ORGANIZATION_ID",
  );
  const takoserverEvidenceCredentialFile = requiredAbsolutePath(
    environment.TAKOSERVER_STAGING_EVIDENCE_CREDENTIAL_FILE,
    "TAKOSERVER_STAGING_EVIDENCE_CREDENTIAL_FILE",
  );
  if (environment.TAKOSUMI_STAGING_EXPECTED_VERSION_ID?.trim()) {
    throw new Error(
      "TAKOSUMI_STAGING_EXPECTED_VERSION_ID is not accepted; derive the target from the owner release receipt",
    );
  }
  const workspaceId = requiredIdentifier(
    environment.TAKOSUMI_STAGING_WORKSPACE_ID,
    "TAKOSUMI_STAGING_WORKSPACE_ID",
  );
  const probeActorApId = readActorApId(
    environment.TAKOSUMI_STAGING_PROBE_ACTOR_AP_ID,
    "TAKOSUMI_STAGING_PROBE_ACTOR_AP_ID",
  );
  const sessionTokenFile = requiredAbsolutePath(
    environment.TAKOSUMI_STAGING_SESSION_TOKEN_FILE,
    "TAKOSUMI_STAGING_SESSION_TOKEN_FILE",
  );
  const sessionCookieFile = requiredAbsolutePath(
    environment.TAKOSUMI_STAGING_SESSION_COOKIE_FILE,
    "TAKOSUMI_STAGING_SESSION_COOKIE_FILE",
  );
  const sourceUrl = readGitSourceUrl(environment.TAKOSUMI_STAGING_SOURCE_URL);
  const sourceRef = boundedText(
    environment.TAKOSUMI_STAGING_SOURCE_REF,
    "TAKOSUMI_STAGING_SOURCE_REF",
    MAX_REF_BYTES,
  );
  const sourcePath = readRelativePath(
    environment.TAKOSUMI_STAGING_SOURCE_PATH ?? DEFAULT_SOURCE_PATH,
    "TAKOSUMI_STAGING_SOURCE_PATH",
  );
  const modulePath = readRelativePath(
    environment.TAKOSUMI_STAGING_MODULE_PATH ?? MANAGED_MODULE_PATH,
    "TAKOSUMI_STAGING_MODULE_PATH",
  );
  if (modulePath !== MANAGED_MODULE_PATH) {
    throw new Error(
      `TAKOSUMI_STAGING_MODULE_PATH must select the exact ${MANAGED_MODULE_PATH} managed module; root module mode is not supported`,
    );
  }
  const capsuleName = readCapsuleName(
    environment.TAKOSUMI_STAGING_CAPSULE_NAME,
  );
  const providerConnectionId = requiredIdentifier(
    environment.TAKOSUMI_STAGING_PROVIDER_CONNECTION_ID,
    "TAKOSUMI_STAGING_PROVIDER_CONNECTION_ID",
  );
  if (environment.TAKOSUMI_STAGING_PROVIDER_CONNECTIONS_FILE?.trim()) {
    throw new Error(
      "TAKOSUMI_STAGING_PROVIDER_CONNECTIONS_FILE is not accepted; root module mode is not supported",
    );
  }
  const timeoutSeconds = boundedInteger(
    environment.TAKOSUMI_STAGING_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
    MIN_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
    "TAKOSUMI_STAGING_TIMEOUT_SECONDS",
  );

  // There is no production switch. This runner always creates an isolated
  // staging Capsule and refuses a caller-provided environment override.
  if (environment.TAKOSUMI_STAGING_ENVIRONMENT?.trim()) {
    throw new Error(
      "TAKOSUMI_STAGING_ENVIRONMENT is not configurable; this harness is staging-only",
    );
  }
  if (environment.TF_IN_AUTOMATION === "0") {
    throw new Error(
      "TF_IN_AUTOMATION=0 is not allowed for the staging harness",
    );
  }

  return {
    takosumiOrigin,
    takosumiDeployReceiptFile,
    takoserverOwnerOrigin,
    takoserverOrganizationId,
    takoserverEvidenceCredentialFile,
    workspaceId,
    sessionTokenFile,
    sessionCookieFile,
    probeActorApId,
    sourceUrl,
    sourceRef,
    sourcePath,
    modulePath,
    capsuleName,
    providerConnectionId,
    timeoutMs: timeoutSeconds * 1_000,
  };
}

/** Managed Takoform must remain a single exact 4.0.0 Provider requirement. */
export function deriveManagedProviderBindings(
  requirements: readonly ProviderRequirement[],
  connectionId: string,
): readonly ProviderBindingSelection[] {
  const selected = connectionId.trim();
  if (!selected)
    throw new Error("managed Takoform ProviderConnection id is empty");
  const normalized = requirements.map((requirement, index) =>
    normalizeProviderRequirement(requirement, index),
  );
  if (
    normalized.length !== 1 ||
    normalized[0]!.provider !== TAKOFORM_PROVIDER_SOURCE ||
    normalized[0]!.moduleLocalName !== "takoform" ||
    normalized[0]!.childAlias !== undefined ||
    normalized[0]!.version !== TAKOFORM_PROVIDER_VERSION
  ) {
    throw new Error(
      `deploy/takoform requires only ${TAKOFORM_PROVIDER_SOURCE} (Provider ${TAKOFORM_PROVIDER_VERSION})`,
    );
  }
  return [
    {
      provider: normalized[0]!.provider,
      moduleLocalName: normalized[0]!.moduleLocalName,
      connectionId: selected,
    },
  ];
}

/** Validate the public, value-free inventory recorded by Takosumi after apply. */
export function assertManagedResourceInventory(
  value: unknown,
  providerSources: readonly string[] = [TAKOFORM_PROVIDER_SOURCE],
  expectedLineage?: ManagedResourceLineage,
): void {
  assertManagedResourceInventoryProjection(
    value,
    false,
    providerSources,
    expectedLineage,
  );
}

/**
 * Join Takosumi's value-free Terraform inventory with the module's closed UID
 * output.  The resulting list is the only set of identities permitted for a
 * Takoserver evidence read: one UID per graph address, with no caller-supplied
 * resource names or guessed IDs.
 */
export function readManagedResourceIdentities(
  inventoryValue: unknown,
  outputsValue: unknown,
  expectedLineage?: ManagedResourceLineage,
): readonly ManagedResourceIdentity[] {
  assertManagedResourceInventory(
    inventoryValue,
    [TAKOFORM_PROVIDER_SOURCE],
    expectedLineage,
  );
  const inventory = nestedRecord(inventoryValue, "inventory response");
  const inventoryProjection = nestedRecord(
    inventory.inventory,
    "inventory response.inventory",
  );
  const entries = inventoryProjection.resources;
  if (!Array.isArray(entries)) {
    throw new Error("Capsule inventory resources were not a list");
  }
  const output = assertOutputProjection(outputsValue);
  if (output.capsuleId !== inventoryProjection.capsuleId) {
    throw new Error("Output capsule identity did not match current inventory");
  }
  if (output.workspaceId !== inventoryProjection.workspaceId) {
    throw new Error(
      "Output Workspace identity did not match current inventory",
    );
  }
  if (output.stateGeneration !== inventoryProjection.generation) {
    throw new Error(
      "Output state generation did not match current inventory generation",
    );
  }
  if (expectedLineage !== undefined) {
    assertOutputLineage(output, expectedLineage);
  }
  const workspaceOutputs = nestedRecord(
    output.workspaceOutputs,
    "Capsule outputs response.output.workspaceOutputs",
  );
  const ids = nestedRecord(
    workspaceOutputs.takoform_resource_ids,
    "Capsule outputs response.output.workspaceOutputs.takoform_resource_ids",
  );
  const expectedOutputKeys = CURRENT_RESOURCE_GRAPH.map(
    ({ outputKey }) => outputKey,
  );
  const missingOutputKeys = expectedOutputKeys.filter(
    (key) => typeof ids[key] !== "string" || !ids[key].trim(),
  );
  if (missingOutputKeys.length > 0) {
    throw new Error(
      `Capsule outputs takoform_resource_ids did not contain all ${CURRENT_RESOURCE_GRAPH.length} Resource UIDs`,
    );
  }
  assertExactKeys(
    ids,
    expectedOutputKeys,
    "Capsule outputs takoform_resource_ids",
  );
  const seen = new Set<string>();
  return CURRENT_RESOURCE_GRAPH.map(({ outputKey, address, type }) => {
    const uid = requiredIdentifier(
      typeof ids[outputKey] === "string" ? ids[outputKey] : undefined,
      `takoform_resource_ids.${outputKey}`,
    );
    if (seen.has(uid)) {
      throw new Error(
        "takoform_resource_ids contained duplicate Resource UIDs",
      );
    }
    seen.add(uid);
    const matches = entries.filter(
      (candidate): candidate is JsonRecord =>
        isRecord(candidate) &&
        candidate.address === address &&
        candidate.type === type,
    );
    if (matches.length !== 1) {
      throw new Error(
        `current inventory did not contain exactly one ${address} identity`,
      );
    }
    return { outputKey, address, type, uid };
  });
}

/** Validate the empty current inventory after a successful destroy. */
export function assertManagedResourceInventoryEmpty(
  value: unknown,
  expectedLineage?: ManagedResourceLineage,
): void {
  assertManagedResourceInventoryProjection(value, true, [], expectedLineage);
}

function assertManagedResourceInventoryProjection(
  value: unknown,
  expectEmpty: boolean,
  providerSources: readonly string[],
  expectedLineage: ManagedResourceLineage | undefined,
): void {
  if (!isRecord(value)) {
    throw new Error("Capsule current-resource-inventory response was invalid");
  }
  assertExactKeys(
    value,
    ["inventory"],
    "Capsule current-resource-inventory response",
  );
  if (!isRecord(value.inventory)) {
    throw new Error("Capsule current-resource-inventory response was invalid");
  }
  const inventory = value.inventory;
  assertExactKeys(
    inventory,
    INVENTORY_KEYS,
    "Capsule current-resource-inventory inventory",
  );
  if (inventory.kind !== CAPSULE_CURRENT_RESOURCE_INVENTORY_KIND) {
    throw new Error("Capsule current-resource-inventory kind was invalid");
  }
  const capsuleId = requiredIdentifier(
    typeof inventory.capsuleId === "string" ? inventory.capsuleId : undefined,
    "Capsule current-resource-inventory capsuleId",
  );
  const workspaceId = requiredIdentifier(
    typeof inventory.workspaceId === "string"
      ? inventory.workspaceId
      : undefined,
    "Capsule current-resource-inventory workspaceId",
  );
  boundedTextValue(
    inventory.environment,
    "Capsule current-resource-inventory environment",
    128,
  );
  const stateVersionId = requiredIdentifier(
    typeof inventory.stateVersionId === "string"
      ? inventory.stateVersionId
      : undefined,
    "Capsule current-resource-inventory stateVersionId",
  );
  const generation = requiredInteger(
    inventory.generation,
    "Capsule current-resource-inventory generation",
  );
  if (generation < 1) {
    throw new Error(
      "Capsule current-resource-inventory generation was invalid",
    );
  }
  const applyRunId = requiredIdentifier(
    typeof inventory.applyRunId === "string" ? inventory.applyRunId : undefined,
    "Capsule current-resource-inventory applyRunId",
  );
  const planRunId = requiredIdentifier(
    typeof inventory.planRunId === "string" ? inventory.planRunId : undefined,
    "Capsule current-resource-inventory planRunId",
  );
  assertCanonicalTimestamp(
    inventory.recordedAt,
    "Capsule current-resource-inventory recordedAt",
  );
  if (
    inventory.availability !== "recorded" ||
    !Array.isArray(inventory.resources)
  ) {
    throw new Error(
      "Capsule current-resource-inventory is not a recorded projection",
    );
  }
  if (expectEmpty && inventory.resources.length !== 0) {
    throw new Error(
      "destroyed Capsule current-resource-inventory projection was not empty",
    );
  }
  if (
    !expectEmpty &&
    inventory.resources.length !== CURRENT_RESOURCE_GRAPH.length
  ) {
    throw new Error(
      `managed staging inventory did not contain all ${CURRENT_RESOURCE_GRAPH.length} resources`,
    );
  }
  if (expectedLineage !== undefined) {
    if (capsuleId !== expectedLineage.capsuleId) {
      throw new Error(
        "current inventory Capsule identity did not match Run lineage",
      );
    }
    if (workspaceId !== expectedLineage.workspaceId) {
      throw new Error(
        "current inventory Workspace identity did not match Run lineage",
      );
    }
    if (
      expectedLineage.environment !== undefined &&
      inventory.environment !== expectedLineage.environment
    ) {
      throw new Error(
        "current inventory environment did not match Run lineage",
      );
    }
    if (stateVersionId !== expectedLineage.stateVersionId) {
      throw new Error(
        "current inventory StateVersion identity did not match Run lineage",
      );
    }
    if (generation !== expectedLineage.generation) {
      throw new Error(
        "current inventory state generation did not match Run lineage",
      );
    }
    if (applyRunId !== expectedLineage.applyRunId) {
      throw new Error(
        "current inventory ApplyRun identity did not match Run lineage",
      );
    }
    if (planRunId !== expectedLineage.planRunId) {
      throw new Error(
        "current inventory PlanRun identity did not match Run lineage",
      );
    }
  }
  if (expectEmpty) return;
  if (providerSources.length === 0) {
    throw new Error("managed staging inventory provider set was empty");
  }
  const actual = inventory.resources
    .map((resource, index) => {
      if (!isRecord(resource))
        throw new Error(`resource inventory entry ${index + 1} was invalid`);
      assertClosedKeys(
        resource,
        ["address", "type"],
        ["providerSource"],
        `resource inventory entry ${index + 1}`,
      );
      if (
        typeof resource.address !== "string" ||
        typeof resource.type !== "string"
      ) {
        throw new Error(
          `resource inventory entry ${index + 1} omitted address/type`,
        );
      }
      if (
        typeof resource.providerSource !== "string" ||
        !providerSources.includes(resource.providerSource)
      ) {
        throw new Error(
          `resource inventory entry ${index + 1} omitted or used an unselected Provider`,
        );
      }
      return `${resource.address}\0${resource.type}`;
    })
    .sort();
  const expected = CURRENT_RESOURCE_GRAPH.map(
    ({ address, type }) => `${address}\0${type}`,
  ).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "managed staging inventory did not match the current Takoform graph",
    );
  }
}

function assertOutputProjection(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new Error("Capsule outputs response was invalid");
  }
  assertExactKeys(value, ["output"], "Capsule outputs response");
  if (!isRecord(value.output)) {
    throw new Error("Capsule outputs response.output was not present");
  }
  const output = value.output;
  assertExactKeys(output, OUTPUT_KEYS, "Capsule outputs response.output");
  requiredIdentifier(
    typeof output.id === "string" ? output.id : undefined,
    "Capsule outputs response.output.id",
  );
  requiredIdentifier(
    typeof output.capsuleId === "string" ? output.capsuleId : undefined,
    "Capsule outputs response.output.capsuleId",
  );
  requiredIdentifier(
    typeof output.workspaceId === "string" ? output.workspaceId : undefined,
    "Capsule outputs response.output.workspaceId",
  );
  const stateGeneration = requiredInteger(
    output.stateGeneration,
    "Capsule outputs response.output.stateGeneration",
  );
  if (stateGeneration < 1) {
    throw new Error(
      "Capsule outputs response.output.stateGeneration was invalid",
    );
  }
  requiredDigest(
    output.outputDigest,
    "Capsule outputs response.output.outputDigest",
  );
  assertCanonicalTimestamp(
    output.createdAt,
    "Capsule outputs response.output.createdAt",
  );
  if (!isRecord(output.publicOutputs) || !isRecord(output.workspaceOutputs)) {
    throw new Error("Capsule outputs projections were invalid");
  }
  return output;
}

function assertOutputLineage(
  output: JsonRecord,
  expected: ManagedResourceLineage,
): void {
  if (output.capsuleId !== expected.capsuleId) {
    throw new Error("Output capsule identity did not match Run lineage");
  }
  if (output.workspaceId !== expected.workspaceId) {
    throw new Error("Output Workspace identity did not match Run lineage");
  }
  if (output.stateGeneration !== expected.generation) {
    throw new Error("Output state generation did not match Run lineage");
  }
}

/** Validate the resolved launcher returned only to a principal with ui.open. */
export function assertManagedLauncher(value: unknown, launchUrl: string): void {
  if (!isRecord(value) || !Array.isArray(value.interfaces)) {
    throw new Error("Takosumi ui-surfaces response was invalid");
  }
  const launchers = value.interfaces.filter(
    (candidate): candidate is JsonRecord =>
      isRecord(candidate) &&
      isRecord(candidate.spec) &&
      candidate.spec.type === "interface.ui.surface" &&
      candidate.spec.version === "1" &&
      isRecord(candidate.status) &&
      candidate.status.phase === "Resolved",
  );
  if (launchers.length !== 1) {
    throw new Error("managed staging did not resolve exactly one UI launcher");
  }
  const launcher = launchers[0]!;
  const spec = launcher.spec as JsonRecord;
  const access = spec.access;
  if (!isRecord(access) || access.visibility !== "workspace") {
    throw new Error("managed launcher did not retain workspace visibility");
  }
  const status = launcher.status as JsonRecord;
  const inputs = status.resolvedInputs;
  const resolvedUrl = isRecord(inputs) ? inputs.url : undefined;
  if (resolvedUrl !== launchUrl) {
    throw new Error(
      "managed launcher launch_url resolution did not match Capsule output",
    );
  }
  // The session endpoint itself is filtered by the canonical ui.open binding;
  // seeing this Interface is therefore authorization evidence, not just a
  // public Interface document read.
}

/** Destroy must remove the UI launcher from the authorized current surface. */
export function assertManagedLauncherAbsent(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.interfaces)) {
    throw new Error("Takosumi ui-surfaces response was invalid");
  }
  const launchers = value.interfaces.filter(
    (candidate): candidate is JsonRecord =>
      isRecord(candidate) &&
      isRecord(candidate.spec) &&
      candidate.spec.type === "interface.ui.surface" &&
      candidate.spec.version === "1",
  );
  if (launchers.length !== 0) {
    throw new Error("destroyed Capsule still exposed a UI launcher");
  }
}

function providerTupleKey(requirement: ProviderRequirement): string {
  return `${requirement.provider}\0${requirement.moduleLocalName}\0${requirement.childAlias ?? ""}`;
}

function normalizeProviderRequirement(
  requirement: ProviderRequirement,
  index: number,
): ProviderRequirement {
  if (!isRecord(requirement))
    throw new Error(`provider requirement ${index + 1} was invalid`);
  const provider = boundedTextValue(
    typeof requirement.provider === "string"
      ? requirement.provider
      : requirement.source,
    `provider requirement ${index + 1}.provider`,
    512,
  );
  const moduleLocalName = boundedTextValue(
    requirement.moduleLocalName,
    `provider requirement ${index + 1}.moduleLocalName`,
    128,
  );
  const childAlias =
    requirement.childAlias === undefined
      ? undefined
      : boundedTextValue(
          requirement.childAlias,
          `provider requirement ${index + 1}.childAlias`,
          128,
        );
  const version =
    requirement.version === undefined
      ? undefined
      : boundedTextValue(
          requirement.version,
          `provider requirement ${index + 1}.version`,
          64,
        );
  return {
    provider,
    moduleLocalName,
    ...(childAlias ? { childAlias } : {}),
    ...(version ? { version } : {}),
  };
}

async function main(): Promise<void> {
  const config = readManagedStagingConfig(process.env);
  // Prove that the configured URL is the owner-deployed staging Worker before
  // opening either private credential file.  A DNS/route mix-up must never
  // receive a bearer token or OIDC cookie.
  const takosumiProof = await probeTakosumiDeployment(config);
  const takosumiReceipt = takosumiProof.receipt;
  const sessionToken = await readSecretFile(
    config.sessionTokenFile,
    "Takosumi session token",
  );
  const takoserverEvidenceTransport = await createPinnedHttpTransport(
    config.takoserverOwnerOrigin,
  );
  const takoserverEvidenceCredential = await readPrivateFile(
    config.takoserverEvidenceCredentialFile,
    "Takoserver read-only execution evidence credential",
    false,
  );
  const takoserverEvidence = createTakoserverEvidenceClient(
    config.takoserverOwnerOrigin,
    config.takoserverOrganizationId,
    takoserverEvidenceCredential,
    takoserverEvidenceTransport,
  );
  // This is a mandatory pre-mutation capability gate.  It deliberately runs
  // before the InstallPlan POST so an unavailable owner evidence surface can
  // never strand a newly-created Capsule.
  await proveTakoserverEvidenceCapability(takoserverEvidence);

  const api = createApiClient(
    config.takosumiOrigin,
    sessionToken,
    takosumiReceipt.deployedVersionId,
    takosumiProof.transport,
  );
  const checks: string[] = [];
  let capsuleId = "";
  let destroyAttempted = false;
  let primaryError: unknown;
  let launchUrl = "";
  let installPlanRunId = "";
  let configurationPlanRunId = "";
  let applyRunId = "";
  let destroyPlanRunId = "";
  let destroyApplyRunId = "";
  let sourceSnapshotEvidence: SourceSnapshotEvidence | undefined;
  let managedResourceIdentities: readonly ManagedResourceIdentity[] | undefined;
  let applyEvidenceReadback: TakoserverEvidenceReadback | undefined;
  let destroyAcknowledgementInterval:
    DestroyAcknowledgementInterval | undefined;
  let lifecycle: LifecyclePhase = "none";
  let mutationUncertain = false;

  try {
    const recipes = await api.requestJson("/api/v1/credential-recipes", {
      expectedStatus: 200,
    });
    const connections = await api.requestJson(
      `/api/v1/provider-connections?workspaceId=${encodeURIComponent(config.workspaceId)}`,
      { expectedStatus: 200 },
    );
    const selection = await readProviderSelection(config);
    const selectedConnections = assertSelectedConnections(
      connections,
      recipes,
      selection,
      config.workspaceId,
    );
    checks.push("provider-connections.recipe");

    const install = await createInstallPlan(api, config);
    const configured = await driveInstallPlan(
      api,
      install,
      config,
      selection,
      selectedConnections,
    );
    checks.push("git.install-plan");
    capsuleId = requiredString(
      configured.installPlan.capsuleId,
      "installPlan.capsuleId",
    );
    lifecycle = "capsule-created";
    installPlanRunId = requiredString(
      configured.installPlan.planRunId,
      "installPlan.planRunId",
    );
    assertInstallPlanProviderPin(configured.installPlan);
    const installPlanRun = await readRun(api, installPlanRunId);
    assertRunType(installPlanRun, "Git install PlanRun", "plan");
    assertReviewableRun(installPlanRun, "Git install plan");
    assertRunGraph(installPlanRun);

    const providerBindings = await api.requestJson(
      `/api/v1/capsules/${encodeURIComponent(capsuleId)}/provider-bindings`,
      { expectedStatus: 200 },
    );
    assertProviderBindingSet(
      providerBindings,
      selection,
      capsuleId,
      config.workspaceId,
    );
    checks.push("provider-binding-array");

    const capsuleRead = await api.requestJson(
      `/api/v1/capsules/${encodeURIComponent(capsuleId)}`,
      { expectedStatus: 200 },
    );
    sourceSnapshotEvidence = await readSourceSnapshotEvidence(
      api,
      capsuleRead,
      installPlanRun,
      config,
    );
    checks.push("source.snapshot.commit-digest");
    const authorityGuard = readAuthorityGuard(capsuleRead);
    const configuration = await createConfigurationPlan(
      api,
      capsuleId,
      extractProviderBindings(providerBindings),
      authorityGuard,
    );
    checks.push("configuration-plan");
    configurationPlanRunId = requiredString(
      nestedRecord(configuration.configurationPlan, "configuration plan")
        .planRunId,
      "configurationPlan.planRunId",
    );

    const reviewedPlan = await waitForReviewableRun(
      api,
      configurationPlanRunId,
      config.timeoutMs,
    );
    assertRunType(reviewedPlan, "configuration PlanRun", "plan");
    assertRunProviderPin(reviewedPlan);
    assertRunGraph(reviewedPlan);
    assertSourceSnapshotRunConsistency(reviewedPlan, sourceSnapshotEvidence!);
    lifecycle = "plan-reviewed";
    checks.push("plan.reviewed");

    const approved = await approveRunIfRequired(
      api,
      configurationPlanRunId,
      reviewedPlan,
    );
    if (approved) checks.push("plan.approved");
    lifecycle = "apply-dispatch-started";
    const applied = await mutateWithRunReconciliation(
      api,
      `/api/v1/runs/${encodeURIComponent(configurationPlanRunId)}/apply`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(
            "yurucommu-apply",
            configurationPlanRunId,
          ),
        },
        expectedStatus: 201,
      },
      (client) => reconcileApplyMutation(client, configurationPlanRunId),
      "configuration apply",
      (value) =>
        parseRunMutationResponse(value, "configuration apply", "apply"),
    );
    applyRunId = requiredString(
      nestedRecord(applied.run, "run response").id,
      "apply run id",
    );
    const appliedRun = await waitForSucceededRun(
      api,
      applyRunId,
      config.timeoutMs,
    );
    assertRunType(appliedRun, "configuration ApplyRun", "apply");
    assertRunSucceeded(appliedRun, "apply");
    assertSourceSnapshotRunConsistency(
      appliedRun,
      sourceSnapshotEvidence!,
      configurationPlanRunId,
    );
    // The ApplyRun readback is the authoritative lifecycle boundary.  From
    // this point on, any evidence, output, or functional-probe failure must
    // enter the normal Destroy path rather than leaving a Capsule stranded.
    lifecycle = "apply-confirmed";
    checks.push("apply.succeeded");

    const appliedCapsuleResponse = await api.requestJson(
      `/api/v1/capsules/${encodeURIComponent(capsuleId)}`,
      { expectedStatus: 200 },
    );
    const appliedCapsuleContext = readCapsuleRunIdentityContext(
      appliedCapsuleResponse,
      capsuleId,
      config.workspaceId,
    );
    if (!appliedCapsuleContext.currentStateVersionId) {
      throw new Error(
        "Apply succeeded without a current StateVersion identity for inventory lineage",
      );
    }
    const appliedInventoryLineage: ManagedResourceLineage = {
      capsuleId: appliedCapsuleContext.capsuleId,
      workspaceId: appliedCapsuleContext.workspaceId,
      environment: STAGING_ENVIRONMENT,
      stateVersionId: appliedCapsuleContext.currentStateVersionId,
      generation: appliedCapsuleContext.baseStateGeneration,
      applyRunId,
      planRunId: configurationPlanRunId,
    };
    const inventory = await api.requestJson(
      `/api/v1/capsules/${encodeURIComponent(capsuleId)}/current-resource-inventory`,
      { expectedStatus: 200 },
    );
    assertManagedResourceInventory(
      inventory,
      [TAKOFORM_PROVIDER_SOURCE],
      appliedInventoryLineage,
    );
    checks.push(`resources.ready.${CURRENT_RESOURCE_GRAPH.length}`);

    const outputs = await api.requestJson(
      `/api/v1/capsules/${encodeURIComponent(capsuleId)}/outputs`,
      { expectedStatus: 200 },
    );
    managedResourceIdentities = readManagedResourceIdentities(
      inventory,
      outputs,
      appliedInventoryLineage,
    );
    launchUrl = readLaunchUrl(outputs);
    checks.push("output.launch_url");

    applyEvidenceReadback = await readTakoserverExecutionEvidence(
      takoserverEvidence,
      managedResourceIdentities,
      "apply",
    );
    checks.push("takoserver.execution.apply");

    const interfaces = await api.requestJson(
      `/api/v1/workspaces/${encodeURIComponent(config.workspaceId)}/ui-surfaces?capsuleId=${encodeURIComponent(capsuleId)}`,
      { expectedStatus: 200 },
    );
    assertManagedLauncher(interfaces, launchUrl);
    checks.push("interface.launch_url.ui.open");
    lifecycle = "functional-probe";

    // Qualify the launch host and pin its DNS answer before the OIDC cookie is
    // handed to any product request.  The Takosumi API transport is a
    // different origin and is never reused for the product host.
    const launchTransport = await createPinnedHttpTransport(launchUrl);
    const sessionCookie = await readSecretFile(
      config.sessionCookieFile,
      "Yurucommu OIDC session cookie",
    );
    if (!sessionCookie.startsWith("session=")) {
      throw new Error(
        "Yurucommu session cookie file must contain a session cookie from the real OIDC callback",
      );
    }
    const probe = await runFunctionalProbe({
      launchUrl,
      sessionCookie,
      expectedActorApId: config.probeActorApId,
      transport: launchTransport,
      requireOidc: true,
    });
    checks.push(...probe.checks.map((name) => `oidc.${name}`));
  } catch (error) {
    primaryError = error;
    if (
      isMutationUncertain(error) ||
      isFunctionalProbeMutationUncertain(error)
    ) {
      mutationUncertain = true;
    }
  }

  const cleanupErrors: unknown[] = [];
  const cleanupDecision = decideCleanup(
    lifecycle,
    mutationUncertain,
    capsuleId,
  );
  if (cleanupDecision === "refuse") {
    cleanupErrors.push(
      new Error(
        "cleanup refused: a mutation acknowledgement was lost after dispatch; reconcile the recorded Run before any destroy",
      ),
    );
  } else if (capsuleId) {
    destroyAttempted = true;
    const destroyErrors: unknown[] = [];
    let destroyApplyAcknowledged = false;
    try {
      const destroyCapsuleResponse = await api.requestJson(
        `/api/v1/capsules/${encodeURIComponent(capsuleId)}`,
        { expectedStatus: 200 },
      );
      const destroyContext = readCapsuleRunIdentityContext(
        destroyCapsuleResponse,
        capsuleId,
        config.workspaceId,
      );
      lifecycle = "destroy-plan-dispatch-started";
      const destroy = await mutateWithRunReconciliation(
        api,
        `/api/v1/capsules/${encodeURIComponent(capsuleId)}/destroy-plan`,
        {
          method: "POST",
          body: {},
          headers: {
            "Idempotency-Key": idempotencyKey(
              "yurucommu-destroy-plan",
              capsuleId,
            ),
          },
          expectedStatus: 201,
        },
        (client) => reconcileDestroyPlanMutation(client, capsuleId),
        "destroy plan",
        (value) =>
          parseRunMutationResponse(value, "destroy plan", "destroy_plan"),
      );
      destroyPlanRunId = requiredString(
        nestedRecord(destroy.run, "destroy response").id,
        "destroy run id",
      );
      const destroyPlan = await waitForReviewableRun(
        api,
        destroyPlanRunId,
        config.timeoutMs,
      );
      assertRunType(destroyPlan, "destroy PlanRun", "destroy_plan");
      if (sourceSnapshotEvidence) {
        assertSourceSnapshotRunConsistency(
          destroyPlan,
          sourceSnapshotEvidence,
          undefined,
          destroyContext,
        );
      } else {
        assertDestroyRunIdentity(destroyPlan, destroyContext);
      }
      assertDestroyRequiresApproval(destroyPlan);
      await approveRunIfRequired(api, destroyPlanRunId, destroyPlan);
      lifecycle = "destroy-plan-confirmed";
      lifecycle = "destroy-apply-dispatch-started";
      const destroyApplyStartedAtMs = Date.now();
      const appliedDestroy = await mutateWithRunReconciliation(
        api,
        `/api/v1/runs/${encodeURIComponent(destroyPlanRunId)}/apply`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": idempotencyKey(
              "yurucommu-destroy-apply",
              destroyPlanRunId,
            ),
          },
          expectedStatus: 201,
        },
        (client) => reconcileApplyMutation(client, destroyPlanRunId),
        "destroy apply",
        (value) =>
          parseRunMutationResponse(value, "destroy apply", "destroy_apply"),
      );
      destroyApplyRunId = requiredString(
        nestedRecord(appliedDestroy.run, "destroy apply response").id,
        "destroy apply run id",
      );
      const destroyedRun = await waitForSucceededRun(
        api,
        destroyApplyRunId,
        config.timeoutMs,
      );
      destroyAcknowledgementInterval = {
        startedAtMs: destroyApplyStartedAtMs,
        acknowledgedAtMs: Date.now(),
      };
      assertRunType(destroyedRun, "destroy ApplyRun", "destroy_apply");
      assertRunSucceeded(destroyedRun, "destroy apply");
      // This is the authoritative lifecycle boundary.  It is deliberately
      // set before any later evidence/projection checks so a malformed
      // SourceSnapshot or Takoserver readback cannot strand a succeeded
      // destroy without running all independent absence checks.
      destroyApplyAcknowledged = true;
      try {
        await assertExactDestroyedProjection(api, {
          capsuleId,
          workspaceId: config.workspaceId,
          planRunId: destroyPlanRunId,
          applyRunId: destroyApplyRunId,
        });
        checks.push("destroy.exact-absence");
      } catch (error) {
        destroyErrors.push(error);
      }
      try {
        if (sourceSnapshotEvidence) {
          assertSourceSnapshotRunConsistency(
            destroyedRun,
            sourceSnapshotEvidence,
            destroyPlanRunId,
            destroyContext,
          );
        } else {
          assertDestroyRunIdentity(
            destroyedRun,
            destroyContext,
            destroyPlanRunId,
          );
        }
      } catch (error) {
        destroyErrors.push(error);
      }
      if (!managedResourceIdentities) {
        destroyErrors.push(
          new Error(
            "destroy cannot prove Takoserver delete evidence because Apply did not publish managed Resource identities",
          ),
        );
      } else {
        let destroyEvidence: TakoserverEvidenceReadback | undefined;
        try {
          destroyEvidence = await readTakoserverExecutionEvidence(
            takoserverEvidence,
            managedResourceIdentities,
            "destroy",
            applyEvidenceReadback?.snapshotFences,
            applyEvidenceReadback?.historyFingerprints,
          );
          if (!applyEvidenceReadback) {
            throw new Error(
              "destroy evidence lacked the Apply evidence prefix/fence baseline",
            );
          }
          for (const resource of managedResourceIdentities) {
            const applyIdentity =
              applyEvidenceReadback.identityFingerprints.get(resource.uid);
            const destroyIdentity = destroyEvidence.identityFingerprints.get(
              resource.uid,
            );
            if (!applyIdentity || applyIdentity !== destroyIdentity) {
              throw new Error(
                `Takoserver execution evidence Resource identity prefix drifted for ${resource.outputKey}`,
              );
            }
            const applyPrefix = applyEvidenceReadback.prefixFingerprints.get(
              resource.uid,
            );
            const destroyPrefix = destroyEvidence.prefixFingerprints.get(
              resource.uid,
            );
            if (!applyPrefix || applyPrefix !== destroyPrefix) {
              throw new Error(
                `Takoserver execution evidence apply prefix drifted for ${resource.outputKey}`,
              );
            }
          }
          checks.push("takoserver.execution.destroy");
        } catch (error) {
          destroyErrors.push(error);
        }
        // Each UID-dependent residual check is independent.  A failed
        // aggregate read must not prevent the generic Resource 404 checks,
        // and one malformed UID must not short-circuit its siblings.
        for (const resource of managedResourceIdentities) {
          const address = destroyEvidence?.addresses.get(resource.uid);
          if (!address) {
            destroyErrors.push(
              new Error(
                `Takoserver native absence lacked an exact address for ${resource.outputKey}`,
              ),
            );
          } else {
            try {
              if (!destroyAcknowledgementInterval) {
                throw new Error(
                  "destroy Apply acknowledgement interval was unavailable",
                );
              }
              await assertTakoserverNativeAbsent(
                takoserverEvidence,
                resource,
                address,
                destroyAcknowledgementInterval,
              );
            } catch (error) {
              destroyErrors.push(error);
            }
          }
          try {
            await assertTakoserverResourceAbsent(takoserverEvidence, resource);
          } catch (error) {
            destroyErrors.push(error);
          }
        }
        if (destroyEvidence) checks.push("takoserver.native-absence");
      }
    } catch (error) {
      if (isMutationUncertain(error)) mutationUncertain = true;
      destroyErrors.push(error);
    }
    if (destroyApplyAcknowledged && destroyErrors.length === 0) {
      lifecycle = "destroy-confirmed";
    }
    cleanupErrors.push(...destroyErrors);
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "managed staging E2E and cleanup both failed",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "managed staging cleanup failed");
  }
  if (!destroyAttempted) {
    throw new Error("managed staging E2E did not create a cleanup boundary");
  }

  console.log(
    JSON.stringify({
      kind: "yurucommu.takosumi-managed-staging-e2e@v1",
      status: "passed",
      environment: STAGING_ENVIRONMENT,
      provider: {
        source: TAKOFORM_PROVIDER_SOURCE,
        version: TAKOFORM_PROVIDER_VERSION,
      },
      graph: {
        resources: CURRENT_RESOURCE_GRAPH.length,
        kinds: [...new Set(CURRENT_RESOURCE_TYPES)].length,
      },
      takosumi: {
        deployVersionId: takosumiReceipt.deployedVersionId,
        predecessorVersionId: takosumiReceipt.predecessorVersionId,
        deploySourceCommit: takosumiReceipt.sourceCommit,
        planConfirmation: takosumiReceipt.planConfirmation,
        deployReceiptDigest: takosumiReceipt.fileDigest,
        installPlanRunId,
        configurationPlanRunId,
        applyRunId,
        destroyPlanRunId,
        destroyApplyRunId,
      },
      sourceSnapshot: sourceSnapshotEvidence,
      checks: checks.map((name) => ({ name, status: "passed" })),
      cleanupVerified: true,
    }),
  );
}

async function createInstallPlan(
  api: ApiClient,
  config: ManagedStagingConfig,
): Promise<InstallPlanResponse> {
  const path = `/api/v1/workspaces/${encodeURIComponent(config.workspaceId)}/install-plans`;
  const options = {
    method: "POST" as const,
    headers: {
      "Idempotency-Key": idempotencyKey(
        "yurucommu-install-plan",
        config.capsuleName,
      ),
    },
    // A fresh durable create returns 201; replaying the same idempotency key
    // after a lost acknowledgement returns the original plan with 200.
    expectedStatus: [200, 201] as const,
    body: {
      source: {
        name: `yurucommu-${config.capsuleName}`,
        url: config.sourceUrl,
        ref: config.sourceRef,
        path: config.sourcePath,
      },
      capsule: { name: config.capsuleName, environment: STAGING_ENVIRONMENT },
      options: { modulePath: config.modulePath },
    },
  };
  const value = await mutateWithRunReconciliation(
    api,
    path,
    options,
    // A lost create acknowledgement has no Capsule/Plan id yet.  Replay the
    // exact owner request with the same idempotency key; the durable install
    // ledger returns the original plan or remains indeterminate.  Never scan
    // by a guessed capsule name or synthesize an id from a partial response.
    (client) => client.requestJson(path, options),
    "install plan",
    parseInstallPlanResponse,
  );
  return value;
}

async function createConfigurationPlan(
  api: ApiClient,
  capsuleId: string,
  providerBindings: readonly ProviderBindingSelection[],
  authorityGuard: string,
): Promise<JsonRecord> {
  try {
    return await mutateWithRunReconciliation(
      api,
      `/api/v1/capsules/${encodeURIComponent(capsuleId)}/configuration-plans`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(
            "yurucommu-configuration-plan",
            capsuleId,
          ),
        },
        expectedStatus: [200, 201],
        body: {
          variablePatch: { set: {}, remove: [] },
          providerBindings,
          interfaceBlueprints: [
            {
              key: "launcher",
              name: "yurucommu.launcher",
              spec: {
                type: "interface.ui.surface",
                version: "1",
                document: {
                  launcher: true,
                  display: {
                    title: "Yurucommu",
                    icon: "/icons/yurucommu.svg",
                  },
                },
                inputs: {
                  url: {
                    source: "capsule_output",
                    outputName: "launch_url",
                  },
                },
                access: { visibility: "workspace" },
              },
              bindings: [
                {
                  key: "installer",
                  subject: { source: "installing_principal" },
                  permissions: ["ui.open"],
                  delivery: { type: "none" },
                },
              ],
            },
          ],
          expected: { authorityGuard },
        },
      },
      (client) => reconcileConfigurationPlanMutation(client, capsuleId),
      "configuration plan",
      parseConfigurationPlanResponse,
    );
  } catch (error) {
    // Keep an unavailable upstream configuration-plan contract explicit. The
    // caller still enters the mandatory destroy boundary for the Capsule.
    if (error instanceof Error && /HTTP 404/u.test(error.message)) {
      throw new MutationUncertainError(
        "Takosumi configuration-plan endpoint is unavailable after dispatch; refusing to fall back to a direct Provider run or guess cleanup",
      );
    }
    throw error;
  }
}

async function submitInstallAction(
  api: ApiClient,
  planId: string,
  options: Parameters<ApiClient["requestJson"]>[1],
  actionKind: "choose_module" | "configure" | "reconcile",
): Promise<InstallPlanResponse> {
  try {
    const response = await api.requestJson(
      `/api/v1/install-plans/${encodeURIComponent(planId)}${actionKind === "reconcile" ? "/reconcile" : "/actions"}`,
      options,
    );
    try {
      return parseInstallPlanResponse(response, planId, actionKind);
    } catch (error) {
      throw new MutationUncertainError(
        `${actionKind} install-plan response was semantically invalid after dispatch: ${
          error instanceof Error ? error.message : "unknown response error"
        }`,
      );
    }
  } catch (error) {
    if (!isMutationUncertain(error)) throw error;
    // The action key is stable.  Re-read the immutable plan before retrying so
    // a lost acknowledgement cannot submit a second contextual action.
    const observed = await api
      .requestJson(`/api/v1/install-plans/${encodeURIComponent(planId)}`, {
        expectedStatus: 200,
      })
      .catch(() => undefined);
    if (observed) {
      try {
        const parsed = parseInstallPlanResponse(observed, planId, actionKind);
        if (parsed.nextAction !== actionKind) {
          return parsed;
        }
      } catch {
        throw new MutationUncertainError(
          `install plan ${actionKind} reconciliation returned an invalid owner projection`,
        );
      }
    }
    throw new MutationUncertainError(
      `install plan ${actionKind} acknowledgement is indeterminate after dispatch`,
    );
  }
}

async function driveInstallPlan(
  api: ApiClient,
  initial: InstallPlanResponse,
  config: ManagedStagingConfig,
  selection: Readonly<Record<string, string>>,
  selectedConnections: ReadonlyMap<string, JsonRecord>,
): Promise<InstallPlanResponse> {
  let response = initial;
  const planId = requiredString(response.installPlan.id, "installPlan.id");
  let configureSent = false;
  let chooseSent = false;
  const deadline = Date.now() + config.timeoutMs;
  for (;;) {
    if (Date.now() > deadline)
      throw new Error("Takosumi install plan timed out");
    const phase = requiredString(
      response.installPlan.phase,
      "installPlan.phase",
    );
    if (phase === "failed") {
      throw new Error(
        "Takosumi install plan failed; inspect the bounded diagnostic in the control plane",
      );
    }
    switch (response.nextAction) {
      case "choose_module": {
        if (chooseSent)
          throw new Error(
            "Takosumi install plan repeated choose_module without progress",
          );
        const action = requireAction(response, "choose_module");
        const modules = action.modules;
        if (
          !Array.isArray(modules) ||
          !modules.some(
            (candidate) =>
              isRecord(candidate) && candidate.path === config.modulePath,
          )
        ) {
          throw new Error(
            "requested modulePath was not offered by the immutable SourceSnapshot",
          );
        }
        response = await submitInstallAction(
          api,
          planId,
          {
            method: "POST",
            headers: {
              "Idempotency-Key": idempotencyKey(
                "yurucommu-install-action-choose",
                `${planId}-${requiredString(action.id, "choose action id")}`,
              ),
            },
            expectedStatus: 200,
            body: {
              actionId: requiredString(action.id, "choose action id"),
              generation: requiredInteger(
                action.generation,
                "choose action generation",
              ),
              kind: "choose_module",
              modulePath: config.modulePath,
            },
          },
          "choose_module",
        );
        chooseSent = true;
        break;
      }
      case "configure": {
        if (configureSent)
          throw new Error(
            "Takosumi install plan repeated configure without progress",
          );
        const action = requireAction(response, "configure");
        const requirements = parseProviderRequirements(
          action.providerRequirements,
        );
        const bindings = deriveManagedProviderBindings(
          requirements,
          config.providerConnectionId,
        );
        assertBindingsUseSelectedConnections(bindings, selectedConnections);
        response = await submitInstallAction(
          api,
          planId,
          {
            method: "POST",
            headers: {
              "Idempotency-Key": idempotencyKey(
                "yurucommu-install-action-configure",
                `${planId}-${requiredString(action.id, "configure action id")}`,
              ),
            },
            expectedStatus: 200,
            body: {
              actionId: requiredString(action.id, "configure action id"),
              generation: requiredInteger(
                action.generation,
                "configure action generation",
              ),
              kind: "configure",
              variables: {},
              providerBindings: bindings,
            },
          },
          "configure",
        );
        configureSent = true;
        break;
      }
      case "reconcile":
        response = await submitInstallAction(
          api,
          planId,
          {
            method: "POST",
            headers: {
              "Idempotency-Key": idempotencyKey(
                "yurucommu-install-reconcile",
                planId,
              ),
            },
            expectedStatus: 200,
          },
          "reconcile",
        );
        break;
      case "review_run":
        return response;
      case "none":
        if (phase === "reviewable") return response;
        throw new Error(`install plan stopped at unexpected phase ${phase}`);
      default:
        throw new Error(
          `install plan returned unsupported nextAction ${response.nextAction}`,
        );
    }
    if (
      response.nextAction !== "review_run" &&
      response.nextAction !== "none"
    ) {
      await sleep(POLL_DELAY_MS);
    }
  }
}

function assertSelectedConnections(
  value: JsonRecord,
  recipes: JsonRecord,
  selection: Readonly<Record<string, string>>,
  workspaceId: string,
): ReadonlyMap<string, JsonRecord> {
  const rawConnections = value.providerConnections;
  if (!Array.isArray(rawConnections))
    throw new Error(
      "provider-connections response omitted providerConnections",
    );
  const rawRecipes = recipes.recipes;
  if (!Array.isArray(rawRecipes))
    throw new Error("credential-recipes response omitted recipes");
  const recipesById = new Map<string, JsonRecord>();
  for (const candidate of rawRecipes) {
    if (isRecord(candidate) && typeof candidate.id === "string")
      recipesById.set(candidate.id, candidate);
  }
  const connectionsById = new Map<string, JsonRecord>();
  for (const candidate of rawConnections) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
    connectionsById.set(candidate.id, candidate);
  }
  const selected = new Map<string, JsonRecord>();
  for (const [tuple, connectionId] of Object.entries(selection)) {
    const connection = connectionsById.get(connectionId);
    if (!connection)
      throw new Error(
        `selected ProviderConnection ${connectionId} was not visible in the staging Workspace`,
      );
    if (
      connection.workspaceId !== undefined &&
      connection.workspaceId !== workspaceId
    ) {
      throw new Error(
        `selected ProviderConnection ${connectionId} belongs to another Workspace`,
      );
    }
    if (connection.status !== "verified" && connection.status !== "ready") {
      throw new Error(
        `selected ProviderConnection ${connectionId} is not verified`,
      );
    }
    const [providerSource] = tuple.split("\0", 1);
    if (connection.providerSource !== providerSource) {
      throw new Error(
        `selected ProviderConnection ${connectionId} did not match provider tuple ${providerSource}`,
      );
    }
    const recipeRef = connection.credentialRecipe;
    if (!isRecord(recipeRef) || typeof recipeRef.id !== "string") {
      throw new Error(
        `selected ProviderConnection ${connectionId} omitted its CredentialRecipe reference`,
      );
    }
    const recipe = recipesById.get(recipeRef.id);
    if (!recipe)
      throw new Error(
        `CredentialRecipe ${recipeRef.id} was not installed in the staging control plane`,
      );
    const sources = recipe.terraformSource;
    if (
      sources !== "*" &&
      (!Array.isArray(sources) || !sources.includes(connection.providerSource))
    ) {
      throw new Error(
        `CredentialRecipe ${recipeRef.id} did not admit the selected Provider source`,
      );
    }
    selected.set(connectionId, connection);
  }
  return selected;
}

function assertBindingsUseSelectedConnections(
  bindings: readonly ProviderBindingSelection[],
  selectedConnections: ReadonlyMap<string, JsonRecord>,
): void {
  for (const binding of bindings) {
    if (!selectedConnections.has(binding.connectionId)) {
      throw new Error(
        `ProviderBinding selected an unverified connection ${binding.connectionId}`,
      );
    }
  }
}

async function readProviderSelection(
  config: ManagedStagingConfig,
): Promise<Readonly<Record<string, string>>> {
  if (config.modulePath !== MANAGED_MODULE_PATH) {
    throw new Error(
      `managed staging requires the exact ${MANAGED_MODULE_PATH} module`,
    );
  }
  return {
    [`${TAKOFORM_PROVIDER_SOURCE}\0takoform\0`]: config.providerConnectionId,
  };
}

export function assertInstallPlanProviderPin(installPlan: JsonRecord): void {
  const requirements = parseProviderRequirements(
    installPlan.credentialRequiredProviderRequirements ??
      installPlan.providerRequirements,
  );
  if (
    requirements.length !== 1 ||
    requirements[0]!.provider !== TAKOFORM_PROVIDER_SOURCE ||
    requirements[0]!.moduleLocalName !== "takoform" ||
    requirements[0]!.childAlias !== undefined ||
    requirements[0]!.version !== TAKOFORM_PROVIDER_VERSION
  ) {
    throw new Error(
      "managed install plan did not retain the exact Takoform Provider requirement",
    );
  }
  if (
    Object.hasOwn(installPlan, "providerVersion") &&
    installPlan.providerVersion !== TAKOFORM_PROVIDER_VERSION
  ) {
    throw new Error(
      `managed install plan selected Provider ${String(installPlan.providerVersion)} instead of ${TAKOFORM_PROVIDER_VERSION}`,
    );
  }
}

function assertInstallPlanGraph(installPlan: JsonRecord): void {
  const resources = installPlan.planResources;
  if (
    !Array.isArray(resources) ||
    resources.length !== CURRENT_RESOURCE_GRAPH.length
  ) {
    throw new Error(
      `managed plan did not contain all ${CURRENT_RESOURCE_GRAPH.length} resources`,
    );
  }
  const actual = resources
    .map((resource, index) => {
      if (
        !isRecord(resource) ||
        typeof resource.address !== "string" ||
        typeof resource.type !== "string"
      ) {
        throw new Error(`managed plan resource ${index + 1} was invalid`);
      }
      return `${resource.address}\0${resource.type}`;
    })
    .sort();
  const expected = CURRENT_RESOURCE_GRAPH.map(
    ({ address, type }) => `${address}\0${type}`,
  ).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      "managed plan resource graph drifted from the product module",
    );
}

function assertProviderBindingSet(
  value: JsonRecord,
  selection: Readonly<Record<string, string>>,
  capsuleId: string,
  workspaceId: string,
): void {
  const set = value.providerBindingSet;
  if (
    !isRecord(set) ||
    set.capsuleId !== capsuleId ||
    set.workspaceId !== workspaceId ||
    !Array.isArray(set.bindings)
  ) {
    throw new Error("Capsule ProviderBindingSet identity was invalid");
  }
  const actual = set.bindings
    .map((binding, index) => {
      if (
        !isRecord(binding) ||
        typeof binding.provider !== "string" ||
        typeof binding.moduleLocalName !== "string" ||
        typeof binding.connectionId !== "string"
      ) {
        throw new Error(`ProviderBinding ${index + 1} was invalid`);
      }
      return `${binding.provider}\0${binding.moduleLocalName}\0${typeof binding.childAlias === "string" ? binding.childAlias : ""}\0${typeof binding.rootAlias === "string" ? binding.rootAlias : ""}\0${binding.connectionId}`;
    })
    .sort();
  const expected = Object.entries(selection)
    .map(([tuple, connectionId]) => {
      const childAlias = tuple.split("\0")[2] ?? "";
      return `${tuple}\0${childAlias}\0${connectionId}`;
    })
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      "Capsule ProviderBindingSet did not retain the exact selected array",
    );
}

function extractProviderBindings(
  value: JsonRecord,
): readonly ProviderBindingSelection[] {
  const set = nestedRecord(
    value.providerBindingSet,
    "ProviderBindingSet response",
  );
  if (!Array.isArray(set.bindings)) {
    throw new Error("ProviderBindingSet response omitted bindings");
  }
  return set.bindings.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.provider !== "string" ||
      typeof candidate.moduleLocalName !== "string" ||
      typeof candidate.connectionId !== "string"
    ) {
      throw new Error(`ProviderBinding ${index + 1} was invalid`);
    }
    const childAlias =
      candidate.childAlias === undefined
        ? undefined
        : boundedTextValue(
            candidate.childAlias,
            `ProviderBinding ${index + 1}.childAlias`,
            128,
          );
    const rootAlias =
      candidate.rootAlias === undefined
        ? undefined
        : boundedTextValue(
            candidate.rootAlias,
            `ProviderBinding ${index + 1}.rootAlias`,
            128,
          );
    return {
      provider: boundedTextValue(
        candidate.provider,
        `ProviderBinding ${index + 1}.provider`,
        512,
      ),
      moduleLocalName: boundedTextValue(
        candidate.moduleLocalName,
        `ProviderBinding ${index + 1}.moduleLocalName`,
        128,
      ),
      ...(childAlias ? { childAlias } : {}),
      ...(rootAlias ? { rootAlias } : {}),
      connectionId: requiredIdentifier(
        candidate.connectionId,
        `ProviderBinding ${index + 1}.connectionId`,
      ),
    };
  });
}

function readAuthorityGuard(value: JsonRecord): string {
  const reAdoption = nestedRecord(
    value.installConfigReAdoption,
    "Capsule installConfigReAdoption response",
  );
  const authorityGuard = requiredString(
    reAdoption.authorityGuard,
    "installConfigReAdoption.authorityGuard",
  );
  if (!/^sha256:[0-9a-f]{64}$/u.test(authorityGuard)) {
    throw new Error(
      "installConfigReAdoption.authorityGuard was not a valid opaque digest",
    );
  }
  return authorityGuard;
}

async function readSourceSnapshotEvidence(
  api: ApiClient,
  capsuleResponse: JsonRecord,
  installPlanRun: JsonRecord,
  config: ManagedStagingConfig,
): Promise<SourceSnapshotEvidence> {
  const capsule = nestedRecord(capsuleResponse.capsule, "capsule response");
  const sourceId = requiredIdentifier(
    typeof capsule.sourceId === "string" ? capsule.sourceId : undefined,
    "capsule.sourceId",
  );
  const sourceSnapshotId = requiredIdentifier(
    typeof installPlanRun.sourceSnapshotId === "string"
      ? installPlanRun.sourceSnapshotId
      : undefined,
    "installPlanRun.sourceSnapshotId",
  );
  const capsuleId = requiredIdentifier(
    typeof capsule.id === "string" ? capsule.id : undefined,
    "capsule.id",
  );
  const workspaceId = requiredIdentifier(
    typeof capsule.workspaceId === "string" ? capsule.workspaceId : undefined,
    "capsule.workspaceId",
  );
  const baseStateGeneration = requiredInteger(
    installPlanRun.baseStateGeneration,
    "installPlanRun.baseStateGeneration",
  );
  const currentStateVersionId =
    capsule.currentStateVersionId === undefined
      ? null
      : requiredIdentifier(
          typeof capsule.currentStateVersionId === "string"
            ? capsule.currentStateVersionId
            : undefined,
          "capsule.currentStateVersionId",
        );
  const snapshots = await api.requestJson(
    `/api/v1/sources/${encodeURIComponent(sourceId)}/snapshots`,
    { expectedStatus: 200 },
  );
  if (!Array.isArray(snapshots.snapshots)) {
    throw new Error("SourceSnapshot list omitted snapshots");
  }
  const snapshot = snapshots.snapshots.find(
    (candidate): candidate is JsonRecord =>
      isRecord(candidate) && candidate.id === sourceSnapshotId,
  );
  if (!snapshot) {
    throw new Error(
      "install PlanRun SourceSnapshot was not present in the immutable source list",
    );
  }
  const resolvedCommit = requiredString(
    snapshot.resolvedCommit,
    "SourceSnapshot.resolvedCommit",
  );
  if (!/^[0-9a-f]{40}$/iu.test(resolvedCommit)) {
    throw new Error("SourceSnapshot.resolvedCommit was not a Git SHA-1");
  }
  const archiveDigest = requiredString(
    snapshot.archiveDigest,
    "SourceSnapshot.archiveDigest",
  );
  if (!/^sha256:[0-9a-f]{64}$/u.test(archiveDigest)) {
    throw new Error("SourceSnapshot.archiveDigest was invalid");
  }
  if (snapshot.url !== config.sourceUrl || snapshot.ref !== config.sourceRef) {
    throw new Error("SourceSnapshot Git URL/ref drifted from requested source");
  }
  if (snapshot.path !== config.sourcePath) {
    throw new Error("SourceSnapshot path drifted from requested source path");
  }
  return {
    id: sourceSnapshotId,
    url: requiredString(snapshot.url, "SourceSnapshot.url"),
    resolvedCommit: resolvedCommit.toLowerCase(),
    archiveDigest,
    ref: requiredString(snapshot.ref, "SourceSnapshot.ref"),
    path: requiredString(snapshot.path, "SourceSnapshot.path"),
    modulePath: config.modulePath,
    capsuleId,
    workspaceId,
    baseStateGeneration,
    currentStateVersionId,
  };
}

function readCapsuleRunIdentityContext(
  value: JsonRecord,
  expectedCapsuleId: string,
  expectedWorkspaceId: string,
): RunIdentityContext {
  const capsule = nestedRecord(value.capsule, "capsule response");
  const capsuleId = requiredIdentifier(
    typeof capsule.id === "string" ? capsule.id : undefined,
    "capsule.id",
  );
  const workspaceId = requiredIdentifier(
    typeof capsule.workspaceId === "string" ? capsule.workspaceId : undefined,
    "capsule.workspaceId",
  );
  if (capsuleId !== expectedCapsuleId || workspaceId !== expectedWorkspaceId) {
    throw new Error("Capsule identity drifted before destroy planning");
  }
  const baseStateGeneration = requiredInteger(
    capsule.currentStateGeneration,
    "capsule.currentStateGeneration",
  );
  const currentStateVersionId =
    capsule.currentStateVersionId === undefined
      ? null
      : requiredIdentifier(
          typeof capsule.currentStateVersionId === "string"
            ? capsule.currentStateVersionId
            : undefined,
          "capsule.currentStateVersionId",
        );
  return {
    capsuleId,
    workspaceId,
    baseStateGeneration,
    currentStateVersionId,
  };
}

/**
 * Destroy remains safe even when install-time SourceSnapshot retrieval failed
 * after the Capsule was created.  The owner Run must still publish every
 * immutable identity field; this helper checks those fields without requiring
 * a locally-held snapshot digest to compare against.
 */
export function assertDestroyRunIdentity(
  run: JsonRecord,
  expectedContext: RunIdentityContext,
  expectedPlanRunId?: string,
): void {
  const label =
    expectedPlanRunId === undefined ? "DestroyPlanRun" : "DestroyApplyRun";
  requiredIdentifier(
    typeof run.id === "string" ? run.id : undefined,
    `${label}.id`,
  );
  const workspaceId = requiredIdentifier(
    typeof run.workspaceId === "string" ? run.workspaceId : undefined,
    `${label}.workspaceId`,
  );
  if (workspaceId !== expectedContext.workspaceId) {
    throw new Error(`${label} Workspace identity drifted from the Capsule`);
  }
  const capsuleId = requiredIdentifier(
    typeof run.capsuleId === "string" ? run.capsuleId : undefined,
    `${label}.capsuleId`,
  );
  if (capsuleId !== expectedContext.capsuleId) {
    throw new Error(`${label} Capsule identity drifted from the Capsule`);
  }
  requiredIdentifier(
    typeof run.sourceSnapshotId === "string" ? run.sourceSnapshotId : undefined,
    `${label}.sourceSnapshotId`,
  );
  const baseStateGeneration = requiredInteger(
    run.baseStateGeneration,
    `${label}.baseStateGeneration`,
  );
  if (baseStateGeneration !== expectedContext.baseStateGeneration) {
    throw new Error(`${label} base state generation drifted from the Capsule`);
  }
  requiredDigest(
    run.runEnvironmentEvidenceDigest,
    `${label}.runEnvironmentEvidenceDigest`,
  );
  const archive = nestedRecord(run.sourceArchive, `${label}.sourceArchive`);
  assertExactKeys(archive, ["digest", "ref"], `${label}.sourceArchive`);
  requiredDigest(archive.digest, `${label}.sourceArchive.digest`);
  boundedTextValue(archive.ref, `${label}.sourceArchive.ref`, 4_096);
  requiredCommit(run.sourceCommit, `${label}.sourceCommit`);

  if (expectedPlanRunId === undefined) return;
  if (run.planRunId !== expectedPlanRunId) {
    throw new Error(`${label} did not bind its reviewed DestroyPlanRun`);
  }
  const applyExpected = nestedRecord(
    run.applyExpected,
    `${label}.applyExpected`,
  );
  for (const key of [
    "planId",
    "capsuleId",
    "currentStateVersionId",
    "sourceDigest",
    "variablesDigest",
    "policyDecisionDigest",
    "planDigest",
    "planArtifactDigest",
    "sourceCommit",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(applyExpected, key)) {
      throw new Error(`${label}.applyExpected omitted ${key}`);
    }
  }
  if (
    applyExpected.planId !== expectedPlanRunId ||
    applyExpected.capsuleId !== expectedContext.capsuleId ||
    applyExpected.currentStateVersionId !==
      expectedContext.currentStateVersionId
  ) {
    throw new Error(`${label}.applyExpected identity did not bind the Capsule`);
  }
  for (const key of [
    "sourceDigest",
    "variablesDigest",
    "policyDecisionDigest",
    "planDigest",
    "planArtifactDigest",
  ]) {
    requiredDigest(applyExpected[key], `${label}.applyExpected.${key}`);
  }
  requiredCommit(
    applyExpected.sourceCommit,
    `${label}.applyExpected.sourceCommit`,
  );
  if (applyExpected.sourceCommit !== run.sourceCommit) {
    throw new Error(
      `${label}.applyExpected source commit drifted from the Run`,
    );
  }
}

export function assertSourceSnapshotRunConsistency(
  run: JsonRecord,
  evidence: SourceSnapshotEvidence,
  expectedPlanRunId?: string,
  expectedContext: RunIdentityContext = evidence,
): RunIdentityContext {
  const runId = requiredIdentifier(
    typeof run.id === "string" ? run.id : undefined,
    expectedPlanRunId === undefined ? "PlanRun.id" : "ApplyRun.id",
  );
  const workspaceId = requiredIdentifier(
    typeof run.workspaceId === "string" ? run.workspaceId : undefined,
    `${expectedPlanRunId === undefined ? "PlanRun" : "ApplyRun"}.workspaceId`,
  );
  if (workspaceId !== expectedContext.workspaceId) {
    throw new Error("Run Workspace identity drifted from the expected Capsule");
  }
  const capsuleId = requiredIdentifier(
    typeof run.capsuleId === "string" ? run.capsuleId : undefined,
    `${expectedPlanRunId === undefined ? "PlanRun" : "ApplyRun"}.capsuleId`,
  );
  if (capsuleId !== expectedContext.capsuleId) {
    throw new Error("Run Capsule identity drifted from the expected Capsule");
  }
  const sourceSnapshotId = requiredIdentifier(
    typeof run.sourceSnapshotId === "string" ? run.sourceSnapshotId : undefined,
    `${expectedPlanRunId === undefined ? "PlanRun" : "ApplyRun"}.sourceSnapshotId`,
  );
  if (sourceSnapshotId !== evidence.id) {
    throw new Error(
      "Run SourceSnapshot id drifted from immutable source evidence",
    );
  }
  const baseStateGeneration = requiredInteger(
    run.baseStateGeneration,
    `${expectedPlanRunId === undefined ? "PlanRun" : "ApplyRun"}.baseStateGeneration`,
  );
  if (baseStateGeneration !== expectedContext.baseStateGeneration) {
    throw new Error(
      "Run base state generation drifted from the expected Capsule",
    );
  }
  requiredDigest(
    run.runEnvironmentEvidenceDigest,
    `${expectedPlanRunId === undefined ? "PlanRun" : "ApplyRun"}.runEnvironmentEvidenceDigest`,
  );
  assertRunSourceArchive(run, evidence, expectedPlanRunId);
  const applyExpected = isRecord(run.applyExpected)
    ? run.applyExpected
    : undefined;
  if (expectedPlanRunId !== undefined) {
    if (runId === expectedPlanRunId) {
      throw new Error("ApplyRun id unexpectedly matched its PlanRun");
    }
    if (run.planRunId !== expectedPlanRunId) {
      throw new Error("ApplyRun did not bind the reviewed PlanRun");
    }
    if (!applyExpected) {
      throw new Error(
        "ApplyRun omitted its immutable apply guard; the public Run source/snapshot contract is unavailable",
      );
    }
    if (applyExpected.planId !== expectedPlanRunId) {
      throw new Error("ApplyRun apply guard did not bind the reviewed PlanRun");
    }
    if (applyExpected.capsuleId !== expectedContext.capsuleId) {
      throw new Error("ApplyRun apply guard did not bind the expected Capsule");
    }
    if (
      !Object.prototype.hasOwnProperty.call(
        applyExpected,
        "currentStateVersionId",
      ) ||
      applyExpected.currentStateVersionId !==
        expectedContext.currentStateVersionId
    ) {
      throw new Error(
        "ApplyRun apply guard omitted or drifted its immutable StateVersion",
      );
    }
    for (const key of [
      "sourceDigest",
      "variablesDigest",
      "policyDecisionDigest",
      "planDigest",
      "planArtifactDigest",
    ]) {
      requiredDigest(applyExpected[key], `ApplyRun apply guard ${key}`);
    }
    if (applyExpected.sourceCommit !== evidence.resolvedCommit) {
      throw new Error(
        "ApplyRun apply guard source commit drifted from SourceSnapshot",
      );
    }
  } else {
    if (!isRecord(run.source)) {
      throw new Error(
        "PlanRun source/snapshot identity is unavailable in the public Run contract",
      );
    }
    const source = run.source;
    if (
      source.kind !== "git" ||
      source.url !== normalizeGitUrlToHttps(evidence.url)
    ) {
      throw new Error(
        "PlanRun Git source drifted from immutable source evidence",
      );
    }

    // `snapshotModuleSource` intentionally omits ref: the immutable
    // SourceSnapshot commit is the execution coordinate.  This managed lane
    // has one graph only, so the module coordinate is always the exact
    // deploy/takoform path; the archive root is not a valid fallback.
    if (source.ref !== undefined) {
      throw new Error("PlanRun Git source unexpectedly carried a mutable ref");
    }
    if (
      evidence.modulePath !== MANAGED_MODULE_PATH ||
      source.modulePath !== MANAGED_MODULE_PATH
    ) {
      throw new Error(
        `PlanRun Git module path must remain the exact ${MANAGED_MODULE_PATH} managed module`,
      );
    }
    if (source.commit !== evidence.resolvedCommit) {
      throw new Error(
        "PlanRun source commit drifted from immutable source evidence",
      );
    }
  }
  const sourceCommit =
    typeof applyExpected?.sourceCommit === "string"
      ? applyExpected.sourceCommit
      : expectedPlanRunId === undefined && typeof run.sourceCommit === "string"
        ? run.sourceCommit
        : undefined;
  if (!sourceCommit || sourceCommit !== evidence.resolvedCommit) {
    throw new Error(
      "Run source commit did not exactly match immutable SourceSnapshot",
    );
  }
  if (
    applyExpected !== undefined &&
    !DIGEST_PATTERN.test(String(applyExpected.sourceDigest ?? ""))
  ) {
    throw new Error("Run source digest was malformed");
  }
  return expectedContext;
}

function assertRunSourceArchive(
  run: JsonRecord,
  evidence: SourceSnapshotEvidence,
  expectedPlanRunId: string | undefined,
): void {
  const label = expectedPlanRunId === undefined ? "PlanRun" : "ApplyRun";
  const archive = nestedRecord(
    run.sourceArchive,
    `${label}.sourceArchive (immutable SourceSnapshot archive)`,
  );
  assertExactKeys(archive, ["digest", "ref"], `${label}.sourceArchive`);
  const digest = requiredDigest(
    archive.digest,
    `${label}.sourceArchive.digest`,
  );
  if (digest !== evidence.archiveDigest) {
    throw new Error(
      `${label} source archive digest drifted from SourceSnapshot`,
    );
  }
  boundedTextValue(archive.ref, `${label}.sourceArchive.ref`, 4_096);
}

/** Keep parity with Takosumi's snapshotModuleSource identity normalization. */
function normalizeGitUrlToHttps(url: string): string {
  const value = url.trim();
  if (/^https:\/\//iu.test(value)) return value;
  const sshMatch = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/iu.exec(value);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  const scpMatch = /^(?:[^@/:]+)@([^:/]+):(.+)$/u.exec(value);
  if (scpMatch) return `https://${scpMatch[1]}/${scpMatch[2]}`;
  return value;
}

/**
 * Validate the positive owner identity served by Takoserver itself.  A
 * negative response from an arbitrary old Worker is not enough evidence that
 * this is the owner that publishes the Resource evidence routes.
 */
export function assertTakoserverOwnerDiscovery(
  value: unknown,
  origin: string,
): void {
  const expectedOrigin = readOrigin(
    origin,
    "Takoserver owner discovery origin",
  );
  const discovery = nestedRecord(value, "Takoserver owner discovery");
  assertExactKeys(
    discovery,
    ["apiVersion", "endpoints", "product"],
    "Takoserver owner discovery",
  );
  if (discovery.product !== "takoserver") {
    throw new Error("Takoserver owner discovery product was not takoserver");
  }
  if (discovery.apiVersion !== "v1") {
    throw new Error("Takoserver owner discovery apiVersion was not v1");
  }
  const endpoints = nestedRecord(
    discovery.endpoints,
    "Takoserver owner discovery endpoints",
  );
  assertClosedKeys(
    endpoints,
    ["api", "openapi", "takoform"],
    ["ai", "console"],
    "Takoserver owner discovery endpoints",
  );
  assertExactEndpoint(
    endpoints.api,
    expectedOrigin,
    "Takoserver owner discovery endpoints.api",
  );
  assertExactEndpoint(
    endpoints.openapi,
    `${expectedOrigin}${TAKOSERVER_OPENAPI_PATH}`,
    "Takoserver owner discovery endpoints.openapi",
  );
  assertExactEndpoint(
    endpoints.takoform,
    `${expectedOrigin}/apis/forms.takoform.com/v1`,
    "Takoserver owner discovery endpoints.takoform",
  );
  if (endpoints.console !== undefined) {
    assertBareEndpointOrigin(
      endpoints.console,
      "Takoserver owner discovery endpoints.console",
    );
  }
  if (endpoints.ai !== undefined) {
    assertExactEndpoint(
      endpoints.ai,
      `${expectedOrigin}/v1/ai`,
      "Takoserver owner discovery endpoints.ai",
    );
  }
}

/**
 * Validate the exact published OpenAPI surface needed by this E2E.  The
 * document is deliberately checked as a positive owner contract before the
 * authenticated impossible-UID 404 probes run.
 */
export function assertTakoserverOwnerOpenApi(
  value: unknown,
  origin: string,
): void {
  const expectedOrigin = readOrigin(origin, "Takoserver owner OpenAPI origin");
  const document = nestedRecord(value, "Takoserver owner OpenAPI document");
  assertExactKeys(
    document,
    ["components", "info", "openapi", "paths", "security", "servers"],
    "Takoserver owner OpenAPI document",
  );
  if (document.openapi !== "3.1.0") {
    throw new Error("Takoserver owner OpenAPI version was not 3.1.0");
  }
  const info = nestedRecord(document.info, "Takoserver owner OpenAPI info");
  assertClosedKeys(
    info,
    ["title", "version"],
    ["summary"],
    "Takoserver owner OpenAPI info",
  );
  if (info.title !== "Takoserver API") {
    throw new Error("Takoserver owner OpenAPI title was not Takoserver API");
  }
  if (info.version !== "1.0.0") {
    throw new Error("Takoserver owner OpenAPI info version was not 1.0.0");
  }
  const servers = document.servers;
  if (!Array.isArray(servers) || servers.length !== 1) {
    throw new Error(
      "Takoserver owner OpenAPI servers were not a single server",
    );
  }
  const server = nestedRecord(servers[0], "Takoserver owner OpenAPI server");
  assertExactKeys(server, ["url"], "Takoserver owner OpenAPI server");
  assertExactEndpoint(
    server.url,
    expectedOrigin,
    "Takoserver owner OpenAPI server.url",
  );
  const security = document.security;
  if (
    !Array.isArray(security) ||
    security.length !== 1 ||
    !isRecord(security[0])
  ) {
    throw new Error("Takoserver owner OpenAPI security was invalid");
  }
  assertExactKeys(
    security[0],
    ["bearerAuth"],
    "Takoserver owner OpenAPI security",
  );
  if (
    !Array.isArray(security[0].bearerAuth) ||
    security[0].bearerAuth.length !== 0
  ) {
    throw new Error("Takoserver owner OpenAPI bearer security was invalid");
  }

  const components = nestedRecord(
    document.components,
    "Takoserver owner OpenAPI components",
  );
  assertExactKeys(
    components,
    ["schemas", "securitySchemes"],
    "Takoserver owner OpenAPI components",
  );
  const securitySchemes = nestedRecord(
    components.securitySchemes,
    "Takoserver owner OpenAPI security schemes",
  );
  assertExactKeys(
    securitySchemes,
    ["bearerAuth"],
    "Takoserver owner OpenAPI security schemes",
  );
  const bearerAuth = nestedRecord(
    securitySchemes.bearerAuth,
    "Takoserver owner OpenAPI bearer scheme",
  );
  assertClosedKeys(
    bearerAuth,
    ["scheme", "type"],
    ["description"],
    "Takoserver owner OpenAPI bearer scheme",
  );
  if (bearerAuth.type !== "http" || bearerAuth.scheme !== "bearer") {
    throw new Error("Takoserver owner OpenAPI bearer scheme was invalid");
  }
  const schemas = nestedRecord(
    components.schemas,
    "Takoserver owner OpenAPI schemas",
  );
  schemaRecord(schemas.Error, "Error");
  assertResourceExecutionEvidenceSchemas(schemas);

  const paths = nestedRecord(document.paths, "Takoserver owner OpenAPI paths");
  assertOwnerEvidenceOperation(
    paths,
    TAKOSERVER_RESOURCE_EXECUTION_EVIDENCE_PATH,
  );
  assertOwnerNativeResidualOperation(paths, TAKOSERVER_NATIVE_RESIDUAL_PATH);
}

function assertExactEndpoint(
  value: unknown,
  expected: string,
  label: string,
): void {
  const actual = boundedTextValue(value, label, MAX_SOURCE_URL_BYTES);
  if (actual !== expected) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(actual).origin === new URL(expected).origin;
    } catch {
      // The bounded URL error below is enough for malformed values.
    }
    throw new Error(
      `${label} was not the exact same-origin endpoint${sameOrigin ? " path" : ""}`,
    );
  }
}

function assertBareEndpointOrigin(value: unknown, label: string): void {
  readOrigin(boundedTextValue(value, label, MAX_SOURCE_URL_BYTES), label);
}

function assertResourceExecutionEvidenceSchemas(schemas: JsonRecord): void {
  const commit = schemaRecord(
    schemas.ResourceExecutionCommit,
    "ResourceExecutionCommit",
  );
  assertSchemaObject(
    commit,
    [
      "sequence",
      "operationId",
      "action",
      "outcome",
      "resourceVersion",
      "committedAt",
    ],
    [
      "sequence",
      "operationId",
      "action",
      "outcome",
      "resourceVersion",
      "committedAt",
    ],
    "ResourceExecutionCommit",
  );
  assertIntegerSchema(
    commit.properties.sequence,
    1,
    "ResourceExecutionCommit.sequence",
  );
  assertStringSchema(
    commit.properties.operationId,
    3,
    128,
    "ResourceExecutionCommit.operationId",
  );
  assertEnumSchema(
    commit.properties.action,
    ["create", "update", "delete"],
    "ResourceExecutionCommit.action",
  );
  const outcome = schemaRecord(
    commit.properties.outcome,
    "ResourceExecutionCommit.outcome",
  );
  if (outcome.const !== "committed") {
    throw new Error("ResourceExecutionCommit.outcome was not committed");
  }
  const resourceVersion = schemaRecord(
    commit.properties.resourceVersion,
    "ResourceExecutionCommit.resourceVersion",
  );
  assertSchemaObject(
    resourceVersion,
    ["generation", "revision"],
    ["generation", "revision"],
    "ResourceExecutionCommit.resourceVersion",
  );
  assertNumericStringSchema(
    resourceVersion.properties.generation,
    "ResourceExecutionCommit.resourceVersion.generation",
  );
  assertNumericStringSchema(
    resourceVersion.properties.revision,
    "ResourceExecutionCommit.resourceVersion.revision",
  );
  assertDateTimeSchema(
    commit.properties.committedAt,
    "ResourceExecutionCommit.committedAt",
  );

  const evidence = schemaRecord(
    schemas.ResourceExecutionEvidence,
    "ResourceExecutionEvidence",
  );
  assertSchemaObject(
    evidence,
    [
      "format",
      "organizationId",
      "resource",
      "coverage",
      "snapshotFence",
      "commits",
    ],
    [
      "format",
      "organizationId",
      "resource",
      "coverage",
      "snapshotFence",
      "commits",
    ],
    "ResourceExecutionEvidence",
  );
  const format = schemaRecord(
    evidence.properties.format,
    "ResourceExecutionEvidence.format",
  );
  if (format.const !== TAKOSERVER_RESOURCE_EXECUTION_EVIDENCE_FORMAT) {
    throw new Error(
      "ResourceExecutionEvidence.format was not the versioned owner format",
    );
  }
  assertStringSchema(
    evidence.properties.organizationId,
    1,
    128,
    "ResourceExecutionEvidence.organizationId",
  );
  const resource = schemaRecord(
    evidence.properties.resource,
    "ResourceExecutionEvidence.resource",
  );
  assertSchemaObject(
    resource,
    ["uid", "address", "formRef"],
    ["uid", "address", "formRef"],
    "ResourceExecutionEvidence.resource",
  );
  assertStringSchema(
    resource.properties.uid,
    1,
    128,
    "ResourceExecutionEvidence.resource.uid",
  );
  const address = schemaRecord(
    resource.properties.address,
    "ResourceExecutionEvidence.resource.address",
  );
  assertSchemaObject(
    address,
    ["space", "apiVersion", "kind", "name"],
    ["space", "apiVersion", "kind", "name"],
    "ResourceExecutionEvidence.resource.address",
  );
  assertStringSchema(
    address.properties.space,
    1,
    255,
    "ResourceExecutionEvidence.resource.address.space",
    true,
  );
  assertStringSchema(
    address.properties.apiVersion,
    1,
    320,
    "ResourceExecutionEvidence.resource.address.apiVersion",
  );
  assertStringSchema(
    address.properties.kind,
    1,
    128,
    "ResourceExecutionEvidence.resource.address.kind",
  );
  assertStringSchema(
    address.properties.name,
    1,
    128,
    "ResourceExecutionEvidence.resource.address.name",
    true,
  );
  const formRef = schemaRecord(
    resource.properties.formRef,
    "ResourceExecutionEvidence.resource.formRef",
  );
  assertSchemaObject(
    formRef,
    ["apiVersion", "kind", "definitionVersion", "schemaDigest"],
    ["apiVersion", "kind", "definitionVersion", "schemaDigest"],
    "ResourceExecutionEvidence.resource.formRef",
  );
  assertStringSchema(
    formRef.properties.apiVersion,
    1,
    320,
    "ResourceExecutionEvidence.resource.formRef.apiVersion",
  );
  assertStringSchema(
    formRef.properties.kind,
    1,
    128,
    "ResourceExecutionEvidence.resource.formRef.kind",
  );
  assertStringSchema(
    formRef.properties.definitionVersion,
    1,
    128,
    "ResourceExecutionEvidence.resource.formRef.definitionVersion",
  );
  assertPatternSchema(
    formRef.properties.schemaDigest,
    "^sha256:[a-f0-9]{64}$",
    "ResourceExecutionEvidence.resource.formRef.schemaDigest",
  );
  assertEnumSchema(
    evidence.properties.coverage,
    ["complete", "partial"],
    "ResourceExecutionEvidence.coverage",
  );
  assertIntegerSchema(
    evidence.properties.snapshotFence,
    0,
    "ResourceExecutionEvidence.snapshotFence",
  );
  const commits = schemaRecord(
    evidence.properties.commits,
    "ResourceExecutionEvidence.commits",
  );
  if (
    commits.type !== "array" ||
    commits.maxItems !== 200 ||
    !isRecord(commits.items) ||
    commits.items.$ref !== "#/components/schemas/ResourceExecutionCommit"
  ) {
    throw new Error("ResourceExecutionEvidence.commits schema was invalid");
  }

  const response = schemaRecord(
    schemas.ResourceExecutionEvidenceResponse,
    "ResourceExecutionEvidenceResponse",
  );
  assertSchemaObject(
    response,
    ["executionEvidence"],
    ["executionEvidence", "cursor"],
    "ResourceExecutionEvidenceResponse",
  );
  if (
    !isRecord(response.properties.executionEvidence) ||
    response.properties.executionEvidence.$ref !==
      "#/components/schemas/ResourceExecutionEvidence"
  ) {
    throw new Error(
      "ResourceExecutionEvidenceResponse.executionEvidence schema was invalid",
    );
  }
  assertPatternSchema(
    response.properties.cursor,
    "^[A-Za-z0-9_-]+$",
    "ResourceExecutionEvidenceResponse.cursor",
  );
  assertStringSchema(
    response.properties.cursor,
    1,
    1_024,
    "ResourceExecutionEvidenceResponse.cursor",
  );
}

function assertOwnerEvidenceOperation(
  paths: JsonRecord,
  pathName: string,
): void {
  const path = schemaRecord(
    paths[pathName],
    `Takoserver owner OpenAPI ${pathName}`,
  );
  assertExactKeys(path, ["get"], `Takoserver owner OpenAPI ${pathName}`);
  const operation = schemaRecord(
    path.get,
    `Takoserver owner OpenAPI ${pathName}.get`,
  );
  assertClosedKeys(
    operation,
    ["parameters", "responses"],
    ["description", "summary"],
    `Takoserver owner OpenAPI ${pathName}.get`,
  );
  assertParameters(
    operation.parameters,
    [
      ["organizationId", "path", true],
      ["resourceUid", "path", true],
      ["limit", "query", false],
      ["cursor", "query", false],
    ],
    `Takoserver owner OpenAPI ${pathName}.get.parameters`,
  );
  const parameters = operation.parameters as unknown[];
  assertStringSchema(
    schemaRecord(parameters[0], "organizationId parameter").schema,
    1,
    128,
    `${pathName}.organizationId`,
  );
  assertStringSchema(
    schemaRecord(parameters[1], "resourceUid parameter").schema,
    1,
    128,
    `${pathName}.resourceUid`,
  );
  assertIntegerSchema(
    schemaRecord(parameters[2], "limit parameter").schema,
    1,
    `${pathName}.limit`,
    200,
  );
  const limitSchema = schemaRecord(parameters[2], "limit parameter")
    .schema as JsonRecord;
  if (limitSchema.default !== 50) {
    throw new Error(`${pathName}.limit default was not 50`);
  }
  assertPatternSchema(
    schemaRecord(parameters[3], "cursor parameter").schema,
    "^[A-Za-z0-9_-]+$",
    `${pathName}.cursor`,
  );
  assertStringSchema(
    schemaRecord(parameters[3], "cursor parameter").schema,
    1,
    1_024,
    `${pathName}.cursor`,
  );
  assertOperationResponses(
    operation.responses,
    ["200", "400", "401", "403", "404", "503"],
    "#/components/schemas/ResourceExecutionEvidenceResponse",
    pathName,
  );
}

function assertOwnerNativeResidualOperation(
  paths: JsonRecord,
  pathName: string,
): void {
  const path = schemaRecord(
    paths[pathName],
    `Takoserver owner OpenAPI ${pathName}`,
  );
  assertExactKeys(path, ["get"], `Takoserver owner OpenAPI ${pathName}`);
  const operation = schemaRecord(
    path.get,
    `Takoserver owner OpenAPI ${pathName}.get`,
  );
  assertClosedKeys(
    operation,
    ["parameters", "responses"],
    ["description", "summary"],
    `Takoserver owner OpenAPI ${pathName}.get`,
  );
  assertParameters(
    operation.parameters,
    [
      ["space", "query", true],
      ["name", "query", true],
    ],
    `Takoserver owner OpenAPI ${pathName}.get.parameters`,
  );
  const parameters = operation.parameters as unknown[];
  const spaceSchema = schemaRecord(
    schemaRecord(parameters[0], "space parameter").schema,
    `${pathName}.space`,
  );
  assertStringSchema(spaceSchema, 1, 255, `${pathName}.space`, true);
  if (typeof spaceSchema.pattern !== "string" || !spaceSchema.pattern) {
    throw new Error(`${pathName}.space schema lacked its boundary pattern`);
  }
  assertStringSchema(
    schemaRecord(parameters[1], "name parameter").schema,
    1,
    128,
    `${pathName}.name`,
  );
  assertOperationResponses(
    operation.responses,
    ["200", "400", "401", "404", "503"],
    undefined,
    pathName,
  );
  const responses = nestedRecord(operation.responses, `${pathName}.responses`);
  const successSchema = responseJsonSchema(
    responses["200"],
    `${pathName}.responses.200`,
  );
  assertNativeResidualSchema(successSchema, `${pathName}.responses.200`);
}

function assertSchemaObject(
  value: JsonRecord,
  required: readonly string[],
  properties: readonly string[],
  label: string,
): void {
  assertClosedKeys(
    value,
    ["additionalProperties", "properties", "required", "type"],
    ["description"],
    label,
  );
  if (value.type !== "object" || value.additionalProperties !== false) {
    throw new Error(`${label} was not a closed object schema`);
  }
  if (JSON.stringify(value.required) !== JSON.stringify(required)) {
    throw new Error(`${label}.required was not exact`);
  }
  const props = nestedRecord(value.properties, `${label}.properties`);
  const actual = Object.keys(props).sort();
  const expected = [...properties].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}.properties were not exact`);
  }
}

type OpenApiSchemaRecord = JsonRecord & {
  readonly properties: JsonRecord;
};

function schemaRecord(value: unknown, label: string): OpenApiSchemaRecord {
  if (!isRecord(value)) throw new Error(`${label} schema was missing`);
  return value as OpenApiSchemaRecord;
}

function assertStringSchema(
  value: unknown,
  minLength: number,
  maxLength: number,
  label: string,
  patternRequired = false,
): void {
  const schema = schemaRecord(value, label);
  if (
    schema.type !== "string" ||
    schema.minLength !== minLength ||
    schema.maxLength !== maxLength ||
    (patternRequired && (typeof schema.pattern !== "string" || !schema.pattern))
  ) {
    throw new Error(`${label} schema was invalid`);
  }
}

function assertIntegerSchema(
  value: unknown,
  minimum: number,
  label: string,
  maximum?: number,
): void {
  const schema = schemaRecord(value, label);
  if (
    schema.type !== "integer" ||
    schema.minimum !== minimum ||
    (maximum !== undefined && schema.maximum !== maximum)
  ) {
    throw new Error(`${label} schema was invalid`);
  }
}

function assertEnumSchema(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  const schema = schemaRecord(value, label);
  if (
    schema.type !== "string" ||
    JSON.stringify(schema.enum) !== JSON.stringify(expected)
  ) {
    throw new Error(`${label} schema was invalid`);
  }
}

function assertPatternSchema(
  value: unknown,
  pattern: string,
  label: string,
): void {
  const schema = schemaRecord(value, label);
  if (schema.type !== "string" || schema.pattern !== pattern) {
    throw new Error(`${label} schema pattern was invalid`);
  }
}

function assertNumericStringSchema(value: unknown, label: string): void {
  const schema = schemaRecord(value, label);
  if (
    schema.type !== "string" ||
    schema.minLength !== 1 ||
    schema.maxLength !== 128 ||
    schema.pattern !== "^[0-9]+$"
  ) {
    throw new Error(`${label} schema was invalid`);
  }
}

function assertDateTimeSchema(value: unknown, label: string): void {
  const schema = schemaRecord(value, label);
  if (schema.type !== "string" || schema.format !== "date-time") {
    throw new Error(`${label} schema was invalid`);
  }
}

function assertParameters(
  value: unknown,
  expected: readonly (readonly [string, string, boolean])[],
  label: string,
): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${label} were not exact`);
  }
  value.forEach((candidate, index) => {
    const parameter = schemaRecord(candidate, `${label}[${index}]`);
    assertClosedKeys(
      parameter,
      ["in", "name", "required", "schema"],
      [],
      `${label}[${index}]`,
    );
    const wanted = expected[index]!;
    if (
      parameter.name !== wanted[0] ||
      parameter.in !== wanted[1] ||
      parameter.required !== wanted[2]
    ) {
      throw new Error(`${label}[${index}] was not the exact parameter`);
    }
  });
}

function assertOperationResponses(
  value: unknown,
  expectedStatuses: readonly string[],
  successRef: string | undefined,
  label: string,
): void {
  const responses = nestedRecord(value, `${label}.responses`);
  const actualStatuses = Object.keys(responses).sort();
  const wantedStatuses = [...expectedStatuses].sort();
  if (JSON.stringify(actualStatuses) !== JSON.stringify(wantedStatuses)) {
    throw new Error(`${label} responses were not exact`);
  }
  for (const status of expectedStatuses) {
    const response = responses[status];
    const schema = responseJsonSchema(response, `${label}.responses.${status}`);
    if (status === "200" && successRef !== undefined) {
      if (schema.$ref !== successRef) {
        throw new Error(
          `${label}.responses.200 schema was not the owner response`,
        );
      }
    } else if (
      status !== "200" &&
      schema.$ref !== "#/components/schemas/Error"
    ) {
      throw new Error(`${label}.responses.${status} schema was not Error`);
    }
  }
}

function responseJsonSchema(value: unknown, label: string): JsonRecord {
  const response = nestedRecord(value, label);
  assertClosedKeys(response, ["content"], ["description"], label);
  const content = nestedRecord(response.content, `${label}.content`);
  assertExactKeys(content, ["application/json"], `${label}.content`);
  const applicationJson = nestedRecord(
    content["application/json"],
    `${label}.content.application/json`,
  );
  assertExactKeys(
    applicationJson,
    ["schema"],
    `${label}.content.application/json`,
  );
  return schemaRecord(applicationJson.schema, `${label}.schema`);
}

function assertNativeResidualSchema(value: JsonRecord, label: string): void {
  assertSchemaObject(value, ["residual"], ["residual"], label);
  const properties = nestedRecord(value.properties, `${label}.properties`);
  const residual = schemaRecord(properties.residual, `${label}.residual`);
  assertSchemaObject(
    residual,
    ["status", "source", "effectCount", "deploymentCount", "checkedAt"],
    [
      "status",
      "source",
      "effectCount",
      "deploymentCount",
      "checkedAt",
      "evidenceRef",
      "reason",
    ],
    `${label}.residual`,
  );
  assertEnumSchema(
    residual.properties.status,
    ["absent", "present", "indeterminate"],
    `${label}.residual.status`,
  );
  assertEnumSchema(
    residual.properties.source,
    ["intrinsic", "provider"],
    `${label}.residual.source`,
  );
  assertIntegerSchema(
    residual.properties.effectCount,
    0,
    `${label}.residual.effectCount`,
  );
  assertIntegerSchema(
    residual.properties.deploymentCount,
    0,
    `${label}.residual.deploymentCount`,
  );
  assertDateTimeSchema(
    residual.properties.checkedAt,
    `${label}.residual.checkedAt`,
  );
  assertPatternSchema(
    residual.properties.evidenceRef,
    "^sha256:[a-f0-9]{64}$",
    `${label}.residual.evidenceRef`,
  );
  const reason = schemaRecord(
    residual.properties.reason,
    `${label}.residual.reason`,
  );
  if (
    reason.type !== "string" ||
    !Array.isArray(reason.enum) ||
    JSON.stringify(reason.enum) !==
      JSON.stringify(TAKOSERVER_NATIVE_RESIDUAL_REASONS)
  ) {
    throw new Error(`${label}.residual.reason schema was invalid`);
  }
}

/**
 * Validate the auth-first negative probe used when the endpoint is not yet
 * described by Takoserver's public OpenAPI document.  A 404 is meaningful only
 * after authentication: the owner route authenticates before looking up the
 * impossible UID, whereas an unauthenticated request is 401.
 */
export function assertTakoserverEvidenceCapabilityResponse(
  status: number,
  body: unknown,
): void {
  if (status !== 404) {
    throw new Error(
      `Takoserver execution evidence capability was not authenticated (HTTP ${status})`,
    );
  }
  assertTakoserverErrorEnvelope(
    body,
    "Takoserver capability probe",
    "not_found",
    false,
  );
}

/** Validate the auth-first negative probe for the provider-native residual route. */
export function assertTakoserverNativeCapabilityResponse(
  status: number,
  body: unknown,
): void {
  if (status !== 404) {
    throw new Error(
      `Takoserver native residual capability was not authenticated (HTTP ${status})`,
    );
  }
  assertTakoserverErrorEnvelope(
    body,
    "Takoserver native residual capability probe",
    "resource_not_found",
    false,
  );
}

/** Parse one exact owner Resource execution-evidence page. */
export function parseResourceExecutionEvidenceResponse(
  value: JsonRecord,
  expectedOrganizationId: string,
  expectedResourceUid: string,
  operation: "apply" | "destroy",
  expectedResource?: Pick<ManagedResourceIdentity, "address" | "type">,
): JsonRecord {
  assertClosedKeys(
    value,
    ["executionEvidence"],
    ["cursor"],
    "Takoserver Resource execution evidence response",
  );
  if (value.cursor !== undefined) {
    boundedTextValue(
      value.cursor,
      "Takoserver execution evidence cursor",
      8_192,
    );
  }
  const evidence = nestedRecord(
    value.executionEvidence,
    "Takoserver execution evidence",
  );
  assertExactKeys(
    evidence,
    [
      "commits",
      "coverage",
      "format",
      "organizationId",
      "resource",
      "snapshotFence",
    ],
    "Takoserver execution evidence",
  );
  if (evidence.format !== TAKOSERVER_RESOURCE_EXECUTION_EVIDENCE_FORMAT) {
    throw new Error(
      "Takoserver execution evidence format was not the versioned owner contract",
    );
  }
  if (evidence.organizationId !== expectedOrganizationId) {
    throw new Error("Takoserver execution evidence organization drifted");
  }
  const resource = nestedRecord(
    evidence.resource,
    "Takoserver execution evidence.resource",
  );
  assertExactKeys(
    resource,
    ["address", "formRef", "uid"],
    "Takoserver execution evidence.resource",
  );
  const uid = requiredIdentifier(
    typeof resource.uid === "string" ? resource.uid : undefined,
    "Takoserver execution evidence.resource.uid",
  );
  if (uid !== expectedResourceUid) {
    throw new Error("Takoserver execution evidence Resource UID drifted");
  }
  const address = nestedRecord(
    resource.address,
    "Takoserver execution evidence.resource.address",
  );
  assertExactKeys(
    address,
    ["apiVersion", "kind", "name", "space"],
    "Takoserver execution evidence.resource.address",
  );
  for (const key of ["apiVersion", "kind", "name", "space"] as const) {
    boundedTextValue(
      address[key],
      `Takoserver execution evidence.resource.address.${key}`,
      512,
    );
  }
  if (expectedResource !== undefined) {
    const expectedForm = MANAGED_FORM_CONTRACT[expectedResource.type];
    if (!expectedForm) {
      throw new Error(
        `Takoserver execution evidence did not recognize managed type ${expectedResource.type}`,
      );
    }
    if (
      address.apiVersion !== "edge.forms.takoform.com" ||
      address.kind !== expectedForm.kind
    ) {
      throw new Error(
        "Takoserver execution evidence Resource address did not match the managed inventory",
      );
    }
  }
  const formRef = nestedRecord(
    resource.formRef,
    "Takoserver execution evidence.resource.formRef",
  );
  assertExactKeys(
    formRef,
    ["apiVersion", "definitionVersion", "kind", "schemaDigest"],
    "Takoserver execution evidence.resource.formRef",
  );
  for (const key of ["apiVersion", "definitionVersion", "kind"] as const) {
    boundedTextValue(
      formRef[key],
      `Takoserver execution evidence.resource.formRef.${key}`,
      512,
    );
  }
  const schemaDigest = requiredDigest(
    formRef.schemaDigest,
    "Takoserver execution evidence.resource.formRef.schemaDigest",
  );
  if (
    formRef.apiVersion !== address.apiVersion ||
    formRef.kind !== address.kind
  ) {
    throw new Error(
      "Takoserver execution evidence Resource address and FormRef did not agree",
    );
  }
  if (expectedResource !== undefined) {
    const expectedForm = MANAGED_FORM_CONTRACT[expectedResource.type]!;
    if (formRef.definitionVersion !== expectedForm.definitionVersion) {
      throw new Error(
        "Takoserver execution evidence FormRef definition version did not match the managed inventory",
      );
    }
  }
  if (evidence.coverage !== "complete") {
    throw new Error(
      "Takoserver execution evidence coverage was invalid: expected complete",
    );
  }
  const snapshotFence = requiredInteger(
    evidence.snapshotFence,
    "Takoserver execution evidence.snapshotFence",
  );
  if (snapshotFence < 0) {
    throw new Error("Takoserver execution evidence snapshotFence was negative");
  }
  if (!Array.isArray(evidence.commits) || evidence.commits.length === 0) {
    throw new Error(
      "Takoserver execution evidence omitted committed lifecycle entries",
    );
  }
  evidence.commits.forEach((candidate, index) => {
    const commit = nestedRecord(
      candidate,
      `Takoserver execution evidence.commits[${index}]`,
    );
    assertExactKeys(
      commit,
      [
        "action",
        "committedAt",
        "operationId",
        "outcome",
        "resourceVersion",
        "sequence",
      ],
      `Takoserver execution evidence.commits[${index}]`,
    );
    const sequence = requiredInteger(
      commit.sequence,
      `Takoserver execution evidence.commits[${index}].sequence`,
    );
    if (sequence <= 0) {
      throw new Error(
        "Takoserver execution evidence sequence was not positive",
      );
    }
    requiredIdentifier(
      typeof commit.operationId === "string" ? commit.operationId : undefined,
      `Takoserver execution evidence.commits[${index}].operationId`,
    );
    if (commit.outcome !== "committed") {
      throw new Error(
        "Takoserver execution evidence contained an uncommitted entry",
      );
    }
    if (!["create", "update", "delete"].includes(commit.action as string)) {
      throw new Error(
        "Takoserver execution evidence contained an unknown lifecycle action",
      );
    }
    const resourceVersion = nestedRecord(
      commit.resourceVersion,
      `Takoserver execution evidence.commits[${index}].resourceVersion`,
    );
    assertExactKeys(
      resourceVersion,
      ["generation", "revision"],
      `Takoserver execution evidence.commits[${index}].resourceVersion`,
    );
    boundedTextValue(
      resourceVersion.generation,
      `Takoserver execution evidence.commits[${index}].resourceVersion.generation`,
      128,
    );
    boundedTextValue(
      resourceVersion.revision,
      `Takoserver execution evidence.commits[${index}].resourceVersion.revision`,
      128,
    );
    if (
      typeof commit.committedAt !== "string" ||
      !Number.isFinite(Date.parse(commit.committedAt))
    ) {
      throw new Error(
        `Takoserver execution evidence.commits[${index}].committedAt was invalid`,
      );
    }
  });
  void operation;
  void schemaDigest;
  return value;
}

/**
 * Validate one complete, owner-published execution-evidence history after all
 * paginated pages have been joined.  The endpoint orders commits newest first;
 * the first sequence must equal the immutable fence and every following row
 * must descend by exactly one until sequence 1.  Classification happens only
 * after that aggregate check, so a truncated page can never masquerade as a
 * successful create/delete proof.
 */
export function assertResourceExecutionEvidenceSequence(
  commits: readonly JsonRecord[],
  snapshotFence: number,
  operation: "apply" | "destroy",
  priorSnapshotFence?: number,
  priorApplyHistory?: readonly JsonRecord[],
): void {
  if (!Number.isSafeInteger(snapshotFence) || snapshotFence < 1) {
    throw new Error(
      "Takoserver execution evidence snapshotFence was not positive",
    );
  }
  if (operation === "destroy") {
    if (
      priorSnapshotFence === undefined ||
      !Number.isSafeInteger(priorSnapshotFence) ||
      priorSnapshotFence < 1 ||
      snapshotFence !== priorSnapshotFence + 1
    ) {
      throw new Error(
        "Takoserver destroy execution evidence fence did not advance by exactly one; exact suffix shape was invalid",
      );
    }
  }
  if (commits.length === 0) {
    throw new Error("Takoserver execution evidence history was empty");
  }
  const operationIds = new Set<string>();
  commits.forEach((commit, index) => {
    const sequence = requiredInteger(
      commit.sequence,
      `Takoserver execution evidence aggregate commit ${index + 1}.sequence`,
    );
    const expectedSequence = snapshotFence - index;
    if (sequence !== expectedSequence) {
      throw new Error(
        `Takoserver execution evidence sequence was not contiguous (expected ${expectedSequence}, got ${sequence})`,
      );
    }
    const operationId = requiredIdentifier(
      typeof commit.operationId === "string" ? commit.operationId : undefined,
      `Takoserver execution evidence aggregate commit ${index + 1}.operationId`,
    );
    if (operationIds.has(operationId)) {
      throw new Error(
        "Takoserver execution evidence aggregate contained duplicate operationId",
      );
    }
    operationIds.add(operationId);
  });
  if (commits[0]!.sequence !== snapshotFence) {
    throw new Error(
      "Takoserver execution evidence first sequence did not equal snapshotFence",
    );
  }
  if (commits.at(-1)!.sequence !== 1) {
    throw new Error(
      "Takoserver execution evidence terminal page did not reach sequence 1",
    );
  }
  const newestAction = commits[0]!.action;
  if (
    operation === "apply" &&
    newestAction !== "create" &&
    newestAction !== "update"
  ) {
    throw new Error(
      "Takoserver execution evidence apply newest action was not create/update",
    );
  }
  if (
    operation === "apply" &&
    commits.some((commit) => commit.action === "delete")
  ) {
    throw new Error(
      "Takoserver execution evidence apply history contained a terminal delete",
    );
  }
  if (operation === "apply" && commits.at(-1)!.action !== "create") {
    throw new Error(
      "Takoserver execution evidence apply history did not terminate at create",
    );
  }
  if (operation === "destroy" && newestAction !== "delete") {
    throw new Error(
      "Takoserver execution evidence destroy newest action was not delete",
    );
  }
  if (operation === "destroy") {
    if (priorApplyHistory !== undefined) {
      if (priorSnapshotFence === undefined) {
        throw new Error(
          "Takoserver execution evidence Apply history lacked its fence",
        );
      }
      assertResourceExecutionEvidenceSequence(
        priorApplyHistory,
        priorSnapshotFence,
        "apply",
      );
      const expectedPrior = priorApplyHistory.map(executionCommitFingerprint);
      const actualPrior = commits.slice(1).map(executionCommitFingerprint);
      if (expectedPrior.length !== priorSnapshotFence) {
        throw new Error(
          "Takoserver execution evidence Apply history did not reach its fence",
        );
      }
      if (
        expectedPrior.length !== actualPrior.length ||
        expectedPrior.some((value, index) => value !== actualPrior[index])
      ) {
        throw new Error(
          "Takoserver execution evidence Destroy history did not retain the exact Apply history prefix",
        );
      }
    }
    const suffixLength =
      commits.length - (priorSnapshotFence ?? snapshotFence - 1);
    if (suffixLength !== 1 || commits[0]!.action !== "delete") {
      throw new Error(
        "Takoserver execution evidence Destroy history did not contain the exact one-delete suffix",
      );
    }
  }
}

function executionCommitFingerprint(commit: JsonRecord): string {
  const resourceVersion = nestedRecord(
    commit.resourceVersion,
    "Takoserver execution evidence commit.resourceVersion",
  );
  return JSON.stringify({
    sequence: requiredInteger(
      commit.sequence,
      "Takoserver execution evidence commit.sequence",
    ),
    operationId: requiredIdentifier(
      typeof commit.operationId === "string" ? commit.operationId : undefined,
      "Takoserver execution evidence commit.operationId",
    ),
    action: boundedTextValue(
      commit.action,
      "Takoserver execution evidence commit.action",
      64,
    ),
    outcome: boundedTextValue(
      commit.outcome,
      "Takoserver execution evidence commit.outcome",
      64,
    ),
    resourceVersion: {
      generation: boundedTextValue(
        resourceVersion.generation,
        "Takoserver execution evidence commit.resourceVersion.generation",
        128,
      ),
      revision: boundedTextValue(
        resourceVersion.revision,
        "Takoserver execution evidence commit.resourceVersion.revision",
        128,
      ),
    },
    committedAt: boundedTextValue(
      commit.committedAt,
      "Takoserver execution evidence commit.committedAt",
      128,
    ),
  });
}

async function readTakoserverExecutionEvidence(
  client: TakoserverEvidenceClient,
  resources: readonly ManagedResourceIdentity[],
  operation: "apply" | "destroy",
  priorSnapshotFences?: ReadonlyMap<string, number>,
  priorApplyHistory?: ReadonlyMap<string, readonly string[]>,
): Promise<TakoserverEvidenceReadback> {
  if (resources.length !== CURRENT_RESOURCE_GRAPH.length) {
    throw new Error(
      `Takoserver execution evidence expected all ${CURRENT_RESOURCE_GRAPH.length} Resource identities`,
    );
  }
  const addresses = new Map<string, TakoserverResourceAddress>();
  const identityFingerprints = new Map<string, string>();
  const snapshotFences = new Map<string, number>();
  const prefixFingerprints = new Map<string, string>();
  const historyFingerprints = new Map<string, readonly string[]>();
  const coverages = new Map<string, "complete">();
  for (const resource of resources) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let pages = 0;
    const aggregateCommits: JsonRecord[] = [];
    for (;;) {
      pages += 1;
      if (pages > MAX_TAKOSERVER_EVIDENCE_PAGES) {
        throw new Error(
          "Takoserver execution evidence pagination exceeded its bound",
        );
      }
      const path = `/v1/organizations/${encodeURIComponent(client.organizationId)}/resources/${encodeURIComponent(resource.uid)}/execution-evidence?limit=${TAKOSERVER_EVIDENCE_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await client.request(path);
      if (response.status !== 200) {
        throw new Error(
          `Takoserver ${operation} execution evidence for ${resource.outputKey} returned HTTP ${response.status}`,
        );
      }
      const page = parseResourceExecutionEvidenceResponse(
        nestedRecord(response.body, "Takoserver execution evidence response"),
        client.organizationId,
        resource.uid,
        operation,
        resource,
      );
      const evidence = nestedRecord(
        page.executionEvidence,
        "Takoserver execution evidence",
      );
      const address = nestedRecord(
        nestedRecord(
          evidence.resource,
          "Takoserver execution evidence.resource",
        ).address,
        "Takoserver execution evidence.resource.address",
      );
      const currentAddress: TakoserverResourceAddress = {
        space: boundedTextValue(
          address.space,
          "Takoserver execution evidence.resource.address.space",
          512,
        ),
        name: boundedTextValue(
          address.name,
          "Takoserver execution evidence.resource.address.name",
          512,
        ),
      };
      const identityFingerprint = JSON.stringify({
        address,
        formRef: nestedRecord(
          evidence.resource,
          "Takoserver execution evidence.resource",
        ).formRef,
      });
      const priorIdentity = identityFingerprints.get(resource.uid);
      if (
        priorIdentity !== undefined &&
        priorIdentity !== identityFingerprint
      ) {
        throw new Error(
          "Takoserver execution evidence Resource identity changed between pages",
        );
      }
      identityFingerprints.set(resource.uid, identityFingerprint);
      const snapshotFence = requiredInteger(
        evidence.snapshotFence,
        "Takoserver execution evidence.snapshotFence",
      );
      const priorFence = snapshotFences.get(resource.uid);
      if (priorFence !== undefined && priorFence !== snapshotFence) {
        throw new Error(
          "Takoserver execution evidence snapshot fence changed between pages",
        );
      }
      snapshotFences.set(resource.uid, snapshotFence);
      const coverage = evidence.coverage;
      if (coverage !== "complete") {
        throw new Error(
          "Takoserver execution evidence coverage was invalid: expected complete",
        );
      }
      const priorCoverage = coverages.get(resource.uid);
      if (priorCoverage !== undefined && priorCoverage !== coverage) {
        throw new Error(
          "Takoserver execution evidence coverage changed between pages",
        );
      }
      coverages.set(resource.uid, coverage);
      const pageCommits = evidence.commits;
      if (!Array.isArray(pageCommits) || pageCommits.length === 0) {
        throw new Error(
          "Takoserver execution evidence page omitted committed lifecycle entries",
        );
      }
      for (const commit of pageCommits) {
        aggregateCommits.push(
          nestedRecord(commit, "Takoserver execution evidence commit"),
        );
      }
      const priorAddress = addresses.get(resource.uid);
      if (
        priorAddress !== undefined &&
        (priorAddress.space !== currentAddress.space ||
          priorAddress.name !== currentAddress.name)
      ) {
        throw new Error(
          "Takoserver execution evidence Resource address changed between pages",
        );
      }
      addresses.set(resource.uid, currentAddress);
      const nextCursor =
        typeof page.cursor === "string" && page.cursor.length > 0
          ? page.cursor
          : undefined;
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) {
        throw new Error("Takoserver execution evidence cursor repeated");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    const priorFence = priorSnapshotFences?.get(resource.uid);
    if (operation === "apply" && coverages.get(resource.uid) !== "complete") {
      throw new Error(
        "Takoserver execution evidence Apply coverage was not complete",
      );
    }
    const history = aggregateCommits.map(executionCommitFingerprint);
    historyFingerprints.set(resource.uid, history);
    assertResourceExecutionEvidenceSequence(
      aggregateCommits,
      snapshotFences.get(resource.uid)!,
      operation,
      priorFence,
    );
    if (operation === "destroy") {
      const expectedPrior = priorApplyHistory?.get(resource.uid);
      if (!expectedPrior) {
        throw new Error(
          "Takoserver execution evidence Destroy history lacked the Apply history baseline",
        );
      }
      const actualPrior = history.slice(1);
      if (
        expectedPrior.length !== actualPrior.length ||
        expectedPrior.some((value, index) => value !== actualPrior[index])
      ) {
        throw new Error(
          "Takoserver execution evidence Destroy history did not retain the exact Apply history prefix",
        );
      }
    }
    const terminalCommit = aggregateCommits.at(-1);
    if (!terminalCommit) {
      throw new Error(
        "Takoserver execution evidence aggregate omitted its sequence-1 prefix",
      );
    }
    if (
      coverages.get(resource.uid) === "complete" &&
      terminalCommit.action !== "create"
    ) {
      throw new Error(
        "Takoserver execution evidence marked a non-create history complete",
      );
    }
    prefixFingerprints.set(
      resource.uid,
      JSON.stringify({
        sequence: terminalCommit.sequence,
        operationId: terminalCommit.operationId,
        action: terminalCommit.action,
        outcome: terminalCommit.outcome,
        resourceVersion: terminalCommit.resourceVersion,
      }),
    );
  }
  if (addresses.size !== resources.length) {
    throw new Error(
      "Takoserver execution evidence did not cover every managed Resource",
    );
  }
  return {
    addresses,
    identityFingerprints,
    snapshotFences,
    historyFingerprints,
    prefixFingerprints,
  };
}

async function assertTakoserverResourceAbsent(
  client: TakoserverEvidenceClient,
  resource: ManagedResourceIdentity,
): Promise<void> {
  const path = `/v1/organizations/${encodeURIComponent(client.organizationId)}/resources/${encodeURIComponent(resource.uid)}`;
  const response = await client.request(path);
  if (response.status !== 404) {
    throw new Error(
      `Takoserver Resource ${resource.outputKey} was not absent after destroy (HTTP ${response.status})`,
    );
  }
  assertTakoserverErrorEnvelope(
    response.body,
    `Takoserver Resource ${resource.outputKey} absence`,
    "not_found",
    false,
  );
}

/** Validate the Host-owned provider-native absence attestation. */
export function assertTakoserverNativeAbsenceResponse(
  status: number,
  body: unknown,
  resource: ManagedResourceIdentity,
  destroyInterval: DestroyAcknowledgementInterval,
): void {
  if (status !== 200) {
    throw new Error(
      `Takoserver native absence for ${resource.outputKey} returned HTTP ${status}`,
    );
  }
  const root = nestedRecord(
    body,
    `Takoserver native absence for ${resource.outputKey}`,
  );
  assertExactKeys(
    root,
    ["residual"],
    `Takoserver native absence for ${resource.outputKey}`,
  );
  const residual = nestedRecord(
    root.residual,
    `Takoserver native absence for ${resource.outputKey}.residual`,
  );
  assertClosedKeys(
    residual,
    ["checkedAt", "deploymentCount", "effectCount", "source", "status"],
    ["evidenceRef", "reason"],
    `Takoserver native absence for ${resource.outputKey}.residual`,
  );
  if (!["intrinsic", "provider"].includes(String(residual.source))) {
    throw new Error(
      `Takoserver native absence for ${resource.outputKey} had an invalid source`,
    );
  }
  if (residual.status !== "absent") {
    throw new Error(
      `Takoserver native absence for ${resource.outputKey} was not absent`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(residual, "reason")) {
    throw new Error(
      `Takoserver native absence for ${resource.outputKey} included a reason for status=absent`,
    );
  }
  for (const key of ["effectCount", "deploymentCount"] as const) {
    const count = requiredInteger(
      residual[key],
      `Takoserver native absence for ${resource.outputKey}.residual.${key}`,
    );
    if (count < 0) {
      throw new Error(
        `Takoserver native absence for ${resource.outputKey}.${key} was negative`,
      );
    }
  }
  const checkedAt = assertCanonicalTimestamp(
    residual.checkedAt,
    `Takoserver native absence for ${resource.outputKey}.checkedAt`,
  );
  const checkedAtMs = Date.parse(checkedAt);
  assertDestroyAcknowledgementInterval(destroyInterval);
  if (
    checkedAtMs <
      destroyInterval.startedAtMs - MAX_NATIVE_ABSENCE_CLOCK_SKEW_MS ||
    checkedAtMs >
      destroyInterval.acknowledgedAtMs + MAX_NATIVE_ABSENCE_CLOCK_SKEW_MS
  ) {
    throw new Error(
      `Takoserver native absence for ${resource.outputKey}.checkedAt was outside the Destroy acknowledgement interval (bounded evidence window)`,
    );
  }
  requiredDigest(
    residual.evidenceRef,
    `Takoserver native absence for ${resource.outputKey}.evidenceRef`,
  );
}

async function assertTakoserverNativeAbsent(
  client: TakoserverEvidenceClient,
  resource: ManagedResourceIdentity,
  address: TakoserverResourceAddress,
  destroyInterval: DestroyAcknowledgementInterval,
): Promise<void> {
  const query = new URLSearchParams({
    space: address.space,
    name: address.name,
  });
  const path = `/v1/organizations/${encodeURIComponent(client.organizationId)}/resources/${encodeURIComponent(resource.uid)}/native-residual?${query.toString()}`;
  const response = await client.request(path);
  assertTakoserverNativeAbsenceResponse(
    response.status,
    response.body,
    resource,
    destroyInterval,
  );
}

function assertDestroyAcknowledgementInterval(
  interval: DestroyAcknowledgementInterval,
): void {
  const now = Date.now();
  if (
    !Number.isSafeInteger(interval.startedAtMs) ||
    !Number.isSafeInteger(interval.acknowledgedAtMs) ||
    interval.startedAtMs < 0 ||
    interval.acknowledgedAtMs < interval.startedAtMs ||
    interval.acknowledgedAtMs - interval.startedAtMs >
      MAX_DESTROY_ACKNOWLEDGEMENT_INTERVAL_MS ||
    interval.acknowledgedAtMs > now + MAX_NATIVE_ABSENCE_CLOCK_SKEW_MS
  ) {
    throw new Error(
      "Destroy acknowledgement interval was not a bounded acknowledged interval",
    );
  }
}

function assertTakoserverErrorEnvelope(
  value: unknown,
  label: string,
  expectedCode: string,
  allowOptional = true,
): void {
  const root = nestedRecord(value, `${label} response`);
  assertExactKeys(root, ["error"], label);
  const error = nestedRecord(root.error, `${label}.error`);
  assertClosedKeys(
    error,
    ["code", "message", "requestId", "retryable"],
    allowOptional ? ["details", "hostCode"] : [],
    `${label}.error`,
  );
  if (
    error.code !== expectedCode ||
    typeof error.message !== "string" ||
    !error.message.trim() ||
    typeof error.requestId !== "string" ||
    !error.requestId.trim() ||
    error.retryable !== false
  ) {
    throw new Error(`${label} was not a closed ${expectedCode} error envelope`);
  }
}

export function assertRunProviderPin(run: JsonRecord): void {
  const requirements = parseProviderRequirements(
    run.requiredProviderRequirements,
  );
  if (
    requirements.length !== 1 ||
    requirements[0]!.provider !== TAKOFORM_PROVIDER_SOURCE ||
    requirements[0]!.moduleLocalName !== "takoform" ||
    requirements[0]!.childAlias !== undefined ||
    requirements[0]!.version !== TAKOFORM_PROVIDER_VERSION
  ) {
    throw new Error(
      "reviewed PlanRun did not retain the exact Takoform Provider",
    );
  }
  if (
    Object.hasOwn(run, "providerVersion") &&
    run.providerVersion !== TAKOFORM_PROVIDER_VERSION
  ) {
    throw new Error(
      `reviewed PlanRun selected Provider ${String(run.providerVersion)} instead of ${TAKOFORM_PROVIDER_VERSION}`,
    );
  }
}

function assertRunGraph(run: JsonRecord): void {
  assertInstallPlanGraph(run);
}

export function assertReviewableRun(run: JsonRecord, label: string): void {
  const status = requiredString(run.status, `${label}.status`);
  if (status !== "waiting_approval" && status !== "succeeded") {
    throw new Error(`${label} did not leave a reviewable PlanRun`);
  }
}

export function assertRunType(
  run: JsonRecord,
  label: string,
  expected: "plan" | "apply" | "destroy_plan" | "destroy_apply",
): void {
  const actual = requiredString(run.type, `${label}.type`);
  if (actual !== expected) {
    throw new Error(`${label}.type was ${actual}; expected ${expected}`);
  }
}

export function runRequiresApproval(run: JsonRecord): boolean {
  return run.status === "waiting_approval" || run.requiresApproval === true;
}

export function assertDestroyRequiresApproval(run: JsonRecord): void {
  assertReviewableRun(run, "destroy PlanRun");
  if (!runRequiresApproval(run)) {
    throw new Error(
      "destroy PlanRun did not park in waiting_approval; refusing an unreviewed destroy",
    );
  }
}

export function decideCleanup(
  phase: LifecyclePhase,
  mutationUncertain: boolean,
  capsuleId: string,
): "destroy" | "refuse" | "none" {
  if (!capsuleId) return "none";
  if (
    mutationUncertain ||
    phase === "apply-dispatch-started" ||
    phase === "destroy-plan-dispatch-started" ||
    phase === "destroy-apply-dispatch-started"
  )
    return "refuse";
  if (
    phase === "capsule-created" ||
    phase === "plan-reviewed" ||
    phase === "apply-confirmed" ||
    phase === "functional-probe"
  ) {
    return "destroy";
  }
  return "none";
}

async function waitForReviewableRun(
  api: ApiClient,
  runId: string,
  timeoutMs: number,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await api.requestJson(
      `/api/v1/runs/${encodeURIComponent(runId)}`,
      { expectedStatus: 200 },
    );
    const current = response.run;
    if (!isRecord(current)) throw new Error("run response omitted run");
    const status = requiredString(current.status, "run.status");
    if (status === "succeeded" || status === "waiting_approval") return current;
    if (["failed", "cancelled", "expired"].includes(status))
      throw new Error(`Run ${runId} ended in ${status}`);
    if (Date.now() > deadline) throw new Error(`Run ${runId} timed out`);
    await sleep(POLL_DELAY_MS);
  }
}

async function waitForSucceededRun(
  api: ApiClient,
  runId: string,
  timeoutMs: number,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await readRun(api, runId);
    const status = requiredString(current.status, "run.status");
    if (status === "succeeded") return current;
    if (status === "waiting_approval") {
      throw new Error(`Run ${runId} is waiting_approval after approval`);
    }
    if (["failed", "cancelled", "expired"].includes(status))
      throw new Error(`Run ${runId} ended in ${status}`);
    if (Date.now() > deadline) throw new Error(`Run ${runId} timed out`);
    await sleep(POLL_DELAY_MS);
  }
}

async function readRun(api: ApiClient, runId: string): Promise<JsonRecord> {
  const response = await api.requestJson(
    `/api/v1/runs/${encodeURIComponent(runId)}`,
    { expectedStatus: 200 },
  );
  return nestedRecord(response.run, "run response");
}

async function approveRunIfRequired(
  api: ApiClient,
  runId: string,
  run: JsonRecord,
): Promise<boolean> {
  if (!runRequiresApproval(run)) return false;
  const expectedType =
    run.type === "destroy_plan" ? "destroy_plan" : ("plan" as const);
  assertRunType(run, "approval target Run", expectedType);
  try {
    const approved = await api.requestJson(
      `/api/v1/runs/${encodeURIComponent(runId)}/approve`,
      {
        method: "POST",
        body: {},
        headers: {
          "Idempotency-Key": idempotencyKey("yurucommu-approve", runId),
        },
        expectedStatus: 200,
      },
    );
    parseApprovedRunResponse(approved, runId, expectedType);
    return true;
  } catch (error) {
    if (!isMutationUncertain(error)) {
      // The POST reached the owner and returned a 2xx body, but the body was
      // not the closed approval contract.  Its effect is therefore unknown.
      throw new MutationUncertainError(
        `plan approval response was semantically invalid after dispatch: ${
          error instanceof Error ? error.message : "unknown response error"
        }`,
      );
    }
    // A lost approval acknowledgement is safe to reconcile by reading the
    // same Run.  Retry only when the durable projection still requires it;
    // never guess that an approval happened.
    const observed = await readRun(api, runId).catch(() => undefined);
    if (observed) {
      try {
        parseApprovedRunResponse({ run: observed }, runId, expectedType);
        return true;
      } catch {
        // The stable-key readback did not prove the exact approved Run; keep
        // the mutation indeterminate and never submit Apply or Destroy.
      }
    }
    if (!observed) throw error;
    throw new MutationUncertainError(
      `approval acknowledgement for Run ${runId} remains indeterminate`,
    );
  }
}

async function mutateWithRunReconciliation<T = JsonRecord>(
  api: ApiClient,
  path: string,
  options: Parameters<ApiClient["requestJson"]>[1],
  reconcile: MutationReconciler | undefined,
  label: string,
  validate?: MutationValidator<T>,
): Promise<T> {
  let response: JsonRecord;
  try {
    response = await api.requestJson(path, options);
  } catch (error) {
    if (!isMutationUncertain(error)) throw error;
    const reconciled = await reconcileMutationAcknowledgement(
      api,
      reconcile,
      label,
      error,
    );
    return validateReconciledMutation(reconciled, label, validate);
  }
  if (!validate) return response as T;
  try {
    return validate(response);
  } catch (error) {
    // A 2xx mutation with a malformed/closed-schema response may have been
    // committed.  Treat semantic validation exactly like a lost transport
    // acknowledgement and reconcile through the owner projection.
    const uncertain = new MutationUncertainError(
      `${label} response was semantically invalid after dispatch: ${
        error instanceof Error ? error.message : "unknown response error"
      }`,
    );
    const reconciled = await reconcileMutationAcknowledgement(
      api,
      reconcile,
      label,
      uncertain,
    );
    return validateReconciledMutation(reconciled, label, validate);
  }
}

function validateReconciledMutation<T>(
  value: JsonRecord,
  label: string,
  validate: MutationValidator<T> | undefined,
): T {
  if (!validate) return value as T;
  try {
    return validate(value);
  } catch (error) {
    throw new MutationUncertainError(
      `${label} owner reconciliation did not match its closed response contract: ${
        error instanceof Error ? error.message : "unknown response error"
      }`,
    );
  }
}

async function reconcileMutationAcknowledgement(
  api: ApiClient,
  reconcile: MutationReconciler | undefined,
  label: string,
  original: unknown,
): Promise<JsonRecord> {
  if (!isMutationUncertain(original)) throw original;
  const acknowledged = reconcile
    ? await reconcile(api).catch(() => undefined)
    : undefined;
  if (acknowledged) return acknowledged;
  throw new MutationUncertainError(
    `${label} acknowledgement is indeterminate after dispatch; no cleanup is safe`,
  );
}

async function reconcileApplyMutation(
  api: ApiClient,
  planRunId: string,
): Promise<JsonRecord | undefined> {
  const observed = await readRun(api, planRunId).catch(() => undefined);
  if (!observed) return undefined;
  if (typeof observed.appliedApplyRunId === "string") {
    const applyRun = await readRun(api, observed.appliedApplyRunId).catch(
      () => undefined,
    );
    if (applyRun) return { run: applyRun };
  }
  return undefined;
}

/**
 * Destroy-plan acknowledgement has no Capsule-id-shaped Run endpoint.  Only
 * an explicit upstream projection may identify the plan; never pass the
 * Capsule id to /runs/:id and accidentally reconcile an unrelated object.
 */
async function reconcileDestroyPlanMutation(
  api: ApiClient,
  capsuleId: string,
): Promise<JsonRecord | undefined> {
  const response = await api.requestJson(
    `/api/v1/capsules/${encodeURIComponent(capsuleId)}`,
    { expectedStatus: 200 },
  );
  const capsule = isRecord(response.capsule) ? response.capsule : undefined;
  const destroyPlanRunId =
    capsule && typeof capsule.destroyPlanRunId === "string"
      ? capsule.destroyPlanRunId
      : undefined;
  if (!destroyPlanRunId) return undefined;
  const run = await readRun(api, destroyPlanRunId).catch(() => undefined);
  return run ? { run } : undefined;
}

/** Configuration-plan recovery is accepted only through the exact owner
 * response shape. A Capsule GET is not allowed to be reshaped into a guessed
 * configuration-plan acknowledgement when the upstream projection is absent.
 */
async function reconcileConfigurationPlanMutation(
  api: ApiClient,
  capsuleId: string,
): Promise<JsonRecord | undefined> {
  const response = await api.requestJson(
    `/api/v1/capsules/${encodeURIComponent(capsuleId)}`,
    { expectedStatus: 200 },
  );
  if (!isRecord(response.configurationPlan) || !isRecord(response.links)) {
    return undefined;
  }
  const capsule = nestedRecord(response.capsule, "configuration plan capsule");
  if (capsule.id !== capsuleId) return undefined;
  parseConfigurationPlanResponse(response);
  return response;
}

function idempotencyKey(prefix: string, id: string): string {
  const normalized = id.replace(/[^A-Za-z0-9_.:-]/gu, "_");
  return `${prefix}-${normalized}`;
}

export async function assertExactDestroyedProjection(
  api: ApiClient,
  expectation: DestroyProjectionExpectation,
): Promise<void> {
  const errors: unknown[] = [];
  let capsuleContext: RunIdentityContext | undefined;
  try {
    const capsule = await api.requestJson(
      `/api/v1/capsules/${encodeURIComponent(expectation.capsuleId)}`,
      { expectedStatus: 200 },
    );
    const capsuleRecord = nestedRecord(capsule.capsule, "capsule response");
    if (capsuleRecord.status !== "destroyed") {
      throw new Error(
        "destroyed Capsule projection did not report status=destroyed",
      );
    }
    capsuleContext = readCapsuleRunIdentityContext(
      capsule,
      expectation.capsuleId,
      expectation.workspaceId,
    );
  } catch (error) {
    errors.push(error);
  }

  // Every projection is read even when another one is malformed or absent.
  // This is important after a successful Destroy Apply: one stale surface must
  // not hide evidence that a different surface still exposes the Capsule.
  try {
    const outputs = await api.requestJson(
      `/api/v1/capsules/${encodeURIComponent(expectation.capsuleId)}/outputs`,
      { expectedStatus: 200 },
    );
    assertExactKeys(outputs, ["output"], "destroyed Capsule outputs response");
    if (outputs.output !== null) {
      throw new Error("destroyed Capsule still exposed a current Output");
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    const bindings = await api.requestJson(
      `/api/v1/capsules/${encodeURIComponent(expectation.capsuleId)}/provider-bindings`,
      { expectedStatus: 200 },
    );
    assertExactKeys(
      bindings,
      ["providerBindingSet"],
      "destroyed Capsule ProviderBindingSet response",
    );
    if (bindings.providerBindingSet !== null) {
      throw new Error("destroyed Capsule still exposed a ProviderBindingSet");
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    const inventory = await api.requestJson(
      `/api/v1/capsules/${encodeURIComponent(expectation.capsuleId)}/current-resource-inventory`,
      { expectedStatus: 200 },
    );
    if (!capsuleContext?.currentStateVersionId) {
      throw new Error(
        "destroyed Capsule omitted the StateVersion required to bind empty inventory",
      );
    }
    assertManagedResourceInventoryEmpty(inventory, {
      capsuleId: expectation.capsuleId,
      workspaceId: expectation.workspaceId,
      environment: STAGING_ENVIRONMENT,
      stateVersionId: capsuleContext.currentStateVersionId,
      generation: capsuleContext.baseStateGeneration,
      applyRunId: expectation.applyRunId,
      planRunId: expectation.planRunId,
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    const interfaces = await api.requestJson(
      `/api/v1/workspaces/${encodeURIComponent(expectation.workspaceId)}/ui-surfaces?capsuleId=${encodeURIComponent(expectation.capsuleId)}`,
      { expectedStatus: 200 },
    );
    assertManagedLauncherAbsent(interfaces);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "destroyed Capsule projection absence failed",
    );
  }
}

function readLaunchUrl(value: JsonRecord): string {
  const output = nestedRecord(value, "Capsule output response").output;
  if (
    !isRecord(output) ||
    !isRecord(output.publicOutputs) ||
    typeof output.publicOutputs.launch_url !== "string"
  )
    throw new Error("Capsule outputs did not contain launch_url");
  const url = new URL(output.publicOutputs.launch_url);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("launch_url must be HTTPS unless loopback");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("launch_url must be a credential-free origin");
  return url.origin + (url.pathname === "/" ? "/" : url.pathname);
}

function parseProviderRequirements(value: unknown): ProviderRequirement[] {
  if (!Array.isArray(value))
    throw new Error("configuration plan omitted provider requirements");
  return value.map((candidate, index) =>
    normalizeProviderRequirement(candidate as ProviderRequirement, index),
  );
}

export function parseInstallPlanResponse(
  value: JsonRecord,
  expectedPlanId?: string,
  expectedActionKind?: "choose_module" | "configure" | "reconcile",
): InstallPlanResponse {
  assertClosedKeys(
    value,
    ["installPlan", "nextAction", "links"],
    ["action"],
    "Takosumi install plan response",
  );
  const installPlan = nestedRecord(
    value.installPlan,
    "Takosumi install plan response.installPlan",
  );
  const planId = requiredIdentifier(
    typeof installPlan.id === "string" ? installPlan.id : undefined,
    "Takosumi install plan response.installPlan.id",
  );
  if (expectedPlanId !== undefined && planId !== expectedPlanId) {
    throw new Error("Takosumi install plan response id did not match dispatch");
  }
  const phase = requiredString(
    installPlan.phase,
    "Takosumi install plan response.installPlan.phase",
  );
  if (
    ![
      "syncing_source",
      "compiling_install",
      "analyzing_compatibility",
      "awaiting_module",
      "awaiting_configuration",
      "creating_capsule",
      "planning",
      "reviewable",
      "failed",
    ].includes(phase)
  ) {
    throw new Error("Takosumi install plan response phase was unsupported");
  }
  requiredInteger(
    installPlan.generation,
    "Takosumi install plan response.installPlan.generation",
  );
  const nextAction = requiredString(
    value.nextAction,
    "Takosumi install plan response.nextAction",
  );
  if (
    !["reconcile", "choose_module", "configure", "review_run", "none"].includes(
      nextAction,
    )
  ) {
    throw new Error(
      "Takosumi install plan response nextAction was unsupported",
    );
  }
  const action =
    value.action === undefined
      ? undefined
      : nestedRecord(value.action, "Takosumi install plan response.action");
  if (action) assertInstallPlanAction(action, planId);
  if (
    expectedActionKind !== undefined &&
    expectedActionKind !== "reconcile" &&
    nextAction === expectedActionKind &&
    (!action || action.kind !== expectedActionKind)
  ) {
    throw new Error(
      `Takosumi install plan ${expectedActionKind} response omitted its closed action projection`,
    );
  }
  const links = nestedRecord(
    value.links,
    "Takosumi install plan response.links",
  );
  assertClosedKeys(links, ["self"], ["reconcile", "run"], "install plan links");
  const self = requiredString(links.self, "install plan links.self");
  if (self !== `/api/v1/install-plans/${encodeURIComponent(planId)}`) {
    throw new Error("install plan links.self did not bind its InstallPlan");
  }
  if (links.reconcile !== undefined) {
    if (
      typeof links.reconcile !== "string" ||
      links.reconcile !== `${self}/reconcile`
    ) {
      throw new Error(
        "install plan links.reconcile did not bind its InstallPlan",
      );
    }
  }
  const planRunId =
    installPlan.planRunId === undefined
      ? undefined
      : requiredIdentifier(
          typeof installPlan.planRunId === "string"
            ? installPlan.planRunId
            : undefined,
          "Takosumi install plan response.installPlan.planRunId",
        );
  if (links.run !== undefined) {
    if (
      !planRunId ||
      links.run !== `/api/v1/runs/${encodeURIComponent(planRunId)}`
    ) {
      throw new Error("install plan links.run did not bind its PlanRun");
    }
  }
  if (nextAction === "review_run" && (!planRunId || links.run === undefined)) {
    throw new Error("reviewable install plan omitted its PlanRun link");
  }
  return {
    installPlan,
    nextAction,
    ...(action ? { action } : {}),
    links,
  };
}

function assertInstallPlanAction(action: JsonRecord, planId: string): void {
  const kind = requiredString(action.kind, "install plan action.kind");
  if (kind === "choose_module") {
    assertExactKeys(
      action,
      ["generation", "href", "id", "kind", "method", "modules"],
      "choose_module install action",
    );
    if (action.method !== "POST")
      throw new Error("choose_module install action method was not POST");
    requiredIdentifier(
      typeof action.id === "string" ? action.id : undefined,
      "choose_module install action.id",
    );
    requiredInteger(
      action.generation,
      "choose_module install action.generation",
    );
    if (
      action.href !==
      `/api/v1/install-plans/${encodeURIComponent(planId)}/actions`
    )
      throw new Error(
        "choose_module install action href did not bind its InstallPlan",
      );
    if (!Array.isArray(action.modules) || action.modules.length === 0)
      throw new Error("choose_module install action omitted module candidates");
    action.modules.forEach((candidate, index) =>
      assertInstallModuleCandidate(candidate, index),
    );
    return;
  }
  if (kind === "configure") {
    assertExactKeys(
      action,
      [
        "compatibilityReportId",
        "generation",
        "href",
        "id",
        "installConfigId",
        "kind",
        "method",
        "providerRequirements",
      ],
      "configure install action",
    );
    if (action.method !== "POST")
      throw new Error("configure install action method was not POST");
    requiredIdentifier(
      typeof action.id === "string" ? action.id : undefined,
      "configure install action.id",
    );
    requiredInteger(action.generation, "configure install action.generation");
    if (
      action.href !==
      `/api/v1/install-plans/${encodeURIComponent(planId)}/actions`
    )
      throw new Error(
        "configure install action href did not bind its InstallPlan",
      );
    requiredIdentifier(
      typeof action.installConfigId === "string"
        ? action.installConfigId
        : undefined,
      "configure install action.installConfigId",
    );
    requiredIdentifier(
      typeof action.compatibilityReportId === "string"
        ? action.compatibilityReportId
        : undefined,
      "configure install action.compatibilityReportId",
    );
    if (!Array.isArray(action.providerRequirements))
      throw new Error("configure install action omitted provider requirements");
    action.providerRequirements.forEach((candidate, index) => {
      const requirement = nestedRecord(
        candidate,
        `configure install action.providerRequirements[${index}]`,
      );
      assertClosedKeys(
        requirement,
        ["moduleLocalName", "provider"],
        ["childAlias"],
        `configure install action.providerRequirements[${index}]`,
      );
      normalizeProviderRequirement(
        requirement as unknown as ProviderRequirement,
        index,
      );
    });
    return;
  }
  throw new Error(`install plan returned unsupported action kind ${kind}`);
}

function assertInstallModuleCandidate(value: unknown, index: number): void {
  const module = nestedRecord(
    value,
    `choose_module install action.modules[${index}]`,
  );
  assertClosedKeys(
    module,
    ["path", "providerPackages", "rootProviderRequirements"],
    [],
    `choose_module install action.modules[${index}]`,
  );
  boundedTextValue(
    module.path,
    `choose_module install action.modules[${index}].path`,
    4_096,
  );
  if (!Array.isArray(module.providerPackages)) {
    throw new Error(
      `choose_module install action.modules[${index}].providerPackages was invalid`,
    );
  }
  module.providerPackages.forEach((candidate, packageIndex) => {
    const providerPackage = nestedRecord(
      candidate,
      `choose_module install action.modules[${index}].providerPackages[${packageIndex}]`,
    );
    assertClosedKeys(
      providerPackage,
      ["source"],
      ["version"],
      `choose_module install action.modules[${index}].providerPackages[${packageIndex}]`,
    );
    boundedTextValue(
      providerPackage.source,
      `choose_module install action.modules[${index}].providerPackages[${packageIndex}].source`,
      512,
    );
    if (providerPackage.version !== undefined) {
      boundedTextValue(
        providerPackage.version,
        `choose_module install action.modules[${index}].providerPackages[${packageIndex}].version`,
        64,
      );
    }
  });
  if (!Array.isArray(module.rootProviderRequirements)) {
    throw new Error(
      `choose_module install action.modules[${index}].rootProviderRequirements was invalid`,
    );
  }
  module.rootProviderRequirements.forEach((candidate, requirementIndex) => {
    const requirement = nestedRecord(
      candidate,
      `choose_module install action.modules[${index}].rootProviderRequirements[${requirementIndex}]`,
    );
    assertClosedKeys(
      requirement,
      ["moduleLocalName", "source"],
      ["childAlias", "version"],
      `choose_module install action.modules[${index}].rootProviderRequirements[${requirementIndex}]`,
    );
    boundedTextValue(
      requirement.source,
      `choose_module install action.modules[${index}].rootProviderRequirements[${requirementIndex}].source`,
      512,
    );
    boundedTextValue(
      requirement.moduleLocalName,
      `choose_module install action.modules[${index}].rootProviderRequirements[${requirementIndex}].moduleLocalName`,
      128,
    );
    if (requirement.childAlias !== undefined) {
      boundedTextValue(
        requirement.childAlias,
        `choose_module install action.modules[${index}].rootProviderRequirements[${requirementIndex}].childAlias`,
        128,
      );
    }
    if (requirement.version !== undefined) {
      boundedTextValue(
        requirement.version,
        `choose_module install action.modules[${index}].rootProviderRequirements[${requirementIndex}].version`,
        64,
      );
    }
  });
}

/** Validate the owner-published configuration-plan response before using its Run id. */
export function parseConfigurationPlanResponse(value: JsonRecord): JsonRecord {
  assertExactKeys(
    value,
    ["capsule", "configurationPlan", "links"],
    "configuration plan response",
  );
  const capsule = nestedRecord(
    value.capsule,
    "configuration plan response.capsule",
  );
  requiredIdentifier(
    typeof capsule.id === "string" ? capsule.id : undefined,
    "configuration plan response.capsule.id",
  );
  const plan = nestedRecord(
    value.configurationPlan,
    "configuration plan response.configurationPlan",
  );
  assertExactKeys(
    plan,
    [
      "planRunId",
      "previousInstallConfigId",
      "replayed",
      "sourceSnapshotId",
      "targetInstallConfigId",
    ],
    "configuration plan response.configurationPlan",
  );
  const planRunId = requiredIdentifier(
    typeof plan.planRunId === "string" ? plan.planRunId : undefined,
    "configurationPlan.planRunId",
  );
  requiredIdentifier(
    typeof plan.previousInstallConfigId === "string"
      ? plan.previousInstallConfigId
      : undefined,
    "configurationPlan.previousInstallConfigId",
  );
  requiredIdentifier(
    typeof plan.targetInstallConfigId === "string"
      ? plan.targetInstallConfigId
      : undefined,
    "configurationPlan.targetInstallConfigId",
  );
  requiredIdentifier(
    typeof plan.sourceSnapshotId === "string"
      ? plan.sourceSnapshotId
      : undefined,
    "configurationPlan.sourceSnapshotId",
  );
  if (typeof plan.replayed !== "boolean") {
    throw new Error("configurationPlan.replayed was not a boolean");
  }
  const links = nestedRecord(value.links, "configuration plan response.links");
  assertExactKeys(links, ["run"], "configuration plan response.links");
  if (links.run !== `/api/v1/runs/${encodeURIComponent(planRunId)}`) {
    throw new Error(
      "configuration plan response.links.run did not bind its Run",
    );
  }
  return value;
}

/** Approval is a mutation: require the exact `{run}` owner response and id. */
export function parseApprovedRunResponse(
  value: JsonRecord,
  expectedRunId: string,
  expectedType?: "plan" | "destroy_plan",
): JsonRecord {
  assertExactKeys(value, ["run"], "plan approval response");
  const run = nestedRecord(value.run, "plan approval response.run");
  const runId = requiredIdentifier(
    typeof run.id === "string" ? run.id : undefined,
    "plan approval response.run.id",
  );
  if (runId !== expectedRunId) {
    throw new Error(
      "plan approval response Run id did not match the dispatched Run",
    );
  }
  if (expectedType !== undefined) {
    assertRunType(run, "plan approval response.run", expectedType);
  }
  if (run.status !== "succeeded" || run.requiresApproval === true) {
    throw new Error(
      "plan approval response did not prove the Run was approved and applyable",
    );
  }
  return value;
}

/** All dispatched plan/apply mutations must at least return an owner Run id. */
export function parseRunMutationResponse(
  value: JsonRecord,
  label: string,
  expectedType?: "plan" | "apply" | "destroy_plan" | "destroy_apply",
): JsonRecord {
  assertExactKeys(value, ["run"], `${label} response`);
  const run = nestedRecord(value.run, `${label} response.run`);
  requiredIdentifier(
    typeof run.id === "string" ? run.id : undefined,
    `${label} response.run.id`,
  );
  const status = requiredString(run.status, `${label} response.run.status`);
  if (
    ![
      "queued",
      "running",
      "waiting_approval",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
    ].includes(status)
  ) {
    throw new Error(`${label} response.run.status was invalid`);
  }
  if (expectedType !== undefined) {
    assertRunType(run, `${label} response.run`, expectedType);
  }
  return value;
}

function requireAction(
  response: InstallPlanResponse,
  kind: string,
): JsonRecord {
  if (!response.action || response.action.kind !== kind)
    throw new Error(`install plan did not return a ${kind} action`);
  return response.action;
}

async function readBoundedResponseText(
  response: Response,
  path: string,
  mutation: boolean,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ApiRequestError(
          `${path} response exceeded ${MAX_RESPONSE_BYTES} bytes`,
          mutation,
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError(`${path} response body read failed`, mutation);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function probeTakosumiDeployment(
  config: ManagedStagingConfig,
): Promise<TakosumiDeploymentProof> {
  const receipt = await readTakosumiDeployReceipt(
    config.takosumiDeployReceiptFile,
  );
  const transport = await createPinnedHttpTransport(config.takosumiOrigin);
  const response = await transport.request(
    new URL("/", config.takosumiOrigin),
    {
      method: "GET",
      headers: { accept: "text/html", origin: config.takosumiOrigin },
    },
  );
  const observedVersionId = response.headers.get("x-takosumi-version-id");
  const body = await readBoundedResponseText(response, "/", false);
  if (response.status !== 200) {
    throw new Error(
      `Takosumi staging identity probe returned HTTP ${response.status}`,
    );
  }
  if (observedVersionId !== receipt.deployedVersionId) {
    throw new Error(
      "Takosumi staging identity probe did not return the expected x-takosumi-version-id",
    );
  }
  if (!body)
    throw new Error("Takosumi staging identity probe returned an empty body");
  return { receipt, transport };
}

export async function readTakosumiDeployReceipt(
  path: string,
): Promise<TakosumiDeployReceipt> {
  const raw = await readPrivateFile(path, "Takosumi deploy receipt", true);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Takosumi deploy receipt file was not valid JSON");
  }
  if (!isRecord(value)) {
    throw new Error("Takosumi deploy receipt must be a JSON object");
  }
  const actualKeys = Object.keys(value).sort();
  const requiredKeys = [...PLATFORM_READY_RECEIPT_KEYS].sort();
  const recoveryKeys = [...requiredKeys, "recoverySourceCommit"].sort();
  if (
    JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys) &&
    JSON.stringify(actualKeys) !== JSON.stringify(recoveryKeys)
  ) {
    throw new Error(
      "Takosumi deploy receipt keys are not the closed ready-evidence set",
    );
  }
  if (
    value.kind !== "takosumi.platform-worker-release-evidence@v2" ||
    value.status !== "ready" ||
    value.environment !== STAGING_ENVIRONMENT
  ) {
    throw new Error("Takosumi deploy receipt must be ready staging evidence");
  }
  const sourceCommit = requiredCommit(
    value.sourceCommit,
    "deploy source commit",
  );
  if (Object.hasOwn(value, "recoverySourceCommit")) {
    requiredCommit(value.recoverySourceCommit, "deploy recovery source commit");
  }
  const predecessorVersionId = readWorkerVersionId(
    value.predecessorVersionId,
    "deploy predecessor Worker Version ID",
  );
  const deployedVersionId = readWorkerVersionId(
    value.deployedVersionId,
    "deploy Worker Version ID",
  );
  if (predecessorVersionId === deployedVersionId) {
    throw new Error(
      "Takosumi deploy receipt reused the predecessor Worker Version ID",
    );
  }
  for (const name of [
    "closureSha256",
    "configSha256",
    "dashboardAssetsSha256",
    "dryRunSha256",
    "sealedConfigSha256",
    "secretNamesSha256",
    "planConfirmation",
  ]) {
    requiredDigest(value[name], `deploy ${name}`);
  }
  const planConfirmation = requiredDigest(
    value.planConfirmation,
    "deploy planConfirmation",
  );
  if (
    typeof value.completedAt !== "string" ||
    value.completedAt.length > 128 ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    new Date(value.completedAt).toISOString() !== value.completedAt
  ) {
    throw new Error("Takosumi deploy receipt completedAt was invalid");
  }
  const configPath = boundedTextValue(
    value.configPath,
    "deploy config path",
    4_096,
  );
  if (!configPath.startsWith("/")) {
    throw new Error("Takosumi deploy receipt configPath must be absolute");
  }
  boundedTextValue(value.releaseTag, "deploy release tag", 512);
  const reviewer = boundedTextValue(value.reviewer, "deploy reviewer", 512);
  if (
    /-----BEGIN [^-]*PRIVATE KEY-----/iu.test(reviewer) ||
    /\b(?:bearer|token|secret|password)\s*[=:]\s*\S+/iu.test(reviewer) ||
    /\b(?:gh[pousr]_|sk_live_|AKIA)[0-9A-Za-z]{12,}/u.test(reviewer)
  ) {
    throw new Error("Takosumi deploy receipt reviewer was invalid");
  }
  if (typeof value.lostAcknowledgement !== "boolean") {
    throw new Error("Takosumi deploy receipt lostAcknowledgement was invalid");
  }
  const predecessorContainer = assertPlatformContainer(
    value.predecessorContainer,
    "deploy predecessorContainer",
  );
  const deployedContainer = assertPlatformContainer(
    value.deployedContainer,
    "deploy deployedContainer",
  );
  if (
    deployedContainer.id !== predecessorContainer.id ||
    deployedContainer.name !== predecessorContainer.name
  ) {
    throw new Error(
      "Takosumi deploy receipt did not bind one restorable Worker",
    );
  }
  const reversal = nestedRecord(value.reversal, "deploy reversal");
  assertExactKeys(
    reversal,
    [
      "action",
      "planConfirmation",
      "predecessorContainer",
      "predecessorVersionId",
      "surface",
    ],
    "deploy reversal",
  );
  if (
    reversal.surface !== TAKOSUMI_DEPLOY_SURFACE ||
    reversal.action !== "restore" ||
    reversal.planConfirmation !== planConfirmation ||
    reversal.predecessorVersionId !== predecessorVersionId ||
    JSON.stringify(reversal.predecessorContainer) !==
      JSON.stringify(predecessorContainer)
  ) {
    throw new Error("Takosumi deploy reversal did not bind the ready receipt");
  }
  return {
    kind: "takosumi.platform-worker-release-evidence@v2",
    status: "ready",
    environment: STAGING_ENVIRONMENT,
    sourceCommit,
    predecessorVersionId,
    deployedVersionId,
    planConfirmation,
    reviewer,
    reversal: {
      surface: TAKOSUMI_DEPLOY_SURFACE,
      action: "restore",
      planConfirmation,
      predecessorVersionId,
    },
    fileDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  };
}

function createApiClient(
  origin: string,
  token: string,
  expectedVersionId: string,
  transport: PinnedHttpTransport,
): ApiClient {
  const pinnedOrigin = readOrigin(origin, "Takosumi API origin");
  if (!WORKER_VERSION_ID_PATTERN.test(expectedVersionId)) {
    throw new Error("Takosumi API expected Worker Version ID was invalid");
  }
  if (transport.origin !== pinnedOrigin) {
    throw new Error(
      "Takosumi API transport origin did not match the release receipt",
    );
  }
  return {
    origin: pinnedOrigin,
    token,
    transport,
    async requestJson(path, options) {
      const method = options.method ?? "GET";
      const url = new URL(path, pinnedOrigin);
      if (url.origin !== pinnedOrigin) {
        throw new Error("Takosumi request escaped the pinned origin");
      }
      let response: Response;
      try {
        response = await transport.request(url, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            origin: pinnedOrigin,
            ...(options.body !== undefined
              ? { "content-type": "application/json" }
              : {}),
            ...(options.headers ?? {}),
          },
          ...(options.body !== undefined
            ? { body: JSON.stringify(options.body) }
            : {}),
        });
      } catch (error) {
        throw new ApiRequestError(
          `${method} ${path} network request failed`,
          method !== "GET",
        );
      }
      const observedVersionId = response.headers.get("x-takosumi-version-id");
      if (observedVersionId !== expectedVersionId) {
        await response.body?.cancel();
        throw new ApiRequestError(
          `${method} ${path} did not carry the expected x-takosumi-version-id`,
          method !== "GET",
        );
      }
      const expectedStatus = options.expectedStatus ?? 200;
      const expectedStatuses = Array.isArray(expectedStatus)
        ? expectedStatus
        : [expectedStatus];
      if (!expectedStatuses.includes(response.status)) {
        await response.body?.cancel();
        throw new ApiRequestError(
          `${method} ${path} returned HTTP ${response.status}, expected ${expectedStatuses.join(" or ")}`,
          method !== "GET",
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(
          await readBoundedResponseText(response, path, method !== "GET"),
        );
      } catch (error) {
        if (error instanceof ApiRequestError) throw error;
        throw new ApiRequestError(
          `${method} ${path} returned invalid JSON`,
          method !== "GET",
        );
      }
      if (!isRecord(body)) {
        throw new ApiRequestError(
          `${method} ${path} did not return a JSON object`,
          method !== "GET",
        );
      }
      return body;
    },
  };
}

function createTakoserverEvidenceClient(
  origin: string,
  organizationId: string,
  token: string,
  transport: PinnedHttpTransport,
): TakoserverEvidenceClient {
  const pinnedOrigin = readOrigin(origin, "Takoserver evidence API origin");
  if (transport.origin !== pinnedOrigin) {
    throw new Error(
      "Takoserver evidence transport origin did not match its configured owner origin",
    );
  }
  const normalizedToken = token.trim();
  if (!normalizedToken || /[\r\n]/u.test(normalizedToken)) {
    throw new Error(
      "Takoserver evidence API credential was empty or multiline",
    );
  }
  return {
    origin: pinnedOrigin,
    organizationId: requiredIdentifier(
      organizationId,
      "Takoserver evidence organization id",
    ),
    token: normalizedToken,
    transport,
    async request(path, options = {}) {
      const url = new URL(path, pinnedOrigin);
      if (url.origin !== pinnedOrigin) {
        throw new Error("Takoserver evidence request escaped the owner origin");
      }
      let response: Response;
      try {
        response = await transport.request(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            ...(options.authenticated === false
              ? {}
              : { authorization: `Bearer ${normalizedToken}` }),
          },
          redirect: "error",
        });
      } catch {
        throw new Error("Takoserver evidence request failed");
      }
      const raw = await readBoundedResponseText(response, path, false);
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        throw new Error("Takoserver evidence response was not valid JSON");
      }
      return { status: response.status, body };
    },
  };
}

export async function proveTakoserverEvidenceCapability(
  client: TakoserverEvidenceClient,
): Promise<void> {
  // Positive identity must come from the same Worker before any authenticated
  // impossible-UID request.  Discovery and OpenAPI are public, so do not send
  // the evidence bearer token on either request.  The pinned transport shares
  // its bounded DNS/connect/response deadline and rejects redirects.
  const discoveryResponse = await client.request(
    TAKOSERVER_OWNER_DISCOVERY_PATH,
    { authenticated: false },
  );
  if (discoveryResponse.status !== 200) {
    throw new Error(
      `Takoserver owner discovery returned HTTP ${discoveryResponse.status}`,
    );
  }
  assertTakoserverOwnerDiscovery(discoveryResponse.body, client.origin);

  const openApiResponse = await client.request(TAKOSERVER_OPENAPI_PATH, {
    authenticated: false,
  });
  if (openApiResponse.status !== 200) {
    throw new Error(
      `Takoserver owner OpenAPI returned HTTP ${openApiResponse.status}`,
    );
  }
  assertTakoserverOwnerOpenApi(openApiResponse.body, client.origin);

  // This separate authenticated Takoserver Resource evidence endpoint is the
  // owner authority; Takosumi generic Run/event fields are never substituted.
  // The 0048 owner route authenticates before resource lookup.  This
  // auth-first negative request uses one impossible, canonical UID and accepts
  // only the exact closed `not_found` envelope; a 401, HTML 404, or generic
  // Run projection is not capability.
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const resourceUid = `e2e-capability-probe-${nonce}`;
  const space = `e2e-capability-${nonce}`;
  const name = `e2e-capability-${nonce}`;
  const resourcePrefix = `/v1/organizations/${encodeURIComponent(client.organizationId)}/resources/${encodeURIComponent(resourceUid)}`;
  const executionResponse = await client.request(
    `${resourcePrefix}/execution-evidence`,
  );
  assertTakoserverEvidenceCapabilityResponse(
    executionResponse.status,
    executionResponse.body,
  );
  const nativeResponse = await client.request(
    `${resourcePrefix}/native-residual?space=${encodeURIComponent(space)}&name=${encodeURIComponent(name)}`,
  );
  assertTakoserverNativeCapabilityResponse(
    nativeResponse.status,
    nativeResponse.body,
  );
}

async function readSecretFile(path: string, label: string): Promise<string> {
  return readPrivateFile(path, label, false);
}

/** Read one operator-private regular file without following a symlink. */
export async function readPrivateFile(
  path: string,
  label: string,
  allowMultiline: boolean,
  beforeRead?: () => void | Promise<void>,
): Promise<string> {
  if (!path.startsWith("/")) {
    throw new Error(`${label} file path must be absolute`);
  }
  const canonicalPath = await realpath(path).catch(() => undefined);
  if (!canonicalPath || canonicalPath !== path) {
    throw new Error(`${label} file path must be canonical and non-symlink`);
  }
  const ancestorIdentity = await inspectPrivatePathAncestors(
    canonicalPath,
    label,
  );
  const linkMetadata = await lstat(canonicalPath).catch(() => undefined);
  if (!linkMetadata?.isFile() || linkMetadata.isSymbolicLink()) {
    throw new Error(`${label} file must be a regular non-symlink file`);
  }
  assertPrivateFileMetadata(linkMetadata, label);
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  if (!handle) throw new Error(`${label} file is missing`);
  try {
    const before = await handle.stat();
    assertPrivateFileMetadata(before, label);
    if (!sameFileIdentity(linkMetadata, before)) {
      throw new Error(`${label} file changed before read`);
    }
    await beforeRead?.();
    const value = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    assertPrivateFileMetadata(after, label);
    if (!sameFileIdentity(before, after)) {
      throw new Error(`${label} file changed during read`);
    }
    const pathAfter = await lstat(canonicalPath).catch(() => undefined);
    if (!pathAfter || !sameFileIdentity(before, pathAfter)) {
      throw new Error(`${label} file path changed during read`);
    }
    const canonicalAfter = await realpath(canonicalPath).catch(() => undefined);
    if (canonicalAfter !== canonicalPath) {
      throw new Error(`${label} file path changed during read`);
    }
    await assertPrivatePathAncestorsStable(ancestorIdentity, label);
    const trimmed = value.trim();
    if (!trimmed || (!allowMultiline && /[\r\n]/u.test(trimmed))) {
      throw new Error(`${label} file was empty or multiline`);
    }
    return trimmed;
  } finally {
    await handle.close();
  }
}

/** Test-only seam for deterministic identity-race regression coverage. */
export async function readPrivateFileForTest(
  path: string,
  label: string,
  allowMultiline: boolean,
  beforeRead: () => void | Promise<void>,
): Promise<string> {
  return readPrivateFile(path, label, allowMultiline, beforeRead);
}

interface PrivatePathAncestorIdentity {
  readonly path: string;
  readonly metadata: Awaited<ReturnType<typeof lstat>>;
}

/**
 * Private credentials must not live in any source checkout, including a
 * linked Git worktree.  Do not use a product-specific prefix: an operator may
 * keep repos under any directory.  `lstat` deliberately does not follow a
 * `.git` file indirection, so both repository directories and worktree files
 * are treated as a source boundary.  The returned directory identities are
 * rechecked after reading the credential to close a marker/path replacement
 * race.
 */
async function inspectPrivatePathAncestors(
  canonicalPath: string,
  label: string,
): Promise<readonly PrivatePathAncestorIdentity[]> {
  const identities: PrivatePathAncestorIdentity[] = [];
  let current = dirname(canonicalPath);
  for (let depth = 0; depth < MAX_PRIVATE_PATH_ANCESTORS; depth += 1) {
    const metadata = await lstat(current).catch(() => undefined);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${label} file has an invalid parent directory`);
    }
    const gitMarker = await lstat(join(current, ".git")).catch(() => undefined);
    if (gitMarker || (await isBareGitRepositoryDirectory(current))) {
      throw new Error(
        `${label} file must be outside Git repositories and worktrees`,
      );
    }
    identities.push({ path: current, metadata });
    const parent = dirname(current);
    if (parent === current) return identities;
    current = parent;
  }
  throw new Error(
    `${label} file parent path exceeded the bounded ancestor limit`,
  );
}

async function assertPrivatePathAncestorsStable(
  identities: readonly PrivatePathAncestorIdentity[],
  label: string,
): Promise<void> {
  for (const identity of identities) {
    const current = await lstat(identity.path).catch(() => undefined);
    if (!current || !samePathIdentity(identity.metadata, current)) {
      throw new Error(`${label} file parent path changed during read`);
    }
    const gitMarker = await lstat(join(identity.path, ".git")).catch(
      () => undefined,
    );
    if (gitMarker || (await isBareGitRepositoryDirectory(identity.path))) {
      throw new Error(`${label} file Git boundary changed during read`);
    }
  }
}

/**
 * Bare repositories do not have a `.git` child. Require the bounded
 * HEAD/config/objects/refs layout plus a `[core] bare = true` declaration so
 * an ordinary operator directory with similarly named files is not rejected.
 */
async function isBareGitRepositoryDirectory(path: string): Promise<boolean> {
  const [head, config, objects, refs] = await Promise.all(
    ["HEAD", "config", "objects", "refs"].map((name) =>
      lstat(join(path, name)).catch(() => undefined),
    ),
  );
  if (
    !head?.isFile() ||
    head.isSymbolicLink() ||
    !config?.isFile() ||
    config.isSymbolicLink() ||
    !objects?.isDirectory() ||
    objects.isSymbolicLink() ||
    !refs?.isDirectory() ||
    refs.isSymbolicLink()
  ) {
    return false;
  }
  if (head.size > MAX_GIT_MARKER_BYTES || config.size > MAX_GIT_MARKER_BYTES) {
    return false;
  }
  const [headText, configText] = await Promise.all([
    readGitMarkerFile(join(path, "HEAD"), head),
    readGitMarkerFile(join(path, "config"), config),
  ]);
  if (!headText || !configText) return false;
  const headValue = headText.trim();
  if (
    !/^ref:\s+refs\/[A-Za-z0-9._/-]+$/u.test(headValue) &&
    !COMMIT_PATTERN.test(headValue)
  ) {
    return false;
  }
  let section = "";
  for (const line of configText.split(/\r?\n/u)) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.toLowerCase();
      continue;
    }
    if (
      section === "core" &&
      /^\s*bare\s*=\s*true\s*(?:[#;].*)?$/iu.test(line)
    ) {
      return true;
    }
  }
  return false;
}

async function readGitMarkerFile(
  path: string,
  metadata: Awaited<ReturnType<typeof lstat>>,
): Promise<string | undefined> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const before = await handle.stat();
    if (
      !sameFileIdentity(metadata, before) ||
      before.size > MAX_GIT_MARKER_BYTES
    )
      return undefined;
    const value = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)) return undefined;
    return value;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function assertPrivateFileMetadata(
  metadata: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} file must be a regular non-symlink file`);
  }
  if ((Number(metadata.mode) & 0o077) !== 0) {
    throw new Error(`${label} file must not be group/world accessible`);
  }
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`${label} file must be owned by the current user`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(`${label} file must have one hard link`);
  }
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return samePathIdentity(left, right);
}

function samePathIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readOrigin(value: string | undefined, label: string): string {
  const raw = boundedText(value, label, 512);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(`${label} must use HTTPS unless loopback`);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`${label} must be a bare origin without credentials`);
  return url.origin;
}

function readActorApId(value: string | undefined, label: string): string {
  const raw = boundedText(value, label, MAX_SOURCE_URL_BYTES);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute ActivityPub actor URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS unless loopback`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/" ||
    !url.pathname.startsWith("/ap/")
  ) {
    throw new Error(`${label} must be a credential-free /ap/ actor URL`);
  }
  return url.origin + url.pathname;
}

function readGitSourceUrl(value: string | undefined): string {
  const raw = boundedText(
    value,
    "TAKOSUMI_STAGING_SOURCE_URL",
    MAX_SOURCE_URL_BYTES,
  );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TAKOSUMI_STAGING_SOURCE_URL must be an absolute Git URL");
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "TAKOSUMI_STAGING_SOURCE_URL must be a credential-free HTTPS/SSH Git URL",
    );
  return raw;
}

function readRelativePath(value: string, label: string): string {
  const path = value.trim();
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  )
    throw new Error(`${label} must be a relative archive path without ..`);
  return path === "." ? "." : path.replace(/\/+$/u, "");
}

function readCapsuleName(value: string | undefined): string {
  const name =
    value?.trim() ||
    `yurucommu-e2e-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  if (!/^yurucommu-e2e-[a-z0-9]{8,64}$/u.test(name))
    throw new Error(
      "TAKOSUMI_STAGING_CAPSULE_NAME must use the yurucommu-e2e- prefix and a random suffix",
    );
  return name;
}

function boundedText(
  value: string | undefined,
  label: string,
  maxBytes: number,
): string {
  const text = value?.trim() ?? "";
  if (
    !text ||
    new TextEncoder().encode(text).byteLength > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(text)
  )
    throw new Error(`${label} is required and bounded`);
  return text;
}

function boundedTextValue(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return boundedText(value, label, maxBytes);
}

function requiredIdentifier(value: string | undefined, label: string): string {
  const text = boundedText(value, label, MAX_ID_BYTES);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(text))
    throw new Error(`${label} must be a bounded identifier`);
  return text;
}

function readWorkerVersionId(value: unknown, label: string): string {
  const versionId = boundedText(
    typeof value === "string" ? value : undefined,
    label,
    MAX_ID_BYTES,
  );
  if (!WORKER_VERSION_ID_PATTERN.test(versionId)) {
    throw new Error(
      `${label} must be the lowercase Takosumi Worker Version UUID`,
    );
  }
  return versionId;
}

function requiredCommit(value: unknown, label: string): string {
  const commit = boundedTextValue(value, label, 64);
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`${label} must be a 40-character Git commit`);
  }
  return commit;
}

function requiredDigest(value: unknown, label: string): string {
  const digest = boundedTextValue(value, label, 128);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return digest;
}

function assertExactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(keys)) {
    throw new Error(`${label} keys were not the closed contract`);
  }
}

function assertClosedKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  const missing = required.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  const unexpected = actual.filter((key) => !allowed.has(key));
  if (missing.length !== 0 || unexpected.length !== 0) {
    const detail = [
      ...(missing.length !== 0 ? [`missing ${missing.join(",")}`] : []),
      ...(unexpected.length !== 0
        ? [`unexpected ${unexpected.join(",")}`]
        : []),
    ].join("; ");
    throw new Error(`${label} keys were not the closed contract (${detail})`);
  }
}

function assertPlatformContainer(value: unknown, label: string): JsonRecord {
  const container = nestedRecord(value, label);
  assertExactKeys(
    container,
    ["hasActiveRollout", "health", "id", "image", "name", "state", "version"],
    label,
  );
  const health = nestedRecord(container.health, `${label}.health`);
  assertExactKeys(
    health,
    ["errorCount", "failed", "scheduling", "starting"],
    `${label}.health`,
  );
  if (
    ![
      health.errorCount,
      health.failed,
      health.scheduling,
      health.starting,
    ].every((count) => count === 0) ||
    container.hasActiveRollout !== false ||
    !["active", "ready"].includes(String(container.state)) ||
    typeof container.image !== "string" ||
    !/^registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner@sha256:[0-9a-f]{64}$/u.test(
      container.image,
    ) ||
    (typeof container.version !== "string" &&
      !Number.isSafeInteger(container.version))
  ) {
    throw new Error(`${label} was not exact healthy release evidence`);
  }
  requiredIdentifier(
    typeof container.id === "string" ? container.id : undefined,
    `${label}.id`,
  );
  boundedTextValue(container.name, `${label}.name`, 512);
  return container;
}

function optionalIdentifier(
  value: string | undefined,
  label: string,
): string | undefined {
  return value?.trim() ? requiredIdentifier(value, label) : undefined;
}

function requiredAbsolutePath(
  value: string | undefined,
  label: string,
): string {
  const path = boundedText(value, label, 4_096);
  if (!path.startsWith("/"))
    throw new Error(`${label} must be an absolute path`);
  return path;
}

function optionalAbsolutePath(
  value: string | undefined,
  label: string,
): string | undefined {
  return value?.trim() ? requiredAbsolutePath(value, label) : undefined;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/u.test(value.trim()))
    throw new Error(`${label} must be an integer`);
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${label} must be between ${min} and ${max}`);
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} was missing`);
  return value.trim();
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value))
    throw new Error(`${label} was not an integer`);
  return value as number;
}

function assertCanonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} was not a bounded canonical timestamp`);
  }
  return value;
}

function nestedRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} was not an object`);
  return value;
}

function assertRunSucceeded(value: JsonRecord, label: string): void {
  if (value.status !== "succeeded") throw new Error(`${label} did not succeed`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.main) await main();
