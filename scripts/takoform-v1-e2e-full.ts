import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  TAKOFORM_PROVIDER_PIN,
  TAKOFORM_PROVIDER_VERSION,
} from "./takoform-provider-pin.ts";

/** The exact Provider release this runner proves, taken from the module pin. */
export type TakoformProviderVersion = typeof TAKOFORM_PROVIDER_VERSION;
/** The exact `required_providers` constraint that release is pinned by. */
export type TakoformProviderConstraint = `= ${TakoformProviderVersion}`;
const TAKOFORM_PROVIDER_CONSTRAINT: TakoformProviderConstraint = `= ${TAKOFORM_PROVIDER_VERSION}`;

const PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";
const STABLE_DISCOVERY_PATH = "/.well-known/takoform/v1";
const STABLE_API_PATH = "/apis/forms.takoform.com/v1";
const HEALTH_PATH = "/healthz";
const READINESS_PATH = "/readyz";
const SOCIAL_SERVER_PATH = "/.well-known/social-server";
const NODEINFO_PATH = "/nodeinfo/2.0";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60 * 1_000;
const MIN_COMMAND_TIMEOUT_MS = 100;
const MAX_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const CHILD_TERM_GRACE_MS = 5_000;
const MAX_CHILD_OUTPUT_BYTES = 128 * 1024;
const MAX_PROVENANCE_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Provider schema JSON is substantially larger than ordinary child output. */
export const PROVIDER_SCHEMA_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const SOURCE_MODULE_FILES = [
  "main.tf",
  "outputs.tf",
  ".terraform.lock.hcl",
  "README.md",
] as const;
const SOURCE_COPIED_MODULE_FILES = ["main.tf", "outputs.tf"] as const;
const SOURCE_OPTIONAL_MODULE_FILES = [".terraform.lock.hcl"] as const;
const SOURCE_EXPECTED_UNUSED_ENTRIES = ["migrations", "e2e"] as const;
const GENERATED_WORKER_FILE = "yurucommu-worker.js";
const GENERATED_MIGRATIONS_DIR = "migrations";

/** The current Yurucommu Capsule graph. Keep this in lockstep with main.tf. */
export const CURRENT_RESOURCE_GRAPH = [
  {
    address: "takoform_module_worker.worker",
    type: "takoform_module_worker",
    outputKey: "worker",
  },
  {
    address: "takoform_sqlite_database.database",
    type: "takoform_sqlite_database",
    outputKey: "database",
  },
  {
    address: "takoform_sqlite_migration_set.schema",
    type: "takoform_sqlite_migration_set",
    outputKey: "migration_set",
  },
  {
    address: "takoform_sqlite_migration_application.schema",
    type: "takoform_sqlite_migration_application",
    outputKey: "migration_application",
  },
  {
    address: "takoform_edge_kv_namespace.kv",
    type: "takoform_edge_kv_namespace",
    outputKey: "kv",
  },
  {
    address: "takoform_edge_object_bucket.media",
    type: "takoform_edge_object_bucket",
    outputKey: "media",
  },
  {
    address: "takoform_at_least_once_queue.delivery",
    type: "takoform_at_least_once_queue",
    outputKey: "delivery",
  },
  {
    address: "takoform_at_least_once_queue.delivery_dlq",
    type: "takoform_at_least_once_queue",
    outputKey: "delivery_dlq",
  },
  {
    address: "takoform_worker_bundle.worker",
    type: "takoform_worker_bundle",
    outputKey: "worker_bundle",
  },
  {
    address: "takoform_worker_version.worker",
    type: "takoform_worker_version",
    outputKey: "worker_version",
  },
  {
    address: "takoform_worker_deployment.worker",
    type: "takoform_worker_deployment",
    outputKey: "worker_deployment",
  },
  {
    address: "takoform_worker_endpoint.worker",
    type: "takoform_worker_endpoint",
    outputKey: "worker_endpoint",
  },
  {
    address: "takoform_queue_consumer.delivery",
    type: "takoform_queue_consumer",
    outputKey: "delivery_consumer",
  },
  {
    address: "takoform_queue_consumer.delivery_dlq",
    type: "takoform_queue_consumer",
    outputKey: "delivery_dlq_consumer",
  },
  {
    address: "takoform_worker_cron_trigger.retention",
    type: "takoform_worker_cron_trigger",
    outputKey: "retention",
  },
] as const;

export const CURRENT_RESOURCE_TYPES = CURRENT_RESOURCE_GRAPH.map(
  (resource) => resource.type,
);
const CURRENT_RESOURCE_ID_KEYS = CURRENT_RESOURCE_GRAPH.map(
  (resource) => resource.outputKey,
);
const CURRENT_RESOURCE_COUNT = CURRENT_RESOURCE_GRAPH.length;

