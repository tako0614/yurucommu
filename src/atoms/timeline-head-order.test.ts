import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import {
  feedItemKey,
  type Actor,
  type Post,
  type PostWithRepost,
} from "../types/index.ts";

const origin = "https://example.test";
const owner: Actor = {
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

function post(number: number, timestamp = number): Post {
  return {
    ap_id: `${origin}/ap/objects/${String(number).padStart(3, "0")}`,
    type: "Note",
    author: owner,
    content: String(number),
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 0,
    reply_count: 0,
    announce_count: 0,
    published: new Date(Date.UTC(2026, 0, 1) + timestamp * 1000).toISOString(),
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  };
}

function range(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, i) => post(last - i));
}

function page(posts: Post[]) {
  return new Response(
    JSON.stringify({ posts, next_cursor: "head-cursor", has_more: true }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}

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
  const plugin = await import("../lib/plugin.ts");
  plugin.clearYurucommuFrontendPlugin();
  const releases: Array<(response: Response) => void> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: ((input: RequestInfo | URL) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        origin,
      );
      expect(url.pathname).toBe("/api/timeline");
      expect(url.searchParams.get("limit")).toBe("20");
      return new Promise<Response>((resolve) => releases.push(resolve));
    }) as typeof fetch,
  });
  const atoms = await import("./timeline.ts");
  const { actorAtom } = await import("./auth.ts");
  const store = createStore();
  store.set(actorAtom, owner);
  store.set(atoms.timelinePostsAtom, [post(0)]);
  store.set(atoms.newestSeenKeyAtom, `${post(0).published} ${post(0).ap_id}`);
  store.set(atoms.timelineCursorAtom, "retained-older-cursor");
  const pending: Promise<void>[] = [];
  return {
    atoms,
    store,
    releases,
    start: () => {
      const run = store.set(atoms.checkNewPostsAtom);
      pending.push(run);
      return run;
    },
    cleanup: async () => {
      for (const release of releases) release(page([]));
      await Promise.allSettled(pending);
      plugin.clearYurucommuFrontendPlugin();
      for (const key of keys) {
        const descriptor = descriptors.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

for (const order of ["older-first", "newer-first"] as const) {
  test(`overlapping 20-entry polls retain their ordered union: ${order}`, async () => {
    const f = await fixture();
    try {
      const older = f.start();
      const newer = f.start();
      expect(f.releases).toHaveLength(2);
      const releaseOlder = async () => {
        f.releases[0](page(range(1, 20)));
        await older;
      };
      const releaseNewer = async () => {
        f.releases[1](page(range(11, 30)));
        await newer;
      };
      if (order === "older-first") {
        await releaseOlder();
        await releaseNewer();
      } else {
        await releaseNewer();
        await releaseOlder();
      }
      const expected = range(1, 30).map(feedItemKey);
      expect(f.store.get(f.atoms.pendingNewPostsAtom).map(feedItemKey)).toEqual(
        expected,
      );
      f.store.set(f.atoms.applyNewPostsAtom);
      expect(f.store.get(f.atoms.timelinePostsAtom).map(feedItemKey)).toEqual([
        ...expected,
        feedItemKey(post(0)),
      ]);
      expect(f.store.get(f.atoms.pendingNewPostsAtom)).toEqual([]);
      expect(f.store.get(f.atoms.newestSeenKeyAtom)).toBe(
        `${post(30).published} ${post(30).ap_id}`,
      );
      expect(f.store.get(f.atoms.timelineCursorAtom)).toBe(
        "retained-older-cursor",
      );
      // A repeated head is neither a duplicate row nor a new indicator.
      const repeated = f.start();
      f.releases[2](page(range(11, 30)));
      await repeated;
      expect(f.store.get(f.atoms.pendingNewPostsAtom)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
}

test("late head merges sort equal timestamps by object ID and keep distinct boosts", async () => {
  const f = await fixture();
  try {
    const lower = post(8, 10);
    const higher = post(9, 10);
    const original = post(1);
    const boost = (number: number): PostWithRepost => ({
      ...original,
      repost_ap_id: `${origin}/ap/activities/boost-${number}`,
      repost_published: post(number).published,
      reposted_by: owner,
    });
    const older = f.start();
    const newer = f.start();
    f.releases[1](page([boost(32), higher, original]));
    await newer;
    f.releases[0](page([boost(31), higher, lower, original]));
    await older;
    const expected = [boost(32), boost(31), higher, lower, original].map(
      feedItemKey,
    );
    expect(f.store.get(f.atoms.pendingNewPostsAtom).map(feedItemKey)).toEqual(
      expected,
    );
    f.store.set(f.atoms.applyNewPostsAtom);
    expect(f.store.get(f.atoms.timelinePostsAtom).map(feedItemKey)).toEqual([
      ...expected,
      feedItemKey(post(0)),
    ]);
    expect(f.store.get(f.atoms.newestSeenKeyAtom)).toBe(
      `${post(32).published} ${original.ap_id}`,
    );
  } finally {
    await f.cleanup();
  }
});

test("the staged cap keeps the newest 100 entries when the older head settles last", async () => {
  const f = await fixture();
  try {
    f.store.set(f.atoms.pendingNewPostsAtom, range(1, 95));
    const older = f.start();
    const newer = f.start();
    f.releases[1](page(range(116, 135)));
    await newer;
    f.releases[0](page(range(96, 115)));
    await older;
    const expected = range(36, 135).map(feedItemKey);
    expect(f.store.get(f.atoms.pendingNewPostsAtom).map(feedItemKey)).toEqual(
      expected,
    );
    f.store.set(f.atoms.applyNewPostsAtom);
    expect(f.store.get(f.atoms.timelinePostsAtom).map(feedItemKey)).toEqual([
      ...expected,
      feedItemKey(post(0)),
    ]);
    expect(f.store.get(f.atoms.newestSeenKeyAtom)).toBe(
      `${post(135).published} ${post(135).ap_id}`,
    );
  } finally {
    await f.cleanup();
  }
});
