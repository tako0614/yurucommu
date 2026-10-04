import { afterEach, expect, test } from "bun:test";
import { createStory } from "./api.ts";
import { ApiError } from "./api/fetch.ts";
import {
  canRenewStoryMedia,
  createStoryIntentCoordinator,
  isExpiredStoryMedia,
  storyMediaExpired,
  type StoryCreatePayload,
  type StoryIntentRecord,
  type StoryIntentScope,
  type StoryIntentStorage,
} from "./story-intent.ts";

const scope: StoryIntentScope = {
  origin: "https://social.example",
  principal: "https://social.example/ap/users/owner",
};
const initialPayload: StoryCreatePayload = {
  attachment: {
    url: "/media/old.jpg",
    r2_key: "uploads/old.jpg",
    content_type: "image/jpeg",
  },
  caption: " hello ",
  displayDuration: "PT5S",
  overlays: [
    {
      type: "Note",
      name: "Keep this text",
      position: { x: 0.5, y: 0.5, width: 0.4, height: 0.2 },
    },
  ],
};
const now = Date.now();
const past = new Date(now - 24 * 60 * 60 * 1000).toISOString();
const future = new Date(now + 24 * 60 * 60 * 1000).toISOString();
const expired = () =>
  new ApiError(409, "The uploaded media expired", {
    code: "MEDIA_EXPIRED",
  });
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

class Store implements StoryIntentStorage {
  values = new Map<string, string>();
  denyRead = false;
  denyWrite = false;
  partialWrite = false;

  getItem(key: string) {
    if (this.denyRead) throw new Error("read denied");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.denyWrite) throw new Error("write denied");
    if (this.partialWrite) {
      this.values.set(key, value.slice(0, -1));
      return;
    }
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function acknowledge(payload: StoryCreatePayload, suffix = "new") {
  return {
    ap_id: `https://social.example/ap/objects/story-${suffix}`,
    author: { ap_id: scope.principal },
    attachment: {
      type: payload.attachment.content_type.startsWith("video/")
        ? "Video"
        : "Document",
      url: payload.attachment.url,
      r2_key: payload.attachment.r2_key,
      mediaType: payload.attachment.content_type,
    },
    caption: payload.caption?.trim(),
    displayDuration: payload.displayDuration,
    overlays: payload.overlays,
    published: "2026-10-02T00:00:00.000Z",
    end_time: "2026-10-03T00:00:00.000Z",
  };
}

function ready(store = new Store()) {
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(initialPayload);
  return { intent, store };
}

function storedRecord(intent: ReturnType<typeof createStoryIntentCoordinator>) {
  const record = intent.read().record;
  if (!record) throw new Error("Expected a persisted Story intent");
  return record;
}

function seed(record: Record<string, unknown>) {
  const store = new Store();
  const coordinator = createStoryIntentCoordinator(scope, store);
  store.values.set(coordinator.key, JSON.stringify(record));
  return { store, coordinator: createStoryIntentCoordinator(scope, store) };
}

function legacyRecord(
  status: StoryIntentRecord["status"],
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    intentId: "12345678-1234-4234-8234-123456789012",
    origin: scope.origin,
    principal: scope.principal,
    endpoint: `${scope.origin}/api/stories`,
    status,
    payload: initialPayload,
    ...overrides,
  };
}

test("only the SDK 409 MEDIA_EXPIRED discriminator identifies expired Story media", () => {
  expect(isExpiredStoryMedia(expired())).toBe(true);
  expect(isExpiredStoryMedia(new ApiError(409, "Conflict"))).toBe(false);
  expect(
    isExpiredStoryMedia(
      new ApiError(409, "Conflict", { code: "OTHER_CONFLICT" }),
    ),
  ).toBe(false);
  expect(
    isExpiredStoryMedia(
      new ApiError(503, "Unavailable", { code: "MEDIA_EXPIRED" }),
    ),
  ).toBe(false);
  expect(isExpiredStoryMedia(new TypeError("network"))).toBe(false);
});

test("the actual published SDK propagates HTTP expiry and preserves earlier unknown writes", async () => {
  for (const earlierUnknown of [false, true]) {
    const { intent, store } = ready();
    const requests: StoryCreatePayload[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input).endsWith("/api/stories")).toBe(true);
        expect(init?.method).toBe("POST");
        requests.push(JSON.parse(String(init?.body)));
        if (earlierUnknown && requests.length === 1)
          throw new TypeError("connection lost after write");
        return Response.json(
          { error: "Media expired", code: "MEDIA_EXPIRED" },
          { status: 409 },
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    if (earlierUnknown) {
      expect((await intent.submit(createStory)).kind).toBe("unconfirmed");
    }
    const reloaded = createStoryIntentCoordinator(scope, store);
    const result = earlierUnknown
      ? await reloaded.retry(createStory)
      : await reloaded.submit(createStory);
    expect(requests).toEqual(
      earlierUnknown ? [initialPayload, initialPayload] : [initialPayload],
    );
    expect(result.error).toBeInstanceOf(ApiError);
    expect(result.error).toMatchObject({ status: 409, code: "MEDIA_EXPIRED" });
    expect(result.kind).toBe(earlierUnknown ? "unconfirmed" : "rejected");
    expect(canRenewStoryMedia(result.record, now)).toBe(!earlierUnknown);
  }
});

