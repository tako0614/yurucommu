/**
 * Drawing Panel for Story Editor
 *
 * Controls drawing tool properties: color, brush width, and opacity.
 */

import { ColorPicker } from "./ColorPicker.tsx";
import { useI18n } from "../../lib/i18n.tsx";

interface DrawingPanelProps {
  color: string;
  width: number;
  opacity: number;
  onColorChange: (color: string) => void;
  onWidthChange: (width: number) => void;
  onOpacityChange: (opacity: number) => void;
  onClear: () => void;
  onUndo: () => void;
  onDone: () => void;
}

// Compact, so it can dock below the drawing instead of over it: the actions
// share the title row, the two sliders share a row, and the brush preview sits
// beside them instead of in a box of its own. Where the stage is too narrow
// for the preview (a 320px phone, a phone on its side), the sliders keep the
// room, so their values stay readable.
export function DrawingPanel(props: DrawingPanelProps) {
  const { t } = useI18n();
  const thickness = () =>
    t("story.thickness").replace("{value}", String(props.width));
  const opacity = () =>
    t("story.opacity").replace(
      "{value}",
      String(Math.round(props.opacity * 100)),
    );
  return (
    <div class="@container space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="mr-auto font-medium text-white">{t("story.drawing")}</h3>
        <button
          type="button"
          onClick={props.onUndo}
          class="rounded-lg bg-neutral-800 px-3 py-1.5 text-sm text-white transition-colors hover:bg-neutral-700"
        >
          {t("story.undo")}
        </button>
        <button
          type="button"
          onClick={props.onClear}
          class="rounded-lg bg-red-500/20 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/30"
        >
          {t("story.clear")}
        </button>
        <button
          type="button"
          onClick={props.onDone}
          class="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-white/90"
        >
          {t("story.done")}
        </button>
      </div>

      <div data-panel-start>
        <ColorPicker color={props.color} onChange={props.onColorChange} />
      </div>

      <div class="flex items-center gap-3">
        <div class="grid min-w-0 flex-1 grid-cols-2 gap-3">
          <label class="min-w-0 text-sm text-neutral-400">
            <span class="block truncate">{thickness()}</span>
            <input
              type="range"
              min="2"
              max="50"
              value={props.width}
              onInput={(e) =>
                props.onWidthChange(parseInt(e.currentTarget.value))
              }
              class="mt-1 w-full accent-blue-500"
            />
          </label>
          <label class="min-w-0 text-sm text-neutral-400">
            <span class="block truncate">{opacity()}</span>
            <input
              type="range"
              min="10"
              max="100"
              value={props.opacity * 100}
              onInput={(e) =>
                props.onOpacityChange(parseInt(e.currentTarget.value) / 100)
              }
              class="mt-1 w-full accent-blue-500"
            />
          </label>
        </div>
        {/* Brush preview, at its real size (up to the 50px maximum). */}
        <div
          aria-hidden="true"
          class="hidden size-13 shrink-0 items-center justify-center rounded-lg bg-neutral-800 @[20rem]:flex"
        >
          <div
            class="rounded-full"
            style={{
              width: `${props.width}px`,
              height: `${props.width}px`,
              "background-color": props.color,
              opacity: props.opacity,
            }}
          />
        </div>
      </div>
    </div>
  );
}
