import { atom } from "jotai/vanilla";
import type { Post } from "../types/index.ts";
import { fetchBookmarks } from "../lib/api.ts";
import { actorAtom } from "./auth.ts";
import { tAtom } from "./i18n.ts";
import {
  type BookmarkRead,
  beginBookmarkRead,
  finishBookmarkRead,
  ownsBookmarkRead,
  reconcileBookmarkRead,
} from "./bookmark-reads.ts";

type Requests = {
  generation: number;
  ticket: object | null;
  fullRead: BookmarkRead | null;
  pager: object | null;
  pagerRead: BookmarkRead | null;
  disposed: boolean;
};

export function createBookmarksState() {
  const posts = atom<Post[]>([]);
  const loading = atom(true);
  const cursor = atom<string | null>(null);
  const hasMore = atom(false);
  const loadingMore = atom(false);
  const loadError = atom<string | null>(null);
  const error = atom<string | null>(null);
  const requests = atom<Requests>({
    generation: 0,
    ticket: null,
    fullRead: null,
    pager: null,
    pagerRead: null,
    disposed: false,
  });

  const load = atom(null, async (get, set) => {
    const prior = get(requests);
    if (prior.disposed) return;
    const generation = prior.generation + 1;
    const ticket = {};
    const actorApId = get(actorAtom)?.ap_id;
    if (prior.fullRead) finishBookmarkRead(get, set, prior.fullRead);
    if (prior.pagerRead) finishBookmarkRead(get, set, prior.pagerRead);
    const read = beginBookmarkRead(get, set);
    set(requests, {
      generation,
      ticket,
      fullRead: read,
      pager: null,
      pagerRead: null,
      disposed: false,
    });
    if (get(posts).length === 0) set(loading, true);
    set(loadingMore, false);
    set(cursor, null);
    set(hasMore, false);
    set(loadError, null);
    try {
      const page = await fetchBookmarks();
      const active = get(requests);
      if (
        active.generation !== generation ||
        active.ticket !== ticket ||
        active.disposed ||
        actorApId !== get(actorAtom)?.ap_id ||
        !ownsBookmarkRead(get, read)
      )
        return;
      const reconciled = reconcileBookmarkRead(get, read, page.posts, [])!;
      set(
        posts,
        reconciled.filter((post) => post.bookmarked !== false),
      );
      set(cursor, page.nextCursor);
      set(hasMore, page.hasMore);
    } catch (cause) {
      const active = get(requests);
      if (
        active.generation !== generation ||
        active.ticket !== ticket ||
        active.disposed ||
        actorApId !== get(actorAtom)?.ap_id ||
        !ownsBookmarkRead(get, read)
      )
        return;
      console.error("Failed to load bookmarks:", cause);
      set(loadError, get(tAtom)("common.loadFailed"));
    } finally {
      finishBookmarkRead(get, set, read);
      const active = get(requests);
      if (active.generation === generation && active.ticket === ticket) {
        set(requests, { ...active, fullRead: null });
        set(loading, false);
      }
    }
  });

  const loadMore = atom(null, async (get, set) => {
    const state = get(requests);
    const before = get(cursor);
    if (
      state.disposed ||
      state.pager !== null ||
      get(loadingMore) ||
      !get(hasMore) ||
      !before
    )
      return;
    const generation = state.generation;
    const ticket = state.ticket;
    const pager = {};
    const actorApId = get(actorAtom)?.ap_id;
    const read = beginBookmarkRead(get, set);
    set(requests, { ...state, pager, pagerRead: read });
    set(loadingMore, true);
    const ownsPager = () => {
      const active = get(requests);
      return (
        active.generation === generation &&
        active.ticket === ticket &&
        active.pager === pager &&
        !active.disposed &&
        get(cursor) === before &&
        actorApId === get(actorAtom)?.ap_id &&
        ownsBookmarkRead(get, read)
      );
    };
    try {
      const page = await fetchBookmarks({ before });
      if (!ownsPager()) return;
      const reconciled = reconcileBookmarkRead(get, read, page.posts, [])!;
      const seen = new Set(get(posts).map((post) => post.ap_id));
      const appended: Post[] = [];
      for (const post of reconciled) {
        if (post.bookmarked === false || seen.has(post.ap_id)) continue;
        seen.add(post.ap_id);
        appended.push(post);
      }
      set(posts, [...get(posts), ...appended]);
      // Paging metadata belongs to the server page even when reconciliation
      // removes every row from that page.
      set(cursor, page.nextCursor);
      set(hasMore, page.hasMore);
    } catch (cause) {
      if (!ownsPager()) return;
      console.error("Failed to load more bookmarks:", cause);
      set(error, get(tAtom)("common.error"));
    } finally {
      finishBookmarkRead(get, set, read);
      const active = get(requests);
      if (
        active.generation === generation &&
        active.ticket === ticket &&
        active.pager === pager
      ) {
        set(requests, { ...active, pager: null, pagerRead: null });
        set(loadingMore, false);
      }
    }
  });

  const dispose = atom(null, (get, set) => {
    const state = get(requests);
    if (state.disposed) return;
    if (state.fullRead) finishBookmarkRead(get, set, state.fullRead);
    if (state.pagerRead) finishBookmarkRead(get, set, state.pagerRead);
    set(requests, {
      generation: state.generation + 1,
      ticket: null,
      fullRead: null,
      pager: null,
      pagerRead: null,
      disposed: true,
    });
  });

  return {
    posts,
    loading,
    cursor,
    hasMore,
    loadingMore,
    loadError,
    error,
    load,
    loadMore,
    dispose,
  };
}
