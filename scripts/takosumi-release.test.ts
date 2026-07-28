import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  assertLegacyLedgerIsMigrationPrefix,
  buildD1ExecuteTemplate,
  buildD1QueryArgs,
  buildLegacyLedgerReconciliationSql,
  buildWranglerToml,
  coreMigrationsDir,
  d1MigrationResource,
  hasCoreMigrationsDir,
  legacyMigrationRows,
  missingReleaseReadinessInputs,
  parseWranglerD1Rows,
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

test("legacy D1 ledger inspection uses the selected official D1 resource", () => {
  expect(
    buildD1QueryArgs(
      ".tmp/wrangler.toml",
      "db-name",
      "SELECT name FROM sqlite_master",
    ),
  ).toEqual([
    "bunx",
    "wrangler",
    "d1",
    "execute",
    "db-name",
    "--remote",
    "--json",
    "--yes",
    "--config",
    ".tmp/wrangler.toml",
    "--command",
    "SELECT name FROM sqlite_master",
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

test("generated release config keeps migrations, retention, and queue failure handling", () => {
  const source = buildWranglerToml({
    workerName: "yurucommu-test",
    appUrl: "https://yurucommu.example.test",
    d1DatabaseName: "yurucommu-db",
    d1DatabaseId: "db-id",
    kvNamespaceId: "kv-id",
    deliveryQueueName: "delivery",
    deliveryDlqName: "delivery-dlq",
    vars: {},
    secrets: {},
  });

  expect(source).toContain('migrations_table = "yurucommu_migrations"');
  expect(source).toContain('[triggers]\ncrons = ["0 * * * *"]');
  expect(source).toContain('dead_letter_queue = "delivery-dlq"');
});

test("legacy D1 migration rows converge only from an exact applied prefix", () => {
  const rows = legacyMigrationRows(
    parseWranglerD1Rows(
      JSON.stringify([
        {
          success: true,
          results: [
            { name: "0001_init.sql", applied_at: "2026-01-01 00:00:00" },
            { name: "0002_profile.sql", applied_at: "2026-01-02 00:00:00" },
          ],
        },
      ]),
    ),
  );
  expect(() =>
    assertLegacyLedgerIsMigrationPrefix(rows, [
      "0001_init.sql",
      "0002_profile.sql",
      "0003_posts.sql",
    ]),
  ).not.toThrow();

  const sql = buildLegacyLedgerReconciliationSql(rows);
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS yurucommu_migrations");
  expect(sql).toContain(
    "INSERT OR IGNORE INTO yurucommu_migrations (name, applied_at)",
  );
  expect(sql).not.toContain("DROP TABLE");
});

test("legacy D1 migration reconciliation refuses gaps or unknown files", () => {
  expect(() =>
    assertLegacyLedgerIsMigrationPrefix(
      [{ name: "0002_profile.sql" }],
      ["0001_init.sql", "0002_profile.sql"],
    ),
  ).toThrow("not an exact prefix");
  expect(() =>
    assertLegacyLedgerIsMigrationPrefix(
      [{ name: "9999_unknown.sql" }],
      ["0001_init.sql"],
    ),
  ).toThrow("not an exact prefix");
});

test("full release fails closed when encryption or authentication is absent", () => {
  const base: YurucommuReleaseConfig = {
    workerName: "yurucommu-test",
    appUrl: "https://yurucommu.example.test",
    d1DatabaseName: "yurucommu-db",
    d1DatabaseId: "db-id",
    kvNamespaceId: "kv-id",
    vars: {},
    secrets: {},
  };
  expect(missingReleaseReadinessInputs(base)).toEqual([
    "ENCRYPTION_KEY",
    "AUTH_METHOD",
  ]);
  expect(
    missingReleaseReadinessInputs({
      ...base,
      vars: {
        TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts.example.test",
        TAKOSUMI_ACCOUNTS_CLIENT_ID: "client-id",
      },
      secrets: { ENCRYPTION_KEY: "a".repeat(64) },
    }),
  ).toEqual([]);
});
