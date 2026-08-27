export type CommittedSiteEntry = {
  oid: string;
  path: string;
};

export type SiteManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type SealedSiteCandidate = {
  releaseRoot: string;
  custodyRoot: string;
  siteRoot: string;
  wranglerCwd: string;
  outputPath: string;
  manifestPath: string;
  manifest: {
    kind: string;
    commit: string;
    treeDigest: string;
    files: SiteManifestFile[];
  };
  manifestDigest: string;
  treeDigest: string;
  directoryFd: number | null;
};

export type PagesDeploymentIdentity = {
  deploymentId: string;
  deploymentUrl: string;
  commit: string;
  environment: "production";
  productionBranch: "main";
};

export type CanonicalProductionAuthority = {
  authority: "cloudflare-pages-project.canonical_deployment";
  project: "yurucommu-website";
  projectId: string;
  deploymentId: string;
  deploymentUrl: string;
  branch: "main";
  source: string | null;
  publicOrigin: "https://yurucommu.com";
  automaticProductionDeployments: "not-configured" | "disabled";
};

export type SiteRepresentative = {
  urlPath: string;
  file: string;
  bytes: number;
  sha256: string;
  contentType: string;
  headers?: Record<string, string>;
};

export type SiteFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function parseCommittedSiteTree(
  rawTree: Uint8Array,
): CommittedSiteEntry[];

export function sealCommittedSite(input: {
  baseDirectory: string;
  commit: string;
  entries: CommittedSiteEntry[];
  readBlob(oid: string): Uint8Array;
}): SealedSiteCandidate;

export function verifySealedSite(candidate: SealedSiteCandidate): {
  files: number;
  treeDigest: string;
};

export function disposeSealedSite(candidate: {
  releaseRoot?: string;
  directoryFd?: number | null;
}): void;

export function validateSealedSiteContent(candidate: SealedSiteCandidate): {
  representatives: SiteRepresentative[];
  internalReferences: number;
  installCta: { href: string; occurrences: number };
};

export function parsePagesDeployIdentity(
  rawOutput: string,
  expected: { commit: string },
): PagesDeploymentIdentity;

export function parseCanonicalProductionProject(
  rawResponse: string,
): CanonicalProductionAuthority;

export function parseWranglerReleaseAuthority(
  whoamiOutput: string,
  tokenOutput: string,
): {
  accountId: string;
  token: string;
};

export function requireCanonicalPublishedDeployment(
  authority: CanonicalProductionAuthority,
  identity: PagesDeploymentIdentity,
): CanonicalProductionAuthority;

export function sanitizeProviderOutput(value: unknown): string;

export function verifyCurrentProductionBinding(input: {
  authority: CanonicalProductionAuthority;
  representatives: SiteRepresentative[];
  fetchImpl?: SiteFetch;
  attempts?: number;
  sleep?(milliseconds: number): Promise<void>;
}): Promise<{
  bindingDigest: string;
  readbacks: Array<{
    urlPath: string;
    bytes: number;
    sha256: string;
    contentType: string;
    headers: Record<string, string>;
    status: "CURRENT_CANONICAL_BYTES";
  }>;
}>;

export function verifyRepresentativeReadbacks(input: {
  origins: string[];
  representatives: SiteRepresentative[];
  treeDigest: string;
  fetchImpl?: SiteFetch;
  attempts?: number;
  sleep?(milliseconds: number): Promise<void>;
}): Promise<
  Array<{
    origin: string;
    urlPath: string;
    bytes: number;
    sha256: string;
    contentType: string;
    status: "EXPECTED_CANDIDATE";
  }>
>;

export class YurucommuSiteReleaseFailure extends Error {
  readonly phase: string;
  readonly evidence: Record<string, unknown>;
  readonly provider: { stdout: string; stderr: string } | null;
}

export function deployYurucommuSite(options?: {
  repo?: string;
}): Promise<Record<string, unknown>>;

export function reportYurucommuSiteReleaseFailure(error: unknown): void;
