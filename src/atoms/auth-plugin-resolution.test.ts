import { afterAll, afterEach, expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";

import {
  clearYurucommuFrontendPlugin,
  setYurucommuFrontendPlugins,
  type AuthCheckResult,
  type AuthStrategy,
} from "../lib/plugin.ts";

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

const { checkAuthAtom, hostedUserAtom, isHostedDeployment } =
  await import("./auth.ts");

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
