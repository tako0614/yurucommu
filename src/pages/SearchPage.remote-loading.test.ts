import { expect, test } from "bun:test";

// There is no DOM test runtime in this package. Run the real component's
// initialization, effects and callbacks with Solid's client runtime instead.
// The loader replaces its final JSX view with a test probe; it does not copy or
// rewrite search logic. Module mocks remain in a child process, as in the
// FFmpeg regressions, so they cannot leak into the rest of the portable suite.
const childSource = String.raw`
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { createRoot, createSignal } from "solid-js";

const target = __TARGET__;
const targetUrl = pathToFileURL(target);
const fields = [
  "performSearch", "resortUsers", "resortPosts", "toggleIncludeRemote",
  "acceptRemoteHandlePrompt", "resetSearch", "searchingRemote", "searching",
  "searchUsersResult", "searchError", "lastQuery", "includeRemote",
];
let returnReplacements = 0;
const iconReplacements = [];
const events = new EventTarget();
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error("unexpected_network"); };

Bun.plugin({
  name: "search-page-controller-probe",
  setup(builder) {
    builder.onLoad({ filter: /\/SearchPage\.tsx$/ }, async ({ path }) => {
      assert.equal(path, target);
      const source = await Bun.file(path).text();
      const transformed = ts.transpileModule(source, {
        fileName: path,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.Preserve,
          verbatimModuleSyntax: false,
        },
        transformers: {
          before: [(context) => {
            const visit = (node) => {
              if (ts.isFunctionDeclaration(node) && node.name?.text === "SearchPage") {
                assert.ok(node.body);
                const statements = node.body.statements.map((statement) => {
                  if (!ts.isReturnStatement(statement)) return statement;
                  let expression = statement.expression;
                  while (expression && ts.isParenthesizedExpression(expression)) {
                    expression = expression.expression;
                  }
                  assert.ok(expression && ts.isJsxElement(expression));
                  returnReplacements++;
                  return ts.factory.createReturnStatement(
                    ts.factory.createObjectLiteralExpression(
                      fields.map((name) => ts.factory.createShorthandPropertyAssignment(name)),
                    ),
                  );
                });
                return ts.factory.updateFunctionDeclaration(
                  node, node.modifiers, node.asteriskToken, node.name,
                  node.typeParameters, node.parameters, node.type,
                  ts.factory.updateBlock(node.body, statements),
                );
              }
              // Neutralize exactly the three standalone SVG helpers. Do not
              // silently transform any newly introduced JSX or callback.
              if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
                  ["SearchEmptyIcon", "CloseIcon", "SearchIcon"].includes(node.name.text)) {
                const arrow = node.initializer;
                assert.ok(arrow && ts.isArrowFunction(arrow));
                assert.ok(ts.isParenthesizedExpression(arrow.body) && ts.isJsxElement(arrow.body.expression));
                iconReplacements.push(node.name.text);
                return ts.factory.updateVariableDeclaration(
                  node, node.name, node.exclamationToken, node.type,
                  ts.factory.updateArrowFunction(arrow, arrow.modifiers, arrow.typeParameters,
                    arrow.parameters, arrow.type, arrow.equalsGreaterThanToken, ts.factory.createNull()),
                );
              }
              if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
                throw new Error("unexpected JSX outside the exact render seam");
              }
              return ts.visitEachChild(node, visit, context);
            };
            return (root) => ts.visitNode(root, visit);
          }],
        },
      });
      assert.equal(returnReplacements, 1);
      assert.deepEqual(iconReplacements, ["SearchEmptyIcon", "CloseIcon", "SearchIcon"]);
      return { contents: transformed.outputText, loader: "js" };
    });
  },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const until = async (predicate) => {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("expected deferred boundary was not reached");
};
const localActor = (query) => ({ ap_id: "local:" + query });
const remoteActor = (query) => ({ ap_id: "remote:" + query });
const emptyPosts = () => Promise.resolve({ items: [], hasMore: false });
let fixture;
const forbiddenEffect = () => { throw new Error("unexpected_effect"); };
mock.module(new URL("../lib/api.ts", targetUrl).pathname, () => ({
  fetchCommunities: async () => [],
  fetchFollowing: async () => ({ actors: [] }),
  fetchTrendingHashtags: async () => [],
  searchActors(query) {
    const owner = fixture;
    owner.localCalls.push(query);
    if (owner.failNextLocal) {
      owner.failNextLocal = false;
      return Promise.reject(new Error("synthetic_local_failure"));
    }
    if (owner.holdNextLocal) {
      owner.holdNextLocal = false;
      const gate = deferred();
      owner.locals.push({ query, ...gate });
      return gate.promise;
    }
    return Promise.resolve({ items: [localActor(query)], hasMore: false });
  },
  searchPosts: emptyPosts,
  searchHashtag: emptyPosts,
  searchRemote(query) {
    const gate = deferred();
    fixture.remotes.push({ query, ...gate });
    return gate.promise;
  },
  follow: forbiddenEffect, joinCommunity: forbiddenEffect,
  likePost: forbiddenEffect, unlikePost: forbiddenEffect,
  getYurucommuApiTransport: forbiddenEffect,
}));
mock.module(new URL("../hooks/useRequiredActor.ts", targetUrl).pathname, () => ({
  useRequiredActor: () => ({ ap_id: "actor:synthetic-test" }),
}));
mock.module(new URL("../lib/i18n.tsx", targetUrl).pathname, () => ({
  useI18n: () => ({ t: (key) => key, language: () => "en" }),
}));
mock.module(new URL("../atoms/scope.ts", targetUrl).pathname, () => ({
  refreshScopesAtom: {}, scopeCommunitiesAtom: {},
}));
mock.module(new URL("../atoms/auth.ts", targetUrl).pathname, () => ({
  actorAtom: {}, authSessionEpochAtom: {}, hostedUserAtom: {},
  instancesLoadingAtom: {}, logoutBusyAtom: {}, selectedInstanceIdAtom: {},
}));
mock.module("solid-jotai", () => ({
  useStore: () => ({ get: forbiddenEffect, set: forbiddenEffect, sub: forbiddenEffect }),
  useAtomValue: () => () => [],
  useSetAtom: () => {
    const owner = fixture;
    return (update) => { owner.toasts = typeof update === "function" ? update(owner.toasts) : update; };
  },
}));
mock.module("@solidjs/router", () => ({
  useSearchParams: () => {
    const owner = fixture;
    const [params, setParams] = createSignal({ search: "", tab: "users" });
    owner.navigate = (search) => setParams({ search, tab: "users" });
    return [
      { get search() { return params().search; }, get tab() { return params().tab; } },
      (patch) => setParams((current) => ({ ...current, ...patch })),
    ];
  },
  A: () => null,
}));
mock.module(new URL("../components/MediaLightbox.tsx", targetUrl).pathname, () => ({
  useMediaLightbox: () => ({}), AttachmentGrid: () => null, MediaLightbox: () => null,
}));

const { SearchPage } = await import(target);
const results = [];
const errors = [];
console.error = (...args) => errors.push(String(args[0]));
async function scenario(name, run) {
  fixture = { remotes: [], locals: [], localCalls: [], toasts: [], tasks: [] };
  const owner = fixture;
  let dispose;
  const view = createRoot((release) => { dispose = release; return SearchPage(); });
  const call = (name, ...args) => {
    const task = Promise.resolve(view[name](...args));
    owner.tasks.push(task);
    return task;
  };
  try {
    await flush();
    await run({ owner, view, call, dispose });
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, message: String(error.message) });
  } finally {
    dispose();
    for (const item of owner.locals) item.resolve({ items: [localActor(item.query)], hasMore: false });
    for (const item of owner.remotes) item.resolve([remoteActor(item.query)]);
    await Promise.allSettled(owner.tasks);
    await flush();
  }
}
const startRemote = async (context, query) => {
  if (!context.view.includeRemote()) context.view.toggleIncludeRemote();
  const task = context.call("performSearch", query);
  await until(() => context.owner.remotes.some((item) => item.query === query));
  return { task, request: context.owner.remotes.findLast((item) => item.query === query) };
};

for (const outcome of ["success", "failure"]) {
  await scenario("stale " + outcome + " preserves the newer pending lookup", async (context) => {
    const old = await startRemote(context, "old@fixture.invalid");
    const current = await startRemote(context, "new@fixture.invalid");
    if (outcome === "success") old.request.resolve([remoteActor("stale")]);
    else old.request.reject(new Error("synthetic_old_failure"));
    await old.task;
    assert.equal(context.view.searchingRemote(), true);
    assert.deepEqual(context.view.searchUsersResult(), [localActor("new@fixture.invalid")]);
    assert.equal(context.owner.toasts.length, 0);
    current.request.resolve([remoteActor("new")]);
    await current.task;
    assert.deepEqual(context.view.searchUsersResult(), [localActor("new@fixture.invalid"), remoteActor("new")]);
    assert.equal(context.view.searchingRemote(), false);
  });
}
for (const failLocal of [false, true]) {
  await scenario("new plain query clears old loading, local failure=" + failLocal, async (context) => {
    const old = await startRemote(context, "old@fixture.invalid");
    context.owner.failNextLocal = failLocal;
    const searching = context.call("performSearch", "plain");
    assert.equal(context.view.searchingRemote(), false);
    await searching;
    assert.equal(context.view.searchingRemote(), false);
    assert.equal(Boolean(context.view.searchError()), failLocal);
    old.request.resolve([remoteActor("stale")]);
    await old.task;
    assert.equal(context.view.searchingRemote(), false);
  });
}
await scenario("posts sort clears the old generation's loading", async (context) => {
  const old = await startRemote(context, "old@fixture.invalid");
  const sorting = context.call("resortPosts", "old@fixture.invalid");
  assert.equal(context.view.searchingRemote(), false);
  await sorting;
  assert.equal(context.view.searchingRemote(), false);
  old.request.resolve([remoteActor("stale")]);
  await old.task;
  assert.equal(context.view.searchingRemote(), false);
});
await scenario("users sort owns its new remote loading", async (context) => {
  const old = await startRemote(context, "old@fixture.invalid");
  const sorting = context.call("resortUsers", "old@fixture.invalid");
  assert.equal(context.view.searchingRemote(), false);
  await until(() => context.owner.remotes.length === 2);
  old.request.resolve([remoteActor("stale")]);
  await old.task;
  assert.equal(context.view.searchingRemote(), true);
  assert.deepEqual(context.view.searchUsersResult(), [localActor("old@fixture.invalid")]);
  context.owner.remotes[1].resolve([remoteActor("sorted")]);
  await sorting;
  assert.equal(context.view.searchingRemote(), false);
});
for (const action of ["toggleIncludeRemote", "acceptRemoteHandlePrompt"]) {
  await scenario(action + " and local completion share one lookup", async (context) => {
    context.owner.holdNextLocal = true;
    const searching = context.call("performSearch", "one@fixture.invalid");
    await until(() => context.owner.locals.length === 1);
    context.view[action]();
    await until(() => context.owner.remotes.length === 1);
    context.owner.locals[0].resolve({ items: [localActor("one@fixture.invalid")], hasMore: false });
    await until(() => context.owner.remotes.length > 1 || !context.view.searching());
    assert.equal(context.owner.remotes.length, 1);
    assert.equal(context.view.searchingRemote(), true);
    context.owner.remotes[0].resolve([remoteActor("one")]);
    await searching;
    await flush();
    assert.equal(context.view.searchingRemote(), false);
    assert.deepEqual(context.view.searchUsersResult(), [localActor("one@fixture.invalid"), remoteActor("one")]);
  });
}
await scenario("clear invalidates a pending remote result", async (context) => {
  const old = await startRemote(context, "old@fixture.invalid");
  context.view.resetSearch();
  assert.equal(context.view.searchingRemote(), false);
  old.request.resolve([remoteActor("stale")]);
  await old.task;
  assert.deepEqual(context.view.searchUsersResult(), []);
  assert.equal(context.view.lastQuery(), "");
  assert.equal(context.owner.toasts.length, 0);
});
await scenario("the actual route effect and cleanup fence stale work", async (context) => {
  context.owner.navigate("route@fixture.invalid");
  await until(() => context.view.lastQuery() === "route@fixture.invalid" && !context.view.searching());
  assert.deepEqual(context.owner.localCalls, ["route@fixture.invalid"]);
  const old = await startRemote(context, "old@fixture.invalid");
  const before = [...context.view.searchUsersResult()];
  context.dispose();
  context.owner.navigate("after-dispose");
  old.request.resolve([remoteActor("stale")]);
  await old.task;
  await flush();
  assert.deepEqual(context.view.searchUsersResult(), before);
  assert.equal(context.owner.localCalls.includes("after-dispose"), false);
  assert.equal(context.owner.toasts.length, 0);
});
await scenario("turning remote off starts no additional lookup", async (context) => {
  const current = await startRemote(context, "one@fixture.invalid");
  context.view.toggleIncludeRemote();
  assert.equal(context.view.includeRemote(), false);
  assert.equal(context.owner.remotes.length, 1);
  current.request.resolve([remoteActor("one")]);
  await current.task;
  assert.equal(context.view.searchingRemote(), false);
  assert.equal(context.owner.remotes.length, 1);
});
await scenario("current remote failure clears loading and emits one toast", async (context) => {
  const current = await startRemote(context, "one@fixture.invalid");
  current.request.reject(new Error("synthetic_current_failure"));
  await current.task;
  assert.equal(context.view.searchingRemote(), false);
  assert.equal(context.owner.toasts.length, 1);
  assert.equal(context.owner.toasts[0].message, "search.remoteSearchFailed");
});
assert.equal(networkCalls, 0);
assert.equal(returnReplacements, 1);
console.log(JSON.stringify({ results, networkCalls, returnReplacements }));
process.exitCode = results.every((item) => item.pass) ? 0 : 1;
`;

test("actual SearchPage callbacks retain generation-owned remote loading", async () => {
  const target = new URL("./SearchPage.tsx", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "--eval",
      childSource.replace("__TARGET__", JSON.stringify(target)),
    ],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const watchdog = setTimeout(() => child.kill(), 20_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stdout, stderr, exit }).toMatchObject({ exit: 0 });
    const result = JSON.parse(stdout) as {
      results: { name: string; pass: boolean; message?: string }[];
      networkCalls: number;
      returnReplacements: number;
    };
    expect(result.results).toHaveLength(12);
    expect(result.results.filter((item) => !item.pass)).toEqual([]);
    expect(result.networkCalls).toBe(0);
    expect(result.returnReplacements).toBe(1);
    console.log(stdout.trim());
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 30_000);
