import { atom, type Getter, type Setter } from "jotai/vanilla";
import {
  actorAtom,
  authSessionEpochAtom,
  hostedUserAtom,
  instancesLoadingAtom,
  logoutBusyAtom,
  selectedInstanceIdAtom,
} from "./auth.ts";
import type { Post } from "../types/index.ts";

// Jotai re-evaluates this per store whenever the selected instance changes,
// even if the selection returns to the same ID before an old request settles.
// A same-value selection keeps the same marker.
const selectedInstanceMarkerAtom = atom((get) => {
  get(selectedInstanceIdAtom);
  return {};
});

export type BookmarkRead = {
  actorApId?: string;
  epoch: number;
  instanceId: string | null;
  hostedUserId: string | null;
  instanceMarker: object;
  ticket: object;
};
type Window = BookmarkRead & {
  confirmed: ReadonlyMap<string, boolean>;
  mutation?: BookmarkMutation;
};
// Store-local and request-local: bookmark changes are reversible. A completed
// read leaves no overlay on later GETs, and nothing is persisted to storage.
const windowsAtom = atom<ReadonlyMap<object, Window>>(new Map());

// Requests for the same bookmark can overlap across Detail, Home and Saved.
// Keep their dispatch order in the Provider's store, not in a page component.
export type BookmarkMutation = Readonly<{
  ticket: object;
  sequence: number;
  key: string;
  actorApId: string;
  epoch: number;
  instanceId: string | null;
  hostedUserId: string | null;
  instanceMarker: object;
  apId: string;
  bookmarked: boolean;
}>;
type MutationEntry = {
  mutation: BookmarkMutation;
  status: "pending" | "confirmed";
};
type MutationGroup = {
  instanceMarker: object;
  entries: readonly MutationEntry[];
  publishedSequence: number;
};
const mutationsAtom = atom<{
  sequence: number;
  groups: ReadonlyMap<string, MutationGroup>;
}>({ sequence: 0, groups: new Map() });
export const activeBookmarkMutationCountAtom = atom((get) =>
  [...get(mutationsAtom).groups.values()].reduce(
    (count, group) =>
      count +
      group.entries.filter((entry) => entry.status === "pending").length,
    0,
  ),
);

export function isBookmarkMutationCurrent(
  get: Getter,
  mutation: BookmarkMutation,
): boolean {
  return (
    !get(logoutBusyAtom) &&
    get(actorAtom)?.ap_id === mutation.actorApId &&
    get(authSessionEpochAtom) === mutation.epoch &&
    get(selectedInstanceIdAtom) === mutation.instanceId &&
    get(selectedInstanceMarkerAtom) === mutation.instanceMarker &&
    (get(hostedUserAtom)?.id ?? null) === mutation.hostedUserId
  );
}

export function beginBookmarkMutation(
  get: Getter,
  set: Setter,
  change: { actorApId: string; apId: string; bookmarked: boolean },
): BookmarkMutation | null {
  if (
    get(logoutBusyAtom) ||
    get(instancesLoadingAtom) ||
    get(actorAtom)?.ap_id !== change.actorApId
  )
    return null;
  const epoch = get(authSessionEpochAtom);
  const instanceId = get(selectedInstanceIdAtom);
  const hostedUserId = get(hostedUserAtom)?.id ?? null;
  const instanceMarker = get(selectedInstanceMarkerAtom);
  const state = get(mutationsAtom);
  const sequence = state.sequence + 1;
  const key = JSON.stringify([
    change.actorApId,
    epoch,
    instanceId,
    hostedUserId,
    change.apId,
  ]);
  const mutation = {
    ...change,
    ticket: {},
    sequence,
    key,
    epoch,
    instanceId,
    hostedUserId,
    instanceMarker,
  };
  const groups = new Map(state.groups);
  const prior = groups.get(key);
  // The same string key can reappear after A -> B -> A. Retire that old
  // group; a later settlement can no longer find its old ticket.
  const group =
    prior?.instanceMarker === instanceMarker
      ? prior
      : { instanceMarker, entries: [], publishedSequence: 0 };
  groups.set(key, {
    ...group,
    entries: [...group.entries, { mutation, status: "pending" }],
  });
  set(mutationsAtom, { sequence, groups });
  return mutation;
}

