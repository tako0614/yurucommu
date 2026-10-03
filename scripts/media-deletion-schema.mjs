export const MEDIA_DELETION_SCHEMA_QUERY = `
SELECT 'column' AS kind, cid AS ordinal, name, type AS detail,
       "notnull" AS required, pk AS position
FROM pragma_table_info('media_blob_deletion_jobs')
UNION ALL
SELECT 'index' AS kind, 0 AS ordinal, name, origin AS detail,
       "unique" AS required, partial AS position
FROM pragma_index_list('media_blob_deletion_jobs')
WHERE name = 'media_blob_deletion_jobs_due_idx'
UNION ALL
SELECT 'index-column' AS kind, seqno AS ordinal, name, '' AS detail,
       0 AS required, cid AS position
FROM pragma_index_info('media_blob_deletion_jobs_due_idx')
ORDER BY kind, ordinal`;

const EXPECTED_COLUMNS = [
  { ordinal: 0, name: "r2_key", detail: "TEXT", required: 1, position: 1 },
  {
    ordinal: 1,
    name: "uploader_ap_id",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
  { ordinal: 2, name: "created_at", detail: "TEXT", required: 1, position: 0 },
  {
    ordinal: 3,
    name: "next_attempt_at",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
];

const EXPECTED_INDEX_COLUMNS = [
  { ordinal: 0, name: "next_attempt_at", position: 3 },
  { ordinal: 1, name: "created_at", position: 2 },
  { ordinal: 2, name: "r2_key", position: 0 },
];

function fail(message) {
  throw new Error(`Core 4.1.11 migration 0030 D1 preflight failed: ${message}`);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function assertMetadataRows(rows) {
  if (!Array.isArray(rows)) fail("D1 query results are not an array");
  const columns = [];
  const indexes = [];
  const indexColumns = [];

  for (const row of rows) {
    if (
      !exactKeys(row, [
        "kind",
        "ordinal",
        "name",
        "detail",
        "required",
        "position",
      ])
    ) {
      fail("D1 query returned a malformed migration 0030 metadata row");
    }
    if (row.kind === "column") columns.push(row);
    else if (row.kind === "index") indexes.push(row);
    else if (row.kind === "index-column") indexColumns.push(row);
    else fail("D1 query returned an unknown migration 0030 metadata row kind");
  }

  const sameRows = (actual, expected, keys) =>
    actual.length === expected.length &&
    actual.every((row, index) =>
      keys.every((key) => row[key] === expected[index][key]),
    );

  if (
    !sameRows(columns, EXPECTED_COLUMNS, [
      "ordinal",
      "name",
      "detail",
      "required",
      "position",
    ])
  ) {
    fail(
      "media_blob_deletion_jobs columns or primary key do not match migration 0030",
    );
  }
  if (
    !sameRows(
      indexes,
      [
        {
          ordinal: 0,
          name: "media_blob_deletion_jobs_due_idx",
          detail: "c",
          required: 0,
          position: 0,
        },
      ],
      ["ordinal", "name", "detail", "required", "position"],
    )
  ) {
    fail("migration 0030 due index is missing or has unexpected index flags");
  }
  if (
    !sameRows(indexColumns, EXPECTED_INDEX_COLUMNS, [
      "ordinal",
      "name",
      "position",
    ]) ||
    indexColumns.some((row) => row.detail !== "" || row.required !== 0)
  ) {
    fail("migration 0030 due index columns or order do not match");
  }
}

export function validateMediaDeletionQueryResults(queryResults) {
  if (!Array.isArray(queryResults) || queryResults.length !== 1) {
    fail("D1 API must return exactly one query result");
  }
  const queryResult = queryResults[0];
  if (
    !queryResult ||
    typeof queryResult !== "object" ||
    Array.isArray(queryResult) ||
    queryResult.success !== true ||
    !Array.isArray(queryResult.results) ||
    (queryResult.meta !== undefined &&
      (!queryResult.meta ||
        typeof queryResult.meta !== "object" ||
        Array.isArray(queryResult.meta)))
  ) {
    fail("D1 API returned an unsuccessful or malformed query result");
  }
  const meta = queryResult.meta;
  if (
    (meta?.changed_db !== undefined && typeof meta.changed_db !== "boolean") ||
    (meta?.rows_written !== undefined &&
      (!Number.isInteger(meta.rows_written) || meta.rows_written < 0))
  ) {
    fail("D1 query returned malformed write metadata");
  }
  if (
    meta?.changed_db === true ||
    (meta?.rows_written !== undefined && meta.rows_written > 0)
  ) {
    fail("D1 metadata query reported a database write");
  }
  assertMetadataRows(queryResult.results);
  return {
    kind: "yurucommu.core-media-deletion-schema@v1",
    table: "media_blob_deletion_jobs",
    index: "media_blob_deletion_jobs_due_idx",
    scope: "migration-0030-only",
  };
}
