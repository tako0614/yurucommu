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

test("old read stays retired after hosted instance A to B to A", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  let selected = "instance-a";
  const strategy = {
    mode: "hosted" as const,
    async checkAuth() {
      return {
        actor: actor(),
        hostedUser: null,
        needsSetup: false,
        instancePending: false,
        instanceMissing: false,
        instanceBlocked: false,
        instanceHealth: null,
        instances: [],
        selectedInstanceId: selected,
      };
    },
    async login() {
      return { success: true };
    },
    async logout() {},
    extractTokenFromUrl() {
      return false;
    },
    async selectInstance(id: string) {
      selected = id;
    },
  };
  h.plugin.setYurucommuFrontendPlugins([
    {
      apiVersion: 1,
      name: "synthetic-hosted-scope",
      createAuthStrategy: () => strategy,
    },
  ]);
  try {
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const old = h.store.set(h.timeline.loadTimelineAtom);
    work.push(old);
    const request = await h.waitFor(1);
    await h.store.set(h.auth.selectInstanceAtom, "instance-b");
    expect(h.store.get(h.auth.selectedInstanceIdAtom)).toBe("instance-b");
    await h.store.set(h.auth.selectInstanceAtom, "instance-a");
    expect(h.store.get(h.auth.selectedInstanceIdAtom)).toBe("instance-a");
    const fresh = post("new-after-return");
    h.store.set(h.timeline.timelinePostsAtom, [fresh]);
    request.pending.resolve(page([post("stale-before-switch")]));
    await old;
    expect(h.store.get(h.timeline.timelinePostsAtom)).toEqual([fresh]);
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("old mutation stays retired after an instance A to B to A cycle", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("old-instance-mutation", 10, false);
  try {
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const older = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(older);
    const olderRequest = await h.waitFor(1);
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-b");
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const newer = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    work.push(newer);
    const newerRequest = await h.waitFor(2);
    newerRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    await newer;
    olderRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    expect(await older).toBe(false);
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    expect(h.activeMutations()).toBe(0);
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("same instance selection and a different store do not retire a read", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  try {
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const read = h.store.set(h.timeline.loadTimelineAtom);
    work.push(read);
    const request = await h.waitFor(1);
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const otherStore = createStore();
    otherStore.set(h.auth.selectedInstanceIdAtom, "instance-a");
    otherStore.set(h.auth.selectedInstanceIdAtom, "instance-b");
    otherStore.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const latest = post("same-instance-read");
    request.pending.resolve(page([latest]));
    await read;
    expect(h.store.get(h.timeline.timelinePostsAtom)).toEqual([latest]);
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("an old instance ACK cannot mark a new read after A to B to A", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("new-window", 10, true);
  try {
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const older = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(older);
    const olderRequest = await h.waitFor(1);
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-b");
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const newerRead = h.store.set(h.timeline.loadTimelineAtom);
    work.push(newerRead);
    const readRequest = await h.waitFor(2);
    olderRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    expect(await older).toBe(false);
    readRequest.pending.resolve(page([target]));
    await newerRead;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    expect(h.activeMutations()).toBe(0);
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("a direct ACK with a retired marker is rejected", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("retired-direct-ack", 10, true);
  try {
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const mutation = h.store.set(h.timeline.beginTimelineBookmarkMutationAtom, {
      actorApId: actor().ap_id,
      apId: target.ap_id,
      bookmarked: false,
    });
    expect(mutation).not.toBeNull();
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-b");
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const read = h.store.set(h.timeline.loadTimelineAtom);
    work.push(read);
    const request = await h.waitFor(1);
    expect(h.store.set(h.reads.acknowledgeBookmarkReadAtom, mutation!)).toBe(
      false,
    );
    request.pending.resolve(page([target]));
    await read;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    h.store.set(h.timeline.timelinePostsAtom, []);
    const currentRead = h.store.set(h.timeline.loadTimelineAtom);
    work.push(currentRead);
    const currentRequest = await h.waitFor(2);
    const currentMutation = h.store.set(
      h.timeline.beginTimelineBookmarkMutationAtom,
      {
        actorApId: actor().ap_id,
        apId: target.ap_id,
        bookmarked: false,
      },
    );
    expect(currentMutation).not.toBeNull();
    expect(
      h.store.set(h.reads.acknowledgeBookmarkReadAtom, currentMutation!),
    ).toBe(true);
    currentRequest.pending.resolve(page([target]));
    await currentRead;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(
      false,
    );
    h.store.set(h.timeline.settleTimelineBookmarkMutationAtom, {
      mutation: mutation!,
      success: false,
    });
    h.store.set(h.timeline.settleTimelineBookmarkMutationAtom, {
      mutation: currentMutation!,
      success: false,
    });
    expect(h.activeMutations()).toBe(0);
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("same-identity auth refresh does not retire a read", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const strategy = {
    mode: "hosted" as const,
    async checkAuth() {
      return {
        actor: actor(),
        hostedUser: null,
        needsSetup: false,
        instancePending: false,
        instanceMissing: false,
        instanceBlocked: false,
        instanceHealth: null,
        instances: [],
        selectedInstanceId: "instance-a",
      };
    },
    async login() {
      return { success: true };
    },
    async logout() {},
    extractTokenFromUrl() {
      return false;
    },
  };
  h.plugin.setYurucommuFrontendPlugins([
    {
      apiVersion: 1,
      name: "synthetic-same-identity",
      createAuthStrategy: () => strategy,
    },
  ]);
  try {
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const read = h.store.set(h.timeline.loadTimelineAtom);
    work.push(read);
    const request = await h.waitFor(1);
    await h.store.set(h.auth.checkAuthAtom);
    const latest = post("same-identity-refresh");
    request.pending.resolve(page([latest]));
    await read;
    expect(h.store.get(h.timeline.timelinePostsAtom)).toEqual([latest]);
    expect(h.activeCount()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("bookmark actions do not dispatch while instance loading is reported", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const entered = deferred<void>();
  const release = deferred<void>();
  let selected = "instance-a";
  const strategy = {
    mode: "hosted" as const,
    async checkAuth() {
      return {
        actor: actor(),
        hostedUser: null,
        needsSetup: false,
        instancePending: false,
        instanceMissing: false,
        instanceBlocked: false,
        instanceHealth: null,
        instances: [],
        selectedInstanceId: selected,
      };
    },
    async login() {
      return { success: true };
    },
    async logout() {},
    extractTokenFromUrl() {
      return false;
    },
    async selectInstance(id: string) {
      selected = id;
      entered.resolve();
      await release.promise;
    },
  };
  h.plugin.setYurucommuFrontendPlugins([
    {
      apiVersion: 1,
      name: "synthetic-selection-pending",
      createAuthStrategy: () => strategy,
    },
  ]);
  try {
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const target = post("selection-pending", 10, false);
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const selection = h.store.set(h.auth.selectInstanceAtom, "instance-b");
    work.push(selection);
    await entered.promise;
    expect(h.store.get(h.auth.instancesLoadingAtom)).toBe(true);
    expect(h.store.get(h.auth.selectedInstanceIdAtom)).toBe("instance-a");
    const toggle = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    const saved = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(toggle, saved);
    const direct = h.store.set(h.timeline.beginTimelineBookmarkMutationAtom, {
      actorApId: actor().ap_id,
      apId: target.ap_id,
      bookmarked: true,
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(h.requests).toHaveLength(0);
    expect(direct).toBeNull();
    expect(await saved).toBe(false);
    await toggle;
    release.resolve();
    await selection;
    expect(h.store.get(h.auth.selectedInstanceIdAtom)).toBe("instance-b");
    const after = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    work.push(after);
    const request = await h.waitFor(1);
    request.pending.resolve(new Response(JSON.stringify({ success: true })));
    await after;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    expect(h.activeMutations()).toBe(0);
    expect(h.activeCount()).toBe(0);
  } finally {
    release.resolve();
    await h.cleanup(work);
  }
});

test("bookmark actions resume after a same-identity auth refresh", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const entered = deferred<void>();
  const release = deferred<void>();
  const strategy = {
    mode: "hosted" as const,
    async checkAuth() {
      entered.resolve();
      await release.promise;
      return {
        actor: actor(),
        hostedUser: null,
        needsSetup: false,
        instancePending: false,
        instanceMissing: false,
        instanceBlocked: false,
        instanceHealth: null,
        instances: [],
        selectedInstanceId: "instance-a",
      };
    },
    async login() {
      return { success: true };
    },
    async logout() {},
    extractTokenFromUrl() {
      return false;
    },
  };
  h.plugin.setYurucommuFrontendPlugins([
    {
      apiVersion: 1,
      name: "synthetic-auth-refresh",
      createAuthStrategy: () => strategy,
    },
  ]);
  try {
    h.store.set(h.auth.selectedInstanceIdAtom, "instance-a");
    const target = post("auth-refresh-pending", 10, false);
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const refresh = h.store.set(h.auth.checkAuthAtom);
    work.push(refresh);
    await entered.promise;
    await h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    expect(h.requests).toHaveLength(0);
    release.resolve();
    await refresh;
    expect(h.store.get(h.auth.instancesLoadingAtom)).toBe(false);
    const after = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    work.push(after);
    const request = await h.waitFor(1);
    request.pending.resolve(new Response(JSON.stringify({ success: true })));
    await after;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    expect(h.activeMutations()).toBe(0);
    expect(h.activeCount()).toBe(0);
  } finally {
    release.resolve();
    await h.cleanup(work);
  }
});

test("logout in progress blocks timeline bookmark sends", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("signout-pending", 10, false);
  try {
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    h.store.set(h.auth.logoutBusyAtom, true);
    work.push(h.store.set(h.timeline.toggleTimelineBookmarkAtom, target));
    work.push(h.store.set(h.timeline.unbookmarkTimelinePostAtom, target.ap_id));
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(h.requests).toHaveLength(0);
    expect(h.store.get(h.timeline.timelinePostsAtom)).toEqual([target]);
    expect(h.activeMutations()).toBe(0);
    await Promise.all(work);
  } finally {
    await h.cleanup(work);
  }
});

test("older timeline bookmark ACK cannot reverse a newer confirmed unbookmark", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("accepted-order", 10, false);
  try {
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const earlier = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    work.push(earlier);
    const postRequest = await h.waitFor(1);
    expect(postRequest.method).toBe("POST");
    const later = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(later);
    const deleteRequest = await h.waitFor(2);
    expect(deleteRequest.method).toBe("DELETE");
    deleteRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    expect(await later).toBe(true);
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(
      false,
    );
    postRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    await earlier;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(
      false,
    );
    expect(h.activeCount()).toBe(0);
    expect(h.activeMutations()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("older unbookmark ACK cannot reverse a newer optimistic bookmark and its failed rollback", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("pending-order", 10, false);
  try {
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const earlier = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(earlier);
    const deleteRequest = await h.waitFor(1);
    const later = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    work.push(later);
    const postRequest = await h.waitFor(2);
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    deleteRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    expect(await earlier).toBe(true);
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    postRequest.pending.reject(new Error("later bookmark unavailable"));
    await expect(later).rejects.toThrow();
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(
      false,
    );
    expect(h.activeCount()).toBe(0);
    expect(h.activeMutations()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("an older feed read retains the newer confirmed unbookmark", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("read-order", 10, false);
  try {
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const read = h.store.set(h.timeline.loadTimelineAtom);
    work.push(read);
    const oldRead = await h.waitFor(1);
    const earlier = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    work.push(earlier);
    const postRequest = await h.waitFor(2);
    const later = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(later);
    const deleteRequest = await h.waitFor(3);
    deleteRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    expect(await later).toBe(true);
    postRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    await earlier;
    oldRead.pending.resolve(page([{ ...target, bookmarked: true }]));
    await read;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(
      false,
    );
    expect(h.activeCount()).toBe(0);
    expect(h.activeMutations()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("older ACK protects an active read without hiding a pending newer bookmark", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("pending-read", 10, false);
  try {
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const read = h.store.set(h.timeline.loadTimelineAtom);
    work.push(read);
    const oldRead = await h.waitFor(1);
    const earlier = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(earlier);
    const deleteRequest = await h.waitFor(2);
    const later = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    work.push(later);
    const postRequest = await h.waitFor(3);
    deleteRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    expect(await earlier).toBe(true);
    oldRead.pending.resolve(page([{ ...target, bookmarked: false }]));
    await read;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    postRequest.pending.resolve(
      new Response(JSON.stringify({ success: true })),
    );
    await later;
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    expect(h.activeCount()).toBe(0);
    expect(h.activeMutations()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("duplicate optimistic toggle leaves no extra shared mutation ticket", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("duplicate", 10, false);
  try {
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const first = h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    work.push(first);
    const request = await h.waitFor(1);
    await h.store.set(h.timeline.toggleTimelineBookmarkAtom, target);
    expect(h.requests).toHaveLength(1);
    expect(h.activeMutations()).toBe(1);
    request.pending.resolve(new Response(JSON.stringify({ success: true })));
    await first;
    expect(h.activeCount()).toBe(0);
    expect(h.activeMutations()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

test("an old ACK cannot update the same actor after authentication generation changes", async () => {
  const h = await fixture();
  const work: Promise<unknown>[] = [];
  const target = post("old-epoch", 10, true);
  try {
    h.store.set(h.timeline.timelinePostsAtom, [target]);
    const earlier = h.store.set(
      h.timeline.unbookmarkTimelinePostAtom,
      target.ap_id,
    );
    work.push(earlier);
    const request = await h.waitFor(1);
    const login = h.store.set(h.auth.loginAtom, "synthetic");
    work.push(login);
    const loginRequest = await h.waitFor(2);
    request.pending.resolve(new Response(JSON.stringify({ success: true })));
    expect(await earlier).toBe(false);
    expect(h.store.get(h.timeline.timelinePostsAtom)[0]?.bookmarked).toBe(true);
    loginRequest.pending.resolve(new Response("unavailable", { status: 503 }));
    await login;
    expect(h.activeMutations()).toBe(0);
  } finally {
    await h.cleanup(work);
  }
});

for (const lane of ["unified", "following"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`${lane} old read cannot publish ${outcome} after a same-actor instance change`, async () => {
      const h = await fixture();
      const work: Promise<unknown>[] = [];
      const load =
        lane === "unified"
          ? h.timeline.loadTimelineAtom
          : h.timeline.loadFollowingTimelineAtom;
      const posts =
        lane === "unified"
          ? h.timeline.timelinePostsAtom
          : h.timeline.followingPostsAtom;
      const error =
        lane === "unified"
          ? h.timeline.timelineLoadErrorAtom
          : h.timeline.followingLoadErrorAtom;
      const fresh = post("new-instance");
      try {
        h.store.set(h.auth.selectedInstanceIdAtom, "old-instance");
        const old = h.store.set(load);
        work.push(old);
        const request = await h.waitFor(1);
        h.store.set(h.auth.selectedInstanceIdAtom, "new-instance");
        h.store.set(posts, [fresh]);
        if (outcome === "success")
          request.pending.resolve(page([post("old-instance")]));
        else request.pending.reject(new Error("old instance unavailable"));
        await old;
        expect(h.store.get(posts)).toEqual([fresh]);
        expect(h.store.get(error)).toBeNull();
        expect(h.activeCount()).toBe(0);
      } finally {
        await h.cleanup(work);
      }
    });
  }
}
