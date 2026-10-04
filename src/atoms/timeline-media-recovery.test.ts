import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import { getYurucommuApiTransport } from "@takosjp/yurucommu-api";
import type { Actor, Post } from "../types/index.ts";
import type { UploadedMedia } from "../components/timeline/types.ts";
import type { MediaUploadScope } from "../lib/staged-media.ts";

type Draft = {
  content: string;
  summary: string;
  visibility: "public" | "unlisted" | "followers" | "direct";
};

type ExtraMedia = UploadedMedia & {
  sourceFile?: File;
  uploadId?: string;
  expires_at?: string;
  needsReupload?: boolean;
  uploadScope?: MediaUploadScope;
};

type Modules = {
  timeline: typeof import("./timeline.ts");
  auth: typeof import("./auth.ts");
  plugin: typeof import("../lib/plugin.ts");
};

const owner: Actor = {
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

const draft: Draft = {
  content: "saved words",
  summary: "content warning",
  visibility: "followers",
};

function postResponse(id: string, content: string): Response {
  const post: Post = {
    ap_id: `https://example.test/ap/objects/${id}`,
    type: "Note",
    author: owner,
    content,
    summary: draft.summary,
    attachments: [],
    in_reply_to: null,
    visibility: draft.visibility,
    community_ap_id: null,
    like_count: 0,
    reply_count: 0,
    announce_count: 0,
    published: new Date().toISOString(),
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  };
  return Response.json({ post }, { status: 201 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

class TestStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

async function withHarness(
  run: (h: {
    modules: Modules;
    store: ReturnType<typeof createStore>;
    storage: TestStorage;
    uploads: File[];
    postBodies: Record<string, unknown>[];
    setUploadResponse: (response: () => Promise<Response>) => void;
    setPostResponse: (
      response: (body: Record<string, unknown>) => Promise<Response>,
    ) => void;
  }) => Promise<void>,
) {
  const globals = ["localStorage", "navigator", "fetch"] as const;
  const descriptors = new Map(
    globals.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const urlMethods = ["createObjectURL", "revokeObjectURL"] as const;
  const urlDescriptors = new Map(
    urlMethods.map((key) => [key, Object.getOwnPropertyDescriptor(URL, key)]),
  );
  const storage = new TestStorage();
  const uploads: File[] = [];
  const postBodies: Record<string, unknown>[] = [];
  let uploadResponse: (() => Promise<Response>) | null = null;
  let postResponseForRequest:
    ((body: Record<string, unknown>) => Promise<Response>) | null = null;
  let previewId = 0;
  let plugin: Modules["plugin"] | null = null;
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { language: "en-US" },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: () => `blob:test-${++previewId}`,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/media/upload")) {
          const body = init?.body;
          if (body instanceof FormData) {
            const file = body.get("file");
            if (file instanceof File) uploads.push(file);
          }
          if (!uploadResponse)
            throw new Error("Upload responder was not configured");
          return uploadResponse();
        }
        if (url.endsWith("/api/posts")) {
          const body =
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : {};
          postBodies.push(body);
          if (!postResponseForRequest)
            throw new Error("Post responder was not configured");
          return postResponseForRequest(body);
        }
        throw new Error(`Unexpected test request: ${url}`);
      }) as typeof fetch,
    });

    plugin = await import("../lib/plugin.ts");
    plugin.clearYurucommuFrontendPlugin();
    const [timeline, auth] = await Promise.all([
      import("./timeline.ts"),
      import("./auth.ts"),
    ]);
    const modules = { timeline, auth, plugin };
    await run({
      modules,
      store: createStore(),
      storage,
      uploads,
      postBodies,
      setUploadResponse: (response) => {
        uploadResponse = response;
      },
      setPostResponse: (response) => {
        postResponseForRequest = response;
      },
    });
  } finally {
    plugin?.clearYurucommuFrontendPlugin();
    for (const key of globals) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    for (const key of urlMethods) {
      const descriptor = urlDescriptors.get(key);
      if (descriptor) Object.defineProperty(URL, key, descriptor);
      else Reflect.deleteProperty(URL, key);
    }
  }
}

