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

import { For, Show } from "solid-js";
import { useI18n } from "../../../lib/i18n.tsx";
import type { StoryOverlay } from "../../../types/index.ts";
import type { OverlayItem } from "./useStoryOverlays.ts";

interface StoryComposerOverlayLayerProps {
  items: OverlayItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, width: number) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
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

  const onPointerDown = (e: PointerEvent, item: OverlayItem) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
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
    if (!layerRef) return;
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

  const endDrag = () => {
    drag = null;
    resize = null;
  };

  const onResizeDown = (e: PointerEvent, item: OverlayItem) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    resize = {
      id: item.id,
      startX: e.clientX,
      startWidth: item.overlay.position.width,
    };
  };

  return (
    // Container ignores pointer events so taps on empty space still reach the
    // canvas; each overlay re-enables them for drag/select.
    <div ref={(el) => (layerRef = el)} class="pointer-events-none absolute inset-0 z-[6]">
      <For each={props.items}>
        {(item) => {
          const pos = () => item.overlay.position;
          const selected = () => props.selectedId === item.id;
          return (
            <div
              class="pointer-events-auto absolute flex touch-none select-none items-center justify-center"
              classList={{ "outline outline-2 outline-white/80 rounded-xl": selected() }}
              style={{
                left: `${(pos().x - pos().width / 2) * 100}%`,
                top: `${(pos().y - pos().height / 2) * 100}%`,
                width: `${pos().width * 100}%`,
                "min-height": `${pos().height * 100}%`,
                cursor: "move",
              }}
              onPointerDown={(e) => onPointerDown(e, item)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <OverlayPreview overlay={item.overlay} />

              <Show when={selected()}>
                <div class="absolute -top-9 left-1/2 flex -translate-x-1/2 gap-1 rounded-full bg-neutral-900/95 px-1 py-1 shadow-lg">
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onEdit(item.id);
                    }}
                    class="rounded-full px-3 py-1 text-xs text-white hover:bg-white/10"
                  >
                    {t("story.overlay.edit")}
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRemove(item.id);
                    }}
                    aria-label={t("story.overlay.remove")}
                    class="rounded-full px-3 py-1 text-xs text-red-400 hover:bg-white/10"
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
                  aria-label={t("story.overlay.resize")}
                  class="absolute -bottom-2 -right-2 h-5 w-5 cursor-nwse-resize rounded-full border-2 border-neutral-900 bg-white shadow"
                  onPointerDown={(e) => onResizeDown(e, item)}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export default StoryComposerOverlayLayer;
