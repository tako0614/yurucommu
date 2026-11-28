import { createEffect, onCleanup } from "solid-js";

export const APP_TITLE = "Yurucommu";

/**
 * Format a browser-tab document title with the brand suffix.
 * Blank/whitespace-only titles collapse to the bare product name so tabs
 * never render a leading separator like " — Yurucommu".
 */
export function formatDocumentTitle(section?: string | null): string {
  const trimmed = section?.trim();
  if (!trimmed || trimmed === APP_TITLE) return APP_TITLE;
  return `${trimmed} — ${APP_TITLE}`;
}

/**
 * Keep `document.title` in sync with the active screen (and active language /
 * loaded entity name). Restores the product title when the screen unmounts so
 * transient views never leave a stale title behind, without clobbering a title
 * already written by a newer view.
 */
export function useDocumentTitle(
  section: () => string | null | undefined,
): void {
  let lastSet: string | null = null;
  createEffect(() => {
    const next = formatDocumentTitle(section());
    if (typeof document !== "undefined") {
      document.title = next;
      lastSet = next;
    }
  });
  onCleanup(() => {
    if (
      typeof document !== "undefined" &&
      lastSet !== null &&
      document.title === lastSet
    ) {
      document.title = APP_TITLE;
    }
  });
}