test("first stage rejects malformed advertised expiry and never sends", async () => {
  const intent = createStoryIntentCoordinator(scope, new Store());
  expect(intent.stage(initialPayload, "invalid")).toEqual({
    record: null,
    failed: true,
  });
  let sends = 0;
  expect(
    (
      await intent.submit(async () => {
        sends++;
        return acknowledge(initialPayload);
      })
    ).kind,
  ).toBe("blocked");
  expect(sends).toBe(0);
});

test("a failed first stage cannot silently drop its advertised deadline", async () => {
  const store = new Store();
  store.denyWrite = true;
  const intent = createStoryIntentCoordinator(scope, store);
  const old = intent.stage(initialPayload, future);
  store.denyWrite = false;
  expect(intent.stage(initialPayload)).toEqual(old);
  expect(store.values.size).toBe(0);
  expect(intent.stage(initialPayload, future).failed).toBe(false);
});

test("an exact expiry rejection preserves the old payload and enables safe renewal", async () => {
  const { intent, store } = ready();
  const result = await intent.submit(async () => {
    throw expired();
  });

  expect(result.kind).toBe("rejected");
  expect(result.record?.status).toBe("rejected");
  expect(result.record?.failureCode).toBe("MEDIA_EXPIRED");
  expect(result.record?.writeHistory).toBe("no-unknown");
  expect(result.record?.payload).toEqual(initialPayload);
  const reloaded = createStoryIntentCoordinator(scope, store).read().record;
  expect(reloaded).toEqual(result.record);
  expect(canRenewStoryMedia(reloaded, now)).toBe(true);
});

test("manual replacement keeps story metadata, adopts new references and waits for explicit submit", async () => {
  const { intent } = ready();
  await intent.submit(async () => {
    throw expired();
  });
  const old = storedRecord(intent);
  let posts = 0;
  const replacement = intent.replaceExpiredAttachment(
    old,
    {
      url: "/media/new.jpg",
      r2_key: "uploads/new.jpg",
      content_type: "image/jpeg",
    },
    future,
    now,
  );

  expect(replacement.failed).toBe(false);
  expect(posts).toBe(0);
  expect(replacement.record).toMatchObject({
    status: "ready",
    writeHistory: "no-unknown",
    mediaExpiresAt: future,
    payload: {
      ...initialPayload,
      attachment: {
        url: "/media/new.jpg",
        r2_key: "uploads/new.jpg",
        content_type: "image/jpeg",
      },
    },
  });
  expect(replacement.record?.intentId).not.toBe(old.intentId);

  const result = await intent.submit(async (payload) => {
    posts++;
    expect(payload.attachment).toEqual({
      url: "/media/new.jpg",
      r2_key: "uploads/new.jpg",
      content_type: "image/jpeg",
    });
    return acknowledge(payload);
  });
  expect(result.kind).toBe("confirmed");
  expect(posts).toBe(1);
});

test("unknown write history stays unknown after reload and later expiry or ordinary rejection", async () => {
  for (const laterError of [expired(), new ApiError(400, "Invalid")]) {
    const { intent, store } = ready();
    expect(
      (
        await intent.submit(async () => {
          throw new TypeError("connection closed after sending");
        })
      ).kind,
    ).toBe("unconfirmed");

    const reloaded = createStoryIntentCoordinator(scope, store);
    expect(reloaded.read().record?.writeHistory).toBe("has-unknown");
    const later = await reloaded.retry(async () => {
      throw laterError;
    });
    expect(later.kind).toBe("unconfirmed");
    expect(later.record?.status).toBe("unconfirmed");
    expect(later.record?.writeHistory).toBe("has-unknown");
    expect(later.record?.failureCode).toBeUndefined();
    expect(canRenewStoryMedia(later.record, now)).toBe(false);
    expect(
      reloaded.replaceExpiredAttachment(
        later.record!,
        {
          url: "/media/another.jpg",
          r2_key: "uploads/another.jpg",
          content_type: "image/jpeg",
        },
        future,
        now,
      ).record?.payload.attachment.r2_key,
    ).toBe("uploads/old.jpg");
  }
});

