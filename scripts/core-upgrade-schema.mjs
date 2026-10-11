// A bounded, read-only readiness probe for the Core 4.1.12 schema. This checks
// release prerequisites, not migration contents, existing rows, or live state.
export const CORE_UPGRADE_MIGRATIONS = [
  "0031_account_deletion_reservations.sql",
  "0032_outbox_revocations.sql",
  "0033_delivery_reconciliation.sql",
  "0034_staged_media_retention.sql",
  "0035_published_media_deletion_claims.sql",
  "0036_notification_push_actor_fk_repair.sql",
];

const TABLE_COLUMNS = {
  account_deletions: [
    "id",
    "root_actor_ap_id",
    "root_public_key_pem",
    "worker_token",
    "lease_expires_at",
  ],
  account_deletion_targets: [
    "actor_ap_id",
    "operation_id",
    "public_key_pem",
    "cascade_complete",
  ],
  account_deletion_object_targets: ["object_ap_id", "operation_id"],
  media_upload_attempts: [
    "id",
    "r2_key",
    "uploader_ap_id",
    "public_key_pem",
    "phase",
  ],
  actor_write_assertions: ["id", "witness", "operation_id"],
  outbox_revocations: ["activity_ap_id"],
  delivery_queue: ["reconcile_attempt", "dlq_pending", "processing_token"],
  media_upload_lifetimes: [
    "r2_key",
    "upload_id",
    "uploader_ap_id",
    "public_key_pem",
    "state",
    "created_at",
    "expires_at",
  ],
  media_staged_references: ["r2_key", "source_kind", "source_id"],
  media_staged_ambiguity: ["source_kind", "source_id"],
  media_staged_source_inputs: ["source_kind", "source_id", "payload"],
  media_staged_backfill: ["source_kind", "cursor", "complete"],
  media_blob_deletion_claims: [
    "r2_key",
    "uploader_ap_id",
    "upload_id",
    "created_at",
  ],
  notification_pushers: [
    "id",
    "actor_ap_id",
    "product",
    "kind",
    "app_id",
    "pushkey",
    "pushkey_hash",
    "gateway_url",
    "data_json",
    "last_seen_at",
  ],
  notification_push_jobs: [
    "id",
    "actor_ap_id",
    "activity_ap_id",
    "product",
    "status",
    "processing_token",
    "pending_pusher_ids_json",
    "next_attempt_at",
  ],
};

const INDEX_COLUMNS = {
  account_deletions_root_idx: ["root_actor_ap_id"],
  delivery_queue_reconcile_due_idx: ["next_attempt_at"],
  media_upload_lifetimes_due_idx: ["state", "expires_at", "r2_key"],
  media_blob_deletion_jobs_uploader_idx: ["uploader_ap_id"],
  notification_pushers_actor_product_idx: ["actor_ap_id", "product"],
  notification_push_jobs_actor_activity_idx: ["actor_ap_id", "activity_ap_id"],
};

const INDEX_TABLES = {
  account_deletions_root_idx: "account_deletions",
  delivery_queue_reconcile_due_idx: "delivery_queue",
  media_upload_lifetimes_due_idx: "media_upload_lifetimes",
  media_blob_deletion_jobs_uploader_idx: "media_blob_deletion_jobs",
  notification_pushers_actor_product_idx: "notification_pushers",
  notification_push_jobs_actor_activity_idx: "notification_push_jobs",
};

const TRIGGERS = {
  media_upload_attempts_insert: "media_upload_attempts",
  account_deletion_actors_insert: "actors",
  outbox_revocations_after_object_delete: "objects",
  outbox_revocations_after_activity_delete: "activities",
  media_staged_lifetime_admission: "media_upload_lifetimes",
  media_staged_claim_proof: "media_upload_lifetimes",
  media_blob_claim_admission: "media_blob_deletion_claims",
  media_blob_account_target_release: "account_deletion_targets",
  account_deletion_notification_pushers_insert: "notification_pushers",
  account_deletion_notification_pushers_update: "notification_pushers",
  account_deletion_notification_push_jobs_insert: "notification_push_jobs",
};

const VIEWS = ["media_staged_normalized", "media_blob_deletion_claimable"];
const OBJECT_NAMES = [
  ...Object.keys(TABLE_COLUMNS),
  ...Object.keys(INDEX_COLUMNS),
  ...Object.keys(TRIGGERS),
  ...VIEWS,
];
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const literalList = (values) => values.map(quote).join(",");

export const CORE_UPGRADE_SCHEMA_QUERY = [
  `SELECT 'migration' AS kind, '' AS owner, name, '' AS detail
   FROM yurucommu_migrations WHERE name IN (${literalList(CORE_UPGRADE_MIGRATIONS)})`,
  `SELECT type AS kind, tbl_name AS owner, name, sql AS detail
   FROM sqlite_schema WHERE name IN (${literalList(OBJECT_NAMES)})`,
  ...Object.keys(TABLE_COLUMNS).map(
    (table) =>
      `SELECT 'column' AS kind, ${quote(table)} AS owner, name, type AS detail
       FROM pragma_table_info(${quote(table)})`,
  ),
  ...Object.keys(INDEX_COLUMNS).map(
    (index) =>
      `SELECT 'index-column' AS kind, ${quote(index)} AS owner, name,
              CAST(seqno AS TEXT) AS detail
       FROM pragma_index_info(${quote(index)})`,
  ),
  ...["notification_pushers", "notification_push_jobs"].map(
    (table) =>
      `SELECT 'foreign-key' AS kind, ${quote(table)} AS owner,
              "table" AS name, "from" AS detail
       FROM pragma_foreign_key_list(${quote(table)})`,
  ),
].join("\nUNION ALL\n");

