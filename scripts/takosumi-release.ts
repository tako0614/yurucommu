#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { argv, env } from "node:process";

import {
  applyMigrations,
  MIGRATION_LEDGER_TABLE,
} from "@takosjp/yurucommu-core/migrations";

type JsonRecord = Record<string, unknown>;

export type YurucommuReleaseConfig = {
  workerName: string;
  appUrl: string;
  cloudflareAccountId?: string;
  d1DatabaseName: string;
  d1DatabaseId: string;
  kvNamespaceId: string;
  r2BucketName?: string;
  deliveryQueueName?: string;
  deliveryDlqName?: string;
  vars: Record<string, string>;
  secrets: Record<string, string>;
};

const SECRET_ENV_MAP: Record<string, string> = {
  YURUCOMMU_ENCRYPTION_KEY: "ENCRYPTION_KEY",
  YURUCOMMU_AUTH_PASSWORD_HASH: "AUTH_PASSWORD_HASH",
  YURUCOMMU_GOOGLE_CLIENT_SECRET: "GOOGLE_CLIENT_SECRET",
  YURUCOMMU_X_CLIENT_SECRET: "X_CLIENT_SECRET",
  YURUCOMMU_OIDC_CLIENT_SECRET: "OIDC_CLIENT_SECRET",
  YURUCOMMU_TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "TAKOSUMI_ACCOUNTS_CLIENT_SECRET",
  YURUCOMMU_SESSION_HASH_SALT: "YURUCOMMU_SESSION_HASH_SALT",
  ENCRYPTION_KEY: "ENCRYPTION_KEY",
  AUTH_PASSWORD_HASH: "AUTH_PASSWORD_HASH",
  GOOGLE_CLIENT_SECRET: "GOOGLE_CLIENT_SECRET",
  X_CLIENT_SECRET: "X_CLIENT_SECRET",
  OIDC_CLIENT_SECRET: "OIDC_CLIENT_SECRET",
  TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "TAKOSUMI_ACCOUNTS_CLIENT_SECRET",
};

const OPTIONAL_VAR_ENV = [
  "AUTH_MODE",
  "GOOGLE_CLIENT_ID",
  "X_CLIENT_ID",
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OAUTH_ISSUER_URL",
  "TAKOSUMI_ACCOUNTS_ISSUER_URL",
  "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  "OIDC_OWNER_SUB",
  "OIDC_ALLOWED_SUBS",
  "TAKOS_URL",
  "YURUCOMMU_SOFTWARE_VERSION",
  "CSRF_ALLOWED_ORIGINS",
  "YURUCOMMU_STRICT_READINESS",
] as const;

const DEFAULT_RELEASE_COMMAND_RETRY_ATTEMPTS = 3;
const DEFAULT_RELEASE_COMMAND_RETRY_INTERVAL_MS = 2_000;

export function parseTakosumiOutputsJson(text: string): JsonRecord {
  const outputs = JSON.parse(text) as unknown;
  if (!isRecord(outputs)) {
    throw new Error("TAKOSUMI_OUTPUTS_JSON must be a JSON object");
  }
  return outputs;
}

export function releaseConfigFromOutputs(
  outputs: JsonRecord,
  sourceEnv: Record<string, string | undefined> = env,
): YurucommuReleaseConfig {
  const workerName = requireStringOutput(outputs, "worker_name");
  const appUrl =
    firstString(sourceEnv.YURUCOMMU_APP_URL, sourceEnv.APP_URL) ??
    requireStringOutput(outputs, "launch_url");
  const d1DatabaseName = requireStringOutput(
    outputs,
    "cloudflare_d1_database_name",
  );
  const d1DatabaseId = requireStringOutput(
    outputs,
    "cloudflare_d1_database_id",
  );
  const kvNamespaceId = requireStringOutput(
    outputs,
    "cloudflare_kv_namespace_id",
  );
  const cloudflareAccountId = optionalStringOutput(
    outputs,
    "cloudflare_account_id",
  );
  const queueNames = outputValue(outputs.cloudflare_queue_names);
  const vars = collectWorkerVars(appUrl, queueNames, sourceEnv);
  return {
    workerName,
    appUrl,
    ...(cloudflareAccountId ? { cloudflareAccountId } : {}),
    d1DatabaseName,
    d1DatabaseId,
    kvNamespaceId,
    r2BucketName: optionalStringOutput(outputs, "cloudflare_r2_bucket_name"),
    deliveryQueueName: nestedString(queueNames, "delivery"),
    deliveryDlqName: nestedString(queueNames, "delivery_dlq"),
    vars,
    secrets: collectWorkerSecrets(sourceEnv),
  };
}