test("malformed ACK after an attempt remains unknown across reload", async () => {
  const { intent, store } = ready();
  const result = await intent.submit(async () => ({
    story: acknowledge(initialPayload),
  }));
  expect(result.kind).toBe("unconfirmed");
  expect(result.record?.writeHistory).toBe("has-unknown");

  const reloaded = createStoryIntentCoordinator(scope, store);
  expect(reloaded.read().record?.status).toBe("unconfirmed");
  expect(canRenewStoryMedia(reloaded.read().record, now)).toBe(false);
});

test("an advertised deadline blocks first submit and retry once elapsed", async () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  const staged = intent.stage(initialPayload, past);
  expect(staged.record?.mediaExpiresAt).toBe(past);
  expect(storyMediaExpired(staged.record, now)).toBe(true);
  let sends = 0;
  expect(
    (
      await intent.submit(async () => {
        sends++;
        return acknowledge(initialPayload);
      })
    ).kind,
  ).toBe("blocked");
  expect(sends).toBe(0);

  const retryIntent = createStoryIntentCoordinator(scope, new Store());
  retryIntent.stage(initialPayload, future);
  await retryIntent.submit(async () => {
    throw new ApiError(400, "Invalid");
  });
  // Simulate recovery after the advertised deadline has elapsed. Renewal is
  // deliberately not involved: an unexpired ordinary rejection cannot renew.
  const { coordinator: elapsedRetry } = seed({
    ...storedRecord(retryIntent),
    mediaExpiresAt: past,
  });
  expect(
    (
      await elapsedRetry.retry(async () => {
        sends++;
        return acknowledge(initialPayload);
      })
    ).kind,
  ).toBe("blocked");
  expect(sends).toBe(0);
});

test("an elapsed ready record permits manual replacement before its first POST", async () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  const staged = intent.stage(initialPayload, past);
  expect(canRenewStoryMedia(staged.record, now)).toBe(true);
  let sends = 0;
  const replaced = intent.replaceExpiredAttachment(
    staged.record!,
    {
      url: "/media/recovered.jpg",
      r2_key: "uploads/recovered.jpg",
      content_type: "image/jpeg",
    },
    undefined,
    now,
  );
  expect(replaced.record?.status).toBe("ready");
  expect(replaced.record?.payload.attachment.r2_key).toBe(
    "uploads/recovered.jpg",
  );
  expect(sends).toBe(0);
});

test("invalid or elapsed replacement deadlines and reused storage keys are rejected", async () => {
  const { intent } = ready();
  await intent.submit(async () => {
    throw expired();
  });
  const old = storedRecord(intent);
  const nextAttachment = {
    url: "/media/next.jpg",
    r2_key: "uploads/next.jpg",
    content_type: "image/jpeg",
  };
  for (const deadline of ["invalid", past]) {
    expect(
      intent.replaceExpiredAttachment(old, nextAttachment, deadline, now).record
        ?.intentId,
    ).toBe(old.intentId);
  }
  expect(
    intent.replaceExpiredAttachment(
      old,
      { ...nextAttachment, r2_key: old.payload.attachment.r2_key },
      future,
      now,
    ).record?.intentId,
  ).toBe(old.intentId);
});

test("stale expected snapshots and externally changed storage are not overwritten", async () => {
  const { intent, store } = ready();
  await intent.submit(async () => {
    throw expired();
  });
  const old = storedRecord(intent);
  const stale = { ...old, payload: { ...old.payload, caption: "stale" } };
  expect(
    intent.replaceExpiredAttachment(
      stale,
      {
        url: "/media/stale.jpg",
        r2_key: "uploads/stale.jpg",
        content_type: "image/jpeg",
      },
      future,
      now,
    ).record?.payload.attachment.r2_key,
  ).toBe("uploads/old.jpg");

  const latest = createStoryIntentCoordinator(scope, store);
  const key = latest.key;
  const foreign = JSON.stringify({ changed: "outside this coordinator" });
  store.values.set(key, foreign);
  const result = latest.replaceExpiredAttachment(
    old,
    {
      url: "/media/foreign.jpg",
      r2_key: "uploads/foreign.jpg",
      content_type: "image/jpeg",
    },
    future,
    now,
  );
  expect(result.failed).toBe(true);
  expect(store.values.get(key)).toBe(foreign);
});