function fail(message) {
  throw new Error(`Core 4.1.12 D1 preflight failed: ${message}`);
}

export function validateCoreUpgradeQueryResults(queryResults) {
  if (!Array.isArray(queryResults) || queryResults.length !== 1) {
    fail("D1 API must return exactly one query result");
  }
  const result = queryResults[0];
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.success !== true ||
    !Array.isArray(result.results) ||
    (result.meta !== undefined &&
      (!result.meta ||
        typeof result.meta !== "object" ||
        Array.isArray(result.meta)))
  ) {
    fail("D1 API returned an unsuccessful or malformed query result");
  }
  if (
    (result.meta?.changed_db !== undefined &&
      typeof result.meta.changed_db !== "boolean") ||
    (result.meta?.rows_written !== undefined &&
      (!Number.isInteger(result.meta.rows_written) ||
        result.meta.rows_written < 0))
  ) {
    fail("D1 query returned malformed write metadata");
  }
  if (result.meta?.changed_db === true || result.meta?.rows_written > 0) {
    fail("D1 metadata query reported a database write");
  }

  const rows = result.results;
  const kinds = new Set([
    "migration",
    "table",
    "index",
    "trigger",
    "view",
    "column",
    "index-column",
    "foreign-key",
  ]);
  if (
    rows.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(",") !== "detail,kind,name,owner" ||
        !kinds.has(row.kind) ||
        !["kind", "owner", "name"].every(
          (key) => typeof row[key] === "string",
        ) ||
        !["string", "null"].includes(
          row.detail === null ? "null" : typeof row.detail,
        ),
    )
  ) {
    fail("D1 metadata row is malformed");
  }
  const find = (kind, owner, name) =>
    rows.filter(
      (row) => row.kind === kind && row.owner === owner && row.name === name,
    );
  for (const name of CORE_UPGRADE_MIGRATIONS) {
    if (find("migration", "", name).length !== 1) {
      fail(`migration ledger is missing or duplicates ${name}`);
    }
  }
  for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
    if (find("table", table, table).length !== 1) {
      fail(`required table ${table} is missing`);
    }
    for (const column of columns) {
      if (find("column", table, column).length !== 1) {
        fail(`required column ${table}.${column} is missing`);
      }
    }
  }
  for (const [index, columns] of Object.entries(INDEX_COLUMNS)) {
    if (find("index", INDEX_TABLES[index], index).length !== 1) {
      fail(`required index ${index} is missing`);
    }
    const actual = rows
      .filter((row) => row.kind === "index-column" && row.owner === index)
      .sort((a, b) => Number(a.detail) - Number(b.detail));
    if (
      actual.length !== columns.length ||
      actual.some(
        (row, ordinal) =>
          row.detail !== String(ordinal) || row.name !== columns[ordinal],
      )
    ) {
      fail(`required index ${index} has unexpected columns`);
    }
  }
  for (const [trigger, table] of Object.entries(TRIGGERS)) {
    if (find("trigger", table, trigger).length !== 1) {
      fail(`required trigger ${trigger} is missing`);
    }
  }
  for (const view of VIEWS) {
    if (find("view", view, view).length !== 1) {
      fail(`required view ${view} is missing`);
    }
  }
  if (rows.some((row) => row.kind === "foreign-key")) {
    fail("repaired notification push tables still have foreign keys");
  }
  for (const trigger of [
    "account_deletion_notification_pushers_insert",
    "account_deletion_notification_pushers_update",
    "account_deletion_notification_push_jobs_insert",
  ]) {
    const sql = find("trigger", TRIGGERS[trigger], trigger)[0].detail;
    if (
      typeof sql !== "string" ||
      !sql.includes("account_deletion_targets") ||
      !sql.includes("actor_write_assertions") ||
      !sql.includes("RAISE(ABORT")
    ) {
      fail(`repaired push reservation trigger ${trigger} has unexpected SQL`);
    }
  }
  const due = find(
    "index",
    "delivery_queue",
    "delivery_queue_reconcile_due_idx",
  )[0]?.detail;
  if (
    typeof due !== "string" ||
    !/WHERE\s+status\s*=\s*'dead_letter'\s+AND\s+dlq_pending\s*=\s*1/iu.test(
      due,
    )
  ) {
    fail("delivery reconciliation due index has unexpected predicate");
  }
  return {
    kind: "yurucommu.core-upgrade-schema@v1",
    migrations: [...CORE_UPGRADE_MIGRATIONS],
    scope: "migration-0031-through-0036-prerequisites",
  };
}
