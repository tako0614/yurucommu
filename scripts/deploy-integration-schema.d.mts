export type FreshIntegrationSchemaOptions = {
  accountId: string;
  databaseId: string;
  token: string;
  repo: string;
  diagnosticsDir: string;
  fetchImpl?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
};

export type FreshIntegrationSchemaResult = {
  status: "APPLIED";
  databaseId: string;
  coreVersion: "4.1.15";
  migrationCount: 35;
  migrations: string[];
  mapSha256: string;
};

export type Prefix32RecoveryResult = {
  status: "APPLIED";
  phase: "recover-prefix32";
  databaseId: string;
  coreVersion: "4.1.15";
  prefixLength: 32;
  migrationCount: 35;
  applied: string[];
  skipped: string[];
  mapSha256: string;
};

export declare function applyFreshIntegrationSchema(
  options: FreshIntegrationSchemaOptions,
): Promise<FreshIntegrationSchemaResult>;

export declare function recoverPrefix32IntegrationSchema(
  options: FreshIntegrationSchemaOptions,
): Promise<Prefix32RecoveryResult>;

export declare const integrationSchemaTestSupport: Readonly<{
  migrationNames: readonly string[];
  migrationMapSha256: string;
  probeTable: string;
  probeLogTable: string;
  probeTrigger: string;
  assertMigrationScript(
    sql: string,
    migration: string,
    migrationSql: string,
  ): string;
  buildMigrationBatch(sql: string, migration: string): Array<{ sql: string }>;
  splitSqlStatements(sql: string): string[];
  assertEnvelope(
    result: unknown,
    expectedCount: number | undefined,
    label: string,
    context: unknown,
    requireRows?: boolean,
  ): unknown[];
  proveRestBatchAtomicity(context: unknown): Promise<void>;
  verifyCoreInputs(repo: string): Promise<{
    migrationsDir: string;
    applyMigrations: (options: unknown) => Promise<{
      applied: string[];
      skipped: string[];
    }>;
  }>;
  emptySchemaSql: string;
}>;
