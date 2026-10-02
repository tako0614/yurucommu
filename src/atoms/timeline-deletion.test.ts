import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Actor, Post, PostWithRepost } from "../types/index.ts";

// i18n reads browser globals while timeline.ts is imported. Keep this before
// the dynamic import, as in timeline-pagination.test.ts.
function ensureBrowserStorage(): void {
  if (typeof globalThis.localStorage === "undefined") {
    const values = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  }
  if (
    typeof globalThis.navigator === "undefined" ||
    !globalThis.navigator.language
  ) {
    Object.defineProperty(globalThis, "navigator", {
      value: { language: "en-US" },
      configurable: true,
    });
  }
}

const origin = "https://example.test";
const ownerId = `${origin}/ap/users/owner`;
const id = (name: string) => `${origin}/ap/objects/${name}`;

function post(name: string, day: number): Post {
  return {
    ap_id: id(name),
    type: "Note",
    author: {
      ap_id: ownerId,
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
    published: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  };
}

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

function page(
  posts: Post[],
  cursor: string | null,
  hasMore: boolean,
): Response {
  return new Response(
    JSON.stringify({ posts, next_cursor: cursor, has_more: hasMore }),
    { status: 200, headers: { "Content-Type": "application/json" } },
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

function request(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    origin,
  );
  return {
    url,
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
  };
}

async function withFetch<T>(
  mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const { clearYurucommuFrontendPlugin } = await import("../lib/plugin.ts");
  clearYurucommuFrontendPlugin();
  globalThis.fetch = mock as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    clearYurucommuFrontendPlugin();
  }
}

for (const lane of [
  "following-full",
  "following-older",
  "unified-full",
  "unified-older",
  "head-poll",
] as const) {
  test(`confirmed deletion masks a pre-DELETE ${lane} response without losing unrelated rows`, async () => {
    ensureBrowserStorage();
    const atoms = await import("./timeline.ts");
    const stale = deferred<Response>();
    const m1 = post("delete-me", 5);
    const m2 = post("keep-me", 4);
    const older = post("older-unrelated", 3);
    const newCanary = post("new-unrelated", 7);
    const nextCursor = `${older.published} ${older.ap_id}`;
    const calls: Array<{
      path: string;
      method: string;
      before: string | null;
    }> = [];

    await withFetch(
      async (input, init) => {
        const { url, method } = request(input, init);
        calls.push({
          path: url.pathname,
          method,
          before: url.searchParams.get("before"),
        });
        if (method === "DELETE") {
          expect(url.pathname).toBe(
            `/api/posts/${encodeURIComponent(m1.ap_id)}`,
          );
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
          });
        }
        return stale.promise;
      },
      async () => {
        const store = createStore();
        store.set(atoms.timelinePostsAtom, [m1, m2]);
        store.set(atoms.followingPostsAtom, [m1, m2]);
        store.set(atoms.pendingNewPostsAtom, [m1]);
        store.set(atoms.timelineCursorAtom, "unified-before");
        store.set(atoms.timelineHasMoreAtom, true);
        store.set(atoms.followingCursorAtom, "following-before");
        store.set(atoms.followingHasMoreAtom, true);
        store.set(atoms.newestSeenKeyAtom, `${m2.published} ${m2.ap_id}`);

        const loading =
          lane === "following-full"
            ? store.set(atoms.loadFollowingTimelineAtom)
            : lane === "following-older"
              ? store.set(atoms.loadMoreFollowingTimelineAtom)
              : lane === "unified-full"
                ? store.set(atoms.loadTimelineAtom)
                : lane === "unified-older"
                  ? store.set(atoms.loadMoreTimelineAtom)
                  : store.set(atoms.checkNewPostsAtom);
        expect(calls[0]?.method).toBe("GET");
        expect(calls[0]?.path).toBe(
          lane.startsWith("following")
            ? "/api/timeline/following"
            : "/api/timeline",
        );
        if (lane.endsWith("older")) {
          expect(calls[0]?.before).toBe(
            lane.startsWith("following")
              ? "following-before"
              : "unified-before",
          );
        }

        await store.set(atoms.deleteTimelinePostAtom, m1.ap_id);
        expect(store.get(atoms.timelinePostsAtom).map((p) => p.ap_id)).toEqual([
          m2.ap_id,
        ]);
        expect(store.get(atoms.followingPostsAtom).map((p) => p.ap_id)).toEqual(
          [m2.ap_id],
        );
        expect(store.get(atoms.pendingNewPostsAtom)).toEqual([]);

        stale.resolve(
          page(
            lane === "head-poll" ? [newCanary, m1, m2] : [m1, m2, older],
            nextCursor,
            true,
          ),
        );
        await loading;
        for (const feed of [
          atoms.timelinePostsAtom,
          atoms.followingPostsAtom,
          atoms.pendingNewPostsAtom,
        ]) {
          expect(store.get(feed).some((p) => p.ap_id === m1.ap_id)).toBe(false);
        }
        expect(
          store.get(atoms.timelinePostsAtom).some((p) => p.ap_id === m2.ap_id),
        ).toBe(true);
        expect(
          store.get(atoms.followingPostsAtom).some((p) => p.ap_id === m2.ap_id),
        ).toBe(true);
        if (lane === "following-full" || lane === "following-older") {
          expect(store.get(atoms.followingCursorAtom)).toBe(nextCursor);
          expect(store.get(atoms.followingHasMoreAtom)).toBe(true);
          expect(
            store
              .get(atoms.followingPostsAtom)
              .some((p) => p.ap_id === older.ap_id),
          ).toBe(true);
        }
        if (lane === "unified-full" || lane === "unified-older") {
          expect(store.get(atoms.timelineCursorAtom)).toBe(nextCursor);
          expect(store.get(atoms.timelineHasMoreAtom)).toBe(true);
          expect(
            store
              .get(atoms.timelinePostsAtom)
              .some((p) => p.ap_id === older.ap_id),
          ).toBe(true);
        }
        if (lane === "head-poll") {
          expect(
            store
              .get(atoms.pendingNewPostsAtom)
              .some((p) => p.ap_id === older.ap_id),
          ).toBe(false);
          expect(store.get(atoms.newestSeenKeyAtom)).toBe(
            `${m2.published} ${m2.ap_id}`,
          );
          expect(
            store.get(atoms.pendingNewPostsAtom).map((p) => p.ap_id),
          ).toEqual([newCanary.ap_id]);
          store.set(atoms.applyNewPostsAtom);
          expect(
            store.get(atoms.timelinePostsAtom).map((p) => p.ap_id),
          ).toEqual([newCanary.ap_id, m2.ap_id]);
        }
      },
    );
  });
}

