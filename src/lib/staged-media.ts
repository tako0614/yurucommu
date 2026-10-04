import type { ApiTransport } from "@takosjp/yurucommu-api";
import type { AuthStrategy } from "./plugin.ts";
import type { UploadedMedia } from "../components/timeline/types.ts";

/** Memory-only ownership of a staged upload, never an authentication token. */
export type MediaUploadScope = {
  actorApId: string;
  authEpoch: number;
  instanceId: string | null;
  hostedUserId: string | null;
  strategy: AuthStrategy;
  transport: ApiTransport;
  uploadUrl: string;
  postUrl: string;
};

export function mediaNeedsReupload(
  media: UploadedMedia,
  now = Date.now(),
): boolean {
  const deadline = media.expires_at ? Date.parse(media.expires_at) : NaN;
  return (
    media.needsReupload === true ||
    (Number.isFinite(deadline) && deadline <= now)
  );
}