function imageFile(name = "source.png", bytes = [7, 11, 19]): File {
  return new File([new Uint8Array(bytes)], name, {
    type: "image/png",
    lastModified: 123,
  });
}

function uploadJson(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    url: "https://media.example.test/fresh.png",
    r2_key: "posts/fresh.png",
    content_type: "image/png",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

function seedDraft(store: ReturnType<typeof createStore>, modules: Modules) {
  store.set(modules.auth.actorAtom, owner);
  store.set(modules.timeline.postContentAtom, draft.content);
  store.set(modules.timeline.postSummaryAtom, draft.summary);
  store.set(modules.timeline.postVisibilityAtom, draft.visibility);
}

function media(key: string, overrides: Partial<ExtraMedia> = {}): ExtraMedia {
  return {
    url: `https://media.example.test/${key}`,
    r2_key: key,
    content_type: "image/png",
    preview: `blob:${key}`,
    name: `alt ${key}`,
    sourceFile: imageFile(`${key}.png`),
    uploadId: `upload-${key}`,
    ...overrides,
  };
}

function currentScope(
  store: ReturnType<typeof createStore>,
  modules: Modules,
): MediaUploadScope {
  const transport = getYurucommuApiTransport();
  return {
    actorApId: owner.ap_id,
    authEpoch: store.get(modules.auth.authSessionEpochAtom),
    instanceId: store.get(modules.auth.selectedInstanceIdAtom),
    hostedUserId: store.get(modules.auth.hostedUserAtom)?.id ?? null,
    strategy: modules.plugin.getAuthStrategy(),
    transport,
    uploadUrl: transport.resolveUrl("/api/media/upload"),
    postUrl: transport.resolveUrl("/api/posts"),
  };
}

test("upload stages source bytes and wire expiry in memory without persisting Files", async () => {
  await withHarness(
    async ({ modules, store, storage, uploads, setUploadResponse }) => {
      seedDraft(store, modules);
      const expiresAt = new Date(Date.now() + 120_000).toISOString();
      setUploadResponse(async () => uploadJson({ expires_at: expiresAt }));
      const original = imageFile();

      await store.set(modules.timeline.uploadMediaAtom, original);

      const staged = store.get(
        modules.timeline.uploadedMediaAtom,
      ) as ExtraMedia[];
      expect(uploads).toHaveLength(1);
      expect(await uploads[0]!.arrayBuffer()).toEqual(
        await original.arrayBuffer(),
      );
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        r2_key: "posts/fresh.png",
        content_type: "image/png",
        expires_at: expiresAt,
        sourceFile: original,
        uploadScope: { actorApId: owner.ap_id },
      });
      expect(staged[0]?.uploadId).toEqual(expect.any(String));
      expect(staged[0]?.preview).toMatch(/^blob:test-/);
      expect([...storage.values.values()].join(" ")).not.toContain(
        "source.png",
      );
      expect(createStore().get(modules.timeline.uploadedMediaAtom)).toEqual([]);
    },
  );
});

test("a changed actor during file reading prevents the upload request", async () => {
  await withHarness(async ({ modules, store, uploads, setUploadResponse }) => {
    seedDraft(store, modules);
    setUploadResponse(async () => uploadJson());
    const file = imageFile();
    const read = deferred<ArrayBuffer>();
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: () => read.promise,
    });
    const pending = store.set(modules.timeline.uploadMediaAtom, file);
    store.set(modules.auth.actorAtom, {
      ...owner,
      ap_id: "https://example.test/ap/users/bob",
    });
    read.resolve(new Uint8Array([7, 11, 19]).buffer);

    await pending;

    expect(uploads).toHaveLength(0);
    expect(store.get(modules.timeline.uploadedMediaAtom)).toEqual([]);
  });
});

