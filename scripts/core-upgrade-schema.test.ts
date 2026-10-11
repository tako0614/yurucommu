import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  CORE_UPGRADE_MIGRATIONS,
  CORE_UPGRADE_SCHEMA_QUERY,
  validateCoreUpgradeQueryResults,
} from "./core-upgrade-schema.mjs";

const tables: Record<string, string[]> = {
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
  delivery_queue: [
    "reconcile_attempt",
    "dlq_pending",
    "processing_token",
    "next_attempt_at",
    "status",
  ],
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
  media_blob_deletion_jobs: ["r2_key", "uploader_ap_id"],
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
  actors: ["id"],
  objects: ["id"],
  activities: ["id"],
};

const indexes: Record<string, [string, string]> = {
  account_deletions_root_idx: ["account_deletions", "root_actor_ap_id"],
  media_upload_lifetimes_due_idx: [
    "media_upload_lifetimes",
    "state,expires_at,r2_key",
  ],
  media_blob_deletion_jobs_uploader_idx: [
    "media_blob_deletion_jobs",
    "uploader_ap_id",
  ],
  notification_pushers_actor_product_idx: [
    "notification_pushers",
    "actor_ap_id,product",
  ],
  notification_push_jobs_actor_activity_idx: [
    "notification_push_jobs",
    "actor_ap_id,activity_ap_id",
  ],
};

const triggers: Record<string, string> = {
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

function metadataRows(options: { actorForeignKey?: boolean } = {}) {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE yurucommu_migrations (name TEXT PRIMARY KEY, applied_at TEXT)",
    );
    for (const name of CORE_UPGRADE_MIGRATIONS) {
      db.query("INSERT INTO yurucommu_migrations (name) VALUES (?)").run(name);
    }
    for (const [table, columns] of Object.entries(tables)) {
      const foreignKey =
        options.actorForeignKey && table === "notification_pushers"
          ? ", FOREIGN KEY (actor_ap_id) REFERENCES actors(id) ON DELETE CASCADE"
          : "";
      db.exec(
        `CREATE TABLE ${table} (${columns.map((column) => `${column} TEXT`).join(",")}${foreignKey})`,
      );
    }
    for (const [index, [table, columns]] of Object.entries(indexes)) {
      db.exec(`CREATE INDEX ${index} ON ${table}(${columns})`);
    }
    db.exec(
      "CREATE INDEX delivery_queue_reconcile_due_idx ON delivery_queue(next_attempt_at) WHERE status = 'dead_letter' AND dlq_pending = 1",
    );
    db.exec("CREATE VIEW media_staged_normalized AS SELECT 1 AS value");
    db.exec("CREATE VIEW media_blob_deletion_claimable AS SELECT 1 AS value");
    for (const [trigger, table] of Object.entries(triggers)) {
      const guard = trigger.startsWith("account_deletion_notification_push")
        ? "SELECT CASE WHEN EXISTS(SELECT 1 FROM account_deletion_targets) AND EXISTS(SELECT 1 FROM actor_write_assertions) THEN RAISE(ABORT, 'account deletion reserved') END;"
        : "SELECT 1;";
      db.exec(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN ${guard} END`,
      );
    }
    return db.query(CORE_UPGRADE_SCHEMA_QUERY).all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

function response(rows: unknown[], meta: Record<string, unknown> = {}) {
  return [{ success: true, results: rows, meta }];
}

describe("Core 4.1.12 D1 upgrade readiness", () => {
  test("accepts the bounded target metadata shape", () => {
    expect(validateCoreUpgradeQueryResults(response(metadataRows()))).toEqual({
      kind: "yurucommu.core-upgrade-schema@v1",
      migrations: CORE_UPGRADE_MIGRATIONS,
      scope: "migration-0031-through-0036-prerequisites",
    });
  });

  test("rejects an old 0030-only database", () => {
    const db = new Database(":memory:");
    let rows: Record<string, unknown>[] = [];
    try {
      db.exec("CREATE TABLE yurucommu_migrations (name TEXT PRIMARY KEY)");
      db.exec(
        "INSERT INTO yurucommu_migrations(name) VALUES ('0030_media_blob_deletion_jobs.sql')",
      );
      db.exec(
        "CREATE TABLE media_blob_deletion_jobs (r2_key TEXT PRIMARY KEY, uploader_ap_id TEXT)",
      );
      db.exec(
        "CREATE INDEX media_blob_deletion_jobs_uploader_idx ON media_blob_deletion_jobs(uploader_ap_id)",
      );
      rows = db.query(CORE_UPGRADE_SCHEMA_QUERY).all() as Record<
        string,
        unknown
      >[];
    } finally {
      db.close();
    }
    expect(() => validateCoreUpgradeQueryResults(response(rows))).toThrow(
      "0031_account_deletion_reservations.sql",
    );
  });

  test("rejects a missing migration, column, index, or reservation trigger", () => {
    const cases = [
      ["migration", "0036_notification_push_actor_fk_repair.sql"],
      ["column", "dlq_pending"],
      ["index", "delivery_queue_reconcile_due_idx"],
      ["trigger", "account_deletion_notification_push_jobs_insert"],
    ];
    for (const [kind, name] of cases) {
      const rows = metadataRows().filter(
        (row) => row.kind !== kind || row.name !== name,
      );
      expect(() => validateCoreUpgradeQueryResults(response(rows))).toThrow();
    }
  });

  test("rejects an actor foreign key in the final push table", () => {
    expect(() =>
      validateCoreUpgradeQueryResults(
        response(metadataRows({ actorForeignKey: true })),
      ),
    ).toThrow("still have foreign keys");
  });

  test("rejects denied, malformed, or write-reported query results", () => {
    const rows = metadataRows();
    for (const result of [
      null,
      [],
      [{ success: false, results: rows }],
      [{ success: true, results: null }],
      response(rows, { changed_db: true }),
      response(rows, { rows_written: 1 }),
      response(rows, { rows_written: "0" }),
    ]) {
      expect(() => validateCoreUpgradeQueryResults(result)).toThrow();
    }
  });
});
