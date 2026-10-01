export const MEDIA_DELETION_SCHEMA_QUERY: string;

export type MediaDeletionSchemaQualification = {
  kind: "yurucommu.core-media-deletion-schema@v1";
  table: "media_blob_deletion_jobs";
  index: "media_blob_deletion_jobs_due_idx";
  scope: "migration-0030-only";
};

export function validateMediaDeletionQueryResults(
  queryResults: unknown,
): MediaDeletionSchemaQualification;
