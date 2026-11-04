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
  const restoreGlobals = () => {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
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
  let plugin: typeof import("../lib/plugin.ts");
  let timeline: typeof import("./timeline.ts");
  let bookmarks: typeof import("./bookmarks.ts");
  let reads: typeof import("./bookmark-reads.ts");
  let auth: typeof import("./auth.ts");
  let scope: typeof import("./scope.ts");
  try {
    plugin = await import("../lib/plugin.ts");
    plugin.clearYurucommuFrontendPlugin();
    [timeline, bookmarks, reads, auth, scope] = await Promise.all([
      import("./timeline.ts"),
      import("./bookmarks.ts"),
      import("./bookmark-reads.ts"),
      import("./auth.ts"),
      import("./scope.ts"),
    ]);
  } catch (error) {
    restoreGlobals();
    throw error;
  }
  const store = createStore();
  store.set(auth.actorAtom, actor());
  return {
    store,
    timeline,
    bookmarks,
    reads,
    auth,
    plugin,
    scope,
    requests,
    activeCount: () => store.get(reads.activeBookmarkReadCountAtom),
    activeMutations: () => store.get(reads.activeBookmarkMutationCountAtom),
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
        try {
          plugin.clearYurucommuFrontendPlugin();
        } finally {
          restoreGlobals();
        }
      }
    },
  };
}

for (const changed of [true, false]) {
  test(`a successful auth check ${changed ? "of a different actor hides both cached feeds" : "of the same actor preserves both cached feeds"}`, async () => {
    const h = await fixture();
    const work: Promise<unknown>[] = [];
    try {
      const first = post("old-owner-feed"),
        following = post("old-owner-following"),
        pending = post("old-owner-pending");
      h.store.set(h.timeline.timelinePostsAtom, [first]);
      h.store.set(h.timeline.followingPostsAtom, [following]);
      h.store.set(h.timeline.pendingNewPostsAtom, [pending]);
      h.store.set(h.timeline.timelineLoadedAtAtom, 123);
      h.store.set(h.timeline.followingLoadedAtAtom, 456);
      const epoch = h.store.get(h.auth.authSessionEpochAtom);
      const check = h.store.set(h.auth.checkAuthAtom);
      work.push(check);
      const req = await h.waitFor(1);
      expect(req.url.pathname).toBe("/api/auth/me");
      const next = changed
        ? {
            ...actor(),
            ap_id: `${origin}/ap/users/second`,
            name: "Synthetic Second",
          }
        : { ...actor(), name: "Updated profile" };
      req.pending.resolve(Response.json({ actor: next }));
      await check;
      expect(h.store.get(h.auth.actorAtom)?.ap_id).toBe(next.ap_id);
      expect(h.store.get(h.auth.authSessionEpochAtom)).toBe(epoch);
      expect(h.store.get(h.timeline.timelinePostsAtom)).toEqual(
        changed ? [] : [first],
      );
      expect(h.store.get(h.timeline.followingPostsAtom)).toEqual(
        changed ? [] : [following],
      );
      expect(h.store.get(h.timeline.pendingNewPostsAtom)).toEqual(
        changed ? [] : [pending],
      );
      expect(h.store.get(h.timeline.timelineLoadedAtAtom)).toBe(
        changed ? null : 123,
      );
      expect(h.store.get(h.timeline.followingLoadedAtAtom)).toBe(
        changed ? null : 456,
      );
    } finally {
      await h.cleanup(work);
    }
  });
}

for (const observeB of [true, false]) {
  test(`A to B to A cannot revive A feed; B observed: ${observeB}`, async () => {
    const h = await fixture();
    const work: Promise<unknown>[] = [];
    try {
      const old = post("old-a");
      h.store.set(h.timeline.timelinePostsAtom, [old]);
      h.store.set(h.timeline.timelineLoadedAtAtom, 123);
      const checkB = h.store.set(h.auth.checkAuthAtom);
      work.push(checkB);
      (await h.waitFor(1)).pending.resolve(
        Response.json({
          actor: { ...actor(), ap_id: `${origin}/ap/users/second` },
        }),
      );
      await checkB;
      if (observeB)
        expect(h.store.get(h.timeline.timelinePostsAtom)).toEqual([]);
      const checkA = h.store.set(h.auth.checkAuthAtom);
      work.push(checkA);
      (await h.waitFor(2)).pending.resolve(Response.json({ actor: actor() }));
      await checkA;
      expect(h.store.get(h.timeline.timelinePostsAtom)).toEqual([]);
      expect(h.store.get(h.timeline.timelineLoadedAtAtom)).toBeNull();
    } finally {
      await h.cleanup(work);
    }
  });
}

