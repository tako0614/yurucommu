import { afterAll, afterEach, expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import type { Actor } from "../types/index.ts";
import {
  clearYurucommuFrontendPlugin,
  setYurucommuFrontendPlugins,
  type AuthStrategy,
} from "../lib/plugin.ts";

const originals = new Map(
  ["localStorage", "sessionStorage", "navigator"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
};
for (const key of ["localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: storage,
  });
}
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { language: "en-US" },
});
const originalFetch = globalThis.fetch;
const {
  actorAtom,
  authErrorAtom,
  checkAuthAtom,
  completeSetupAtom,
  hostedUserAtom,
  logoutAtom,
  logoutBusyAtom,
  logoutErrorAtom,
  rebuildInstanceAtom,
  selectInstanceAtom,
  selectedInstanceIdAtom,
} = await import("./auth.ts");
const { inhabitedScopeAtom, PERSONAL_SCOPE } = await import("./scope.ts");

const owner: Actor = {
  ap_id: "https://personal.example.test/ap/actors/owner",
  username: "owner",
  preferred_username: "owner",
  name: "Owner",
  summary: null,
  icon_url: null,
  header_url: null,
  follower_count: 0,
  following_count: 0,
  post_count: 0,
  role: "owner",
  created_at: "2026-10-03T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function freshStore() {
  const store = createStore();
  store.set(actorAtom, owner);
  store.set(inhabitedScopeAtom, {
    kind: "community",
    ap_id: "https://personal.example.test/ap/communities/a",
    name: "a",
    display_name: "A",
    member_role: "member",
  });
  return store;
}

function installFetch(
  logout: () => Promise<Response>,
  auth: () => Promise<Response>,
) {
  const counts = { logout: 0, auth: 0 };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url === "/api/auth/logout") {
      counts.logout += 1;
      return logout();
    }
    if (url === "/api/auth/me") {
      counts.auth += 1;
      return auth();
    }
    if (url.endsWith("/api/notifications/pushers/config")) {
      return Response.json({ enabled: false });
    }
    throw new Error(`Unexpected test request: ${url}`);
  }) as unknown as typeof fetch;
  return counts;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearYurucommuFrontendPlugin();
  values.clear();
});
afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("failed logout retains only an observed current principal and permits explicit retry", async () => {
  const store = freshStore();
  let first = true;
  let active = true;
  const counts = installFetch(
    async () => {
      if (first) {
        first = false;
        return new Response(null, { status: 503 });
      }
      active = false;
      return Response.json({ success: true });
    },
    async () =>
      active
        ? Response.json({ actor: owner })
        : new Response(null, { status: 401 }),
  );

  expect(await store.set(logoutAtom)).toBe(false);
  expect(store.get(actorAtom)).toBe(owner);
  expect(store.get(logoutErrorAtom)).toBeString();
  expect(store.get(inhabitedScopeAtom)).toEqual(PERSONAL_SCOPE);
  expect(counts).toEqual({ logout: 1, auth: 1 });
  expect(values.get("yurucommu:oidc-auto-start-attempted")).toBe("1");

  expect(await store.set(logoutAtom)).toBe(true);
  expect(store.get(actorAtom)).toBeNull();
  expect(store.get(logoutErrorAtom)).toBeNull();
  expect(counts).toEqual({ logout: 2, auth: 2 });
});

test("a lost acknowledgement is reconciled read-only without repeating logout", async () => {
  const store = freshStore();
  const counts = installFetch(
    async () => {
      throw new TypeError("ACK lost");
    },
    async () => new Response(null, { status: 401 }),
  );
  expect(await store.set(logoutAtom)).toBe(true);
  expect(store.get(actorAtom)).toBeNull();
  expect(store.get(inhabitedScopeAtom)).toEqual(PERSONAL_SCOPE);
  expect(counts).toEqual({ logout: 1, auth: 1 });
});

test("a successful POST does not override an authenticated follow-up observation", async () => {
  const store = freshStore();
  const counts = installFetch(
    async () => Response.json({ success: true }),
    async () => Response.json({ actor: owner }),
  );
  expect(await store.set(logoutAtom)).toBe(false);
  expect(store.get(actorAtom)).toBe(owner);
  expect(store.get(logoutErrorAtom)).toBeString();
  expect(counts).toEqual({ logout: 1, auth: 1 });
});

test("a failed or malformed auth observation hides stale identity without success", async () => {
  for (const status of [503, 200]) {
    const store = freshStore();
    store.set(hostedUserAtom, { id: "stale-hosted" });
    store.set(selectedInstanceIdAtom, "stale-instance");
    const counts = installFetch(
      async () => Response.json({ success: true }),
      async () => Response.json({}, { status }),
    );
    expect(await store.set(logoutAtom)).toBe(false);
    expect(store.get(actorAtom)).toBeNull();
    expect(store.get(hostedUserAtom)).toBeNull();
    expect(store.get(selectedInstanceIdAtom)).toBeNull();
    expect(store.get(authErrorAtom)).toBeString();
    expect(store.get(inhabitedScopeAtom)).toEqual(PERSONAL_SCOPE);
    expect(counts).toEqual({ logout: 1, auth: 1 });
  }
});

