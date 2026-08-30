import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  open,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";
const STABLE_DISCOVERY_PATH = "/.well-known/takoform/v1";
const STABLE_API_PATH = "/apis/forms.takoform.com/v1";
const STANDARD_SERVICE_PROTOCOL = "com.amazonaws.s3";
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
const DEFAULT_LIVE_CHECKPOINT_WAIT_SECONDS = 300;
/** Keep the optional pause below the 3600-second credential-pair lifetime. */
export const MAX_LIVE_CHECKPOINT_WAIT_SECONDS = 900;
const LIVE_CHECKPOINT_FILE_NAME = "takoform-v1-e2e-checkpoint.json";
const LIVE_RELEASE_SIGNAL_FILE_NAME = "takoform-v1-e2e-release";
const LIVE_CHECKPOINT_ENV = "TAKOFORM_E2E_CHECKPOINT_PATH";
const LIVE_CHECKPOINT_WAIT_ENV = "TAKOFORM_E2E_CHECKPOINT_WAIT_SECONDS";
const LIVE_SCREENSHOT_ENV = "TAKOFORM_E2E_SCREENSHOT_PATH";
const LIVE_CHECKPOINT_POLL_INTERVAL_MS = 100;
const LIVE_CHECKPOINT_KIND =
  "yurucommu.takoform-v1-e2e-live-checkpoint@v2" as const;
const LIVE_RELEASE_SIGNAL_KIND =
  "yurucommu.takoform-v1-e2e-live-release@v2" as const;
const LIVE_CHECKPOINT_NONCE_RE = /^[a-f0-9]{32}$/u;
const MAX_CHECKPOINT_EVIDENCE_BYTES = 64 * 1024;
const MAX_RELEASE_SIGNAL_BYTES = 512;
const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;
const terminationListeners = new Set<(error: Error) => void>();
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
const SOURCE_EXPECTED_UNUSED_ENTRIES = ["e2e"] as const;
const SOURCE_MIGRATIONS_DIR = "migrations";
const SOURCE_MIGRATIONS_SQL_DIR = "sql";
const SOURCE_MIGRATION_ROOT_ENTRIES = [
  "schema-bundle.json",
  SOURCE_MIGRATIONS_SQL_DIR,
  "takoform-overrides",
] as const;
const GENERATED_WORKER_FILE = "yurucommu-worker.js";
const MIGRATION_FILE_RE = /^\d{4}_[A-Za-z0-9_-]+\.sql$/u;

/** The current Yurucommu Capsule graph. Keep this in lockstep with main.tf. */
export const CURRENT_RESOURCE_TYPES = [
  "takoform_module_worker",
  "takoform_sqlite_database",
  "takoform_sqlite_migration_set",
  "takoform_sqlite_migration_application",
  "takoform_edge_kv_namespace",
  "takoform_at_least_once_queue",
  "takoform_at_least_once_queue",
  "takoform_worker_bundle",
  "takoform_worker_version",
  "takoform_worker_deployment",
  "takoform_worker_endpoint",
  "takoform_queue_consumer",
  "takoform_worker_cron_trigger",
] as const;

const CURRENT_RESOURCE_ID_KEYS = [
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
] as const;

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
  /** Optional owner-controlled pause used to inspect a live assigned Worker. */
  readonly liveCheckpoint?: LiveCheckpointConfig;
}

/**
 * Explicit opt-in configuration for the human/browser live checkpoint.
 *
 * `checkpointPath` must already exist and identify an owner-only regular file
 * or directory outside every Git worktree. A directory target receives the fixed
 * checkpoint and release filenames documented by the runner; a file target is
 * written in place and uses a sibling `.release` signal.
 */
export interface LiveCheckpointConfig {
  readonly checkpointPath: string;
  readonly waitSeconds: number;
  readonly screenshotPath?: string;
}

export interface LiveCheckpointTarget {
  readonly configuredPath: string;
  readonly targetKind: "directory" | "file";
  readonly checkpointPath: string;
  readonly releasePath: string;
  readonly waitSeconds: number;
  readonly waitMs: number;
  readonly screenshotPath?: string;
}

export interface LiveCheckpointEvidence {
  readonly kind: typeof LIVE_CHECKPOINT_KIND;
  readonly state: "awaiting-owner-release";
  /** SHA-256 of canonical evidence with this digest field omitted. */
  readonly evidenceSha256: string;
  readonly runId: string;
  /** Fresh per-checkpoint binding so a stale signal cannot release a new run. */
  readonly nonce: string;
  readonly createdAt: string;
  readonly capsule: {
    readonly source: SourceProvenance;
    readonly provider: {
      readonly source: string;
      readonly sha256: string;
      readonly schema: ProviderSchemaProof;
    };
  };
  readonly run: {
    readonly resourceCount: number;
    readonly screenshotExpected: boolean;
  };
  readonly runtime: {
    readonly launchUrl: string;
    readonly apiUrl: string;
    readonly probeUrl: string;
    readonly endpointClassification:
      "assigned-worker-endpoint" | "test-only-loopback-diagnostic";
  };
}

export interface LiveCheckpointEvidenceInput {
  readonly runId: string;
  readonly nonce?: string;
  readonly createdAt?: string;
  readonly capsule: LiveCheckpointEvidence["capsule"];
  readonly run: LiveCheckpointEvidence["run"];
  readonly runtime: LiveCheckpointEvidence["runtime"];
}

export interface LiveCheckpointReleaseSignal {
  readonly kind: typeof LIVE_RELEASE_SIGNAL_KIND;
  readonly runId: string;
  readonly nonce: string;
  readonly evidenceSha256: string;
  readonly checkpointSha256: string;
}

export interface RuntimeProbeEvidence {
  readonly healthz: {
    readonly status: "ok";
    readonly missingBindings: readonly string[];
  };
  readonly readyz: {
    readonly status: "ok";
    readonly missingBindings: readonly string[];
  };
  readonly socialServer: { readonly product: "yurucommu" };
  readonly nodeinfo: {
    readonly software: "yurucommu";
    readonly users: number;
    readonly localPosts: number;
  };
}

export interface LiveScreenshotEvidence {
  readonly kind: "external-owner-png@v1";
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
}

export interface LiveCheckpointAttestation {
  readonly kind: "yurucommu.takoform-v1-e2e-live-attestation@v1";
  readonly state: "released-and-reprobed";
  readonly checkpoint: {
    readonly evidence: LiveCheckpointEvidence;
    readonly evidenceSha256: string;
    readonly checkpointSha256: string;
  };
  readonly release: {
    readonly signal: LiveCheckpointReleaseSignal;
    readonly signalSha256: string;
    readonly releasedAt: string;
  };
  readonly screenshot?: LiveScreenshotEvidence;
  readonly postReleaseRuntimeReadback: {
    readonly verifiedAt: string;
    readonly evidence: RuntimeProbeEvidence;
  };
}

