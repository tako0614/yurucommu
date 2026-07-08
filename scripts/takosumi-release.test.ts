import { expect, test } from "bun:test";

import {
  buildD1ExecuteTemplate,
  cloudflareCompatApiBaseUrl,
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
