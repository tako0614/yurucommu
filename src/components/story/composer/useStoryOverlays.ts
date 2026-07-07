/**
 * Story overlay authoring state.
 *
 * Overlays are interactive, coordinate-positioned elements (poll / note / link)
 * that federate as ActivityPub `StoryOverlay` and are rendered by the viewer on
 * top of the story media — they are NOT baked into the exported canvas image.
 * This hook owns the editable list and mirrors the backend `validateOverlays`
 * constraints client-side so the composer fails early instead of on POST.
 */

import { createSignal } from "solid-js";
import type { StoryOverlay } from "../../../types/index.ts";

export type OverlayKind = "Question" | "Note" | "Link";

/** Must not exceed the backend cap (query-helpers.ts MAX_OVERLAYS = 20). */
export const MAX_OVERLAYS = 20;
/** Backend requires a poll to have 2–4 options. */
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;

export interface OverlayItem {
  readonly id: string;
  readonly overlay: StoryOverlay;
}

/** Default normalized size per overlay kind (center defaults to canvas middle). */
export function defaultOverlayPosition(kind: OverlayKind) {
  const size = kind === "Question"
    ? { width: 0.74, height: 0.18 }
    : kind === "Note"
    ? { width: 0.6, height: 0.1 }
    : { width: 0.5, height: 0.09 };
  return { x: 0.5, y: 0.5, ...size };
}

export function useStoryOverlays() {
  const [items, setItems] = createSignal<OverlayItem[]>([]);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  const overlays = (): StoryOverlay[] => items().map((i) => i.overlay);
  const hasQuestion = (): boolean =>
    items().some((i) => i.overlay.type === "Question");
  const canAddMore = (): boolean => items().length < MAX_OVERLAYS;

  /** Whether a new overlay of this kind can be added given current constraints. */
  function canAdd(kind: OverlayKind): boolean {
    if (!canAddMore()) return false;
    if (kind === "Question" && hasQuestion()) return false;
    return true;
  }

  function addOverlay(overlay: StoryOverlay): string | null {
    if (!canAddMore()) return null;
    if (overlay.type === "Question" && hasQuestion()) return null;
    const id = crypto.randomUUID();
    setItems((prev) => [...prev, { id, overlay }]);
    setSelectedId(id);
    return id;
  }

  function updateOverlay(id: string, overlay: StoryOverlay): void {
    setItems((prev) => prev.map((i) => (i.id === id ? { id, overlay } : i)));
  }

  function removeOverlay(id: string): void {
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (selectedId() === id) setSelectedId(null);
  }

  /** Reposition an overlay by its normalized center; coordinates are clamped. */
  function moveOverlay(id: string, x: number, y: number): void {
    const cx = Math.min(1, Math.max(0, x));
    const cy = Math.min(1, Math.max(0, y));
    setItems((prev) =>
      prev.map((i) =>
        i.id === id
          ? { id, overlay: { ...i.overlay, position: { ...i.overlay.position, x: cx, y: cy } } }
          : i
      )
    );
  }

  function getItem(id: string): OverlayItem | null {
    return items().find((i) => i.id === id) ?? null;
  }

  return {
    items,
    overlays,
    selectedId,
    setSelectedId,
    hasQuestion,
    canAdd,
    addOverlay,
    updateOverlay,
    removeOverlay,
    moveOverlay,
    getItem,
  };
}