interface LiveCheckpointReleaseAttestation {
  readonly checkpoint: LiveCheckpointAttestation["checkpoint"];
  readonly release: LiveCheckpointAttestation["release"];
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
  readonly providerConstraint: "= 3.0.0";
}

export interface ProviderSchemaProof {
  readonly source: string;
  readonly providerVersion: "3.0.0";
  readonly versionConstraint: "= 3.0.0";
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

/**
 * Read the opt-in owner checkpoint contract without touching the filesystem.
 *
 * The path is intentionally a single explicit knob. Its existing type (a
 * regular owner-only file or directory) determines where the sanitized
 * checkpoint is written and where the one-shot release signal is watched.
 */
export function readLiveCheckpointConfig(
  environment: Environment,
): LiveCheckpointConfig | undefined {
  const checkpointPath = environment[LIVE_CHECKPOINT_ENV]?.trim() ?? "";
  const waitInput = environment[LIVE_CHECKPOINT_WAIT_ENV]?.trim() ?? "";
  const screenshotPath = environment[LIVE_SCREENSHOT_ENV]?.trim() ?? "";
  if (!checkpointPath) {
    if (waitInput || screenshotPath) {
      throw new Error(
        `${waitInput ? LIVE_CHECKPOINT_WAIT_ENV : LIVE_SCREENSHOT_ENV} requires ${LIVE_CHECKPOINT_ENV}`,
      );
    }
    return undefined;
  }
  if (!isAbsolute(checkpointPath)) {
    throw new Error(`${LIVE_CHECKPOINT_ENV} must be an absolute path`);
  }
  if (screenshotPath && !isAbsolute(screenshotPath)) {
    throw new Error(`${LIVE_SCREENSHOT_ENV} must be an absolute path`);
  }
  const waitSeconds = parseLiveCheckpointWait(waitInput);
  return {
    checkpointPath,
    waitSeconds,
    ...(screenshotPath ? { screenshotPath } : {}),
  };
}

function parseLiveCheckpointWait(input: string): number {
  if (!input) return DEFAULT_LIVE_CHECKPOINT_WAIT_SECONDS;
  if (!/^\d+$/u.test(input)) {
    throw new Error(
      `${LIVE_CHECKPOINT_WAIT_ENV} must be an integer number of seconds`,
    );
  }
  const seconds = Number(input);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > MAX_LIVE_CHECKPOINT_WAIT_SECONDS
  ) {
    throw new Error(
      `${LIVE_CHECKPOINT_WAIT_ENV} must be between 0 and ${MAX_LIVE_CHECKPOINT_WAIT_SECONDS} seconds`,
    );
  }
  return seconds;
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
  const liveCheckpoint = readLiveCheckpointConfig(environment);

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
    ...(liveCheckpoint ? { liveCheckpoint } : {}),
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
 * Validate the explicit live-checkpoint target before any E2E mutation.
 *
 * The configured path itself must already exist as an owner-only regular file
 * or directory. The directory form is useful for a disposable operator
 * scratch area; the file form is useful when the caller wants an exact
 * evidence pathname. No target or signal path is ever resolved through a
 * symbolic link, and regular files must not have another hard link.
 */
export async function prepareLiveCheckpointTarget(
  config: LiveCheckpointConfig,
): Promise<LiveCheckpointTarget> {
  assertLiveCheckpointConfig(config);
  assertExternalCheckpointPath(config.checkpointPath);
  await assertOutsideGitWorktree(config.checkpointPath);
  await assertNoSymlinkInAncestors(config.checkpointPath, "checkpoint path");

  let metadata;
  try {
    metadata = await lstat(config.checkpointPath);
  } catch {
    throw new Error(
      "TAKOFORM_E2E_CHECKPOINT_PATH must point to an existing file or directory",
    );
  }
  if (metadata.isSymbolicLink()) {
    throw new Error("checkpoint path must not be a symbolic link");
  }

  let targetKind: LiveCheckpointTarget["targetKind"];
  if (metadata.isDirectory()) {
    assertOwnerOnlyDirectory(metadata, "checkpoint directory");
    targetKind = "directory";
  } else if (metadata.isFile()) {
    assertOwnerOnlyFile(metadata, "checkpoint file");
    if (metadata.nlink !== 1) {
      throw new Error("checkpoint file must not be hard-linked");
    }
    targetKind = "file";
  } else {
    throw new Error("checkpoint path must be a regular file or directory");
  }

  const checkpointPath =
    targetKind === "directory"
      ? join(config.checkpointPath, LIVE_CHECKPOINT_FILE_NAME)
      : config.checkpointPath;
  const releasePath =
    targetKind === "directory"
      ? join(config.checkpointPath, LIVE_RELEASE_SIGNAL_FILE_NAME)
      : `${config.checkpointPath}.release`;

  await assertNoSymlinkInAncestors(
    dirname(checkpointPath),
    "checkpoint parent directory",
  );
  await assertNoSymlinkInAncestors(
    dirname(releasePath),
    "release signal parent directory",
  );
  await assertOptionalCheckpointFile(checkpointPath);
  await assertOptionalReleaseSignal(releasePath);
  if (config.screenshotPath) {
    await prepareLiveScreenshotPath(
      config.screenshotPath,
      checkpointPath,
      releasePath,
    );
  }

  return {
    configuredPath: config.checkpointPath,
    targetKind,
    checkpointPath,
    releasePath,
    waitSeconds: config.waitSeconds,
    waitMs: config.waitSeconds * 1_000,
    ...(config.screenshotPath ? { screenshotPath: config.screenshotPath } : {}),
  };
}

/** Construct the only fields allowed in the on-disk live checkpoint. */
export function buildLiveCheckpointEvidence(
  input: LiveCheckpointEvidenceInput,
): LiveCheckpointEvidence {
  const runId = input.runId;
  const nonce = input.nonce ?? crypto.randomUUID().replaceAll("-", "");
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!/^[a-z][a-z0-9-]{1,50}[a-z0-9]$/u.test(runId)) {
    throw new Error("live checkpoint runId is not a valid E2E identity");
  }
  if (!LIVE_CHECKPOINT_NONCE_RE.test(nonce)) {
    throw new Error("live checkpoint nonce is not a valid E2E binding");
  }
  if (
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    throw new Error("live checkpoint createdAt must be an ISO timestamp");
  }
  const capsule = sanitizeLiveCheckpointCapsule(input.capsule);
  const run = sanitizeLiveCheckpointRun(input.run);
  const runtime = sanitizeLiveCheckpointRuntime(input.runtime);
  const body = {
    kind: LIVE_CHECKPOINT_KIND,
    state: "awaiting-owner-release" as const,
    runId,
    nonce,
    createdAt,
    capsule,
    run,
    runtime,
  };
  return {
    ...body,
    evidenceSha256: digestBytes(Buffer.from(canonicalJson(body), "utf8")),
  };
}

