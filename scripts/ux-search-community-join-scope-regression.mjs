// Exercise the actual SearchPage registry with isolated synthetic stores only.
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
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.navigator = { language: "en" };
Bun.plugin({
  name: "search-community-join-registry-observer",
  setup(build) {
    build.onLoad({ filter: /SearchPage\.tsx$/ }, async (args) => ({
      contents: `${await Bun.file(args.path).text()}\nexport { pendingSearchJoinsAtom, searchJoinReceiptsAtom, searchLikeSubscriptions, beginSearchLike, settleSearchLikeWhenReady, endSearchLike, rememberSearchJoinReceipt, updateSearchJoinReceipt };`,
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
  name: "synthetic-join-scope",
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
const original = registry.beginSearchLike(first, "group-a", "join", "alpha");
check("join begins in original scope", original?.sameScope());
check(
  "same target cannot be sent again after remount",
  !registry.beginSearchLike(first, "group-a", "join", "alpha"),
);
check(
  "missing original name cannot be sent",
  !registry.beginSearchLike(first, "group-c", "join"),
);
const other = registry.beginSearchLike(first, "group-b", "join", "beta");
const separate = registry.beginSearchLike(second, "group-a", "join", "alpha");
check(
  "another target and another provider remain independent",
  other && separate,
);
registry.endSearchLike(first, { ...original, token: Symbol() });
check(
  "wrong token cannot release an in-flight original",
  !registry.beginSearchLike(first, "group-a", "join", "alpha"),
);
first.set(auth.actorAtom, { ap_id: "actor-a" });
first.set(auth.hostedUserAtom, { id: "hosted-a" });
check(
  "same identity refresh preserves the original scope",
  original.sameScope(),
);
registry.rememberSearchJoinReceipt(first, original, "alpha", "unconfirmed");
registry.endSearchLike(first, original);
const receipt = first.get(registry.searchJoinReceiptsAtom).get(original.key);
check(
  "unknown receipt keeps only the original target",
  receipt?.name === "alpha" &&
    receipt.status === "unconfirmed" &&
    receipt.sameScope(),
);
check(
  "unknown receipt prevents a blind retry after remount",
  !registry.beginSearchLike(first, "group-a", "join", "renamed"),
);
check(
  "receipt keeps scope tracking live",
  registry.searchLikeSubscriptions.has(first),
);
registry.updateSearchJoinReceipt(first, original.key, receipt, true);
const checked = first.get(registry.searchJoinReceiptsAtom).get(original.key);
check(
  "explicit original-status visit is retained",
  checked?.checked && checked.name === "alpha",
);
registry.updateSearchJoinReceipt(first, original.key, receipt, false);
check(
  "an older receipt cannot clear a newer one",
  first.get(registry.searchJoinReceiptsAtom).get(original.key) === checked,
);
registry.updateSearchJoinReceipt(first, original.key, checked, false);
const deliberateRetry = registry.beginSearchLike(
  first,
  "group-a",
  "join",
  "alpha",
);
check(
  "explicitly clearing checked receipt enables a later send",
  deliberateRetry,
);
registry.rememberSearchJoinReceipt(
  first,
  deliberateRetry,
  "alpha",
  "unconfirmed",
);
registry.endSearchLike(first, deliberateRetry);
first.set(auth.selectedInstanceIdAtom, "instance-b");
first.set(auth.selectedInstanceIdAtom, "instance-a");
check(
  "instance ABA invalidates the original receipt",
  first.get(registry.searchJoinReceiptsAtom).size === 0 && !receipt.sameScope(),
);
registry.endSearchLike(first, other);
registry.endSearchLike(second, separate);
check(
  "settled operations release tracking",
  !registry.searchLikeSubscriptions.has(first) &&
    !registry.searchLikeSubscriptions.has(second),
);

const loading = make();
const held = registry.beginSearchLike(loading, "group-a", "join", "alpha");
loading.set(auth.instancesLoadingAtom, true);
check(
  "loading refuses a new join",
  !registry.beginSearchLike(loading, "group-b", "join", "beta"),
);
let delivered = 0;
const pending = registry.settleSearchLikeWhenReady(
  loading,
  held.sameScope,
  () => delivered++,
);
await Promise.resolve();
check(
  "observed loading holds the outcome and pending lock",
  delivered === 0 &&
    !registry.beginSearchLike(loading, "group-a", "join", "alpha"),
);
loading.set(auth.instancesLoadingAtom, false);
await pending;
check("unchanged scope receives the original outcome once", delivered === 1);
registry.endSearchLike(loading, held);
const stale = registry.beginSearchLike(loading, "group-c", "join", "gamma");
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
registry.rememberSearchJoinReceipt(loading, stale, "gamma", "joined");
check(
  "actor ABA discards stale delivery and receipt",
  staleDelivered === 0 &&
    loading.get(registry.searchJoinReceiptsAtom).size === 0,
);
registry.endSearchLike(loading, stale);
const changedUrl = registry.beginSearchLike(
  loading,
  "group-d",
  "join",
  "delta",
);
registry.rememberSearchJoinReceipt(loading, changedUrl, "delta", "pending");
prefix = "http://two.local";
check(
  "transport change invalidates settlement and reminder",
  !changedUrl.sameScope() &&
    !loading
      .get(registry.searchJoinReceiptsAtom)
      .get(changedUrl.key)
      ?.sameScope(),
);
registry.endSearchLike(loading, changedUrl);
loading.set(auth.actorAtom, { ap_id: "actor-b" });
check(
  "scope change clears receipt and releases tracking",
  loading.get(registry.searchJoinReceiptsAtom).size === 0 &&
    !registry.searchLikeSubscriptions.has(loading),
);

console.log(
  JSON.stringify(
    {
      scope: "actual SearchPage registry; synthetic identity and transport",
      checks,
    },
    null,
    2,
  ),
);
process.exit(checks.every((item) => item.pass) ? 0 : 1);
