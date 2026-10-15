// Run in a separate Bun process with the browser export condition. This uses
// real Solid/Jotai subscriptions, the hook, SDK and intent coordinator without
// replacing modules in the rest of the portable test process.
import assert from "node:assert/strict";
import type { Actor } from "../../../../types/index.ts";
import type { StoryCanvas } from "../../../../lib/story-canvas.ts";

const origin = "https://story.example";
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
};
Object.defineProperties(globalThis, {
  window: { value: { location: { href: `${origin}/` } } },
  navigator: { value: { language: "ja-JP" } },
  localStorage: { value: storage },
  sessionStorage: { value: storage },
  document: {
    value: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (callback: BlobCallback) =>
          callback(new Blob(["rendered fixture"], { type: "image/jpeg" })),
      }),
    },
  },
});

const { createRoot } = await import("solid-js");
const { getDefaultStore } = await import("jotai/vanilla");
const { actorAtom, selectedInstanceIdAtom, logoutBusyAtom, hostedUserAtom } =
  await import("../../../../atoms/auth.ts");
const { setYurucommuFrontendPlugins } =
  await import("../../../../lib/plugin.ts");
const { useStoryPost } = await import("../useStoryPost.ts");
const store = getDefaultStore();
const owner = {
  ap_id: `${origin}/ap/users/you`,
  username: "you",
  preferred_username: "you",
  name: "You",
  role: "owner",
} as Actor;
store.set(actorAtom, owner);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const scenario = process.argv[2];
const renderGate = deferred();
const uploadGate = deferred();
const uploadStarted = deferred();
let serverOrigin = origin;
const transport = {
  credentials: "include" as const,
  resolveUrl: (path: string) => `${serverOrigin}${path}`,
  getAuthHeaders: () => ({}),
};
setYurucommuFrontendPlugins([
  {
    apiVersion: 1,
    name: "story-scope-fixture",
    createApiTransport: () => transport,
  },
]);
const requests: { path: string; origin: string }[] = [];
globalThis.fetch = (async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    origin,
  );
  requests.push({ path: url.pathname, origin: url.origin });
  if (url.pathname === "/api/media/upload") {
    uploadStarted.resolve();
    if (scenario.endsWith("during-upload")) await uploadGate.promise;
    return Response.json({
      url: "/media/story-scope.jpg",
      r2_key: "uploads/story-scope.jpg",
      content_type: "image/jpeg",
    });
  }
  assert.equal(url.pathname, "/api/stories");
  const payload = JSON.parse(String(init?.body));
  return Response.json({
    story: {
      ap_id: `${origin}/ap/objects/created-story`,
      author: owner,
      attachment: {
        type: "Document",
        mediaType: payload.attachment.content_type,
        url: "/media/story-scope.jpg",
        r2_key: payload.attachment.r2_key,
      },
      caption: payload.caption,
      displayDuration: payload.displayDuration,
      overlays: payload.overlays ?? [],
      published: "2026-10-15T00:00:00.000Z",
      end_time: "2026-10-16T00:00:00.000Z",
    },
  });
}) as typeof fetch;

if (scenario === "invalid-initial-origin") {
  store.set(actorAtom, {
    ...owner,
    ap_id: "https://mock.example/ap/users/you",
  });
}
let closed = 0;
let acknowledged = 0;
let dispose!: () => void;
let actions!: ReturnType<typeof useStoryPost>;
createRoot((cleanup) => {
  dispose = cleanup;
  actions = useStoryPost({
    get actorApId() {
      return store.get(actorAtom)!.ap_id;
    },
    storyCanvas: {
      getLayers: () => [],
      render: () =>
        scenario === "server-during-render"
          ? renderGate.promise
          : Promise.resolve(),
      getCanvas: () => ({ width: 20, height: 30 }),
    } as unknown as StoryCanvas,
    videoFile: null,
    videoScale: 1,
    videoPosition: { x: 0, y: 0 },
    videoRotation: 0,
    displayScale: 1,
    ffmpegReady: true,
    busy: false,
    onStart: () => {},
    onResumeEditing: () => {},
    overlays: [],
    caption: "scope regression",
    setError: () => {},
    onSuccess: () => {
      acknowledged += 1;
    },
    onClose: () => {
      closed += 1;
    },
  });
});

try {
  if (scenario === "invalid-initial-origin") {
    assert.equal(
      actions.identityChanged(),
      false,
      "initialization failure is not an account switch",
    );
    assert.equal(actions.recovery().failed, true);
    assert.equal(actions.editingLocked(), true);
    await actions.handlePost();
    assert.equal(requests.length, 0);
  } else {
    assert.equal(actions.identityChanged(), false);
    assert.equal(actions.editingLocked(), false);
    if (scenario === "stable" || scenario === "same-principal-refresh") {
      if (scenario === "same-principal-refresh")
        store.set(actorAtom, { ...owner, name: "Updated profile" });
      await actions.handlePost();
      await Promise.resolve();
      assert.equal(actions.identityChanged(), false);
      assert.equal(actions.recovery().record?.status, "confirmed");
      assert.equal(acknowledged, 1);
      assert.equal(closed, 1);
      assert.deepEqual(
        requests.map((r) => r.path),
        ["/api/media/upload", "/api/stories"],
      );
    } else if (scenario === "server-during-render") {
      const posting = actions.handlePost();
      serverOrigin = "https://other.example";
      renderGate.resolve();
      await posting;
      assert.equal(actions.identityChanged(), true);
      assert.equal(requests.length, 0);
    } else if (scenario.endsWith("during-upload")) {
      const posting = actions.handlePost();
      const timer = setTimeout(() => {
        throw new Error("upload boundary was not reached");
      }, 2000);
      await uploadStarted.promise;
      clearTimeout(timer);
      if (scenario === "actor-during-upload")
        store.set(actorAtom, {
          ...owner,
          ap_id: `${origin}/ap/users/other-profile`,
        });
      else serverOrigin = "https://other.example";
      uploadGate.resolve();
      await posting;
      assert.equal(actions.identityChanged(), true);
      assert.deepEqual(requests, [{ path: "/api/media/upload", origin }]);
      assert.equal(actions.recovery().record, null);
      assert.equal(acknowledged, 0);
      assert.equal(closed, 0);
    } else {
      if (scenario === "actor-before-post")
        store.set(actorAtom, {
          ...owner,
          ap_id: `${origin}/ap/users/other-profile`,
        });
      else if (scenario === "instance-before-post")
        store.set(selectedInstanceIdAtom, "different-server");
      else if (scenario === "logout-before-post")
        store.set(logoutBusyAtom, true);
      else if (scenario === "hosted-user-before-post")
        store.set(hostedUserAtom, { id: "different-hosted-user" });
      else throw new Error(`Unknown scenario: ${scenario}`);
      assert.equal(actions.identityChanged(), true);
      // Returning to the original account/server cannot revive the old draft.
      store.set(actorAtom, owner);
      store.set(selectedInstanceIdAtom, null);
      store.set(logoutBusyAtom, false);
      store.set(hostedUserAtom, null);
      assert.equal(actions.editingLocked(), true);
      await actions.handlePost();
      assert.equal(requests.length, 0);
    }
  }
  console.log(JSON.stringify({ scenario, passed: true }));
} finally {
  dispose();
}