/** Build the exact owner release object for one fresh checkpoint binding. */
export function buildLiveCheckpointReleaseSignal(
  evidence: LiveCheckpointEvidence,
): LiveCheckpointReleaseSignal {
  const sanitized = sanitizeLiveCheckpointEvidence(evidence);
  const checkpointPayload = serializeLiveCheckpointEvidence(sanitized);
  return {
    kind: LIVE_RELEASE_SIGNAL_KIND,
    runId: sanitized.runId,
    nonce: sanitized.nonce,
    evidenceSha256: digestLiveCheckpointEvidence(sanitized),
    checkpointSha256: digestBytes(Buffer.from(checkpointPayload, "utf8")),
  };
}

/** Digest the canonical, secret-free evidence object (without file framing). */
export function digestLiveCheckpointEvidence(
  evidence: LiveCheckpointEvidence,
): string {
  return sanitizeLiveCheckpointEvidence(evidence).evidenceSha256;
}

function sanitizeLiveCheckpointEvidence(
  evidence: LiveCheckpointEvidence,
): LiveCheckpointEvidence {
  if (
    evidence.kind !== LIVE_CHECKPOINT_KIND ||
    evidence.state !== "awaiting-owner-release"
  ) {
    throw new Error("live checkpoint evidence kind or state was invalid");
  }
  const sanitized = buildLiveCheckpointEvidence({
    runId: evidence.runId,
    nonce: evidence.nonce,
    createdAt: evidence.createdAt,
    capsule: evidence.capsule,
    run: evidence.run,
    runtime: evidence.runtime,
  });
  if (evidence.evidenceSha256 !== sanitized.evidenceSha256) {
    throw new Error("live checkpoint evidence digest was invalid");
  }
  return sanitized;
}

function sanitizeLiveCheckpointCapsule(
  capsule: LiveCheckpointEvidence["capsule"],
): LiveCheckpointEvidence["capsule"] {
  if (!isRecord(capsule) || !isRecord(capsule.provider)) {
    throw new Error("live checkpoint capsule evidence was invalid");
  }
  if (capsule.provider.source !== PROVIDER_SOURCE) {
    throw new Error("live checkpoint Provider source was invalid");
  }
  const providerSha256 = canonicalSha256(
    capsule.provider.sha256,
    "live checkpoint Provider digest",
  );
  const schema = sanitizeProviderSchemaProof(capsule.provider.schema);
  return {
    source: sanitizeSourceProvenance(capsule.source),
    provider: {
      source: PROVIDER_SOURCE,
      sha256: providerSha256,
      schema,
    },
  };
}

function sanitizeSourceProvenance(source: SourceProvenance): SourceProvenance {
  if (
    !isRecord(source) ||
    !/^[a-f0-9]{40,64}$/u.test(source.sourceHead) ||
    typeof source.workspaceDirty !== "boolean" ||
    !isRecord(source.module) ||
    !Array.isArray(source.moduleFiles) ||
    !isRecord(source.worker) ||
    !Array.isArray(source.migrations) ||
    source.providerConstraint !== "= 3.0.0"
  ) {
    throw new Error("live checkpoint source provenance was invalid");
  }
  const module = Object.fromEntries(
    Object.entries(source.module).map(([path, sha256]) => {
      if (!path || typeof sha256 !== "string") {
        throw new Error("live checkpoint module provenance was invalid");
      }
      return [path, canonicalSha256(sha256, "live checkpoint module digest")];
    }),
  );
  return {
    sourceHead: source.sourceHead,
    workspaceDirty: source.workspaceDirty,
    workspaceStateDigest: canonicalSha256(
      source.workspaceStateDigest,
      "live checkpoint workspace digest",
    ),
    module,
    moduleFiles: source.moduleFiles.map((entry) =>
      sanitizeProvenanceFile(entry, "live checkpoint module file"),
    ),
    worker: sanitizeProvenanceFile(source.worker, "live checkpoint Worker"),
    migrations: source.migrations.map((entry) =>
      sanitizeProvenanceFile(entry, "live checkpoint migration"),
    ),
    providerConstraint: "= 3.0.0",
  };
}

function sanitizeProvenanceFile(
  entry: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  },
  label: string,
): { readonly path: string; readonly bytes: number; readonly sha256: string } {
  if (
    !isRecord(entry) ||
    typeof entry.path !== "string" ||
    entry.path.length === 0 ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0
  ) {
    throw new Error(`${label} provenance was invalid`);
  }
  return {
    path: entry.path,
    bytes: entry.bytes,
    sha256: canonicalSha256(entry.sha256, `${label} digest`),
  };
}

function sanitizeProviderSchemaProof(
  schema: ProviderSchemaProof,
): ProviderSchemaProof {
  if (
    !isRecord(schema) ||
    schema.source !== PROVIDER_SOURCE ||
    schema.providerVersion !== "3.0.0" ||
    schema.versionConstraint !== "= 3.0.0" ||
    !Number.isSafeInteger(schema.protocolSchemaVersion) ||
    schema.protocolSchemaVersion < 0 ||
    !Array.isArray(schema.resourceKinds) ||
    schema.resourceKinds.some(
      (kind: unknown) => typeof kind !== "string" || kind.length === 0,
    )
  ) {
    throw new Error("live checkpoint Provider schema proof was invalid");
  }
  return {
    source: PROVIDER_SOURCE,
    providerVersion: "3.0.0",
    versionConstraint: "= 3.0.0",
    protocolSchemaVersion: schema.protocolSchemaVersion,
    resourceKinds: [...schema.resourceKinds],
  };
}

function sanitizeLiveCheckpointRun(
  run: LiveCheckpointEvidence["run"],
): LiveCheckpointEvidence["run"] {
  if (
    !isRecord(run) ||
    !Number.isSafeInteger(run.resourceCount) ||
    run.resourceCount < 1 ||
    typeof run.screenshotExpected !== "boolean"
  ) {
    throw new Error("live checkpoint run evidence was invalid");
  }
  return {
    resourceCount: run.resourceCount,
    screenshotExpected: run.screenshotExpected,
  };
}

function sanitizeLiveCheckpointRuntime(
  runtime: LiveCheckpointEvidence["runtime"],
): LiveCheckpointEvidence["runtime"] {
  if (!isRecord(runtime)) {
    throw new Error("live checkpoint runtime evidence was invalid");
  }
  const launch = absoluteHttpUrl(
    runtime.launchUrl,
    "live checkpoint launch URL",
  );
  assertWorkerEndpointUrl(launch.toString());
  const api = absoluteHttpUrl(runtime.apiUrl, "live checkpoint API URL");
  assertApiOutput(api.toString(), launch.toString());
  const probe = absoluteHttpUrl(
    runtime.probeUrl,
    "live checkpoint runtime probe URL",
  );
  assertWorkerEndpointUrl(probe.toString());
  if (
    runtime.endpointClassification !== "assigned-worker-endpoint" &&
    runtime.endpointClassification !== "test-only-loopback-diagnostic"
  ) {
    throw new Error("live checkpoint runtime classification was invalid");
  }
  return {
    launchUrl: launch.toString(),
    apiUrl: api.toString(),
    probeUrl: probe.toString(),
    endpointClassification: runtime.endpointClassification,
  };
}

function canonicalSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} was not canonical sha256`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  throw new Error("live checkpoint evidence was not canonical JSON");
}

function serializeLiveCheckpointEvidence(
  evidence: LiveCheckpointEvidence,
): string {
  return `${canonicalJson(sanitizeLiveCheckpointEvidence(evidence))}\n`;
}

/**
 * Atomically write sanitized checkpoint evidence with mode 0600.
 *
 * The target is revalidated immediately before writing. A temp file is opened
 * with O_EXCL/O_NOFOLLOW in the target's existing parent, then renamed over
 * the checkpoint path; no caller-supplied object is serialized directly.
 */
export async function writeLiveCheckpoint(
  target: LiveCheckpointTarget,
  evidence: LiveCheckpointEvidence,
): Promise<void> {
  const validated = await prepareLiveCheckpointTarget({
    checkpointPath: target.configuredPath,
    waitSeconds: target.waitSeconds,
  });
  if (
    validated.checkpointPath !== target.checkpointPath ||
    validated.releasePath !== target.releasePath
  ) {
    throw new Error("live checkpoint target changed during validation");
  }
  const payload = serializeLiveCheckpointEvidence(evidence);
  if (Buffer.byteLength(payload, "utf8") > MAX_CHECKPOINT_EVIDENCE_BYTES) {
    throw new Error("live checkpoint evidence exceeded the size limit");
  }
  const temporaryPath = join(
    dirname(validated.checkpointPath),
    `.${basename(validated.checkpointPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, flags, 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, validated.checkpointPath);
  } catch (error) {
    throw new Error("could not write the live E2E checkpoint", {
      cause: error,
    });
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** Wait for and consume one safe owner release signal. */
export async function waitForLiveCheckpointRelease(
  target: LiveCheckpointTarget,
  options: {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    /** Immutable evidence produced before the checkpoint file is written. */
    readonly expectedEvidence: LiveCheckpointEvidence;
  },
): Promise<LiveCheckpointReleaseAttestation> {
  const validated = await prepareLiveCheckpointTarget({
    checkpointPath: target.configuredPath,
    waitSeconds: target.waitSeconds,
  });
  if (
    validated.checkpointPath !== target.checkpointPath ||
    validated.releasePath !== target.releasePath
  ) {
    throw new Error("live checkpoint target changed during validation");
  }
  const timeoutMs = options.timeoutMs ?? validated.waitMs;
  const pollIntervalMs =
    options.pollIntervalMs ?? LIVE_CHECKPOINT_POLL_INTERVAL_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_LIVE_CHECKPOINT_WAIT_SECONDS * 1_000
  ) {
    throw new Error(
      `live checkpoint timeout must be between 0 and ${MAX_LIVE_CHECKPOINT_WAIT_SECONDS * 1_000}ms`,
    );
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("live checkpoint poll interval must be a positive integer");
  }
  const evidence = sanitizeLiveCheckpointEvidence(options.expectedEvidence);
  const expectedPayload = serializeLiveCheckpointEvidence(evidence);
  const expectedSignal = buildLiveCheckpointReleaseSignal(evidence);
  const initialCheckpoint = await readLiveCheckpointRecord(
    validated.checkpointPath,
  );
  if (initialCheckpoint.raw !== expectedPayload) {
    throw new Error("live E2E checkpoint bytes changed before release");
  }

  const startedAt = Date.now();
  while (true) {
    throwIfTerminationRequested();
    const release = await consumeReleaseSignal(
      validated.releasePath,
      expectedSignal,
      async () => {
        const current = await readLiveCheckpointRecord(
          validated.checkpointPath,
        );
        if (current.raw !== expectedPayload) {
          throw new Error("live E2E checkpoint bytes changed before release");
        }
      },
    );
    if (release) {
      return {
        checkpoint: {
          evidence,
          evidenceSha256: expectedSignal.evidenceSha256,
          checkpointSha256: expectedSignal.checkpointSha256,
        },
        release,
      };
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `live E2E checkpoint release signal was not received within ${timeoutMs}ms`,
      );
    }
    await delayOrTermination(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
  }
}

/** Write one fresh checkpoint, then wait for its exact owner release. */
export async function runLiveCheckpointGate(
  target: LiveCheckpointTarget,
  evidence: LiveCheckpointEvidence,
  options: {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly postReleaseRuntimeReadback: (
      signal: AbortSignal,
    ) => Promise<unknown>;
  },
): Promise<LiveCheckpointAttestation> {
  const sanitized = sanitizeLiveCheckpointEvidence(evidence);
  if (sanitized.run.screenshotExpected !== Boolean(target.screenshotPath)) {
    throw new Error("live checkpoint screenshot expectation changed");
  }
  if (
    target.screenshotPath &&
    [target.checkpointPath, target.releasePath].some(
      (path) => resolve(path) === resolve(target.screenshotPath!),
    )
  ) {
    throw new Error("live screenshot path overlaps checkpoint files");
  }
  await writeLiveCheckpoint(target, sanitized);
  const released = await waitForLiveCheckpointRelease(target, {
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
    expectedEvidence: sanitized,
  });
  throwIfTerminationRequested();
  const runtimeAbort = new AbortController();
  const abortRuntimeReadback = (error: Error): void => {
    runtimeAbort.abort(error);
  };
  terminationListeners.add(abortRuntimeReadback);
  let runtimeReadback: RuntimeProbeEvidence;
  try {
    if (terminationRequest) abortRuntimeReadback(terminationRequest);
    runtimeReadback = sanitizeRuntimeProbeEvidence(
      await options.postReleaseRuntimeReadback(runtimeAbort.signal),
    );
  } finally {
    terminationListeners.delete(abortRuntimeReadback);
  }
  throwIfTerminationRequested();
  const runtimeVerifiedAt = new Date().toISOString();
  const screenshot = target.screenshotPath
    ? await verifyLiveScreenshot(target.screenshotPath, sanitized.createdAt)
    : undefined;
  throwIfTerminationRequested();
  return {
    kind: "yurucommu.takoform-v1-e2e-live-attestation@v1",
    state: "released-and-reprobed",
    ...released,
    ...(screenshot ? { screenshot } : {}),
    postReleaseRuntimeReadback: {
      verifiedAt: runtimeVerifiedAt,
      evidence: runtimeReadback,
    },
  };
}

