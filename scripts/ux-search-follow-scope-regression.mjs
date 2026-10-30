// Exercise the actual private registry with isolated Jotai stores. No network.
import { createStore } from "jotai/vanilla";

globalThis.window = {
  history: { state: { _depth: 0 }, length: 1, replaceState() {} },
  location: {
    href: "http://localhost/",
    origin: "http://localhost",
    pathname: "/",
    search: "",
  },
};
globalThis.localStorage = {
  getItem() {
    return null;
  },
  setItem() {},
};
globalThis.navigator = { language: "en" };
Bun.plugin({
  name: "search-follow-registry-observer",
  setup(build) {
    build.onLoad({ filter: /SearchPage\.tsx$/ }, async (args) => ({
      contents: `${await Bun.file(args.path).text()}\nexport { pendingSearchFollowsAtom, searchFollowReceiptsAtom, searchLikeSubscriptions, beginSearchLike, settleSearchLikeWhenReady, endSearchLike, rememberSearchFollowReceipt };`,
      loader: "tsx",
    }));
  },
});

const registry = await import("../src/pages/SearchPage.tsx");
const auth = await import("../src/atoms/auth.ts");
const plugin = await import("../src/lib/plugin.ts");
const checks = [];
const check = (name, pass) => checks.push({ name, pass: Boolean(pass) });
const strategy = {
  mode: "self-hosted",
  async login() {
    return { success: false };
  },
};
let prefix = "http://one.local";
const transport = {
  credentials: "include",
  getAuthHeaders: () => ({}),
  resolveUrl: (path) => prefix + path,
};
plugin.registerYurucommuFrontendPlugin({
  apiVersion: 1,
  name: "synthetic-follow-scope",
  createAuthStrategy: () => strategy,
  createApiTransport: () => transport,
});
const make = () => {
  const store = createStore();
  store.set(auth.actorAtom, { ap_id: "actor-a" });
  store.set(auth.hostedUserAtom, { id: "hosted-a" });
  store.set(auth.selectedInstanceIdAtom, "instance-a");
  store.set(auth.instancesLoadingAtom, false);
  return store;
};
const first = make();
const second = make();
const original = registry.beginSearchLike(first, "target-a", "follow");
check("original follow is bound to current scope", original?.sameScope());
check(
  "same Provider and target cannot send twice after route unmount",
  !registry.beginSearchLike(first, "target-a", "follow"),
);
const different = registry.beginSearchLike(first, "target-b", "follow");
const separateLike = registry.beginSearchLike(first, "target-a");
const separateProvider = registry.beginSearchLike(second, "target-a", "follow");
check(
  "other target, like, and Provider remain independent",
  different && separateLike && separateProvider,
);
registry.endSearchLike(first, { ...original, token: Symbol() });
check(
  "wrong token cannot release original follow",
  !registry.beginSearchLike(first, "target-a", "follow"),
);
first.set(auth.actorAtom, { ap_id: "actor-a" });
first.set(auth.hostedUserAtom, { id: "hosted-a" });
check("same-ID auth refresh keeps original scope", original.sameScope());
registry.rememberSearchFollowReceipt(first, original, "target-a");
registry.endSearchLike(first, original);
const receipt = first.get(registry.searchFollowReceiptsAtom);
check(
  "unmounted ACK retains original target and scope",
  receipt?.targets.has("target-a") && receipt.sameScope(),
);
check(
  "receipt maintains identity subscription without the original lock",
  registry.searchLikeSubscriptions.has(first),
);
first.set(auth.selectedInstanceIdAtom, "instance-b");
first.set(auth.selectedInstanceIdAtom, "instance-a");
check(
  "instance ABA removes the receipt and invalidates the old settlement",
  first.get(registry.searchFollowReceiptsAtom) === null && !receipt.sameScope(),
);
registry.endSearchLike(first, different);
registry.endSearchLike(first, separateLike);
registry.endSearchLike(second, separateProvider);
check(
  "last attempts and cleared receipt release subscriptions",
  !registry.searchLikeSubscriptions.has(first) &&
    !registry.searchLikeSubscriptions.has(second),
);

