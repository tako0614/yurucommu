export type WorkerEnvironment = "production";

export type WorkerDeployTarget = {
  kind: "yurucommu.worker-deploy-target@v1";
  environment: WorkerEnvironment;
  accountId: string;
  workerName: "yurucommu";
  publicOrigin: "https://test.yurucommu.com";
  route: {
    kind: "custom-domain";
    hostname: "test.yurucommu.com";
  };
  config: {
    path: string;
    sha256: string;
  };
};

export type WorkerDeployment = {
  id: string;
  created_on: string;
  strategy: string;
  versions: Array<{ version_id: string; percentage: number }>;
  annotations?: Record<string, string>;
};

export type WorkerDomain = {
  hostname: string;
  service: string;
  environment: string;
};

export type WorkerVersion = {
  id: string;
  annotations?: Record<string, string>;
  resources?: Record<string, unknown> & {
    bindings?: unknown;
    script?: { etag?: string; [key: string]: unknown };
    script_runtime?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

export type WorkerProvider = {
  domains(): Promise<WorkerDomain[]>;
  activeDeployment(): Promise<WorkerDeployment>;
  version(input: { versionId: string }): Promise<WorkerVersion>;
  upload(input: {
    repo?: string;
    environment?: WorkerEnvironment;
    target?: WorkerDeployTarget;
    bundlePath?: string;
    bundleBytes: Uint8Array;
    bundleDigest?: string;
    configBytes: Uint8Array;
    configDigest?: string;
    previousVersion: WorkerVersion;
    message: string;
  }): Promise<{ versionId: string; workerName: string }>;
  deployVersion(input: {
    environment?: WorkerEnvironment;
    target?: WorkerDeployTarget;
    versionId: string;
    message: string;
  }): Promise<{ deploymentId: string; workerName: string }>;
  smoke(input: {
    environment?: WorkerEnvironment;
    target?: WorkerDeployTarget;
    versionId?: string;
    deploymentId?: string;
  }): Promise<{ status: string; [key: string]: unknown }>;
};

export type WorkerCommandResult =
  | string
  | Uint8Array
  | {
      stdout?: string | Uint8Array;
      stderr?: string | Uint8Array;
      status?: number;
      exitCode?: number;
    };

export type WorkerCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => WorkerCommandResult | Promise<WorkerCommandResult>;

export type WorkerGit = (
  args: string[],
  options?: { cwd?: string },
) => WorkerCommandResult | Promise<WorkerCommandResult>;

export type WorkerReleaseFailurePhase =
  | "PRE_UPLOAD_FAILURE"
  | "POST_UPLOAD_INDETERMINATE"
  | "POST_DEPLOY_INDETERMINATE"
  | "POST_CONDITION_INDETERMINATE";

export class YurucommuWorkerReleaseFailure extends Error {
  readonly phase: WorkerReleaseFailurePhase;
  readonly evidence: Record<string, unknown>;
  readonly provider: { stdout: string; stderr: string } | null;
}

export type WorkerReleaseResult = {
  kind: "takos.deploy-result@v1";
  surface: "yurucommu-worker";
  target: "cloudflare-worker:yurucommu";
  environment: WorkerEnvironment;
  accountId: string;
  workerName: "yurucommu";
  commit: string;
  branch: string;
  remoteRef: "origin/main";
  bundleDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
  route: "https://test.yurucommu.com";
  previousDeploymentId: string;
  previousVersionId: string;
  deploymentId: string;
  versionId: string;
  providerReadback: "EXACT_ACTIVE_DEPLOYMENT_AND_VERSION_IDENTITY";
  smoke: { status: "passed"; [key: string]: unknown };
  status: "PUBLISHED";
};

export function loadYurucommuWorkerTarget(options: {
  path: string;
  environment: WorkerEnvironment;
  repo?: string;
}): WorkerDeployTarget;

export function ownerGateEnvironment(): NodeJS.ProcessEnv;

export function assertCodeOnlyVersion(
  previous: WorkerVersion,
  candidate: WorkerVersion,
): unknown;

export function createCloudflareWorkerProvider(options: {
  repo?: string;
  target: WorkerDeployTarget;
  token?: string;
  smokePassword?: string;
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  runSmoke?: WorkerCommand;
}): WorkerProvider;

export function deployYurucommuWorker(options: {
  repo?: string;
  environment: WorkerEnvironment;
  commit: string;
  target: WorkerDeployTarget;
  git?: WorkerGit;
  check?: (input: {
    repo: string;
    environment: WorkerEnvironment;
    commit: string;
  }) => void | Promise<void>;
  provider?: Partial<WorkerProvider>;
}): Promise<WorkerReleaseResult>;

export function reportYurucommuWorkerReleaseFailure(error: unknown): void;
