import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Post } from "../types/index.ts";

function ensureBrowserGlobals() {
  if (typeof globalThis.localStorage === "undefined") {
    const values = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      length: 0,
    };
  }
  if (!globalThis.navigator?.language) {
    Object.defineProperty(globalThis, "navigator", {
      value: { language: "en-US" },
      configurable: true,
    });
  }
}

function post(name: string): Post {
  return {
    ap_id: `https://example.test/ap/objects/${name}`,
    type: "Note",
    author: {
      ap_id: "https://example.test/ap/users/owner",
      username: "owner@example.test",
      preferred_username: "owner",
      name: "Owner",
      icon_url: null,
    },
    content: name,
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 0,
    reply_count: 0,
    announce_count: 0,
    published: "2026-01-01T00:00:00.000Z",
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  };
}

function page(posts: Post[], cursor: string | null, hasMore = true) {
  return new Response(
    JSON.stringify({ posts, next_cursor: cursor, has_more: hasMore }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(kind: "unified" | "following") {
  ensureBrowserGlobals();
  const a = await import("./timeline.ts");
  const { toastsAtom } = await import("./toast.ts");
  const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");
  const lane =
    kind === "unified"
      ? {
          full: a.loadTimelineAtom,
          more: a.loadMoreTimelineAtom,
          posts: a.timelinePostsAtom,
          cursor: a.timelineCursorAtom,
          hasMore: a.timelineHasMoreAtom,
          loadingMore: a.timelineLoadingMoreAtom,
          loadedAt: a.timelineLoadedAtAtom,
          error: a.timelineLoadErrorAtom,
          path: "/api/timeline",
        }
      : {
          full: a.loadFollowingTimelineAtom,
          more: a.loadMoreFollowingTimelineAtom,
          posts: a.followingPostsAtom,
          cursor: a.followingCursorAtom,
          hasMore: a.followingHasMoreAtom,
          loadingMore: a.followingLoadingMoreAtom,
          loadedAt: a.followingLoadedAtAtom,
          error: a.followingLoadErrorAtom,
          path: "/api/timeline/following",
        };
  const requests: Array<ReturnType<typeof deferred<Response>> & { url: URL }> =
    [];
  const pending: Promise<void>[] = [];
  const original = globalThis.fetch;
  clearYurucommuFrontendPlugin();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "https://example.test",
    );
    const request = { ...deferred<Response>(), url };
    requests.push(request);
    return request.promise;
  }) as typeof fetch;
  const store = createStore();
  const start = (action: typeof lane.full) => {
    const promise = store.set(action);
    pending.push(promise);
    return promise;
  };
  const waitForRequests = async (count: number) => {
    for (let i = 0; i < 30 && requests.length < count; i++)
      await Promise.resolve();
    expect(requests.length).toBe(count);
  };
  return {
    lane,
    store,
    requests,
    start,
    waitForRequests,
    toastsAtom,
    cleanup: async () => {
      for (const request of requests) request.resolve(page([], null, false));
      await Promise.allSettled(pending);
      globalThis.fetch = original;
      clearYurucommuFrontendPlugin();
    },
  };
}

