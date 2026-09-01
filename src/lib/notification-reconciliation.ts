import type { Notification } from "../types/index.ts";

/**
 * Reconcile a refreshed newest page with the rows already held by the client.
 * The newest page is returned in its incoming order, followed by existing rows
 * that are strictly older than its keyset boundary.
 * Preserve object identity for unchanged notifications across an in-place
 * refresh so the `<For>` (keyed by reference) re-renders only the rows that
 * actually changed, instead of rebuilding the whole list (visible flicker) on
 * every focus/visibility refresh.
 */
export function reconcileNewestNotifications(
  previous: Notification[],
  incoming: Notification[],
): Notification[] {
  const previousById = new Map(
    previous.map((notification) => [notification.id, notification]),
  );
  const incomingIds = new Set<string>();
  const merged = incoming.map((notification) => {
    const id = notification.id;
    incomingIds.add(id);
    const old = previousById.get(id);
    return old && JSON.stringify(old) === JSON.stringify(notification)
      ? old
      : notification;
  });
  const boundary = incoming[incoming.length - 1];
  const older = boundary
    ? previous.filter(
        (notification) =>
          !incomingIds.has(notification.id) &&
          (notification.created_at < boundary.created_at ||
            (notification.created_at === boundary.created_at &&
              notification.id < boundary.id)),
      )
    : [];
  return older.length > 0 ? [...merged, ...older] : merged;
}
