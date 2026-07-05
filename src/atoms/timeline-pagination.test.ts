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
