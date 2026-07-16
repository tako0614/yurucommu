export const MINIMUM_NOTIFICATION_RELEASE: string;

export type CoreReleaseInput = {
  minimumVersion?: string;
  packageJson: {
    dependencies?: Record<string, string>;
  };
  lockText: string;
  installedVersions?: Record<string, string | undefined>;
  hasNotificationMigration: boolean;
  apiExports?: string[];
};

export type CoreReleaseResult = {
  ok: boolean;
  blockers: string[];
};

export function lockedPackageVersion(
  lockText: string,
  packageName: string,
): string | undefined;

export function evaluateCoreRelease(input: CoreReleaseInput): CoreReleaseResult;

export function inspectCurrentRepo(
  repoRoot?: string,
): Promise<CoreReleaseResult>;
