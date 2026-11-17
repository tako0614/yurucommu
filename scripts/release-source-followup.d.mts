export interface ReleaseFollowupSource {
  readonly commit: string;
  readonly version: string;
  readonly workerReleaseTag: string;
  readonly workerBundleUrl: string;
  readonly workerBundleSha256: string;
  readonly modulePath: string;
  readonly ledger: string;
  readonly site: string;
  readonly siteSource: string;
}

export function decodeReleaseSourceBytes(bytes: Uint8Array): string;

export interface ReleaseSourceFollowup {
  readonly kind: "yurucommu.release-source-followup@v1";
  readonly status:
    | "SOURCE_CHANGES_PROPOSED"
    | "ALREADY_FOLLOWED"
    | "SOURCE_FOLLOWUP_UNAVAILABLE";
  readonly reason?:
    | "SOURCE_IDENTITY_MISMATCH"
    | "INVALID_SOURCE_METADATA"
    | "CONFLICTING_RELEASE_ROW"
    | "INSTALL_LINK_IDENTITY_MISMATCH"
    | "OUTPUT_LIMIT"
    | "SOURCE_READ_OR_PARSE_FAILED"
    | "DIAGNOSTIC_OUTPUT_FAILED";
  readonly qualification?: string;
  readonly sourceCommit?: string;
  readonly published?: {
    readonly tag: string;
    readonly commit: string;
    readonly assetDigests: Readonly<Record<string, string>>;
  };
  readonly changes?: readonly Record<string, unknown>[];
}

export function reportPublishedReleaseSourceFollowup(
  published: unknown,
  readSource: () => ReleaseFollowupSource,
  emit: (result: ReleaseSourceFollowup) => unknown,
): ReleaseSourceFollowup | null;
