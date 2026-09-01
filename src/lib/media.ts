import type { MediaAttachment } from "../types/index.ts";

export function isVideoMediaAttachment(m: MediaAttachment): boolean {
  return (m.content_type || "").startsWith("video/");
}
