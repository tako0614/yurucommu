import { describe, expect, test } from "bun:test";

import {
  evaluateCoreRelease,
  lockedPackageVersion,
} from "./check-core-release.mjs";

const readyLock = `
"@takosjp/yurucommu-api": ["@takosjp/yurucommu-api@3.1.0", "", {}],
"@takosjp/yurucommu-core": ["@takosjp/yurucommu-core@3.1.0", "", {}],
`;

const apiExports = [
  "clearBrowserNotificationPush",
  "disableBrowserNotificationPush",
  "enableBrowserNotificationPush",
  "fetchNotificationPusherPublicConfig",
  "getBrowserNotificationPushState",
  "refreshBrowserNotificationPush",
];

describe("core notification release gate", () => {
  test("accepts independently locked registry packages at the required release", () => {
    const result = evaluateCoreRelease({
      packageJson: {
        dependencies: {
          "@takosjp/yurucommu-api": "^3.1.0",
          "@takosjp/yurucommu-core": "^3.1.0",
        },
      },
      lockText: readyLock,
      installedVersions: {
        "@takosjp/yurucommu-api": "3.1.0",
        "@takosjp/yurucommu-core": "3.1.0",
      },
      hasNotificationMigration: true,
      apiExports,
    });
    expect(result).toEqual({ ok: true, blockers: [] });
    expect(lockedPackageVersion(readyLock, "@takosjp/yurucommu-core")).toBe(
      "3.1.0",
    );
  });

  test("blocks old locks and unpublished-source dependency bypasses", () => {
    const result = evaluateCoreRelease({
      packageJson: {
        dependencies: {
          "@takosjp/yurucommu-api": "file:../yurucommu-core/packages/api",
          "@takosjp/yurucommu-core": "^3.0.3",
        },
      },
      lockText: readyLock.replaceAll("3.1.0", "3.0.3"),
      installedVersions: {
        "@takosjp/yurucommu-api": "3.0.3",
        "@takosjp/yurucommu-core": "3.0.3",
      },
      hasNotificationMigration: false,
      apiExports: [],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain(
      "@takosjp/yurucommu-api.non_registry_dependency",
    );
    expect(result.blockers).toContain(
      "@takosjp/yurucommu-core.dependency_floor_too_old",
    );
    expect(result.blockers).toContain("migration.0019_missing");
  });
});
