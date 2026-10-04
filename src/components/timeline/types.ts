import type { MediaUploadScope } from "../../lib/staged-media.ts";

export type UploadedMedia = {
  url?: string;
  r2_key: string;
  content_type: string;
  preview: string;
  // ActivityPub-standard alt text (`name` on a Document attachment).
  name?: string;
  // These fields are local to the open composer and never sent or persisted.
  uploadId?: string;
  sourceFile?: File;
  expires_at?: string;
  needsReupload?: boolean;
  uploadScope?: MediaUploadScope;
};
