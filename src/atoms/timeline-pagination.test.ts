import { assert, assertEquals } from "#test/assert";
import { test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Post } from "../types/index.ts";

// The timeline atom module transitively loads i18n.ts, which reads localStorage
// at import time. The bun test env has no DOM, so polyfill a minimal store
// BEFORE dynamically importing the atoms (a static import would evaluate i18n
// before the test body runs).
function ensureLocalStorage(): void {
  if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  }
  if (
    typeof globalThis.navigator === "undefined" ||
    typeof globalThis.navigator.language === "undefined"
  ) {
    Object.defineProperty(globalThis, "navigator", {
      value: { language: "en-US" },
      configurable: true,
    });
  }
}

function makePost(apId: string, published = "2026-01-01T00:00:00.000Z"): Post {
  return {
    ap_id: apId,
    type: "Note",
    author: {
      ap_id: "https://example.com/ap/users/alice",
      username: "alice@example.com",
      preferred_username: "alice",
      name: "Alice",
      icon_url: null,
    },
    content: "hello",
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 0,
    reply_count: 0,
    announce_count: 0,
    published,
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  };
}

// Regression for the home/community infinite-scroll stall: loadMore must page
// with the SERVER's composite cursor, never a post's ap_id. A bare ap_id decodes
// server-side as a legacy published-only cursor whose string compare matches
// every row, so the feed re-serves page 1 forever and never advances.
test("loadMoreTimeline paginates with the server cursor, not a post ap_id", async () => {
  ensureLocalStorage();
  const {
    loadMoreTimelineAtom,
    timelineCursorAtom,
    timelineHasMoreAtom,
    timelinePostsAtom,
  } = await import("./timeline.ts");
  const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");

  const lastApId = "https://example.com/ap/objects/post-1";
  const serverCursor = "2026-01-01T00:00:00.000Z " + lastApId;

  const captured: string[] = [];
  const originalFetch = globalThis.fetch;
  clearYurucommuFrontendPlugin();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    captured.push(typeof input === "string" ? input : input.toString());
    return Promise.resolve(
      new Response(JSON.stringify({ posts: [], has_more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    const store = createStore();
    store.set(timelinePostsAtom, [makePost(lastApId)]);
    store.set(timelineCursorAtom, serverCursor);
    store.set(timelineHasMoreAtom, true);

    await store.set(loadMoreTimelineAtom);

    assertEquals(captured.length, 1);
    const url = new URL(captured[0], "http://localhost");
    const before = url.searchParams.get("before");
    // It echoes the opaque server cursor verbatim...
    assertEquals(before, serverCursor);
    // ...and never the bare ap_id (the bug).
    assert(
      before !== lastApId,
      "loadMore must not send a post ap_id as before",
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearYurucommuFrontendPlugin();
  }
});

// When there is no server cursor (last page), loadMore must NOT refetch — doing
// so with a bogus/absent cursor previously re-served the head.
test("loadMoreTimeline is a no-op when there is no server cursor", async () => {
  ensureLocalStorage();
  const {
    loadMoreTimelineAtom,
    timelineCursorAtom,
    timelineHasMoreAtom,
    timelinePostsAtom,
  } = await import("./timeline.ts");
  const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  clearYurucommuFrontendPlugin();
  globalThis.fetch = ((_input: RequestInfo | URL) => {
    calls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ posts: [], has_more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    const store = createStore();
    store.set(timelinePostsAtom, [
      makePost("https://example.com/ap/objects/p"),
    ]);
    store.set(timelineCursorAtom, null);
    store.set(timelineHasMoreAtom, true);

    await store.set(loadMoreTimelineAtom);

    assertEquals(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearYurucommuFrontendPlugin();
  }
});

// The following feed pages with the same server-cursor discipline as the
// unified feed (see the loadMoreTimeline regression above) against its OWN
// endpoint.
test("loadMoreFollowingTimeline paginates /api/timeline/following with the server cursor", async () => {
  ensureLocalStorage();
  const {
    followingCursorAtom,
    followingHasMoreAtom,
    followingPostsAtom,
    loadMoreFollowingTimelineAtom,
  } = await import("./timeline.ts");
  const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");

  const lastApId = "https://example.com/ap/objects/post-1";
  const serverCursor = "2026-01-01T00:00:00.000Z " + lastApId;

  const captured: string[] = [];
  const originalFetch = globalThis.fetch;
  clearYurucommuFrontendPlugin();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    captured.push(typeof input === "string" ? input : input.toString());
    return Promise.resolve(
      new Response(JSON.stringify({ posts: [], has_more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    const store = createStore();
    store.set(followingPostsAtom, [makePost(lastApId)]);
    store.set(followingCursorAtom, serverCursor);
    store.set(followingHasMoreAtom, true);

    await store.set(loadMoreFollowingTimelineAtom);

    assertEquals(captured.length, 1);
    const url = new URL(captured[0], "http://localhost");
    assertEquals(url.pathname, "/api/timeline/following");
    assertEquals(url.searchParams.get("before"), serverCursor);
  } finally {
    globalThis.fetch = originalFetch;
    clearYurucommuFrontendPlugin();
  }
});

// Forward-compat: a boost entry shares the boosted post's ap_id and is only
// distinguished by repost_ap_id (see PostWithRepost/feedItemKey). checkNewPosts
// must stage a NEW boost of an already-visible post instead of swallowing it
// as a duplicate ap_id.
test("checkNewPosts stages a boost entry of an already-visible post", async () => {
  ensureLocalStorage();
  const { checkNewPostsAtom, pendingNewPostsAtom, timelinePostsAtom } =
    await import("./timeline.ts");
  const { feedItemKey } = await import("../types/index.ts");
  const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");

  const original = makePost(
    "https://example.com/ap/objects/original",
    "2026-01-01T00:00:00.000Z",
  );
  // The same post resurfaced by an announce: newer sort position, own
  // announce ap_id, booster attribution.
  const boost: Post = {
    ...makePost(original.ap_id, original.published),
    ...{
      reposted_by: {
        ap_id: "https://example.com/ap/users/bob",
        username: "bob@example.com",
        preferred_username: "bob",
        name: "Bob",
        icon_url: null,
      },
      repost_ap_id: "https://example.com/ap/activities/announce-1",
      repost_published: "2026-01-02T00:00:00.000Z",
    },
  };

  const originalFetch = globalThis.fetch;
  clearYurucommuFrontendPlugin();
  globalThis.fetch = ((_input: RequestInfo | URL) =>
    Promise.resolve(
      new Response(
        JSON.stringify({ posts: [boost, original], has_more: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as typeof fetch;

  try {
    const store = createStore();
    store.set(timelinePostsAtom, [original]);

    await store.set(checkNewPostsAtom);

    const pending = store.get(pendingNewPostsAtom);
    // Only the boost ENTRY is new; the original is already visible.
    assertEquals(pending.map(feedItemKey), [
      "https://example.com/ap/activities/announce-1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    clearYurucommuFrontendPlugin();
  }
});

// Regression: the MAX_TIMELINE_POSTS feed cap evicts the newest head once the
// user scrolls deep. checkNewPosts must NOT re-stage a head post that was
// already seen-then-evicted (no longer in the live window) as "new" — the
// newest-seen watermark gate prevents the misleading "N new" pill.
test("checkNewPosts ignores an evicted-but-seen head post, stages a genuinely newer one", async () => {
  ensureLocalStorage();
  const {
    checkNewPostsAtom,
    pendingNewPostsAtom,
    newestSeenKeyAtom,
    timelinePostsAtom,
  } = await import("./timeline.ts");
  const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");

  const seenNew = makePost(
    "https://example.com/ap/objects/seen-new",
    "2026-01-05T00:00:00.000Z",
  );
  // The live window is the deep-scrolled OLDER tail; the seen head is evicted.
  const oldTail = [
    makePost(
      "https://example.com/ap/objects/old-1",
      "2026-01-02T00:00:00.000Z",
    ),
    makePost(
      "https://example.com/ap/objects/old-2",
      "2026-01-01T00:00:00.000Z",
    ),
  ];

  let headResponse: Post[] = [seenNew];
  const originalFetch = globalThis.fetch;
  clearYurucommuFrontendPlugin();
  globalThis.fetch = ((_input: RequestInfo | URL) =>
    Promise.resolve(
      new Response(JSON.stringify({ posts: headResponse, has_more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;

  try {
    const store = createStore();
    store.set(timelinePostsAtom, oldTail);
    // Watermark = the seen head's key (it WAS incorporated before eviction).
    store.set(newestSeenKeyAtom, `${seenNew.published} ${seenNew.ap_id}`);

    // The head poll returns the evicted-but-seen post: must NOT be staged.
    await store.set(checkNewPostsAtom);
    assertEquals(store.get(pendingNewPostsAtom).length, 0);

    // A genuinely newer post (published after the watermark) IS staged.
    const genuinelyNew = makePost(
      "https://example.com/ap/objects/genuine-new",
      "2026-01-06T00:00:00.000Z",
    );
    headResponse = [genuinelyNew, seenNew];
    await store.set(checkNewPostsAtom);
    const pendingIds = store.get(pendingNewPostsAtom).map((p) => p.ap_id);
    assertEquals(pendingIds, [genuinelyNew.ap_id]);
  } finally {
    globalThis.fetch = originalFetch;
    clearYurucommuFrontendPlugin();
  }
});

// Head polling and a scope reload overlap in the mounted timeline page. Hold
// the actual fetch boundary so an old response lands after the new view loads.
for (const transition of [
  "different-scope",
  "same-scope-reload",
  "scope-ABA",
  "before-reload",
] as const) {
  test(`checkNewPosts ignores a superseded head: ${transition}`, async () => {
    ensureLocalStorage();
    const {
      applyNewPostsAtom,
      checkNewPostsAtom,
      loadTimelineAtom,
      pendingNewPostsAtom,
      timelinePostsAtom,
      timelineCursorAtom,
      timelineHasMoreAtom,
      newestSeenKeyAtom,
    } = await import("./timeline.ts");
    const { inhabitedScopeAtom } = await import("./scope.ts");
    const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");
    const scope = (id: string) => ({
      kind: "community" as const,
      ap_id: id,
      name: id,
      display_name: id,
      member_role: "owner" as const,
    });
    const a = scope("https://example.com/ap/communities/a");
    const b = scope("https://example.com/ap/communities/b");
    const old = makePost("https://example.com/ap/objects/a-old");
    const late = makePost(
      "https://example.com/ap/objects/a-late",
      "2026-01-10T00:00:00.000Z",
    );
    const fresh = makePost(
      "https://example.com/ap/objects/fresh",
      "2026-01-02T00:00:00.000Z",
    );
    let release!: (response: Response) => void;
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    clearYurucommuFrontendPlugin();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requests.push(String(input));
      if (requests.length === 1)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            posts: [fresh],
            has_more: true,
            next_cursor: "fresh-cursor",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    try {
      const store = createStore();
      store.set(inhabitedScopeAtom, a);
      store.set(timelinePostsAtom, [old]);
      store.set(timelineCursorAtom, "old-cursor");
      store.set(newestSeenKeyAtom, `${old.published} ${old.ap_id}`);
      const polling = store.set(checkNewPostsAtom);
      assertEquals(requests.length, 1);
      assertEquals(
        new URL(requests[0], "http://localhost").searchParams.get("community"),
        a.ap_id,
      );
      if (transition !== "same-scope-reload") store.set(inhabitedScopeAtom, b);
      if (transition !== "before-reload") await store.set(loadTimelineAtom);
      if (transition === "scope-ABA") {
        store.set(inhabitedScopeAtom, a);
        await store.set(loadTimelineAtom);
      }
      const before = {
        posts: store.get(timelinePostsAtom),
        cursor: store.get(timelineCursorAtom),
        hasMore: store.get(timelineHasMoreAtom),
        watermark: store.get(newestSeenKeyAtom),
      };
      release(
        new Response(JSON.stringify({ posts: [late], has_more: false }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      await polling;
      assertEquals(store.get(pendingNewPostsAtom), []);
      store.set(applyNewPostsAtom);
      assertEquals(store.get(timelinePostsAtom), before.posts);
      assertEquals(store.get(timelineCursorAtom), before.cursor);
      assertEquals(store.get(timelineHasMoreAtom), before.hasMore);
      assertEquals(store.get(newestSeenKeyAtom), before.watermark);
    } finally {
      globalThis.fetch = originalFetch;
      clearYurucommuFrontendPlugin();
    }
  });
}

test("reload clears staged head before a changed scope finishes or fails", async () => {
  ensureLocalStorage();
  const {
    applyNewPostsAtom,
    loadTimelineAtom,
    pendingNewPostsAtom,
    timelinePostsAtom,
  } = await import("./timeline.ts");
  const { inhabitedScopeAtom } = await import("./scope.ts");
  const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");
  let reject!: (error: Error) => void;
  let loading: Promise<void> | undefined;
  const originalFetch = globalThis.fetch;
  clearYurucommuFrontendPlugin();
  globalThis.fetch = ((_input: RequestInfo | URL) =>
    new Promise<Response>((_resolve, fail) => {
      reject = fail;
    })) as typeof fetch;
  try {
    const store = createStore();
    store.set(pendingNewPostsAtom, [
      makePost("https://example.com/ap/objects/a-pending"),
    ]);
    store.set(inhabitedScopeAtom, {
      kind: "community",
      ap_id: "https://example.com/ap/communities/b",
      name: "b",
      display_name: "B",
      member_role: "member",
    });
    // The mounted page clears the prior rows before issuing the scoped load.
    store.set(timelinePostsAtom, []);
    loading = store.set(loadTimelineAtom);
    assertEquals(store.get(pendingNewPostsAtom), []);
    store.set(applyNewPostsAtom);
    assertEquals(store.get(timelinePostsAtom), []);
    reject(new Error("new scope offline"));
    await loading;
    assertEquals(store.get(pendingNewPostsAtom), []);
  } finally {
    // Settle the request even if the early assertion failed on the baseline.
    reject(new Error("fixture cleanup"));
    await loading;
    globalThis.fetch = originalFetch;
    clearYurucommuFrontendPlugin();
  }
});

test("same-scope concurrent head polls stage each new entry once", async () => {
  ensureLocalStorage();
  const {
    applyNewPostsAtom,
    checkNewPostsAtom,
    pendingNewPostsAtom,
    timelinePostsAtom,
    timelineCursorAtom,
    newestSeenKeyAtom,
  } = await import("./timeline.ts");
  const { inhabitedScopeAtom } = await import("./scope.ts");
  const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");
  const old = makePost("https://example.com/ap/objects/old");
  const fresh = makePost(
    "https://example.com/ap/objects/new",
    "2026-01-03T00:00:00.000Z",
  );
  const releases: ((response: Response) => void)[] = [];
  const originalFetch = globalThis.fetch;
  clearYurucommuFrontendPlugin();
  globalThis.fetch = ((_input: RequestInfo | URL) =>
    new Promise<Response>((resolve) => {
      releases.push(resolve);
    })) as typeof fetch;
  try {
    const store = createStore();
    const scope = {
      kind: "community" as const,
      ap_id: "https://example.com/ap/communities/a",
      name: "a",
      display_name: "A",
      member_role: "owner" as const,
    };
    store.set(inhabitedScopeAtom, scope);
    store.set(timelinePostsAtom, [old]);
    store.set(timelineCursorAtom, "older-cursor");
    store.set(newestSeenKeyAtom, `${old.published} ${old.ap_id}`);
    const first = store.set(checkNewPostsAtom);
    const second = store.set(checkNewPostsAtom);
    // Hydration can refresh metadata for the same community without changing
    // its feed identity; that does not invalidate these legitimate head polls.
    store.set(inhabitedScopeAtom, { ...scope, display_name: "Renamed A" });
    const response = () =>
      new Response(JSON.stringify({ posts: [fresh, old], has_more: false }), {
        headers: { "Content-Type": "application/json" },
      });
    releases[1](response());
    await second;
    assertEquals(
      store.get(pendingNewPostsAtom).map((p) => p.ap_id),
      [fresh.ap_id],
    );
    store.set(applyNewPostsAtom);
    releases[0](response());
    await first;
    assertEquals(store.get(pendingNewPostsAtom), []);
    store.set(applyNewPostsAtom);
    assertEquals(
      store.get(timelinePostsAtom).map((p) => p.ap_id),
      [fresh.ap_id, old.ap_id],
    );
    assertEquals(store.get(timelineCursorAtom), "older-cursor");
  } finally {
    globalThis.fetch = originalFetch;
    clearYurucommuFrontendPlugin();
  }
});
