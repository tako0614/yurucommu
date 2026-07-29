import { describe, expect, test } from "bun:test";

import {
  evaluateCoreRelease,
  lockedPackageVersion,
} from "./check-core-release.mjs";

const readyLock = `
"@takosjp/yurucommu-api": ["@takosjp/yurucommu-api@3.4.3", "", {}],
"@takosjp/yurucommu-core": ["@takosjp/yurucommu-core@3.4.3", "", {}],
`;

const apiExports = [
  "clearBrowserNotificationPush",
  "disableBrowserNotificationPush",
  "enableBrowserNotificationPush",
  "fetchNotificationPusherPublicConfig",
  "getBrowserNotificationPushState",
  "refreshBrowserNotificationPush",
];
const coreExports = [
  "createManagedRuntimeKeyValueStore",
  "createManagedRuntimeObjectStorage",
  "createManagedRuntimeQueueProducer",
  "createManagedRelationalDatabase",
  "runYurucommuRetention",
];

describe("registry core/API product release gate", () => {
  test("accepts independently locked registry packages at the required release", () => {
    const result = evaluateCoreRelease({
      packageJson: {
        dependencies: {
          "@takosjp/yurucommu-api": "^3.4.3",
          "@takosjp/yurucommu-core": "^3.4.3",
        },
      },
      lockText: readyLock,
      installedVersions: {
        "@takosjp/yurucommu-api": "3.4.3",
        "@takosjp/yurucommu-core": "3.4.3",
      },
      hasNotificationMigration: true,
      apiExports,
      coreExports,
    });
    expect(result).toEqual({ ok: true, blockers: [] });
    expect(lockedPackageVersion(readyLock, "@takosjp/yurucommu-core")).toBe(
      "3.4.3",
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
      coreExports: [],
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
