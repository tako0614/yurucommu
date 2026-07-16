#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MINIMUM_NOTIFICATION_RELEASE = "3.1.0";

const PACKAGE_NAMES = ["@takosjp/yurucommu-core", "@takosjp/yurucommu-api"];
const REQUIRED_API_EXPORTS = [
  "clearBrowserNotificationPush",
  "disableBrowserNotificationPush",
  "enableBrowserNotificationPush",
  "fetchNotificationPusherPublicConfig",
  "getBrowserNotificationPushState",
  "refreshBrowserNotificationPush",
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
  const minimum = parseSemver(
    input.minimumVersion ?? MINIMUM_NOTIFICATION_RELEASE,
  );
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
  try {
    apiExports = Object.keys(await import("@takosjp/yurucommu-api"));
  } catch {
    // Missing or incompatible registry packages are reported as export blockers.
  }
  return evaluateCoreRelease({
    packageJson,
    lockText,
    installedVersions,
    hasNotificationMigration: existsSync(migrationPath),
    apiExports,
  });
}

if (import.meta.main) {
  const result = await inspectCurrentRepo();
  if (!result.ok) {
    console.error(
      `Yurucommu notification release is blocked until registry core/API ${MINIMUM_NOTIFICATION_RELEASE} is published and this repo's package.json + bun.lock are updated from npm.`,
    );
    console.error(result.blockers.map((blocker) => `- ${blocker}`).join("\n"));
    console.error(
      "Do not use file:, workspace:, or Git dependencies as a bypass.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Registry core/API ${MINIMUM_NOTIFICATION_RELEASE}+ and migration 0019 are ready for this product release.`,
    );
  }
}
