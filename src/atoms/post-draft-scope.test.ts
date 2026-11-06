import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Actor } from "../types/index.ts";

function actor(name: string): Actor {
  return {
    ap_id: `https://draft.example.test/ap/users/${name}`,
    username: `${name}@draft.example.test`,
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

type Harness = {
  values: Map<string, string>;
  auth: typeof import("./auth.ts");
  timeline: typeof import("./timeline.ts");
  plugin: typeof import("../lib/plugin.ts");
  requests: string[];
  mount: (name: string) => ReturnType<typeof createStore>;
  denyWrites: (denied: boolean) => void;
  origin: (origin: string) => void;
};

async function withDrafts(run: (h: Harness) => void | Promise<void>) {
  const descriptors = new Map(
    ["localStorage", "location", "navigator", "fetch"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const values = new Map<string, string>();
  const unsubs: Array<() => void> = [];
  let denied = false;
  let plugin: Harness["plugin"] | undefined;
  const requests: string[] = [];
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (denied) throw new Error("Storage write denied");
          values.set(key, value);
        },
      },
    });
    const origin = (value: string) =>
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: new URL(value),
      });
    origin("https://draft.example.test/");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "en-US" },
    });
    plugin = await import("../lib/plugin.ts");
    plugin.clearYurucommuFrontendPlugin();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response("Unexpected fixture request", { status: 500 });
      },
    });
    const auth = await import("./auth.ts");
    const timeline = await import("./timeline.ts");
    const mount = (name: string) => {
      const store = createStore();
      store.set(auth.actorAtom, actor(name));
      for (const field of [
        timeline.postContentAtom,
        timeline.postSummaryAtom,
        timeline.postVisibilityAtom,
      ])
        unsubs.push(store.sub(field, () => {}));
      return store;
    };
    await run({
      plugin,
      requests,
      values,
      auth,
      timeline,
      mount,
      denyWrites: (value) => {
        denied = value;
      },
      origin,
    });
  } finally {
    unsubs.forEach((stop) => stop());
    plugin?.clearYurucommuFrontendPlugin();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const draftOf = (
  store: ReturnType<typeof createStore>,
  timeline: Harness["timeline"],
) => ({
  content: store.get(timeline.postContentAtom),
  summary: store.get(timeline.postSummaryAtom),
  visibility: store.get(timeline.postVisibilityAtom),
});
const empty = { content: "", summary: "", visibility: "public" as const };
const aliceDraft = {
  content: "Alice private unsent text",
  summary: "Alice warning",
  visibility: "followers" as const,
};
function writeDraft(
  store: ReturnType<typeof createStore>,
  timeline: Harness["timeline"],
  draft = aliceDraft,
) {
  store.set(timeline.postContentAtom, draft.content);
  store.set(timeline.postSummaryAtom, draft.summary);
  store.set(timeline.postVisibilityAtom, draft.visibility);
}

test("the product composer does not hydrate another actor's text, warning or audience after reload", async () => {
  await withDrafts(({ values, timeline, mount }) => {
    const a = mount("alice");
    writeDraft(a, timeline);
    const originalBytes = [...values];
    // Fresh stores exercise the actual product's reload boundary. Only the
    // browser storage port and observed identities are synthetic.
    const b = mount("bob");
    expect(b.get(timeline.postContentAtom)).toBe("");
    expect(b.get(timeline.postSummaryAtom)).toBe("");
    expect(b.get(timeline.postVisibilityAtom)).toBe("public");
    expect([...values]).toEqual(originalBytes);
    expect(draftOf(mount("alice"), timeline)).toEqual(aliceDraft);
  });
});

test("actor, instance and hosted-user switches immediately select only their own draft", async () => {
  await withDrafts(({ values, auth, timeline, mount }) => {
    const store = mount("alice");
    writeDraft(store, timeline);
    const originalBytes = [...values];
    store.set(auth.actorAtom, actor("bob"));
    expect(draftOf(store, timeline)).toEqual(empty);
    store.set(auth.actorAtom, actor("alice"));
    expect(draftOf(store, timeline)).toEqual(aliceDraft);
    store.set(auth.selectedInstanceIdAtom, "another-instance");
    expect(draftOf(store, timeline)).toEqual(empty);
    store.set(auth.selectedInstanceIdAtom, null);
    expect(draftOf(store, timeline)).toEqual(aliceDraft);
    store.set(auth.hostedUserAtom, {
      id: "another-user",
      username: "other@example.test",
    });
    expect(draftOf(store, timeline)).toEqual(empty);
    store.set(auth.hostedUserAtom, null);
    expect(draftOf(store, timeline)).toEqual(aliceDraft);
    store.set(auth.actorAtom, { ...actor("alice"), name: "Updated profile" });
    expect(draftOf(store, timeline)).toEqual(aliceDraft);
    expect([...values]).toEqual(originalBytes);
  });
});

test("another API origin cannot hydrate the same actor's saved draft", async () => {
  await withDrafts(({ values, timeline, mount, origin }) => {
    writeDraft(mount("alice"), timeline);
    const originalBytes = [...values];
    origin("https://another.example.test/");
    expect(draftOf(mount("alice"), timeline)).toEqual(empty);
    expect([...values]).toEqual(originalBytes);
    origin("https://draft.example.test/");
    expect(draftOf(mount("alice"), timeline)).toEqual(aliceDraft);
  });
});

test("legacy bytes never auto-hydrate, move or disappear and can only be explicitly exported", async () => {
  await withDrafts(({ values, timeline, mount }) => {
    const legacy = {
      "compose.draft.content": JSON.stringify("unassigned secret"),
      "compose.draft.summary": JSON.stringify("unassigned warning"),
      "compose.draft.visibility": JSON.stringify("direct"),
    };
    Object.entries(legacy).forEach(([key, value]) => values.set(key, value));
    const store = mount("bob");
    expect(draftOf(store, timeline)).toEqual(empty);
    expect(store.get(timeline.legacyPostDraftAvailableAtom)).toBe(true);
    expect([...values]).toEqual(Object.entries(legacy));
    const backup = store.set(timeline.exportLegacyPostDraftAtom);
    expect(JSON.parse(backup!).fields).toEqual(legacy);
    expect([...values]).toEqual(Object.entries(legacy));
    values.set("compose.draft.content", "damaged-json");
    const damaged = store.set(timeline.exportLegacyPostDraftAtom);
    expect(JSON.parse(damaged!).fields["compose.draft.content"]).toBe(
      "damaged-json",
    );
    expect(draftOf(store, timeline)).toEqual(empty);
  });
});

test("unsaved memory and storage failure stay with their original actor", async () => {
  await withDrafts(({ auth, timeline, mount, denyWrites }) => {
    const store = mount("alice");
    denyWrites(true);
    writeDraft(store, timeline);
    expect(store.get(timeline.postDraftWriteFailedAtom)).toBe(true);
    denyWrites(false);
    store.set(auth.actorAtom, actor("bob"));
    expect(draftOf(store, timeline)).toEqual(empty);
    expect(store.get(timeline.postDraftWriteFailedAtom)).toBe(false);
    store.set(auth.actorAtom, actor("alice"));
    expect(draftOf(store, timeline)).toEqual(aliceDraft);
    expect(store.get(timeline.postDraftWriteFailedAtom)).toBe(true);
  });
});

test("an unbound composer cannot save, clear or export another actor's draft", async () => {
  await withDrafts(({ values, auth, timeline, mount }) => {
    const store = mount("alice");
    writeDraft(store, timeline);
    const originalBytes = [...values];
    store.set(auth.actorAtom, null);
    store.set(timeline.postContentAtom, "unbound text");
    expect(draftOf(store, timeline)).toEqual(empty);
    expect(store.get(timeline.postDraftWriteFailedAtom)).toBe(true);
    expect(store.set(timeline.exportLegacyPostDraftAtom)).toBeNull();
    expect([...values]).toEqual(originalBytes);
  });
});

test("changing the API origin without a new observed owner fails closed before POST", async () => {
  await withDrafts(async ({ values, timeline, mount, plugin, requests }) => {
    const store = mount("alice");
    writeDraft(store, timeline);
    const originalBytes = [...values];
    plugin.registerYurucommuFrontendPlugin({
      apiVersion: 1,
      name: "synthetic-origin-change",
      createApiTransport: () => ({
        credentials: "include",
        resolveUrl: (path) => "https://another.example.test" + path,
        getAuthHeaders: () => ({}),
      }),
    });
    expect(await store.set(timeline.createPostAtom, aliceDraft)).toBe(false);
    expect(requests).toEqual([]);
    expect(store.get(timeline.postSubmitErrorAtom)).toContain(
      "connection changed",
    );
    expect([...values]).toEqual(originalBytes);
  });
});