export function bindBookmarkReadMutation(
  get: Getter,
  set: Setter,
  read: BookmarkRead,
  mutation: BookmarkMutation,
): void {
  const windows = get(windowsAtom);
  const window = windows.get(read.ticket);
  if (
    !window ||
    window.actorApId !== mutation.actorApId ||
    window.epoch !== mutation.epoch ||
    window.instanceId !== mutation.instanceId ||
    window.instanceMarker !== mutation.instanceMarker ||
    window.hostedUserId !== mutation.hostedUserId
  )
    return;
  set(windowsAtom, new Map(windows).set(read.ticket, { ...window, mutation }));
}

// The caller records `markRead` even when a newer optimistic write is pending,
// but publishes only the latest confirmed value that no newer write can mask.
export function settleBookmarkMutation(
  get: Getter,
  set: Setter,
  mutation: BookmarkMutation,
  success: boolean,
): {
  current: boolean;
  markRead?: BookmarkMutation;
  publish?: BookmarkMutation;
} {
  const state = get(mutationsAtom);
  const group = state.groups.get(mutation.key);
  const entry = group?.entries.find(
    (item) => item.mutation.ticket === mutation.ticket,
  );
  if (!group || !entry || entry.status !== "pending") return { current: false };
  const current = isBookmarkMutationCurrent(get, mutation);
  let entries = group.entries.filter((item) => item !== entry);
  const newerConfirmed = entries.some(
    (item) =>
      item.status === "confirmed" && item.mutation.sequence > mutation.sequence,
  );
  const markRead = current && success && !newerConfirmed ? mutation : undefined;
  if (markRead) entries = [...entries, { mutation, status: "confirmed" }];
  const confirmed = current
    ? entries
        .filter((item) => item.status === "confirmed")
        .sort((a, b) => b.mutation.sequence - a.mutation.sequence)[0]
    : undefined;
  const hasNewerPending = confirmed
    ? entries.some(
        (item) =>
          item.status === "pending" &&
          item.mutation.sequence > confirmed.mutation.sequence,
      )
    : false;
  const publish =
    confirmed &&
    !hasNewerPending &&
    confirmed.mutation.sequence > group.publishedSequence
      ? confirmed.mutation
      : undefined;
  const groups = new Map(state.groups);
  if (entries.some((item) => item.status === "pending")) {
    groups.set(mutation.key, {
      instanceMarker: group.instanceMarker,
      entries,
      publishedSequence: publish?.sequence ?? group.publishedSequence,
    });
  } else {
    groups.delete(mutation.key);
  }
  set(mutationsAtom, { ...state, groups });
  return { current, markRead, publish };
}

// Read-only view of the actual store-local registry for lifetime checks.
export const activeBookmarkReadCountAtom = atom((get) => get(windowsAtom).size);

export function beginBookmarkRead(get: Getter, set: Setter): BookmarkRead {
  const read = {
    actorApId: get(actorAtom)?.ap_id,
    epoch: get(authSessionEpochAtom),
    instanceId: get(selectedInstanceIdAtom),
    hostedUserId: get(hostedUserAtom)?.id ?? null,
    instanceMarker: get(selectedInstanceMarkerAtom),
    ticket: {},
  };
  set(
    windowsAtom,
    new Map(get(windowsAtom)).set(read.ticket, {
      ...read,
      confirmed: new Map<string, boolean>(),
    }),
  );
  return read;
}

export function ownsBookmarkRead(get: Getter, read: BookmarkRead): boolean {
  return (
    !get(logoutBusyAtom) &&
    get(windowsAtom).has(read.ticket) &&
    get(actorAtom)?.ap_id === read.actorApId &&
    get(authSessionEpochAtom) === read.epoch &&
    get(selectedInstanceIdAtom) === read.instanceId &&
    get(selectedInstanceMarkerAtom) === read.instanceMarker &&
    (get(hostedUserAtom)?.id ?? null) === read.hostedUserId
  );
}