test("canonical deletion removes the original and its boost from all three feeds", async () => {
  ensureBrowserStorage();
  const atoms = await import("./timeline.ts");
  const m1 = post("canonical", 5);
  const m2 = post("unrelated", 4);
  const boost: PostWithRepost = {
    ...m1,
    repost_ap_id: `${origin}/ap/activities/boost-1`,
    repost_published: "2026-01-06T00:00:00.000Z",
  };
  await withFetch(
    async () => new Response(null, { status: 200 }),
    async () => {
      const store = createStore();
      for (const feed of [
        atoms.timelinePostsAtom,
        atoms.followingPostsAtom,
        atoms.pendingNewPostsAtom,
      ]) {
        store.set(feed, [boost, m1, m2]);
      }
      await store.set(atoms.deleteTimelinePostAtom, m1.ap_id);
      for (const feed of [
        atoms.timelinePostsAtom,
        atoms.followingPostsAtom,
        atoms.pendingNewPostsAtom,
      ]) {
        expect(store.get(feed).map((p) => p.ap_id)).toEqual([m2.ap_id]);
      }
    },
  );
});

for (const failure of ["refused", "uncertain"] as const) {
  test(`${failure} DELETE leaves every feed row and permits a later write`, async () => {
    ensureBrowserStorage();
    const atoms = await import("./timeline.ts");
    const m1 = post("not-confirmed", 5);
    const m2 = post("keep", 4);
    await withFetch(
      async (_input, init) => {
        expect(init?.method).toBe("DELETE");
        if (failure === "uncertain")
          throw new TypeError("network outcome unknown");
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
        });
      },
      async () => {
        const store = createStore();
        for (const feed of [
          atoms.timelinePostsAtom,
          atoms.followingPostsAtom,
          atoms.pendingNewPostsAtom,
        ]) {
          store.set(feed, [m1, m2]);
        }
        await expect(
          store.set(atoms.deleteTimelinePostAtom, m1.ap_id),
        ).rejects.toThrow();
        for (const feed of [
          atoms.timelinePostsAtom,
          atoms.followingPostsAtom,
          atoms.pendingNewPostsAtom,
        ]) {
          expect(store.get(feed).map((p) => p.ap_id)).toEqual([
            m1.ap_id,
            m2.ap_id,
          ]);
          store.set(feed, (rows) => [...rows, m1]);
          expect(
            store.get(feed).filter((p) => p.ap_id === m1.ap_id),
          ).toHaveLength(2);
        }
      },
    );
  });
}

