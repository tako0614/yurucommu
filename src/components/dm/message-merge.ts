import type { ChatMessage } from "./conversation-source.ts";

/**
 * Merge a freshly-fetched message list into the existing list, deduplicating
 * by message id. The server-ordered `fetched` list is authoritative; any
 * existing message not yet present in it (e.g. an optimistic send the server
 * has not indexed yet) is appended at the end so it does not flicker out.
 */
export function mergeMessagesById(
  existing: ChatMessage[],
  fetched: ChatMessage[],
): ChatMessage[] {
  // The common poll path has the same id sequence. Return the previous array
  // before allocating a Set or merged copy, even when fetched objects changed.
  if (existing.length === fetched.length) {
    let sameIds = true;
    for (let index = 0; index < existing.length; index += 1) {
      if (existing[index].id !== fetched[index].id) {
        sameIds = false;
        break;
      }
    }
    if (sameIds) return existing;
  }

  const fetchedIds = new Set<string>();
  for (const message of fetched) fetchedIds.add(message.id);

  // Keep the server's array/reference when there are no pending messages.
  // Only copy it once the first pending message needs to be appended.
  let merged: ChatMessage[] | null = null;
  for (const message of existing) {
    if (fetchedIds.has(message.id)) continue;
    if (merged === null) merged = [...fetched];
    merged.push(message);
  }

  if (merged === null) return fetched;

  // No-op guard: if the merged id-sequence is identical to the existing one,
  // return the previous array reference so the messages signal does not
  // change identity on a poll that fetched nothing new.
  if (merged.length === existing.length) {
    let sameIds = true;
    for (let index = 0; index < existing.length; index += 1) {
      if (merged[index].id !== existing[index].id) {
        sameIds = false;
        break;
      }
    }
    if (sameIds) return existing;
  }

  return merged;
}
