import type {
  StampCommunityMessage,
  StampDMMessage,
} from "../../lib/api/stamps.ts";

export type ChatMessage = StampDMMessage | StampCommunityMessage;

/**
 * Merge an authoritative newest page with locally appended messages. The
 * projection comparison includes a Stamp asset URL because remote snapshots
 * are switched to the verified local mirror after the background fetch.
 */
export function mergeMessagesById(
  existing: ChatMessage[],
  fetched: ChatMessage[],
): ChatMessage[] {
  const fetchedIds = new Set(fetched.map((message) => message.id));
  const pending = existing.filter((message) => !fetchedIds.has(message.id));
  const merged = pending.length > 0 ? [...fetched, ...pending] : fetched;

  if (
    merged.length === existing.length &&
    merged.every((message, index) =>
      sameMessageProjection(message, existing[index]),
    )
  ) {
    return existing;
  }
  return merged;
}

function sameMessageProjection(
  left: ChatMessage,
  right: ChatMessage | undefined,
): boolean {
  return (
    !!right &&
    left.id === right.id &&
    left.content === right.content &&
    left.created_at === right.created_at &&
    left.stamp?.revision === right.stamp?.revision &&
    left.stamp?.asset.url === right.stamp?.asset.url
  );
}
