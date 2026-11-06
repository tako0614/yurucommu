import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import { createPostOutcomeAtoms } from "./post-outcome.ts";

function harness(namespace = "owner-A") {
  const bytes = new Map<string, string>();
  const faults = { read: false, write: false, remove: false };
  const storage = {
    getItem(key: string) {
      if (faults.read) throw new Error("denied read");
      return bytes.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (faults.write) throw new Error("denied write");
      bytes.set(key, value);
    },
    removeItem(key: string) {
      if (faults.remove) throw new Error("denied remove");
      bytes.delete(key);
    },
  };
  return {
    bytes,
    faults,
    storage,
    atoms: createPostOutcomeAtoms(namespace, () => storage),
    store: createStore(),
  };
}

test("a durable attempt is visible in a fresh store with no content or credential payload", () => {
  const { store, atoms, bytes, storage } = harness();
  const id = store.set(atoms.beginAtom);
  expect(typeof id).toBe("string");
  const record = JSON.parse(bytes.get("owner-A.outcome")!);
  expect(Object.keys(record).sort()).toEqual(["id", "status", "version"]);
  expect(record.status).toBe("pending");
  const reloaded = createStore();
  const fresh = createPostOutcomeAtoms("owner-A", () => storage);
  expect(reloaded.get(fresh.valueAtom)).toEqual({
    kind: "record",
    attempt: record,
    caution: "pending",
  });
});

test("a validated ACK is recorded before cleanup and only that attempt can resolve", () => {
  const { store, atoms } = harness();
  const id = store.set(atoms.beginAtom)!;
  expect(store.set(atoms.finishAtom, { id, confirmed: true })).toBe(true);
  expect(store.get(atoms.valueAtom)).toMatchObject({
    kind: "record",
    attempt: { status: "confirmed" },
  });
  expect(store.set(atoms.finishAtom, { id, confirmed: false })).toBe(true);
  expect(store.get(atoms.valueAtom)).toEqual({ kind: "missing" });
});

test("an older completion cannot confirm or remove a newer attempt", () => {
  const { store, atoms, storage, bytes } = harness();
  const old = store.set(atoms.beginAtom)!;
  const other = createPostOutcomeAtoms("owner-A", () => storage);
  const second = createStore();
  const latest = second.set(other.beginAtom)!;
  expect(latest).not.toBe(old);
  const exact = bytes.get("owner-A.outcome");
  expect(store.set(atoms.finishAtom, { id: old, confirmed: true })).toBe(false);
  expect(store.set(atoms.finishAtom, { id: old, confirmed: false })).toBe(
    false,
  );
  expect(bytes.get("owner-A.outcome")).toBe(exact);
});

test("write failure refuses a new attempt without replacing previous bytes", () => {
  const { store, atoms, faults, bytes } = harness();
  const id = store.set(atoms.beginAtom)!;
  const exact = bytes.get("owner-A.outcome");
  faults.write = true;
  expect(store.set(atoms.beginAtom)).toBeNull();
  expect(store.set(atoms.finishAtom, { id, confirmed: true })).toBe(false);
  expect(bytes.get("owner-A.outcome")).toBe(exact);
});

test("denied removal preserves a confirmed outcome across reload", () => {
  const { store, atoms, faults, storage } = harness();
  const id = store.set(atoms.beginAtom)!;
  expect(store.set(atoms.finishAtom, { id, confirmed: true })).toBe(true);
  faults.remove = true;
  expect(store.set(atoms.finishAtom, { id, confirmed: false })).toBe(false);
  expect(store.set(atoms.discardAtom)).toBe(false);
  expect(
    createStore().get(
      createPostOutcomeAtoms("owner-A", () => storage).valueAtom,
    ),
  ).toMatchObject({ kind: "record", attempt: { status: "confirmed" } });
});

