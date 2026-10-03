import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import { postDraftWriteFailedAtom } from "./post-draft.ts";
import type { Actor, Post } from "../types/index.ts";
import type { UploadedMedia } from "../components/timeline/types.ts";

const DRAFT_KEYS = {
  content: "compose.draft.content",
  summary: "compose.draft.summary",
  visibility: "compose.draft.visibility",
} as const;
const json = (value: unknown): string => JSON.stringify(value) as string;

class TestStorage implements Storage {
  readonly values = new Map<string, string>();
  writeAttempts = 0;
  failOnWriteAttempt: number | null = null;
  denyReads = false;

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    if (this.denyReads) throw new Error("storage read denied");
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.writeAttempts += 1;
    if (this.writeAttempts === this.failOnWriteAttempt) {
      throw new Error("storage write denied");
    }
    this.values.set(key, value);
  }
}

type Draft = {
  content: string;
  summary: string;
  visibility: "public" | "unlisted" | "followers" | "direct";
};
const jsonForDraft = (draft: Draft): Record<string, string> => ({
  [DRAFT_KEYS.content]: json(draft.content),
  [DRAFT_KEYS.summary]: json(draft.summary),
  [DRAFT_KEYS.visibility]: json(draft.visibility),
});

function putRawDraft(storage: TestStorage, draft: Draft): void {
  for (const [key, value] of Object.entries(jsonForDraft(draft)))
    storage.values.set(key, value);
}

function actor(): Actor {
  return {
    ap_id: "https://example.test/ap/users/alice",
    username: "alice@example.test",
    preferred_username: "alice",
    name: "Alice",
    summary: null,
    icon_url: null,
    header_url: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function postResponse(
  postId: string,
  authorApId: string,
  content: string,
  attachments: Post["attachments"] = [],
): Response {
  const post: Post = {
    ap_id: `https://example.test/ap/objects/${postId}`,
    type: "Note",
    author: { ...actor(), ap_id: authorApId },
    content,
    summary: null,
    attachments,
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 0,
    reply_count: 0,
    announce_count: 0,
    published: "2026-10-02T00:00:00.000Z",
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  };
  return new Response(JSON.stringify({ post }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type HarnessModules = {
  timeline: typeof import("./timeline.ts");
  auth: typeof import("./auth.ts");
  plugin: typeof import("../lib/plugin.ts");
};

async function withCreatePostHarness(
  run: (harness: {
    storage: TestStorage;
    modules: HarnessModules;
    store: ReturnType<typeof createStore>;
    requestBodies: Record<string, unknown>[];
    setResponder: (
      responder: (body: Record<string, unknown>) => Promise<Response>,
    ) => void;
  }) => Promise<void>,
): Promise<void> {
  const keys = ["localStorage", "navigator", "fetch"] as const;
  const descriptors = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const storage = new TestStorage();
  const requestBodies: Record<string, unknown>[] = [];
  let responder: ((body: Record<string, unknown>) => Promise<Response>) | null =
    null;

  let plugin: HarnessModules["plugin"] | null = null;
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      enumerable: descriptors.get("localStorage")?.enumerable ?? true,
      writable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      enumerable: descriptors.get("navigator")?.enumerable ?? true,
      writable: true,
      value: { language: "en-US" },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      enumerable: descriptors.get("fetch")?.enumerable ?? true,
      writable: true,
      value: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.endsWith("/api/posts"))
          throw new Error(`Unexpected test request: ${url}`);
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};
        requestBodies.push(body);
        if (!responder) throw new Error("Post responder was not configured");
        return responder(body);
      }) as typeof fetch,
    });

    plugin = await import("../lib/plugin.ts");
    plugin.clearYurucommuFrontendPlugin();
    const [timeline, auth] = await Promise.all([
      import("./timeline.ts"),
      import("./auth.ts"),
    ]);
    await run({
      storage,
      modules: { timeline, auth, plugin },
      store: createStore(),
      requestBodies,
      setResponder: (value) => {
        responder = value;
      },
    });
  } finally {
    plugin?.clearYurucommuFrontendPlugin();
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function stageDraft(
  store: ReturnType<typeof createStore>,
  timeline: HarnessModules["timeline"],
  auth: HarnessModules["auth"],
  draft: Draft,
  media: UploadedMedia[],
): void {
  store.set(auth.actorAtom, actor());
  store.set(timeline.postContentAtom, draft.content);
  store.set(timeline.postSummaryAtom, draft.summary);
  store.set(timeline.postVisibilityAtom, draft.visibility);
  store.set(timeline.uploadedMediaAtom, media);
  store.set(timeline.showPostModalAtom, true);
}

const sampleMedia: UploadedMedia[] = [
  {
    url: "https://media.example.test/already-uploaded.png",
    r2_key: "posts/already-uploaded.png",
    content_type: "image/png",
    preview: "blob:local-preview",
    name: "already-uploaded.png",
  },
];

test("createPost ACK refreshes a newer raw-only draft and retains staged media", async () => {
  await withCreatePostHarness(
    async ({
      storage,
      modules: { timeline, auth },
      store,
      requestBodies,
      setResponder,
    }) => {
      const submitted: Draft = {
        content: "submitted body",
        summary: "submitted warning",
        visibility: "followers",
      };
      const newer: Draft = {
        content: "newer other-tab body",
        summary: "newer warning",
        visibility: "unlisted",
      };
      stageDraft(store, timeline, auth, submitted, sampleMedia);
      let resolveResponse!: (response: Response) => void;
      const heldResponse = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      let requestArrived!: () => void;
      const arrived = new Promise<void>((resolve) => {
        requestArrived = resolve;
      });
      setResponder(async () => {
        requestArrived();
        return heldResponse;
      });

      const writesBeforeAck = storage.writeAttempts;
      const resultPromise = store.set(timeline.createPostAtom, submitted);
      await arrived;
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]).toMatchObject({
        content: submitted.content,
        summary: submitted.summary,
        visibility: submitted.visibility,
        attachments: [
          {
            r2_key: sampleMedia[0].r2_key,
            content_type: sampleMedia[0].content_type,
          },
        ],
      });
      putRawDraft(storage, newer);
      const writesAfterRawChange = storage.writeAttempts;
      resolveResponse(
        postResponse(
          "ack-1",
          actor().ap_id,
          submitted.content,
          sampleMedia.map(({ preview: _preview, ...attachment }) => attachment),
        ),
      );

      expect(await resultPromise).toBe(false);
      expect(storage.writeAttempts).toBe(writesAfterRawChange);
      expect(writesAfterRawChange).toBe(writesBeforeAck);
      expect(store.get(timeline.postContentAtom)).toBe(newer.content);
      expect(store.get(timeline.postSummaryAtom)).toBe(newer.summary);
      expect(store.get(timeline.postVisibilityAtom)).toBe(newer.visibility);
      expect(storage.values.get(DRAFT_KEYS.content)).toBe(json(newer.content));
      expect(store.get(timeline.uploadedMediaAtom)).toEqual(sampleMedia);
      expect(store.get(timeline.postDraftRecoveryNeededAtom)).toBe(false);
      expect(store.get(timeline.postDraftNoticeAtom)).toBeTruthy();
      expect(store.get(timeline.postSubmitErrorAtom)).toBeNull();
      expect(
        store.get(timeline.timelinePostsAtom).map((post) => post.ap_id),
      ).toEqual(["https://example.test/ap/objects/ack-1"]);
    },
  );
});