test("identity-scoped story viewer survives same actor refresh and closes on another actor", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  try {
    h.store.set(h.timeline.showStoryViewerAtom, true);
    h.store.set(h.timeline.storyViewerActorIndexAtom, 2);
    const same = h.store.set(h.auth.checkAuthAtom);
    work.push(same);
    (await h.waitFor(1)).pending.resolve(
      Response.json({ actor: { ...actor(), name: "New name" } }),
    );
    await same;
    expect(h.store.get(h.timeline.showStoryViewerAtom)).toBe(true);
    expect(h.store.get(h.timeline.storyViewerActorIndexAtom)).toBe(2);
    const changed = h.store.set(h.auth.checkAuthAtom);
    work.push(changed);
    (await h.waitFor(2)).pending.resolve(
      Response.json({
        actor: { ...actor(), ap_id: `${origin}/ap/users/other` },
      }),
    );
    await changed;
    expect(h.store.get(h.timeline.showStoryViewerAtom)).toBe(false);
    expect(h.store.get(h.timeline.storyViewerActorIndexAtom)).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("held A stories cannot commit after unobserved A to B to A auth checks", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  try {
    const request = h.store.set(h.timeline.loadStoriesAtom);
    work.push(request);
    const old = await h.waitFor(1);
    const checkB = h.store.set(h.auth.checkAuthAtom);
    work.push(checkB);
    (await h.waitFor(2)).pending.resolve(
      Response.json({
        actor: { ...actor(), ap_id: `${origin}/ap/users/other` },
      }),
    );
    await checkB;
    const checkA = h.store.set(h.auth.checkAuthAtom);
    work.push(checkA);
    (await h.waitFor(3)).pending.resolve(Response.json({ actor: actor() }));
    await checkA;
    old.pending.resolve(
      Response.json({
        actor_stories: [{ actor: actor(), stories: [], has_unviewed: false }],
      }),
    );
    await request;
    expect(h.store.get(h.timeline.actorStoriesAtom)).toEqual([]);
    expect(h.store.get(h.timeline.storiesLoadingAtom)).toBe(true);
  } finally {
    await h.cleanup(work);
  }
});

test("hosted identity ABA retires cached rows but same-id refresh does not", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  try {
    h.store.set(h.auth.hostedUserAtom, { id: "owner-a" });
    const old = post("old-hosted");
    h.store.set(h.timeline.timelinePostsAtom, [old]);
    h.store.set(h.auth.hostedUserAtom, { id: "owner-a" });
    expect(h.store.get(h.timeline.timelinePostsAtom)).toEqual([old]);
    h.store.set(h.auth.hostedUserAtom, { id: "owner-b" });
    h.store.set(h.auth.hostedUserAtom, { id: "owner-a" });
    expect(h.store.get(h.timeline.timelinePostsAtom)).toEqual([]);
  } finally {
    await h.cleanup(work);
  }
});

test("identity transition versions are isolated between Jotai stores", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  try {
    const other = createStore();
    other.set(h.auth.actorAtom, actor());
    const otherPost = post("other-store");
    other.set(h.timeline.timelinePostsAtom, [otherPost]);
    h.store.set(h.auth.actorAtom, {
      ...actor(),
      ap_id: `${origin}/ap/users/other`,
    });
    h.store.set(h.auth.actorAtom, actor());
    expect(other.get(h.timeline.timelinePostsAtom)).toEqual([otherPost]);
    expect(other.get(h.auth.observedActorIdentityVersionAtom)).toBe(1);
  } finally {
    await h.cleanup(work);
  }
});