const REQUIRED_DISCOVERY_FEATURES = [
  "service_forms",
  "exact_form_ref",
  "optimistic_concurrency",
  "idempotent_lifecycle",
  "operations",
  "artifact_upload",
  "support_profiles",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

export interface TakoformV1E2EConfig {
  readonly endpoint: string;
  readonly space: string;
  /** Bearer credential used only by the Provider's mutation child. */
  readonly writerToken: string;
  /** Bearer credential used only for direct Host evidence readback. */
  readonly evidenceToken: string;
  readonly providerBinary: string;
  readonly providerSha256: string;
  readonly commandTimeoutMs: number;
  /**
   * Optional loopback runtime endpoint for a local Host whose assigned URL is
   * intentionally non-routable. It is diagnostic evidence, not endpoint proof.
   */
  readonly diagnosticRuntimeEndpoint?: string;
}

export interface LocalProviderAuthority {
  readonly providerBinary: string;
  readonly providerSha256: string;
}

export interface StableHostDiscovery {
  readonly apiBase: string;
  readonly endpoint: string;
  readonly apiVersions: readonly string[];
  readonly features: Readonly<Record<string, boolean>>;
}

export interface FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

export interface AppliedResourceIdentity {
  readonly address: string;
  readonly type: string;
  readonly name: string;
  readonly space: string;
  readonly uid: string;
  readonly generation: string;
  readonly form: FormRef;
}

export interface CleanupResult {
  readonly cleanupVerified: boolean;
  readonly preservedWorkdir: boolean;
  readonly error?: Error;
}

export interface SourceProvenance {
  readonly sourceHead: string;
  readonly workspaceDirty: boolean;
  readonly workspaceStateDigest: string;
  readonly module: Readonly<Record<string, string>>;
  readonly moduleFiles: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly worker: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly migrations: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly providerConstraint: TakoformProviderConstraint;
}

export interface ProviderSchemaProof {
  readonly source: string;
  readonly providerVersion: TakoformProviderVersion;
  readonly versionConstraint: TakoformProviderConstraint;
  readonly protocolSchemaVersion: number;
  readonly resourceKinds: readonly string[];
}

export interface BoundedChildResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export function readLocalProviderAuthority(
  environment: Environment,
): LocalProviderAuthority {
  const providerBinary = environment.TAKOFORM_PROVIDER_BINARY?.trim() ?? "";
  const providerSha256 = environment.TAKOFORM_PROVIDER_SHA256?.trim() ?? "";
  if (!providerBinary || !providerSha256) {
    throw new Error(
      "TAKOFORM_PROVIDER_BINARY and TAKOFORM_PROVIDER_SHA256 are required; unpublished Provider bytes are explicit E2E authority",
    );
  }
  if (!isAbsolute(providerBinary)) {
    throw new Error("TAKOFORM_PROVIDER_BINARY must be an absolute path");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(providerSha256)) {
    throw new Error(
      "TAKOFORM_PROVIDER_SHA256 must be canonical sha256:<lowercase hex>",
    );
  }
  return { providerBinary, providerSha256 };
}

export function readTakoformV1E2EConfig(
  environment: Environment,
): TakoformV1E2EConfig {
  const endpointInput = environment.TAKOFORM_ENDPOINT?.trim() ?? "";
  const space = environment.TAKOFORM_SPACE?.trim() ?? "";
  const writerToken = environment.TAKOFORM_TOKEN?.trim() ?? "";
  const evidenceToken = environment.TAKOFORM_EVIDENCE_TOKEN?.trim() ?? "";
  const diagnosticInput =
    environment.TAKOFORM_DIAGNOSTIC_RUNTIME_ENDPOINT?.trim() ?? "";
  const timeoutInput = environment.TAKOFORM_E2E_TIMEOUT_SECONDS?.trim() ?? "";
  if (!endpointInput || !space || !writerToken || !evidenceToken) {
    throw new Error(
      "TAKOFORM_ENDPOINT, TAKOFORM_SPACE, TAKOFORM_TOKEN, and TAKOFORM_EVIDENCE_TOKEN are required; the full lifecycle E2E never skips when Host authority is absent",
    );
  }
  if (writerToken === evidenceToken) {
    throw new Error(
      "TAKOFORM_TOKEN and TAKOFORM_EVIDENCE_TOKEN must be distinct credentials",
    );
  }
  const provider = readLocalProviderAuthority(environment);

  const commandTimeoutMs = parseCommandTimeout(timeoutInput);

  const endpointUrl = absoluteHttpUrl(endpointInput, "TAKOFORM_ENDPOINT");
  if (endpointUrl.pathname !== "/") {
    throw new Error(
      "TAKOFORM_ENDPOINT must be a bare origin; stable Host v1 discovery owns the /apis/forms.takoform.com/v1 path",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    endpointUrl.hostname,
  );
  if (endpointUrl.protocol !== "https:" && !loopback) {
    throw new Error("TAKOFORM_ENDPOINT must use HTTPS unless it is loopback");
  }

  let diagnosticRuntimeEndpoint: string | undefined;
  if (diagnosticInput) {
    const diagnostic = absoluteHttpUrl(
      diagnosticInput,
      "TAKOFORM_DIAGNOSTIC_RUNTIME_ENDPOINT",
    );
    if (!["localhost", "127.0.0.1", "[::1]"].includes(diagnostic.hostname)) {
      throw new Error(
        "TAKOFORM_DIAGNOSTIC_RUNTIME_ENDPOINT is test-only and must be loopback",
      );
    }
    diagnosticRuntimeEndpoint = diagnostic.toString().replace(/\/$/u, "");
  }

  return {
    endpoint: endpointUrl.origin,
    space,
    writerToken,
    evidenceToken,
    ...provider,
    commandTimeoutMs,
    ...(diagnosticRuntimeEndpoint ? { diagnosticRuntimeEndpoint } : {}),
  };
}

export async function prepareProviderDevOverride(
  config: LocalProviderAuthority,
  workdir: string,
): Promise<{
  readonly cliConfigPath: string;
  /** The digest-verified copy used for the version handshake. */
  readonly providerBinary: string;
}> {
  let metadata;
  try {
    metadata = await stat(config.providerBinary);
  } catch {
    throw new Error("TAKOFORM_PROVIDER_BINARY does not exist");
  }
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error("TAKOFORM_PROVIDER_BINARY must be an executable file");
  }
  const bytes = await readFile(config.providerBinary);
  const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  if (digest !== config.providerSha256) {
    throw new Error("Provider binary digest mismatch");
  }

  const providerDirectory = join(workdir, "provider-dev-override");
  await mkdir(providerDirectory, { recursive: true });
  const providerCopy = join(providerDirectory, "terraform-provider-takoform");
  await copyFile(config.providerBinary, providerCopy);
  await chmod(providerCopy, 0o755);
  const copiedDigest =
    "sha256:" +
    createHash("sha256")
      .update(await readFile(providerCopy))
      .digest("hex");
  if (copiedDigest !== config.providerSha256) {
    throw new Error("Copied Provider binary digest mismatch");
  }

  const cliConfigPath = join(workdir, "tofu.rc");
  await writeFile(
    cliConfigPath,
    `provider_installation {\n  dev_overrides {\n    "${PROVIDER_SOURCE}" = ${JSON.stringify(providerDirectory)}\n  }\n  direct {}\n}\n`,
    { mode: 0o600 },
  );
  return { cliConfigPath, providerBinary: providerCopy };
}

/** Build mutation commands without putting bearer credentials in argv. */
export function buildTofuCommand(
  phase: "apply" | "destroy",
  projectName: string,
): readonly string[] {
  if (!/^[a-z][a-z0-9-]{1,50}[a-z0-9]$/u.test(projectName)) {
    throw new Error("projectName is not a valid Takoform resource prefix");
  }
  return [
    phase,
    "-auto-approve",
    "-input=false",
    "-no-color",
    `-var=project_name=${projectName}`,
  ];
}

/**
 * Cleanup is deliberately independent from the primary probe result. Once an
 * apply was attempted, destroy and exact absence readback both run; a failed
 * destroy does not permit us to skip the readback or delete the recovery state.
 */
export async function cleanupTakoformV1E2E(options: {
  readonly mutationAttempted: boolean;
  readonly destroy: () => Promise<void>;
  readonly verifyAbsence: () => Promise<void>;
  readonly removeWorkdir: () => Promise<void>;
  readonly workdir: string;
}): Promise<CleanupResult> {
  if (!options.mutationAttempted) {
    try {
      await options.removeWorkdir();
      return { cleanupVerified: false, preservedWorkdir: false };
    } catch (error) {
      return {
        cleanupVerified: false,
        preservedWorkdir: true,
        error: new Error(
          `temporary E2E workdir cleanup failed; recovery state is preserved at ${options.workdir}`,
          { cause: error },
        ),
      };
    }
  }

  const errors: unknown[] = [];
  try {
    await options.destroy();
  } catch (error) {
    errors.push(error);
  }
  try {
    await options.verifyAbsence();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    return {
      cleanupVerified: false,
      preservedWorkdir: true,
      error: new AggregateError(
        errors,
        `E2E cleanup failed; recovery state is preserved at ${options.workdir}`,
      ),
    };
  }

  try {
    await options.removeWorkdir();
  } catch (error) {
    return {
      cleanupVerified: false,
      preservedWorkdir: true,
      error: new Error(
        `temporary E2E workdir cleanup failed; recovery state is preserved at ${options.workdir}`,
        { cause: error },
      ),
    };
  }
  return { cleanupVerified: true, preservedWorkdir: false };
}

/** Validate and normalize a stable-v1 discovery response. */
export function parseStableHostDiscovery(
  endpoint: string,
  value: unknown,
): StableHostDiscovery {
  if (!isRecord(value))
    throw new Error("Host discovery response was not an object");
  const apiVersions = value.api_versions;
  if (
    !Array.isArray(apiVersions) ||
    apiVersions.length !== 1 ||
    apiVersions[0] !== "forms.takoform.com/v1"
  ) {
    throw new Error("Host discovery did not advertise forms.takoform.com/v1");
  }
  const features = value.features;
  if (!isRecord(features)) throw new Error("Host discovery omitted features");
  const normalizedFeatures: Record<string, boolean> = {};
  for (const feature of REQUIRED_DISCOVERY_FEATURES) {
    if (features[feature] !== true) {
      throw new Error(`Host discovery does not advertise features.${feature}`);
    }
    normalizedFeatures[feature] = true;
  }
  const endpoints = value.endpoints;
  if (!isRecord(endpoints) || typeof endpoints.api !== "string") {
    throw new Error("Host discovery omitted endpoints.api");
  }
  const configured = new URL(endpoint);
  const advertised = absoluteHttpUrl(
    endpoints.api,
    "Host discovery endpoints.api",
  );
  if (
    advertised.origin !== configured.origin ||
    advertised.pathname !== STABLE_API_PATH
  ) {
    throw new Error(
      "Host discovery endpoints.api must be same-origin and use /apis/forms.takoform.com/v1",
    );
  }
  if (advertised.pathname.includes("%")) {
    throw new Error(
      "Host discovery endpoints.api must not percent-encode its path",
    );
  }
  return {
    endpoint: configured.origin,
    apiBase: advertised.toString().replace(/\/$/u, ""),
    apiVersions: [apiVersions[0]],
    features: normalizedFeatures,
  };
}

/** Build the stable-v1 exact FormRef GET URL used for readback and absence. */
export function buildResourceReadUrl(
  apiBase: string,
  resource: Pick<AppliedResourceIdentity, "name" | "space" | "form">,
): string {
  const group = resource.form.apiVersion;
  if (group.includes("/")) {
    throw new Error("stable-v1 Form group must be versionless");
  }
  const url = new URL(
    `${apiBase.replace(/\/$/u, "")}/resources/${encodeURIComponent(group)}/${encodeURIComponent(resource.form.kind)}/${encodeURIComponent(resource.name)}`,
  );
  url.search = new URLSearchParams({
    space: resource.space,
    group: resource.form.apiVersion,
    kind: resource.form.kind,
    definitionVersion: resource.form.definitionVersion,
    schemaDigest: resource.form.schemaDigest,
  }).toString();
  return url.toString();
}

/** Fail closed on anything other than the stable Host's exact absence code. */
export async function assertAuthoritativeAbsence(
  response: Response,
  label: string,
): Promise<void> {
  if (response.status !== 404) {
    await response.body?.cancel();
    throw new Error(
      `${label} still exists or returned HTTP ${response.status}`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} absence response was not a JSON error envelope`);
  }
  if (
    !isRecord(body) ||
    !isRecord(body.error) ||
    body.error.code !== "resource_not_found"
  ) {
    throw new Error(`${label} absence response was not resource_not_found`);
  }
}

/** Extract all managed resource identities from `tofu show -json`. */
export function extractAppliedResourceIdentities(
  state: unknown,
  fallbackSpace?: string,
): readonly AppliedResourceIdentity[] {
  const resources: Array<{
    readonly type: string;
    readonly address: string;
    readonly values: Record<string, unknown>;
  }> = [];
  const visitModule = (module: unknown): void => {
    if (!isRecord(module)) return;
    if (Array.isArray(module.resources)) {
      for (const candidate of module.resources) {
        if (!isRecord(candidate) || candidate.mode === "data") continue;
        if (!isRecord(candidate.values)) continue;
        if (
          typeof candidate.type !== "string" ||
          typeof candidate.address !== "string"
        )
          continue;
        resources.push({
          type: candidate.type,
          address: candidate.address,
          values: candidate.values,
        });
      }
    }
    if (Array.isArray(module.child_modules)) {
      for (const child of module.child_modules) visitModule(child);
    }
  };
  if (
    isRecord(state) &&
    isRecord(state.values) &&
    isRecord(state.values.root_module)
  ) {
    visitModule(state.values.root_module);
  } else {
    visitModule(state);
  }

  const expected = CURRENT_RESOURCE_GRAPH.map(
    (resource) => `${resource.address}\0${resource.type}`,
  ).sort();
  const actual = resources
    .map((resource) => `${resource.address}\0${resource.type}`)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `tofu state did not contain the current ${CURRENT_RESOURCE_COUNT}-resource graph (got ${actual.join(",") || "none"})`,
    );
  }

  return resources.map((resource) => {
    const value = resource.values;
    const space = stringValue(value.space) || fallbackSpace || "";
    return {
      address: resource.address,
      type: resource.type,
      name: requireString(value.name, `${resource.address}.name`),
      space: requireString(space, `${resource.address}.space`),
      uid: requireString(value.uid, `${resource.address}.uid`),
      generation: requireString(
        value.generation,
        `${resource.address}.generation`,
      ),
      form: {
        apiVersion: requireString(
          value.form_api_version,
          `${resource.address}.form_api_version`,
        ),
        kind: requireString(value.form_kind, `${resource.address}.form_kind`),
        definitionVersion: requireString(
          value.form_definition_version,
          `${resource.address}.form_definition_version`,
        ),
        schemaDigest: requireString(
          value.form_schema_digest,
          `${resource.address}.form_schema_digest`,
        ),
      },
    } satisfies AppliedResourceIdentity;
  });
}

export function assertCurrentResourceOutputIds(
  value: unknown,
  identities?: readonly AppliedResourceIdentity[],
): void {
  if (!isRecord(value))
    throw new Error("takoform_resource_ids output was not an object");
  const actual = Object.keys(value).sort();
  const expected = [...CURRENT_RESOURCE_ID_KEYS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `takoform_resource_ids output did not contain all ${CURRENT_RESOURCE_COUNT} current resources`,
    );
  }
  for (const key of CURRENT_RESOURCE_ID_KEYS) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`takoform_resource_ids.${key} was not a non-empty UID`);
    }
  }
  if (!identities) return;
  for (const key of CURRENT_RESOURCE_ID_KEYS) {
    const matches = identities.filter((identity) =>
      outputResourceKeyMatches(key, identity),
    );
    if (matches.length !== 1) {
      throw new Error(
        `takoform_resource_ids.${key} did not map to one state resource`,
      );
    }
    if (value[key] !== matches[0]!.uid) {
      throw new Error(
        `takoform_resource_ids.${key} did not match the state UID`,
      );
    }
  }
}

function outputResourceKeyMatches(
  key: (typeof CURRENT_RESOURCE_ID_KEYS)[number],
  identity: AppliedResourceIdentity,
): boolean {
  const resource = CURRENT_RESOURCE_GRAPH.find(
    (candidate) => candidate.outputKey === key,
  );
  return (
    resource?.address === identity.address && resource.type === identity.type
  );
}

export function assertReadyResource(body: unknown, label: string): void {
  if (!isRecord(body) || !isRecord(body.metadata) || !isRecord(body.status)) {
    throw new Error(`${label} response omitted metadata or status`);
  }
  const conditions = body.status.conditions;
  if (
    !Array.isArray(conditions) ||
    !conditions.some(
      (condition) =>
        isRecord(condition) &&
        condition.type === "Ready" &&
        condition.status === "True",
    )
  ) {
    throw new Error(`${label} did not report a Ready=True condition`);
  }
}

export function assertResourceIdentity(
  body: unknown,
  identity: AppliedResourceIdentity,
): void {
  if (!isRecord(body) || !isRecord(body.metadata) || !isRecord(body.form)) {
    throw new Error(
      `${identity.address} response omitted exact identity fields`,
    );
  }
  const formRef = body.form.formRef;
  if (
    body.apiVersion !== identity.form.apiVersion ||
    body.kind !== identity.form.kind ||
    !isRecord(formRef) ||
    formRef.apiVersion !== identity.form.apiVersion ||
    formRef.kind !== identity.form.kind ||
    formRef.definitionVersion !== identity.form.definitionVersion ||
    formRef.schemaDigest !== identity.form.schemaDigest ||
    body.metadata.name !== identity.name ||
    body.metadata.space !== identity.space ||
    body.metadata.uid !== identity.uid ||
    body.metadata.generation !== identity.generation
  ) {
    throw new Error(`${identity.address} readback changed the exact identity`);
  }
}

export async function collectSourceProvenance(
  repositoryRoot: string,
  sourceRoot: string,
  environment: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<SourceProvenance> {
  const sourceHead = (
    await runGitCapture(
      repositoryRoot,
      ["rev-parse", "HEAD"],
      environment,
      timeoutMs,
    )
  ).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(sourceHead)) {
    throw new Error("source HEAD was not a canonical Git commit");
  }
  const status = await runGitCapture(
    repositoryRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    environment,
    timeoutMs,
  );
  const diff = await runGitCapture(
    repositoryRoot,
    ["diff", "--binary", "--no-ext-diff"],
    environment,
    timeoutMs,
  );
  const stagedDiff = await runGitCapture(
    repositoryRoot,
    ["diff", "--cached", "--binary", "--no-ext-diff"],
    environment,
    timeoutMs,
  );
  const untracked = await runGitCapture(
    repositoryRoot,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    environment,
    timeoutMs,
  );
  const workspaceHasher = createHash("sha256");
  workspaceHasher.update(status);
  workspaceHasher.update("\0");
  workspaceHasher.update(diff);
  workspaceHasher.update("\0");
  workspaceHasher.update(stagedDiff);
  workspaceHasher.update("\0");
  const untrackedPaths = untracked.split("\0").filter(Boolean).sort();
  for (const path of untrackedPaths) {
    const absolute = resolve(repositoryRoot, path);
    if (relative(repositoryRoot, absolute).startsWith("..")) {
      throw new Error("Git returned an untracked path outside the repository");
    }
    const metadata = await lstat(absolute);
    workspaceHasher.update(path);
    workspaceHasher.update("\0");
    if (metadata.isSymbolicLink()) {
      workspaceHasher.update(`symlink:${await readlink(absolute)}`);
    } else if (metadata.isFile()) {
      workspaceHasher.update(await readFile(absolute));
    } else {
      throw new Error(`untracked path is not a regular file: ${path}`);
    }
    workspaceHasher.update("\0");
  }

  const module: Record<string, string> = {};
  const moduleFiles: Array<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }> = [];
  for (const path of [
    ...SOURCE_COPIED_MODULE_FILES,
    ...SOURCE_OPTIONAL_MODULE_FILES,
  ]) {
    const sourcePath = join(sourceRoot, path);
    if (!(await pathExists(sourcePath))) {
      if ((SOURCE_OPTIONAL_MODULE_FILES as readonly string[]).includes(path)) {
        continue;
      }
      throw new Error(`Takoform module ${path} is missing`);
    }
    await assertRegularFile(sourcePath, `Takoform module ${path}`);
    const bytes = await readFile(sourcePath);
    const sha256 = digestBytes(bytes);
    module[path] = sha256;
    moduleFiles.push({ path, bytes: bytes.byteLength, sha256 });
  }
  const mainText = await readFile(join(sourceRoot, "main.tf"), "utf8");
  if (!mainText.includes(TAKOFORM_PROVIDER_PIN)) {
    throw new Error(
      `Takoform module no longer pins Provider ${TAKOFORM_PROVIDER_VERSION} exactly`,
    );
  }
  const workerPath = join(sourceRoot, ".generated", GENERATED_WORKER_FILE);
  await assertRegularFile(workerPath, "generated Yurucommu Worker");
  const workerBytes = await readFile(workerPath);
  const migrationRoot = join(
    sourceRoot,
    ".generated",
    GENERATED_MIGRATIONS_DIR,
  );
  const migrationEntries = (
    await readdir(migrationRoot, { withFileTypes: true })
  )
    .map((entry) => entry.name)
    .sort();
  const migrations = [];
  for (const name of migrationEntries) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/u.test(name)) {
      throw new Error(`unexpected generated migration entry: ${name}`);
    }
    const migrationPath = join(migrationRoot, name);
    await assertRegularFile(migrationPath, `generated migration ${name}`);
    const bytes = await readFile(migrationPath);
    migrations.push({
      path: `${GENERATED_MIGRATIONS_DIR}/${name}`,
      bytes: bytes.byteLength,
      sha256: digestBytes(bytes),
    });
  }
  if (migrations.length === 0)
    throw new Error("source migration inventory is empty");
  return {
    sourceHead,
    workspaceDirty: status.trim().length > 0,
    workspaceStateDigest: `sha256:${workspaceHasher.digest("hex")}`,
    module,
    moduleFiles,
    worker: {
      path: `.generated/${GENERATED_WORKER_FILE}`,
      bytes: workerBytes.byteLength,
      sha256: digestBytes(workerBytes),
    },
    migrations,
    providerConstraint: TAKOFORM_PROVIDER_CONSTRAINT,
  };
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function main(): Promise<void> {
  const config = readTakoformV1E2EConfig(process.env);
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const sourceRoot = join(repositoryRoot, "deploy", "takoform");
  const workdir = await mkdtemp(join(tmpdir(), "yurucommu-takoform-v1-"));
  const projectName = `yurucommu-e2e-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const toolEnvironment = buildSafeChildEnvironment(process.env);
  const tofuEnvironment = createTofuEnvironment(config, workdir);
  const removeSignalHandlers = installLifecycleSignalHandlers();
  let mutationAttempted = false;
  let primaryError: unknown;
  let identities: readonly AppliedResourceIdentity[] = [];
  let hostDiscovery: StableHostDiscovery | undefined;
  let sourceProvenance: SourceProvenance | undefined;
  let providerSchemaProof: ProviderSchemaProof | undefined;
  let verifiedProviderBinary = "";
  let launchUrl = "";
  let apiUrl = "";
  let probes: Record<string, unknown> = {};

  try {
    try {
      await runCommand(
        ["bun", "run", "build:worker"],
        repositoryRoot,
        toolEnvironment,
        config.commandTimeoutMs,
      );
      await runCommand(
        ["bun", "scripts/prepare-takoform-v1-source.ts"],
        repositoryRoot,
        toolEnvironment,
        config.commandTimeoutMs,
      );
      sourceProvenance = await collectSourceProvenance(
        repositoryRoot,
        sourceRoot,
        toolEnvironment,
        config.commandTimeoutMs,
      );
      await copyCapsuleToWorkdir(sourceRoot, workdir, {
        repositoryRoot,
        environment: toolEnvironment,
        timeoutMs: config.commandTimeoutMs,
      });

      const providerOverride = await prepareProviderDevOverride(
        config,
        workdir,
      );
      verifiedProviderBinary = providerOverride.providerBinary;
      tofuEnvironment.TF_CLI_CONFIG_FILE = providerOverride.cliConfigPath;
      const providerVersion = await readProviderVersion(
        providerOverride.providerBinary,
        toolEnvironment,
        workdir,
        config.commandTimeoutMs,
      );
      providerSchemaProof = await readProviderSchemaProof(
        workdir,
        tofuEnvironment,
        config.commandTimeoutMs,
        providerVersion,
      );

      mutationAttempted = true;
      await runTofu(buildTofuCommand("apply", projectName), {
        workdir,
        environment: tofuEnvironment,
        timeoutMs: config.commandTimeoutMs,
      });

      const outputs = parseTofuJson(
        await runTofu(["output", "-json"], {
          workdir,
          environment: tofuEnvironment,
          captureStdout: true,
          timeoutMs: config.commandTimeoutMs,
        }),
        "tofu output",
      );
      launchUrl = outputString(outputs, "launch_url");
      apiUrl = outputString(outputs, "api_url");
      assertWorkerEndpointUrl(launchUrl);
      assertApiOutput(apiUrl, launchUrl);
      const outputResourceIds = outputValue(outputs, "takoform_resource_ids");

      identities = extractAppliedResourceIdentities(
        parseTofuJson(
          await runTofu(["show", "-json"], {
            workdir,
            environment: tofuEnvironment,
            captureStdout: true,
            timeoutMs: config.commandTimeoutMs,
          }),
          "tofu show",
        ),
        config.space,
      );
      assertCurrentResourceOutputIds(outputResourceIds, identities);

      hostDiscovery = await discoverStableHost(config);
      const hostResources = await readAppliedResources(
        hostDiscovery,
        config,
        identities,
      );
      requireReadyType(
        hostResources,
        "takoform_sqlite_migration_application",
        "SQLite migration application",
        identities,
      );
      requireReadyType(
        hostResources,
        "takoform_queue_consumer",
        "queue consumer",
        identities,
      );
      requireReadyType(
        hostResources,
        "takoform_worker_cron_trigger",
        "cron trigger",
        identities,
      );
      requireReadyType(
        hostResources,
        "takoform_worker_version",
        "WorkerVersion",
        identities,
      );

      // MEDIA is a Form in this graph now, so its evidence is the bucket's own
      // Ready=True readback. Asking the Host whether it can satisfy a
      // com.amazonaws.s3 standard service would prove something the module no
      // longer requests, and would fail a Host that implements every Form here.
      requireReadyType(
        hostResources,
        "takoform_edge_object_bucket",
        "object bucket",
        identities,
      );
      const runtimeBase = config.diagnosticRuntimeEndpoint ?? launchUrl;
      probes = {
        hostResourceReadback: {
          count: hostResources.length,
          ready: hostResources.length,
          graph: `Provider ${TAKOFORM_PROVIDER_VERSION}/current-${CURRENT_RESOURCE_COUNT}-resources`,
        },
        migrationBackedHealth: await probeRuntime(runtimeBase),
        objectBucket: "Ready=True resource evidence",
        nativeHandlers: {
          queueConsumer: "Ready=True resource evidence",
          cronTrigger: "Ready=True resource evidence",
          invocationCounters: "not exposed by portable Host API v1",
        },
      };
    } catch (error) {
      primaryError = error;
    }
    if (!primaryError && terminationRequest) primaryError = terminationRequest;

    const cleanup = await cleanupTakoformV1E2E({
      mutationAttempted,
      destroy: async () => {
        await runTofu(buildTofuCommand("destroy", projectName), {
          workdir,
          environment: tofuEnvironment,
          timeoutMs: config.commandTimeoutMs,
          allowAfterTermination: true,
        });
      },
      verifyAbsence: async () => {
        if (!hostDiscovery) {
          throw new Error(
            "cannot verify authoritative absence without stable Host discovery",
          );
        }
        if (identities.length !== CURRENT_RESOURCE_TYPES.length) {
          throw new Error(
            `cannot verify authoritative absence without all ${CURRENT_RESOURCE_COUNT} applied identities`,
          );
        }
        await verifyResourceAbsence(hostDiscovery, config, identities);
      },
      removeWorkdir: () => rm(workdir, { recursive: true, force: true }),
      workdir,
    });

    // A signal can arrive while destroy, absence readback, or workdir removal
    // is in progress. Re-check after all recovery work and before reporting a
    // passing lifecycle, otherwise that late request could false-green.
    if (!primaryError && terminationRequest) primaryError = terminationRequest;

    if (primaryError && cleanup.error) {
      throw new AggregateError(
        [primaryError, cleanup.error],
        "full lifecycle E2E and cleanup both failed",
      );
    }
    if (primaryError) throw primaryError;
    if (cleanup.error) throw cleanup.error;
    if (!cleanup.cleanupVerified)
      throw new Error("full lifecycle E2E did not verify cleanup");

    console.log(
      JSON.stringify({
        kind: "yurucommu.takoform-v1-e2e@v3",
        status: "passed",
        phase: "full-lifecycle",
        runId: projectName,
        provider: {
          source: PROVIDER_SOURCE,
          sha256: config.providerSha256,
          verifiedBinary: verifiedProviderBinary,
          ...providerSchemaProof,
        },
        source: sourceProvenance,
        host: {
          discoveryPath: STABLE_DISCOVERY_PATH,
          apiVersion: "forms.takoform.com/v1",
          endpoint: hostDiscovery?.endpoint,
          apiBase: hostDiscovery?.apiBase,
          apiVersions: hostDiscovery?.apiVersions,
          features: hostDiscovery?.features,
        },
        projectName,
        launchUrl,
        apiUrl,
        resourceCount: identities.length,
        runtimeEndpointClassification: config.diagnosticRuntimeEndpoint
          ? "test-only-loopback-diagnostic"
          : "assigned-worker-endpoint",
        probes,
        cleanupVerified: cleanup.cleanupVerified,
        authoritativeAbsenceVerified: true,
      }),
    );
  } finally {
    removeSignalHandlers();
  }
}

export async function copyCapsuleToWorkdir(
  sourceRoot: string,
  workdir: string,
  options: {
    readonly repositoryRoot?: string;
    readonly timeoutMs?: number;
    readonly environment?: Record<string, string | undefined>;
  } = {},
): Promise<void> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const allowedRootEntries = new Set([
    ...SOURCE_MODULE_FILES,
    ...SOURCE_EXPECTED_UNUSED_ENTRIES,
    ".generated",
  ]);
  for (const entry of entries) {
    if (!allowedRootEntries.has(entry.name)) {
      throw new Error(`unexpected Takoform module source entry: ${entry.name}`);
    }
    if (entry.name === ".generated") continue;
    const entryPath = join(sourceRoot, entry.name);
    if (
      (SOURCE_EXPECTED_UNUSED_ENTRIES as readonly string[]).includes(entry.name)
    ) {
      await assertRegularDirectory(entryPath, `Takoform source ${entry.name}`);
    } else {
      await assertRegularFile(entryPath, `Takoform module ${entry.name}`);
    }
  }
  for (const relativePath of SOURCE_COPIED_MODULE_FILES) {
    const sourcePath = join(sourceRoot, relativePath);
    await assertRegularFile(sourcePath, `Takoform module ${relativePath}`);
    if (options.repositoryRoot) {
      await assertTrackedSourcePath(
        options.repositoryRoot,
        join("deploy", "takoform", relativePath),
        options.environment ?? buildSafeChildEnvironment(process.env),
        options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      );
    }
    await copyFile(sourcePath, join(workdir, relativePath));
  }
  for (const relativePath of SOURCE_OPTIONAL_MODULE_FILES) {
    const sourcePath = join(sourceRoot, relativePath);
    if (!(await pathExists(sourcePath))) continue;
    await assertRegularFile(sourcePath, `Takoform module ${relativePath}`);
    if (options.repositoryRoot) {
      await assertTrackedSourcePath(
        options.repositoryRoot,
        join("deploy", "takoform", relativePath),
        options.environment ?? buildSafeChildEnvironment(process.env),
        options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      );
    }
    await copyFile(sourcePath, join(workdir, relativePath));
  }

  const generatedRoot = join(sourceRoot, ".generated");
  const generatedRootMetadata = await lstat(generatedRoot);
  if (
    generatedRootMetadata.isSymbolicLink() ||
    !generatedRootMetadata.isDirectory()
  ) {
    throw new Error("Takoform .generated must be a regular directory");
  }
  const generatedEntries = await readdir(generatedRoot, {
    withFileTypes: true,
  });
  const allowedGeneratedEntries = new Set([
    GENERATED_WORKER_FILE,
    GENERATED_MIGRATIONS_DIR,
  ]);
  for (const entry of generatedEntries) {
    if (!allowedGeneratedEntries.has(entry.name)) {
      throw new Error(
        `unexpected generated Takoform source entry: ${entry.name}`,
      );
    }
  }
  const generatedWorker = join(generatedRoot, GENERATED_WORKER_FILE);
  await assertRegularFile(generatedWorker, "generated Yurucommu Worker");
  await mkdir(join(workdir, ".generated", GENERATED_MIGRATIONS_DIR), {
    recursive: true,
  });
  await copyFile(
    generatedWorker,
    join(workdir, ".generated", GENERATED_WORKER_FILE),
  );

  const migrationsRoot = join(generatedRoot, GENERATED_MIGRATIONS_DIR);
  const migrationsMetadata = await lstat(migrationsRoot);
  if (
    migrationsMetadata.isSymbolicLink() ||
    !migrationsMetadata.isDirectory()
  ) {
    throw new Error("generated migration source must be a regular directory");
  }
  const migrationEntries = await readdir(migrationsRoot, {
    withFileTypes: true,
  });
  if (migrationEntries.length === 0) {
    throw new Error("generated migration source is empty");
  }
  for (const entry of migrationEntries) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/u.test(entry.name)) {
      throw new Error(`unexpected generated migration entry: ${entry.name}`);
    }
    const sourcePath = join(migrationsRoot, entry.name);
    await assertRegularFile(sourcePath, `generated migration ${entry.name}`);
    await copyFile(
      sourcePath,
      join(workdir, ".generated", GENERATED_MIGRATIONS_DIR, entry.name),
    );
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
}