test("double selection while an upload is pending sends only one request", async () => {
  await withHarness(async ({ modules, store, uploads, setUploadResponse }) => {
    seedDraft(store, modules);
    const response = deferred<Response>();
    setUploadResponse(() => response.promise);
    const first = store.set(
      modules.timeline.uploadMediaAtom,
      imageFile("one.png"),
    );
    await Promise.resolve();
    await store.set(modules.timeline.uploadMediaAtom, imageFile("two.png"));
    response.resolve(uploadJson());
    await first;

    expect(uploads).toHaveLength(1);
    expect(
      (store.get(modules.timeline.uploadedMediaAtom) as ExtraMedia[]).map(
        (item) => item.sourceFile?.name,
      ),
    ).toEqual(["one.png"]);
  });
});

test("createPost blocks elapsed advertised expiry and permits future, absent or malformed expiry", async () => {
  const cases: { label: string; expiresAt?: string; blocked: boolean }[] = [
    {
      label: "elapsed",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      blocked: true,
    },
    { label: "malformed", expiresAt: "tomorrow-ish", blocked: false },
    {
      label: "future",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      blocked: false,
    },
    { label: "missing", blocked: false },
  ];
  for (const scenario of cases) {
    await withHarness(
      async ({ modules, store, postBodies, setPostResponse }) => {
        seedDraft(store, modules);
        store.set(modules.timeline.uploadedMediaAtom, [
          media(scenario.label, { expires_at: scenario.expiresAt }),
        ]);
        setPostResponse(async () =>
          postResponse(`expiry-${scenario.label}`, draft.content),
        );
        const result = await store.set(modules.timeline.createPostAtom, draft);

        expect(result, scenario.label).toBe(!scenario.blocked);
        expect(postBodies, scenario.label).toHaveLength(
          scenario.blocked ? 0 : 1,
        );
        if (scenario.blocked) {
          expect(store.get(modules.timeline.uploadedMediaAtom)).toHaveLength(1);
          expect(store.get(modules.timeline.postContentAtom)).toBe(
            draft.content,
          );
          expect(store.get(modules.timeline.postSummaryAtom)).toBe(
            draft.summary,
          );
          expect(store.get(modules.timeline.postVisibilityAtom)).toBe(
            draft.visibility,
          );
        }
      },
    );
  }
});

test("MEDIA_EXPIRED marks every submitted staged item and retains the draft", async () => {
  await withHarness(async ({ modules, store, postBodies, setPostResponse }) => {
    seedDraft(store, modules);
    const before = [
      media("one", { expires_at: new Date(Date.now() + 60_000).toISOString() }),
      media("two"),
    ];
    store.set(modules.timeline.uploadedMediaAtom, before);
    setPostResponse(async () =>
      Response.json(
        { code: "MEDIA_EXPIRED", error: "Media expired" },
        { status: 409 },
      ),
    );

    expect(await store.set(modules.timeline.createPostAtom, draft)).toBe(false);

    expect(postBodies).toHaveLength(1);
    expect(
      (store.get(modules.timeline.uploadedMediaAtom) as ExtraMedia[]).map(
        (item) => item.needsReupload,
      ),
    ).toEqual([true, true]);
    expect(
      (store.get(modules.timeline.uploadedMediaAtom) as ExtraMedia[]).map(
        (item) => item.sourceFile,
      ),
    ).toEqual(before.map((item) => item.sourceFile));
    expect(store.get(modules.timeline.postContentAtom)).toBe(draft.content);
    expect(store.get(modules.timeline.postSummaryAtom)).toBe(draft.summary);
    expect(store.get(modules.timeline.postVisibilityAtom)).toBe(
      draft.visibility,
    );
  });
});