const actorStore = make();
const actorAttempt = registry.beginSearchLike(actorStore, "target-a", "follow");
registry.rememberSearchFollowReceipt(actorStore, actorAttempt, "target-a");
actorStore.set(auth.actorAtom, { ap_id: "actor-b" });
actorStore.set(auth.actorAtom, { ap_id: "actor-a" });
check(
  "actor ABA removes receipt and invalidates original scope",
  actorStore.get(registry.searchFollowReceiptsAtom) === null &&
    !actorAttempt.sameScope(),
);
check(
  "old same-actor in-flight request remains locked after ABA",
  !registry.beginSearchLike(actorStore, "target-a", "follow"),
);
registry.endSearchLike(actorStore, actorAttempt);
const epochAttempt = registry.beginSearchLike(actorStore, "target-c", "follow");
registry.rememberSearchFollowReceipt(actorStore, epochAttempt, "target-c");
await actorStore.set(auth.loginAtom);
check(
  "auth epoch change removes receipt and invalidates original scope",
  actorStore.get(registry.searchFollowReceiptsAtom) === null &&
    !epochAttempt.sameScope(),
);
registry.endSearchLike(actorStore, epochAttempt);
const changedUrl = registry.beginSearchLike(actorStore, "target-d", "follow");
registry.rememberSearchFollowReceipt(actorStore, changedUrl, "target-d");
prefix = "http://two.local";
check(
  "transport URL change invalidates original receipt and settlement",
  !actorStore.get(registry.searchFollowReceiptsAtom)?.sameScope() &&
    !changedUrl.sameScope(),
);
registry.endSearchLike(actorStore, changedUrl);
prefix = "http://one.local";
actorStore.set(auth.actorAtom, { ap_id: "actor-b" });
check(
  "scope transition clears stale receipt and its subscription",
  actorStore.get(registry.searchFollowReceiptsAtom) === null &&
    !registry.searchLikeSubscriptions.has(actorStore),
);

const loading = make();
const held = registry.beginSearchLike(loading, "target-a", "follow");
loading.set(auth.instancesLoadingAtom, true);
check(
  "observed loading refuses another dispatch",
  !registry.beginSearchLike(loading, "target-b", "follow"),
);
let delivered = 0;
const pending = registry.settleSearchLikeWhenReady(
  loading,
  held.sameScope,
  () => delivered++,
);
await Promise.resolve();
check(
  "loading holds outcome and original lock",
  delivered === 0 && !registry.beginSearchLike(loading, "target-a", "follow"),
);
loading.set(auth.instancesLoadingAtom, false);
await pending;
check("unchanged scope receives outcome exactly once", delivered === 1);
registry.endSearchLike(loading, held);
const stale = registry.beginSearchLike(loading, "target-c", "follow");
loading.set(auth.instancesLoadingAtom, true);
let staleDelivered = 0;
const stalePending = registry.settleSearchLikeWhenReady(
  loading,
  stale.sameScope,
  () => staleDelivered++,
);
loading.set(auth.actorAtom, { ap_id: "actor-b" });
await stalePending;
loading.set(auth.actorAtom, { ap_id: "actor-a" });
loading.set(auth.instancesLoadingAtom, false);
check(
  "actor change while loading discards the old outcome even after ABA",
  staleDelivered === 0,
);
registry.endSearchLike(loading, stale);
check(
  "loading subscriptions are released",
  !registry.searchLikeSubscriptions.has(loading),
);

console.log(
  JSON.stringify(
    {
      scope:
        "actual SearchPage registry and Jotai stores; synthetic auth and transport only",
      checks,
    },
    null,
    2,
  ),
);
process.exit(checks.every((item) => item.pass) ? 0 : 1);
