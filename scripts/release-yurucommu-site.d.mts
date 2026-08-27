export type SiteEnvironment = "integration" | "production";

export type SiteReadback = {
  origin: string;
  path: string;
  status: number;
  bytes: number;
  sha256: string;
};

export type SiteReleaseResult = {
  kind: "takos.deploy-result@v1";
  surface: "yurucommu-site";
  target: "cloudflare-pages:yurucommu-website";
  environment: SiteEnvironment;
  branch: string;
  commit?: string;
  site: "site";
  siteSha256: string;
  deploymentUrl: string;
  immutableReadback: SiteReadback;
  publicReadback?: SiteReadback;
  status: "PUBLISHED";
};

export type SiteReleaseFailurePhase =
  "PRE_UPLOAD_FAILURE" | "POST_UPLOAD_INDETERMINATE";

export class YurucommuSiteReleaseFailure extends Error {
  readonly phase: SiteReleaseFailurePhase;
  readonly evidence: Record<string, unknown>;
  readonly provider: { stdout: string; stderr: string } | null;
}

export type SiteCommandResult =
  | string
  | Uint8Array
  | {
      stdout?: string | Uint8Array;
      stderr?: string | Uint8Array;
      status?: number;
      exitCode?: number;
      url?: string;
    };

export type SiteCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => SiteCommandResult | Promise<SiteCommandResult>;

export type SiteFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SiteProvider = {
  run?: SiteCommand;
  check?: (input: {
    repo: string;
    environment: SiteEnvironment;
    siteRoot: string;
  }) => void | Promise<void>;
  upload?: (input: {
    repo: string;
    environment: SiteEnvironment;
    siteRoot: string;
    branch: string;
    commit: string | null;
  }) => SiteCommandResult | Promise<SiteCommandResult>;
  readback?: (input: {
    origin: string;
    path: "/";
    expected: { bytes: number; sha256: string };
  }) => SiteReadback | Promise<SiteReadback>;
};

export function parsePagesDeploymentUrl(result: SiteCommandResult): string;

export function deployYurucommuSite(options: {
  repo?: string;
  environment: SiteEnvironment;
  run?: SiteCommand;
  git?: (args: string[]) => SiteCommandResult | Promise<SiteCommandResult>;
  fetchImpl?: SiteFetch;
  provider?: SiteProvider;
}): Promise<SiteReleaseResult>;

export function reportYurucommuSiteReleaseFailure(error: unknown): void;