test("unreadable raw draft after ACK blocks resend and close until explicit recovery", async () => {
  await withCreatePostHarness(
    async ({
      storage,
      modules: { timeline, auth },
      store,
      requestBodies,
      setResponder,
    }) => {
      const submitted: Draft = {
        content: "known committed body",
        summary: "warning",
        visibility: "direct",
      };
      stageDraft(store, timeline, auth, submitted, sampleMedia);
      let resolveResponse!: (response: Response) => void;
      const heldResponse = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      let requestArrived!: () => void;
      const arrived = new Promise<void>((resolve) => {
        requestArrived = resolve;
      });
      setResponder(async () => {
        requestArrived();
        return heldResponse;
      });

      const firstSubmit = store.set(timeline.createPostAtom, submitted);
      await arrived;
      storage.denyReads = true;
      resolveResponse(
        postResponse("ack-read-failed", actor().ap_id, submitted.content),
      );
      expect(await firstSubmit).toBe(false);
      expect(store.get(timeline.postDraftRecoveryNeededAtom)).toBe(true);
      expect(store.get(timeline.postContentAtom)).toBe(submitted.content);
      expect(store.get(timeline.uploadedMediaAtom)).toEqual(sampleMedia);
      expect(store.get(timeline.postSubmitErrorAtom)).toBeNull();

      const writesBeforeBlockedActions = storage.writeAttempts;
      expect(await store.set(timeline.createPostAtom, submitted)).toBe(false);
      store.set(timeline.closePostModalAtom);
      expect(requestBodies).toHaveLength(1);
      expect(storage.writeAttempts).toBe(writesBeforeBlockedActions);
      expect(store.get(timeline.showPostModalAtom)).toBe(true);
      store.set(timeline.hideRetainedPostModalAtom);
      expect(store.get(timeline.showPostModalAtom)).toBe(false);
      expect(store.get(timeline.postContentAtom)).toBe(submitted.content);
      expect(store.get(timeline.uploadedMediaAtom)).toEqual(sampleMedia);
      store.set(timeline.showPostModalAtom, true);

      store.set(timeline.recoverPostDraftAtom);
      expect(store.get(timeline.postDraftRecoveryNeededAtom)).toBe(true);
      storage.denyReads = false;
      putRawDraft(storage, submitted);
      store.set(timeline.recoverPostDraftAtom);
      expect(store.get(timeline.postDraftRecoveryNeededAtom)).toBe(false);
      expect(store.get(timeline.postContentAtom)).toBe(submitted.content);
      expect(store.get(timeline.uploadedMediaAtom)).toEqual(sampleMedia);
    },
  );
});

