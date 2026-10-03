import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import {
  createPostDraftAtoms,
  readStoredPostDraft,
  type PostDraft,
} from "./post-draft.ts";

const CONTENT_KEY = "compose.draft.content";
const SUMMARY_KEY = "compose.draft.summary";
const VISIBILITY_KEY = "compose.draft.visibility";
const json = (value: unknown): string => JSON.stringify(value) as string;

class MemoryStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  failOnWrite: number | null = null;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    if (this.writes === this.failOnWrite)
      throw new Error("storage write denied");
    this.values.set(key, value);
  }
}

class TrackingEvents extends EventTarget {
  additions = 0;
  removals = 0;

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "storage") this.additions += 1;
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (type === "storage") this.removals += 1;
    super.removeEventListener(type, callback, options);
  }

  storageEvent(properties: {
    key: string | null;
    storageArea: Storage;
    newValue: string | null;
  }): void {
    const event = new Event("storage");
    Object.defineProperties(event, {
      key: { value: properties.key },
      storageArea: { value: properties.storageArea },
      newValue: { value: properties.newValue },
    });
    this.dispatchEvent(event);
  }
}

const defaultDraft: PostDraft = {
  content: "",
  summary: "",
  visibility: "public",
};

function setup() {
  const storage = new MemoryStorage();
  const events = new TrackingEvents();
  const atoms = createPostDraftAtoms(
    () => storage,
    events as unknown as Pick<
      Window,
      "addEventListener" | "removeEventListener"
    >,
  );
  const store = createStore();
  return { storage, events, atoms, store };
}

function putDraft(storage: MemoryStorage, draft: PostDraft): void {
  storage.values.set(CONTENT_KEY, json(draft.content));
  storage.values.set(SUMMARY_KEY, json(draft.summary));
  storage.values.set(VISIBILITY_KEY, json(draft.visibility));
}

function readDraft(
  store: ReturnType<typeof createStore>,
  atoms: ReturnType<typeof createPostDraftAtoms>,
): PostDraft {
  return {
    content: store.get(atoms.contentAtom),
    summary: store.get(atoms.summaryAtom),
    visibility: store.get(atoms.visibilityAtom),
  };
}

function rawDraft(storage: MemoryStorage): PostDraft | null {
  return readStoredPostDraft(storage);
}

test("stored draft defaults missing keys and restores a valid restricted visibility", () => {
  const storage = new MemoryStorage();
  expect(readStoredPostDraft(storage)).toEqual(defaultDraft);

  putDraft(storage, {
    content: "saved text",
    summary: "content warning",
    visibility: "followers",
  });
  expect(readStoredPostDraft(storage)).toEqual({
    content: "saved text",
    summary: "content warning",
    visibility: "followers",
  });
});

test("malformed JSON, invalid field types, and unknown visibility refuse the whole saved draft", () => {
  const storage = new MemoryStorage();
  storage.values.set(CONTENT_KEY, "not-json");
  expect(readStoredPostDraft(storage)).toBeNull();

  for (const [key, value] of [
    [CONTENT_KEY, json(42)],
    [SUMMARY_KEY, json(null)],
    [VISIBILITY_KEY, json("circle")],
  ] as const) {
    storage.values.clear();
    storage.values.set(key, value);
    expect(readStoredPostDraft(storage)).toBeNull();
  }
});

test("storage read failures return null instead of replacing the draft with defaults", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("storage denied");
    },
  };
  expect(readStoredPostDraft(throwingStorage)).toBeNull();
});

test("mount preserves valid saved warning and private audience beside malformed content", () => {
  const { storage, atoms, store } = setup();
  storage.values.set(CONTENT_KEY, "not-json");
  storage.values.set(SUMMARY_KEY, json("saved warning"));
  storage.values.set(VISIBILITY_KEY, json("followers"));
  const unsubscribe = store.sub(atoms.contentAtom, () => {});

  const retained: PostDraft = {
    content: "",
    summary: "saved warning",
    visibility: "followers",
  };
  expect(readDraft(store, atoms)).toEqual(retained);
  expect(store.get(atoms.writeFailedAtom)).toBe(true);
  expect(store.set(atoms.refreshAtom)).toBeNull();
  expect(readDraft(store, atoms)).toEqual(retained);
  unsubscribe();
});

test("refresh hydrates from current saved values without persisting another write", () => {
  const { storage, atoms, store } = setup();
  putDraft(storage, {
    content: "saved",
    summary: "cw",
    visibility: "unlisted",
  });
  storage.writes = 0;

  store.set(atoms.refreshAtom);

  expect(readDraft(store, atoms)).toEqual({
    content: "saved",
    summary: "cw",
    visibility: "unlisted",
  });
  expect(storage.writes).toBe(0);
});