async function readLiveCheckpointRecord(path: string): Promise<{
  readonly evidence: LiveCheckpointEvidence;
  readonly raw: string;
}> {
  const raw = await readBoundedOwnerFile(
    path,
    "live checkpoint file",
    MAX_CHECKPOINT_EVIDENCE_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("live E2E checkpoint was not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("live E2E checkpoint was not a JSON object");
  }
  let evidence: LiveCheckpointEvidence;
  try {
    evidence = sanitizeLiveCheckpointEvidence(parsed as LiveCheckpointEvidence);
  } catch {
    throw new Error("live E2E checkpoint had invalid evidence");
  }
  if (raw !== serializeLiveCheckpointEvidence(evidence)) {
    throw new Error("live E2E checkpoint bytes were not canonical");
  }
  return { evidence, raw };
}

function delayOrTermination(milliseconds: number): Promise<void> {
  if (terminationRequest) return Promise.reject(terminationRequest);
  return new Promise((resolveDelay, reject) => {
    const timeout = setTimeout(() => {
      terminationListeners.delete(onTermination);
      resolveDelay();
    }, milliseconds);
    const onTermination = (error: Error): void => {
      clearTimeout(timeout);
      terminationListeners.delete(onTermination);
      reject(error);
    };
    terminationListeners.add(onTermination);
    if (terminationRequest) onTermination(terminationRequest);
  });
}

function assertLiveCheckpointConfig(config: LiveCheckpointConfig): void {
  if (!isAbsolute(config.checkpointPath)) {
    throw new Error("TAKOFORM_E2E_CHECKPOINT_PATH must be an absolute path");
  }
  if (config.screenshotPath && !isAbsolute(config.screenshotPath)) {
    throw new Error(`${LIVE_SCREENSHOT_ENV} must be an absolute path`);
  }
  if (
    !Number.isSafeInteger(config.waitSeconds) ||
    config.waitSeconds < 0 ||
    config.waitSeconds > MAX_LIVE_CHECKPOINT_WAIT_SECONDS
  ) {
    throw new Error(
      `live checkpoint wait must be between 0 and ${MAX_LIVE_CHECKPOINT_WAIT_SECONDS} seconds`,
    );
  }
}

function assertExternalCheckpointPath(path: string): void {
  assertExternalOwnerPath(path, LIVE_CHECKPOINT_ENV);
}

function assertExternalOwnerPath(path: string, environmentName: string): void {
  const repositoryRoot = resolve(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  const relativePath = relative(repositoryRoot, resolve(path));
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  ) {
    throw new Error(
      `${environmentName} must point outside the Yurucommu repository`,
    );
  }
}

async function assertOutsideGitWorktree(
  path: string,
  environmentName = LIVE_CHECKPOINT_ENV,
): Promise<void> {
  const resolvedPath = resolve(path);
  if (basename(resolvedPath) === ".git") {
    throw new Error(`${environmentName} must point outside every Git worktree`);
  }
  let current = resolvedPath;
  try {
    const metadata = await lstat(current);
    if (metadata.isFile()) current = dirname(current);
  } catch {
    // The configured path itself is checked by prepareLiveCheckpointTarget;
    // this helper only needs existing ancestors to identify Git markers.
  }
  while (true) {
    const gitMarker = join(current, ".git");
    try {
      await lstat(gitMarker);
      throw new Error(
        `${environmentName} must point outside every Git worktree`,
      );
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        // This ancestor is not a Git worktree root.
      } else {
        throw error;
      }
    }
    if (current === dirname(current)) return;
    current = dirname(current);
  }
}

async function prepareLiveScreenshotPath(
  screenshotPath: string,
  checkpointPath: string,
  releasePath: string,
): Promise<void> {
  if (!isAbsolute(screenshotPath)) {
    throw new Error(`${LIVE_SCREENSHOT_ENV} must be an absolute path`);
  }
  const resolvedScreenshot = resolve(screenshotPath);
  if (
    resolvedScreenshot === resolve(checkpointPath) ||
    resolvedScreenshot === resolve(releasePath)
  ) {
    throw new Error(
      "live screenshot path must be separate from checkpoint files",
    );
  }
  assertExternalOwnerPath(resolvedScreenshot, LIVE_SCREENSHOT_ENV);
  await assertOutsideGitWorktree(resolvedScreenshot, LIVE_SCREENSHOT_ENV);
  const parent = dirname(resolvedScreenshot);
  await assertNoSymlinkInAncestors(parent, "live screenshot parent directory");
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory()) {
    throw new Error("live screenshot parent must be a directory");
  }
  assertOwnerOnlyDirectory(parentMetadata, "live screenshot parent directory");
  try {
    const existing = await lstat(resolvedScreenshot);
    if (existing.isSymbolicLink()) {
      throw new Error("live screenshot path must not be a symbolic link");
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    if (error instanceof Error) throw error;
    throw new Error("could not inspect the live screenshot path", {
      cause: error,
    });
  }
  throw new Error("live screenshot path must not exist before the E2E run");
}

