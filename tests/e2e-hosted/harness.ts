import { readFileSync } from "node:fs";
import { main as ownerLifecycle } from "../../scripts/takoform-v1-e2e-full.ts";

const API = "/apis/forms.takoform.com/v1";
const DISCOVERY = "/.well-known/takoform/v1";
// These are staging selectors, never a configurable arbitrary-origin allowlist.
export const STAGING_ORIGINS = [
  "https://api-staging.takoserver.com",
  "https://takoserver-staging.takos.jp",
] as const;

type FormRef = {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
};
const profile = JSON.parse(
  readFileSync(
    new URL("../../deploy/takoform/host-support-profile.json", import.meta.url),
    "utf8",
  ),
);
export const WORKER_FORM: FormRef = profile.host.declaredForms.find(
  (form: Record<string, unknown>) =>
    form.resourceType === "takoform_worker_version",
);
if (
  !WORKER_FORM ||
  WORKER_FORM.kind !== "WorkerVersion" ||
  WORKER_FORM.apiVersion !== "edge.forms.takoform.com" ||
  !/^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(WORKER_FORM.definitionVersion) ||
  !/^sha256:[a-f0-9]{64}$/u.test(WORKER_FORM.schemaDigest)
)
  throw new Error("PINNED_WORKER_PROFILE_0_X_REQUIRED");

type Environment = Record<string, string | undefined>;
type Transport = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
export interface Config {
  readonly environment: "staging";
  readonly origin: string;
  readonly workerVersion: string;
  readonly space: string;
  readonly dryRun: boolean;
  readonly childEnv: Environment;
}

export class HarnessError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function refuse(code: string): never {
  throw new HarnessError(code);
}
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only the flag is read from argv; credential material is accepted in env. */
export function readConfig(argv: readonly string[], env: Environment): Config {
  if (
    argv.length > 1 ||
    (argv[0] && !["--dry-run", "--execute"].includes(argv[0]))
  )
    refuse("INVALID_ARGUMENTS");
  const dryRun = argv[0] !== "--execute";
  const environment =
    env.YURUCOMMU_HOSTED_E2E_ENVIRONMENT ?? (dryRun ? "staging" : "");
  const origin = env.TAKOFORM_ENDPOINT ?? (dryRun ? STAGING_ORIGINS[0] : "");
  const workerVersion =
    env.YURUCOMMU_HOSTED_E2E_WORKER_VERSION ??
    (dryRun ? WORKER_FORM.definitionVersion : "");
  const space = env.TAKOFORM_SPACE ?? (dryRun ? "yurucommu-e2e-dryrun" : "");
  if (environment !== "staging") refuse("PRODUCTION_FORBIDDEN");
  if (!STAGING_ORIGINS.some((allowed) => allowed === origin))
    refuse("STAGING_ORIGIN_REQUIRED");
  if (workerVersion !== WORKER_FORM.definitionVersion)
    refuse("PINNED_WORKER_VERSION_0_X_REQUIRED");
  if (!/^yurucommu-e2e-[a-z0-9]{1,16}$/u.test(space))
    refuse("DISPOSABLE_SPACE_REQUIRED");
  // Prevent alternate URLs, OIDC journeys, Terraform logging, and provider overrides.
  for (const key of [
    "TAKOFORM_DIAGNOSTIC_RUNTIME_ENDPOINT",
    "TAKOFORM_USER_JOURNEY",
    "YURU_OIDC_ISSUER_URL",
    "YURU_OIDC_HANDOFF_FILE",
    "TF_LOG",
    "TF_LOG_PATH",
    "DEBUG",
    "PWDEBUG",
  ]) {
    if (env[key]) refuse("UNSAFE_OVERRIDE_FORBIDDEN");
  }
  const childEnv: Environment = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TZ",
    "TAKOFORM_PROVIDER_BINARY",
    "TAKOFORM_PROVIDER_SHA256",
    "TAKOFORM_E2E_TIMEOUT_SECONDS",
    "TAKOFORM_TOKEN",
    "TAKOFORM_EVIDENCE_TOKEN",
  ]) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  childEnv.TAKOFORM_SPACE = space;
  if (!dryRun) {
    if (
      !childEnv.TAKOFORM_TOKEN ||
      !childEnv.TAKOFORM_EVIDENCE_TOKEN ||
      childEnv.TAKOFORM_TOKEN === childEnv.TAKOFORM_EVIDENCE_TOKEN
    )
      refuse("DISTINCT_ENV_CREDENTIALS_REQUIRED");
    if (
      !childEnv.TAKOFORM_PROVIDER_BINARY ||
      !/^sha256:[a-f0-9]{64}$/u.test(childEnv.TAKOFORM_PROVIDER_SHA256 ?? "")
    )
      refuse("PINNED_PROVIDER_REQUIRED");
  }
  return {
    environment: "staging",
    origin,
    workerVersion,
    space,
    dryRun,
    childEnv,
  };
}

