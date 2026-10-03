import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Actor, Post } from "../types/index.ts";

const origin = "https://example.test";

function actor(): Actor {
  return {
    ap_id: `${origin}/ap/users/owner`,
    username: "owner@example.test",
    preferred_username: "owner",
    name: "Owner",
    summary: null,
    icon_url: null,
    header_url: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function post(name: string, day = 10, bookmarked = true): Post {
  return {
    ap_id: `${origin}/ap/objects/${name}`,
    type: "Note",
    author: actor(),
    content: name,
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 0,
    reply_count: 0,
    announce_count: 0,
    published: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    edited_at: null,
    liked: false,
    bookmarked,
    reposted: false,
  };
}

function page(posts: Post[], cursor: string | null = null, hasMore = false) {
  return new Response(
    JSON.stringify({ posts, next_cursor: cursor, has_more: hasMore }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type HeldRequest = {
  url: URL;
  method: string;
  pending: ReturnType<typeof deferred<Response>>;
};

async function fixture() {
  const keys = ["localStorage", "navigator", "fetch"] as const;
  const descriptors = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    } satisfies Storage,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: "en-US" },
  });
  const requests: HeldRequest[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        origin,
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const pending = deferred<Response>();
      requests.push({ url, method, pending });
      return pending.promise;
    },
  });
  const plugin = await import("../lib/plugin.ts");
  plugin.clearYurucommuFrontendPlugin();
  const [timeline, bookmarks, reads, auth, scope] = await Promise.all([
    import("./timeline.ts"),
    import("./bookmarks.ts"),
    import("./bookmark-reads.ts"),
    import("./auth.ts"),
    import("./scope.ts"),
  ]);
  const store = createStore();
  store.set(auth.actorAtom, actor());
  return {
    store,
    timeline,
    bookmarks,
    reads,
    scope,
    requests,
    activeCount: () => store.get(reads.activeBookmarkReadCountAtom),
    async waitFor(count: number) {
      for (let i = 0; i < 30 && requests.length < count; i++) {
        await Promise.resolve();
      }
      expect(requests).toHaveLength(count);
      return requests[count - 1]!;
    },
    async cleanup(work: Promise<unknown>[]) {
      try {
        for (const request of requests) {
          request.pending.resolve(
            request.method === "DELETE"
              ? new Response(JSON.stringify({ success: true }))
              : page([]),
          );
        }
        await Promise.allSettled(work);
      } finally {
        plugin.clearYurucommuFrontendPlugin();
        for (const key of keys) {
          const descriptor = descriptors.get(key);
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

for (const oldOutcome of ["success", "failure"] as const) {
  test(`scope-switch full reload retires its old unified window before late ${oldOutcome}`, async () => {
    const h = await fixture();
    const work: Promise<unknown>[] = [];
    const community = `${origin}/ap/communities/one`;
    const fresh = post("new-scope");
    try {
      const oldLoad = h.store.set(h.timeline.loadTimelineAtom);
      work.push(oldLoad);
      const oldRequest = await h.waitFor(1);
      expect(h.activeCount()).toBe(1);

      h.store.set(h.scope.inhabitedScopeAtom, {
        kind: "community",
        ap_id: community,
        name: "one",
        display_name: "One",
        member_role: "member",
      });
      const newLoad = h.store.set(h.timeline.loadTimelineAtom);
      work.push(newLoad);
      const newRequest = await h.waitFor(2);
      expect(newRequest.url.searchParams.get("community")).toBe(community);
      expect(h.activeCount()).toBe(1);

      if (oldOutcome === "success") {
        oldRequest.pending.resolve(
          page([post("old-scope")], "old-cursor", true),
        );
      } else {
        oldRequest.pending.reject(new Error("old scope offline"));
      }
      await oldLoad;
      expect(h.activeCount()).toBe(1);
      expect(h.store.get(h.timeline.timelineLoadErrorAtom)).toBeNull();
      expect(h.store.get(h.timeline.timelineCursorAtom)).toBeNull();

      const unsaving = h.store.set(
        h.timeline.unbookmarkTimelinePostAtom,
        fresh.ap_id,
      );
      work.push(unsaving);
      const deletion = await h.waitFor(3);
      expect(deletion.method).toBe("DELETE");
      deletion.pending.resolve(new Response(JSON.stringify({ success: true })));
      expect(await unsaving).toBe(true);
      newRequest.pending.resolve(page([fresh], "fresh-cursor", true));
      await newLoad;
      expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(
        false,
      );
      expect(h.store.get(h.timeline.timelineCursorAtom)).toBe("fresh-cursor");
      expect(h.activeCount()).toBe(0);
    } finally {
      await h.cleanup(work);
    }
  });
}

for (const feed of ["unified", "following"] as const) {
  test(`${feed} full reload retires its pending older-page window before SDK settlement`, async () => {
    const h = await fixture();
    const work: Promise<unknown>[] = [];
    const lane =
      feed === "unified"
        ? {
            load: h.timeline.loadTimelineAtom,
            pager: h.timeline.loadMoreTimelineAtom,
            posts: h.timeline.timelinePostsAtom,
            cursor: h.timeline.timelineCursorAtom,
            loadingMore: h.timeline.timelineLoadingMoreAtom,
          }
        : {
            load: h.timeline.loadFollowingTimelineAtom,
            pager: h.timeline.loadMoreFollowingTimelineAtom,
            posts: h.timeline.followingPostsAtom,
            cursor: h.timeline.followingCursorAtom,
            loadingMore: h.timeline.followingLoadingMoreAtom,
          };
    const fresh = post(`${feed}-fresh`);
    try {
      const initial = h.store.set(lane.load);
      work.push(initial);
      (await h.waitFor(1)).pending.resolve(
        page([post(`${feed}-first`)], "older-cursor", true),
      );
      await initial;
      const paging = h.store.set(lane.pager);
      work.push(paging);
      const oldPage = await h.waitFor(2);
      expect(oldPage.url.searchParams.get("before")).toBe("older-cursor");
      expect(h.activeCount()).toBe(1);
      expect(h.store.get(lane.loadingMore)).toBe(true);

      const replacement = h.store.set(lane.load);
      work.push(replacement);
      const newRequest = await h.waitFor(3);
      expect(h.activeCount()).toBe(1);
      expect(h.store.get(lane.loadingMore)).toBe(false);
      expect(h.store.get(lane.cursor)).toBeNull();
      oldPage.pending.resolve(page([post(`${feed}-stale`)], "stale", true));
      await paging;
      expect(h.activeCount()).toBe(1);
      expect(h.store.get(lane.loadingMore)).toBe(false);
      expect(h.store.get(lane.cursor)).toBeNull();
      newRequest.pending.resolve(page([fresh], "fresh", true));
      await replacement;
      expect(h.store.get(lane.posts)).toEqual([fresh]);
      expect(h.store.get(lane.cursor)).toBe("fresh");
      expect(h.activeCount()).toBe(0);
    } finally {
      await h.cleanup(work);
    }
  });
}

test("unified reload retires every concurrent same-generation poll", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  try {
    h.store.set(h.timeline.timelinePostsAtom, [post("anchor", 10)]);
    const polls = [
      h.store.set(h.timeline.checkNewPostsAtom),
      h.store.set(h.timeline.checkNewPostsAtom),
      h.store.set(h.timeline.checkNewPostsAtom),
    ];
    work.push(...polls);
    await h.waitFor(3);
    expect(h.activeCount()).toBe(3);

    const reload = h.store.set(h.timeline.loadTimelineAtom);
    work.push(reload);
    const fresh = await h.waitFor(4);
    expect(h.activeCount()).toBe(1);
    h.requests[0]!.pending.resolve(page([post("stale-poll", 12)]));
    h.requests[1]!.pending.reject(new Error("stale poll offline"));
    h.requests[2]!.pending.resolve(page([post("stale-poll-2", 13)]));
    await Promise.all(polls);
    expect(h.activeCount()).toBe(1);
    expect(h.store.get(h.timeline.pendingNewPostsAtom)).toEqual([]);
    fresh.pending.resolve(page([post("fresh-head", 14)]));
    await reload;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.content).toBe(
      "fresh-head",
    );
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("unified and following reloads retire only their own windows", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  try {
    const oldUnified = h.store.set(h.timeline.loadTimelineAtom);
    work.push(oldUnified);
    const oldUnifiedRequest = await h.waitFor(1);
    const oldFollowing = h.store.set(h.timeline.loadFollowingTimelineAtom);
    work.push(oldFollowing);
    const oldFollowingRequest = await h.waitFor(2);
    expect(h.activeCount()).toBe(2);

    const newUnified = h.store.set(h.timeline.loadTimelineAtom);
    work.push(newUnified);
    const newUnifiedRequest = await h.waitFor(3);
    expect(h.activeCount()).toBe(2);
    const newFollowing = h.store.set(h.timeline.loadFollowingTimelineAtom);
    work.push(newFollowing);
    const newFollowingRequest = await h.waitFor(4);
    expect(h.activeCount()).toBe(2);

    oldUnifiedRequest.pending.resolve(page([post("old-unified")]));
    oldFollowingRequest.pending.reject(new Error("old following offline"));
    await Promise.all([oldUnified, oldFollowing]);
    expect(h.activeCount()).toBe(2);
    expect(h.store.get(h.timeline.followingLoadErrorAtom)).toBeNull();

    newUnifiedRequest.pending.resolve(page([post("new-unified")]));
    await newUnified;
    expect(h.activeCount()).toBe(1);
    newFollowingRequest.pending.resolve(page([post("new-following")]));
    await newFollowing;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.content).toBe(
      "new-unified",
    );
    expect(h.store.get(h.timeline.followingPostsAtom)[0]?.content).toBe(
      "new-following",
    );
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("unified reload preserves a saved-list window and its later bookmark ACK", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const saved = h.bookmarks.createBookmarksState();
  const target = post("saved-target");
  try {
    const savedLoad = h.store.set(saved.load);
    work.push(savedLoad);
    const savedRequest = await h.waitFor(1);
    const oldUnified = h.store.set(h.timeline.loadTimelineAtom);
    work.push(oldUnified);
    const oldRequest = await h.waitFor(2);
    expect(h.activeCount()).toBe(2);

    const freshUnified = h.store.set(h.timeline.loadTimelineAtom);
    work.push(freshUnified);
    const freshRequest = await h.waitFor(3);
    expect(h.activeCount()).toBe(2);
    oldRequest.pending.resolve(page([post("obsolete")]));
    await oldUnified;
    expect(h.activeCount()).toBe(2);

    const unsaving = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(unsaving);
    (await h.waitFor(4)).pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    expect(await unsaving).toBe(true);
    savedRequest.pending.resolve(page([target]));
    freshRequest.pending.resolve(page([target]));
    await Promise.all([savedLoad, freshUnified]);
    expect(h.store.get(saved.posts)).toEqual([]);
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(
      false,
    );
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("unified reload preserves an optimistic mutation window and its rollback guard", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("optimistic-target");
  try {
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const oldUnified = h.store.set(h.timeline.loadTimelineAtom);
    work.push(oldUnified);
    const oldRequest = await h.waitFor(1);
    const toggling = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    work.push(toggling);
    const oldDelete = await h.waitFor(2);
    expect(oldDelete.method).toBe("DELETE");
    expect(h.activeCount()).toBe(2);

    const freshUnified = h.store.set(h.timeline.loadTimelineAtom);
    work.push(freshUnified);
    const freshRequest = await h.waitFor(3);
    expect(h.activeCount()).toBe(2);
    oldRequest.pending.resolve(page([post("obsolete")]));
    await oldUnified;
    expect(h.activeCount()).toBe(2);

    const unsaving = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(unsaving);
    const newDelete = await h.waitFor(4);
    newDelete.pending.resolve(new Response(JSON.stringify({ success: true })));
    expect(await unsaving).toBe(true);
    oldDelete.pending.reject(new Error("earlier toggle failed"));
    await expect(toggling).rejects.toThrow();
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(
      false,
    );
    expect(h.activeCount()).toBe(1);

    freshRequest.pending.resolve(page([target]));
    await freshUnified;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(
      false,
    );
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});
