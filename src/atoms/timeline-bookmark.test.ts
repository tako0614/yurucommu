import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Actor, Post, PostWithRepost } from "../types/index.ts";

const origin = "https://example.test";
function actor(name: string): Actor {
  return {
    ap_id: `${origin}/ap/users/${name}`,
    username: `${name}@example.test`,
    preferred_username: name,
    name,
    summary: null,
    icon_url: null,
    header_url: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}
function post(name: string): Post {
  return {
    ap_id: `${origin}/ap/objects/${name}`,
    type: "Note",
    author: actor("owner"),
    content: name,
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 2,
    reply_count: 1,
    announce_count: 3,
    published: "2026-01-01T00:00:00.000Z",
    edited_at: null,
    liked: true,
    bookmarked: true,
    reposted: false,
  };
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

async function fixture() {
  const descriptors = new Map(
    (["localStorage", "navigator", "fetch"] as const).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
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
  const plugin = await import("../lib/plugin.ts");
  plugin.clearYurucommuFrontendPlugin();
  const pending = deferred<Response>();
  const requests: Array<{ path: string; method: string }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        origin,
      );
      requests.push({
        path: url.pathname,
        method:
          init?.method ?? (input instanceof Request ? input.method : "GET"),
      });
      return pending.promise;
    },
  });
  const atoms = await import("./timeline.ts");
  const auth = await import("./auth.ts");
  const store = createStore();
  store.set(auth.actorAtom, actor("owner"));
  const target = post("target");
  const unrelated = post("unrelated");
  const boost: PostWithRepost = {
    ...target,
    repost_ap_id: `${origin}/ap/activities/boost`,
    reposted_by: actor("peer"),
    repost_published: "2026-01-02T00:00:00.000Z",
  };
  store.set(atoms.timelinePostsAtom, [target, unrelated, boost]);
  store.set(atoms.followingPostsAtom, [boost, unrelated]);
  store.set(atoms.pendingNewPostsAtom, [target]);
  store.set(atoms.timelineLoadedAtAtom, 123);
  store.set(atoms.followingLoadedAtAtom, 456);
  store.set(atoms.timelineCursorAtom, "unified-cursor");
  store.set(atoms.followingCursorAtom, "following-cursor");
  store.set(atoms.timelineScrollTopAtom, 210);
  store.set(atoms.followingScrollTopAtom, 340);
  return {
    atoms,
    auth,
    store,
    target,
    unrelated,
    boost,
    requests,
    pending,
    cleanup() {
      plugin.clearYurucommuFrontendPlugin();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("confirmed unsave updates every cached feed entry after ACK without losing posts or reading position", async () => {
  const h = await fixture();
  try {
    const before = [
      h.store.get(h.atoms.timelinePostsAtom),
      h.store.get(h.atoms.followingPostsAtom),
      h.store.get(h.atoms.pendingNewPostsAtom),
    ];
    const saving = h.store.set(
      h.atoms.unbookmarkTimelinePostAtom,
      h.target.ap_id,
    );
    expect(h.store.get(h.atoms.timelinePostsAtom)).toBe(before[0]);
    h.pending.resolve(new Response(JSON.stringify({ success: true })));
    expect(await saving).toBe(true);
    for (const [index, feed] of [
      h.atoms.timelinePostsAtom,
      h.atoms.followingPostsAtom,
      h.atoms.pendingNewPostsAtom,
    ].entries()) {
      expect(h.store.get(feed)).toEqual(
        before[index]!.map((row) =>
          row.ap_id === h.target.ap_id ? { ...row, bookmarked: false } : row,
        ),
      );
    }
    expect(h.store.get(h.atoms.timelinePostsAtom)[1]).toBe(h.unrelated);
    expect(h.store.get(h.atoms.timelineLoadedAtAtom)).toBe(123);
    expect(h.store.get(h.atoms.followingLoadedAtAtom)).toBe(456);
    expect(h.store.get(h.atoms.timelineCursorAtom)).toBe("unified-cursor");
    expect(h.store.get(h.atoms.followingCursorAtom)).toBe("following-cursor");
    expect(h.store.get(h.atoms.timelineScrollTopAtom)).toBe(210);
    expect(h.store.get(h.atoms.followingScrollTopAtom)).toBe(340);
    expect(h.requests).toEqual([
      {
        path: `/api/posts/${encodeURIComponent(h.target.ap_id)}/bookmark`,
        method: "DELETE",
      },
    ]);
  } finally {
    h.cleanup();
  }
});

for (const outcome of ["503", "ack-loss"] as const) {
  test(`unconfirmed unsave ${outcome} retains all cached rows and sends no retry`, async () => {
    const h = await fixture();
    try {
      const feeds = [
        h.atoms.timelinePostsAtom,
        h.atoms.followingPostsAtom,
        h.atoms.pendingNewPostsAtom,
      ];
      const before = feeds.map((feed) => h.store.get(feed));
      const result = h.store.set(
        h.atoms.unbookmarkTimelinePostAtom,
        h.target.ap_id,
      );
      if (outcome === "503") {
        h.pending.resolve(new Response("unavailable", { status: 503 }));
      } else {
        h.pending.reject(new TypeError("lost acknowledgement"));
      }
      await expect(result).rejects.toThrow();
      for (const [index, feed] of feeds.entries()) {
        expect(h.store.get(feed)).toBe(before[index]);
      }
      expect(h.requests).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
}

for (const nextActor of [null, actor("persona")]) {
  test(`late unsave ACK cannot change the feed after ${nextActor ? "persona switch" : "logout"}`, async () => {
    const h = await fixture();
    try {
      const result = h.store.set(
        h.atoms.unbookmarkTimelinePostAtom,
        h.target.ap_id,
      );
      h.store.set(h.auth.actorAtom, nextActor);
      const before = h.store.get(h.atoms.timelinePostsAtom);
      h.pending.resolve(new Response(JSON.stringify({ success: true })));
      expect(await result).toBe(false);
      expect(h.store.get(h.atoms.timelinePostsAtom)).toBe(before);
      expect(h.store.get(h.atoms.followingPostsAtom)[0]!.bookmarked).toBe(true);
      expect(h.store.get(h.atoms.pendingNewPostsAtom)[0]!.bookmarked).toBe(
        true,
      );
    } finally {
      h.cleanup();
    }
  });
}

test("same actor profile refresh preserves confirmed unsave while absent feed entries remain absent", async () => {
  const h = await fixture();
  try {
    h.store.set(h.atoms.pendingNewPostsAtom, [h.unrelated]);
    const result = h.store.set(
      h.atoms.unbookmarkTimelinePostAtom,
      h.target.ap_id,
    );
    h.store.set(h.auth.actorAtom, {
      ...actor("owner"),
      name: "Updated profile",
    });
    h.pending.resolve(new Response(JSON.stringify({ success: true })));
    expect(await result).toBe(true);
    expect(h.store.get(h.atoms.timelinePostsAtom)[0]!.bookmarked).toBe(false);
    expect(h.store.get(h.atoms.pendingNewPostsAtom)).toEqual([h.unrelated]);
  } finally {
    h.cleanup();
  }
});

test("anonymous unsave does not issue a mutation or change cache", async () => {
  const h = await fixture();
  try {
    h.store.set(h.auth.actorAtom, null);
    const before = h.store.get(h.atoms.timelinePostsAtom);
    expect(
      await h.store.set(h.atoms.unbookmarkTimelinePostAtom, h.target.ap_id),
    ).toBe(false);
    expect(h.requests).toEqual([]);
    expect(h.store.get(h.atoms.timelinePostsAtom)).toBe(before);
  } finally {
    h.cleanup();
  }
});
