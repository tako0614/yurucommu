import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  buildD1ExecuteTemplate,
  buildWranglerToml,
  coreMigrationsDir,
  d1MigrationResource,
  hasCoreMigrationsDir,
  releaseConfigFromOutputs,
  shouldInstallDependenciesBeforeRelease,
  type YurucommuReleaseConfig,
} from "./takosumi-release";

const CONFIG: Pick<YurucommuReleaseConfig, "d1DatabaseId" | "d1DatabaseName"> =
  {
    d1DatabaseId: "db-id",
    d1DatabaseName: "db-name",
  };

test("release migrations use wrangler for the official Cloudflare API", () => {
  expect(d1MigrationResource(CONFIG)).toBe("db-name");
  expect(buildD1ExecuteTemplate(".tmp/wrangler.toml")).toEqual([
    "bunx",
    "wrangler",
    "d1",
    "execute",
    "{resource}",
    "--remote",
    "--json",
    "--yes",
    "--config",
    ".tmp/wrangler.toml",
    "--file",
    "{sql_file}",
  ]);
});

test("release migrations stay Cloudflare-native even when a compat base env exists", () => {
  expect(
    buildD1ExecuteTemplate(".tmp/wrangler.toml", {
      CLOUDFLARE_API_BASE_URL: "https://compat.example.test/client/v4/",
    }),
  ).toEqual([
    "bunx",
    "wrangler",
    "d1",
    "execute",
    "{resource}",
    "--remote",
    "--json",
    "--yes",
    "--config",
    ".tmp/wrangler.toml",
    "--file",
    "{sql_file}",
  ]);
});

test("release migrations come from the authoritative core package", () => {
  expect(
    coreMigrationsDir({
      YURUCOMMU_CORE_MIGRATIONS_DIR: "/operator/migrations",
    }),
  ).toBe("/operator/migrations");

  const migrationsDir = coreMigrationsDir({});
  expect(migrationsDir).not.toBe("migrations");
  expect(migrationsDir).toContain(
    join("node_modules", "@takosjp", "yurucommu-core", "migrations"),
  );
  expect(
    existsSync(join(migrationsDir, "0019_notification_push_delivery.sql")),
  ).toBe(true);
});

test("migrations-only release can detect when dependency materialization is required", () => {
  expect(
    shouldInstallDependenciesBeforeRelease({
      migrationsOnly: true,
      coreMigrationsAvailable: false,
    }),
  ).toBe(true);
  expect(
    shouldInstallDependenciesBeforeRelease({
      migrationsOnly: true,
      coreMigrationsAvailable: true,
    }),
  ).toBe(false);
  expect(
    shouldInstallDependenciesBeforeRelease({
      migrationsOnly: false,
      coreMigrationsAvailable: true,
    }),
  ).toBe(true);

  expect(
    hasCoreMigrationsDir({
      YURUCOMMU_CORE_MIGRATIONS_DIR: "/operator/migrations",
    }),
  ).toBe(true);

  expect(hasCoreMigrationsDir({})).toBe(true);
});
