import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import {
  feedItemKey,
  type Actor,
  type Post,
  type PostWithRepost,
} from "../types/index.ts";

const origin = "https://example.test";
const ownerId = `${origin}/ap/users/owner`;
const objectId = (name: string) => `${origin}/ap/objects/${name}`;

function actor(): Actor {
  return {
    ap_id: ownerId,
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

function post(name: string, day: number, patch: Partial<Post> = {}): Post {
  return {
    ap_id: objectId(name),
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
    bookmarked: false,
    reposted: false,
    ...patch,
  };
}

function postAck(value: Post): Response {
  return new Response(JSON.stringify({ post: value }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

function page(
  posts: Post[],
  cursor: string | null,
  hasMore: boolean,
): Response {
  return new Response(
    JSON.stringify({ posts, next_cursor: cursor, has_more: hasMore }),
    { headers: { "Content-Type": "application/json" } },
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

type HeldResponse = ReturnType<typeof deferred<Response>> & { path: string };
type Harness = {
  atoms: typeof import("./timeline.ts");
  auth: typeof import("./auth.ts");
  scope: typeof import("./scope.ts");
  store: ReturnType<typeof createStore>;
  heads: HeldResponse[];
  setPostResponder(responder: () => Promise<Response>): void;
  setDeleteResponder(responder: () => Promise<Response>): void;
  waitForHeads(count: number): Promise<void>;
  cleanup(): Promise<void>;
};

async function fixture(): Promise<Harness> {
  const keys = ["localStorage", "navigator", "fetch"] as const;
  const descriptors = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const values = new Map<string, string>();
  const heads: HeldResponse[] = [];
  const pending: Promise<Response>[] = [];
  let postResponder: (() => Promise<Response>) | null = null;
  let deleteResponder = async () => new Response(null);

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: descriptors.get("localStorage")?.enumerable ?? true,
    writable: true,
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
    enumerable: descriptors.get("navigator")?.enumerable ?? true,
    writable: true,
    value: { language: "en-US" },
  });

  const plugin = await import("../lib/plugin.ts");
  plugin.clearYurucommuFrontendPlugin();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    enumerable: descriptors.get("fetch")?.enumerable ?? true,
    writable: true,
    value: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        origin,
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname === "/api/posts" && method === "POST") {
        if (!postResponder)
          throw new Error("Post responder was not configured");
        const response = postResponder();
        pending.push(response);
        return response;
      }
      if (url.pathname.startsWith("/api/timeline")) {
        const request = { ...deferred<Response>(), path: url.pathname };
        heads.push(request);
        pending.push(request.promise);
        return request.promise;
      }
      if (method === "DELETE") {
        const response = deleteResponder();
        pending.push(response);
        return response;
      }
      throw new Error(`Unexpected test request: ${method} ${url}`);
    }) as typeof fetch,
  });

  try {
    const [atoms, auth, scope] = await Promise.all([
      import("./timeline.ts"),
      import("./auth.ts"),
      import("./scope.ts"),
    ]);
    const store = createStore();
    // Home's real call sites are authenticated before they start a read.
    store.set(auth.actorAtom, actor());
    return {
      atoms,
      auth,
      scope,
      store,
      heads,
      setPostResponder: (responder) => {
        postResponder = responder;
      },
      setDeleteResponder: (responder) => {
        deleteResponder = responder;
      },
      waitForHeads: async (count) => {
        for (let i = 0; i < 30 && heads.length < count; i++)
          await Promise.resolve();
        expect(heads.length).toBe(count);
      },
      cleanup: async () => {
        for (const request of heads) request.resolve(page([], null, false));
        await Promise.allSettled(pending);
        plugin.clearYurucommuFrontendPlugin();
        for (const key of keys) {
          const descriptor = descriptors.get(key);
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      },
    };
  } catch (error) {
    plugin.clearYurucommuFrontendPlugin();
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    throw error;
  }
}

function lane(h: Harness, kind: "unified" | "following") {
  const a = h.atoms;
  return kind === "unified"
    ? {
        posts: a.timelinePostsAtom,
        cursor: a.timelineCursorAtom,
        hasMore: a.timelineHasMoreAtom,
        loadedAt: a.timelineLoadedAtAtom,
        load: a.loadTimelineAtom,
        path: "/api/timeline",
      }
    : {
        posts: a.followingPostsAtom,
        cursor: a.followingCursorAtom,
        hasMore: a.followingHasMoreAtom,
        loadedAt: a.followingLoadedAtAtom,
        load: a.loadFollowingTimelineAtom,
        path: "/api/timeline/following",
      };
}

async function acknowledge(
  h: Harness,
  value: Post,
  communityApId?: string,
): Promise<void> {
  h.store.set(h.auth.actorAtom, actor());
  h.setPostResponder(async () => postAck(value));
  await h.store.set(h.atoms.createPostAtom, {
    content: value.content,
    community_ap_id: communityApId,
  });
}

for (const kind of ["unified", "following"] as const) {
  test(`${kind} pre-unsave head cannot restore a confirmed bookmark flag`, async () => {
    const h = await fixture();
    const f = lane(h, kind);
    const target = post("unsaved-during-head", 10, { bookmarked: true });
    const other = post("unrelated-save", 9, { bookmarked: true });
    try {
      h.store.set(h.auth.actorAtom, actor());
      h.store.set(f.posts, [target, other]);
      const loading = h.store.set(f.load);
      await h.waitForHeads(1);
      expect(
        await h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id),
      ).toBe(true);
      expect(h.store.get(f.posts)[0]!.bookmarked).toBe(false);
      h.heads[0]!.resolve(page([target, other], "older-saved-cursor", true));
      await loading;
      expect(
        h.store.get(f.posts).map((row) => [row.ap_id, row.bookmarked]),
      ).toEqual([
        [target.ap_id, false],
        [other.ap_id, true],
      ]);
      expect(h.store.get(f.cursor)).toBe("older-saved-cursor");
      expect(h.store.get(f.hasMore)).toBe(true);
      // A later server read is authoritative: a reversible bookmark must not
      // inherit the permanent canonical-object deletion fence.
      const later = h.store.set(f.load);
      await h.waitForHeads(2);
      h.heads[1]!.resolve(page([target, other], "later-cursor", false));
      await later;
      expect(h.store.get(f.posts)[0]!.bookmarked).toBe(true);
      expect(h.store.get(f.cursor)).toBe("later-cursor");
    } finally {
      await h.cleanup();
    }
  });

  test(`${kind} unsave fences an absent object and its boost only within this head`, async () => {
    const h = await fixture();
    const f = lane(h, kind);
    const target = post("absent-unsave", 10, { bookmarked: true });
    const boost: PostWithRepost = {
      ...target,
      repost_ap_id: objectId("absent-boost"),
      reposted_by: actor(),
      repost_published: "2026-01-11T00:00:00.000Z",
    };
    const other = post("server-authoritative-unrelated", 9, {
      bookmarked: true,
      liked: true,
    });
    try {
      h.store.set(f.posts, [other]);
      const loading = h.store.set(f.load);
      await h.waitForHeads(1);
      await h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id);
      h.heads[0]!.resolve(
        page(
          [boost, target, { ...other, liked: false }],
          "absent-cursor",
          true,
        ),
      );
      await loading;
      expect(
        h.store.get(f.posts).map((row) => [feedItemKey(row), row.bookmarked]),
      ).toEqual([
        [feedItemKey(boost), false],
        [feedItemKey(target), false],
        [feedItemKey(other), true],
      ]);
      expect(h.store.get(f.posts)[2]!.liked).toBe(false);
      expect(h.store.get(f.cursor)).toBe("absent-cursor");
      const later = h.store.set(f.load);
      await h.waitForHeads(2);
      await h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id);
      // Respect a later local bookmark change rather than a permanent false
      // overlay. This is field reconciliation, not server mutation ordering.
      h.store.set(f.posts, (rows) =>
        rows.map((row) => ({ ...row, bookmarked: true })),
      );
      h.heads[1]!.resolve(page([boost, target, other], "latest-cursor", false));
      await later;
      expect(h.store.get(f.posts).every((row) => row.bookmarked)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  for (const outcome of ["503", "ack-loss"] as const) {
    test(`${kind} unconfirmed unsave ${outcome} adds no head fence`, async () => {
      const h = await fixture();
      const f = lane(h, kind);
      const target = post("refused-unsave", 10, { bookmarked: true });
      try {
        h.store.set(f.posts, [target]);
        const loading = h.store.set(f.load);
        await h.waitForHeads(1);
        h.setDeleteResponder(async () => {
          if (outcome === "ack-loss") throw new TypeError("lost ACK");
          return new Response("refused", { status: 503 });
        });
        await expect(
          h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id),
        ).rejects.toThrow();
        expect(h.store.get(f.posts)[0]!.bookmarked).toBe(true);
        h.heads[0]!.resolve(page([target], "refused-cursor", false));
        await loading;
        expect(h.store.get(f.posts)[0]!.bookmarked).toBe(true);
        expect(h.store.get(f.cursor)).toBe("refused-cursor");
      } finally {
        await h.cleanup();
      }
    });
  }

  test(`${kind} late full head cannot publish across an observed actor change`, async () => {
    const h = await fixture();
    const f = lane(h, kind);
    const target = post("old-actor-head", 10, { bookmarked: true });
    const next = post("new-actor-view", 9);
    try {
      h.store.set(f.posts, [target]);
      const loading = h.store.set(f.load);
      await h.waitForHeads(1);
      await h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id);
      h.store.set(h.auth.actorAtom, {
        ...actor(),
        ap_id: `${origin}/ap/users/persona`,
      });
      h.store.set(f.posts, [next]);
      h.heads[0]!.resolve(page([target], "old-actor-cursor", true));
      await loading;
      expect(h.store.get(f.posts)).toEqual([next]);
      expect(h.store.get(f.cursor)).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test(`${kind} ACK after a completed head retains its server position without duplication`, async () => {
    const h = await fixture();
    const f = lane(h, kind);
    const head = post("completed-head", 10);
    const ack = post("already-in-head", 9);
    const older = post("completed-older", 8);
    try {
      h.store.set(f.loadedAt, 1);
      const loading = h.store.set(f.load);
      await h.waitForHeads(1);
      h.heads[0].resolve(page([head, ack, older], "completed-cursor", true));
      await loading;

      h.store.set(f.posts, (rows) =>
        rows.map((row) =>
          row.ap_id === ack.ap_id ? { ...row, liked: true } : row,
        ),
      );
      await acknowledge(h, ack);
      expect(h.store.get(f.posts).map((row) => row.ap_id)).toEqual([
        head.ap_id,
        ack.ap_id,
        older.ap_id,
      ]);
      expect(h.store.get(f.posts)[1].liked).toBe(true);
      expect(h.store.get(f.cursor)).toBe("completed-cursor");
      expect(h.store.get(f.hasMore)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  test(`${kind} full-head window merges an ACK once at the server position and preserves local patches`, async () => {
    const h = await fixture();
    const f = lane(h, kind);
    const head = post("server-head", 9);
    const ack = post("created-during-load", 8);
    const existing = post("existing-row", 7, { reply_count: 1 });
    const refreshedExisting = { ...existing, reply_count: 7 };
    try {
      h.store.set(f.loadedAt, 1);
      h.store.set(f.posts, [existing]);
      const loading = h.store.set(f.load);
      await h.waitForHeads(1);
      expect(h.heads[0].path).toBe(f.path);

      await acknowledge(h, ack);
      h.store.set(f.posts, (rows) =>
        rows.map((row) =>
          row.ap_id === ack.ap_id ? { ...row, liked: true } : row,
        ),
      );
      h.heads[0].resolve(
        page(
          [head, { ...ack, liked: false }, refreshedExisting],
          "raw-server-cursor",
          true,
        ),
      );
      await loading;

      const rows = h.store.get(f.posts);
      expect(rows.map((row) => row.ap_id)).toEqual([
        head.ap_id,
        ack.ap_id,
        existing.ap_id,
      ]);
      expect(rows.filter((row) => row.ap_id === ack.ap_id)).toHaveLength(1);
      expect(rows[1].liked).toBe(true);
      expect(rows[2].reply_count).toBe(7);
      expect(h.store.get(f.cursor)).toBe("raw-server-cursor");
      expect(h.store.get(f.hasMore)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  test(`${kind} full-head window inserts an older missing ACK by post order and retains paging metadata`, async () => {
    const h = await fixture();
    const f = lane(h, kind);
    const head = post("head", 9);
    const ack = post("missing-from-page", 5);
    const older = post("older", 4);
    try {
      h.store.set(f.loadedAt, 1);
      const loading = h.store.set(f.load);
      await h.waitForHeads(1);
      await acknowledge(h, ack);
      h.heads[0].resolve(page([head, older], "unchanged-cursor", false));
      await loading;

      expect(h.store.get(f.posts).map((row) => row.ap_id)).toEqual([
        head.ap_id,
        ack.ap_id,
        older.ap_id,
      ]);
      expect(h.store.get(f.cursor)).toBe("unchanged-cursor");
      expect(h.store.get(f.hasMore)).toBe(false);
      if (kind === "unified") {
        expect(h.store.get(h.atoms.newestSeenKeyAtom)).toBe(
          `${head.published} ${head.ap_id}`,
        );
        h.store.set(h.atoms.timelinePostsAtom, [older]);
        const poll = h.store.set(h.atoms.checkNewPostsAtom);
        await h.waitForHeads(2);
        h.heads[1].resolve(page([head], null, false));
        await poll;
        expect(h.store.get(h.atoms.pendingNewPostsAtom)).toEqual([]);
        expect(h.store.get(h.atoms.newestSeenKeyAtom)).toBe(
          `${head.published} ${head.ap_id}`,
        );
      }
    } finally {
      await h.cleanup();
    }
  });

  test(`${kind} older full completion cannot clear ACKs owned by a newer head window`, async () => {
    const h = await fixture();
    const f = lane(h, kind);
    const ack = post(`second-window-${kind}-ack`, 9);
    try {
      const older = h.store.set(f.load);
      await h.waitForHeads(1);
      const current = h.store.set(f.load);
      await h.waitForHeads(2);

      h.heads[0].resolve(page([post(`old-${kind}-head`, 10)], "old", true));
      await older;
      await acknowledge(h, ack);
      h.heads[1].resolve(page([post(`new-${kind}-head`, 8)], "new", false));
      await current;

      expect(h.store.get(f.posts).map((row) => row.ap_id)).toEqual([
        ack.ap_id,
        objectId(`new-${kind}-head`),
      ]);
      expect(
        h.store.get(f.posts).filter((row) => row.ap_id === ack.ap_id),
      ).toHaveLength(1);
      expect(h.store.get(f.cursor)).toBe("new");
      expect(h.store.get(f.hasMore)).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
}

test("following ACK during the first full load waits for the head and appears once", async () => {
  const h = await fixture();
  const f = lane(h, "following");
  const ack = post("first-following-ack", 9);
  const serverHead = post("following-head", 8);
  try {
    expect(h.store.get(f.loadedAt)).toBeNull();
    const loading = h.store.set(f.load);
    await h.waitForHeads(1);
    await acknowledge(h, ack);
    expect(h.store.get(f.posts)).toEqual([]);

    h.heads[0].resolve(page([serverHead], "first-cursor", true));
    await loading;
    expect(h.store.get(f.posts).map((row) => row.ap_id)).toEqual([
      ack.ap_id,
      serverHead.ap_id,
    ]);
    expect(
      h.store.get(f.posts).filter((row) => row.ap_id === ack.ap_id),
    ).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});

test("following first-head ACK uses fresh server fields when no ACK row was visible", async () => {
  const h = await fixture();
  const f = lane(h, "following");
  const ack = post("cold-following-server-copy", 9);
  try {
    expect(h.store.get(f.loadedAt)).toBeNull();
    const loading = h.store.set(f.load);
    await h.waitForHeads(1);
    await acknowledge(h, ack);
    expect(h.store.get(f.posts)).toEqual([]);

    h.heads[0].resolve(
      page(
        [{ ...ack, like_count: 2, reply_count: 7 }],
        "fresh-server-cursor",
        true,
      ),
    );
    await loading;

    const rows = h.store.get(f.posts);
    expect(rows).toHaveLength(1);
    expect(rows[0].ap_id).toBe(ack.ap_id);
    expect(rows[0].like_count).toBe(2);
    expect(rows[0].reply_count).toBe(7);
    expect(h.store.get(f.cursor)).toBe("fresh-server-cursor");
    expect(h.store.get(f.hasMore)).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test("following ACK is not carried past a failed first head window", async () => {
  const h = await fixture();
  const f = lane(h, "following");
  const ack = post("failed-first-window-ack", 9);
  try {
    const failed = h.store.set(f.load);
    await h.waitForHeads(1);
    await acknowledge(h, ack);
    expect(h.store.get(f.posts)).toEqual([]);
    h.heads[0].reject(new Error("first following head offline"));
    await failed;

    const retry = h.store.set(f.load);
    await h.waitForHeads(2);
    h.heads[1].resolve(page([post("retry-head", 8)], "retry", true));
    await retry;
    expect(h.store.get(f.posts).map((row) => row.ap_id)).toEqual([
      objectId("retry-head"),
    ]);
    expect(h.store.get(f.posts).some((row) => row.ap_id === ack.ap_id)).toBe(
      false,
    );
  } finally {
    await h.cleanup();
  }
});

test("an ACK belongs only to its active head window and a later head replaces it", async () => {
  const h = await fixture();
  const f = lane(h, "unified");
  const ack = post("window-one-ack", 9);
  try {
    const first = h.store.set(f.load);
    await h.waitForHeads(1);
    await acknowledge(h, ack);
    h.heads[0].resolve(page([post("first-server-head", 8)], "first", true));
    await first;
    expect(h.store.get(f.posts).some((row) => row.ap_id === ack.ap_id)).toBe(
      true,
    );

    const second = h.store.set(f.load);
    await h.waitForHeads(2);
    h.heads[1].resolve(page([post("second-server-head", 10)], "second", false));
    await second;
    expect(h.store.get(f.posts).map((row) => row.content)).toEqual([
      "second-server-head",
    ]);
    expect(h.store.get(f.posts).some((row) => row.ap_id === ack.ap_id)).toBe(
      false,
    );
  } finally {
    await h.cleanup();
  }
});

test("a full head does not resurrect an ACK removed while the response is held", async () => {
  const h = await fixture();
  const f = lane(h, "unified");
  const ack = post("removed-visible-ack", 9);
  try {
    const loading = h.store.set(f.load);
    await h.waitForHeads(1);
    await acknowledge(h, ack);
    expect(h.store.get(f.posts).map((row) => row.ap_id)).toEqual([ack.ap_id]);
    h.store.set(f.posts, []);

    h.heads[0].resolve(page([ack, post("server-head", 8)], "cursor", true));
    await loading;
    expect(h.store.get(f.posts).map((row) => row.ap_id)).toEqual([
      objectId("server-head"),
    ]);
  } finally {
    await h.cleanup();
  }
});

test("a successful delete mask prevents a later create ACK from restoring the row", async () => {
  const h = await fixture();
  const deleted = post("masked-ack", 9);
  try {
    await h.store.set(h.atoms.deleteTimelinePostAtom, deleted.ap_id);
    await acknowledge(h, deleted);
    expect(h.store.get(h.atoms.timelinePostsAtom)).toEqual([]);
    expect(h.store.get(h.atoms.followingPostsAtom)).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test("a boost entry and the canonical post ACK remain distinct feed entries", async () => {
  const h = await fixture();
  const canonical = post("same-object", 9);
  const boost = {
    ...canonical,
    repost_ap_id: `${origin}/ap/activities/announce-1`,
    repost_published: "2026-01-10T00:00:00.000Z",
  } satisfies PostWithRepost;
  try {
    h.store.set(h.auth.actorAtom, actor());
    h.store.set(h.atoms.timelinePostsAtom, [boost]);
    h.setPostResponder(async () => postAck(canonical));
    await h.store.set(h.atoms.createPostAtom, { content: canonical.content });

    const rows = h.store.get(h.atoms.timelinePostsAtom);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => feedItemKey(row))).toEqual([
      canonical.ap_id,
      boost.repost_ap_id,
    ]);
  } finally {
    await h.cleanup();
  }
});

test("a full request captured in community A cannot replace community B after a scope-only switch", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const h = await fixture();
    const f = lane(h, "unified");
    const communityA = `${origin}/ap/communities/a`;
    const communityB = `${origin}/ap/communities/b`;
    try {
      h.store.set(h.scope.inhabitedScopeAtom, {
        kind: "community",
        ap_id: communityA,
        name: "a",
        display_name: "A",
        member_role: "member",
      });
      const loading = h.store.set(f.load);
      await h.waitForHeads(1);
      expect(h.heads[0].path).toBe("/api/timeline");

      const ackA = post("community-a-ack", 9, {
        community_ap_id: communityA,
      });
      await acknowledge(h, ackA, communityA);
      h.store.set(h.scope.inhabitedScopeAtom, {
        kind: "community",
        ap_id: communityB,
        name: "b",
        display_name: "B",
        member_role: "member",
      });
      const bVisible = post("community-b-row", 8, {
        community_ap_id: communityB,
      });
      h.store.set(f.posts, [bVisible]);
      h.store.set(h.atoms.timelineLoadErrorAtom, "community B error");

      if (outcome === "success") {
        h.heads[0].resolve(
          page([post("community-a-row", 10)], "a-cursor", true),
        );
      } else {
        h.heads[0].reject(new Error("community A offline"));
      }
      await loading;

      expect(h.store.get(f.posts).map((row) => row.ap_id)).toEqual([
        bVisible.ap_id,
      ]);
      expect(h.store.get(h.atoms.timelineLoadErrorAtom)).toBe(
        "community B error",
      );
    } finally {
      await h.cleanup();
    }
  }
});

test("a held community A POST ACK cannot enter a community B full-head window", async () => {
  const h = await fixture();
  const f = lane(h, "unified");
  const communityA = `${origin}/ap/communities/a`;
  const communityB = `${origin}/ap/communities/b`;
  const heldPost = deferred<Response>();
  let markPostArrived!: () => void;
  const postArrived = new Promise<void>((resolve) => {
    markPostArrived = resolve;
  });
  try {
    const setCommunity = (apId: string, name: string) =>
      h.store.set(h.scope.inhabitedScopeAtom, {
        kind: "community",
        ap_id: apId,
        name,
        display_name: name.toUpperCase(),
        member_role: "member",
      });
    setCommunity(communityB, "b");
    const loadingB = h.store.set(f.load);
    await h.waitForHeads(1);

    setCommunity(communityA, "a");
    h.store.set(h.auth.actorAtom, actor());
    const ackA = post("held-community-a-ack", 9, {
      community_ap_id: communityA,
    });
    h.setPostResponder(() => {
      markPostArrived();
      return heldPost.promise;
    });
    const submitting = h.store.set(h.atoms.createPostAtom, {
      content: ackA.content,
      community_ap_id: communityA,
    });
    await postArrived;

    setCommunity(communityB, "b");
    heldPost.resolve(postAck(ackA));
    await submitting;
    h.heads[0].resolve(page([post("community-b-head", 8)], "b-cursor", true));
    await loadingB;

    expect(h.store.get(f.posts).map((row) => row.ap_id)).toEqual([
      objectId("community-b-head"),
    ]);
    expect(h.store.get(f.posts).some((row) => row.ap_id === ackA.ap_id)).toBe(
      false,
    );
  } finally {
    heldPost.resolve(postAck(post("cleanup-post", 1)));
    await h.cleanup();
  }
});

test("ACK state is isolated between Jotai stores", async () => {
  const h = await fixture();
  const other = createStore();
  const ack = post("store-local-ack", 9);
  try {
    await acknowledge(h, ack);
    expect(
      h.store.get(h.atoms.timelinePostsAtom).map((row) => row.ap_id),
    ).toEqual([ack.ap_id]);
    expect(other.get(h.atoms.timelinePostsAtom)).toEqual([]);
    expect(other.get(h.atoms.followingPostsAtom)).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

for (const kind of ["unified", "following", "poll"] as const) {
  test(`${kind} pre-unsave read cannot restore an absent saved object or its boost`, async () => {
    const h = await fixture();
    const f = lane(h, kind === "following" ? "following" : "unified");
    const target = post("older-or-poll-unsave", kind === "poll" ? 12 : 8, {
      bookmarked: true,
    });
    const boost: PostWithRepost = {
      ...target,
      repost_ap_id: objectId("older-or-poll-boost"),
      reposted_by: actor(),
      repost_published: "2026-01-13T00:00:00.000Z",
    };
    const existing = post("existing-read-anchor", 10);
    const unrelated = post("unrelated-read-save", kind === "poll" ? 11 : 7, {
      bookmarked: true,
      liked: true,
    });
    try {
      h.store.set(f.posts, [existing]);
      h.store.set(f.cursor, "start-cursor");
      h.store.set(f.hasMore, true);
      const read =
        kind === "poll"
          ? h.atoms.checkNewPostsAtom
          : kind === "following"
            ? h.atoms.loadMoreFollowingTimelineAtom
            : h.atoms.loadMoreTimelineAtom;
      const loading = h.store.set(read);
      await h.waitForHeads(1);
      await h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id);
      h.heads[0]!.resolve(
        page([boost, target, unrelated], "next-cursor", false),
      );
      await loading;
      const rows = h.store.get(
        kind === "poll" ? h.atoms.pendingNewPostsAtom : f.posts,
      );
      expect(
        rows
          .filter((row) => row.ap_id === target.ap_id)
          .map((row) => row.bookmarked),
      ).toEqual([false, false]);
      expect(rows.find((row) => row.ap_id === unrelated.ap_id)).toEqual(
        unrelated,
      );
      if (kind === "poll") {
        h.store.set(h.atoms.applyNewPostsAtom);
        expect(
          h.store
            .get(f.posts)
            .filter((row) => row.ap_id === target.ap_id)
            .every((row) => row.bookmarked === false),
        ).toBe(true);
      } else {
        expect(h.store.get(f.cursor)).toBe("next-cursor");
        expect(h.store.get(f.hasMore)).toBe(false);
      }
    } finally {
      await h.cleanup();
    }
  });
}

for (const kind of ["unified", "following", "poll"] as const) {
  for (const outcome of ["503", "ack-loss"] as const) {
    test(`${kind} unconfirmed unsave ${outcome} leaves earlier GET authority`, async () => {
      const h = await fixture();
      const f = lane(h, kind === "following" ? "following" : "unified");
      const target = post("unconfirmed-page-target", kind === "poll" ? 12 : 8, {
        bookmarked: true,
      });
      try {
        h.store.set(f.posts, [post("page-anchor", 10)]);
        h.store.set(f.cursor, "initial");
        const read =
          kind === "poll"
            ? h.atoms.checkNewPostsAtom
            : kind === "following"
              ? h.atoms.loadMoreFollowingTimelineAtom
              : h.atoms.loadMoreTimelineAtom;
        const loading = h.store.set(read);
        await h.waitForHeads(1);
        h.setDeleteResponder(async () => {
          if (outcome === "ack-loss") throw new TypeError("lost ACK");
          return new Response("refused", { status: 503 });
        });
        await expect(
          h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id),
        ).rejects.toThrow();
        h.heads[0]!.resolve(page([target], "next", true));
        await loading;
        expect(
          h.store
            .get(kind === "poll" ? h.atoms.pendingNewPostsAtom : f.posts)
            .find((row) => row.ap_id === target.ap_id)?.bookmarked,
        ).toBe(true);
      } finally {
        await h.cleanup();
      }
    });
  }
  test(`${kind} late read and error cannot publish across an observed actor change`, async () => {
    const h = await fixture();
    const f = lane(h, kind === "following" ? "following" : "unified");
    const anchor = post("actor-page-anchor", 10);
    const next = post("next-actor-anchor", 11);
    try {
      h.store.set(f.posts, [anchor]);
      h.store.set(f.cursor, "actor-cursor");
      const read =
        kind === "poll"
          ? h.atoms.checkNewPostsAtom
          : kind === "following"
            ? h.atoms.loadMoreFollowingTimelineAtom
            : h.atoms.loadMoreTimelineAtom;
      const loading = h.store.set(read);
      await h.waitForHeads(1);
      h.store.set(h.auth.actorAtom, {
        ...actor(),
        ap_id: `${origin}/ap/users/persona`,
      });
      h.store.set(f.posts, [next]);
      h.heads[0]!.resolve(
        page(
          [
            post("old-principal-target", kind === "poll" ? 12 : 8, {
              bookmarked: true,
            }),
          ],
          "old-next",
          false,
        ),
      );
      await loading;
      expect(h.store.get(f.posts)).toEqual([next]);
      expect(h.store.get(h.atoms.pendingNewPostsAtom)).toEqual([]);
      expect(h.store.get(f.cursor)).toBe("actor-cursor");
      expect(h.store.get(f.hasMore)).toBe(true);
      // New active request belongs to the current actor; losing it after a
      // second actor change must not publish that prior actor's error either.
      const failed = h.store.set(read);
      await h.waitForHeads(2);
      h.store.set(h.auth.actorAtom, actor());
      h.heads[1]!.reject(new Error("old actor offline"));
      await failed;
      const { toastsAtom } = await import("./toast.ts");
      expect(h.store.get(toastsAtom)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
  test(`${kind} later GET remains authoritative after a confirmed unsave`, async () => {
    const h = await fixture();
    const f = lane(h, kind === "following" ? "following" : "unified");
    const target = post("next-get-authority", kind === "poll" ? 12 : 8, {
      bookmarked: true,
    });
    try {
      h.store.set(f.posts, [post("authority-anchor", 10)]);
      h.store.set(f.cursor, "initial");
      const read =
        kind === "poll"
          ? h.atoms.checkNewPostsAtom
          : kind === "following"
            ? h.atoms.loadMoreFollowingTimelineAtom
            : h.atoms.loadMoreTimelineAtom;
      const loading = h.store.set(read);
      await h.waitForHeads(1);
      await h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id);
      h.heads[0]!.resolve(page([target], "next", true));
      await loading;
      h.store.set(f.posts, [post("authority-anchor", 10)]);
      h.store.set(h.atoms.pendingNewPostsAtom, []);
      const later = h.store.set(read);
      await h.waitForHeads(2);
      h.heads[1]!.resolve(page([target], "latest", false));
      await later;
      expect(
        h.store
          .get(kind === "poll" ? h.atoms.pendingNewPostsAtom : f.posts)
          .find((row) => row.ap_id === target.ap_id)?.bookmarked,
      ).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
}

for (const kind of ["unified", "following", "poll"] as const) {
  test(`${kind} Home toggle ACK participates in earlier read ordering`, async () => {
    const h = await fixture();
    const f = lane(h, kind === "following" ? "following" : "unified");
    const target = post("home-toggle-target", kind === "poll" ? 12 : 8, {
      bookmarked: true,
    });
    try {
      h.store.set(f.posts, [target, post("home-toggle-anchor", 10)]);
      h.store.set(f.cursor, "start");
      const read =
        kind === "poll"
          ? h.atoms.checkNewPostsAtom
          : kind === "following"
            ? h.atoms.loadMoreFollowingTimelineAtom
            : h.atoms.loadMoreTimelineAtom;
      const loading = h.store.set(read);
      await h.waitForHeads(1);
      const { toggleBookmark } = await import("./posts.ts");
      await toggleBookmark(
        target,
        (fn) => h.store.set(f.posts, fn),
        (bookmarked) => {
          h.store.set(h.atoms.acknowledgeTimelineBookmarkAtom, {
            actorApId: ownerId,
            apId: target.ap_id,
            bookmarked,
          });
        },
      );
      const boost: PostWithRepost = {
        ...target,
        repost_ap_id: objectId("home-toggle-boost"),
        reposted_by: actor(),
        repost_published: "2026-01-13T00:00:00.000Z",
      };
      h.heads[0]!.resolve(page([boost], "next", false));
      await loading;
      expect(
        h.store
          .get(kind === "poll" ? h.atoms.pendingNewPostsAtom : f.posts)
          .find((row) => feedItemKey(row) === feedItemKey(boost))?.bookmarked,
      ).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
}

test("overlapping read windows retain ACKs independently and leave later server saves authoritative", async () => {
  const h = await fixture();
  const target = post("overlapping-window-target", 12, { bookmarked: true });
  const anchor = post("overlapping-anchor", 10);
  try {
    h.store.set(h.atoms.timelinePostsAtom, [anchor]);
    h.store.set(h.atoms.followingPostsAtom, [anchor]);
    h.store.set(h.atoms.followingCursorAtom, "start");
    const polling = h.store.set(h.atoms.checkNewPostsAtom);
    const paging = h.store.set(h.atoms.loadMoreFollowingTimelineAtom);
    await h.waitForHeads(2);
    await h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id);
    h.heads[0]!.resolve(page([target], "poll", false));
    await polling;
    expect(h.store.get(h.atoms.pendingNewPostsAtom)[0]!.bookmarked).toBe(false);
    h.heads[1]!.resolve(page([target], "older", true));
    await paging;
    expect(h.store.get(h.atoms.followingPostsAtom)[1]!.bookmarked).toBe(false);
    const later = h.store.set(h.atoms.loadFollowingTimelineAtom);
    await h.waitForHeads(3);
    h.heads[2]!.resolve(page([target], null, false));
    await later;
    expect(h.store.get(h.atoms.followingPostsAtom)[0]!.bookmarked).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test("a failed optimistic Home unsave cannot roll back a later confirmed Bookmarks unsave", async () => {
  const h = await fixture();
  const target = post("rollback-after-detail-ack", 10, { bookmarked: true });
  try {
    h.store.set(h.atoms.timelinePostsAtom, [target]);
    const loading = h.store.set(h.atoms.loadTimelineAtom);
    await h.waitForHeads(1);
    const failedDelete = deferred<Response>();
    h.setDeleteResponder(() => failedDelete.promise);
    const toggling = h.store.set(h.atoms.toggleTimelineBookmarkAtom, target);
    h.setDeleteResponder(
      async () => new Response(JSON.stringify({ success: true })),
    );
    expect(
      await h.store.set(h.atoms.unbookmarkTimelinePostAtom, target.ap_id),
    ).toBe(true);
    failedDelete.reject(new TypeError("earlier Home ACK lost"));
    await expect(toggling).rejects.toThrow();
    expect(h.store.get(h.atoms.timelinePostsAtom)[0]!.bookmarked).toBe(false);
    h.heads[0]!.resolve(page([target], null, false));
    await loading;
    expect(h.store.get(h.atoms.timelinePostsAtom)[0]!.bookmarked).toBe(false);
  } finally {
    await h.cleanup();
  }
});

for (const later of ["none", "other-object"] as const) {
  test(`failed Home unsave still rolls back when later ACK is ${later}`, async () => {
    const h = await fixture();
    const target = post("rollback-owned-target", 10, { bookmarked: true });
    try {
      h.store.set(h.atoms.timelinePostsAtom, [target]);
      const failedDelete = deferred<Response>();
      h.setDeleteResponder(() => failedDelete.promise);
      const toggling = h.store.set(h.atoms.toggleTimelineBookmarkAtom, target);
      expect(h.store.get(h.atoms.timelinePostsAtom)[0]!.bookmarked).toBe(false);
      if (later === "other-object") {
        h.setDeleteResponder(
          async () => new Response(JSON.stringify({ success: true })),
        );
        await h.store.set(
          h.atoms.unbookmarkTimelinePostAtom,
          objectId("other-rollback-target"),
        );
      }
      failedDelete.reject(new TypeError("Home write failed"));
      await expect(toggling).rejects.toThrow();
      expect(h.store.get(h.atoms.timelinePostsAtom)[0]!.bookmarked).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
}