for (const lane of ["unified", "following"] as const) {
  test(`${lane} held A feed cannot commit after unobserved A-B-A`, async () => {
    const h = await fixture();
    const work: Promise<unknown>[] = [];
    try {
      const load =
        lane === "unified"
          ? h.timeline.loadTimelineAtom
          : h.timeline.loadFollowingTimelineAtom;
      const rows =
        lane === "unified"
          ? h.timeline.timelinePostsAtom
          : h.timeline.followingPostsAtom;
      const loadedAt =
        lane === "unified"
          ? h.timeline.timelineLoadedAtAtom
          : h.timeline.followingLoadedAtAtom;
      const pending = h.store.set(load);
      work.push(pending);
      const old = await h.waitFor(1);
      const checkB = h.store.set(h.auth.checkAuthAtom);
      work.push(checkB);
      (await h.waitFor(2)).pending.resolve(
        Response.json({
          actor: { ...actor(), ap_id: `${origin}/ap/users/second` },
        }),
      );
      await checkB;
      const checkA = h.store.set(h.auth.checkAuthAtom);
      work.push(checkA);
      (await h.waitFor(3)).pending.resolve(Response.json({ actor: actor() }));
      await checkA;
      old.pending.resolve(page([post("stale-before-transition")]));
      await pending;
      expect(h.store.get(rows)).toEqual([]);
      expect(h.store.get(loadedAt)).toBeNull();
      const loading =
        lane === "unified"
          ? h.timeline.timelineLoadingAtom
          : h.timeline.followingLoadingAtom;
      expect(h.store.get(loading)).toBe(true);
    } finally {
      await h.cleanup(work);
    }
  });
}

test("a held A bookmark ACK cannot affect a new A feed after unobserved A-B-A", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  try {
    const target = post("bookmark-aba", 10, true);
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const pending = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(pending);
    const old = await h.waitFor(1);
    const checkB = h.store.set(h.auth.checkAuthAtom);
    work.push(checkB);
    (await h.waitFor(2)).pending.resolve(
      Response.json({
        actor: { ...actor(), ap_id: `${origin}/ap/users/second` },
      }),
    );
    await checkB;
    const checkA = h.store.set(h.auth.checkAuthAtom);
    work.push(checkA);
    (await h.waitFor(3)).pending.resolve(Response.json({ actor: actor() }));
    await checkA;
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    old.pending.resolve(Response.json({ success: true }));
    expect(await pending).toBe(false);
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
  } finally {
    await h.cleanup(work);
  }
});

for (const lane of ["unified", "following"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`${lane} old head ${outcome} cannot end a newer head after epoch change`, async () => {
      const h = await fixture();
      const work: Promise<unknown>[] = [];
      try {
        const load =
          lane === "unified"
            ? h.timeline.loadTimelineAtom
            : h.timeline.loadFollowingTimelineAtom;
        const rows =
          lane === "unified"
            ? h.timeline.timelinePostsAtom
            : h.timeline.followingPostsAtom;
        const loading =
          lane === "unified"
            ? h.timeline.timelineLoadingAtom
            : h.timeline.followingLoadingAtom;
        const error =
          lane === "unified"
            ? h.timeline.timelineLoadErrorAtom
            : h.timeline.followingLoadErrorAtom;
        const old = h.store.set(load);
        work.push(old);
        const oldRequest = await h.waitFor(1);
        const login = h.store.set(h.auth.loginAtom, "synthetic");
        work.push(login);
        const loginRequest = await h.waitFor(2);
        const next = h.store.set(load);
        work.push(next);
        const nextRequest = await h.waitFor(3);
        if (outcome === "reject")
          oldRequest.pending.reject(new Error("synthetic old read failure"));
        else oldRequest.pending.resolve(page([]));
        await old;
        expect(h.store.get(loading)).toBe(true);
        expect(h.store.get(error)).toBeNull();
        const fresh = post("fresh-current");
        nextRequest.pending.resolve(page([fresh]));
        await next;
        expect(h.store.get(rows)).toEqual([fresh]);
        expect(h.store.get(loading)).toBe(false);
        expect(h.store.get(error)).toBeNull();
        loginRequest.pending.resolve(
          new Response("unavailable", { status: 503 }),
        );
        await login;
      } finally {
        await h.cleanup(work);
      }
    });
    test(`${lane} old pager ${outcome} cannot change a new actor's head`, async () => {
      const h = await fixture();
      const work: Promise<unknown>[] = [];
      try {
        const load =
          lane === "unified"
            ? h.timeline.loadTimelineAtom
            : h.timeline.loadFollowingTimelineAtom;
        const more =
          lane === "unified"
            ? h.timeline.loadMoreTimelineAtom
            : h.timeline.loadMoreFollowingTimelineAtom;
        const rows =
          lane === "unified"
            ? h.timeline.timelinePostsAtom
            : h.timeline.followingPostsAtom;
        const cursor =
          lane === "unified"
            ? h.timeline.timelineCursorAtom
            : h.timeline.followingCursorAtom;
        const hasMore =
          lane === "unified"
            ? h.timeline.timelineHasMoreAtom
            : h.timeline.followingHasMoreAtom;
        const loading =
          lane === "unified"
            ? h.timeline.timelineLoadingAtom
            : h.timeline.followingLoadingAtom;
        const error =
          lane === "unified"
            ? h.timeline.timelineLoadErrorAtom
            : h.timeline.followingLoadErrorAtom;
        h.store.set(rows, [post("old-actor")]);
        h.store.set(cursor, "old-cursor");
        h.store.set(hasMore, true);
        const old = h.store.set(more);
        work.push(old);
        const oldRequest = await h.waitFor(1);
        const check = h.store.set(h.auth.checkAuthAtom);
        work.push(check);
        const auth = await h.waitFor(2);
        auth.pending.resolve(
          Response.json({
            actor: { ...actor(), ap_id: `${origin}/ap/users/second` },
          }),
        );
        await check;
        const next = h.store.set(load);
        work.push(next);
        const nextRequest = await h.waitFor(3);
        if (outcome === "reject")
          oldRequest.pending.reject(new Error("synthetic old page failure"));
        else
          oldRequest.pending.resolve(
            page([post("stale-page")], "stale-cursor", true),
          );
        await old;
        expect(h.store.get(loading)).toBe(true);
        expect(h.store.get(error)).toBeNull();
        expect(h.store.get(rows)).toEqual([]);
        const fresh = post("new-actor-head");
        nextRequest.pending.resolve(page([fresh], "new-cursor", true));
        await next;
        expect(h.store.get(rows)).toEqual([fresh]);
        expect(h.store.get(cursor)).toBe("new-cursor");
        expect(h.store.get(loading)).toBe(false);
      } finally {
        await h.cleanup(work);
      }
    });
  }
}

