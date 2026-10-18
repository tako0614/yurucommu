import { For, Show } from "solid-js";
import { DrawingPanel } from "../DrawingPanel.tsx";
import { StickerPanel } from "../StickerPanel.tsx";
import { useI18n } from "../../../lib/i18n.tsx";
import type { OverlayKind } from "./useStoryOverlays.ts";

/**
 * A tool panel takes focus when it opens, on its first enabled control inside
 * `[data-panel-start]`. The panels come after the caption and 投稿 in the DOM,
 * so from the rail button that opened one it took a Tab through the rest of
 * the rail and the footer to reach it.
 */
export function focusPanelStart(panel: HTMLElement) {
  queueMicrotask(() => {
    panel
      .querySelector<HTMLElement>(
        '[data-panel-start] :is(button, input, select):not(:disabled):not([tabindex="-1"])',
      )
      ?.focus();
  });
}

interface StoryComposerStickerPanelProps {
  open: boolean;
  onAddEmoji: (emoji: string) => void;
  onAddOverlay: (kind: OverlayKind) => void;
  canAddOverlay: (kind: OverlayKind) => boolean;
  onClose: () => void;
}

const INTERACTIVE_STICKERS = [
  { kind: "Question", icon: "📊", labelKey: "story.overlay.poll" },
  { kind: "Note", icon: "💬", labelKey: "story.overlay.note" },
  { kind: "Link", icon: "🔗", labelKey: "story.overlay.link" },
] as const satisfies ReadonlyArray<{
  kind: OverlayKind;
  icon: string;
  labelKey: string;
}>;

const CloseIcon = () => (
  <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M6 18L18 6M6 6l12 12"
    />
  </svg>
);

export function StoryComposerStickerPanel(
  props: StoryComposerStickerPanelProps,
) {
  const { t } = useI18n();
  return (
    <Show when={props.open}>
      <div
        ref={focusPanelStart}
        role="group"
        aria-label={t("story.stamp")}
        class="absolute left-4 right-4 z-20 bg-neutral-900/95 backdrop-blur-sm rounded-2xl p-4 max-h-[40vh] overflow-y-auto"
        style={{
          bottom: "calc(max(env(safe-area-inset-bottom, 0px), 16px) + 130px)",
        }}
      >
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-white font-medium">{t("story.stamp")}</h3>
          <button
            type="button"
            onClick={props.onClose}
            aria-label={t("common.close")}
            class="text-white/60 hover:text-white p-1"
          >
            <CloseIcon />
          </button>
        </div>
        <div data-panel-start>
          {/* Interactive stickers (poll / note / link) — federate as
              StoryOverlay and stay editable/positionable over the media,
              unlike emoji which bake into the image. */}
          <div class="mb-3 grid grid-cols-3 gap-2">
            <For each={INTERACTIVE_STICKERS}>
              {(sticker) => (
                <button
                  type="button"
                  disabled={!props.canAddOverlay(sticker.kind)}
                  onClick={() => props.onAddOverlay(sticker.kind)}
                  class="flex flex-col items-center gap-1 rounded-xl bg-white/10 py-3 text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span class="text-2xl">{sticker.icon}</span>
                  <span class="text-xs">{t(sticker.labelKey)}</span>
                </button>
              )}
            </For>
          </div>
          <StickerPanel onAddEmoji={props.onAddEmoji} />
        </div>
      </div>
    </Show>
  );
}

interface DrawingSettings {
  color: string;
  width: number;
  opacity: number;
}

interface StoryComposerDrawingPanelProps {
  isDrawing: boolean;
  drawingSettings: DrawingSettings;
  onDrawingSettingsChange: (next: DrawingSettings) => void;
  onClear: () => void;
  onUndo: () => void;
  onDone: () => void;
}

// Docked at the stage's bottom edge, over the caption and 投稿 (hidden while
// drawing): the panel sat in the middle of the canvas and covered most of it,
// so a stroke could not be seen or even started there.
export function StoryComposerDrawingPanel(
  props: StoryComposerDrawingPanelProps,
) {
  const { t } = useI18n();
  return (
    <Show when={props.isDrawing}>
      <div
        ref={focusPanelStart}
        role="group"
        aria-label={t("story.drawing")}
        class="absolute left-3 right-3 z-20 max-h-[45%] overflow-y-auto rounded-2xl bg-neutral-900/95 p-3 shadow-2xl backdrop-blur-sm"
        style={{
          bottom: "max(env(safe-area-inset-bottom, 0px), 12px)",
        }}
      >
        <DrawingPanel
          color={props.drawingSettings.color}
          width={props.drawingSettings.width}
          opacity={props.drawingSettings.opacity}
          onColorChange={(color) =>
            props.onDrawingSettingsChange({ ...props.drawingSettings, color })
          }
          onWidthChange={(width) =>
            props.onDrawingSettingsChange({ ...props.drawingSettings, width })
          }
          onOpacityChange={(opacity) =>
            props.onDrawingSettingsChange({
              ...props.drawingSettings,
              opacity,
            })
          }
          onClear={props.onClear}
          onUndo={props.onUndo}
          onDone={props.onDone}
        />
      </div>
    </Show>
  );
}