async function assertNoSymlinkInAncestors(
  inputPath: string,
  label: string,
): Promise<void> {
  let current = resolve(inputPath);
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      throw new Error(`${label} does not exist`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link`);
    }
    if (current === dirname(current)) return;
    current = dirname(current);
  }
}

function assertOwnerOnlyDirectory(metadata: Stats, label: string): void {
  assertOwner(metadata, label);
  if ((metadata.mode & 0o7777) !== 0o700) {
    throw new Error(`${label} must be owner-only and writable (mode 0700)`);
  }
}

function assertOwnerOnlyFile(metadata: Stats, label: string): void {
  assertOwner(metadata, label);
  if ((metadata.mode & 0o7777) !== 0o600) {
    throw new Error(`${label} must be owner-only (mode 0600)`);
  }
}

function assertOwner(metadata: Stats, label: string): void {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

async function assertOptionalCheckpointFile(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw new Error("could not inspect the live checkpoint file", {
      cause: error,
    });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("live checkpoint file must be a regular file");
  }
  assertOwnerOnlyFile(metadata, "live checkpoint file");
  if (metadata.nlink !== 1) {
    throw new Error("live checkpoint file must not be hard-linked");
  }
}

async function assertOptionalReleaseSignal(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw new Error("could not inspect the live release signal", {
      cause: error,
    });
  }
  assertSafeReleaseSignalMetadata(metadata);
}

function assertSafeReleaseSignalMetadata(metadata: Stats): void {
  if (metadata.isSymbolicLink()) {
    throw new Error("live release signal must not be a symbolic link");
  }
  if (!metadata.isFile()) {
    throw new Error("live release signal must be a regular file");
  }
  assertOwnerOnlyFile(metadata, "live release signal");
  if (metadata.nlink !== 1) {
    throw new Error("live release signal must not be hard-linked");
  }
}

async function readBoundedOwnerFile(
  path: string,
  label: string,
  maxBytes: number,
): Promise<string> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let openedMetadata: Stats | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    openedMetadata = await handle.stat();
    if (openedMetadata.isSymbolicLink() || !openedMetadata.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    assertOwnerOnlyFile(openedMetadata, label);
    if (openedMetadata.nlink !== 1) {
      throw new Error(`${label} must not be hard-linked`);
    }
    const bytes = await readBoundedFileHandle(handle, maxBytes);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${label} is too large`);
    }
    const currentMetadata = await lstat(path);
    if (
      currentMetadata.dev !== openedMetadata.dev ||
      currentMetadata.ino !== openedMetadata.ino ||
      currentMetadata.size !== openedMetadata.size ||
      currentMetadata.mtimeMs !== openedMetadata.mtimeMs ||
      bytes.byteLength !== openedMetadata.size
    ) {
      throw new Error(`${label} changed during validation`);
    }
    assertOwnerOnlyFile(currentMetadata, label);
    if (currentMetadata.nlink !== 1) {
      throw new Error(`${label} must not be hard-linked`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} was not valid UTF-8`);
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new Error(`${label} is missing`);
    }
    if (isRecord(error) && error.code === "ELOOP") {
      throw new Error(`${label} must not be a symbolic link`);
    }
    if (error instanceof Error) throw error;
    throw new Error(`could not inspect the ${label}`, { cause: error });
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function readBoundedFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

function assertLiveCheckpointReleaseSignal(
  raw: string,
  expected: LiveCheckpointReleaseSignal,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("live release signal was malformed");
  }
  if (!isRecord(parsed)) {
    throw new Error("live release signal was malformed");
  }
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== "checkpointSha256" ||
    keys[1] !== "evidenceSha256" ||
    keys[2] !== "kind" ||
    keys[3] !== "nonce" ||
    keys[4] !== "runId" ||
    parsed.kind !== LIVE_RELEASE_SIGNAL_KIND ||
    typeof parsed.runId !== "string" ||
    typeof parsed.nonce !== "string" ||
    !LIVE_CHECKPOINT_NONCE_RE.test(parsed.nonce) ||
    typeof parsed.evidenceSha256 !== "string" ||
    typeof parsed.checkpointSha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(parsed.evidenceSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(parsed.checkpointSha256)
  ) {
    throw new Error("live release signal was malformed");
  }
  if (
    parsed.runId !== expected.runId ||
    parsed.nonce !== expected.nonce ||
    parsed.evidenceSha256 !== expected.evidenceSha256 ||
    parsed.checkpointSha256 !== expected.checkpointSha256
  ) {
    throw new Error("live release signal was stale or for a different run");
  }
}

async function consumeReleaseSignal(
  path: string,
  expected: LiveCheckpointReleaseSignal,
  beforeConsume: () => Promise<void>,
): Promise<LiveCheckpointAttestation["release"] | undefined> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let openedMetadata: Stats | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    openedMetadata = await handle.stat();
    assertSafeReleaseSignalMetadata(openedMetadata);
    if (openedMetadata.size > MAX_RELEASE_SIGNAL_BYTES) {
      throw new Error("live release signal was too large");
    }
    const bytes = await readBoundedFileHandle(handle, MAX_RELEASE_SIGNAL_BYTES);
    if (bytes.byteLength > MAX_RELEASE_SIGNAL_BYTES) {
      throw new Error("live release signal was too large");
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("live release signal was malformed");
    }
    assertLiveCheckpointReleaseSignal(raw, expected);
    await beforeConsume();

    const currentMetadata = await lstat(path);
    assertSafeReleaseSignalMetadata(currentMetadata);
    if (
      currentMetadata.dev !== openedMetadata.dev ||
      currentMetadata.ino !== openedMetadata.ino ||
      currentMetadata.size !== openedMetadata.size ||
      currentMetadata.mtimeMs !== openedMetadata.mtimeMs
    ) {
      throw new Error("live release signal changed during validation");
    }
    try {
      await unlink(path);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw new Error("could not consume the live release signal", {
        cause: error,
      });
    }
    return {
      signal: expected,
      signalSha256: digestBytes(Buffer.from(raw, "utf8")),
      releasedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    if (isRecord(error) && error.code === "ELOOP") {
      throw new Error("live release signal must not be a symbolic link");
    }
    if (error instanceof Error) throw error;
    throw new Error("could not inspect the live release signal", {
      cause: error,
    });
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function verifyLiveScreenshot(
  path: string,
  notBefore: string,
): Promise<LiveScreenshotEvidence> {
  assertExternalOwnerPath(path, LIVE_SCREENSHOT_ENV);
  await assertOutsideGitWorktree(path, LIVE_SCREENSHOT_ENV);
  await assertNoSymlinkInAncestors(
    dirname(path),
    "live screenshot parent directory",
  );
  const parentMetadata = await lstat(dirname(path));
  if (!parentMetadata.isDirectory()) {
    throw new Error("live screenshot parent must be a directory");
  }
  assertOwnerOnlyDirectory(parentMetadata, "live screenshot parent directory");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw new Error("live screenshot must be a regular file");
    }
    assertOwnerOnlyFile(openedMetadata, "live screenshot");
    if (openedMetadata.nlink !== 1) {
      throw new Error("live screenshot must not be hard-linked");
    }
    if (
      openedMetadata.size < 33 ||
      openedMetadata.size > MAX_SCREENSHOT_BYTES
    ) {
      throw new Error("live screenshot PNG size was invalid");
    }
    if (openedMetadata.mtimeMs < Date.parse(notBefore)) {
      throw new Error("live screenshot was not captured for this checkpoint");
    }
    const bytes = await readBoundedFileHandle(handle, MAX_SCREENSHOT_BYTES);
    if (
      bytes.byteLength !== openedMetadata.size ||
      bytes.byteLength > MAX_SCREENSHOT_BYTES
    ) {
      throw new Error("live screenshot changed during verification");
    }
    const currentMetadata = await lstat(path);
    if (
      currentMetadata.dev !== openedMetadata.dev ||
      currentMetadata.ino !== openedMetadata.ino ||
      currentMetadata.size !== openedMetadata.size ||
      currentMetadata.mtimeMs !== openedMetadata.mtimeMs
    ) {
      throw new Error("live screenshot changed during verification");
    }
    if (!currentMetadata.isFile()) {
      throw new Error("live screenshot must be a regular file");
    }
    assertOwnerOnlyFile(currentMetadata, "live screenshot");
    if (currentMetadata.nlink !== 1) {
      throw new Error("live screenshot must not be hard-linked");
    }
    assertPngEvidence(bytes);
    return {
      kind: "external-owner-png@v1",
      sha256: digestBytes(bytes),
      bytes: bytes.byteLength,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      capturedAt: new Date(openedMetadata.mtimeMs).toISOString(),
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new Error("live screenshot PNG is missing");
    }
    if (isRecord(error) && error.code === "ELOOP") {
      throw new Error("live screenshot must not be a symbolic link");
    }
    if (error instanceof Error) throw error;
    throw new Error("could not verify the live screenshot PNG", {
      cause: error,
    });
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function assertPngEvidence(bytes: Buffer): void {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const hasIhdr =
    bytes.readUInt32BE(8) === 13 &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0;
  const iend = bytes.subarray(-12);
  const hasIend =
    iend.readUInt32BE(0) === 0 &&
    iend.subarray(4, 8).toString("ascii") === "IEND";
  if (!bytes.subarray(0, 8).equals(signature) || !hasIhdr || !hasIend) {
    throw new Error("live screenshot was not a complete PNG");
  }
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

  const expected = [...CURRENT_RESOURCE_TYPES].sort();
  const actual = resources.map((resource) => resource.type).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `tofu state did not contain the current 13-resource graph (got ${actual.join(",") || "none"})`,
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
      "takoform_resource_ids output did not contain all 13 current resources",
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
  const exact: Partial<
    Record<(typeof CURRENT_RESOURCE_ID_KEYS)[number], string>
  > = {
    worker: "takoform_module_worker",
    worker_bundle: "takoform_worker_bundle",
    worker_version: "takoform_worker_version",
    worker_deployment: "takoform_worker_deployment",
    worker_endpoint: "takoform_worker_endpoint",
    database: "takoform_sqlite_database",
    migration_set: "takoform_sqlite_migration_set",
    migration_application: "takoform_sqlite_migration_application",
    kv: "takoform_edge_kv_namespace",
    delivery_consumer: "takoform_queue_consumer",
    retention: "takoform_worker_cron_trigger",
  };
  if (key === "delivery" || key === "delivery_dlq") {
    return (
      identity.type === "takoform_at_least_once_queue" &&
      identity.name.endsWith(key === "delivery" ? "-delivery" : "-delivery-dlq")
    );
  }
  return identity.type === exact[key];
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
  if (!/version\s*=\s*"= 3\.0\.0"/u.test(mainText)) {
    throw new Error("Takoform module no longer pins Provider 3.0.0 exactly");
  }
  const workerPath = join(sourceRoot, ".generated", GENERATED_WORKER_FILE);
  await assertRegularFile(workerPath, "generated Yurucommu Worker");
  const workerBytes = await readFile(workerPath);
  const migrationRoot = join(
    sourceRoot,
    SOURCE_MIGRATIONS_DIR,
    SOURCE_MIGRATIONS_SQL_DIR,
  );
  const migrationEntries = (
    await readdir(migrationRoot, { withFileTypes: true })
  )
    .map((entry) => entry.name)
    .sort();
  const migrations = [];
  for (const name of migrationEntries) {
    if (!MIGRATION_FILE_RE.test(name)) {
      throw new Error(`unexpected tracked migration entry: ${name}`);
    }
    const migrationPath = join(migrationRoot, name);
    await assertRegularFile(migrationPath, `tracked migration ${name}`);
    const bytes = await readFile(migrationPath);
    migrations.push({
      path: `${SOURCE_MIGRATIONS_DIR}/${SOURCE_MIGRATIONS_SQL_DIR}/${name}`,
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
    providerConstraint: "= 3.0.0",
  };
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function main(): Promise<void> {
  const config = readTakoformV1E2EConfig(process.env);
  // Validate the opt-in pause target before creating a workdir or attempting
  // any Provider mutation. The default path remains a no-op.
  const liveCheckpointTarget = config.liveCheckpoint
    ? await prepareLiveCheckpointTarget(config.liveCheckpoint)
    : undefined;
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
  let liveCheckpointAttestation: LiveCheckpointAttestation | undefined;

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
      );
      requireReadyType(
        hostResources,
        "takoform_queue_consumer",
        "queue consumer",
      );
      requireReadyType(
        hostResources,
        "takoform_worker_cron_trigger",
        "cron trigger",
      );
      requireReadyType(
        hostResources,
        "takoform_worker_version",
        "WorkerVersion",
      );

      const standardService = await readStandardServiceSupport(
        hostDiscovery,
        config,
      );
      const runtimeBase = config.diagnosticRuntimeEndpoint ?? launchUrl;
      probes = {
        hostResourceReadback: {
          count: hostResources.length,
          ready: hostResources.length,
          graph: "Provider 3.0.0/current-13-resources",
        },
        migrationBackedHealth: await probeRuntime(runtimeBase),
        standardService,
        nativeHandlers: {
          queueConsumer: "Ready=True resource evidence",
          cronTrigger: "Ready=True resource evidence",
          invocationCounters: "not exposed by portable Host API v1",
        },
      };
      if (liveCheckpointTarget) {
        if (!sourceProvenance || !providerSchemaProof) {
          throw new Error(
            "cannot create live checkpoint without source and Provider provenance",
          );
        }
        const checkpointEvidence = buildLiveCheckpointEvidence({
          runId: projectName,
          capsule: {
            source: sourceProvenance,
            provider: {
              source: PROVIDER_SOURCE,
              sha256: config.providerSha256,
              schema: providerSchemaProof,
            },
          },
          run: {
            resourceCount: identities.length,
            screenshotExpected: Boolean(liveCheckpointTarget.screenshotPath),
          },
          runtime: {
            launchUrl,
            apiUrl,
            probeUrl: absoluteHttpUrl(
              runtimeBase,
              "live checkpoint runtime probe URL",
            ).toString(),
            endpointClassification: config.diagnosticRuntimeEndpoint
              ? "test-only-loopback-diagnostic"
              : "assigned-worker-endpoint",
          },
        });
        liveCheckpointAttestation = await runLiveCheckpointGate(
          liveCheckpointTarget,
          checkpointEvidence,
          {
            postReleaseRuntimeReadback: (signal) =>
              probeRuntime(runtimeBase, signal),
          },
        );
        probes = {
          ...probes,
          postReleaseRuntimeReadback:
            liveCheckpointAttestation.postReleaseRuntimeReadback.evidence,
        };
      }
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
            "cannot verify authoritative absence without all 13 applied identities",
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
        ...(liveCheckpointAttestation
          ? { liveCheckpoint: liveCheckpointAttestation }
          : {}),
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
    SOURCE_MIGRATIONS_DIR,
    ".generated",
  ]);
  for (const entry of entries) {
    if (!allowedRootEntries.has(entry.name)) {
      throw new Error(`unexpected Takoform module source entry: ${entry.name}`);
    }
    if (entry.name === ".generated") continue;
    const entryPath = join(sourceRoot, entry.name);
    if (
      entry.name === SOURCE_MIGRATIONS_DIR ||
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
  const allowedGeneratedEntries = new Set([GENERATED_WORKER_FILE]);
  for (const entry of generatedEntries) {
    if (!allowedGeneratedEntries.has(entry.name)) {
      throw new Error(
        `unexpected generated Takoform source entry: ${entry.name}`,
      );
    }
  }
  const generatedWorker = join(generatedRoot, GENERATED_WORKER_FILE);
  await assertRegularFile(generatedWorker, "generated Yurucommu Worker");
  await mkdir(join(workdir, ".generated"), { recursive: true });
  await copyFile(
    generatedWorker,
    join(workdir, ".generated", GENERATED_WORKER_FILE),
  );

  const migrationsContainer = join(sourceRoot, SOURCE_MIGRATIONS_DIR);
  const migrationContainerEntries = await readdir(migrationsContainer, {
    withFileTypes: true,
  });
  const allowedMigrationRootEntries = new Set<string>(
    SOURCE_MIGRATION_ROOT_ENTRIES,
  );
  for (const entry of migrationContainerEntries) {
    if (!allowedMigrationRootEntries.has(entry.name)) {
      throw new Error(
        `unexpected Takoform migration source entry: ${entry.name}`,
      );
    }
  }
  await assertRegularFile(
    join(migrationsContainer, "schema-bundle.json"),
    "Takoform migration schema bundle",
  );
  await assertRegularDirectory(
    join(migrationsContainer, "takoform-overrides"),
    "Takoform migration overrides",
  );

  const migrationsRoot = join(migrationsContainer, SOURCE_MIGRATIONS_SQL_DIR);
  const migrationsMetadata = await lstat(migrationsRoot);
  if (
    migrationsMetadata.isSymbolicLink() ||
    !migrationsMetadata.isDirectory()
  ) {
    throw new Error("tracked migration source must be a regular directory");
  }
  const migrationEntries = await readdir(migrationsRoot, {
    withFileTypes: true,
  });
  if (migrationEntries.length === 0) {
    throw new Error("tracked migration source is empty");
  }
  await mkdir(join(workdir, SOURCE_MIGRATIONS_DIR, SOURCE_MIGRATIONS_SQL_DIR), {
    recursive: true,
  });
  for (const entry of migrationEntries) {
    if (!MIGRATION_FILE_RE.test(entry.name)) {
      throw new Error(`unexpected tracked migration entry: ${entry.name}`);
    }
    const sourcePath = join(migrationsRoot, entry.name);
    await assertRegularFile(sourcePath, `tracked migration ${entry.name}`);
    if (options.repositoryRoot) {
      await assertTrackedSourcePath(
        options.repositoryRoot,
        join(
          "deploy",
          "takoform",
          SOURCE_MIGRATIONS_DIR,
          SOURCE_MIGRATIONS_SQL_DIR,
          entry.name,
        ),
        options.environment ?? buildSafeChildEnvironment(process.env),
        options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      );
    }
    await copyFile(
      sourcePath,
      join(
        workdir,
        SOURCE_MIGRATIONS_DIR,
        SOURCE_MIGRATIONS_SQL_DIR,
        entry.name,
      ),
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
  providerVersion: "3.0.0",
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
  providerVersion: "3.0.0",
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
    versionConstraint: "= 3.0.0",
    protocolSchemaVersion,
    resourceKinds,
  };
}

export async function readProviderVersion(
  providerBinary: string,
  environment: Record<string, string | undefined>,
  cwd: string,
  timeoutMs: number,
): Promise<"3.0.0"> {
  const result = await runBoundedChild([providerBinary, "-version"], {
    cwd,
    environment,
    timeoutMs,
    label: "Takoform Provider version handshake",
  });
  if (result.timedOut || result.outputTruncated || result.exitCode !== 0) {
    throw new Error("Takoform Provider version handshake failed");
  }
  if (result.stdout.trim() !== "3.0.0") {
    throw new Error("Takoform Provider binary did not report version 3.0.0");
  }
  return "3.0.0";
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

async function readStandardServiceSupport(
  discovery: StableHostDiscovery,
  config: TakoformV1E2EConfig,
): Promise<Record<string, unknown>> {
  const url = `${discovery.apiBase}/support/standard-services/${encodeURIComponent("com.amazonaws.s3")}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.evidenceToken}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await responseJson(response, "S3 standard-service support", 200);
  if (
    !isRecord(body) ||
    body.kind !== "StandardServiceSupport" ||
    body.satisfiable !== true ||
    !isRecord(body.serviceRef) ||
    body.serviceRef.protocol !== STANDARD_SERVICE_PROTOCOL
  ) {
    throw new Error(
      "Host did not report a satisfiable com.amazonaws.s3 standard service",
    );
  }
  return {
    kind: "StandardServiceSupport",
    protocol: STANDARD_SERVICE_PROTOCOL,
    satisfiable: true,
  };
}