async function assertRegularDirectory(
  path: string,
  label: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function buildSafeChildEnvironment(
  environment: Environment,
  config?: Pick<TakoformV1E2EConfig, "endpoint" | "space" | "writerToken">,
  workdir?: string,
): Record<string, string | undefined> {
  const safeNames = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  const safe = Object.fromEntries(
    safeNames
      .filter((name) => typeof environment[name] === "string")
      .map((name) => [name, environment[name]]),
  ) as Record<string, string | undefined>;
  if (!safe.PATH) safe.PATH = "/usr/local/bin:/usr/bin:/bin";
  if (!safe.HOME) safe.HOME = tmpdir();
  if (config) {
    safe.TAKOFORM_ENDPOINT = config.endpoint;
    safe.TAKOFORM_SPACE = config.space;
    safe.TAKOFORM_TOKEN = config.writerToken;
  }
  if (workdir) safe.TF_DATA_DIR = join(workdir, ".tofu-data");
  safe.TF_IN_AUTOMATION = "1";
  safe.CHECKPOINT_DISABLE = "1";
  return safe;
}

function createTofuEnvironment(
  config: TakoformV1E2EConfig,
  workdir: string,
): Record<string, string | undefined> {
  return {
    ...buildSafeChildEnvironment(process.env, config, workdir),
    TAKOFORM_ENDPOINT: config.endpoint,
    TAKOFORM_SPACE: config.space,
    TAKOFORM_TOKEN: config.writerToken,
  };
}

async function discoverStableHost(
  config: TakoformV1E2EConfig,
): Promise<StableHostDiscovery> {
  const response = await fetch(
    new URL(STABLE_DISCOVERY_PATH, config.endpoint),
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.evidenceToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const body = await responseJson(response, "stable Host discovery", 200);
  return parseStableHostDiscovery(config.endpoint, body);
}

async function readProviderSchemaProof(
  workdir: string,
  environment: Record<string, string | undefined>,
  timeoutMs: number,
  providerVersion: TakoformProviderVersion,
): Promise<ProviderSchemaProof> {
  const raw = await runTofu(["providers", "schema", "-json"], {
    workdir,
    environment,
    captureStdout: true,
    timeoutMs,
    maxOutputBytes: PROVIDER_SCHEMA_OUTPUT_MAX_BYTES,
    outputLimitMessage: `provider schema exceeded ${PROVIDER_SCHEMA_OUTPUT_MAX_BYTES} byte capture limit`,
  });
  return parseProviderSchemaProof(
    parseTofuJson(raw, "provider schema"),
    providerVersion,
  );
}

export function parseProviderSchemaProof(
  parsed: unknown,
  providerVersion: TakoformProviderVersion,
): ProviderSchemaProof {
  if (!isRecord(parsed)) throw new Error("provider schema was not an object");
  const schemas = parsed.provider_schemas;
  if (!isRecord(schemas))
    throw new Error("provider schema omitted provider_schemas");
  const matches = Object.entries(schemas).filter(([source]) =>
    source.endsWith("/tako0614/takoform"),
  );
  if (matches.length !== 1) {
    throw new Error(
      "provider schema did not identify exactly one Takoform provider",
    );
  }
  const [source, schema] = matches[0]!;
  if (!isRecord(schema) || !isRecord(schema.resource_schemas)) {
    throw new Error("provider schema omitted resource_schemas");
  }
  const resourceKinds = Object.keys(schema.resource_schemas).sort();
  const expectedKinds = [...new Set(CURRENT_RESOURCE_TYPES)];
  const missing = expectedKinds.filter((kind) => !resourceKinds.includes(kind));
  if (missing.length > 0) {
    throw new Error(
      `provider schema omitted current resource kinds: ${missing.join(",")}`,
    );
  }
  const protocolSchemaVersion =
    typeof schema.version === "number" ? schema.version : 0;
  return {
    source,
    providerVersion,
    versionConstraint: TAKOFORM_PROVIDER_CONSTRAINT,
    protocolSchemaVersion,
    resourceKinds,
  };
}

export async function readProviderVersion(
  providerBinary: string,
  environment: Record<string, string | undefined>,
  cwd: string,
  timeoutMs: number,
): Promise<TakoformProviderVersion> {
  const result = await runBoundedChild([providerBinary, "-version"], {
    cwd,
    environment,
    timeoutMs,
    label: "Takoform Provider version handshake",
  });
  if (result.timedOut || result.outputTruncated || result.exitCode !== 0) {
    throw new Error("Takoform Provider version handshake failed");
  }
  if (result.stdout.trim() !== TAKOFORM_PROVIDER_VERSION) {
    throw new Error(
      `Takoform Provider binary did not report version ${TAKOFORM_PROVIDER_VERSION}`,
    );
  }
  return TAKOFORM_PROVIDER_VERSION;
}

async function readAppliedResources(
  discovery: StableHostDiscovery,
  config: TakoformV1E2EConfig,
  identities: readonly AppliedResourceIdentity[],
): Promise<readonly Record<string, unknown>[]> {
  const resources: Record<string, unknown>[] = [];
  for (const identity of identities) {
    const response = await fetch(
      buildResourceReadUrl(discovery.apiBase, identity),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.evidenceToken}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const body = await responseJson(
      response,
      `${identity.address} readback`,
      200,
    );
    if (!isRecord(body)) {
      throw new Error(`${identity.address} readback was not an object`);
    }
    assertResourceIdentity(body, identity);
    assertReadyResource(body, identity.address);
    resources.push(body);
  }
  return resources;
}

async function verifyResourceAbsence(
  discovery: StableHostDiscovery,
  config: TakoformV1E2EConfig,
  identities: readonly AppliedResourceIdentity[],
): Promise<void> {
  for (const identity of identities) {
    const response = await fetch(
      buildResourceReadUrl(discovery.apiBase, identity),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.evidenceToken}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    await assertAuthoritativeAbsence(response, identity.address);
  }
}

async function probeRuntime(
  runtimeBase: string,
): Promise<Record<string, unknown>> {
  const base = absoluteHttpUrl(runtimeBase, "runtime endpoint");
  const health = await runtimeJson(base, HEALTH_PATH, "healthz");
  if (
    !isRecord(health) ||
    health.service !== "yurucommu" ||
    health.status !== "ok" ||
    !Array.isArray(health.missingBindings) ||
    health.missingBindings.length !== 0
  ) {
    throw new Error(
      "Yurucommu /healthz did not report all runtime bindings ready",
    );
  }
  const ready = await runtimeJson(base, READINESS_PATH, "readyz");
  if (
    !isRecord(ready) ||
    ready.status !== "ok" ||
    !Array.isArray(ready.missingBindings)
  ) {
    throw new Error("Yurucommu /readyz did not report readiness");
  }
  const social = await runtimeJson(
    base,
    SOCIAL_SERVER_PATH,
    "social-server discovery",
  );
  if (
    !isRecord(social) ||
    social.product !== "yurucommu" ||
    !isRecord(social.server) ||
    typeof social.server.canonicalOrigin !== "string"
  ) {
    throw new Error("Yurucommu social-server discovery was incomplete");
  }
  const nodeinfo = await runtimeJson(
    base,
    NODEINFO_PATH,
    "migration-backed NodeInfo",
  );
  if (
    !isRecord(nodeinfo) ||
    !isRecord(nodeinfo.software) ||
    nodeinfo.software.name !== "yurucommu" ||
    !isRecord(nodeinfo.usage) ||
    !isRecord(nodeinfo.usage.users) ||
    !Number.isSafeInteger(nodeinfo.usage.users.total) ||
    !Number.isSafeInteger(nodeinfo.usage.localPosts)
  ) {
    throw new Error(
      "migration-backed NodeInfo did not return database-backed counters",
    );
  }
  return {
    healthz: { status: health.status, missingBindings: health.missingBindings },
    readyz: { status: ready.status, missingBindings: ready.missingBindings },
    socialServer: { product: social.product },
    nodeinfo: {
      software: nodeinfo.software.name,
      users: nodeinfo.usage.users.total,
      localPosts: nodeinfo.usage.localPosts,
    },
  };
}

async function runtimeJson(
  base: URL,
  pathname: string,
  label: string,
): Promise<unknown> {
  const response = await fetch(new URL(pathname, base), {
    method: "GET",
    headers: { accept: "application/json", "cache-control": "no-store" },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return responseJson(response, label, 200);
}

export function requireReadyType(
  resources: readonly Record<string, unknown>[],
  type: string,
  label: string,
  identities?: readonly AppliedResourceIdentity[],
): void {
  const expected = CURRENT_RESOURCE_GRAPH.filter(
    (resource) => resource.type === type,
  );
  if (expected.length === 0) {
    throw new Error(`unknown current resource type ${type}`);
  }
  const matches = resources.filter(
    (resource) => resource.kind === kindFromType(type),
  );
  if (matches.length !== expected.length) {
    throw new Error(
      `Host readback did not contain all ${expected.length} ${label} resources`,
    );
  }
  if (!identities) {
    matches.forEach((resource, index) =>
      assertReadyResource(resource, `${label} ${index + 1}`),
    );
    return;
  }

  const expectedAddresses = expected.map((resource) => resource.address).sort();
  const actualAddresses = identities
    .filter((identity) => identity.type === type)
    .map((identity) => identity.address)
    .sort();
  if (JSON.stringify(actualAddresses) !== JSON.stringify(expectedAddresses)) {
    throw new Error(
      `${label} state identities did not match the current resource graph`,
    );
  }

  const usedMatches = new Set<Record<string, unknown>>();
  for (const resource of expected) {
    const identity = identities.find(
      (candidate) => candidate.address === resource.address,
    );
    if (!identity) {
      throw new Error(`${label} state omitted ${resource.address}`);
    }
    const match = matches.find((candidate) => {
      if (usedMatches.has(candidate) || !isRecord(candidate.metadata)) {
        return false;
      }
      return (
        candidate.metadata.name === identity.name &&
        candidate.metadata.space === identity.space &&
        candidate.metadata.uid === identity.uid &&
        candidate.metadata.generation === identity.generation
      );
    });
    if (!match) {
      throw new Error(`${label} readback omitted ${resource.address}`);
    }
    usedMatches.add(match);
    assertReadyResource(match, `${label} (${resource.address})`);
  }
}

function kindFromType(type: string): string {
  const names: Record<string, string> = {
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
  const result = names[type];
  if (!result) throw new Error(`unknown current resource type ${type}`);
  return result;
}

function assertWorkerEndpointUrl(value: string): void {
  const url = absoluteHttpUrl(value, "WorkerEndpoint.url");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("WorkerEndpoint.url must be HTTPS unless it is loopback");
  }
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("WorkerEndpoint.url must be a credential-free origin root");
  }
}

function assertApiOutput(apiUrl: string, launchUrl: string): void {
  const api = absoluteHttpUrl(apiUrl, "api_url");
  const launch = new URL(launchUrl);
  if (api.origin !== launch.origin || api.pathname !== "/api") {
    throw new Error("api_url was not derived from launch_url");
  }
}

export async function responseJson(
  response: Response,
  label: string,
  expectedStatus: number,
): Promise<unknown> {
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function outputValue(outputs: Record<string, unknown>, name: string): unknown {
  const output = outputs[name];
  if (!isRecord(output) || !("value" in output))
    throw new Error(`tofu output omitted ${name}`);
  return output.value;
}

function outputString(outputs: Record<string, unknown>, name: string): string {
  const value = outputValue(outputs, name);
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`tofu output ${name} was not a non-empty string`);
  return value;
}

function parseTofuJson(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error) {
    throw new Error(`${label} was not valid JSON`, { cause: error });
  }
}

type ChildProcess = ReturnType<typeof Bun.spawn>;

let activeChild: ChildProcess | undefined;
let terminationRequest: Error | undefined;

function signalChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  // `detached: true` gives the child its own POSIX session/process group. A
  // negative PID targets that group, so descendants holding inherited pipes
  // are terminated without ever signalling the caller's process group.
  if (
    process.platform !== "win32" &&
    Number.isInteger(child.pid) &&
    child.pid > 1
  ) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The direct child may have exited before its group was signalled.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A concurrently-exited child needs no further signal.
  }
}