/** Read the selected 0.x Form before the existing owner can start apply. */
export async function preflightWorkerVersion(
  config: Config,
  transport: Transport,
): Promise<void> {
  const query = new URLSearchParams({
    space: config.space,
    group: "edge.forms.takoform.com",
    kind: WORKER_FORM.kind,
    definitionVersion: config.workerVersion,
    schemaDigest: WORKER_FORM.schemaDigest,
  });
  const response = await transport(
    new URL(`${API}/forms?${query}`, config.origin),
    {
      headers: {
        authorization: `Bearer ${config.childEnv.TAKOFORM_EVIDENCE_TOKEN}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status !== 200 || response.redirected)
    refuse("WORKER_PREFLIGHT_FAILED");
  const value = await response.json();
  const entries =
    record(value) && Array.isArray(value.forms) ? value.forms : [];
  const entry =
    entries.length === 1 && record(entries[0]) ? entries[0] : undefined;
  const ref = entry?.identity?.formRef;
  if (
    !record(ref) ||
    ref.apiVersion !== "edge.forms.takoform.com" ||
    ref.kind !== "WorkerVersion" ||
    ref.definitionVersion !== config.workerVersion ||
    ref.schemaDigest !== WORKER_FORM.schemaDigest
  )
    refuse("WORKER_PREFLIGHT_IDENTITY_MISMATCH");
  for (const key of [
    "definitionKnown",
    "installed",
    "executable",
    "activated",
    "availableToPrincipal",
  ])
    if (entry?.[key] !== true) refuse("WORKER_PREFLIGHT_UNAVAILABLE");
  if (
    !Array.isArray(entry?.operations) ||
    !["create", "update", "delete"].every((operation) =>
      entry.operations.includes(operation),
    )
  )
    refuse("WORKER_PREFLIGHT_UNAVAILABLE");
}

/** Owner JS reads only the selected host or a fresh staging app, never redirects. */
export function guardedFetch(config: Config, transport: Transport): Transport {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.pathname.includes("%") ||
      request.method !== "GET"
    )
      refuse("HTTP_TARGET_FORBIDDEN");
    if (url.origin === config.origin) {
      if (
        url.pathname !== DISCOVERY &&
        (!url.pathname.startsWith(`${API}/resources/`) ||
          url.searchParams.getAll("space").length !== 1 ||
          url.searchParams.get("space") !== config.space)
      )
        refuse("HOST_READ_TARGET_FORBIDDEN");
      if (
        url.pathname.includes("/WorkerVersion/") &&
        (url.searchParams.getAll("definitionVersion").length !== 1 ||
          url.searchParams.get("definitionVersion") !== config.workerVersion ||
          url.searchParams.getAll("schemaDigest").length !== 1 ||
          url.searchParams.get("schemaDigest") !== WORKER_FORM.schemaDigest)
      )
        refuse("WORKER_VERSION_MISMATCH");
      if (
        request.headers.get("authorization") !==
          `Bearer ${config.childEnv.TAKOFORM_EVIDENCE_TOKEN}` ||
        request.headers.has("cookie")
      )
        refuse("HOST_READ_CREDENTIAL_FORBIDDEN");
    } else if (
      url.protocol !== "https:" ||
      url.port ||
      !/^yurucommu-e2e-[a-f0-9]{12}\.app-staging\.takos\.jp$/u.test(
        url.hostname,
      ) ||
      request.headers.has("authorization") ||
      request.headers.has("cookie") ||
      ![
        "/healthz",
        "/readyz",
        "/.well-known/social-server",
        "/nodeinfo/2.0",
      ].includes(url.pathname) ||
      url.search
    )
      refuse("RUNTIME_PRODUCTION_OR_REDIRECT_FORBIDDEN");
    const response = await transport(request, { redirect: "error" });
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    )
      refuse("REDIRECT_FORBIDDEN");
    return response;
  };
}

/** Reuse the owner install lifecycle; this does not publish an official surface. */
export async function runHarness(
  config: Config,
  dependencies: { transport?: Transport; lifecycle?: () => Promise<void> } = {},
) {
  const report = {
    kind: "yurucommu.hosted-e2e@v1",
    environment: config.environment,
    origin: config.origin,
    workerVersion: config.workerVersion,
    space: config.space,
  };
  if (config.dryRun)
    return {
      ...report,
      status: "dry-run",
      steps: [
        "0.x preflight",
        "deploy",
        "health",
        "teardown",
        "authoritative absence",
      ],
      mutation: false,
    };
  const originalFetch = globalThis.fetch;
  const originalEnvironment = process.env;
  const originalLog = console.log;
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
    trace: console.trace,
  };
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const transport = dependencies.transport ?? originalFetch.bind(globalThis);
  let ownerPassed = false;
  try {
    await preflightWorkerVersion(config, transport);
    // Preserve canonicalPublicOrigin: the pinned Provider talks directly to staging.
    process.env = { ...config.childEnv, TAKOFORM_ENDPOINT: config.origin };
    globalThis.fetch = guardedFetch(config, transport) as typeof fetch;
    for (const method of ["error", "warn", "info", "debug", "trace"] as const)
      console[method] = () => undefined;
    const discard: typeof process.stdout.write = (...args: any[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") callback();
      return true;
    };
    process.stdout.write = discard;
    process.stderr.write = discard;
    console.log = (...args: unknown[]) => {
      // Never forward owner diagnostics or payloads. Project only a boolean.
      if (args.length !== 1 || typeof args[0] !== "string") return;
      try {
        const value = JSON.parse(args[0]);
        ownerPassed =
          value.kind === "yurucommu.takoform-v1-e2e@v3" &&
          value.status === "passed" &&
          value.phase === "full-lifecycle" &&
          value.cleanupVerified === true &&
          value.authoritativeAbsenceVerified === true &&
          value.resourceCount === 15;
      } catch {
        /* all unstructured owner output is suppressed */
      }
    };
    await (dependencies.lifecycle ?? ownerLifecycle)();
    if (!ownerPassed) refuse("OWNER_LIFECYCLE_PROOF_MISSING");
    return {
      ...report,
      status: "passed",
      resourceCount: 15,
      cleanupVerified: true,
      authoritativeAbsenceVerified: true,
    };
  } catch (error) {
    // No child stdout/stderr, response body, argv, credential, or cause escapes.
    throw new HarnessError(
      error instanceof HarnessError
        ? error.code
        : "OWNER_LIFECYCLE_FAILED_RECOVERY_STATE_RETAINED",
    );
  } finally {
    console.log = originalLog;
    Object.assign(console, originalConsole);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    globalThis.fetch = originalFetch;
    process.env = originalEnvironment;
  }
}
