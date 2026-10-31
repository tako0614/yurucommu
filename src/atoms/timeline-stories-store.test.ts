import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Actor } from "../types/index.ts";

function actor(name: string): Actor {
  return {
    ap_id: `https://example.test/ap/users/${name}`,
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
  const requests: Array<(response: Response) => void> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "https://example.test",
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname !== "/api/stories" || method !== "GET") {
        throw new Error(
          `Unexpected synthetic request: ${method} ${url.pathname}`,
        );
      }
      return new Promise<Response>((resolve) => requests.push(resolve));
    },
  });
  let plugin: typeof import("../lib/plugin.ts");
  let timeline: typeof import("./timeline.ts");
  try {
    plugin = await import("../lib/plugin.ts");
    plugin.clearYurucommuFrontendPlugin();
    timeline = await import("./timeline.ts");
  } catch (error) {
    restoreGlobals();
    throw error;
  }
  const work: Promise<unknown>[] = [];
  return {
    timeline,
    requests,
    load(store: ReturnType<typeof createStore>) {
      const promise = store.set(timeline.loadStoriesAtom);
      work.push(promise);
      return promise;
    },
    async waitForRequests(count: number) {
      for (let i = 0; i < 30 && requests.length < count; i++) {
        await Promise.resolve();
      }
      expect(requests).toHaveLength(count);
    },
    async cleanup() {
      try {
        for (const resolve of requests) {
          resolve(Response.json({ actor_stories: [] }));
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

test("concurrent story loads in separate stores settle independently", async () => {
  const h = await fixture();
  try {
    const firstStore = createStore();
    const secondStore = createStore();
    const first = h.load(firstStore);
    const second = h.load(secondStore);
    await h.waitForRequests(2);

    const firstStory = {
      actor: actor("first"),
      stories: [],
      has_unviewed: false,
    };
    const secondStory = {
      actor: actor("second"),
      stories: [],
      has_unviewed: false,
    };
    h.requests[0]!(Response.json({ actor_stories: [firstStory] }));
    await first;
    h.requests[1]!(Response.json({ actor_stories: [secondStory] }));
    await second;

    expect(firstStore.get(h.timeline.actorStoriesAtom)).toEqual([firstStory]);
    expect(firstStore.get(h.timeline.storiesLoadingAtom)).toBe(false);
    expect(secondStore.get(h.timeline.actorStoriesAtom)).toEqual([secondStory]);
    expect(secondStore.get(h.timeline.storiesLoadingAtom)).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test("an older story response cannot replace a newer response in one store", async () => {
  const h = await fixture();
  try {
    const store = createStore();
    const older = h.load(store);
    const newer = h.load(store);
    await h.waitForRequests(2);
    const oldStory = { actor: actor("old"), stories: [], has_unviewed: false };
    const newStory = { actor: actor("new"), stories: [], has_unviewed: false };
    h.requests[1]!(Response.json({ actor_stories: [newStory] }));
    await newer;
    h.requests[0]!(Response.json({ actor_stories: [oldStory] }));
    await older;

    expect(store.get(h.timeline.actorStoriesAtom)).toEqual([newStory]);
    expect(store.get(h.timeline.storiesLoadingAtom)).toBe(false);
    expect(store.get(h.timeline.storiesErrorAtom)).toBeNull();
  } finally {
    await h.cleanup();
  }
});

test("an older response cannot end loading while the newer load is pending", async () => {
  const h = await fixture();
  try {
    const store = createStore();
    const older = h.load(store);
    const newer = h.load(store);
    await h.waitForRequests(2);
    const oldStory = { actor: actor("old"), stories: [], has_unviewed: false };
    const newStory = { actor: actor("new"), stories: [], has_unviewed: false };
    h.requests[0]!(Response.json({ actor_stories: [oldStory] }));
    await older;
    expect(store.get(h.timeline.actorStoriesAtom)).toEqual([]);
    expect(store.get(h.timeline.storiesLoadingAtom)).toBe(true);

    h.requests[1]!(Response.json({ actor_stories: [newStory] }));
    await newer;
    expect(store.get(h.timeline.actorStoriesAtom)).toEqual([newStory]);
    expect(store.get(h.timeline.storiesLoadingAtom)).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test("an older story failure cannot hide a newer successful response", async () => {
  const h = await fixture();
  try {
    const store = createStore();
    const older = h.load(store);
    const newer = h.load(store);
    await h.waitForRequests(2);
    const story = { actor: actor("new"), stories: [], has_unviewed: false };
    h.requests[1]!(Response.json({ actor_stories: [story] }));
    await newer;
    h.requests[0]!(new Response("unavailable", { status: 503 }));
    await older;

    expect(store.get(h.timeline.actorStoriesAtom)).toEqual([story]);
    expect(store.get(h.timeline.storiesLoadingAtom)).toBe(false);
    expect(store.get(h.timeline.storiesErrorAtom)).toBeNull();
  } finally {
    await h.cleanup();
  }
});
