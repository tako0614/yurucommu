import { afterAll, afterEach, expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";

import {
  clearYurucommuFrontendPlugin,
  setYurucommuFrontendPlugins,
  type AuthCheckResult,
  type AuthStrategy,
} from "../lib/plugin.ts";
import type { Actor } from "../types/index.ts";

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const localValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key),
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { language: "en-US" },
});

const {
  actorAtom,
  authLoadingAtom,
  checkAuthAtom,
  hostedUserAtom,
  instancesLoadingAtom,
  isHostedDeployment,
  logoutAtom,
} = await import("./auth.ts");

const HOSTED_RESULT: AuthCheckResult = {
  actor: null,
  hostedUser: { id: "hosted-user" },
  needsSetup: false,
  instancePending: false,
  instanceMissing: false,
  instanceBlocked: false,
  instanceHealth: null,
  instances: [],
  selectedInstanceId: null,
};

function makeActor(apId: string): Actor {
  return {
    ap_id: apId,
    username: `${apId}@example.com`,
    preferred_username: apId,
    name: null,
    summary: null,
    icon_url: null,
    header_url: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  clearYurucommuFrontendPlugin();
});

afterAll(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("auth strategy is resolved after bootstrap plugins are installed", async () => {
  let checks = 0;
  const hostedStrategy: AuthStrategy = {
    mode: "hosted",
    async checkAuth() {
      checks += 1;
      return HOSTED_RESULT;
    },
    async login() {
      return { success: true };
    },
    async logout() {},
    extractTokenFromUrl() {
      return false;
    },
  };

  // auth.ts was imported before this registration. A module-level strategy
  // cache would keep using the default self-hosted fetch transport here.
  setYurucommuFrontendPlugins([
    {
      apiVersion: 1,
      name: "hosted-auth-test",
      createAuthStrategy: () => hostedStrategy,
    },
  ]);

  expect(isHostedDeployment()).toBe(true);
  const store = createStore();
  await store.set(checkAuthAtom);
  expect(checks).toBe(1);
  expect(store.get(hostedUserAtom)?.id).toBe("hosted-user");
});

test("a slower auth check cannot overwrite the newer generation", async () => {
  const first = deferred<AuthCheckResult>();
  const second = deferred<AuthCheckResult>();
  const oldActor = makeActor("old");
  const newActor = makeActor("new");
  let checks = 0;
  const hostedStrategy: AuthStrategy = {
    mode: "hosted",
    checkAuth() {
      checks += 1;
      return checks === 1 ? first.promise : second.promise;
    },
    async login() {
      return { success: true };
    },
    async logout() {},
    extractTokenFromUrl() {
      return false;
    },
  };

  setYurucommuFrontendPlugins([
    {
      apiVersion: 1,
      name: "hosted-auth-concurrency-test",
      createAuthStrategy: () => hostedStrategy,
    },
  ]);

  const store = createStore();
  const older = store.set(checkAuthAtom);
  const newer = store.set(checkAuthAtom);
  expect(checks).toBe(2);

  second.resolve({ ...HOSTED_RESULT, actor: newActor });
  await newer;
  expect(store.get(actorAtom)?.ap_id).toBe("new");

  first.resolve({ ...HOSTED_RESULT, actor: oldActor });
  await older;
  expect(store.get(actorAtom)?.ap_id).toBe("new");
});

test("auth-check generations remain isolated between Jotai stores", async () => {
  const first = deferred<AuthCheckResult>();
  const second = deferred<AuthCheckResult>();
  let checks = 0;
  const hostedStrategy: AuthStrategy = {
    mode: "hosted",
    checkAuth() {
      checks += 1;
      return checks === 1 ? first.promise : second.promise;
    },
    async login() {
      return { success: true };
    },
    async logout() {},
    extractTokenFromUrl() {
      return false;
    },
  };
  setYurucommuFrontendPlugins([
    {
      apiVersion: 1,
      name: "hosted-auth-store-isolation-test",
      createAuthStrategy: () => hostedStrategy,
    },
  ]);

  const firstStore = createStore();
  const secondStore = createStore();
  const firstCheck = firstStore.set(checkAuthAtom);
  const secondCheck = secondStore.set(checkAuthAtom);

  second.resolve({ ...HOSTED_RESULT, actor: makeActor("second-store") });
  await secondCheck;
  first.resolve({ ...HOSTED_RESULT, actor: makeActor("first-store") });
  await firstCheck;

  expect(firstStore.get(actorAtom)?.ap_id).toBe("first-store");
  expect(firstStore.get(authLoadingAtom)).toBe(false);
  expect(secondStore.get(actorAtom)?.ap_id).toBe("second-store");
  expect(secondStore.get(authLoadingAtom)).toBe(false);
});

test("logout invalidates an in-flight auth check and releases its loading state", async () => {
  const pending = deferred<AuthCheckResult>();
  const staleActor = makeActor("stale-after-logout");
  const hostedStrategy: AuthStrategy = {
    mode: "hosted",
    checkAuth: () => pending.promise,
    async login() {
      return { success: true };
    },
    async logout() {},
    extractTokenFromUrl() {
      return false;
    },
  };
  setYurucommuFrontendPlugins([
    {
      apiVersion: 1,
      name: "hosted-auth-logout-generation-test",
      createAuthStrategy: () => hostedStrategy,
    },
  ]);

  const store = createStore();
  const check = store.set(checkAuthAtom);
  expect(store.get(authLoadingAtom)).toBe(true);
  expect(store.get(instancesLoadingAtom)).toBe(true);

  await store.set(logoutAtom);
  expect(store.get(authLoadingAtom)).toBe(false);
  expect(store.get(instancesLoadingAtom)).toBe(false);

  pending.resolve({ ...HOSTED_RESULT, actor: staleActor });
  await check;
  expect(store.get(actorAtom)).toBeNull();
});

test("an auth refresh cannot start while logout owns the session fence", async () => {
  const logoutStarted = deferred<void>();
  const releaseLogout = deferred<void>();
  const pendingCheck = deferred<AuthCheckResult>();
  let checks = 0;
  const hostedStrategy: AuthStrategy = {
    mode: "hosted",
    checkAuth() {
      checks += 1;
      return pendingCheck.promise;
    },
    async login() {
      return { success: true };
    },
    async logout() {
      logoutStarted.resolve();
      await releaseLogout.promise;
    },
    extractTokenFromUrl() {
      return false;
    },
  };
  setYurucommuFrontendPlugins([
    {
      apiVersion: 1,
      name: "hosted-auth-logout-fence-test",
      createAuthStrategy: () => hostedStrategy,
    },
  ]);

  const store = createStore();
  const logout = store.set(logoutAtom);
  await logoutStarted.promise;
  const refresh = store.set(checkAuthAtom);

  expect(checks).toBe(0);
  releaseLogout.resolve();
  await logout;
  pendingCheck.resolve({
    ...HOSTED_RESULT,
    actor: makeActor("stale-after-logout"),
  });
  await refresh;

  expect(store.get(actorAtom)).toBeNull();
  expect(store.get(authLoadingAtom)).toBe(false);
  expect(store.get(instancesLoadingAtom)).toBe(false);
});
