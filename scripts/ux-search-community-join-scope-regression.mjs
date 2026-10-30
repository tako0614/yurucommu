// Exercise the actual SearchPage registry with isolated synthetic stores only.
import { createStore } from "jotai/vanilla";
import ts from "typescript";

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
    build.onLoad({ filter: /SearchPage\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const parsed = ts.createSourceFile(
        args.path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const matches = [];
      const visit = (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(parsed) === "refreshCurrentJoinScopes"
        )
          matches.push(node);
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      if (matches.length !== 1 || !ts.isArrowFunction(matches[0].initializer))
        throw new Error("unexpected actual refresh callback shape");
      // Exercise the actual callback, not a separately implemented model.
      const refresh = matches[0].initializer.getText(parsed);
      return {
        contents: `${source}\nexport { pendingSearchJoinsAtom, searchJoinReceiptsAtom, searchLikeSubscriptions, beginSearchLike, settleSearchLikeWhenReady, endSearchLike, rememberSearchJoinReceipt, searchJoinScopeReadAtom };\nexport const __probeActualRefresh = (store, language, setToasts) => (${refresh});`,
        loader: "tsx",
      };
    });
  },
});

const registry = await import("../src/pages/SearchPage.tsx");
const auth = await import("../src/atoms/auth.ts");
const scope = await import("../src/atoms/scope.ts");
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
let readOrigin = "http://read-one.local";
const transport = {
  credentials: "include",
  getAuthHeaders: () => ({}),
  resolveUrl: (path) =>
    (path === "/api/communities" ? readOrigin : prefix) + path,
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
check(
  "an unconfirmed receipt remains tied to the original target",
  first.get(registry.searchJoinReceiptsAtom).get(original.key) === receipt,
);
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

// Use the SDK's actual GET and the component's extracted callback, replacing
// only the network with a deferred synthetic response. POST destinations stay
// fixed while the plugin's GET destination changes.
const savedFetch = globalThis.fetch;
const savedError = console.error;
console.error = () => {};
async function readScenario({ change, reject, loading: waitForSelection }) {
  readOrigin = "http://read-one.local";
  const store = make();
  const attempt = registry.beginSearchLike(
    store,
    "group-read",
    "join",
    "read-name",
  );
  const token = Symbol();
  store.set(registry.searchJoinScopeReadAtom, token);
  const oldRows = [{ ap_id: "original-scope-sentinel" }];
  store.set(scope.scopeCommunitiesAtom, oldRows);
  let toastList = [];
  let resolveRead;
  let rejectRead;
  let requestedUrl;
  globalThis.fetch = (url, options) => {
    requestedUrl = String(url);
    if (options?.method && options.method !== "GET")
      throw new Error("unexpected synthetic write");
    return new Promise((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
    });
  };
  const callback = registry.__probeActualRefresh(
    store,
    () => "en",
    (update) => {
      toastList = typeof update === "function" ? update(toastList) : update;
    },
  );
  const pendingRead = callback(token, attempt.sameScope, {
    label: "Original",
    name: "read-name",
  });
  for (let i = 0; i < 30 && !resolveRead; i++) await Promise.resolve();
  if (!resolveRead) throw new Error("the actual SDK read was not issued");
  if (waitForSelection) store.set(auth.instancesLoadingAtom, true);
  if (change && !waitForSelection) readOrigin = "http://read-two.local";
  if (reject) rejectRead(new Error("synthetic read failure"));
  else
    resolveRead(
      new Response(JSON.stringify({ communities: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  if (waitForSelection) {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    readOrigin = "http://read-two.local";
    store.set(auth.instancesLoadingAtom, false);
  }
  await pendingRead;
  const result = {
    originalRequested: requestedUrl === "http://read-one.local/api/communities",
    postScopeCurrent: attempt.sameScope(),
    oldRowsPreserved: store.get(scope.scopeCommunitiesAtom) === oldRows,
    toasts: toastList.length,
  };
  registry.endSearchLike(store, attempt);
  return result;
}
try {
  const changed = await readScenario({ change: true });
  check("actual GET used the original read URL", changed.originalRequested);
  check("GET-only change preserves the POST scope", changed.postScopeCurrent);
  check(
    "GET-only change cannot replace the original list",
    changed.oldRowsPreserved,
  );
  const current = await readScenario({});
  check("unchanged read still refreshes the list", !current.oldRowsPreserved);
  const failed = await readScenario({ reject: true });
  check(
    "current read failure remains visible",
    failed.oldRowsPreserved && failed.toasts === 1,
  );
  const staleFailed = await readScenario({ change: true, reject: true });
  check(
    "stale read failure cannot affect the new connection",
    staleFailed.oldRowsPreserved && staleFailed.toasts === 0,
  );
  const delayed = await readScenario({ change: true, loading: true });
  check(
    "GET change during connection selection cannot publish the old list",
    delayed.oldRowsPreserved,
  );
} finally {
  globalThis.fetch = savedFetch;
  console.error = savedError;
}

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
