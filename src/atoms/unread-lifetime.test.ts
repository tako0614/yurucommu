import { afterAll, afterEach, expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Actor } from "../types/index.ts";
import {
  clearYurucommuFrontendPlugin,
  setYurucommuFrontendPlugins,
} from "../lib/plugin.ts";

const originalFetch = globalThis.fetch;
const originals = new Map(
  ["localStorage", "navigator"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem() {}, removeItem() {} },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { language: "en-US" },
});
const { actorAtom, selectedInstanceIdAtom, logoutBusyAtom, loginAtom } =
  await import("./auth.ts");
const { notificationUnreadAtom, refreshNotificationUnreadAtom } =
  await import("./notifications.ts");
const { dmUnreadCountAtom, refreshDmUnreadAtom } =
  await import("./dm-unread.ts");

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearYurucommuFrontendPlugin();
});
afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const owner = {
  ap_id: "https://personal.example.test/ap/actors/owner",
  role: "owner",
} as Actor;
const persona = {
  ap_id: "https://personal.example.test/ap/actors/work",
  role: "member",
  owner_actor_ap_id: owner.ap_id,
} as unknown as Actor;
const channels = [
  {
    name: "notification",
    value: notificationUnreadAtom,
    refresh: refreshNotificationUnreadAtom,
    path: "/api/notifications/unread/count",
    body: (count: number) => ({ count }),
  },
  {
    name: "DM",
    value: dmUnreadCountAtom,
    refresh: refreshDmUnreadAtom,
    path: "/api/dm/unread/count",
    body: (count: number) => ({ total: count }),
  },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function freshStore() {
  const store = createStore();
  store.set(actorAtom, owner);
  return store;
}
for (const channel of channels) {
  test(`${channel.name}: old poll cannot replace post-read refresh`, async () => {
    const store = freshStore();
    const old = deferred<Response>();
    let reads = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toBe(channel.path);
      return ++reads === 1 ? old.promise : Response.json(channel.body(0));
    }) as unknown as typeof fetch;
    const poll = store.set(channel.refresh);
    await store.set(channel.refresh);
    expect(store.get(channel.value)).toBe(0);
    old.resolve(Response.json(channel.body(7)));
    await poll;
    expect(store.get(channel.value)).toBe(0);
    expect(reads).toBe(2);
  });

  test(`${channel.name}: newer failure keeps last good count and retires old poll`, async () => {
    const store = freshStore();
    const old = deferred<Response>();
    let reads = 0;
    globalThis.fetch = (async () => {
      reads++;
      if (reads === 1) return Response.json(channel.body(3));
      if (reads === 2) return old.promise;
      // Fetch rejection remains a failure for both currently published SDK
      // reads; DM4.1.11 does not itself reject every non-2xx response.
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await store.set(channel.refresh);
    const poll = store.set(channel.refresh);
    await store.set(channel.refresh);
    expect(store.get(channel.value)).toBe(3);
    old.resolve(Response.json(channel.body(9)));
    await poll;
    expect(store.get(channel.value)).toBe(3);
  });

  test(`${channel.name}: persona change hides previous count before its next response`, async () => {
    const store = freshStore();
    globalThis.fetch = (async () =>
      Response.json(channel.body(5))) as unknown as typeof fetch;
    await store.set(channel.refresh);
    expect(store.get(channel.value)).toBe(5);
    store.set(actorAtom, persona);
    expect(store.get(channel.value)).toBe(0);
    await store.set(channel.refresh);
    expect(store.get(channel.value)).toBe(5);
  });

  test(`${channel.name}: late count cannot cross instance or logout retirement`, async () => {
    const store = freshStore();
    const old = deferred<Response>();
    globalThis.fetch = (async () => old.promise) as unknown as typeof fetch;
    const poll = store.set(channel.refresh);
    store.set(selectedInstanceIdAtom, "new-instance");
    store.set(logoutBusyAtom, true);
    old.resolve(Response.json(channel.body(8)));
    await poll;
    expect(store.get(channel.value)).toBe(0);
    store.set(logoutBusyAtom, false);
    expect(store.get(channel.value)).toBe(0);
  });

  test(`${channel.name}: same owner login retires the old epoch and confirmed count`, async () => {
    const store = freshStore();
    const old = deferred<Response>();
    let reads = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input);
      if (path === "/api/auth/login") return Response.json({ success: true });
      if (path === "/api/auth/me") return Response.json({ actor: owner });
      expect(path).toBe(channel.path);
      return ++reads === 1 ? Response.json(channel.body(4)) : old.promise;
    }) as unknown as typeof fetch;
    await store.set(channel.refresh);
    expect(store.get(channel.value)).toBe(4);
    const poll = store.set(channel.refresh);
    await store.set(loginAtom, "fixture-password");
    expect(store.get(actorAtom)?.ap_id).toBe(owner.ap_id);
    expect(store.get(channel.value)).toBe(0);
    old.resolve(Response.json(channel.body(8)));
    await poll;
    expect(store.get(channel.value)).toBe(0);
  });

  test(`${channel.name}: store ordering is independent and signed-out reads do not start`, async () => {
    const a = freshStore();
    const b = freshStore();
    const old = deferred<Response>();
    let reads = 0;
    globalThis.fetch = (async () =>
      ++reads === 1
        ? old.promise
        : Response.json(channel.body(2))) as unknown as typeof fetch;
    const pending = a.set(channel.refresh);
    await b.set(channel.refresh);
    old.resolve(Response.json(channel.body(6)));
    await pending;
    expect(a.get(channel.value)).toBe(6);
    expect(b.get(channel.value)).toBe(2);
    b.set(actorAtom, null);
    await b.set(channel.refresh);
    expect(b.get(channel.value)).toBe(0);
    expect(reads).toBe(2);
  });

  test(`${channel.name}: replaced transport rejects old count and can refresh the new scope`, async () => {
    const store = freshStore();
    const old = deferred<Response>();
    globalThis.fetch = (async () => old.promise) as unknown as typeof fetch;
    const pending = store.set(channel.refresh);
    setYurucommuFrontendPlugins([
      {
        apiVersion: 1,
        name: "fixture-transport",
        createApiTransport: () => ({
          credentials: "include",
          resolveUrl: (path) => "https://new-instance.example.test" + path,
          getAuthHeaders: () => ({}),
        }),
      },
    ]);
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toBe(
        "https://new-instance.example.test" + channel.path,
      );
      return Response.json(channel.body(2));
    }) as unknown as typeof fetch;
    await store.set(channel.refresh);
    old.resolve(Response.json(channel.body(7)));
    await pending;
    expect(store.get(channel.value)).toBe(2);
  });
}
