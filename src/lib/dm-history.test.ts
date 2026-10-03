import { expect, test } from "bun:test";
import { createDMHistory, mergeDMHistory } from "./dm-history.ts";

type Message = { id: string; created_at: string; content: string };
type Page = { messages: Message[]; hasMore: boolean };
type Snapshot = {
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  error: null | "initial" | "older";
};

const message = (id: string, created_at: string, content = id): Message => ({
  id,
  created_at,
  content,
});
const page = (messages: Message[], hasMore = false): Page => ({
  messages,
  hasMore,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function history() {
  const snapshots: Snapshot[] = [];
  const value = createDMHistory<Message>((snapshot) =>
    snapshots.push(snapshot),
  );
  return { ...value, snapshots };
}

test("an accepted poll retires a late initial success and settles initial loading", async () => {
  const h = history();
  const token = h.activate();
  const initial = deferred<Page>();
  const poll = deferred<Page>();
  const initialRead = h.readNewest(token, "initial", () => initial.promise);
  const pollRead = h.readNewest(token, "poll", () => poll.promise);

  poll.resolve(page([message("poll", "2026-01-01T00:00:02Z")], false));
  await pollRead;
  initial.resolve(page([message("old", "2026-01-01T00:00:01Z")], true));
  await initialRead;

  expect(h.snapshot()).toMatchObject({ loading: false, hasMore: false });
  expect(h.snapshot().messages.map(({ id }) => id)).toEqual(["poll"]);
});

test("an empty or failed later poll does not retire an in-flight initial read", async () => {
  for (const outcome of ["empty", "failure"] as const) {
    const h = history();
    const token = h.activate();
    const initial = deferred<Page>();
    const initialRead = h.readNewest(token, "initial", () => initial.promise);
    if (outcome === "empty") {
      await h.readNewest(token, "poll", async () => page([], false));
    } else {
      await h.readNewest(token, "poll", async () => {
        throw new Error("temporary poll failure");
      });
    }
    expect(h.snapshot().loading).toBe(true);
    initial.resolve(page([message("initial", "2026-01-01T00:00:00Z")], false));
    await initialRead;
    expect(h.snapshot()).toMatchObject({ loading: false, error: null });
    expect(h.snapshot().messages.map(({ id }) => id)).toEqual(["initial"]);
  }
});

test("a poll reconciled to only an ACK cannot supersede initial history or seed pagination", async () => {
  const h = history();
  const token = h.activate();
  const initial = deferred<Page>();
  const initialRead = h.readNewest(token, "initial", () => initial.promise);
  const polled = deferred<Page>();
  const pollRead = h.readNewest(token, "poll", () => polled.promise);
  const acknowledged = message("ack", "2026-01-01T00:00:02Z");
  h.acknowledge(token, acknowledged);

  polled.resolve(page([acknowledged], true));
  const result = await pollRead;
  expect(result.applied).toBe(false);
  expect(h.snapshot()).toMatchObject({ loading: false, hasMore: false });

  initial.resolve(page([message("older", "2026-01-01T00:00:01Z")], true));
  await initialRead;
  expect(h.snapshot()).toMatchObject({ loading: false, hasMore: true });
  expect(h.snapshot().messages.map(({ id }) => id)).toEqual(["older", "ack"]);
});

test("a poll reconciled to only a tombstone cannot supersede initial history", async () => {
  const h = history();
  const token = h.activate();
  const initial = deferred<Page>();
  const initialRead = h.readNewest(token, "initial", () => initial.promise);
  const polled = deferred<Page>();
  const pollRead = h.readNewest(token, "poll", () => polled.promise);
  const removed = message("removed", "2026-01-01T00:00:02Z");
  h.acknowledge(token, removed);
  h.remove(token, removed.id);
  polled.resolve(page([removed], true));

  const result = await pollRead;
  expect(result.applied).toBe(false);
  expect(h.snapshot()).toMatchObject({ loading: false, hasMore: false });
  initial.resolve(page([message("older", "2026-01-01T00:00:01Z")], true));
  await initialRead;
  expect(h.snapshot()).toMatchObject({ loading: false, hasMore: true });
  expect(h.snapshot().messages.map(({ id }) => id)).toEqual(["older"]);
});

test("a stale reverse-completing poll cannot overwrite or append to a newer poll", async () => {
  const h = history();
  const token = h.activate();
  const first = deferred<Page>();
  const second = deferred<Page>();
  const firstRead = h.readNewest(token, "poll", () => first.promise);
  const secondRead = h.readNewest(token, "poll", () => second.promise);

  second.resolve(
    page(
      [
        message("shared", "2026-01-01T00:00:01Z", "second"),
        message("two", "2026-01-01T00:00:02Z"),
      ],
      true,
    ),
  );
  await secondRead;
  first.resolve(
    page(
      [
        message("shared", "2026-01-01T00:00:01Z", "first"),
        message("one", "2026-01-01T00:00:00Z"),
      ],
      false,
    ),
  );
  await firstRead;

  expect(h.snapshot().messages).toEqual([
    message("shared", "2026-01-01T00:00:01Z", "second"),
    message("two", "2026-01-01T00:00:02Z"),
  ]);
});

test("an acknowledgement remains visible while initial history resolves and merges older rows", async () => {
  const h = history();
  const token = h.activate();
  const initial = deferred<Page>();
  const initialRead = h.readNewest(token, "initial", () => initial.promise);
  const acknowledged = message("ack", "2026-01-01T00:00:02Z");
  h.acknowledge(token, acknowledged);
  expect(h.snapshot().messages).toEqual([acknowledged]);

  initial.resolve(page([message("old", "2026-01-01T00:00:01Z")], true));
  await initialRead;
  expect(h.snapshot().messages).toEqual([
    message("old", "2026-01-01T00:00:01Z"),
    acknowledged,
  ]);
  expect(h.snapshot()).toMatchObject({ loading: false, hasMore: true });
});

test("a late initial error after acknowledgement leaves the history usable", async () => {
  const h = history();
  const token = h.activate();
  const initial = deferred<Page>();
  const initialRead = h.readNewest(token, "initial", () => initial.promise);
  const acknowledged = message("ack", "2026-01-01T00:00:02Z");
  h.acknowledge(token, acknowledged);
  initial.reject(new Error("initial read failed"));
  await initialRead;

  expect(h.snapshot()).toMatchObject({ loading: false, error: null });
  expect(h.snapshot().messages).toEqual([acknowledged]);
  await h.readNewest(token, "poll", async () =>
    page([message("polled", "2026-01-01T00:00:03Z")]),
  );
  expect(h.snapshot().messages.map(({ id }) => id)).toEqual(["ack", "polled"]);
});

test("history merges over fifty same-time rows by ID and advances the composite cursor across polls", async () => {
  const h = history();
  const token = h.activate();
  const firstPage = Array.from({ length: 52 }, (_, index) =>
    message(`id-${String(index).padStart(2, "0")}`, "2026-01-01T00:00:00.000Z"),
  );
  await h.readNewest(token, "initial", async () => page(firstPage, true));
  await h.readNewest(token, "poll", async () =>
    page(
      [
        message("id-51", "2026-01-01T00:00:00.000Z", "updated by poll"),
        message("newer", "2026-01-01T00:00:01.000Z"),
      ],
      true,
    ),
  );
  let cursor = "";
  await h.readOlder(token, async (value) => {
    cursor = value;
    return page(
      [
        message("older", "2025-12-31T23:59:59.000Z"),
        message("id-51", "2026-01-01T00:00:00.000Z", "stale older payload"),
      ],
      true,
    );
  });

  expect(cursor).toBe("2026-01-01T00:00:00.000Z id-00");
  expect(
    h
      .snapshot()
      .messages.map(({ id }) => id)
      .slice(0, 2),
  ).toEqual(["older", "id-00"]);
  expect(h.snapshot().messages.find(({ id }) => id === "id-51")?.content).toBe(
    "updated by poll",
  );
});

test("newest-page hasMore does not reseed older pagination after an older read starts", async () => {
  const h = history();
  const token = h.activate();
  await h.readNewest(token, "initial", async () =>
    page([message("new", "2026-01-01T00:00:01Z")], true),
  );
  const older = deferred<Page>();
  const olderRead = h.readOlder(token, () => older.promise);
  expect(h.snapshot().loadingOlder).toBe(true);
  await h.readNewest(token, "poll", async () =>
    page([message("new", "2026-01-01T00:00:01Z")], false),
  );
  expect(h.snapshot().hasMore).toBe(true);
  older.reject(new Error("older read failed"));
  await olderRead;
  expect(h.snapshot()).toMatchObject({
    hasMore: true,
    loadingOlder: false,
    error: "older",
  });
});

test("A to B to A ignores stale older success, error and finally work", async () => {
  const h = history();
  const firstA = h.activate();
  await h.readNewest(firstA, "initial", async () =>
    page([message("a1", "2026-01-01T00:00:01Z")], true),
  );
  const oldOlder = deferred<Page>();
  const oldRead = h.readOlder(firstA, () => oldOlder.promise);

  h.invalidate(firstA);
  const b = h.activate();
  await h.readNewest(b, "initial", async () =>
    page([message("b", "2026-01-01T00:00:01Z")], false),
  );
  h.invalidate(b);
  const secondA = h.activate();
  await h.readNewest(secondA, "initial", async () =>
    page([message("a2", "2026-01-01T00:00:02Z")], true),
  );
  const currentOlder = deferred<Page>();
  const currentRead = h.readOlder(secondA, () => currentOlder.promise);
  expect(h.snapshot().loadingOlder).toBe(true);
  const before = h.snapshot();

  oldOlder.resolve(page([message("stale", "2025-12-31T00:00:00Z")], false));
  const staleResult = await oldRead;
  expect(Boolean(staleResult?.isCurrent())).toBe(false);
  expect(h.snapshot()).toEqual(before);
  expect(h.owns(secondA)).toBe(true);
  expect(h.owns(firstA)).toBe(false);

  currentOlder.resolve(page([message("a0", "2025-12-31T00:00:00Z")], false));
  await currentRead;
});

test("an older-read rejection after A to B to A cannot publish stale error or loading state", async () => {
  const h = history();
  const firstA = h.activate();
  await h.readNewest(firstA, "initial", async () =>
    page([message("a1", "2026-01-01T00:00:01Z")], true),
  );
  const oldOlder = deferred<Page>();
  const oldRead = h.readOlder(firstA, () => oldOlder.promise);
  h.invalidate(firstA);
  const b = h.activate();
  await h.readNewest(b, "initial", async () =>
    page([message("b", "2026-01-01T00:00:01Z")]),
  );
  h.invalidate(b);
  const secondA = h.activate();
  await h.readNewest(secondA, "initial", async () =>
    page([message("a2", "2026-01-01T00:00:02Z")], true),
  );
  const before = h.snapshot();

  oldOlder.reject(new Error("stale older failure"));
  await oldRead;
  expect(h.snapshot()).toEqual(before);
});

test("activation during an older-page publish invalidates its scroll ticket", async () => {
  let replacement: unknown;
  let onPublish: (snapshot: Snapshot) => void = () => {};
  const switching = createDMHistory<Message>((snapshot) => onPublish(snapshot));
  onPublish = (snapshot) => {
    if (snapshot.messages.some(({ id }) => id === "old")) {
      replacement = switching.activate();
    }
  };
  const switchingToken = switching.activate();
  await switching.readNewest(switchingToken, "initial", async () =>
    page([message("new", "2026-01-01T00:00:01Z")], true),
  );
  const switchingOlder = deferred<Page>();
  const switchingRead = switching.readOlder(
    switchingToken,
    () => switchingOlder.promise,
  );
  switchingOlder.resolve(page([message("old", "2025-12-31T00:00:00Z")], true));
  const switchingResult = await switchingRead;
  expect(replacement).toBeDefined();
  expect(Boolean(switchingResult?.isCurrent())).toBe(false);
});

test("invalidate ignores pending reads and acknowledgement from the prior token", async () => {
  const h = history();
  const token = h.activate();
  const read = deferred<Page>();
  const pending = h.readNewest(token, "initial", () => read.promise);
  h.invalidate(token);
  const next = h.activate();
  await h.readNewest(next, "initial", async () =>
    page([message("current", "2026-01-01T00:00:00Z")]),
  );
  const before = h.snapshot();
  h.acknowledge(token, message("stale-ack", "2026-01-01T00:00:01Z"));
  read.resolve(page([message("stale", "2026-01-01T00:00:02Z")], true));
  await pending;
  expect(h.snapshot()).toEqual(before);
});

test("payload changes are reported, while unchanged merges preserve the message array", () => {
  const original = [message("same", "2026-01-01T00:00:00Z")];
  const unchanged = mergeDMHistory(original, [
    message("same", "2026-01-01T00:00:00Z"),
  ]);
  expect(unchanged).toBe(original);

  const updated = mergeDMHistory(original, [
    message("same", "2026-01-01T00:00:00Z", "edited"),
  ]);
  expect(updated).not.toBe(original);
  expect(updated).toEqual([message("same", "2026-01-01T00:00:00Z", "edited")]);
});

test("an empty initial page settles loading without erasing an acknowledgement", async () => {
  const h = history();
  const token = h.activate();
  const initial = deferred<Page>();
  const initialRead = h.readNewest(token, "initial", () => initial.promise);
  const acknowledged = message("ack", "2026-01-01T00:00:00Z");
  h.acknowledge(token, acknowledged);
  initial.resolve(page([], false));
  await initialRead;
  expect(h.snapshot()).toMatchObject({ loading: false, hasMore: false });
  expect(h.snapshot().messages).toEqual([acknowledged]);
});

test("acknowledging an existing ID does not roll its payload back", async () => {
  const h = history();
  const token = h.activate();
  const latest = message("same", "2026-01-01T00:00:00Z", "latest payload");
  await h.readNewest(token, "initial", async () => page([latest]));
  h.acknowledge(
    token,
    message("same", "2026-01-01T00:00:00Z", "stale ACK payload"),
  );
  expect(h.snapshot().messages).toEqual([latest]);
});

test("deleting an acknowledged message prevents pending and later reads from resurrecting it", async () => {
  const h = history();
  const token = h.activate();
  const deleted = message("deleted", "2026-01-01T00:00:00Z");
  h.acknowledge(token, deleted);
  const pendingPoll = deferred<Page>();
  const delayed = h.readNewest(token, "poll", () => pendingPoll.promise);

  h.remove(token, deleted.id);
  expect(h.snapshot().messages).toEqual([]);
  await h.readNewest(token, "poll", async () =>
    page([message("deleted", deleted.created_at, "stale poll payload")]),
  );
  expect(h.snapshot().messages).toEqual([]);

  pendingPoll.resolve(
    page([message("deleted", deleted.created_at, "delayed poll payload")]),
  );
  await delayed;
  expect(h.snapshot().messages).toEqual([]);
});

test("an ACK during matching initial history wins over that response, while a fresh poll can update it", async () => {
  const h = history();
  const token = h.activate();
  const initial = deferred<Page>();
  const initialRead = h.readNewest(token, "initial", () => initial.promise);
  const acknowledged = message("same", "2026-01-01T00:00:00Z", "ack payload");
  h.acknowledge(token, acknowledged);
  initial.resolve(
    page([message("same", "2026-01-01T00:00:00Z", "older initial payload")]),
  );
  await initialRead;
  expect(h.snapshot().messages).toEqual([acknowledged]);

  const fresh = message("same", "2026-01-01T00:00:00Z", "fresh poll payload");
  await h.readNewest(token, "poll", async () => page([fresh]));
  expect(h.snapshot().messages).toEqual([fresh]);
});

test("an empty older page preserves hasMore when the SDK gives no reliable exhaustion signal", async () => {
  const h = history();
  const token = h.activate();
  await h.readNewest(token, "initial", async () =>
    page([message("new", "2026-01-01T00:00:01Z")], true),
  );
  await h.readOlder(token, async () => page([], false));
  expect(h.snapshot()).toMatchObject({
    hasMore: true,
    loadingOlder: false,
    error: null,
  });
});

test("an older page containing only a tombstone keeps the cursor and hasMore button", async () => {
  const h = history();
  const token = h.activate();
  const oldest = message("current-oldest", "2026-01-01T00:00:00Z");
  const removed = message("removed", "2025-12-31T23:59:59Z");
  await h.readNewest(token, "initial", async () => page([oldest], true));
  h.remove(token, removed.id);
  let cursor = "";
  await h.readOlder(token, async (value) => {
    cursor = value;
    return page([removed], false);
  });

  expect(cursor).toBe(`${oldest.created_at} ${oldest.id}`);
  expect(h.snapshot()).toMatchObject({ hasMore: true, loadingOlder: false });
  expect(h.snapshot().messages).toEqual([oldest]);
  await h.readOlder(token, async (value) => {
    cursor = value;
    return page([message("actually-older", "2025-12-31T23:59:58Z")], true);
  });
  expect(cursor).toBe(`${oldest.created_at} ${oldest.id}`);
});

test("hasMore changes only when an older page advances the oldest tuple", async () => {
  const h = history();
  const token = h.activate();
  const oldest = message("a", "2026-01-01T00:00:00Z");
  await h.readNewest(token, "initial", async () => page([oldest], true));
  await h.readOlder(token, async () =>
    page(
      [message("z", oldest.created_at, "same-time but after cursor")],
      false,
    ),
  );
  expect(h.snapshot().hasMore).toBe(true);
  expect(h.snapshot().messages[0]).toEqual(oldest);
});

test("an older scroll ticket survives an identical poll and expires after new messages arrive", async () => {
  const h = history();
  const token = h.activate();
  const newest = message("newest", "2026-01-01T00:00:01Z");
  await h.readNewest(token, "initial", async () => page([newest], true));
  const ticket = await h.readOlder(token, async () =>
    page([message("older", "2026-01-01T00:00:00Z")], true),
  );
  expect(ticket?.isCurrent()).toBe(true);

  await h.readNewest(token, "poll", async () => page([newest]));
  expect(ticket?.isCurrent()).toBe(true);
  await h.readNewest(token, "poll", async () =>
    page([message("new-arrival", "2026-01-01T00:00:02Z")]),
  );
  expect(ticket?.isCurrent()).toBe(false);
});
