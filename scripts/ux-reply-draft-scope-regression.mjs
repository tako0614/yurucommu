// Isolate the browser-only imports and expose the actual page's private
// registry to this process, without changing the product module's exports.
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
  name: "reply-draft-registry-observer",
  setup(build) {
    build.onLoad({ filter: /PostDetailPage\.tsx$/ }, async (args) => ({
      contents: `${await Bun.file(args.path).text()}\nexport { replyDraftScopeAtom, replyDraftStateAtom, replyDraftSubscriptions, pendingRepliesAtom, trackReplyDraftScope, stopReplyDraftTrackingIfIdle, saveReplyDraft, currentReplyDraftState, clearAcknowledgedReplyDraft };`,
      loader: "tsx",
    }));
  },
});

const registry = await import("../src/pages/PostDetailPage.tsx");
const auth = await import("../src/atoms/auth.ts");
const plugin = await import("../src/lib/plugin.ts");
const checks = [];
const check = (name, pass) => checks.push({ name, pass: Boolean(pass) });
const actor = (id) => ({ ap_id: id });
const strategy = {
  mode: "self-hosted",
  async login() {
    return { success: false };
  },
};
plugin.registerYurucommuFrontendPlugin({
  apiVersion: 1,
  name: "synthetic-scope-test",
  createAuthStrategy: () => strategy,
});
const setup = () => {
  const store = createStore();
  store.set(auth.actorAtom, actor("actor-a"));
  store.set(auth.selectedInstanceIdAtom, "instance-a");
  store.set(auth.hostedUserAtom, { id: "hosted-a" });
  return store;
};
const read = (store, id) =>
  registry.currentReplyDraftState(store)?.entries.get(id);
const tracked = (store) => registry.replyDraftSubscriptions.has(store);

const first = setup();
const second = setup();
registry.saveReplyDraft(first, "post-a", "original");
check("different Provider stores do not share drafts", !read(second, "post-a"));
first.set(auth.actorAtom, actor("actor-a"));
first.set(auth.hostedUserAtom, { id: "hosted-a" });
check(
  "same-ID auth refresh preserves a draft",
  read(first, "post-a")?.text === "original" && tracked(first),
);
first.set(auth.actorAtom, actor("actor-b"));
first.set(auth.actorAtom, actor("actor-a"));
check(
  "unmounted actor A-B-A cannot restore an old draft",
  !read(first, "post-a") && !tracked(first),
);
registry.saveReplyDraft(first, "post-a", "instance draft");
first.set(auth.selectedInstanceIdAtom, "instance-b");
first.set(auth.selectedInstanceIdAtom, "instance-a");
check(
  "unmounted instance A-B-A cannot restore an old draft",
  !read(first, "post-a") && !tracked(first),
);
registry.saveReplyDraft(first, "post-a", "old epoch");
await first.set(auth.loginAtom);
check(
  "new auth epoch clears drafts even for the same actor",
  !read(first, "post-a") && !tracked(first),
);

registry.saveReplyDraft(first, "post-a", "submitted");
const submitted = read(first, "post-a");
registry.saveReplyDraft(first, "post-a", "submitted");
check(
  "same-text retype has a new token",
  !registry.clearAcknowledgedReplyDraft(first, "post-a", submitted) &&
    read(first, "post-a")?.text === "submitted",
);
const newest = read(first, "post-a");
registry.saveReplyDraft(first, "post-b", "other");
check(
  "matching ACK clears only its original target",
  registry.clearAcknowledgedReplyDraft(first, "post-a", newest) &&
    !read(first, "post-a") &&
    read(first, "post-b")?.text === "other",
);
registry.saveReplyDraft(first, "post-b", "");
check(
  "last discarded draft releases its subscription",
  !read(first, "post-b") && !tracked(first),
);

for (let i = 0; i < 32; i++)
  registry.saveReplyDraft(first, `post-${i}`, `draft ${i}`);
check(
  "capacity refuses a new draft without evicting old ones",
  !registry.saveReplyDraft(first, "post-extra", "extra") &&
    registry.currentReplyDraftState(first)?.entries.size === 32 &&
    read(first, "post-0")?.text === "draft 0",
);
for (let i = 0; i < 32; i++) registry.saveReplyDraft(first, `post-${i}`, "");
registry.saveReplyDraft(first, "post-a", "small");
check(
  "oversize edit is not silently replaced by an old draft",
  !registry.saveReplyDraft(first, "post-a", "x".repeat(250_001)) &&
    !read(first, "post-a") &&
    !tracked(first),
);

registry.saveReplyDraft(first, "post-a", "old transport");
plugin.registerYurucommuFrontendPlugin({
  apiVersion: 1,
  name: "new-synthetic-strategy",
  createAuthStrategy: () => ({ ...strategy }),
});
check(
  "observed strategy change invalidates saved drafts",
  !registry.currentReplyDraftState(first) && !tracked(first),
);

registry.trackReplyDraftScope(first);
first.set(registry.pendingRepliesAtom, new Map([["post-a", Symbol()]]));
const before = first.get(registry.replyDraftScopeAtom);
first.set(auth.selectedInstanceIdAtom, "instance-b");
first.set(auth.selectedInstanceIdAtom, "instance-a");
check(
  "pending reply keeps scope tracking across instance ABA",
  tracked(first) && before !== first.get(registry.replyDraftScopeAtom),
);
first.set(registry.pendingRepliesAtom, new Map());
registry.stopReplyDraftTrackingIfIdle(first);
check("settled empty scope releases subscription", !tracked(first));

console.log(
  JSON.stringify(
    {
      scope: "actual page registry and Jotai stores; synthetic auth only",
      checks,
    },
    null,
    2,
  ),
);
process.exit(checks.every((item) => item.pass) ? 0 : 1);
