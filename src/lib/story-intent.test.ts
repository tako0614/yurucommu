import { expect, test } from "bun:test";
import { ApiError } from "./api/fetch.ts";
import {
  acknowledgesStory,
  createStoryIntentCoordinator,
  type StoryCreatePayload,
  type StoryIntentStorage,
} from "./story-intent.ts";

const scope = {
  origin: "https://social.example",
  principal: "https://social.example/ap/users/owner",
};
const payload: StoryCreatePayload = {
  attachment: {
    url: "/media/one.jpg",
    r2_key: "uploads/one.jpg",
    content_type: "image/jpeg",
  },
  caption: " hello ",
  displayDuration: "PT5S",
  overlays: [
    {
      type: "Note",
      name: "Text",
      position: { x: 0.5, y: 0.5, width: 0.4, height: 0.2 },
    },
  ],
};
const ack = () => ({
  ap_id: "https://social.example/ap/objects/story-one",
  author: { ap_id: scope.principal },
  attachment: {
    type: "Document",
    url: "/media/one.jpg",
    r2_key: "uploads/one.jpg",
    mediaType: "image/jpeg",
  },
  caption: "hello",
  displayDuration: "PT5S",
  overlays: [
    {
      position: { height: 0.2, width: 0.4, y: 0.5, x: 0.5 },
      name: "Text",
      type: "Note",
    },
  ],
  published: "2026-10-02T00:00:00.000Z",
  end_time: "2026-10-03T00:00:00.000Z",
});

class Store implements StoryIntentStorage {
  values = new Map<string, string>();
  denyRead = false;
  denyWrite = false;
  partialWrite = false;
  denyRemove = false;
  ignoreRemove = false;
  getItem(key: string) {
    if (this.denyRead) throw new Error("read denied");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.partialWrite) {
      this.values.set(key, value.slice(0, -1));
      return;
    }
    if (this.denyWrite) throw new Error("write denied");
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.denyRemove) throw new Error("remove denied");
    if (this.ignoreRemove) return;
    this.values.delete(key);
  }
}

test("stage requires exact persistence and keeps uploaded references after denied or partial writes", async () => {
  for (const fault of ["denyWrite", "partialWrite"] as const) {
    const store = new Store();
    store[fault] = true;
    const intent = createStoryIntentCoordinator(scope, store);
    const staged = intent.stage(payload);
    expect(staged.failed).toBe(true);
    expect(staged.record?.payload.attachment.r2_key).toBe("uploads/one.jpg");
    let sends = 0;
    expect(
      (
        await intent.submit(async () => {
          sends++;
          return ack();
        })
      ).kind,
    ).toBe("blocked");
    expect(sends).toBe(0);
  }
});

test("an explicit repeat stage can recover a denied write only when storage is still empty", async () => {
  const store = new Store();
  store.denyWrite = true;
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  store.denyWrite = false;
  expect(intent.stage(payload).failed).toBe(false);
  expect((await intent.submit(async () => ack())).kind).toBe("confirmed");
});

test("readback denial before POST blocks submission; caller cannot mutate stored payload", async () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  store.denyRead = true;
  let sends = 0;
  expect(
    (
      await intent.submit(async () => {
        sends++;
        return ack();
      })
    ).kind,
  ).toBe("blocked");
  expect(sends).toBe(0);
  store.denyRead = false;
  const reload = createStoryIntentCoordinator(scope, store);
  expect(reload.read().record?.status).toBe("ready");
  const result = await reload.submit(async (sent) => {
    sent.caption = "caller mutation";
    sent.attachment.r2_key = "uploads/other.jpg";
    return ack();
  });
  expect(result.kind).toBe("confirmed");
});

