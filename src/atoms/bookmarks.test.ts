import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Actor, Post } from "../types/index.ts";

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

function post(name: string, bookmarked = true): Post {
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
    like_count: 0,
    reply_count: 0,
    announce_count: 0,
    published: "2026-01-01T00:00:00.000Z",
    edited_at: null,
    liked: false,
    bookmarked,
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

type Request = {
  path: string;
  method: string;
  pending: ReturnType<typeof deferred<Response>>;
};

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
  const requests: Request[] = [];
  let deleteResponder: (() => Promise<Response>) | null = null;
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
      requests.push({ path: url.pathname + url.search, method, pending });
      if (method === "DELETE" && deleteResponder) return deleteResponder();
      return pending.promise;
    },
  });

  const plugin = await import("../lib/plugin.ts");
  plugin.clearYurucommuFrontendPlugin();
  const bookmarksModule = await import("./bookmarks.ts");
  const timeline = await import("./timeline.ts");
  const auth = await import("./auth.ts");
  const store = createStore();
  store.set(auth.actorAtom, actor("owner"));
  const state = bookmarksModule.createBookmarksState();
  return {
    store,
    state,
    timeline,
    auth,
    requests,
    setDeleteResponder(responder: () => Promise<Response>) {
      deleteResponder = responder;
    },
    cleanup() {
      plugin.clearYurucommuFrontendPlugin();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const response = (posts: Post[], nextCursor: string | null, hasMore: boolean) =>
  new Response(
    JSON.stringify({ posts, next_cursor: nextCursor, has_more: hasMore }),
  );

async function waitForRequest(
  h: Awaited<ReturnType<typeof fixture>>,
  count: number,
) {
  for (let attempt = 0; attempt < 20 && h.requests.length < count; attempt++) {
    await Promise.resolve();
  }
  expect(h.requests).toHaveLength(count);
  return h.requests[count - 1]!;
}

test("initial saved-list read reconciles an acknowledged unbookmark before publishing", async () => {
  const h = await fixture();
  const saved = post("initial-unsave");
  const other = post("initial-other");
  try {
    const loading = h.store.set(h.state.load);
    const get = await waitForRequest(h, 1);
    expect(get.path).toBe("/api/bookmarks");
    const unsaving = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      saved.ap_id,
    );
    await Promise.resolve();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.method).toBe("DELETE");
    h.requests[1]!.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    expect(await unsaving).toBe(true);
    get.pending.resolve(response([saved, other], "older-cursor", true));
    await loading;
    expect(h.store.get(h.state.posts)).toEqual([other]);
    expect(h.store.get(h.state.cursor)).toBe("older-cursor");
    expect(h.store.get(h.state.hasMore)).toBe(true);
  } finally {
    h.cleanup();
  }
});

test("older saved-list read reconciles ACKs, filters rows, deduplicates, and keeps server paging", async () => {
  const h = await fixture();
  const first = post("older-first");
  const removed = post("older-unsaved");
  const duplicate = post("older-duplicate");
  const unseen = post("older-unseen");
  try {
    const loading = h.store.set(h.state.load);
    (await waitForRequest(h, 1)).pending.resolve(
      response([first, duplicate], "page-2", true),
    );
    await loading;
    const paging = h.store.set(h.state.loadMore);
    const get = await waitForRequest(h, 2);
    expect(get.path).toBe("/api/bookmarks?before=page-2");
    const unsaving = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      removed.ap_id,
    );
    await Promise.resolve();
    expect(h.requests).toHaveLength(3);
    h.requests[2]!.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    expect(await unsaving).toBe(true);
    get.pending.resolve(response([removed, duplicate, unseen], "page-3", true));
    await paging;
    expect(h.store.get(h.state.posts)).toEqual([first, duplicate, unseen]);
    expect(h.store.get(h.state.cursor)).toBe("page-3");
    expect(h.store.get(h.state.hasMore)).toBe(true);
  } finally {
    h.cleanup();
  }
});

