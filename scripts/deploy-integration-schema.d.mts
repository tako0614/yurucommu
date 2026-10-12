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
  coreVersion: "4.1.14";
  migrationCount: 35;
  migrations: string[];
  mapSha256: string;
};

export declare function applyFreshIntegrationSchema(
  options: FreshIntegrationSchemaOptions,
): Promise<FreshIntegrationSchemaResult>;

export declare const integrationSchemaTestSupport: Readonly<{
  migrationNames: readonly string[];
  migrationMapSha256: string;
  probeTable: string;
  assertMigrationScript(
    sql: string,
    migration: string,
    migrationSql: string,
  ): string;
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