test("deletion mask survives actor changes and direct or updater ACK-shaped writes only in its store", async () => {
  ensureBrowserStorage();
  const atoms = await import("./timeline.ts");
  const { actorAtom } = await import("./auth.ts");
  const m1 = post("deleted-across-actors", 5);
  const m2 = post("retained", 4);
  await withFetch(
    async () => new Response(null, { status: 200 }),
    async () => {
      const first = createStore();
      first.set(actorAtom, actor("owner"));
      first.set(atoms.timelinePostsAtom, [m1, m2]);
      await first.set(atoms.deleteTimelinePostAtom, m1.ap_id);
      first.set(actorAtom, actor("persona"));
      for (const feed of [
        atoms.timelinePostsAtom,
        atoms.followingPostsAtom,
        atoms.pendingNewPostsAtom,
      ]) {
        first.set(feed, [m1, m2]);
        first.set(feed, (rows) => [m1, ...rows]);
        expect(first.get(feed).map((p) => p.ap_id)).toEqual([m2.ap_id]);
      }
      const freshStore = createStore();
      freshStore.set(atoms.timelinePostsAtom, [m1, m2]);
      expect(
        freshStore.get(atoms.timelinePostsAtom).map((p) => p.ap_id),
      ).toEqual([m1.ap_id, m2.ap_id]);
    },
  );
});

for (const lane of ["following", "unified"] as const) {
  test(`${lane} all-masked page remains pageable using its server cursor`, async () => {
    ensureBrowserStorage();
    const atoms = await import("./timeline.ts");
    const m1 = post("masked-page", 5);
    const old = post("next-page", 4);
    const cursor = `${m1.published} ${m1.ap_id}`;
    const calls: string[] = [];
    await withFetch(
      async (input, init) => {
        const { url, method } = request(input, init);
        if (method === "DELETE") return new Response(null, { status: 200 });
        calls.push(url.href);
        return page(
          calls.length === 1 ? [m1] : [old],
          calls.length === 1 ? cursor : null,
          calls.length === 1,
        );
      },
      async () => {
        const store = createStore();
        const rowsAtom =
          lane === "following"
            ? atoms.followingPostsAtom
            : atoms.timelinePostsAtom;
        const cursorAtom =
          lane === "following"
            ? atoms.followingCursorAtom
            : atoms.timelineCursorAtom;
        const hasMoreAtom =
          lane === "following"
            ? atoms.followingHasMoreAtom
            : atoms.timelineHasMoreAtom;
        await store.set(atoms.deleteTimelinePostAtom, m1.ap_id);
        await store.set(
          lane === "following"
            ? atoms.loadFollowingTimelineAtom
            : atoms.loadTimelineAtom,
        );
        expect(store.get(rowsAtom)).toEqual([]);
        expect(store.get(hasMoreAtom)).toBe(true);
        expect(store.get(cursorAtom)).toBe(cursor);
        await store.set(
          lane === "following"
            ? atoms.loadMoreFollowingTimelineAtom
            : atoms.loadMoreTimelineAtom,
        );
        expect(new URL(calls[1]).searchParams.get("before")).toBe(cursor);
        expect(store.get(rowsAtom).map((p) => p.ap_id)).toEqual([old.ap_id]);
      },
    );
  });
}

test("full reload derives the head watermark from the first surviving row", async () => {
  ensureBrowserStorage();
  const atoms = await import("./timeline.ts");
  const m1 = post("masked-newest", 6);
  const m2 = post("surviving-head", 5);
  await withFetch(
    async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      return page([m1, m2], null, false);
    },
    async () => {
      const store = createStore();
      await store.set(atoms.deleteTimelinePostAtom, m1.ap_id);
      await store.set(atoms.loadTimelineAtom);
      expect(store.get(atoms.timelinePostsAtom).map((p) => p.ap_id)).toEqual([
        m2.ap_id,
      ]);
      expect(store.get(atoms.newestSeenKeyAtom)).toBe(
        `${m2.published} ${m2.ap_id}`,
      );
      await store.set(atoms.checkNewPostsAtom);
      expect(store.get(atoms.pendingNewPostsAtom)).toEqual([]);
      expect(store.get(atoms.newestSeenKeyAtom)).toBe(
        `${m2.published} ${m2.ap_id}`,
      );
    },
  );
});