test("unrelated 409, 500, and network failure retain media without automatic retry", async () => {
  for (const failure of [
    () =>
      Response.json(
        { code: "OTHER_CONFLICT", error: "Conflict" },
        { status: 409 },
      ),
    () =>
      Response.json({ code: "SERVER_ERROR", error: "Failed" }, { status: 500 }),
    () => {
      throw new Error("network down");
    },
  ]) {
    await withHarness(
      async ({ modules, store, postBodies, setPostResponse }) => {
        seedDraft(store, modules);
        const staged = media("retained");
        store.set(modules.timeline.uploadedMediaAtom, [staged]);
        setPostResponse(async () => failure());

        expect(await store.set(modules.timeline.createPostAtom, draft)).toBe(
          false,
        );
        expect(postBodies).toHaveLength(1);
        expect(store.get(modules.timeline.uploadedMediaAtom)).toEqual([staged]);
      },
    );
  }
});

test("post submission is blocked while explicit reupload is pending", async () => {
  await withHarness(
    async ({
      modules,
      store,
      uploads,
      postBodies,
      setUploadResponse,
      setPostResponse,
    }) => {
      seedDraft(store, modules);
      store.set(modules.timeline.uploadedMediaAtom, [
        media("retry", {
          needsReupload: true,
          uploadScope: currentScope(store, modules),
        }),
      ]);
      const response = deferred<Response>();
      setUploadResponse(() => response.promise);
      setPostResponse(async () => postResponse("must-not-post", draft.content));
      const reupload = store.set(modules.timeline.reuploadMediaAtom, 0);
      await Promise.resolve();

      expect(await store.set(modules.timeline.createPostAtom, draft)).toBe(
        false,
      );
      expect(postBodies).toHaveLength(0);
      expect(uploads).toHaveLength(1);
      response.resolve(uploadJson());
      await reupload;
    },
  );
});

test("explicit reupload refreshes remote fields and manual submit uses the new key once", async () => {
  await withHarness(
    async ({
      modules,
      store,
      uploads,
      postBodies,
      setUploadResponse,
      setPostResponse,
    }) => {
      seedDraft(store, modules);
      const original = media("old-key", {
        needsReupload: true,
        name: "latest alt",
        uploadScope: currentScope(store, modules),
      });
      store.set(modules.timeline.uploadedMediaAtom, [original]);
      setUploadResponse(async () =>
        uploadJson({
          url: "https://media.example.test/replacement.png",
          r2_key: "posts/replacement.png",
          content_type: "image/png",
          expires_at: new Date(Date.now() + 180_000).toISOString(),
        }),
      );
      setPostResponse(async () => postResponse("manual-retry", draft.content));

      await store.set(modules.timeline.reuploadMediaAtom, 0);
      const updated = (
        store.get(modules.timeline.uploadedMediaAtom) as ExtraMedia[]
      )[0]!;
      expect(updated).toMatchObject({
        url: "https://media.example.test/replacement.png",
        r2_key: "posts/replacement.png",
        content_type: "image/png",
        name: "latest alt",
        sourceFile: original.sourceFile,
        preview: original.preview,
        needsReupload: false,
      });
      expect(updated.expires_at).toEqual(expect.any(String));
      expect(updated.uploadId).toBe(original.uploadId);
      expect(uploads).toHaveLength(1);
      expect(await store.set(modules.timeline.createPostAtom, draft)).toBe(
        true,
      );
      expect(postBodies).toHaveLength(1);
      expect(
        (postBodies[0]?.attachments as Record<string, unknown>[])[0],
      ).toMatchObject({ r2_key: "posts/replacement.png" });
    },
  );
});

