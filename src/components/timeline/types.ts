import type { MediaAttachment } from "../../types/index.ts";

export type UploadedMedia = MediaAttachment & {
  preview: string;
};
