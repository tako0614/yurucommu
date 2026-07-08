#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { argv, env, exit, stdout } from "node:process";

type CliOptions = {
  database: string;
  sql?: string;
  sqlFile?: string;
};

async function main(args = argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  const sql = options.sql ?? (await readFile(options.sqlFile!, "utf8"));
  const apiBase = requiredEnv(
    "CLOUDFLARE_API_BASE_URL",
    firstString(
      env.TAKOS_CLOUDFLARE_API_BASE_URL,
      env.TAKOSUMI_CLOUDFLARE_API_BASE_URL,
      env.CLOUDFLARE_API_BASE_URL,
      env.CF_API_BASE_URL,
      env.CLOUDFLARE_BASE_URL,
    ),
  ).replace(/\/+$/u, "");
  const accountId = requiredEnv(
    "CLOUDFLARE_ACCOUNT_ID",
    firstString(env.CLOUDFLARE_ACCOUNT_ID, env.CF_ACCOUNT_ID),
  );
  const apiToken = requiredEnv(
    "CLOUDFLARE_API_TOKEN",
    firstString(env.CLOUDFLARE_API_TOKEN, env.CF_API_TOKEN),
  );
  const endpoint = `${apiBase}/accounts/${encodeURIComponent(
    accountId,
  )}/d1/database/${encodeURIComponent(options.database)}/query`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });
  const text = await response.text();
  if (text.trim()) {
    stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  if (!response.ok) {
    exit(response.status >= 400 && response.status < 600 ? 1 : response.status);
  }
}

function parseArgs(args: readonly string[]): CliOptions {
  let database = "";
  let sql: string | undefined;
  let sqlFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--database" && next) {
      database = next;
      index += 1;
      continue;
    }
    if (arg === "--sql" && next !== undefined) {
      sql = next;
      index += 1;
      continue;
    }
    if (arg === "--sql-file" && next) {
      sqlFile = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!database.trim()) throw new Error("--database is required");
  if (sql === undefined && !sqlFile) {
    throw new Error("--sql or --sql-file is required");
  }
  if (sql !== undefined && sqlFile) {
    throw new Error("--sql and --sql-file cannot be used together");
  }
  return {
    database,
    ...(sql === undefined ? {} : { sql }),
    ...(sqlFile ? { sqlFile } : {}),
  };
}

function requiredEnv(name: string, value: string | undefined): string {
  if (value?.trim()) return value.trim();
  throw new Error(`${name} is required`);
}

function firstString(
  ...values: readonly (string | undefined)[]
): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

if (import.meta.main) {
  await main();
}