export function buildWranglerToml(config: YurucommuReleaseConfig): string {
  const lines = [
    `name = ${tomlString(config.workerName)}`,
    `main = "../../dist/yurucommu-worker.js"`,
    `compatibility_date = "2026-04-01"`,
    `compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]`,
    `workers_dev = true`,
    "",
    "[vars]",
    ...Object.entries(config.vars)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name} = ${tomlString(value)}`),
    "",
    "[[d1_databases]]",
    `binding = "DB"`,
    `database_name = ${tomlString(config.d1DatabaseName)}`,
    `database_id = ${tomlString(config.d1DatabaseId)}`,
    `migrations_dir = "../../node_modules/@takosjp/yurucommu-core/migrations"`,
    `migrations_table = "yurucommu_migrations"`,
    "",
    "[[kv_namespaces]]",
    `binding = "KV"`,
    `id = ${tomlString(config.kvNamespaceId)}`,
    "",
    "[triggers]",
    `crons = ["0 * * * *"]`,
  ];

  if (config.r2BucketName) {
    lines.push(
      "",
      "[[r2_buckets]]",
      `binding = "MEDIA"`,
      `bucket_name = ${tomlString(config.r2BucketName)}`,
    );
  }

  if (config.deliveryQueueName) {
    lines.push(
      "",
      "[[queues.producers]]",
      `binding = "DELIVERY_QUEUE"`,
      `queue = ${tomlString(config.deliveryQueueName)}`,
      "",
      "[[queues.consumers]]",
      `queue = ${tomlString(config.deliveryQueueName)}`,
      "max_batch_size = 10",
      "max_batch_timeout = 1",
      "max_retries = 3",
      ...(config.deliveryDlqName
        ? [`dead_letter_queue = ${tomlString(config.deliveryDlqName)}`]
        : []),
    );
  }

  if (config.deliveryDlqName) {
    lines.push(
      "",
      "[[queues.producers]]",
      `binding = "DELIVERY_DLQ"`,
      `queue = ${tomlString(config.deliveryDlqName)}`,
      "",
      "[[queues.consumers]]",
      `queue = ${tomlString(config.deliveryDlqName)}`,
      "max_batch_size = 10",
      "max_batch_timeout = 60",
      "max_retries = 1",
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function buildDeployArgs(
  configPath: string,
  secretsPath?: string,
): string[] {
  return [
    "bunx",
    "wrangler",
    "deploy",
    "--config",
    configPath,
    ...(secretsPath ? ["--secrets-file", secretsPath] : []),
  ];
}

export function buildInstallArgs(): string[] {
  return ["bun", "install", "--frozen-lockfile", "--ignore-scripts"];
}

export function hasCoreMigrationsDir(
  sourceEnv: Record<string, string | undefined> = env,
): boolean {
  try {
    coreMigrationsDir(sourceEnv);
    return true;
  } catch {
    return false;
  }
}

export function shouldInstallDependenciesBeforeRelease(input: {
  readonly migrationsOnly: boolean;
  readonly coreMigrationsAvailable: boolean;
}): boolean {
  return !input.migrationsOnly || !input.coreMigrationsAvailable;
}

export function coreMigrationsDir(
  sourceEnv: Record<string, string | undefined> = env,
): string {
  const override = sourceEnv.YURUCOMMU_CORE_MIGRATIONS_DIR?.trim();
  if (override) return override;
  const packageDir = join(
    "node_modules",
    "@takosjp",
    "yurucommu-core",
    "migrations",
  );
  if (existsSync(packageDir)) return packageDir;
  throw new Error(
    "Could not find @takosjp/yurucommu-core migrations. Run bun install before activation or set YURUCOMMU_CORE_MIGRATIONS_DIR explicitly.",
  );
}

export function buildD1ExecuteTemplate(
  configPath: string,
  sourceEnv?: Record<string, string | undefined>,
): string[] {
  void sourceEnv;
  return [
    "bunx",
    "wrangler",
    "d1",
    "execute",
    "{resource}",
    "--remote",
    "--json",
    "--yes",
    "--config",
    configPath,
    "--file",
    "{sql_file}",
  ];
}

export function buildD1QueryArgs(
  configPath: string,
  resource: string,
  sql: string,
): string[] {
  return [
    "bunx",
    "wrangler",
    "d1",
    "execute",
    resource,
    "--remote",
    "--json",
    "--yes",
    "--config",
    configPath,
    "--command",
    sql,
  ];
}

export function parseWranglerD1Rows(text: string): JsonRecord[] {
  const parsed = JSON.parse(text) as unknown;
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  const rows: JsonRecord[] = [];
  for (const envelope of envelopes) {
    if (!isRecord(envelope)) continue;
    const results = envelope.results;
    if (!Array.isArray(results)) continue;
    for (const row of results) {
      if (isRecord(row)) rows.push(row);
    }
  }
  return rows;
}

export type LegacyMigrationLedgerRow = {
  name: string;
  appliedAt?: string;
};

export function legacyMigrationRows(
  rows: readonly JsonRecord[],
): LegacyMigrationLedgerRow[] {
  return rows.map((row, index) => {
    if (typeof row.name !== "string" || !row.name.trim()) {
      throw new Error(
        `legacy d1_migrations row ${index} has no migration name`,
      );
    }
    const appliedAt =
      typeof row.applied_at === "string" && row.applied_at.trim()
        ? row.applied_at
        : undefined;
    return { name: row.name, ...(appliedAt ? { appliedAt } : {}) };
  });
}

export function assertLegacyLedgerIsMigrationPrefix(
  legacy: readonly LegacyMigrationLedgerRow[],
  migrationFiles: readonly string[],
): void {
  const names = legacy.map((row) => row.name);
  const duplicates = names.filter(
    (name, index) => names.indexOf(name) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `legacy d1_migrations contains duplicate names: ${[
        ...new Set(duplicates),
      ].join(", ")}`,
    );
  }
  const expected = migrationFiles.slice(0, names.length);
  if (
    names.length > migrationFiles.length ||
    names.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      "legacy d1_migrations is not an exact prefix of the authoritative migration set; refusing automatic reconciliation",
    );
  }
}

export function buildLegacyLedgerReconciliationSql(
  legacy: readonly LegacyMigrationLedgerRow[],
): string {
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (\n` +
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      "  name TEXT UNIQUE NOT NULL,\n" +
      "  applied_at TEXT NOT NULL DEFAULT (datetime('now'))\n" +
      ")",
  ];
  for (const row of legacy) {
    const name = sqlString(row.name);
    const appliedAt = sqlString(row.appliedAt ?? "1970-01-01 00:00:00");
    statements.push(
      `INSERT OR IGNORE INTO ${MIGRATION_LEDGER_TABLE} (name, applied_at) VALUES (${name}, ${appliedAt})`,
    );
  }
  return `${statements.join(";\n")};\n`;
}