for (const kind of ["unified", "following"] as const) {
  test(`${kind} obsolete pager failure is silent after a refreshed head settles`, async () => {
    const f = await fixture(kind);
    const { lane, store, requests, start, waitForRequests, toastsAtom } = f;
    try {
      store.set(lane.posts, [post("old-head")]);
      store.set(lane.cursor, "old-cursor");
      const old = start(lane.more);
      await waitForRequests(1);
      const refresh = start(lane.full);
      await waitForRequests(2);
      requests[1].resolve(page([post("new-head")], "new-cursor"));
      await refresh;
      requests[0].reject(new Error("superseded request failed"));
      await old;
      expect(store.get(toastsAtom)).toEqual([]);
      expect(store.get(lane.posts).map((p) => p.content)).toEqual(["new-head"]);
      expect(store.get(lane.cursor)).toBe("new-cursor");
      expect(store.get(lane.hasMore)).toBe(true);
      expect(store.get(lane.loadingMore)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  for (const outcome of ["success", "failure"] as const) {
    for (const order of ["old-first", "current-first"] as const) {
      test(`${kind} refresh releases an old pager and fences its ${outcome}: ${order}`, async () => {
        const f = await fixture(kind);
        const { lane, store, requests, start, waitForRequests, toastsAtom } = f;
        const oldCursor = "2026-01-01T00:00:00.000Z old-ap-id";
        const freshCursor = "2026-01-02T00:00:00.000Z fresh-ap-id";
        const nextCursor = "2025-12-31T00:00:00.000Z current-page-ap-id";
        const head = post("fresh-head");
        const older = post("current-older");
        try {
          store.set(lane.posts, [post("old-head")]);
          store.set(lane.cursor, oldCursor);
          store.set(lane.hasMore, true);
          store.set(toastsAtom, [
            { id: -1, kind: "info", message: "existing feedback", timeout: 0 },
          ]);
          const old = start(lane.more);
          await waitForRequests(1);
          expect(store.get(lane.loadingMore)).toBe(true);
          expect(requests[0].url.pathname).toBe(lane.path);
          expect(requests[0].url.searchParams.get("before")).toBe(oldCursor);
          const refresh = start(lane.full);
          await waitForRequests(2);
          expect(store.get(lane.loadingMore)).toBe(false);
          expect(store.get(lane.cursor)).toBeNull();
          // A pending replacement head has no usable paging boundary.
          await store.set(lane.more);
          expect(requests.length).toBe(2);
          requests[1].resolve(page([head], freshCursor));
          await refresh;
          expect(store.get(lane.posts).map((p) => p.ap_id)).toEqual([
            head.ap_id,
          ]);
          expect(store.get(lane.cursor)).toBe(freshCursor);
          const loadedAt = store.get(lane.loadedAt);
          const current = start(lane.more);
          await waitForRequests(3);
          expect(requests[2].url.searchParams.get("before")).toBe(freshCursor);
          expect(store.get(lane.loadingMore)).toBe(true);
          // A second demand cannot open a parallel pager for the same cursor.
          await store.set(lane.more);
          expect(requests.length).toBe(3);
          const releaseOld = async () => {
            if (outcome === "success") {
              requests[0].resolve(
                page([post("obsolete-older")], "old-next", false),
              );
            } else {
              requests[0].reject(new Error("obsolete page offline"));
            }
            await old;
          };
          const releaseCurrent = async () => {
            // Preserve a local field mutation made while this page was held.
            store.set(lane.posts, (rows) =>
              rows.map((p) => ({ ...p, liked: true })),
            );
            requests[2].resolve(page([older], nextCursor, false));
            await current;
          };
          if (order === "old-first") {
            await releaseOld();
            expect(store.get(lane.loadingMore)).toBe(true);
            expect(store.get(lane.posts).map((p) => p.ap_id)).toEqual([
              head.ap_id,
            ]);
            expect(store.get(lane.cursor)).toBe(freshCursor);
            expect(store.get(lane.hasMore)).toBe(true);
            await store.set(lane.more);
            expect(requests.length).toBe(3);
            await releaseCurrent();
          } else {
            await releaseCurrent();
            await releaseOld();
          }
          expect(store.get(lane.posts).map((p) => p.ap_id)).toEqual([
            head.ap_id,
            older.ap_id,
          ]);
          expect(store.get(lane.posts)[0].liked).toBe(true);
          expect(store.get(lane.cursor)).toBe(nextCursor);
          expect(store.get(lane.hasMore)).toBe(false);
          expect(store.get(lane.loadingMore)).toBe(false);
          expect(store.get(lane.loadedAt)).toBe(loadedAt);
          expect(store.get(lane.error)).toBeNull();
          expect(store.get(toastsAtom).map((toast) => toast.message)).toEqual([
            "existing feedback",
          ]);
          expect(requests.length).toBe(3);
        } finally {
          await f.cleanup();
        }
      });
    }
  }

  test(`${kind} current pager failure retains its cursor and one retryable error`, async () => {
    const f = await fixture(kind);
    const { lane, store, requests, start, waitForRequests, toastsAtom } = f;
    try {
      const head = post("retained-head");
      store.set(lane.posts, [head]);
      store.set(lane.cursor, "opaque-current-cursor");
      const failed = start(lane.more);
      await waitForRequests(1);
      requests[0].reject(new Error("current page offline"));
      await failed;
      expect(store.get(lane.posts)).toEqual([head]);
      expect(store.get(lane.cursor)).toBe("opaque-current-cursor");
      expect(store.get(lane.hasMore)).toBe(true);
      expect(store.get(lane.loadingMore)).toBe(false);
      expect(store.get(toastsAtom)).toHaveLength(1);
      expect(store.get(toastsAtom)[0].kind).toBe("error");
      const retry = start(lane.more);
      await waitForRequests(2);
      expect(requests[1].url.searchParams.get("before")).toBe(
        "opaque-current-cursor",
      );
      requests[1].resolve(page([post("retried-row")], "raw-next", false));
      await retry;
      expect(store.get(lane.posts).map((p) => p.content)).toEqual([
        "retained-head",
        "retried-row",
      ]);
      expect(store.get(lane.cursor)).toBe("raw-next");
      expect(store.get(lane.loadingMore)).toBe(false);
      expect(store.get(toastsAtom)).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  test(`${kind} refresh in another Jotai store does not invalidate this pager`, async () => {
    const f = await fixture(kind);
    const { lane, store, requests, start, waitForRequests } = f;
    let otherRefresh: Promise<void> | undefined;
    try {
      store.set(lane.posts, [post("first-store-head")]);
      store.set(lane.cursor, "first-store-cursor");
      const older = start(lane.more);
      await waitForRequests(1);
      const other = createStore();
      otherRefresh = other.set(lane.full);
      await waitForRequests(2);
      requests[1].resolve(
        page([post("second-store-head")], "second-store-cursor"),
      );
      await otherRefresh;
      expect(store.get(lane.loadingMore)).toBe(true);
      requests[0].resolve(
        page([post("first-store-older")], "first-store-next"),
      );
      await older;
      expect(store.get(lane.posts).map((p) => p.content)).toEqual([
        "first-store-head",
        "first-store-older",
      ]);
      expect(store.get(lane.cursor)).toBe("first-store-next");
      expect(store.get(lane.loadingMore)).toBe(false);
      expect(other.get(lane.posts).map((p) => p.content)).toEqual([
        "second-store-head",
      ]);
      expect(other.get(lane.cursor)).toBe("second-store-cursor");
    } finally {
      await f.cleanup();
      await otherRefresh;
    }
  });
}