for (const outcome of ["refusal", "ack-loss"] as const) {
  test(`unconfirmed ${outcome} does not overlay the saved-list read`, async () => {
    const h = await fixture();
    const saved = post(`unconfirmed-${outcome}`);
    try {
      h.setDeleteResponder(async () => {
        if (outcome === "ack-loss") throw new TypeError("lost ACK");
        return new Response("refused", { status: 503 });
      });
      const loading = h.store.set(h.state.load);
      const get = await waitForRequest(h, 1);
      const unsaving = h.store.set(
        h.timeline.unbookmarkTimelinePostAtom,
        saved.ap_id,
      );
      await expect(unsaving).rejects.toThrow();
      get.pending.resolve(response([saved], "still-more", true));
      await loading;
      expect(h.store.get(h.state.posts)).toEqual([saved]);
      expect(h.store.get(h.state.cursor)).toBe("still-more");
    } finally {
      h.cleanup();
    }
  });
}

test("a later saved-list GET is server authoritative after a confirmed unbookmark", async () => {
  const h = await fixture();
  const saved = post("authoritative-later");
  try {
    const firstLoad = h.store.set(h.state.load);
    const first = await waitForRequest(h, 1);
    const unsaving = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      saved.ap_id,
    );
    await Promise.resolve();
    h.requests[1]!.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    await unsaving;
    first.pending.resolve(response([saved], "old-cursor", true));
    await firstLoad;
    expect(h.store.get(h.state.posts)).toEqual([]);

    const laterLoad = h.store.set(h.state.load);
    (await waitForRequest(h, 3)).pending.resolve(
      response([saved], null, false),
    );
    await laterLoad;
    expect(h.store.get(h.state.posts)).toEqual([saved]);
  } finally {
    h.cleanup();
  }
});

test("filtered empty older page keeps the server cursor and hasMore", async () => {
  const h = await fixture();
  const first = post("filtered-first");
  const falseBookmark = post("false-bookmark", false);
  try {
    const loading = h.store.set(h.state.load);
    (await waitForRequest(h, 1)).pending.resolve(
      response([first], "filtered-page", true),
    );
    await loading;
    const paging = h.store.set(h.state.loadMore);
    (await waitForRequest(h, 2)).pending.resolve(
      response([falseBookmark], "next-page", true),
    );
    await paging;
    expect(h.store.get(h.state.posts)).toEqual([first]);
    expect(h.store.get(h.state.cursor)).toBe("next-page");
    expect(h.store.get(h.state.hasMore)).toBe(true);
  } finally {
    h.cleanup();
  }
});

test("superseded, actor-changed, and disposed reads cannot publish rows, cursors, or errors", async () => {
  const h = await fixture();
  const stale = post("stale-bookmarks");
  const fresh = post("fresh-bookmarks");
  try {
    const oldLoad = h.store.set(h.state.load);
    const oldRequest = await waitForRequest(h, 1);
    const newLoad = h.store.set(h.state.load);
    const newRequest = await waitForRequest(h, 2);
    oldRequest.pending.resolve(response([stale], "stale-cursor", true));
    await oldLoad;
    expect(h.store.get(h.state.cursor)).toBeNull();
    newRequest.pending.resolve(response([fresh], "fresh-cursor", true));
    await newLoad;
    expect(h.store.get(h.state.posts)).toEqual([fresh]);
    expect(h.store.get(h.state.cursor)).toBe("fresh-cursor");

    const actorLoad = h.store.set(h.state.load);
    const actorRequest = await waitForRequest(h, 3);
    h.store.set(h.auth.actorAtom, actor("other"));
    actorRequest.pending.reject(new Error("stale actor failure"));
    await actorLoad;
    expect(h.store.get(h.state.posts)).toEqual([fresh]);
    expect(h.store.get(h.state.cursor)).toBeNull();
    expect(h.store.get(h.state.loadError)).toBeNull();

    h.store.set(h.auth.actorAtom, actor("owner"));
    const disposedLoad = h.store.set(h.state.load);
    const disposedRequest = await waitForRequest(h, 4);
    h.store.set(h.state.dispose);
    disposedRequest.pending.reject(new Error("disposed failure"));
    await disposedLoad;
    expect(h.store.get(h.state.posts)).toEqual([fresh]);
    expect(h.store.get(h.state.cursor)).toBeNull();
    expect(h.store.get(h.state.loadError)).toBeNull();
  } finally {
    h.cleanup();
  }
});