test("alt text edited during reupload is preserved from the latest state", async () => {
  await withHarness(async ({ modules, store, setUploadResponse }) => {
    seedDraft(store, modules);
    store.set(modules.timeline.uploadedMediaAtom, [
      media("alt-race", {
        needsReupload: true,
        name: "old alt",
        uploadScope: currentScope(store, modules),
      }),
    ]);
    const response = deferred<Response>();
    setUploadResponse(() => response.promise);
    const reupload = store.set(modules.timeline.reuploadMediaAtom, 0);
    await Promise.resolve();
    store.set(modules.timeline.setMediaAltAtom, {
      index: 0,
      alt: "edited while waiting",
    });
    response.resolve(uploadJson());
    await reupload;

    expect(
      (store.get(modules.timeline.uploadedMediaAtom) as ExtraMedia[])[0]?.name,
    ).toBe("edited while waiting");
  });
});

test("removing a media item during reupload does not resurrect it", async () => {
  await withHarness(async ({ modules, store, setUploadResponse }) => {
    seedDraft(store, modules);
    store.set(modules.timeline.uploadedMediaAtom, [
      media("removed", {
        needsReupload: true,
        uploadScope: currentScope(store, modules),
      }),
    ]);
    const response = deferred<Response>();
    setUploadResponse(() => response.promise);
    const reupload = store.set(modules.timeline.reuploadMediaAtom, 0);
    await Promise.resolve();
    store.set(modules.timeline.removeMediaAtom, 0);
    response.resolve(uploadJson());
    await reupload;

    expect(store.get(modules.timeline.uploadedMediaAtom)).toEqual([]);
  });
});

test("reupload leaves other staged attachments unchanged", async () => {
  await withHarness(async ({ modules, store, setUploadResponse }) => {
    seedDraft(store, modules);
    const target = media("target", {
      needsReupload: true,
      uploadScope: currentScope(store, modules),
    });
    const bystander = media("bystander", {
      name: "keep me",
      expires_at: undefined,
    });
    store.set(modules.timeline.uploadedMediaAtom, [target, bystander]);
    setUploadResponse(async () =>
      uploadJson({ r2_key: "posts/target-fresh.png" }),
    );

    await store.set(modules.timeline.reuploadMediaAtom, 0);

    expect(
      (store.get(modules.timeline.uploadedMediaAtom) as ExtraMedia[])[1],
    ).toEqual(bystander);
  });
});

test("a real login epoch change before upload response cannot adopt uploaded media", async () => {
  await withHarness(async ({ modules, store, uploads, setUploadResponse }) => {
    seedDraft(store, modules);
    modules.plugin.registerYurucommuFrontendPlugin({
      apiVersion: 1,
      name: "epoch-test-auth",
      createAuthStrategy: () => ({
        mode: "hosted",
        checkAuth: async () => ({
          actor: owner,
          hostedUser: null,
          needsSetup: false,
          instancePending: false,
          instanceMissing: false,
          instanceBlocked: false,
          instanceHealth: null,
          instances: [],
          selectedInstanceId: null,
        }),
        login: async () => ({ success: true }),
        logout: async () => undefined,
        extractTokenFromUrl: () => false,
      }),
    });
    const response = deferred<Response>();
    setUploadResponse(() => response.promise);
    const pending = store.set(modules.timeline.uploadMediaAtom, imageFile());
    await Promise.resolve();
    expect(await store.set(modules.auth.loginAtom)).toBe(true);
    response.resolve(uploadJson());

    await pending;

    expect(uploads).toHaveLength(1);
    expect(store.get(modules.timeline.uploadedMediaAtom)).toEqual([]);
  });
});

test("changing plugin API transport during upload invalidates its result", async () => {
  await withHarness(async ({ modules, store, uploads, setUploadResponse }) => {
    seedDraft(store, modules);
    const response = deferred<Response>();
    setUploadResponse(() => response.promise);
    const pending = store.set(modules.timeline.uploadMediaAtom, imageFile());
    await Promise.resolve();
    modules.plugin.registerYurucommuFrontendPlugin({
      apiVersion: 1,
      name: "changed-transport",
      createApiTransport: () => ({
        credentials: "include",
        resolveUrl: (path) => `https://alternate.example.test${path}`,
        getAuthHeaders: () => ({}),
      }),
    });
    response.resolve(uploadJson());

    await pending;

    expect(uploads).toHaveLength(1);
    expect(store.get(modules.timeline.uploadedMediaAtom)).toEqual([]);
  });
});

