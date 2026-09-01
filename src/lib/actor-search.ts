import type { Actor } from "../types/index.ts";

/** Filter actors using a query already normalized with JavaScript toLowerCase. */
export function filterActorsByNormalizedQuery(
  actors: readonly Actor[],
  normalizedQuery: string,
): readonly Actor[] {
  if (!normalizedQuery) return actors;

  return actors.filter(
    (actor) =>
      actor.name?.toLowerCase().includes(normalizedQuery) ||
      actor.preferred_username.toLowerCase().includes(normalizedQuery) ||
      actor.username.toLowerCase().includes(normalizedQuery),
  );
}