test("reload exposes pending as unknown and never sends automatically", async () => {
  const store = new Store();
  const first = createStoryIntentCoordinator(scope, store);
  first.stage(payload);
  let finish!: (value: unknown) => void;
  const attempt = first.submit(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const reload = createStoryIntentCoordinator(scope, store);
  expect(reload.read().record?.status).toBe("unconfirmed");
  expect((await reload.submit(async () => ack())).kind).toBe("blocked");
  finish(ack());
  await attempt;
});

test("pending prevents concurrent retries and received rejections require explicit retry", async () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  expect(
    (
      await intent.submit(async () => {
        throw new ApiError(400, "invalid");
      })
    ).kind,
  ).toBe("rejected");
  let finish!: (value: unknown) => void;
  const retry = intent.retry(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect((await intent.retry(async () => ack())).kind).toBe("blocked");
  finish(ack());
  expect((await retry).kind).toBe("confirmed");
});

test("transport, timeout, 5xx and uncertain 4xx stay unconfirmed", async () => {
  for (const error of [
    new TypeError("network"),
    new ApiError(408, "timeout"),
    new ApiError(500, "server"),
    new ApiError(409, "ambiguous"),
  ]) {
    const intent = createStoryIntentCoordinator(scope, new Store());
    intent.stage(payload);
    expect(
      (
        await intent.submit(async () => {
          throw error;
        })
      ).kind,
    ).toBe("unconfirmed");
  }
});

test("ACK must match actual local Story, media, caption, overlays and chronology", () => {
  expect(acknowledgesStory(ack(), scope, payload)).toBe(true);
  for (const changed of [
    { ap_id: "https://remote.example/ap/objects/one" },
    { ap_id: "https://social.example/ap/objects/one?token=secret" },
    { author: { ap_id: "https://social.example/ap/users/other" } },
    { attachment: { ...ack().attachment, r2_key: "uploads/two.jpg" } },
    { attachment: { ...ack().attachment, type: "Video" } },
    { caption: "changed" },
    { displayDuration: "PT8S" },
    { overlays: [] },
    { end_time: "2026-10-01T00:00:00.000Z" },
    { published: "yesterday" },
  ])
    expect(acknowledgesStory({ ...ack(), ...changed }, scope, payload)).toBe(
      false,
    );
});

test("a malformed success remains unknown and keeps the persisted intent", async () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  const result = await intent.submit(async () => ({ story: ack() }));
  expect(result.kind).toBe("unconfirmed");
  expect(createStoryIntentCoordinator(scope, store).read().record?.status).toBe(
    "unconfirmed",
  );
});

test("confirmed ACK is stored before cleanup, and denied cleanup remains locked", async () => {
  const store = new Store();
  store.denyRemove = true;
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  const result = await intent.submit(async () => ack());
  expect(result.kind).toBe("confirmed");
  expect(result.record?.status).toBe("confirmed");
  expect(result.failed).toBe(true);
  expect(createStoryIntentCoordinator(scope, store).read().record?.status).toBe(
    "confirmed",
  );
  expect((await intent.retry(async () => ack())).kind).toBe("blocked");
});

test("ACK plus denied confirmed write stays confirmed and locked in memory", async () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  const result = await intent.submit(async () => {
    store.denyWrite = true;
    return ack();
  });
  expect(result.kind).toBe("confirmed");
  expect(result.failed).toBe(true);
  expect(result.record?.status).toBe("confirmed");
  expect((await intent.retry(async () => ack())).kind).toBe("blocked");
  expect(createStoryIntentCoordinator(scope, store).read().record?.status).toBe(
    "unconfirmed",
  );
});

test("mismatching or malformed storage is never overwritten or dismissed", async () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  const key = intent.key;
  store.values.set(key, "{bad json");
  expect(intent.dismiss().failed).toBe(true);
  expect(store.values.get(key)).toBe("{bad json");
  expect((await intent.submit(async () => ack())).kind).toBe("blocked");
  const reload = createStoryIntentCoordinator(scope, store);
  expect(reload.read()).toEqual({ record: null, failed: true });
  expect(reload.stage(payload).record).toBeNull();
});

test("scope keys isolate principals and stage does not expose mutable caller objects", () => {
  const store = new Store();
  const first = createStoryIntentCoordinator(scope, store);
  const mutable = structuredClone(payload);
  first.stage(mutable);
  mutable.caption = "later";
  const view = first.read();
  view.record!.payload.caption = "changed again";
  expect(first.read().record?.payload.caption).toBe(" hello ");
  const other = createStoryIntentCoordinator(
    { ...scope, principal: "https://social.example/ap/users/other" },
    store,
  );
  expect(other.read().record).toBeNull();
});

