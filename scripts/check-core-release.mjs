#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Earlier versions misread the published edge.sql transaction envelope,
// so portable multi-statement operations such as post creation fail at runtime.
export const MINIMUM_PRODUCT_RELEASE = "4.1.6";

const PACKAGE_NAMES = ["@takosjp/yurucommu-core", "@takosjp/yurucommu-api"];
const REQUIRED_API_EXPORTS = [
  "clearBrowserNotificationPush",
  "disableBrowserNotificationPush",
  "enableBrowserNotificationPush",
  "fetchNotificationPusherPublicConfig",
  "getBrowserNotificationPushState",
  "refreshBrowserNotificationPush",
];
// The Worker entry composes through the runtime-lane selector, so a core that
// predates it cannot run this product's bundle at all: it would hand the
// portable edge.sql facade to drizzle-orm/d1 and fail at the first prepare().
//
// The public-origin exports are listed for the same reason even though the
// entry imports only `withRequiredBackgroundPublicOrigin` of them. This product
// deleted its own copy of the rule and now depends on the core owning it end to
// end: the request path is established by the middleware
// `createYurucommuBackendApp` registers, which is not something an import list
// can name. A core that carries the version but not these symbols would leave
// the portable lane with no origin at all and mint `undefined/ap/users/...`.
const REQUIRED_CORE_EXPORTS = [
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

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function compareSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

function versionFromRegistrySpec(spec) {
  if (
    /^(?:file:|workspace:|git(?:\+[^:]+)?:|https?:|github:|link:)/i.test(spec)
  ) {
    return { error: "non_registry_dependency" };
  }
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(spec);
  if (!match) return { error: "unbounded_dependency" };
  return { version: match[1] };
}

export function lockedPackageVersion(lockText, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escaped}":\\s*\\["${escaped}@([^" ]+)"`).exec(
    lockText,
  )?.[1];
}

export function evaluateCoreRelease(input) {
  const minimum = parseSemver(input.minimumVersion ?? MINIMUM_PRODUCT_RELEASE);
  if (!minimum) throw new Error("minimumVersion must be SemVer");
  const blockers = [];

  for (const packageName of PACKAGE_NAMES) {
    const spec = input.packageJson.dependencies?.[packageName];
    if (typeof spec !== "string") {
      blockers.push(`${packageName}.dependency_missing`);
    } else {
      const declared = versionFromRegistrySpec(spec);
      if (declared.error) {
        blockers.push(`${packageName}.${declared.error}`);
      } else {
        const declaredVersion = parseSemver(declared.version);
        if (!declaredVersion || compareSemver(declaredVersion, minimum) < 0) {
          blockers.push(`${packageName}.dependency_floor_too_old`);
        }
      }
    }

    const locked = lockedPackageVersion(input.lockText, packageName);
    const lockedVersion = locked && parseSemver(locked);
    if (!lockedVersion) {
      blockers.push(`${packageName}.lock_missing`);
    } else if (compareSemver(lockedVersion, minimum) < 0) {
      blockers.push(`${packageName}.lock_too_old`);
    }

    const installed = input.installedVersions?.[packageName];
    const installedVersion = installed && parseSemver(installed);
    if (!installedVersion) {
      blockers.push(`${packageName}.installed_missing`);
    } else if (compareSemver(installedVersion, minimum) < 0) {
      blockers.push(`${packageName}.installed_too_old`);
    }
  }

  if (!input.hasNotificationMigration) {
    blockers.push("migration.0019_missing");
  }
  const availableExports = new Set(input.apiExports ?? []);
  for (const exportName of REQUIRED_API_EXPORTS) {
    if (!availableExports.has(exportName)) {
      blockers.push(`api_export.${exportName}_missing`);
    }
  }
  const availableCoreExports = new Set(input.coreExports ?? []);
  for (const exportName of REQUIRED_CORE_EXPORTS) {
    if (!availableCoreExports.has(exportName)) {
      blockers.push(`core_export.${exportName}_missing`);
    }
  }

  return { ok: blockers.length === 0, blockers };
}

function readInstalledVersion(repoRoot, packageName) {
  const path = join(
    repoRoot,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")).version;
}

export async function inspectCurrentRepo(
  repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
) {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  const lockText = readFileSync(join(repoRoot, "bun.lock"), "utf8");
  const installedVersions = Object.fromEntries(
    PACKAGE_NAMES.map((name) => [name, readInstalledVersion(repoRoot, name)]),
  );
  const migrationPath = join(
    repoRoot,
    "node_modules",
    "@takosjp",
    "yurucommu-core",
    "migrations",
    "0019_notification_push_delivery.sql",
  );
  let apiExports = [];
  let coreExports = [];
  try {
    apiExports = Object.keys(await import("@takosjp/yurucommu-api"));
  } catch {
    // Missing or incompatible registry packages are reported as export blockers.
  }
  try {
    coreExports = Object.keys(await import("@takosjp/yurucommu-core/server"));
  } catch {
    // Missing or incompatible registry packages are reported as export blockers.
  }
  return evaluateCoreRelease({
    packageJson,
    lockText,
    installedVersions,
    hasNotificationMigration: existsSync(migrationPath),
    apiExports,
    coreExports,
  });
}

if (import.meta.main) {
  const result = await inspectCurrentRepo();
  if (!result.ok) {
    console.error(
      `Yurucommu release is blocked until registry core/API ${MINIMUM_PRODUCT_RELEASE} is published and this repo's package.json + bun.lock are updated from npm.`,
    );
    console.error(result.blockers.map((blocker) => `- ${blocker}`).join("\n"));
    console.error(
      "Do not use file:, workspace:, or Git dependencies as a bypass.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Registry core/API ${MINIMUM_PRODUCT_RELEASE}+ and the required runtime exports are ready for this product release.`,
    );
  }
}
