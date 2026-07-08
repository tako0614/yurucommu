import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  buildD1ExecuteTemplate,
  cloudflareCompatApiBaseUrl,
  coreMigrationsDir,
  d1MigrationResource,
  type YurucommuReleaseConfig,
} from "./takosumi-release";

const CONFIG: Pick<YurucommuReleaseConfig, "d1DatabaseId" | "d1DatabaseName"> =
  {
    d1DatabaseId: "db-id",
    d1DatabaseName: "db-name",
  };

test("release migrations use wrangler for the official Cloudflare API", () => {
  const sourceEnv = {
    CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
  };

  expect(cloudflareCompatApiBaseUrl(sourceEnv)).toBeUndefined();
  expect(d1MigrationResource(CONFIG, sourceEnv)).toBe("db-name");
  expect(buildD1ExecuteTemplate(".tmp/wrangler.toml", sourceEnv)).toEqual([
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
    "--command",
    "{sql}",
  ]);
});

test("release migrations use the compat D1 query endpoint for explicit API bases", () => {
  const sourceEnv = {
    CLOUDFLARE_API_BASE_URL:
      "https://app.takosumi.com/compat/cloudflare/client/v4/",
  };

  expect(cloudflareCompatApiBaseUrl(sourceEnv)).toBe(
    "https://app.takosumi.com/compat/cloudflare/client/v4",
  );
  expect(d1MigrationResource(CONFIG, sourceEnv)).toBe("db-id");
  expect(buildD1ExecuteTemplate(".tmp/wrangler.toml", sourceEnv)).toEqual([
    "bun",
    "scripts/cloudflare-compat-d1-execute.ts",
    "--database",
    "{resource}",
    "--sql-file",
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
  expect(existsSync(join(migrationsDir, "0018_actor_notes.sql"))).toBe(true);
});
