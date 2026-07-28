import { expect, test } from "bun:test";
import { createStore } from "jotai/vanilla";
import {
  addMuteWordAtom,
  muteWordsAtom,
  removeMuteWordAtom,
} from "./mute-words.ts";

// The atoms use atomWithStorage, whose default storage reads window.localStorage
// — absent in the bun test env, so each atom safely falls back to its initial
// value ([]) and holds subsequent writes in-memory. That is exactly what these
// tests exercise: the add/remove/dedup logic, independent of persistence.

test("add prepends a trimmed word", () => {
  const store = createStore();
  store.set(addMuteWordAtom, "  spoiler  ");
  expect(store.get(muteWordsAtom)).toEqual(["spoiler"]);
});

test("add dedupes case-insensitively", () => {
  const store = createStore();
  store.set(addMuteWordAtom, "Spoiler");
  store.set(addMuteWordAtom, "spoiler");
  expect(store.get(muteWordsAtom)).toEqual(["Spoiler"]);
});

test("add ignores blank input", () => {
  const store = createStore();
  store.set(addMuteWordAtom, "   ");
  expect(store.get(muteWordsAtom)).toEqual([]);
});

test("newest word lands first", () => {
  const store = createStore();
  store.set(addMuteWordAtom, "a");
  store.set(addMuteWordAtom, "b");
  expect(store.get(muteWordsAtom)).toEqual(["b", "a"]);
});

test("remove drops the exact stored entry", () => {
  const store = createStore();
  store.set(addMuteWordAtom, "keep");
  store.set(addMuteWordAtom, "drop");
  store.set(removeMuteWordAtom, "drop");
  expect(store.get(muteWordsAtom)).toEqual(["keep"]);
});
