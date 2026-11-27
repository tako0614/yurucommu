import { isComposingKey } from "../components/ime.ts";

export type GlobalShortcutAction = "compose" | "search";

/**
 * True on Apple platforms where the primary modifier key is Command (⌘).
 * Safe to call in SSR / Bun test runtimes without `navigator`.
 */
export function isMacPlatform(
  nav:
    | {
        platform?: string;
        userAgent?: string;
        userAgentData?: { platform?: string };
      }
    | undefined = typeof navigator !== "undefined"
    ? (navigator as {
        platform?: string;
        userAgent?: string;
        userAgentData?: { platform?: string };
      })
    : undefined,
): boolean {
  if (!nav) return false;
  const raw =
    nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(raw);
}

/** Platform-aware keyboard hint for multi-line composer submission. */
export function submitShortcutLabel(
  nav?: Parameters<typeof isMacPlatform>[0],
): "⌘Enter" | "Ctrl+Enter" {
  return isMacPlatform(nav) ? "⌘Enter" : "Ctrl+Enter";
}

/**
 * True when keyboard focus is inside a text-entry or form-control element
 * where single-letter shortcuts must never fire.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  const tag = el.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  const role = el.getAttribute?.("role");
  if (role === "textbox" || role === "searchbox" || role === "combobox")
    return true;
  if (
    typeof el.closest === "function" &&
    el.closest('[contenteditable=""], [contenteditable="true"]')
  ) {
    return true;
  }
  return false;
}

/**
 * Classify a window-level keydown event into a safe global navigation/compose
 * shortcut, or null when the event should be ignored.
 */
export function classifyGlobalShortcut(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "metaKey"
    | "ctrlKey"
    | "altKey"
    | "shiftKey"
    | "isComposing"
    | "keyCode"
    | "defaultPrevented"
    | "target"
  >,
  options: { dialogOpen: boolean; menuOpen?: boolean },
): GlobalShortcutAction | null {
  if (event.defaultPrevented) return null;
  if (options.dialogOpen || options.menuOpen) return null;
  if (isComposingKey(event)) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isEditableTarget(event.target)) return null;

  if (!event.shiftKey && (event.key === "n" || event.key === "c")) {
    return "compose";
  }
  if (event.key === "/") {
    return "search";
  }
  return null;
}
