import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";

import {
  MEDIA_DELETION_SCHEMA_QUERY,
  validateMediaDeletionQueryResults,
} from "./media-deletion-schema.mjs";

describe("Core 4.1.11 migration 0030 metadata qualification", () => {
  test("fixed SELECT rejects an empty DB and accepts the exact locked Core migration", async () => {
    const database = new Database(":memory:");
    try {
      const rows = () => database.query(MEDIA_DELETION_SCHEMA_QUERY).all();
      expect(() =>
        validateMediaDeletionQueryResults([
          { success: true, results: rows(), meta: { changed_db: false } },
        ]),
      ).toThrow(/columns or primary key/u);

      const migration = await readFile(
        new URL(
          "../deploy/takoform/migrations/sql/0030_media_blob_deletion_jobs.sql",
          import.meta.url,
        ),
        "utf8",
      );
      const lockedCoreMigration = await readFile(
        new URL(
          "../node_modules/@takosjp/yurucommu-core/migrations/0030_media_blob_deletion_jobs.sql",
          import.meta.url,
        ),
        "utf8",
      );
      expect(migration).toBe(lockedCoreMigration);
      database.exec(migration);
      expect(
        validateMediaDeletionQueryResults([
          { success: true, results: rows(), meta: { changed_db: false } },
        ]),
      ).toEqual({
        kind: "yurucommu.core-media-deletion-schema@v1",
        table: "media_blob_deletion_jobs",
        index: "media_blob_deletion_jobs_due_idx",
        scope: "migration-0030-only",
      });
    } finally {
      database.close();
    }
  });

  test("fails closed for duplicate, unsuccessful, malformed, or write-reporting API results", () => {
    const expected = {
      success: true,
      results: [
        {
          kind: "column",
          ordinal: 0,
          name: "r2_key",
          detail: "TEXT",
          required: 1,
          position: 1,
        },
        {
          kind: "column",
          ordinal: 1,
          name: "uploader_ap_id",
          detail: "TEXT",
          required: 1,
          position: 0,
        },
        {
          kind: "column",
          ordinal: 2,
          name: "created_at",
          detail: "TEXT",
          required: 1,
          position: 0,
        },
        {
          kind: "column",
          ordinal: 3,
          name: "next_attempt_at",
          detail: "TEXT",
          required: 1,
          position: 0,
        },
        {
          kind: "index",
          ordinal: 0,
          name: "media_blob_deletion_jobs_due_idx",
          detail: "c",
          required: 0,
          position: 0,
        },
        {
          kind: "index-column",
          ordinal: 0,
          name: "next_attempt_at",
          detail: "",
          required: 0,
          position: 3,
        },
        {
          kind: "index-column",
          ordinal: 1,
          name: "created_at",
          detail: "",
          required: 0,
          position: 2,
        },
        {
          kind: "index-column",
          ordinal: 2,
          name: "r2_key",
          detail: "",
          required: 0,
          position: 0,
        },
      ],
      meta: { changed_db: false, rows_written: 0 },
    };
    expect(validateMediaDeletionQueryResults([expected])).toMatchObject({
      scope: "migration-0030-only",
    });

    for (const bad of [
      [],
      [expected, expected],
      [{ ...expected, success: false }],
      [{ ...expected, results: expected.results.slice(1) }],
      [
        {
          ...expected,
          results: expected.results.map((row) =>
            row.kind === "column" && row.name === "r2_key"
              ? { ...row, position: 0 }
              : row,
          ),
        },
      ],
      [
        {
          ...expected,
          results: expected.results.map((row) =>
            row.kind === "index" ? { ...row, required: 1 } : row,
          ),
        },
      ],
      [
        {
          ...expected,
          results: expected.results.map((row) =>
            row.kind === "index-column" && row.ordinal === 0
              ? { ...row, name: "created_at" }
              : row,
          ),
        },
      ],
      [
        {
          ...expected,
          results: [...expected.results, expected.results[0]],
        },
      ],
      [{ ...expected, meta: { changed_db: true } }],
      [{ ...expected, meta: { rows_written: 1 } }],
      [{ ...expected, meta: { changed_db: "true" } }],
      [{ ...expected, meta: { rows_written: "1" } }],
      [{ ...expected, meta: { rows_written: -1 } }],
      [{ ...expected, meta: { rows_written: 0.5 } }],
      [{ ...expected, results: [...expected.results, { kind: "extra" }] }],
    ]) {
      expect(() => validateMediaDeletionQueryResults(bad)).toThrow();
    }
  });
});