test("the same store cannot send two overlapping logout operations", async () => {
  const store = freshStore();
  const held = deferred<Response>();
  const entered = deferred<void>();
  const counts = installFetch(
    async () => {
      entered.resolve();
      return held.promise;
    },
    async () => new Response(null, { status: 401 }),
  );
  const first = store.set(logoutAtom);
  await entered.promise;
  expect(store.get(logoutBusyAtom)).toBe(true);
  expect(await store.set(logoutAtom)).toBe(false);
  expect(counts.logout).toBe(1);
  held.resolve(Response.json({ success: true }));
  expect(await first).toBe(true);
  expect(store.get(logoutBusyAtom)).toBe(false);
  expect(counts).toEqual({ logout: 1, auth: 1 });
});

test("a pre-logout auth check cannot restore the actor after logout", async () => {
  const store = freshStore();
  const old = deferred<Response>();
  const entered = deferred<void>();
  let checks = 0;
  installFetch(
    async () => Response.json({ success: true }),
    async () => {
      checks += 1;
      if (checks === 1) {
        entered.resolve();
        return old.promise;
      }
      return new Response(null, { status: 401 });
    },
  );
  const oldCheck = store.set(checkAuthAtom);
  await entered.promise;
  expect(await store.set(logoutAtom)).toBe(true);
  old.resolve(Response.json({ actor: owner }));
  await oldCheck;
  expect(store.get(actorAtom)).toBeNull();
  expect(store.get(authErrorAtom)).toBeNull();
});

test("a superseded logout cannot clear a newer actor or its scope", async () => {
  const store = freshStore();
  const held = deferred<Response>();
  const entered = deferred<void>();
  const counts = installFetch(
    async () => {
      entered.resolve();
      return held.promise;
    },
    async () => new Response(null, { status: 401 }),
  );
  const operation = store.set(logoutAtom);
  await entered.promise;
  const replacement = {
    ...owner,
    ap_id: "https://personal.example.test/ap/actors/new",
  };
  store.set(actorAtom, replacement);
  const newScope = store.get(inhabitedScopeAtom);
  held.resolve(Response.json({ success: true }));
  expect(await operation).toBe(false);
  expect(store.get(actorAtom)).toBe(replacement);
  expect(store.get(inhabitedScopeAtom)).toBe(newScope);
  expect(store.get(logoutErrorAtom)).toBeNull();
  expect(counts.auth).toBe(0);
});

test("hosted logout trusts fulfilled plugin contract but does not infer anonymous after rejection", async () => {
  for (const rejects of [false, true]) {
    const store = freshStore();
    let checks = 0;
    const strategy: AuthStrategy = {
      mode: "hosted",
      async checkAuth() {
        checks += 1;
        throw new Error("not evidence of signed-out");
      },
      async login() {
        return { success: true };
      },
      async logout() {
        if (rejects) throw new Error("unconfirmed hosted logout");
      },
      extractTokenFromUrl() {
        return false;
      },
    };
    setYurucommuFrontendPlugins([
      {
        apiVersion: 1,
        name: "logout-test",
        createAuthStrategy: () => strategy,
      },
    ]);
    globalThis.fetch = (async () =>
      Response.json({ enabled: false })) as unknown as typeof fetch;
    expect(await store.set(logoutAtom)).toBe(!rejects);
    expect(store.get(actorAtom)).toBeNull();
    expect(checks).toBe(0);
    if (rejects) expect(store.get(authErrorAtom)).toBeString();
    clearYurucommuFrontendPlugin();
  }
});

test("hosted setup and instance work started before logout cannot refresh stale identity", async () => {
  for (const action of ["setup", "select", "rebuild"] as const) {
    const store = freshStore();
    const held = deferred<boolean>();
    const entered = deferred<void>();
    let checks = 0;
    const pending = async () => {
      entered.resolve();
      return held.promise;
    };
    const strategy: AuthStrategy = {
      mode: "hosted",
      async checkAuth() {
        checks += 1;
        throw new Error("stale auth refresh");
      },
      async login() {
        return { success: true };
      },
      async logout() {},
      extractTokenFromUrl() {
        return false;
      },
      completeSetup: pending,
      async selectInstance() {
        await pending();
      },
      rebuildInstance: pending,
    };
    setYurucommuFrontendPlugins([
      {
        apiVersion: 1,
        name: "hosted-deferred",
        createAuthStrategy: () => strategy,
      },
    ]);
    globalThis.fetch = (async () =>
      Response.json({ enabled: false })) as unknown as typeof fetch;
    const operation =
      action === "setup"
        ? store.set(completeSetupAtom, "owner")
        : action === "select"
          ? store.set(selectInstanceAtom, "old-instance")
          : store.set(rebuildInstanceAtom, "old-instance");
    await entered.promise;
    expect(await store.set(logoutAtom)).toBe(true);
    held.resolve(true);
    const result = await operation;
    if (action !== "select") expect(result).toBe(false);
    expect(checks).toBe(0);
    expect(store.get(actorAtom)).toBeNull();
    expect(store.get(authErrorAtom)).toBeNull();
    clearYurucommuFrontendPlugin();
  }
});