async function probeRuntime(
  runtimeBase: string,
  signal?: AbortSignal,
): Promise<RuntimeProbeEvidence> {
  const base = absoluteHttpUrl(runtimeBase, "runtime endpoint");
  const health = await runtimeJson(base, HEALTH_PATH, "healthz", signal);
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
  const ready = await runtimeJson(base, READINESS_PATH, "readyz", signal);
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
    signal,
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
    signal,
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
  return sanitizeRuntimeProbeEvidence({
    healthz: { status: health.status, missingBindings: health.missingBindings },
    readyz: { status: ready.status, missingBindings: ready.missingBindings },
    socialServer: { product: social.product },
    nodeinfo: {
      software: nodeinfo.software.name,
      users: nodeinfo.usage.users.total,
      localPosts: nodeinfo.usage.localPosts,
    },
  });
}

function sanitizeRuntimeProbeEvidence(value: unknown): RuntimeProbeEvidence {
  if (
    !isRecord(value) ||
    !isRecord(value.healthz) ||
    value.healthz.status !== "ok" ||
    !Array.isArray(value.healthz.missingBindings) ||
    value.healthz.missingBindings.some(
      (binding: unknown) => typeof binding !== "string",
    ) ||
    !isRecord(value.readyz) ||
    value.readyz.status !== "ok" ||
    !Array.isArray(value.readyz.missingBindings) ||
    value.readyz.missingBindings.some(
      (binding: unknown) => typeof binding !== "string",
    ) ||
    !isRecord(value.socialServer) ||
    value.socialServer.product !== "yurucommu" ||
    !isRecord(value.nodeinfo) ||
    value.nodeinfo.software !== "yurucommu" ||
    !Number.isSafeInteger(value.nodeinfo.users) ||
    !Number.isSafeInteger(value.nodeinfo.localPosts)
  ) {
    throw new Error("post-release runtime readback evidence was invalid");
  }
  return {
    healthz: {
      status: "ok",
      missingBindings: [...value.healthz.missingBindings],
    },
    readyz: {
      status: "ok",
      missingBindings: [...value.readyz.missingBindings],
    },
    socialServer: { product: "yurucommu" },
    nodeinfo: {
      software: "yurucommu",
      users: value.nodeinfo.users,
      localPosts: value.nodeinfo.localPosts,
    },
  };
}

async function runtimeJson(
  base: URL,
  pathname: string,
  label: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(new URL(pathname, base), {
    method: "GET",
    headers: { accept: "application/json", "cache-control": "no-store" },
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  return responseJson(response, label, 200);
}

function requireReadyType(
  resources: readonly Record<string, unknown>[],
  type: string,
  label: string,
): void {
  const matches = resources.filter(
    (resource) => resource.kind === kindFromType(type),
  );
  if (matches.length !== 1)
    throw new Error(`Host readback did not contain one ${label}`);
  assertReadyResource(matches[0], label);
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
    if (terminationRequest) {
      for (const listener of [...terminationListeners]) {
        listener(terminationRequest);
      }
    }
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
