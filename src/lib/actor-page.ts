import type { Actor } from "../types/index.ts";
import {
  appendKeyedPageInPlace,
  replaceKeyedPageInPlace,
  selectItemsUnseenBeforePage,
} from "./keyed-page.ts";

const actorApId = (actor: Actor) => actor.ap_id;

export interface ActorPageSelection {
  actors: Actor[];
  apIds: string[];
}

/**
 * Select rows whose IDs were not present before this page started.
 *
 * The incoming page and snapshot are treated as read-only. IDs introduced by
 * another row in the same page are intentionally not added while selecting,
 * so duplicate rows in one API response retain their order and references.
 */
export function selectActorsUnseenBeforePage(
  page: readonly Actor[],
  seenSnapshot: ReadonlySet<string>,
): ActorPageSelection {
  const { items, keys } = selectItemsUnseenBeforePage(
    page,
    seenSnapshot,
    actorApId,
  );
  return { actors: items, apIds: keys };
}

/** Replace an owned actor page in place and return that same owned array. */
export function replaceActorPageInPlace(
  target: Actor[],
  seen: Set<string>,
  page: readonly Actor[],
): Actor[] {
  return replaceKeyedPageInPlace(target, seen, page, actorApId);
}

/** Append unseen rows to an owned actor page and return that same array. */
export function appendActorPageInPlace(
  target: Actor[],
  seen: Set<string>,
  page: readonly Actor[],
): Actor[] {
  return appendKeyedPageInPlace(target, seen, page, actorApId);
}