test("a delayed storage event hydrates the latest storage values, not its stale newValue", () => {
  const { storage, events, atoms, store } = setup();
  const unsubscribe = store.sub(atoms.contentAtom, () => {});
  putDraft(storage, {
    content: "new body",
    summary: "new warning",
    visibility: "direct",
  });
  events.storageEvent({
    key: CONTENT_KEY,
    storageArea: storage as unknown as Storage,
    newValue: json("older body from delayed event"),
  });

  expect(readDraft(store, atoms)).toEqual({
    content: "new body",
    summary: "new warning",
    visibility: "direct",
  });
  unsubscribe();
});

test("clear events restore defaults, while other storage areas and unrelated keys are ignored", () => {
  const { storage, events, atoms, store } = setup();
  const unsubscribe = store.sub(atoms.contentAtom, () => {});
  store.set(atoms.contentAtom, "active composition");
  store.set(atoms.summaryAtom, "active warning");

  putDraft(storage, {
    content: "foreign",
    summary: "foreign",
    visibility: "followers",
  });
  events.storageEvent({
    key: CONTENT_KEY,
    storageArea: new MemoryStorage() as unknown as Storage,
    newValue: json("foreign"),
  });
  events.storageEvent({
    key: "unrelated.key",
    storageArea: storage as unknown as Storage,
    newValue: json("foreign"),
  });
  expect(readDraft(store, atoms)).toEqual({
    content: "active composition",
    summary: "active warning",
    visibility: "public",
  });

  storage.values.clear();
  events.storageEvent({
    key: null,
    storageArea: storage as unknown as Storage,
    newValue: null,
  });
  expect(readDraft(store, atoms)).toEqual(defaultDraft);
  unsubscribe();
});

test("unmount removes the storage listener and later events cannot refresh stale atoms", () => {
  const { storage, events, atoms, store } = setup();
  const unsubscribe = store.sub(atoms.contentAtom, () => {});
  expect(events.additions).toBe(1);
  store.set(atoms.contentAtom, "before unmount");
  unsubscribe();
  expect(events.removals).toBe(1);

  putDraft(storage, {
    content: "after unmount",
    summary: "later",
    visibility: "public",
  });
  events.storageEvent({
    key: CONTENT_KEY,
    storageArea: storage as unknown as Storage,
    newValue: json("after unmount"),
  });
  expect(readDraft(store, atoms)).toEqual({
    content: "before unmount",
    summary: "",
    visibility: "public",
  });
});

test("a failed field write preserves newer memory and blocks stale refresh until storage catches up", () => {
  const { storage, events, atoms, store } = setup();
  const unsubscribe = store.sub(atoms.contentAtom, () => {});
  const persisted: PostDraft = {
    content: "persisted body",
    summary: "persisted warning",
    visibility: "followers",
  };
  putDraft(storage, persisted);
  store.set(atoms.refreshAtom);

  storage.failOnWrite = storage.writes + 1;
  expect(() =>
    store.set(atoms.contentAtom, "new in-memory body"),
  ).not.toThrow();
  const newer: PostDraft = { ...persisted, content: "new in-memory body" };
  expect(readDraft(store, atoms)).toEqual(newer);
  expect(rawDraft(storage)).toEqual(persisted);
  expect(store.get(atoms.writeFailedAtom)).toBe(true);

  expect(store.set(atoms.refreshAtom)).toBeNull();
  events.storageEvent({
    key: null,
    storageArea: storage as unknown as Storage,
    newValue: null,
  });
  expect(readDraft(store, atoms)).toEqual(newer);
  expect(rawDraft(storage)).toEqual(persisted);

  storage.failOnWrite = null;
  putDraft(storage, newer);
  expect(store.set(atoms.refreshAtom)).toEqual(newer);
  expect(readDraft(store, atoms)).toEqual(newer);
  unsubscribe();
});

test("a second clear write failure keeps the whole prior draft despite partial storage and events", () => {
  const { storage, events, atoms, store } = setup();
  const unsubscribe = store.sub(atoms.contentAtom, () => {});
  const prior: PostDraft = {
    content: "keep body",
    summary: "keep warning",
    visibility: "direct",
  };
  putDraft(storage, prior);
  expect(store.set(atoms.refreshAtom)).toEqual(prior);
  const writesBeforeClear = storage.writes;
  storage.failOnWrite = writesBeforeClear + 2;

  expect(store.set(atoms.clearAtom)).toBe(false);
  expect(readDraft(store, atoms)).toEqual(prior);
  expect(store.get(atoms.writeFailedAtom)).toBe(true);
  expect(storage.values.size).toBe(3);
  expect(storage.values.get(CONTENT_KEY)).toBe(json(""));
  expect(storage.values.get(SUMMARY_KEY)).toBe(json("keep warning"));
  expect(storage.values.get(VISIBILITY_KEY)).toBe(json("direct"));

  events.storageEvent({
    key: null,
    storageArea: storage as unknown as Storage,
    newValue: null,
  });
  expect(store.set(atoms.refreshAtom)).toBeNull();
  expect(readDraft(store, atoms)).toEqual(prior);
  expect(rawDraft(storage)).toEqual({
    content: "",
    summary: "keep warning",
    visibility: "direct",
  });
  unsubscribe();
});