export function d1MigrationResource(
  config: Pick<YurucommuReleaseConfig, "d1DatabaseId" | "d1DatabaseName">,
): string {
  return config.d1DatabaseName;
}

export function buildDeleteWorkerArgs(workerName: string): string[] {
  return ["bunx", "wrangler", "delete", workerName, "--force"];
}

export function buildRemoveQueueConsumerArgs(
  queueName: string,
  workerName: string,
): string[] {
  return [
    "bunx",
    "wrangler",
    "queues",
    "consumer",
    "remove",
    queueName,
    workerName,
  ];
}

export function buildDestroyArgs(config: YurucommuReleaseConfig): string[][] {
  return [
    ...(config.deliveryQueueName
      ? [
          buildRemoveQueueConsumerArgs(
            config.deliveryQueueName,
            config.workerName,
          ),
        ]
      : []),
    ...(config.deliveryDlqName
      ? [
          buildRemoveQueueConsumerArgs(
            config.deliveryDlqName,
            config.workerName,
          ),
        ]
      : []),
    buildDeleteWorkerArgs(config.workerName),
  ];
}

async function main(args = argv.slice(2)): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const keepGenerated = args.includes("--keep-generated");
  const destroy = args.includes("--destroy");
  const migrationsOnly = args.includes("--migrations-only");
  const unknown = args.find(
    (arg) =>
      ![
        "--dry-run",
        "--keep-generated",
        "--destroy",
        "--migrations-only",
      ].includes(arg),
  );
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  if (destroy && migrationsOnly) {
    throw new Error("--destroy and --migrations-only cannot be used together");
  }

  const rawOutputs = env.TAKOSUMI_OUTPUTS_JSON;
  if (!rawOutputs?.trim()) {
    throw new Error("TAKOSUMI_OUTPUTS_JSON is required for Yurucommu release");
  }
  const config = releaseConfigFromOutputs(parseTakosumiOutputsJson(rawOutputs));
  if (destroy) {
    for (const command of buildDestroyArgs(config)) {
      await run(command, { allowMissingDestroyResource: true });
    }
    console.log(
      JSON.stringify({
        ok: true,
        destroyed: true,
        workerName: config.workerName,
      }),
    );
    return;
  }
  const generatedDir = join(".takosumi-release", randomUUID());
  const configPath = join(generatedDir, "wrangler.toml");
  const secretsPath =
    Object.keys(config.secrets).length > 0
      ? join(generatedDir, "secrets.json")
      : undefined;

  await mkdir(generatedDir, { recursive: true, mode: 0o700 });
  try {
    const restoreWranglerEnv = applyWranglerEnv(config);
    try {
      await writeFile(configPath, buildWranglerToml(config), { mode: 0o600 });
      if (secretsPath) {
        await writeFile(secretsPath, JSON.stringify(config.secrets), {
          mode: 0o600,
        });
      }

      if (dryRun) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              dryRun: true,
              workerName: config.workerName,
              appUrl: config.appUrl,
              configPath,
              secretNames: Object.keys(config.secrets).sort(),
              migrationsOnly,
              deployArgs: buildDeployArgs(configPath, secretsPath),
            },
            null,
            2,
          ),
        );
        return;
      }

      if (!migrationsOnly) {
        assertReleaseReadinessConfig(config);
      }
      if (
        shouldInstallDependenciesBeforeRelease({
          migrationsOnly,
          coreMigrationsAvailable: hasCoreMigrationsDir(),
        })
      ) {
        await run(buildInstallArgs());
      }
      if (!migrationsOnly) {
        await run(["bun", "run", "build:worker"]);
      }
      if (shouldSkipD1Migrations(env.YURUCOMMU_SKIP_D1_MIGRATIONS)) {
        console.warn(
          "[takosumi:release] Skipping D1 migrations because YURUCOMMU_SKIP_D1_MIGRATIONS is enabled.",
        );
      } else {
        await reconcileLegacyD1MigrationLedger({
          configPath,
          config,
          generatedDir,
          migrationsDir: coreMigrationsDir(),
        });
        await applyMigrations({
          resource: d1MigrationResource(config),
          migrationsDir: coreMigrationsDir(),
          sqlCommandTemplate: buildD1ExecuteTemplate(configPath),
          wrapTransactions: false,
        });
      }
      if (migrationsOnly) {
        console.log(
          JSON.stringify({
            ok: true,
            migrationsOnly: true,
            workerName: config.workerName,
            appUrl: config.appUrl,
          }),
        );
        return;
      }
      await run(buildDeployArgs(configPath, secretsPath));
      console.log(
        JSON.stringify({
          ok: true,
          workerName: config.workerName,
          appUrl: config.appUrl,
          secretNames: Object.keys(config.secrets).sort(),
        }),
      );
    } finally {
      restoreWranglerEnv();
    }
  } finally {
    if (!keepGenerated) {
      await rm(generatedDir, { recursive: true, force: true });
    }
  }
}

