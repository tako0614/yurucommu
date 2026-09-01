import { expect, test } from "bun:test";
// Bun resolves `solid-js` to its server runtime in tests; use the client
// runtime here so mapArray exercises actual same-reference notifications.
// @ts-expect-error solid-js exposes this runtime path without declarations.
import * as solidClient from "solid-js/dist/solid.js";
const { createMemo, createRoot, createSignal, mapArray } = solidClient;
import type { Actor } from "../types/index.ts";
import {
  appendActorPageInPlace,
  replaceActorPageInPlace,
  selectActorsUnseenBeforePage,
} from "./actor-page.ts";

function makeActor(apId: string): Actor {
  return {
    ap_id: apId,
    username: `${apId}@example.com`,
    preferred_username: apId,
    name: apId,
    summary: null,
    icon_url: null,
    header_url: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

test("filters prior-page IDs while preserving incoming order and references", () => {
  const seenBeforePage = new Set(["already-seen"]);
  const existing = makeActor("already-seen");
  const first = makeActor("new-a");
  const second = makeActor("new-b");
  const page = [existing, first, second];

  const result = selectActorsUnseenBeforePage(page, seenBeforePage);

  expect(result.apIds).toEqual(["new-a", "new-b"]);
  expect(result.actors[0]).toBe(first);
  expect(result.actors[1]).toBe(second);
});

test("preserves duplicate IDs first introduced within the same page", () => {
  const seenBeforePage = new Set<string>();
  const first = makeActor("new");
  const second = makeActor("new");
  const third = makeActor("other");

  const result = selectActorsUnseenBeforePage(
    [first, second, third],
    seenBeforePage,
  );

  expect(result.apIds).toEqual(["new", "new", "other"]);
  expect(result.actors).toEqual([first, second, third]);
  expect(result.actors[0]).toBe(first);
  expect(result.actors[1]).toBe(second);
  expect(result.actors[2]).toBe(third);
});

test("rejects every occurrence when an ID existed before the page", () => {
  const repeated = [makeActor("already-seen"), makeActor("already-seen")];
  const seenBeforePage = new Set(["already-seen"]);

  const result = selectActorsUnseenBeforePage(repeated, seenBeforePage);

  expect(result.actors).toEqual([]);
  expect(result.apIds).toEqual([]);
});

test("does not mutate the page records or the prior-page Set", () => {
  const seenBeforePage = new Set(["already-seen"]);
  const existing = makeActor("already-seen");
  const incoming = makeActor("new");
  const page = [existing, incoming];
  const pageSnapshot = [...page];
  const existingSnapshot = { ...existing };
  const incomingSnapshot = { ...incoming };
  const seenSnapshot = new Set(seenBeforePage);

  selectActorsUnseenBeforePage(page, seenBeforePage);

  expect(page).toEqual(pageSnapshot);
  expect(existing).toEqual(existingSnapshot);
  expect(incoming).toEqual(incomingSnapshot);
  expect(seenBeforePage).toEqual(seenSnapshot);
});

test("replacement forgets old IDs and preserves duplicate order and references", () => {
  const old = makeActor("old");
  const first = makeActor("new");
  const duplicate = makeActor("new");
  const page = [first, duplicate];
  const pageSnapshot = [...page];
  const target = [old];
  const seen = new Set(["old"]);

  const result = replaceActorPageInPlace(target, seen, page);

  expect(result).toBe(target);
  expect(result).not.toBe(page);
  expect(target).toEqual(page);
  expect(target[0]).toBe(first);
  expect(target[1]).toBe(duplicate);
  expect(seen).toEqual(new Set(["new"]));
  expect(page).toEqual(pageSnapshot);
});

test("append keeps the same target, drops prior-page IDs, and accepts later rows", () => {
  const old = makeActor("old");
  const later = makeActor("later");
  const target = [old];
  const seen = new Set(["old"]);

  const result = appendActorPageInPlace(target, seen, [
    makeActor("old"),
    later,
  ]);

  expect(result).toBe(target);
  expect(target).toEqual([old, later]);
  expect(target[1]).toBe(later);
  expect(seen).toEqual(new Set(["old", "later"]));
});

test("append preserves same-page duplicates introduced after the snapshot", () => {
  const first = makeActor("new");
  const duplicate = makeActor("new");
  const target: Actor[] = [];
  const seen = new Set<string>();

  appendActorPageInPlace(target, seen, [first, duplicate]);

  expect(target).toEqual([first, duplicate]);
  expect(target[0]).toBe(first);
  expect(target[1]).toBe(duplicate);
  expect(seen).toEqual(new Set(["new"]));
});

test("append rejects an ID on a later page after recording it", () => {
  const first = makeActor("new");
  const duplicate = makeActor("new");
  const later = makeActor("later");
  const target: Actor[] = [];
  const seen = new Set<string>();

  appendActorPageInPlace(target, seen, [first, duplicate]);
  appendActorPageInPlace(target, seen, [makeActor("new"), later]);

  expect(target).toEqual([first, duplicate, later]);
  expect(target[0]).toBe(first);
  expect(target[1]).toBe(duplicate);
  expect(target[2]).toBe(later);
  expect(seen).toEqual(new Set(["new", "later"]));
});

test("append does not mutate or retain the API page array", () => {
  const existing = makeActor("existing");
  const incoming = makeActor("incoming");
  const page = [existing, incoming];
  const pageSnapshot = [...page];
  const existingSnapshot = { ...existing };
  const incomingSnapshot = { ...incoming };
  const target = [makeActor("prior")];
  const seen = new Set(["prior"]);

  appendActorPageInPlace(target, seen, page);

  expect(target).not.toBe(page);
  expect(page).toEqual(pageSnapshot);
  expect(existing).toEqual(existingSnapshot);
  expect(incoming).toEqual(incomingSnapshot);
  expect(target[1]).toBe(existing);
  expect(target[2]).toBe(incoming);
});

test("same-reference signal notification updates a mapped actor list", () => {
  createRoot((dispose: () => void) => {
    const owned: Actor[] = [];
    const seen = new Set<string>();
    const [actors, setActors] = createSignal<Actor[]>(owned, {
      equals: false,
    });
    const mappedActors = mapArray(actors, (actor: Actor) => actor.ap_id);
    const renderedActors = createMemo(() => mappedActors());

    expect(renderedActors()).toEqual([]);

    const incoming = makeActor("incoming");
    appendActorPageInPlace(owned, seen, [incoming]);
    setActors(owned);

    expect(renderedActors()).toEqual(["incoming"]);
    expect(actors()).toBe(owned);
    dispose();
  });
});

test("keeps one target identity and reads each incoming ap_id once across 200 pages", () => {
  let apIdReads = 0;
  const pages: Actor[][] = [];
  const expectedActors: Actor[] = [];

  for (let pageIndex = 0; pageIndex < 200; pageIndex += 1) {
    const page: Actor[] = [];
    for (let rowIndex = 0; rowIndex < 50; rowIndex += 1) {
      const apId = `actor-${pageIndex}-${rowIndex}`;
      const actor = makeActor(apId);
      Object.defineProperty(actor, "ap_id", {
        configurable: true,
        enumerable: true,
        get: () => {
          apIdReads += 1;
          return apId;
        },
      });
      page.push(actor);
      expectedActors.push(actor);
    }
    pages.push(page);
  }

  const seen = new Set<string>();
  const target: Actor[] = [];
  let returned = replaceActorPageInPlace(target, seen, pages[0]);
  expect(returned).toBe(target);
  for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
    returned = appendActorPageInPlace(target, seen, pages[pageIndex]);
    expect(returned).toBe(target);
  }

  expect(apIdReads).toBe(10_000);
  expect(returned).toBe(target);
  expect(target).toHaveLength(10_000);
  for (let index = 0; index < expectedActors.length; index += 1) {
    expect(target[index]).toBe(expectedActors[index]);
  }
});
