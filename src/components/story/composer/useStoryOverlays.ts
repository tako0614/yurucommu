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
/** Normalized overlay size bounds (position fields must stay within 0–1). */
export const OVERLAY_MIN_WIDTH = 0.2;
export const OVERLAY_MAX_WIDTH = 0.95;
export const OVERLAY_MIN_HEIGHT = 0.04;
export const OVERLAY_MAX_HEIGHT = 0.6;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Keep the whole overlay on-canvas: clamp the center by its half-size. */
function clampCenter(value: number, size: number): number {
  const half = Math.min(size / 2, 0.5);
  return clamp(value, half, 1 - half);
}

export interface OverlayItem {
  readonly id: string;
  readonly overlay: StoryOverlay;
}

/** Default normalized size per overlay kind (center defaults to canvas middle). */
export function defaultOverlayPosition(kind: OverlayKind) {
  const size =
    kind === "Question"
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

  /** Reposition an overlay by its normalized center; kept fully on-canvas. */
  function moveOverlay(id: string, x: number, y: number): void {
    setItems((prev) =>
      prev.map((i) => {
        if (i.id !== id) return i;
        const { width, height } = i.overlay.position;
        return {
          id,
          overlay: {
            ...i.overlay,
            position: {
              ...i.overlay.position,
              x: clampCenter(x, width),
              y: clampCenter(y, height),
            },
          },
        };
      }),
    );
  }

  /**
   * Resize an overlay to a new normalized width, scaling height by the same
   * factor to preserve aspect. Width/height are clamped and the center is
   * re-clamped so the resized overlay stays on-canvas.
   */
  function resizeOverlay(id: string, nextWidth: number): void {
    setItems((prev) =>
      prev.map((i) => {
        if (i.id !== id) return i;
        const { x, y, width, height } = i.overlay.position;
        const w = clamp(nextWidth, OVERLAY_MIN_WIDTH, OVERLAY_MAX_WIDTH);
        const ratio = width > 0 ? w / width : 1;
        const h = clamp(height * ratio, OVERLAY_MIN_HEIGHT, OVERLAY_MAX_HEIGHT);
        return {
          id,
          overlay: {
            ...i.overlay,
            position: {
              ...i.overlay.position,
              width: w,
              height: h,
              x: clampCenter(x, w),
              y: clampCenter(y, h),
            },
          },
        };
      }),
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
    resizeOverlay,
    getItem,
  };
}
