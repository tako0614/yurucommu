import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const PROBE_PATH = "/__takoform_v1_fetch_probe";
const PROBE_KIND = "yurucommu.takoform-v1-fetch-probe@v1";
const PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";

type Environment = Readonly<Record<string, string | undefined>>;

export interface TakoformV1E2EConfig {
  readonly endpoint: string;
  readonly space: string;
  readonly token: string;
  readonly providerBinary: string;
  readonly providerSha256: string;
  readonly diagnosticRuntimeEndpoint?: string;
}

export interface LocalProviderAuthority {
  readonly providerBinary: string;
  readonly providerSha256: string;
}

export function readLocalProviderAuthority(
  environment: Environment,
): LocalProviderAuthority {
  const providerBinary = environment.TAKOFORM_PROVIDER_BINARY?.trim() ?? "";
  const providerSha256 = environment.TAKOFORM_PROVIDER_SHA256?.trim() ?? "";
  if (!providerBinary || !providerSha256) {
    throw new Error(
      "TAKOFORM_PROVIDER_BINARY and TAKOFORM_PROVIDER_SHA256 are required; unpublished Provider bytes are explicit tracer authority",
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
  const token = environment.TAKOFORM_TOKEN?.trim() ?? "";
  const diagnosticInput =
    environment.TAKOFORM_DIAGNOSTIC_RUNTIME_ENDPOINT?.trim() ?? "";
  if (!endpointInput || !space || !token) {
    throw new Error(
      "TAKOFORM_ENDPOINT, TAKOFORM_SPACE, and TAKOFORM_TOKEN are required; the fetch tracer never skips when Host authority is absent",
    );
  }
  const provider = readLocalProviderAuthority(environment);

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpointInput);
  } catch {
    throw new Error("TAKOFORM_ENDPOINT must be an absolute HTTP(S) URL");
  }
  if (endpointUrl.username || endpointUrl.password) {
    throw new Error("TAKOFORM_ENDPOINT must not contain credentials");
  }
  if (endpointUrl.search || endpointUrl.hash) {
    throw new Error("TAKOFORM_ENDPOINT must not contain a query or fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    endpointUrl.hostname,
  );
  if (endpointUrl.protocol !== "https:" && !loopback) {
    throw new Error("TAKOFORM_ENDPOINT must use HTTPS unless it is loopback");
  }
  if (endpointUrl.protocol !== "https:" && endpointUrl.protocol !== "http:") {
    throw new Error("TAKOFORM_ENDPOINT must be an absolute HTTP(S) URL");
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
    diagnosticRuntimeEndpoint = diagnostic.toString().replace(/\/$/, "");
  }

  return {
    endpoint: endpointUrl.toString().replace(/\/$/, ""),
    space,
    token,
    ...provider,
    ...(diagnosticRuntimeEndpoint ? { diagnosticRuntimeEndpoint } : {}),
  };
}

export async function prepareProviderDevOverride(
  config: LocalProviderAuthority,
  workdir: string,
): Promise<{ readonly cliConfigPath: string }> {
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
  return { cliConfigPath };
}

export async function assertFetchProbeResponse(
  response: Response,
  expectedNonce: string,
): Promise<void> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(
      `fetch-only Worker request returned HTTP ${response.status}, expected 200`,
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new Error("fetch-only Worker response was not JSON");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("fetch-only Worker returned invalid JSON");
  }
  if (!isRecord(body) || body.kind !== PROBE_KIND) {
    throw new Error("fetch-only Worker returned the wrong probe identity");
  }
  if (body.nonce !== expectedNonce) {
    throw new Error("fetch-only Worker did not echo this run's nonce");
  }
}