test("unreadable or corrupt records are retained and refuse new dispatch intents", () => {
  const { store, atoms, faults, bytes, storage } = harness();
  bytes.set("owner-A.outcome", "{broken");
  expect(store.get(atoms.valueAtom)).toEqual({ kind: "invalid" });
  expect(store.set(atoms.beginAtom)).toBeNull();
  expect(bytes.get("owner-A.outcome")).toBe("{broken");
  faults.read = true;
  const fresh = createPostOutcomeAtoms("owner-A", () => storage);
  expect(createStore().get(fresh.valueAtom)).toEqual({ kind: "unreadable" });
  expect(store.set(fresh.beginAtom)).toBeNull();
  faults.read = false;
  expect(store.set(atoms.discardAtom)).toBe(true);
  expect(bytes.has("owner-A.outcome")).toBe(false);
});

test("another namespace's outcome is untouched by confirmation and explicit discard", () => {
  const { store, atoms, bytes, storage } = harness();
  const other = createPostOutcomeAtoms("owner-B", () => storage);
  store.set(other.beginAtom);
  const exact = bytes.get("owner-B.outcome");
  const id = store.set(atoms.beginAtom)!;
  store.set(atoms.finishAtom, { id, confirmed: true });
  store.set(atoms.discardAtom);
  expect(bytes.get("owner-B.outcome")).toBe(exact);
});

test("discard does not erase an unobserved newer attempt from another store", () => {
  const { store, atoms, bytes, storage } = harness();
  store.set(atoms.beginAtom);
  store.get(atoms.valueAtom);
  const other = createPostOutcomeAtoms("owner-A", () => storage);
  createStore().set(other.beginAtom);
  const exact = bytes.get("owner-A.outcome");
  expect(store.set(atoms.discardAtom)).toBe(false);
  expect(bytes.get("owner-A.outcome")).toBe(exact);
});

for (const priorConfirmed of [false, true]) {
  test(`retry rejection preserves earlier ${priorConfirmed ? "confirmed" : "uncertain"} caution`, () => {
    const { store, atoms, storage } = harness();
    const first = store.set(atoms.beginAtom)!;
    if (priorConfirmed)
      store.set(atoms.finishAtom, { id: first, confirmed: true });
    const retry = store.set(atoms.beginAtom)!;
    expect(store.set(atoms.finishAtom, { id: retry, confirmed: false })).toBe(
      true,
    );
    const fresh = createStore();
    expect(
      fresh.get(createPostOutcomeAtoms("owner-A", () => storage).valueAtom),
    ).toMatchObject({
      kind: "record",
      caution: priorConfirmed ? "confirmed" : "pending",
    });
    expect(store.set(atoms.discardAtom)).toBe(true);
    expect(
      createStore().get(
        createPostOutcomeAtoms("owner-A", () => storage).valueAtom,
      ),
    ).toEqual({ kind: "missing" });
  });
}

test("a successful retry cleanup cannot settle the earlier uncertain attempt", () => {
  const { store, atoms, storage, bytes } = harness();
  store.set(atoms.beginAtom);
  const retry = store.set(atoms.beginAtom)!;
  store.set(atoms.finishAtom, { id: retry, confirmed: true });
  expect(store.get(atoms.valueAtom)).toMatchObject({
    kind: "record",
    caution: "pending",
  });
  expect(store.set(atoms.finishAtom, { id: retry, confirmed: false })).toBe(
    true,
  );
  const exact = bytes.get("owner-A.outcome");
  expect(
    createStore().get(
      createPostOutcomeAtoms("owner-A", () => storage).valueAtom,
    ),
  ).toMatchObject({ kind: "record", caution: "pending" });
  expect(store.set(atoms.finishAtom, { id: retry, confirmed: false })).toBe(
    false,
  );
  expect(bytes.get("owner-A.outcome")).toBe(exact);
});

test("repeated retries keep bounded caution and uncertainty takes precedence over confirmation", () => {
  const { store, atoms, bytes } = harness();
  const confirmed = store.set(atoms.beginAtom)!;
  store.set(atoms.finishAtom, { id: confirmed, confirmed: true });
  store.set(atoms.beginAtom);
  for (let n = 0; n < 4; n++) {
    const retry = store.set(atoms.beginAtom)!;
    store.set(atoms.finishAtom, { id: retry, confirmed: false });
  }
  expect(store.get(atoms.valueAtom)).toMatchObject({
    kind: "record",
    caution: "pending",
  });
  expect(bytes.get("owner-A.outcome")!.length).toBeLessThan(200);
});
