import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  evaluateCoreRelease,
  lockedPackageVersion,
} from "./check-core-release.mjs";

const packageManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };

const readyLock = `
"@takosjp/yurucommu-api": ["@takosjp/yurucommu-api@4.1.5", "", {}],
"@takosjp/yurucommu-core": ["@takosjp/yurucommu-core@4.1.5", "", {}],
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
  "CANONICAL_ORIGIN_KV_KEY",
  "PublicOriginError",
  "createManagedRuntimeKeyValueStore",
  "createManagedRuntimeObjectStorage",
  "createManagedRuntimeQueueProducer",
  "createManagedRelationalDatabase",
  "establishRequestPublicOrigin",
  "resolveRuntimeLane",
  "runYurucommuRetention",
  "withRequiredBackgroundPublicOrigin",
  "wrapPortableBindings",
  "wrapRuntimeBindings",
  "wrapRuntimeMessageBatch",
];

describe("registry core/API product release gate", () => {
  test("accepts independently locked registry packages at the required release", () => {
    const result = evaluateCoreRelease({
      packageJson: {
        dependencies: {
          "@takosjp/yurucommu-api": "^4.1.5",
          "@takosjp/yurucommu-core": "^4.1.5",
        },
      },
      lockText: readyLock,
      installedVersions: {
        "@takosjp/yurucommu-api": "4.1.5",
        "@takosjp/yurucommu-core": "4.1.5",
      },
      hasNotificationMigration: true,
      apiExports,
      coreExports,
    });
    expect(result).toEqual({ ok: true, blockers: [] });
    expect(lockedPackageVersion(readyLock, "@takosjp/yurucommu-core")).toBe(
      "4.1.5",
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
      lockText: readyLock.replaceAll("4.1.5", "3.0.3"),
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
      lockText: readyLock.replaceAll("4.1.5", "4.0.0"),
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

  // 4.1.1 has the lanes but not the request-derived public origin. This
  // product deleted its own copy of that rule, so on 4.1.1 the portable lane
  // would have no origin at all rather than an older one.
  test("rejects the release before the request-derived public origin", () => {
    const result = evaluateCoreRelease({
      packageJson: {
        dependencies: {
          "@takosjp/yurucommu-api": "^4.1.1",
          "@takosjp/yurucommu-core": "^4.1.1",
        },
      },
      lockText: readyLock.replaceAll("4.1.5", "4.1.1"),
      installedVersions: {
        "@takosjp/yurucommu-api": "4.1.1",
        "@takosjp/yurucommu-core": "4.1.1",
      },
      hasNotificationMigration: true,
      apiExports,
      coreExports: coreExports.filter(
        (name) =>
          name !== "CANONICAL_ORIGIN_KV_KEY" &&
          name !== "PublicOriginError" &&
          name !== "establishRequestPublicOrigin" &&
          name !== "withRequiredBackgroundPublicOrigin",
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "@takosjp/yurucommu-core.dependency_floor_too_old",
        "@takosjp/yurucommu-core.lock_too_old",
        "@takosjp/yurucommu-core.installed_too_old",
        "core_export.establishRequestPublicOrigin_missing",
        "core_export.withRequiredBackgroundPublicOrigin_missing",
      ]),
    );
  });

  // The lane selector is what the generated Worker entry composes through. A
  // core that ships the version but not the export is a red the gate must see.
  test("blocks a core release that lacks the runtime-lane selector", () => {
    const result = evaluateCoreRelease({
      packageJson: {
        dependencies: {
          "@takosjp/yurucommu-api": "^4.1.5",
          "@takosjp/yurucommu-core": "^4.1.5",
        },
      },
      lockText: readyLock,
      installedVersions: {
        "@takosjp/yurucommu-api": "4.1.5",
        "@takosjp/yurucommu-core": "4.1.5",
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

// A gate nothing runs is not a floor. This one was written and left off the
// portable complete gate, so a core below the required release — one missing
// the runtime-lane composition the Worker entry is built on — would have been
// caught by nothing before a deploy.
describe("core release floor is gated", () => {
  test("the portable complete gate runs the core release check", () => {
    expect(packageManifest.scripts?.["check"]).toContain(
      "bun run check:core-release",
    );
  });
});