export async function main(): Promise<void> {
  const config = readTakoformV1E2EConfig(process.env);
  const fixture = new URL(
    "../deploy/takoform/e2e/fetch-only/",
    import.meta.url,
  );
  const workdir = await mkdtemp(join(tmpdir(), "yurucommu-takoform-v1-"));
  const name = `yurucommu-e2e-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const nonce = crypto.randomUUID();
  const tofuEnvironment: Record<string, string | undefined> = {
    ...process.env,
    TAKOFORM_ENDPOINT: config.endpoint,
    TAKOFORM_SPACE: config.space,
    TAKOFORM_TOKEN: config.token,
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_DISABLE: "1",
  };
  let mutationAttempted = false;
  let cleanupVerified = false;
  let primaryError: unknown;
  let endpointUrl = "";

  await Promise.all([
    copyFile(new URL("main.tf", fixture), join(workdir, "main.tf")),
    copyFile(new URL("worker.mjs", fixture), join(workdir, "worker.mjs")),
  ]);

  try {
    const providerOverride = await prepareProviderDevOverride(config, workdir);
    tofuEnvironment.TF_CLI_CONFIG_FILE = providerOverride.cliConfigPath;
    mutationAttempted = true;
    await runTofu(
      [
        "apply",
        "-auto-approve",
        "-input=false",
        "-no-color",
        `-var=name=${name}`,
        `-var=probe_nonce=${nonce}`,
      ],
      { workdir, environment: tofuEnvironment },
    );
    endpointUrl = (
      await runTofu(["output", "-raw", "endpoint_url"], {
        workdir,
        environment: tofuEnvironment,
        captureStdout: true,
      })
    ).trim();
    const publicUrl = new URL(endpointUrl);
    if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/") {
      throw new Error(
        "WorkerEndpoint.url was not the stable assigned HTTPS path root",
      );
    }
    const runtimeUrl = config.diagnosticRuntimeEndpoint
      ? new URL(config.diagnosticRuntimeEndpoint)
      : publicUrl;
    const response = await fetch(new URL(PROBE_PATH, runtimeUrl), {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-store" },
      signal: AbortSignal.timeout(30_000),
    });
    await assertFetchProbeResponse(response, nonce);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  if (mutationAttempted) {
    try {
      await runTofu(
        [
          "destroy",
          "-auto-approve",
          "-input=false",
          "-no-color",
          `-var=name=${name}`,
          `-var=probe_nonce=${nonce}`,
        ],
        { workdir, environment: tofuEnvironment },
      );
      cleanupVerified = true;
    } catch (error) {
      cleanupError = new Error(
        `fetch tracer cleanup failed; recovery state is preserved at ${workdir}`,
        { cause: error },
      );
    }
  }

  if (!cleanupError) {
    await rm(workdir, { recursive: true, force: true });
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "fetch tracer and cleanup both failed",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (!cleanupVerified) {
    throw new Error("fetch tracer did not verify resource cleanup");
  }

  console.log(
    JSON.stringify({
      kind: "yurucommu.takoform-v1-e2e@v1",
      status: "passed",
      phase: "fetch-only",
      provider: PROVIDER_SOURCE,
      endpointUrl,
      trafficEndpointClassification: config.diagnosticRuntimeEndpoint
        ? "test-only-loopback-diagnostic"
        : "assigned-worker-endpoint",
      cleanupVerified,
    }),
  );
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

async function runTofu(
  args: readonly string[],
  options: {
    readonly workdir: string;
    readonly environment: Record<string, string | undefined>;
    readonly captureStdout?: boolean;
  },
): Promise<string> {
  const child = Bun.spawn(["tofu", ...args], {
    cwd: options.workdir,
    env: options.environment,
    stdin: "ignore",
    stdout: options.captureStdout ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const stdoutPromise = options.captureStdout
    ? new Response(child.stdout).text()
    : Promise.resolve("");
  const [exitCode, stdout] = await Promise.all([child.exited, stdoutPromise]);
  if (exitCode !== 0) {
    throw new Error(
      `tofu ${args[0] ?? "command"} failed with exit ${exitCode}`,
    );
  }
  return stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  await main();
}