test("replacement write, readback and partial-write failures retain the old locked record", async () => {
  for (const fault of ["denyWrite", "denyRead", "partialWrite"] as const) {
    const store = new Store();
    const intent = createStoryIntentCoordinator(scope, store);
    intent.stage(initialPayload);
    await intent.submit(async () => {
      throw expired();
    });
    const old = storedRecord(intent);
    store[fault] = true;
    const result = intent.replaceExpiredAttachment(
      old,
      {
        url: "/media/unpersisted.jpg",
        r2_key: "uploads/unpersisted.jpg",
        content_type: "image/jpeg",
      },
      future,
      now,
    );
    expect(result.failed).toBe(true);
    expect(result.record?.intentId).toBe(old.intentId);
    expect(result.record?.payload.attachment).toEqual(old.payload.attachment);
    let sends = 0;
    expect(
      (
        await intent.submit(async () => {
          sends++;
          return acknowledge(initialPayload);
        })
      ).kind,
    ).toBe("blocked");
    expect(sends).toBe(0);
    if (fault === "partialWrite") {
      store.partialWrite = false;
      const damagedBytes = store.values.get(intent.key);
      const reloaded = createStoryIntentCoordinator(scope, store);
      expect(reloaded.read()).toEqual({ record: null, failed: true });
      expect(
        (
          await reloaded.submit(async () => {
            sends++;
            return acknowledge(initialPayload);
          })
        ).kind,
      ).toBe("blocked");
      expect(store.values.get(intent.key)).toBe(damagedBytes);
      expect(sends).toBe(0);
    }
  }
});

test("pending reload and legacy unknown or rejected records cannot renew media", () => {
  const pending = legacyRecord("pending");
  const pendingSeed = seed(pending);
  const pendingRecord = pendingSeed.coordinator.read().record;
  expect(pendingRecord?.status).toBe("unconfirmed");
  expect(pendingRecord?.writeHistory).toBe("has-unknown");
  expect(canRenewStoryMedia(pendingRecord, now)).toBe(false);

  const unknown = legacyRecord("unconfirmed");
  const unknownRecord = seed(unknown).coordinator.read().record;
  expect(unknownRecord?.writeHistory).toBe("has-unknown");
  expect(canRenewStoryMedia(unknownRecord, now)).toBe(false);

  const legacyRejected = legacyRecord("rejected");
  const rejectedRecord = seed(legacyRejected).coordinator.read().record;
  expect(rejectedRecord?.status).toBe("unconfirmed");
  expect(rejectedRecord?.writeHistory).toBe("has-unknown");
  expect(canRenewStoryMedia(rejectedRecord, now)).toBe(false);

  const legacyReady = legacyRecord("ready");
  const readyRecord = seed(legacyReady).coordinator.read().record;
  expect(readyRecord?.writeHistory).toBe("no-unknown");
  expect(canRenewStoryMedia(readyRecord, now)).toBe(false);
});

test("legacy ready with an elapsed advertised deadline can renew safely", () => {
  const legacyReady = legacyRecord("ready", { mediaExpiresAt: past });
  const record = seed(legacyReady).coordinator.read().record;
  expect(record?.writeHistory).toBe("no-unknown");
  expect(canRenewStoryMedia(record, now)).toBe(true);
});

test("forged expiry markers, incompatible histories and malformed deadlines fail closed", async () => {
  const forged = [
    legacyRecord("ready", { failureCode: "MEDIA_EXPIRED" }),
    legacyRecord("rejected", { failureCode: "MEDIA_EXPIRED" }),
    legacyRecord("unconfirmed", {
      failureCode: "MEDIA_EXPIRED",
      writeHistory: "has-unknown",
    }),
    legacyRecord("ready", { mediaExpiresAt: "yesterday" }),
    legacyRecord("ready", { mediaExpiresAt: 123 }),
    legacyRecord("ready", { writeHistory: "maybe" }),
    legacyRecord("ready", { writeHistory: "has-unknown" }),
    legacyRecord("rejected", {
      failureCode: "MEDIA_EXPIRED",
      writeHistory: "has-unknown",
    }),
  ];
  for (const record of forged) {
    const { coordinator, store } = seed(record);
    const originalBytes = store.values.get(coordinator.key);
    expect(coordinator.read()).toEqual({ record: null, failed: true });
    let sends = 0;
    expect(
      (
        await coordinator.submit(async () => {
          sends++;
          return acknowledge(initialPayload);
        })
      ).kind,
    ).toBe("blocked");
    expect(sends).toBe(0);
    expect(store.values.get(coordinator.key)).toBe(originalBytes);
  }
});

test("staging journals only rendered references and metadata, never File or unknown fields", () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  const file = new File(["private bytes"], "secret.jpg", {
    type: "image/jpeg",
  });
  const augmented = {
    ...initialPayload,
    localFile: file,
    privateBlob: new Blob(["private bytes"]),
    attachment: {
      ...initialPayload.attachment,
      file,
      uploadToken: "private-token",
    },
  } as unknown as StoryCreatePayload;

  const staged = intent.stage(augmented);
  expect(staged.failed).toBe(false);
  expect(staged.record?.payload).toEqual(initialPayload);
  const saved = store.values.get(intent.key)!;
  expect(saved).not.toContain("secret.jpg");
  expect(saved).not.toContain("private-token");
  expect(saved).not.toContain("private bytes");
  expect(saved).not.toContain("localFile");
});