for (const lane of ["following", "unified"] as const) {
  test(`${lane} older page filters masked rows before the 300-row tail cap`, async () => {
    ensureBrowserStorage();
    const atoms = await import("./timeline.ts");
    const m1 = post("masked-incoming", 2);
    const retained = Array.from({ length: 300 }, (_, index) =>
      post(`retained-${index}`, 3),
    );
    const nextCursor = `${m1.published} ${m1.ap_id}`;
    await withFetch(
      async (_input, init) => {
        if (init?.method === "DELETE")
          return new Response(null, { status: 200 });
        return page(
          Array.from({ length: 20 }, () => m1),
          nextCursor,
          true,
        );
      },
      async () => {
        const store = createStore();
        await store.set(atoms.deleteTimelinePostAtom, m1.ap_id);
        if (lane === "following") {
          store.set(atoms.followingPostsAtom, retained);
          store.set(atoms.followingCursorAtom, "before");
          await store.set(atoms.loadMoreFollowingTimelineAtom);
          expect(
            store.get(atoms.followingPostsAtom).map((p) => p.ap_id),
          ).toEqual(retained.map((p) => p.ap_id));
          expect(store.get(atoms.followingCursorAtom)).toBe(nextCursor);
        } else {
          store.set(atoms.timelinePostsAtom, retained);
          store.set(atoms.timelineCursorAtom, "before");
          await store.set(atoms.loadMoreTimelineAtom);
          expect(
            store.get(atoms.timelinePostsAtom).map((p) => p.ap_id),
          ).toEqual(retained.map((p) => p.ap_id));
          expect(store.get(atoms.timelineCursorAtom)).toBe(nextCursor);
        }
      },
    );
  });
}

test("head poll filters masked entries before the 100-item staged cap", async () => {
  ensureBrowserStorage();
  const atoms = await import("./timeline.ts");
  const m1 = post("masked-head", 6);
  const current = post("current-head", 4);
  const retainedHead = post("retained-new-head", 5);
  await withFetch(
    async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      return page(
        [...Array.from({ length: 100 }, () => m1), retainedHead],
        null,
        false,
      );
    },
    async () => {
      const store = createStore();
      store.set(atoms.timelinePostsAtom, [current]);
      store.set(
        atoms.newestSeenKeyAtom,
        `${current.published} ${current.ap_id}`,
      );
      await store.set(atoms.deleteTimelinePostAtom, m1.ap_id);
      await store.set(atoms.checkNewPostsAtom);
      expect(store.get(atoms.pendingNewPostsAtom).map((p) => p.ap_id)).toEqual([
        retainedHead.ap_id,
      ]);
    },
  );
});

test("rows stay visible until DELETE acknowledgement, then a late create ACK cannot restore them", async () => {
  ensureBrowserStorage();
  const atoms = await import("./timeline.ts");
  const { actorAtom } = await import("./auth.ts");
  const createAck = deferred<Response>();
  const deleteAck = deferred<Response>();
  const m1 = post("late-create", 6);
  const m2 = post("still-visible", 5);
  const owner = actor("owner");
  await withFetch(
    async (input, init) => {
      const { method } = request(input, init);
      return method === "POST" ? createAck.promise : deleteAck.promise;
    },
    async () => {
      const store = createStore();
      store.set(actorAtom, owner);
      store.set(atoms.postContentAtom, m1.content);
      store.set(atoms.postSummaryAtom, "");
      store.set(atoms.postVisibilityAtom, "public");
      store.set(atoms.timelinePostsAtom, [m1, m2]);
      store.set(atoms.newestSeenKeyAtom, `${m2.published} ${m2.ap_id}`);
      const posting = store.set(atoms.createPostAtom, {
        content: m1.content,
        visibility: "public",
      });
      const deleting = store.set(atoms.deleteTimelinePostAtom, m1.ap_id);
      expect(store.get(atoms.timelinePostsAtom).map((p) => p.ap_id)).toEqual([
        m1.ap_id,
        m2.ap_id,
      ]);
      deleteAck.resolve(new Response(null, { status: 200 }));
      await deleting;
      createAck.resolve(
        new Response(JSON.stringify({ post: m1 }), { status: 201 }),
      );
      await posting;
      expect(store.get(atoms.timelinePostsAtom).map((p) => p.ap_id)).toEqual([
        m2.ap_id,
      ]);
      expect(store.get(atoms.followingPostsAtom)).toEqual([]);
      expect(store.get(atoms.newestSeenKeyAtom)).toBe(
        `${m2.published} ${m2.ap_id}`,
      );
      expect(store.get(atoms.postingAtom)).toBe(false);
    },
  );
});