test("same-origin endpoints have isolated records and cannot replay each other's intent", async () => {
  const store = new Store();
  const first = createStoryIntentCoordinator(scope, store);
  const tenant = createStoryIntentCoordinator(
    { ...scope, endpoint: `${scope.origin}/tenant/b/api/stories` },
    store,
  );
  expect(first.key).not.toBe(tenant.key);
  expect(first.key).toBe(
    createStoryIntentCoordinator(
      { ...scope, endpoint: `${scope.origin}/api/stories` },
      store,
    ).key,
  );
  first.stage(payload);
  expect(tenant.read().record).toBeNull();
  expect((await tenant.submit(async () => ack())).kind).toBe("blocked");
  const staged = tenant.stage({ ...payload, caption: "tenant b" });
  expect(staged.record?.endpoint).toBe(`${scope.origin}/tenant/b/api/stories`);
  expect(
    createStoryIntentCoordinator(scope, store).read().record?.payload.caption,
  ).toBe(" hello ");
  expect(
    createStoryIntentCoordinator(
      { ...scope, endpoint: `${scope.origin}/tenant/b/api/stories` },
      store,
    ).read().record?.payload.caption,
  ).toBe("tenant b");
  expect(() =>
    createStoryIntentCoordinator(
      { ...scope, endpoint: "https://other.example/api/stories" },
      store,
    ),
  ).toThrow();
  expect(() =>
    createStoryIntentCoordinator(
      { ...scope, endpoint: `${scope.origin}/api/stories#fragment` },
      store,
    ),
  ).toThrow();
});

test("saved endpoint must match the endpoint-bound storage key", () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  const serialized = store.values.get(intent.key)!;
  const forged = JSON.parse(serialized) as { endpoint: string };
  forged.endpoint = `${scope.origin}/tenant/other/api/stories`;
  store.values.set(intent.key, JSON.stringify(forged));
  const reloaded = createStoryIntentCoordinator(scope, store);
  expect(reloaded.read()).toEqual({ record: null, failed: true });
  expect(reloaded.stage(payload).record).toBeNull();
});

test("two coordinators cannot replace another staged intent in the same scope", async () => {
  const store = new Store();
  const first = createStoryIntentCoordinator(scope, store);
  const second = createStoryIntentCoordinator(scope, store);
  const staged = first.stage(payload);
  expect(staged.failed).toBe(false);
  const otherPayload = { ...payload, caption: "another story" };
  expect(second.stage(otherPayload).failed).toBe(true);
  expect(second.read().record).toBeNull();
  expect((await second.submit(async () => ack())).kind).toBe("blocked");
  expect(
    createStoryIntentCoordinator(scope, store).read().record?.payload.caption,
  ).toBe(" hello ");
});

test("invalid or unavailable saved state fails closed without erasing it", async () => {
  const store = new Store();
  const initial = createStoryIntentCoordinator(scope, store);
  store.values.set(initial.key, "{malformed");
  const bad = createStoryIntentCoordinator(scope, store);
  expect(bad.stage(payload)).toEqual({ record: null, failed: true });
  expect(bad.dismiss()).toEqual({ record: null, failed: true });
  expect(store.values.get(initial.key)).toBe("{malformed");
  store.denyRead = true;
  const unavailable = createStoryIntentCoordinator(scope, store);
  expect(unavailable.stage(payload).failed).toBe(true);
  expect((await unavailable.submit(async () => ack())).kind).toBe("blocked");
});

test("staged metadata omits unknown fields and rejects credential-bearing media URLs", async () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  const suspicious = {
    ...payload,
    access_token: "must never be stored",
    attachment: { ...payload.attachment, url: "/media/one.jpg?token=private" },
  };
  expect(intent.stage(suspicious).failed).toBe(true);
  expect(store.values.size).toBe(0);
});

test("a failed post-result write retains unknown memory and pending durable record", async () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  const result = await intent.submit(async () => {
    store.denyWrite = true;
    throw new ApiError(400, "rejected");
  });
  expect(result.kind).toBe("unconfirmed");
  expect(result.failed).toBe(true);
  expect(result.record?.status).toBe("unconfirmed");
  expect(createStoryIntentCoordinator(scope, store).read().record?.status).toBe(
    "unconfirmed",
  );
});

test("dismiss only removes the matching local record and verifies deletion", () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  expect(intent.dismiss()).toEqual({ record: null, failed: false });
  expect(store.values.size).toBe(0);
});

test("silent remove failure retains the local intent and blocks a new one", () => {
  const store = new Store();
  const intent = createStoryIntentCoordinator(scope, store);
  intent.stage(payload);
  store.ignoreRemove = true;
  const snapshot = intent.dismiss();
  expect(snapshot.failed).toBe(true);
  expect(snapshot.record?.status).toBe("ready");
  expect(store.values.size).toBe(1);
  expect(intent.stage(payload).failed).toBe(true);
});