for (const lane of ["unified", "following", "story"] as const) {
  test(`${lane} invalidated by failed logout cannot masquerade as an empty successful read`, async () => {
    const h = await fixture();
    const work: Promise<unknown>[] = [];
    const delay = () => new Promise((resolve) => setTimeout(resolve, 1));
    const waitPath = async (path: string) => {
      for (let i = 0; i < 150; i++) {
        for (const req of h.requests)
          if (req.url.pathname.endsWith("/api/notifications/pushers/config"))
            req.pending.resolve(Response.json({ enabled: false }));
        const match = h.requests.find((req) => req.url.pathname === path);
        if (match) return match;
        await delay();
      }
      throw new Error(
        `missing ${path}; got ${h.requests.map((req) => req.url.pathname).join(",")}`,
      );
    };
    try {
      const load =
        lane === "story"
          ? h.timeline.loadStoriesAtom
          : lane === "unified"
            ? h.timeline.loadTimelineAtom
            : h.timeline.loadFollowingTimelineAtom;
      const pending = h.store.set(load);
      work.push(pending);
      const old = await h.waitFor(1);
      const signout = h.store.set(h.auth.logoutAtom);
      work.push(signout);
      const logout = await waitPath("/api/auth/logout");
      logout.pending.reject(new TypeError("synthetic lost acknowledgement"));
      const observed = await waitPath("/api/auth/me");
      observed.pending.resolve(Response.json({ actor: actor() }));
      expect(await signout).toBe(false);
      old.pending.resolve(
        lane === "story" ? Response.json({ actor_stories: [] }) : page([]),
      );
      await pending;
      const loading =
        lane === "story"
          ? h.timeline.storiesLoadingAtom
          : lane === "unified"
            ? h.timeline.timelineLoadingAtom
            : h.timeline.followingLoadingAtom;
      const error =
        lane === "story"
          ? h.timeline.storiesErrorAtom
          : lane === "unified"
            ? h.timeline.timelineLoadErrorAtom
            : h.timeline.followingLoadErrorAtom;
      expect(h.store.get(loading)).toBe(false);
      expect(h.store.get(error)).toBeString();
    } finally {
      for (let i = 0; i < 8; i++) {
        for (const req of h.requests) {
          if (req.url.pathname.endsWith("/api/notifications/pushers/config"))
            req.pending.resolve(Response.json({ enabled: false }));
          else if (req.url.pathname === "/api/auth/me")
            req.pending.resolve(Response.json({ actor: actor() }));
          else
            req.pending.resolve(
              Response.json({ success: true, posts: [], actor_stories: [] }),
            );
        }
        await delay();
      }
      await h.cleanup(work);
    }
  });
}