test("createPost never implicitly reuploads media after MEDIA_EXPIRED", async () => {
  await withHarness(
    async ({
      modules,
      store,
      uploads,
      postBodies,
      setUploadResponse,
      setPostResponse,
    }) => {
      seedDraft(store, modules);
      store.set(modules.timeline.uploadedMediaAtom, [media("manual-only")]);
      setUploadResponse(async () => uploadJson());
      setPostResponse(async () =>
        Response.json(
          { code: "MEDIA_EXPIRED", error: "Media expired" },
          { status: 409 },
        ),
      );

      await store.set(modules.timeline.createPostAtom, draft);

      expect(postBodies).toHaveLength(1);
      expect(uploads).toHaveLength(0);
      expect(
        (store.get(modules.timeline.uploadedMediaAtom) as ExtraMedia[])[0]
          ?.needsReupload,
      ).toBe(true);
    },
  );
});

test("editing existing alt or removing another attachment does not discard a new pending upload", async () => {
  await withHarness(async ({ modules, store, setUploadResponse }) => {
    seedDraft(store, modules);
    store.set(modules.timeline.uploadedMediaAtom, [
      media("edit-me"),
      media("remove-me"),
    ]);
    const response = deferred<Response>();
    setUploadResponse(() => response.promise);
    const pending = store.set(
      modules.timeline.uploadMediaAtom,
      imageFile("new-file.png"),
    );
    await Promise.resolve();
    store.set(modules.timeline.setMediaAltAtom, { index: 0, alt: "newer alt" });
    store.set(modules.timeline.removeMediaAtom, 1);
    response.resolve(uploadJson());
    await pending;
    const items = store.get(modules.timeline.uploadedMediaAtom);
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe("newer alt");
    expect(items[1]?.sourceFile?.name).toBe("new-file.png");
  });
});

test("same hosted user refresh retains staged bytes, changed hosted identity discards them", async () => {
  await withHarness(async ({ modules, store, setUploadResponse }) => {
    seedDraft(store, modules);
    store.set(modules.auth.hostedUserAtom, {
      id: "owner-id",
      username: "first",
    });
    setUploadResponse(async () => uploadJson());
    await store.set(modules.timeline.uploadMediaAtom, imageFile());
    store.set(modules.auth.hostedUserAtom, {
      id: "owner-id",
      username: "updated",
    });
    store.set(modules.timeline.discardForeignMediaAtom);
    expect(store.get(modules.timeline.uploadedMediaAtom)).toHaveLength(1);
    store.set(modules.auth.hostedUserAtom, { id: "different-owner" });
    store.set(modules.timeline.discardForeignMediaAtom);
    expect(store.get(modules.timeline.uploadedMediaAtom)).toEqual([]);
  });
});

test("replacing a row at the same index while renewing does not overwrite the replacement", async () => {
  await withHarness(async ({ modules, store, setUploadResponse }) => {
    seedDraft(store, modules);
    const old = media("old", {
      needsReupload: true,
      uploadScope: currentScope(store, modules),
    });
    store.set(modules.timeline.uploadedMediaAtom, [old]);
    const response = deferred<Response>();
    setUploadResponse(() => response.promise);
    const pending = store.set(modules.timeline.reuploadMediaAtom, 0);
    await Promise.resolve();
    const replacement = media("replacement", {
      uploadScope: currentScope(store, modules),
    });
    store.set(modules.timeline.uploadedMediaAtom, [replacement]);
    response.resolve(uploadJson());
    await pending;
    expect(store.get(modules.timeline.uploadedMediaAtom)).toEqual([
      replacement,
    ]);
  });
});
