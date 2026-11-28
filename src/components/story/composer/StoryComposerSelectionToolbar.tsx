import { Show } from "solid-js";
import type { Layer } from "../../../lib/story-canvas.ts";
import { useI18n } from "../../../lib/i18n.tsx";

interface StoryComposerSelectionToolbarProps {
  selectedLayer: Layer | null;
  onEditText: (layerId: string) => void;
  onEnlarge: () => void;
  onShrink: () => void;
  onRotate: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
}

export function StoryComposerSelectionToolbar(
  props: StoryComposerSelectionToolbarProps,
) {
  const { t } = useI18n();
  return (
    <Show
      when={props.selectedLayer && props.selectedLayer.type !== "background"}
    >
      <div
        role="toolbar"
        aria-label={t("story.layerControls")}
        aria-orientation="vertical"
        class="pointer-events-auto absolute top-1/2 left-4 z-10 -translate-y-1/2 flex max-h-[calc(100%-12rem)] flex-col gap-1 overflow-y-auto scrollbar-hide bg-black/70 backdrop-blur-sm rounded-2xl p-1.5 shadow-lg"
      >
        <Show when={props.selectedLayer!.type === "text"}>
          <button
            type="button"
            onClick={() => props.onEditText(props.selectedLayer!.id)}
            aria-label={t("common.edit")}
            title={t("common.edit")}
            class="flex h-11 w-11 shrink-0 items-center justify-center text-white hover:bg-white/20 rounded-xl transition-colors"
          >
            <svg
              class="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
        </Show>
        <button
          type="button"
          onClick={props.onEnlarge}
          aria-label={t("story.enlarge")}
          title={t("story.enlarge")}
          class="flex h-11 w-11 shrink-0 items-center justify-center text-white hover:bg-white/20 rounded-xl transition-colors"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M12 5v14m7-7H5"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={props.onShrink}
          aria-label={t("story.shrink")}
          title={t("story.shrink")}
          class="flex h-11 w-11 shrink-0 items-center justify-center text-white hover:bg-white/20 rounded-xl transition-colors"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M19 12H5"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={props.onRotate}
          aria-label={t("story.rotate")}
          title={t("story.rotate")}
          class="flex h-11 w-11 shrink-0 items-center justify-center text-white hover:bg-white/20 rounded-xl transition-colors"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M4 4v5h5M20 20v-5h-5M5.64 17.36A9 9 0 0019.07 15M18.36 6.64A9 9 0 004.93 9"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={props.onBringToFront}
          aria-label={t("story.toFront")}
          title={t("story.toFront")}
          class="flex h-11 w-11 shrink-0 items-center justify-center text-white hover:bg-white/20 rounded-xl transition-colors"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M5 15l7-7 7 7"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={props.onSendToBack}
          aria-label={t("story.toBack")}
          title={t("story.toBack")}
          class="flex h-11 w-11 shrink-0 items-center justify-center text-white hover:bg-white/20 rounded-xl transition-colors"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={props.onDelete}
          aria-label={t("common.delete")}
          title={t("common.delete")}
          class="flex h-11 w-11 shrink-0 items-center justify-center text-red-400 hover:bg-red-500/20 rounded-xl transition-colors"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </div>
    </Show>
  );
}