export function installLifecycleSignalHandlers(): () => void {
  const previousTerminationRequest = terminationRequest;
  terminationRequest = undefined;
  const requestTermination = (signal: string): void => {
    terminationRequest ??= new Error(`received ${signal}; cleanup requested`);
    if (activeChild) signalChildProcess(activeChild, "SIGTERM");
  };
  const onSigint = (): void => requestTermination("SIGINT");
  const onSigterm = (): void => requestTermination("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    terminationRequest = previousTerminationRequest;
  };
}

export function assertLifecycleNotTerminated(): void {
  if (terminationRequest) throw terminationRequest;
}

function throwIfTerminationRequested(): void {
  assertLifecycleNotTerminated();
}

export async function runBoundedChild(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly environment?: Record<string, string | undefined>;
    readonly timeoutMs: number;
    readonly label?: string;
    readonly maxOutputBytes?: number;
    readonly termGraceMs?: number;
  },
): Promise<BoundedChildResult> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("child timeout must be a positive integer in milliseconds");
  }
  const termGraceMs = options.termGraceMs ?? CHILD_TERM_GRACE_MS;
  if (!Number.isInteger(termGraceMs) || termGraceMs < 0) {
    throw new Error(
      "child TERM grace must be a non-negative integer in milliseconds",
    );
  }
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  activeChild = child;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES;
  const streamAbort = new AbortController();
  const stdoutPromise = readBoundedStream(
    child.stdout,
    maxOutputBytes,
    streamAbort.signal,
  );
  const stderrPromise = readBoundedStream(
    child.stderr,
    maxOutputBytes,
    streamAbort.signal,
  );
  const completion = Promise.all([
    child.exited,
    stdoutPromise,
    stderrPromise,
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
  const waitForCompletion = async (
    timeoutMs: number,
  ): Promise<
    | { readonly kind: "complete"; readonly value: Awaited<typeof completion> }
    | { readonly kind: "timeout" }
  > => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });
    try {
      return await Promise.race([
        completion.then((value) => ({ kind: "complete" as const, value })),
        timeout,
      ]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  };
  let timeoutError: Error | undefined;
  let completed: Awaited<typeof completion> | undefined;
  try {
    let result = await waitForCompletion(options.timeoutMs);
    if (result.kind === "timeout") {
      signalChildProcess(child, "SIGTERM");
      result = await waitForCompletion(termGraceMs);
      if (result.kind === "timeout") {
        signalChildProcess(child, "SIGKILL");
        result = await waitForCompletion(termGraceMs);
      }
      timeoutError = new Error(
        `${options.label ?? command[0] ?? "child"} exceeded ${options.timeoutMs}ms and was terminated`,
      );
      if (result.kind === "timeout") {
        // A process outside the group can keep an inherited pipe open. Do not
        // await it forever after the group has been force-killed; abort only
        // this capture and let the finite timeout error drive cleanup.
        streamAbort.abort();
        await Promise.race([completion.catch(() => undefined), delay(1)]);
      } else {
        completed = result.value;
      }
    } else {
      completed = result.value;
    }
  } finally {
    if (activeChild === child) activeChild = undefined;
  }
  if (timeoutError) throw timeoutError;
  if (!completed) throw new Error("child exited without a completion result");
  return {
    exitCode: completed.exitCode,
    stdout: completed.stdout.text,
    stderr: completed.stderr.text,
    timedOut: false,
    outputTruncated: completed.stdout.truncated || completed.stderr.truncated,
  };
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  environment: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<void> {
  throwIfTerminationRequested();
  const result = await runBoundedChild(command, {
    cwd,
    environment,
    timeoutMs,
    label: command[0] ?? "child",
  });
  if (result.timedOut) throw new Error(`${command[0] ?? "child"} timed out`);
  if (result.outputTruncated) {
    throw new Error(`${command[0] ?? "child"} output exceeded capture limit`);
  }
  if (result.exitCode !== 0)
    throw new Error(`Command failed: ${command.join(" ")}`);
}

async function runGitCapture(
  cwd: string,
  args: readonly string[],
  environment: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string> {
  const result = await runBoundedChild(["git", ...args], {
    cwd,
    environment,
    timeoutMs,
    label: `git ${args[0] ?? "command"}`,
    maxOutputBytes: MAX_PROVENANCE_OUTPUT_BYTES,
  });
  if (result.timedOut) throw new Error(`git ${args[0] ?? "command"} timed out`);
  if (result.outputTruncated) {
    throw new Error(
      `git ${args[0] ?? "command"} output exceeded the provenance limit`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? "command"} failed with exit ${result.exitCode}`,
    );
  }
  return result.stdout;
}

async function assertTrackedSourcePath(
  repositoryRoot: string,
  relativePath: string,
  environment: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<void> {
  const tracked = (
    await runGitCapture(
      repositoryRoot,
      ["ls-files", "--error-unmatch", "--", relativePath],
      environment,
      timeoutMs,
    )
  ).trim();
  if (tracked !== relativePath) {
    throw new Error(`source path is not tracked: ${relativePath}`);
  }
}

async function runTofu(
  args: readonly string[],
  options: {
    readonly workdir: string;
    readonly environment: Record<string, string | undefined>;
    readonly captureStdout?: boolean;
    readonly maxOutputBytes?: number;
    readonly outputLimitMessage?: string;
    readonly timeoutMs: number;
    /** Cleanup must still be allowed after SIGINT/SIGTERM requested recovery. */
    readonly allowAfterTermination?: boolean;
  },
): Promise<string> {
  if (!options.allowAfterTermination) throwIfTerminationRequested();
  const result = await runBoundedChild(["tofu", ...args], {
    cwd: options.workdir,
    environment: options.environment,
    timeoutMs: options.timeoutMs,
    label: `tofu ${args[0] ?? "command"}`,
    maxOutputBytes: options.maxOutputBytes,
  });
  if (result.timedOut)
    throw new Error(`tofu ${args[0] ?? "command"} timed out`);
  if (result.outputTruncated) {
    throw new Error(
      options.outputLimitMessage ??
        `tofu ${args[0] ?? "command"} output exceeded capture limit`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `tofu ${args[0] ?? "command"} failed with exit ${result.exitCode}`,
    );
  }
  return options.captureStdout ? result.stdout : "";
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const abortReader = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) abortReader();
  else signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (bytes < maxBytes) {
        const remaining = maxBytes - bytes;
        const take = Math.min(remaining, value.byteLength);
        if (take > 0) {
          chunks.push(value.slice(0, take));
          bytes += take;
        }
        if (take < value.byteLength) truncated = true;
      } else if (value.byteLength > 0) {
        // Keep draining after the capture cap. Cancelling here can close the
        // pipe early, causing a child that is still writing to receive SIGPIPE.
        truncated = true;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
  const merged = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function absoluteHttpUrl(input: string, name: string): URL {
  let value: URL;
  try {
    value = new URL(input);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (
    !["http:", "https:"].includes(value.protocol) ||
    value.username ||
    value.password ||
    value.search ||
    value.hash
  ) {
    throw new Error(`${name} must be a credential-free absolute HTTP(S) URL`);
  }
  return value;
}

function parseCommandTimeout(input: string): number {
  if (!input) return DEFAULT_COMMAND_TIMEOUT_MS;
  const seconds = Number(input);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
    throw new Error(
      "TAKOFORM_E2E_TIMEOUT_SECONDS must be an integer number of seconds",
    );
  }
  const milliseconds = seconds * 1_000;
  if (
    milliseconds < MIN_COMMAND_TIMEOUT_MS ||
    milliseconds > MAX_COMMAND_TIMEOUT_MS
  ) {
    throw new Error(
      `TAKOFORM_E2E_TIMEOUT_SECONDS must be between ${Math.ceil(MIN_COMMAND_TIMEOUT_MS / 1_000)} and ${Math.floor(MAX_COMMAND_TIMEOUT_MS / 1_000)} seconds`,
    );
  }
  return milliseconds;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} was not a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  await main();
}