test("partial ACK cleanup keeps draft and media for explicit save recovery", async () => {
  await withCreatePostHarness(
    async ({ storage, modules: { timeline, auth }, store, setResponder }) => {
      const submitted: Draft = {
        content: "keep after partial clear",
        summary: "keep warning",
        visibility: "followers",
      };
      stageDraft(store, timeline, auth, submitted, sampleMedia);
      let resolveResponse!: (response: Response) => void;
      const heldResponse = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      let requestArrived!: () => void;
      const arrived = new Promise<void>((resolve) => {
        requestArrived = resolve;
      });
      setResponder(async () => {
        requestArrived();
        return heldResponse;
      });

      const submission = store.set(timeline.createPostAtom, submitted);
      await arrived;
      storage.failOnWriteAttempt = storage.writeAttempts + 2;
      resolveResponse(
        postResponse("ack-partial-clear", actor().ap_id, submitted.content),
      );

      expect(await submission).toBe(false);
      expect(store.get(timeline.postDraftRecoveryNeededAtom)).toBe(true);
      expect(store.get(postDraftWriteFailedAtom)).toBe(true);
      expect(store.get(timeline.postSubmitErrorAtom)).toBeNull();
      expect(store.get(timeline.postContentAtom)).toBe(submitted.content);
      expect(store.get(timeline.postSummaryAtom)).toBe(submitted.summary);
      expect(store.get(timeline.postVisibilityAtom)).toBe(submitted.visibility);
      expect(store.get(timeline.uploadedMediaAtom)).toEqual(sampleMedia);
      expect(storage.values.get(DRAFT_KEYS.content)).toBe(json(""));
      expect(storage.values.get(DRAFT_KEYS.summary)).toBe(
        json(submitted.summary),
      );
      expect(storage.values.get(DRAFT_KEYS.visibility)).toBe(
        json(submitted.visibility),
      );

      store.set(timeline.recoverPostDraftAtom);
      expect(store.get(timeline.postDraftRecoveryNeededAtom)).toBe(true);
      expect(store.get(timeline.postContentAtom)).toBe(submitted.content);
      const writesBeforeExplicitSave = storage.writeAttempts;
      storage.failOnWriteAttempt = null;
      store.set(timeline.saveRecoveryPostDraftAtom);
      expect(storage.writeAttempts).toBe(writesBeforeExplicitSave + 1);
      expect(store.get(timeline.postDraftRecoveryNeededAtom)).toBe(false);
      expect(store.get(postDraftWriteFailedAtom)).toBe(false);
      expect(Object.fromEntries(storage.values)).toEqual(
        jsonForDraft(submitted),
      );
      expect(store.get(timeline.uploadedMediaAtom)).toEqual(sampleMedia);
    },
  );
});

test("closing an acknowledged composer does not overwrite a newer draft", async () => {
  await withCreatePostHarness(
    async ({ storage, modules: { timeline, auth }, store, setResponder }) => {
      const submitted: Draft = {
        content: "submitted",
        summary: "submitted cw",
        visibility: "unlisted",
      };
      const newer: Draft = {
        content: "new draft after ACK",
        summary: "new cw",
        visibility: "direct",
      };
      stageDraft(store, timeline, auth, submitted, []);
      setResponder(async () =>
        postResponse("ack-close", actor().ap_id, submitted.content),
      );

      expect(await store.set(timeline.createPostAtom, submitted)).toBe(true);
      expect(store.get(timeline.showPostModalAtom)).toBe(true);
      store.set(timeline.postContentAtom, newer.content);
      store.set(timeline.postSummaryAtom, newer.summary);
      store.set(timeline.postVisibilityAtom, newer.visibility);
      const rawBeforeClose = Object.fromEntries(storage.values);
      const writesBeforeClose = storage.writeAttempts;

      store.set(timeline.closeSubmittedPostModalAtom);

      expect(store.get(timeline.showPostModalAtom)).toBe(false);
      expect(storage.writeAttempts).toBe(writesBeforeClose);
      expect(Object.fromEntries(storage.values)).toEqual(rawBeforeClose);
      expect(Object.fromEntries(storage.values)).toEqual(jsonForDraft(newer));
    },
  );
});
