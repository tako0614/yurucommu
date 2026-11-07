// Observe the actual private registry without changing product exports.
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
  name: "search-like-registry-observer",
  setup(build) {
    build.onLoad({ filter: /SearchPage\.tsx$/ }, async (args) => ({
      contents: `${await Bun.file(args.path).text()}\nexport { pendingSearchLikesAtom, searchLikeScopeAtom, searchLikeSubscriptions, beginSearchLike, settleSearchLikeWhenReady, endSearchLike };`,
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
  name: "synthetic-like-scope",
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
const other = make();
const a = registry.beginSearchLike(first, "post-a");
check("first original scope is current", a && a.sameScope());
first.set(auth.instancesLoadingAtom, true);
check(
  "observed instance loading refuses a new dispatch",
  !registry.beginSearchLike(first, "blocked") && a.sameScope(),
);
first.set(auth.instancesLoadingAtom, false);
check(
  "same Provider cannot send the same target twice",
  !registry.beginSearchLike(first, "post-a"),
);
const b = registry.beginSearchLike(first, "post-b");
const independent = registry.beginSearchLike(other, "post-a");
check(
  "different targets and Providers can proceed independently",
  b && independent,
);
first.set(auth.actorAtom, { ap_id: "actor-a" });
first.set(auth.hostedUserAtom, { id: "hosted-a" });
check("same-ID auth refresh keeps the original scope", a.sameScope());
first.set(auth.actorAtom, { ap_id: "actor-b" });
const otherActor = registry.beginSearchLike(first, "post-a");
first.set(auth.actorAtom, { ap_id: "actor-a" });
check(
  "unmounted actor A-B-A invalidates the original settlement",
  otherActor && !a.sameScope() && !otherActor.sameScope(),
);
check(
  "old same-actor request remains locked after actor ABA",
  !registry.beginSearchLike(first, "post-a"),
);
registry.endSearchLike(first, { key: a.key, token: Symbol() });
check(
  "a different token cannot release the original lock",
  !registry.beginSearchLike(first, "post-a"),
);
registry.endSearchLike(first, a);
const afterA = registry.beginSearchLike(first, "post-a");
check(
  "only the owning token releases the original target",
  afterA && afterA.sameScope(),
);
first.set(auth.selectedInstanceIdAtom, "instance-b");
first.set(auth.selectedInstanceIdAtom, "instance-a");
check(
  "unmounted instance A-B-A invalidates the settlement",
  !afterA.sameScope(),
);
registry.endSearchLike(first, afterA);
const epoch = registry.beginSearchLike(first, "post-c");
await first.set(auth.loginAtom);
check(
  "same-actor auth epoch invalidates settlement but keeps the lock",
  !epoch.sameScope() && !registry.beginSearchLike(first, "post-c"),
);
registry.endSearchLike(first, epoch);
const changingUrl = registry.beginSearchLike(first, "post-d");
prefix = "http://two.local";
check(
  "changed resolved URL invalidates the settlement",
  !changingUrl.sameScope(),
);
registry.endSearchLike(first, changingUrl);
prefix = "http://one.local";
const changingPlugin = registry.beginSearchLike(first, "post-e");
plugin.registerYurucommuFrontendPlugin({
  apiVersion: 1,
  name: "changed-synthetic-strategy",
  createAuthStrategy: () => ({ ...strategy }),
});
check(
  "changed strategy or transport invalidates the settlement",
  !changingPlugin.sameScope(),
);
registry.endSearchLike(first, changingPlugin);
first.set(auth.logoutBusyAtom, true);
check(
  "logout in progress refuses a new request",
  !registry.beginSearchLike(first, "post-f"),
);
first.set(auth.logoutBusyAtom, false);
registry.endSearchLike(first, b);
registry.endSearchLike(first, otherActor);
registry.endSearchLike(other, independent);
check(
  "last settled attempt releases its Provider subscription",
  !registry.searchLikeSubscriptions.has(first) &&
    !registry.searchLikeSubscriptions.has(other),
);

const loadingStore = make();
const held = registry.beginSearchLike(loadingStore, "held");
loadingStore.set(auth.instancesLoadingAtom, true);
let delivered = 0;
const pending = registry.settleSearchLikeWhenReady(
  loadingStore,
  held.sameScope,
  () => delivered++,
);
await Promise.resolve();
check(
  "loading keeps the original outcome and target lock pending",
  delivered === 0 && !registry.beginSearchLike(loadingStore, "held"),
);
loadingStore.set(auth.instancesLoadingAtom, false);
await pending;
check("same scope receives its held outcome exactly once", delivered === 1);
registry.endSearchLike(loadingStore, held);
const stale = registry.beginSearchLike(loadingStore, "stale");
loadingStore.set(auth.instancesLoadingAtom, true);
let staleDeliveries = 0;
const stalePending = registry.settleSearchLikeWhenReady(
  loadingStore,
  stale.sameScope,
  () => staleDeliveries++,
);
loadingStore.set(auth.actorAtom, { ap_id: "actor-b" });
await stalePending;
loadingStore.set(auth.actorAtom, { ap_id: "actor-a" });
loadingStore.set(auth.instancesLoadingAtom, false);
check(
  "changed actor discards held outcome even after ABA",
  staleDeliveries === 0,
);
registry.endSearchLike(loadingStore, stale);
check(
  "held outcome subscriptions are released",
  !registry.searchLikeSubscriptions.has(loadingStore),
);

console.log(
  JSON.stringify(
    {
      scope:
        "actual page registry and Jotai stores; synthetic auth and transport only",
      checks,
    },
    null,
    2,
  ),
);
process.exit(checks.every((item) => item.pass) ? 0 : 1);
