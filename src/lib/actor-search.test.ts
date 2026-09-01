import { expect, test } from "bun:test";
// Bun resolves `solid-js` to its server runtime in tests; use the client
// runtime to exercise memo sharing and same-reference notifications.
// @ts-expect-error solid-js exposes this runtime path without declarations.
import * as solidClient from "solid-js/dist/solid.js";
const { createMemo, createRoot, createSignal, mapArray } = solidClient;
import type { Actor } from "../types/index.ts";
import { filterActorsByNormalizedQuery } from "./actor-search.ts";

function makeActor(
  apId: string,
  fields: Partial<Pick<Actor, "name" | "preferred_username" | "username">> = {},
): Actor {
  return {
    ap_id: apId,
    username: fields.username ?? `${apId}@example.com`,
    preferred_username: fields.preferred_username ?? apId,
    name: fields.name ?? apId,
    summary: null,
    icon_url: null,
    header_url: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

test("returns the original list for an empty normalized query", () => {
  const actors = [makeActor("first"), makeActor("second")];

  expect(filterActorsByNormalizedQuery(actors, "")).toBe(actors);
});

test("preserves order, duplicate rows, and actor references", () => {
  const first = makeActor("duplicate", { name: "Alpha" });
  const duplicate = makeActor("duplicate", { preferred_username: "ALPHA" });
  const miss = makeActor("miss", { username: "unrelated" });

  const result = filterActorsByNormalizedQuery(
    [first, miss, duplicate],
    "alpha",
  );

  expect(result).toEqual([first, duplicate]);
  expect(result[0]).toBe(first);
  expect(result[1]).toBe(duplicate);
});

test("one memoized scan serves both count and mapped-list consumers", () => {
  createRoot((dispose: () => void) => {
    const alpha = makeActor("alpha");
    const beta = makeActor("beta");
    const owned = [alpha];
    const [actors, setActors] = createSignal<Actor[]>(owned, { equals: false });
    const [query, setQuery] = createSignal("");
    let queryNormalizations = 0;
    let scans = 0;
    const normalizedQuery = createMemo(() => {
      queryNormalizations += 1;
      return query().toLowerCase();
    });
    const filtered = createMemo(
      () => {
        scans += 1;
        return filterActorsByNormalizedQuery(actors(), normalizedQuery());
      },
      undefined,
      { equals: false },
    );
    const visibleCount = createMemo(() => filtered().length);
    const mapped = mapArray(filtered, (actor: Actor) => actor.ap_id);
    const rendered = createMemo(() => mapped());

    expect(visibleCount()).toBe(1);
    expect(rendered()).toEqual(["alpha"]);
    expect(scans).toBe(1);
    expect(queryNormalizations).toBe(1);

    owned.push(beta);
    setActors(owned);
    expect(visibleCount()).toBe(2);
    expect(rendered()).toEqual(["alpha", "beta"]);
    expect(scans).toBe(2);
    expect(queryNormalizations).toBe(1);

    setQuery("ALPHA");
    expect(visibleCount()).toBe(1);
    expect(rendered()).toEqual(["alpha"]);
    expect(scans).toBe(3);
    expect(queryNormalizations).toBe(2);

    expect(visibleCount()).toBe(1);
    expect(rendered()).toEqual(["alpha"]);
    expect(scans).toBe(3);
    dispose();
  });
});

test("normalizes each searchable actor field at most once per scan", () => {
  let lowerCalls = 0;
  const counted = (value: string): string =>
    ({
      toLowerCase() {
        lowerCalls += 1;
        return value.toLowerCase();
      },
    }) as unknown as string;
  const actors = Array.from({ length: 10_000 }, (_, index) =>
    makeActor(`actor-${index}`, {
      name: counted(`name-${index}`),
      preferred_username: counted(`preferred-${index}`),
      username: counted(`username-${index}`),
    }),
  );

  expect(filterActorsByNormalizedQuery(actors, "absent")).toEqual([]);
  expect(lowerCalls).toBe(30_000);
});
