export const CORE_UPGRADE_MIGRATIONS: string[];
export const CORE_UPGRADE_SCHEMA_QUERY: string;

export type CoreUpgradeSchemaQualification = {
  kind: "yurucommu.core-upgrade-schema@v1";
  migrations: string[];
  scope: "migration-0031-through-0036-prerequisites";
};

export function validateCoreUpgradeQueryResults(
  queryResults: unknown,
): CoreUpgradeSchemaQualification;
