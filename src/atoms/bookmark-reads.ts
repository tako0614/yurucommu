import { atom, type Getter, type Setter } from "jotai/vanilla";
import { actorAtom } from "./auth.ts";
import type { Post } from "../types/index.ts";

export type BookmarkRead = { actorApId?: string; ticket: object };
type Window = BookmarkRead & { confirmed: ReadonlyMap<string, boolean> };
// Store-local and request-local: bookmark changes are reversible. A completed
// read leaves no overlay on later GETs, and nothing is persisted to storage.
const windowsAtom = atom<ReadonlyMap<object, Window>>(new Map());

export function beginBookmarkRead(get: Getter, set: Setter): BookmarkRead {
  const read = { actorApId: get(actorAtom)?.ap_id, ticket: {} };
  set(
    windowsAtom,
    new Map(get(windowsAtom)).set(read.ticket, {
      ...read,
      confirmed: new Map<string, boolean>(),
    }),
  );
  return read;
}

export function ownsBookmarkRead(get: Getter, read: BookmarkRead): boolean {
  return (
    get(windowsAtom).has(read.ticket) &&
    get(actorAtom)?.ap_id === read.actorApId
  );
}

export function finishBookmarkRead(
  get: Getter,
  set: Setter,
  read: BookmarkRead,
): void {
  const next = new Map(get(windowsAtom));
  next.delete(read.ticket);
  set(windowsAtom, next);
}

export function reconcileBookmarkRead(
  get: Getter,
  read: BookmarkRead,
  server: Post[],
  current: Post[],
): Post[] | null {
  if (!ownsBookmarkRead(get, read)) return null;
  const confirmed = get(windowsAtom).get(read.ticket)!.confirmed;
  if (confirmed.size === 0) return server;
  // Preserve a later displayed interaction on this object, including boosts,
  // but change only the bookmark field of the earlier server snapshot.
  const visible = new Map(current.map((post) => [post.ap_id, post.bookmarked]));
  return server.map((post) =>
    confirmed.has(post.ap_id)
      ? {
          ...post,
          bookmarked: visible.get(post.ap_id) ?? confirmed.get(post.ap_id)!,
        }
      : post,
  );
}

export const acknowledgeBookmarkReadAtom = atom(
  null,
  (
    get,
    set,
    change: { actorApId: string; apId: string; bookmarked: boolean },
  ): boolean => {
    if (get(actorAtom)?.ap_id !== change.actorApId) return false;
    const next = new Map(get(windowsAtom));
    for (const [ticket, window] of next) {
      if (window.actorApId !== change.actorApId) continue;
      next.set(ticket, {
        ...window,
        confirmed: new Map(window.confirmed).set(
          change.apId,
          change.bookmarked,
        ),
      });
    }
    set(windowsAtom, next);
    return true;
  },
);

// A pending optimistic toggle uses a temporary window too. A failure may
// restore its old flag only if no successful interaction superseded it.
export function hasBookmarkAcknowledgement(
  get: Getter,
  read: BookmarkRead,
  apId: string,
): boolean {
  return get(windowsAtom).get(read.ticket)?.confirmed.has(apId) === true;
}