test("a successful clear persists the existing three keys and resets the full draft", () => {
  const { storage, atoms, store } = setup();
  const unsubscribe = store.sub(atoms.contentAtom, () => {});
  const prior: PostDraft = {
    content: "body",
    summary: "warning",
    visibility: "unlisted",
  };
  putDraft(storage, prior);
  store.set(atoms.refreshAtom);
  const existingKeys = [...storage.values.keys()].sort();

  expect(store.set(atoms.clearAtom)).toBe(true);

  expect(readDraft(store, atoms)).toEqual(defaultDraft);
  expect(rawDraft(storage)).toEqual(defaultDraft);
  expect([...storage.values.keys()].sort()).toEqual(existingKeys);
  expect(existingKeys).toEqual(
    [CONTENT_KEY, SUMMARY_KEY, VISIBILITY_KEY].sort(),
  );
  expect(
    [...storage.values.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ).toEqual(
    (
      [
        [CONTENT_KEY, json("")],
        [SUMMARY_KEY, json("")],
        [VISIBILITY_KEY, json("public")],
      ] satisfies [string, string][]
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
  expect(store.get(atoms.writeFailedAtom)).toBe(false);
  unsubscribe();
});

test("save refuses to pair private in-memory text with a public stored audience", () => {
  const { storage, atoms, store } = setup();
  const raw: PostDraft = {
    content: "old body",
    summary: "same warning",
    visibility: "public",
  };
  putDraft(storage, raw);
  store.set(atoms.refreshAtom);
  storage.failOnWrite = storage.writes + 1;
  store.set(atoms.visibilityAtom, "direct");
  const writesBeforeSave = storage.writes;

  expect(readDraft(store, atoms)).toEqual({ ...raw, visibility: "direct" });
  expect(store.get(atoms.writeFailedAtom)).toBe(true);
  expect(store.set(atoms.saveAtom)).toBe(false);
  expect(storage.writes).toBe(writesBeforeSave);
  expect(rawDraft(storage)).toEqual(raw);
  expect(readDraft(store, atoms)).toEqual({ ...raw, visibility: "direct" });
});

test("save refuses a recovery draft whose content warning differs from storage", () => {
  const { storage, atoms, store } = setup();
  const raw: PostDraft = {
    content: "old body",
    summary: "old warning",
    visibility: "followers",
  };
  putDraft(storage, raw);
  store.set(atoms.refreshAtom);
  storage.failOnWrite = storage.writes + 1;
  store.set(atoms.summaryAtom, "new warning");
  const writesBeforeSave = storage.writes;

  expect(store.set(atoms.saveAtom)).toBe(false);
  expect(storage.writes).toBe(writesBeforeSave);
  expect(rawDraft(storage)).toEqual(raw);
  expect(readDraft(store, atoms)).toEqual({ ...raw, summary: "new warning" });
  expect(store.get(atoms.writeFailedAtom)).toBe(true);
});

test("save repairs only the body when stored warning and audience still match", () => {
  const { storage, atoms, store } = setup();
  const raw: PostDraft = {
    content: "old body",
    summary: "safe warning",
    visibility: "direct",
  };
  putDraft(storage, raw);
  store.set(atoms.refreshAtom);
  storage.failOnWrite = storage.writes + 1;
  store.set(atoms.contentAtom, "retained body");
  const retained: PostDraft = { ...raw, content: "retained body" };
  const writesBeforeSave = storage.writes;

  storage.failOnWrite = null;
  expect(store.set(atoms.saveAtom)).toBe(true);

  expect(storage.writes).toBe(writesBeforeSave + 1);
  expect(storage.values.get(CONTENT_KEY)).toBe(json(retained.content));
  expect(storage.values.get(SUMMARY_KEY)).toBe(json(retained.summary));
  expect(storage.values.get(VISIBILITY_KEY)).toBe(json(retained.visibility));
  expect(rawDraft(storage)).toEqual(retained);
  expect(readDraft(store, atoms)).toEqual(retained);
  expect(store.get(atoms.writeFailedAtom)).toBe(false);
});

test("mount cannot replace faulted memory with older partially valid storage", () => {
  const { storage, atoms, store } = setup();
  putDraft(storage, {
    content: "old stored body",
    summary: "old warning",
    visibility: "followers",
  });
  store.set(atoms.refreshAtom);
  storage.values.set(SUMMARY_KEY, "malformed");
  storage.failOnWrite = storage.writes + 1;
  store.set(atoms.contentAtom, "new body retained only in memory");
  const beforeMount = readDraft(store, atoms);
  const unsubscribe = store.sub(atoms.contentAtom, () => {});
  expect(readDraft(store, atoms)).toEqual(beforeMount);
  expect(store.get(atoms.writeFailedAtom)).toBe(true);
  expect(store.set(atoms.refreshAtom)).toBeNull();
  unsubscribe();
});