export function finishBookmarkRead(
  get: Getter,
  set: Setter,
  read: BookmarkRead,
): void {
  const windows = get(windowsAtom);
  if (!windows.has(read.ticket)) return;
  const next = new Map(windows);
  next.delete(read.ticket);
  set(windowsAtom, next);
}

export function reconcileBookmarkRead(
  get: Getter,
  read: BookmarkRead,
  server: Post[],
  current: Post[],
): Post[] | null {
  if (!ownsBookmarkRead(get, read)) return null;
  const windows = get(windowsAtom);
  const confirmed = windows.get(read.ticket)!.confirmed;
  const pendingOptimistic = new Set<string>();
  const groups = get(mutationsAtom).groups;
  for (const window of windows.values()) {
    const mutation = window.mutation;
    if (!mutation || !isBookmarkMutationCurrent(get, mutation)) continue;
    const group = groups.get(mutation.key);
    if (
      group?.entries.some(
        (entry) =>
          entry.mutation.ticket === mutation.ticket &&
          entry.status === "pending",
      )
    )
      pendingOptimistic.add(mutation.apId);
  }
  if (confirmed.size === 0 && pendingOptimistic.size === 0) return server;
  // Preserve a later displayed interaction on this object, including boosts,
  // but change only the bookmark field of the earlier server snapshot. An
  // unacknowledged optimistic toggle is overlaid only where it is visible;
  // it is never treated as a successful write or added to a saved list.
  const visible = new Map(current.map((post) => [post.ap_id, post.bookmarked]));
  return server.map((post) => {
    const displayed = visible.get(post.ap_id);
    if (confirmed.has(post.ap_id))
      return { ...post, bookmarked: displayed ?? confirmed.get(post.ap_id)! };
    if (pendingOptimistic.has(post.ap_id) && displayed !== undefined)
      return { ...post, bookmarked: displayed };
    return post;
  });
}

export const acknowledgeBookmarkReadAtom = atom(
  null,
  (
    get,
    set,
    change: {
      actorApId: string;
      apId: string;
      bookmarked: boolean;
      sequence?: number;
      epoch?: number;
      instanceId?: string | null;
      hostedUserId?: string | null;
      instanceMarker?: object;
    },
  ): boolean => {
    if (get(logoutBusyAtom) || get(actorAtom)?.ap_id !== change.actorApId)
      return false;
    const currentMarker = get(selectedInstanceMarkerAtom);
    if (
      (change.epoch !== undefined &&
        change.epoch !== get(authSessionEpochAtom)) ||
      (change.instanceId !== undefined &&
        change.instanceId !== get(selectedInstanceIdAtom)) ||
      (change.hostedUserId !== undefined &&
        change.hostedUserId !== (get(hostedUserAtom)?.id ?? null)) ||
      (change.instanceMarker !== undefined &&
        change.instanceMarker !== currentMarker)
    )
      return false;
    const next = new Map(get(windowsAtom));
    const instanceMarker = change.instanceMarker ?? currentMarker;
    for (const [ticket, window] of next) {
      if (
        window.actorApId !== change.actorApId ||
        window.epoch !== (change.epoch ?? get(authSessionEpochAtom)) ||
        window.instanceId !==
          (change.instanceId ?? get(selectedInstanceIdAtom)) ||
        window.instanceMarker !== instanceMarker ||
        window.hostedUserId !==
          (change.hostedUserId ?? get(hostedUserAtom)?.id ?? null)
      )
        continue;
      // An older success is a rollback baseline, not a later success that can
      // suppress a newer optimistic operation's failure rollback.
      if (
        window.mutation?.apId === change.apId &&
        change.sequence !== undefined &&
        change.sequence < window.mutation.sequence
      )
        continue;
      next.set(ticket, {
        ...window,
        confirmed: new Map(window.confirmed).set(
          change.apId,
          change.bookmarked,
        ),
      });
    }
    set(windowsAtom, next);
    return true;
  },
);

// A pending optimistic toggle uses a temporary window too. A failure may
// restore its old flag only if no successful interaction superseded it.
export function hasBookmarkAcknowledgement(
  get: Getter,
  read: BookmarkRead,
  apId: string,
): boolean {
  return get(windowsAtom).get(read.ticket)?.confirmed.has(apId) === true;
}
