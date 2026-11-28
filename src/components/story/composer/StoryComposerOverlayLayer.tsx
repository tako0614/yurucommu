/**
 * Editable overlay layer rendered over the composer canvas.
 *
 * Overlays use the SAME normalized center-coordinate convention as the viewer
 * (StoryViewerOverlays): `left = (x - width/2)`, expressed here as percentages of
 * the stage so no pixel measurement is needed for rendering. Pointer drag
 * converts a pixel delta to a normalized delta via the layer's measured size.
 * These elements are plain DOM (not canvas layers) so they are never baked into
 * the exported image — they ship as structured `StoryOverlay` data.
 */

import { createEffect, createMemo, For, onCleanup, Show } from "solid-js";
import { useI18n } from "../../../lib/i18n.tsx";
import { isComposingKey } from "../../ime.ts";
import type { StoryOverlay } from "../../../types/index.ts";
import {
  OVERLAY_MAX_WIDTH,
  OVERLAY_MIN_WIDTH,
  type OverlayItem,
} from "./useStoryOverlays.ts";

interface StoryComposerOverlayLayerProps {
  items: OverlayItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, width: number) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onRemoveFocusFallback?: () => void;
  disabled?: boolean;
}

interface DragState {
  id: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface ResizeState {
  id: string;
  startX: number;
  startWidth: number;
}

function OverlayPreview(props: { overlay: StoryOverlay }) {
  return (
    <>
      <Show when={props.overlay.type === "Question"}>
        <div class="w-full rounded-xl bg-black/60 p-2 backdrop-blur-sm">
          <p class="mb-1.5 text-center text-xs font-medium text-white">
            {props.overlay.name}
          </p>
          <div class="flex gap-1.5">
            <For each={props.overlay.oneOf}>
              {(option) => (
                <span class="flex-1 rounded-md bg-white/20 px-2 py-1 text-center text-xs text-white">
                  {option.name}
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={props.overlay.type === "Note"}>
        <p class="rounded-lg bg-black/30 px-3 py-1.5 text-center text-sm font-medium text-white drop-shadow-lg">
          {props.overlay.name}
        </p>
      </Show>
      <Show when={props.overlay.type === "Link"}>
        <span class="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-black">
          {props.overlay.name || props.overlay.href}
        </span>
      </Show>
    </>
  );
}

export function StoryComposerOverlayLayer(
  props: StoryComposerOverlayLayerProps,
) {
  const { t } = useI18n();
  let layerRef: HTMLDivElement | undefined;
  let drag: DragState | null = null;
  let resize: ResizeState | null = null;
  let capture: { target: HTMLElement; pointerId: number } | null = null;

  const endDrag = () => {
    drag = null;
    resize = null;
    if (capture?.target.hasPointerCapture(capture.pointerId))
      capture.target.releasePointerCapture(capture.pointerId);
    capture = null;
  };
  createEffect(() => {
    if (props.disabled) endDrag();
  });
  onCleanup(endDrag);

  const onPointerDown = (e: PointerEvent, item: OverlayItem) => {
    if (props.disabled) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    capture = {
      target: e.currentTarget as HTMLElement,
      pointerId: e.pointerId,
    };
    props.onSelect(item.id);
    drag = {
      id: item.id,
      startX: e.clientX,
      startY: e.clientY,
      originX: item.overlay.position.x,
      originY: item.overlay.position.y,
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!layerRef || props.disabled) return;
    const rect = layerRef.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (resize) {
      // Dragging the corner moves the right edge; width is centered, so the
      // total width changes by twice the horizontal drag.
      const dx = ((e.clientX - resize.startX) / rect.width) * 2;
      props.onResize(resize.id, resize.startWidth + dx);
      return;
    }
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    props.onMove(drag.id, drag.originX + dx, drag.originY + dy);
  };

  const onResizeDown = (e: PointerEvent, item: OverlayItem) => {
    if (props.disabled) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    capture = {
      target: e.currentTarget as HTMLElement,
      pointerId: e.pointerId,
    };
    resize = {
      id: item.id,
      startX: e.clientX,
      startWidth: item.overlay.position.width,
    };
  };

  const itemIds = createMemo(() => props.items.map((item) => item.id));
  const itemById = (id: string) => props.items.find((item) => item.id === id);

  const overlayLabel = (overlay: StoryOverlay): string => {
    const kindLabel =
      overlay.type === "Question"
        ? t("story.overlay.poll")
        : overlay.type === "Note"
          ? t("story.overlay.note")
          : t("story.overlay.link");
    const summary = (overlay.name || overlay.href || "").trim().slice(0, 40);
    const title = summary ? `${kindLabel}: ${summary}` : kindLabel;
    return `${title} — ${t("story.overlayKeyboardHint")}`;
  };

  const removeAndRestoreFocus = (id: string) => {
    const ids = itemIds();
    const index = ids.indexOf(id);
    const nextId = ids[index + 1] ?? ids[index - 1] ?? null;
    props.onRemove(id);
    queueMicrotask(() => {
      if (nextId) {
        const nextEl = layerRef?.querySelector<HTMLElement>(
          `[data-overlay-id="${CSS.escape(nextId)}"]`,
        );
        if (nextEl) {
          nextEl.focus();
          return;
        }
      }
      props.onRemoveFocusFallback?.();
    });
  };

  const handleOverlayKeyDown = (e: KeyboardEvent, item: OverlayItem) => {
    if (
      props.disabled ||
      isComposingKey(e) ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey
    ) {
      return;
    }
    // Let child buttons / resize slider handle their own keys.
    if (e.target !== e.currentTarget) return;
    const pos = item.overlay.position;
    const moveStep = e.shiftKey ? 0.06 : 0.02;
    const resizeStep = e.shiftKey ? 0.1 : 0.04;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        e.stopPropagation();
        props.onMove(item.id, pos.x - moveStep, pos.y);
        return;
      case "ArrowRight":
        e.preventDefault();
        e.stopPropagation();
        props.onMove(item.id, pos.x + moveStep, pos.y);
        return;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        props.onMove(item.id, pos.x, pos.y - moveStep);
        return;
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        props.onMove(item.id, pos.x, pos.y + moveStep);
        return;
      case "+":
      case "=":
        e.preventDefault();
        e.stopPropagation();
        props.onResize(item.id, pos.width + resizeStep);
        return;
      case "-":
      case "_":
        e.preventDefault();
        e.stopPropagation();
        props.onResize(item.id, pos.width - resizeStep);
        return;
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        props.onEdit(item.id);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        e.stopPropagation();
        removeAndRestoreFocus(item.id);
        return;
    }
  };

  const handleResizeKeyDown = (e: KeyboardEvent, item: OverlayItem) => {
    if (
      props.disabled ||
      isComposingKey(e) ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey
    ) {
      return;
    }
    const width = item.overlay.position.width;
    const step = e.shiftKey ? 0.1 : 0.04;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        props.onResize(item.id, width + step);
        return;
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        props.onResize(item.id, width - step);
        return;
      case "PageUp":
        e.preventDefault();
        e.stopPropagation();
        props.onResize(item.id, width + 0.1);
        return;
      case "PageDown":
        e.preventDefault();
        e.stopPropagation();
        props.onResize(item.id, width - 0.1);
        return;
      case "Home":
        e.preventDefault();
        e.stopPropagation();
        props.onResize(item.id, OVERLAY_MIN_WIDTH);
        return;
      case "End":
        e.preventDefault();
        e.stopPropagation();
        props.onResize(item.id, OVERLAY_MAX_WIDTH);
        return;
    }
  };

  return (
    // Container ignores pointer events so taps on empty space still reach the
    // canvas; each overlay re-enables them for drag/select. Iterate by stable
    // string id (not item object) so move/resize never remounts the focused node.
    <div
      ref={(el) => (layerRef = el)}
      class="pointer-events-none absolute inset-0 z-[6]"
    >
      <For each={itemIds()}>
        {(id) => {
          const item = () => itemById(id);
          const selected = () => props.selectedId === id;
          return (
            <Show when={item()}>
              {(current) => {
                const pos = () => current().overlay.position;
                const widthPercent = () => Math.round(pos().width * 100);
                // Flip the action pill below the overlay when near the top of
                // the stage so it never clips above the overflow-hidden stage.
                const showActionsBelow = () =>
                  pos().y - pos().height / 2 < 0.14;
                return (
                  <div
                    data-overlay-id={id}
                    role="group"
                    tabindex={props.disabled ? -1 : 0}
                    aria-label={overlayLabel(current().overlay)}
                    class="pointer-events-auto absolute flex touch-none select-none items-center justify-center rounded-xl"
                    classList={{
                      "outline outline-2 outline-white/80": selected(),
                    }}
                    style={{
                      left: `${(pos().x - pos().width / 2) * 100}%`,
                      top: `${(pos().y - pos().height / 2) * 100}%`,
                      width: `${pos().width * 100}%`,
                      "min-height": `${pos().height * 100}%`,
                      cursor: "move",
                    }}
                    onFocus={() => {
                      if (!props.disabled) props.onSelect(id);
                    }}
                    onKeyDown={(e) => handleOverlayKeyDown(e, current())}
                    onPointerDown={(e) => onPointerDown(e, current())}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    <OverlayPreview overlay={current().overlay} />

                    <Show when={selected()}>
                      <div
                        class={`absolute left-1/2 z-[1] flex w-max -translate-x-1/2 gap-1 rounded-full bg-neutral-900/95 px-1 py-0.5 md:py-1 shadow-lg ${
                          showActionsBelow()
                            ? "top-full mt-2"
                            : "-top-13 md:-top-9"
                        }`}
                      >
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (props.disabled) return;
                            props.onEdit(id);
                          }}
                          class="inline-flex min-h-11 min-w-11 md:min-h-0 md:min-w-0 items-center justify-center whitespace-nowrap rounded-full px-3 py-2 md:py-1 text-xs text-white hover:bg-white/10"
                        >
                          {t("story.overlay.edit")}
                        </button>
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (props.disabled) return;
                            removeAndRestoreFocus(id);
                          }}
                          aria-label={t("story.overlay.remove")}
                          class="inline-flex min-h-11 min-w-11 md:min-h-0 md:min-w-0 items-center justify-center whitespace-nowrap rounded-full px-3 py-2 md:py-1 text-xs text-red-400 hover:bg-white/10"
                        >
                          {t("story.overlay.remove")}
                        </button>
                      </div>
                    </Show>

                    {/* Corner resize handle (adjusts normalized width; height scales
                        to match). Federates via position.width/height. */}
                    <Show when={selected()}>
                      <div
                        role="slider"
                        tabindex={props.disabled ? -1 : 0}
                        aria-label={t("story.overlay.resize")}
                        aria-valuemin={Math.round(OVERLAY_MIN_WIDTH * 100)}
                        aria-valuemax={Math.round(OVERLAY_MAX_WIDTH * 100)}
                        aria-valuenow={widthPercent()}
                        aria-valuetext={`${widthPercent()}%`}
                        class="absolute -bottom-5 -right-5 z-[2] md:-bottom-2.5 md:-right-2.5 flex min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:h-6 md:w-6 cursor-nwse-resize items-center justify-center rounded-full"
                        onKeyDown={(e) => handleResizeKeyDown(e, current())}
                        onPointerDown={(e) => onResizeDown(e, current())}
                        onPointerMove={onPointerMove}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                      >
                        <span
                          aria-hidden="true"
                          class="h-5 w-5 rounded-full border-2 border-neutral-900 bg-white shadow"
                        />
                      </div>
                    </Show>
                  </div>
                );
              }}
            </Show>
          );
        }}
      </For>
    </div>
  );
}

export default StoryComposerOverlayLayer;
