export interface IntegrationTarget {
  accountId: string;
  zoneId: string;
  origin: string;
  prefix: string;
  releaseTag: string;
  artifactSha256: string;
  sourceCommit: string;
  stateDir: string;
  expectedUrl: string;
}

export function parseIntegrationArgs(args: string[]): string;
export function loadIntegrationTarget(path?: string): IntegrationTarget;
export function assertPinnedRootDefaults(
  source: string,
  releaseTag: string,
  expectedUrl: string,
  expectedSha256: string,
): void;
export function assertWorkerScriptAbsent(value: unknown): void;
export function assertCreateOnlyPlan(
  shown: unknown,
  allowed: ReadonlySet<string>,
  existing?: ReadonlySet<string>,
  expectedReads?: ReadonlySet<string>,
): void;
export function assertStateAddresses(
  addresses: unknown,
  expectedManaged: ReadonlySet<string>,
  activated: boolean,
): void;
export function assertDomainChangeset(changeset: unknown): void;
export function assertSingleSuccessfulQuery(body: unknown): void;
export function assertDomainInventoryPage(
  value: unknown,
  page: number,
  filter: "hostname" | "service",
  expected: string,
): { rows: unknown[]; totalCount: number; totalPages?: number };
export function listFilteredDomains(
  accountId: string,
  filter: "hostname" | "service",
  expected: string,
  request: (path: string) => Promise<unknown>,
): Promise<unknown[]>;
export function deployIntegration(args: string[]): Promise<unknown>;

export function isApiSuccess(value: unknown): boolean;
