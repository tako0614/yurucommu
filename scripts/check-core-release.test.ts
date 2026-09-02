import { describe, expect, test } from "bun:test";

import {
  evaluateCoreRelease,
  lockedPackageVersion,
} from "./check-core-release.mjs";

const readyLock = `
"@takosjp/yurucommu-api": ["@takosjp/yurucommu-api@4.1.0", "", {}],
"@takosjp/yurucommu-core": ["@takosjp/yurucommu-core@4.1.0", "", {}],
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
  "resolveRuntimeLane",
  "runYurucommuRetention",
  "wrapPortableBindings",
  "wrapRuntimeBindings",
  "wrapRuntimeMessageBatch",
];

describe("registry core/API product release gate", () => {
  test("accepts independently locked registry packages at the required release", () => {
    const result = evaluateCoreRelease({
      packageJson: {
        dependencies: {
          "@takosjp/yurucommu-api": "^4.1.0",
          "@takosjp/yurucommu-core": "^4.1.0",
        },
      },
      lockText: readyLock,
      installedVersions: {
        "@takosjp/yurucommu-api": "4.1.0",
        "@takosjp/yurucommu-core": "4.1.0",
      },
      hasNotificationMigration: true,
      apiExports,
      coreExports,
    });
    expect(result).toEqual({ ok: true, blockers: [] });
    expect(lockedPackageVersion(readyLock, "@takosjp/yurucommu-core")).toBe(
      "4.1.0",
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
      lockText: readyLock.replaceAll("4.1.0", "3.0.3"),
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

  // 4.0.0 carries the provider-neutral ObjectStore but not the runtime lanes.
  // A Worker entry that composes through wrapRuntimeBindings cannot boot on it,
  // so the floor is the lane release rather than the ObjectStore release.
  test("rejects the pre-lane 4.0.0 release", () => {
    const result = evaluateCoreRelease({
      packageJson: {
        dependencies: {
          "@takosjp/yurucommu-api": "^4.0.0",
          "@takosjp/yurucommu-core": "^4.0.0",
        },
      },
      lockText: readyLock.replaceAll("4.1.0", "4.0.0"),
      installedVersions: {
        "@takosjp/yurucommu-api": "4.0.0",
        "@takosjp/yurucommu-core": "4.0.0",
      },
      hasNotificationMigration: true,
      apiExports,
      coreExports,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "@takosjp/yurucommu-api.dependency_floor_too_old",
        "@takosjp/yurucommu-api.lock_too_old",
        "@takosjp/yurucommu-api.installed_too_old",
        "@takosjp/yurucommu-core.dependency_floor_too_old",
        "@takosjp/yurucommu-core.lock_too_old",
        "@takosjp/yurucommu-core.installed_too_old",
      ]),
    );
  });

  // The lane selector is what the generated Worker entry composes through. A
  // core that ships the version but not the export is a red the gate must see.
  test("blocks a core release that lacks the runtime-lane selector", () => {
    const result = evaluateCoreRelease({
      packageJson: {
        dependencies: {
          "@takosjp/yurucommu-api": "^4.1.0",
          "@takosjp/yurucommu-core": "^4.1.0",
        },
      },
      lockText: readyLock,
      installedVersions: {
        "@takosjp/yurucommu-api": "4.1.0",
        "@takosjp/yurucommu-core": "4.1.0",
      },
      hasNotificationMigration: true,
      apiExports,
      coreExports: coreExports.filter(
        (name) =>
          name !== "wrapRuntimeBindings" && name !== "wrapRuntimeMessageBatch",
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "core_export.wrapRuntimeBindings_missing",
        "core_export.wrapRuntimeMessageBatch_missing",
      ]),
    );
  });
});