async function reconcileLegacyD1MigrationLedger(input: {
  readonly configPath: string;
  readonly config: Pick<
    YurucommuReleaseConfig,
    "d1DatabaseId" | "d1DatabaseName"
  >;
  readonly generatedDir: string;
  readonly migrationsDir: string;
}): Promise<void> {
  const resource = d1MigrationResource(input.config);
  const tableRows = parseWranglerD1Rows(
    await runForStdout(
      buildD1QueryArgs(
        input.configPath,
        resource,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
      ),
    ),
  );
  if (!tableRows.some((row) => row.name === "d1_migrations")) return;

  const legacy = legacyMigrationRows(
    parseWranglerD1Rows(
      await runForStdout(
        buildD1QueryArgs(
          input.configPath,
          resource,
          "SELECT name, applied_at FROM d1_migrations ORDER BY id",
        ),
      ),
    ),
  );
  if (legacy.length === 0) return;

  const migrationFiles = (await readdir(input.migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  assertLegacyLedgerIsMigrationPrefix(legacy, migrationFiles);

  const sqlPath = join(input.generatedDir, "reconcile-d1-ledger.sql");
  await writeFile(sqlPath, buildLegacyLedgerReconciliationSql(legacy), {
    mode: 0o600,
  });
  const command = buildD1ExecuteTemplate(input.configPath).map((part) =>
    part === "{resource}" ? resource : part === "{sql_file}" ? sqlPath : part,
  );
  await run(command);
  console.warn(
    `[takosumi:release] Reconciled ${legacy.length} legacy d1_migrations rows into yurucommu_migrations before applying pending migrations.`,
  );
}

async function run(
  command: readonly string[],
  options: { readonly allowMissingDestroyResource?: boolean } = {},
): Promise<void> {
  console.log(`\n> ${command.map(shellArg).join(" ")}\n`);
  const retryPolicy = releaseCommandRetryPolicy(env);
  for (let attempt = 1; attempt <= retryPolicy.attempts; attempt += 1) {
    const child = Bun.spawn([...command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    if (code === 0) return;
    const combinedOutput = `${stdout}\n${stderr}`;
    if (isIgnorableDestroyFailure(command, `${stdout}\n${stderr}`)) {
      console.warn(
        "[takosumi:release] Ignoring missing release resource during destroy.",
      );
      return;
    }
    if (
      attempt < retryPolicy.attempts &&
      isRetryableCommandFailure(combinedOutput)
    ) {
      console.warn(
        `[takosumi:release] Retryable command failure; retrying ${attempt + 1}/${retryPolicy.attempts} after ${retryPolicy.intervalMs}ms.`,
      );
      await sleep(retryPolicy.intervalMs);
      continue;
    }
    throw new Error(`Command failed (${code}): ${command.join(" ")}`);
  }
}

async function runForStdout(command: readonly string[]): Promise<string> {
  console.log(`\n> ${command.map(shellArg).join(" ")}\n`);
  const retryPolicy = releaseCommandRetryPolicy(env);
  for (let attempt = 1; attempt <= retryPolicy.attempts; attempt += 1) {
    const child = Bun.spawn([...command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    process.stderr.write(stderr);
    if (code === 0) return stdout;
    if (
      attempt < retryPolicy.attempts &&
      isRetryableCommandFailure(`${stdout}\n${stderr}`)
    ) {
      console.warn(
        `[takosumi:release] Retryable query failure; retrying ${attempt + 1}/${retryPolicy.attempts} after ${retryPolicy.intervalMs}ms.`,
      );
      await sleep(retryPolicy.intervalMs);
      continue;
    }
    throw new Error(`Command failed (${code}): ${command.join(" ")}`);
  }
  throw new Error(`Command exhausted retries: ${command.join(" ")}`);
}

export function isRetryableCommandFailure(output: string): boolean {
  return /Cloudflare's API timed out|fetch failed|fetch request failed|A fetch request failed|network connectivity|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP (?:429|5\d\d)\b|status(?: code)?:? (?:429|5\d\d)\b/i.test(
    output,
  );
}

function releaseCommandRetryPolicy(
  sourceEnv: Record<string, string | undefined>,
): { readonly attempts: number; readonly intervalMs: number } {
  return {
    attempts: positiveInt(
      sourceEnv.YURUCOMMU_RELEASE_RETRY_ATTEMPTS,
      DEFAULT_RELEASE_COMMAND_RETRY_ATTEMPTS,
    ),
    intervalMs: positiveInt(
      sourceEnv.YURUCOMMU_RELEASE_RETRY_INTERVAL_MS,
      DEFAULT_RELEASE_COMMAND_RETRY_INTERVAL_MS,
    ),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIgnorableDestroyFailure(
  command: readonly string[],
  output: string,
): boolean {
  if (command.includes("queues") && command.includes("consumer")) {
    return /No worker consumer .* exists for queue|Queue .* does not exist/u.test(
      output,
    );
  }
  if (command.includes("delete")) {
    return /not found|does not exist|No such Worker/i.test(output);
  }
  return false;
}

function applyWranglerEnv(config: YurucommuReleaseConfig): () => void {
  const previousAccountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!previousAccountId && config.cloudflareAccountId) {
    env.CLOUDFLARE_ACCOUNT_ID = config.cloudflareAccountId;
  }
  return () => {
    if (previousAccountId === undefined) {
      delete env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      env.CLOUDFLARE_ACCOUNT_ID = previousAccountId;
    }
  };
}

export function shouldSkipD1Migrations(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function collectWorkerVars(
  appUrl: string,
  queueNames: unknown,
  sourceEnv: Record<string, string | undefined>,
): Record<string, string> {
  const vars: Record<string, string> = {
    APP_URL: appUrl,
    DELIVERY_QUEUE_NAME: nestedString(queueNames, "delivery") ?? "",
    DELIVERY_DLQ_NAME: nestedString(queueNames, "delivery_dlq") ?? "",
  };
  for (const name of OPTIONAL_VAR_ENV) {
    const value = sourceEnv[name];
    if (value?.trim()) vars[name] = value;
  }
  return Object.fromEntries(
    Object.entries(vars).filter(([, value]) => value.trim() !== ""),
  );
}

function collectWorkerSecrets(
  sourceEnv: Record<string, string | undefined>,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [source, target] of Object.entries(SECRET_ENV_MAP)) {
    const value = sourceEnv[source];
    if (value?.trim()) secrets[target] = value;
  }
  return secrets;
}

export function missingReleaseReadinessInputs(
  config: YurucommuReleaseConfig,
): string[] {
  const hasAuth =
    Boolean(config.secrets.AUTH_PASSWORD_HASH) ||
    (Boolean(config.vars.GOOGLE_CLIENT_ID) &&
      Boolean(config.secrets.GOOGLE_CLIENT_SECRET)) ||
    (Boolean(config.vars.X_CLIENT_ID) &&
      Boolean(config.secrets.X_CLIENT_SECRET)) ||
    (Boolean(config.vars.TAKOSUMI_ACCOUNTS_ISSUER_URL) &&
      Boolean(config.vars.TAKOSUMI_ACCOUNTS_CLIENT_ID)) ||
    (Boolean(config.vars.OIDC_ISSUER_URL) &&
      Boolean(config.vars.OIDC_CLIENT_ID));
  const missing: string[] = [];
  if (!config.secrets.ENCRYPTION_KEY) missing.push("ENCRYPTION_KEY");
  if (!hasAuth) missing.push("AUTH_METHOD");
  return missing;
}

function assertReleaseReadinessConfig(config: YurucommuReleaseConfig): void {
  const missing = missingReleaseReadinessInputs(config);
  if (missing.length !== 0) {
    throw new Error(
      `Refusing to deploy a Worker that cannot become ready; provide operator inputs: ${missing.join(", ")}`,
    );
  }
}

function requireStringOutput(outputs: JsonRecord, name: string): string {
  const value = optionalStringOutput(outputs, name);
  if (!value) {
    throw new Error(
      `TAKOSUMI_OUTPUTS_JSON must include string output "${name}"`,
    );
  }
  return value;
}

function optionalStringOutput(
  outputs: JsonRecord,
  name: string,
): string | undefined {
  const value = outputValue(outputs[name]);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function outputValue(entry: unknown): unknown {
  if (isRecord(entry) && "value" in entry && "sensitive" in entry) {
    return entry.value;
  }
  return entry;
}

function nestedString(value: unknown, key: string): string | undefined {
  const record = outputValue(value);
  if (!isRecord(record)) return undefined;
  const nested = outputValue(record[key]);
  return typeof nested === "string" && nested.trim() ? nested : undefined;
}

function firstString(
  ...values: readonly (string | undefined)[]
): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  await main();
}
