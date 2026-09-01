import { onCleanup, onMount } from "solid-js";
import { useSetAtom } from "solid-jotai";
import type { WritableAtom } from "jotai/vanilla";
import { startVisibilityPolling } from "./visibility-polling.ts";

/**
 * Mount once (in the authenticated app layout) to keep a shared unread count
 * fresh via lightweight polling of `refreshAtom`.
 *
 * - Polls every `pollIntervalMs` (default 30s) while the tab is visible.
 * - Pauses the interval when the tab is hidden (`visibilitychange`) and resumes
 *   on return, refreshing immediately so the badge is current.
 * - Cleans up the interval + listener on unmount; one mount point avoids
 *   duplicate intervals.
 */
export function useUnreadPolling(
  refreshAtom: WritableAtom<unknown, [], unknown>,
  pollIntervalMs = 30000,
) {
  const refresh = useSetAtom(refreshAtom);

  onMount(() => {
    const cleanup = startVisibilityPolling(refresh, pollIntervalMs);
    onCleanup(cleanup);
  });
}
