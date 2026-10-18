/**
 * Instagram-style Text Editor Modal
 *
 * Full-screen text editing experience with:
 * - Direct text input in center
 * - Font, color, alignment controls at bottom
 * - Background style presets (none, semi-transparent, solid)
 * - Real-time preview
 */

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { FONTS } from "../../lib/story-canvas.ts";
import { useI18n } from "../../lib/i18n.tsx";
import type { TranslationKey } from "../../lib/i18n.tsx";
import { useDialog } from "../../lib/useDialog.ts";
import { onSwatchKeyDown, swatchTabIndex } from "./swatchGroup.ts";

// Text style presets (Instagram-like A, A, A buttons)
const TEXT_STYLES = [
  { id: "none", label: "A", bg: "transparent" },
  { id: "semi", label: "A", bg: "rgba(0,0,0,0.5)" },
  { id: "solid", label: "A", bg: "#000000" },
] as const;

// Color palette
const COLORS = [
  "#FFFFFF",
  "#000000",
  "#FF3B30",
  "#FF9500",
  "#FFCC00",
  "#34C759",
  "#007AFF",
  "#5856D6",
  "#AF52DE",
  "#FF2D55",
];

interface TextEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (text: TextData) => void;
  initialText?: TextData;
  // Where focus goes on close when the button that opened the editor is gone
  // (the empty canvas's タップしてテキストを追加 goes once text exists): focus
  // fell to <main> behind the composer.
  returnFocus?: () => HTMLElement | null | undefined;
}

export interface TextData {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  color: string;
  backgroundColor?: string;
  textAlign: "left" | "center" | "right";
  stroke?: { color: string; width: number };
}

const defaultTextData: TextData = {
  content: "",
  fontFamily: FONTS[0]?.family || "sans-serif",
  fontSize: 64,
  fontWeight: "bold",
  fontStyle: "normal",
  color: "#FFFFFF",
  backgroundColor: undefined,
  textAlign: "center",
  stroke: { color: "#000000", width: 3 },
};

export function TextEditorModal(props: TextEditorModalProps) {
  const { t } = useI18n();
  const [text, setText] = createSignal<TextData>(
    props.initialText || defaultTextData,
  );
  const [showFontPicker, setShowFontPicker] = createSignal(false);
  const [showColorPicker, setShowColorPicker] = createSignal(false);
  let inputRef!: HTMLTextAreaElement;
  let rootRef: HTMLDivElement | undefined;
  let fontToggleRef: HTMLButtonElement | undefined;
  let colorToggleRef: HTMLButtonElement | undefined;
  // The colour input returns lowercase hex; the swatches are uppercase.
  const sameColor = (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase();
  // An opened list takes focus on its checked item, as the composer's
  // panels do: from the toggle, Tab went to 完了 first.
  const focusList = (list: "font" | "color") =>
    queueMicrotask(() =>
      rootRef
        ?.querySelector<HTMLElement>(
          `[data-text-list="${list}"] [tabindex="0"]`,
        )
        ?.focus(),
    );

  // Full-screen text editor: trap focus, lock scroll, and close on Escape. It
  // sits ABOVE the composer on the shared dialog stack, so Escape dismisses the
  // text editor first (returning to the composer) rather than the whole sheet.
  useDialog({
    isOpen: () => props.isOpen,
    // Escape closes an open list first, back to its toggle: it closed the
    // whole editor and dropped the typed text.
    // Focus goes back to the toggle only from inside the list: from the
    // text field it took the typing away.
    onClose: () => {
      const inList = (list: string) =>
        !!document.activeElement?.closest(`[data-text-list="${list}"]`);
      if (showColorPicker()) {
        const back = inList("color");
        setShowColorPicker(false);
        if (back) colorToggleRef?.focus();
        return;
      }
      if (showFontPicker()) {
        const back = inList("font");
        setShowFontPicker(false);
        if (back) fontToggleRef?.focus();
        return;
      }
      props.onClose();
    },
    container: () => rootRef,
    initialFocus: () => inputRef,
    returnFocus: () => props.returnFocus?.(),
  });

  // Focus input when modal opens
  createEffect(() => {
    if (props.isOpen && inputRef) {
      const timeoutId = setTimeout(() => {
        inputRef?.focus();
      }, 100);
      // onCleanup, NOT a returned function: Solid ignores an effect's return
      // value, so the returned clearTimeout never ran and the deferred focus
      // could fire after the modal closed.
      onCleanup(() => clearTimeout(timeoutId));
    }
  });

  // Reset state when initialText changes
  createEffect(() => {
    if (props.isOpen) {
      setText(props.initialText || defaultTextData);
      // A list left open stayed open the next time the editor opened.
      setShowColorPicker(false);
      setShowFontPicker(false);
    }
  });

  const handleSave = () => {
    const t = text();
    if (t.content.trim()) {
      props.onSave(t);
    }
    props.onClose();
  };

  const handleStyleChange = (styleId: string) => {
    const style = TEXT_STYLES.find((s) => s.id === styleId);
    if (style) {
      setText((prev) => ({
        ...prev,
        backgroundColor: style.bg === "transparent" ? undefined : style.bg,
      }));
    }
  };

  const getCurrentStyle = () => {
    const t = text();
    if (!t.backgroundColor) return "none";
    if (t.backgroundColor.includes("rgba")) return "semi";
    return "solid";
  };

  return (
    <Show when={props.isOpen}>
      <div
        ref={(el) => (rootRef = el)}
        role="dialog"
        aria-modal="true"
        aria-label={t("story.textEditorAriaLabel")}
        // Scrolls when it does not fit: on a phone on its side, and on a
        // 320×568 phone with a list open, the alignment, size and B / I rows
        // were below the screen and could not be reached. Spacing is tighter
        // on short screens so it usually fits without scrolling.
        class="fixed inset-0 z-[60] bg-black/90 flex flex-col overflow-y-auto overscroll-contain"
      >
        {/* Header: stays at the top when the editor scrolls, with キャンセル
            and 完了. */}
        <div class="sticky top-0 z-10 flex items-center justify-between bg-black px-4 py-3">
          <button
            onClick={props.onClose}
            class="text-white text-lg font-medium"
          >
            {t("common.cancel")}
          </button>
          <div class="flex gap-2">
            {/* Font picker toggle */}
            <button
              ref={fontToggleRef}
              type="button"
              onClick={() => {
                setShowFontPicker(!showFontPicker());
                setShowColorPicker(false);
                if (showFontPicker()) focusList("font");
              }}
              // It read only 「Aa」.
              aria-label={t("story.font")}
              aria-expanded={showFontPicker()}
              class={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                showFontPicker()
                  ? "bg-white text-black"
                  : "bg-white/20 text-white"
              }`}
            >
              Aa
            </button>
            {/* Color picker toggle */}
            <button
              ref={colorToggleRef}
              type="button"
              onClick={() => {
                setShowColorPicker(!showColorPicker());
                setShowFontPicker(false);
                if (showColorPicker()) focusList("color");
              }}
              aria-label={t("story.textColor")}
              aria-haspopup="true"
              aria-expanded={showColorPicker()}
              class="w-8 h-8 rounded-full border-2 border-white"
              style={{ "background-color": text().color }}
            />
          </div>
          <button
            onClick={handleSave}
            class="text-accent text-lg font-semibold"
          >
            {t("story.done")}
          </button>
        </div>

        {/* Font picker dropdown */}
        <Show when={showFontPicker()}>
          <div class="px-4 py-2 bg-black/50">
            {/* One choice of several: a radio group with one Tab stop, and
                arrow keys inside (the chips gave no sign of which was on). */}
            <div
              data-text-list="font"
              role="radiogroup"
              aria-label={t("story.font")}
              onKeyDown={onSwatchKeyDown}
              // A scroll container is a Tab stop in Firefox.
              tabIndex={-1}
              class="flex gap-2 overflow-x-auto pb-2 scrollbar-hide"
            >
              <For each={FONTS}>
                {(font, index) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={text().fontFamily === font.family}
                    tabIndex={swatchTabIndex(
                      text().fontFamily === font.family,
                      index(),
                      FONTS.some((f) => f.family === text().fontFamily),
                    )}
                    onClick={() =>
                      setText((prev) => ({ ...prev, fontFamily: font.family }))
                    }
                    // Ring drawn inside: the scrolling row clipped it.
                    class={`focus-inset px-4 py-2 rounded-full whitespace-nowrap text-sm transition-colors ${
                      text().fontFamily === font.family
                        ? "bg-white text-black"
                        : "bg-white/20 text-white"
                    }`}
                    style={{ "font-family": font.family }}
                  >
                    {/* FONTS holds i18n keys, not names: shown as they
                        were, the chips read 「story.fontGothic」. */}
                    {t(font.name as TranslationKey)}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Color picker dropdown */}
        <Show when={showColorPicker()}>
          {/* The whole panel, so the custom colour input counts as inside
              the list too (Escape from it lost focus to <body>). */}
          <div data-text-list="color" class="px-4 py-3 bg-black/50">
            <div class="flex items-center justify-center gap-3">
              {/* The swatches had no name and no state: one radio group with
                  one Tab stop, named by colour like the drawing panel's.
                  Eleven 32px circles in a row did not fit a phone: 「＋」
                  (custom) ran off the right edge. Two rows of five there. */}
              <div
                role="radiogroup"
                aria-label={t("story.textColor")}
                onKeyDown={onSwatchKeyDown}
                class="grid grid-cols-5 gap-2 sm:flex"
              >
                <For each={COLORS}>
                  {(color, index) => (
                    <button
                      type="button"
                      role="radio"
                      aria-label={t("story.selectColor").replace(
                        "{color}",
                        color,
                      )}
                      aria-checked={sameColor(text().color, color)}
                      tabIndex={swatchTabIndex(
                        sameColor(text().color, color),
                        index(),
                        COLORS.some((c) => sameColor(text().color, c)),
                      )}
                      onClick={() => setText((prev) => ({ ...prev, color }))}
                      class={`size-8 rounded-full transition-transform ${
                        sameColor(text().color, color)
                          ? "scale-125 ring-2 ring-white ring-offset-2 ring-offset-black"
                          : ""
                      }`}
                      style={{ "background-color": color }}
                    />
                  )}
                </For>
              </div>
              {/* Custom color input. The input itself is invisible, so its
                  focus is shown on the round label (it had no visible focus
                  and no name). */}
              <label class="relative size-8 shrink-0 rounded-full bg-gradient-to-br from-red-500 via-green-500 to-blue-500 cursor-pointer flex items-center justify-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-white">
                <input
                  type="color"
                  aria-label={t("story.customColor")}
                  value={text().color}
                  onInput={(e) =>
                    setText((prev) => ({
                      ...prev,
                      color: e.currentTarget.value,
                    }))
                  }
                  class="opacity-0 absolute w-0 h-0"
                />
                <span aria-hidden="true" class="text-white text-xs">
                  +
                </span>
              </label>
            </div>
          </div>
        </Show>

        {/* Main text input area */}
        <div class="flex-1 flex items-center justify-center p-8 [@media(max-height:600px)]:p-4">
          <div
            class="w-full max-w-md"
            style={{
              "background-color": text().backgroundColor,
              padding: text().backgroundColor ? "16px 24px" : "0",
              "border-radius": text().backgroundColor ? "12px" : "0",
            }}
          >
            <textarea
              ref={inputRef}
              value={text().content}
              onInput={(e) =>
                setText((prev) => ({
                  ...prev,
                  content: e.currentTarget.value,
                }))
              }
              placeholder={t("story.textPlaceholder")}
              class="w-full bg-transparent border-none outline-none resize-none text-center"
              style={{
                "font-family": text().fontFamily,
                "font-size": `${Math.min(text().fontSize, 48)}px`,
                "font-weight": text().fontWeight,
                "font-style": text().fontStyle,
                color: text().color,
                "text-align": text().textAlign,
                "text-shadow": text().stroke
                  ? `
                    -${text().stroke!.width}px -${text().stroke!.width}px 0 ${
                      text().stroke!.color
                    },
                    ${text().stroke!.width}px -${text().stroke!.width}px 0 ${
                      text().stroke!.color
                    },
                    -${text().stroke!.width}px ${text().stroke!.width}px 0 ${
                      text().stroke!.color
                    },
                    ${text().stroke!.width}px ${text().stroke!.width}px 0 ${
                      text().stroke!.color
                    }
                  `
                  : "none",
                "line-height": "1.4",
                "min-height": "100px",
              }}
              rows={3}
            />
          </div>
        </div>

        {/* Bottom toolbar */}
        <div class="px-4 py-4 bg-black/50 space-y-4 [@media(max-height:600px)]:py-2 [@media(max-height:600px)]:space-y-2">
          {/* Text style buttons (A, A, A) */}
          <div class="flex justify-center gap-4">
            <For each={TEXT_STYLES}>
              {(style) => (
                <button
                  onClick={() => handleStyleChange(style.id)}
                  class={`w-10 h-10 rounded-lg flex items-center justify-center font-bold text-lg transition-all ${
                    getCurrentStyle() === style.id
                      ? "ring-2 ring-white scale-110"
                      : ""
                  }`}
                  style={{
                    "background-color":
                      style.id === "none" ? "transparent" : style.bg,
                    color: "#fff",
                    border:
                      style.id === "none"
                        ? "2px solid rgba(255,255,255,0.5)"
                        : "none",
                  }}
                >
                  A
                </button>
              )}
            </For>
          </div>

          {/* Alignment: icons only, so named; one radio group. */}
          <div
            role="radiogroup"
            aria-label={t("story.align")}
            onKeyDown={onSwatchKeyDown}
            class="flex justify-center gap-2"
          >
            <For each={["left", "center", "right"] as const}>
              {(align, index) => (
                <button
                  type="button"
                  role="radio"
                  aria-label={t(
                    align === "left"
                      ? "story.alignLeft"
                      : align === "center"
                        ? "story.alignCenter"
                        : "story.alignRight",
                  )}
                  aria-checked={text().textAlign === align}
                  tabIndex={swatchTabIndex(
                    text().textAlign === align,
                    index(),
                    true,
                  )}
                  onClick={() =>
                    setText((prev) => ({ ...prev, textAlign: align }))
                  }
                  class={`w-12 h-10 rounded-lg flex items-center justify-center transition-colors ${
                    text().textAlign === align
                      ? "bg-white text-black"
                      : "bg-white/20 text-white"
                  }`}
                >
                  <Show when={align === "left"}>
                    <svg
                      class="w-5 h-5"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 5A.75.75 0 012.75 9h9.5a.75.75 0 010 1.5h-9.5A.75.75 0 012 9.75zm0 5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  </Show>
                  <Show when={align === "center"}>
                    <svg
                      class="w-5 h-5"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm2.5 5a.75.75 0 01.75-.75h9.5a.75.75 0 010 1.5h-9.5a.75.75 0 01-.75-.75zm-2.5 5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  </Show>
                  <Show when={align === "right"}>
                    <svg
                      class="w-5 h-5"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm5 5a.75.75 0 01.75-.75h9.5a.75.75 0 010 1.5h-9.5A.75.75 0 017 9.75zm-5 5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  </Show>
                </button>
              )}
            </For>
          </div>

          {/* Font size slider */}
          <div class="flex items-center gap-3 px-2">
            <span class="text-white/60 text-xs">A</span>
            <input
              type="range"
              min="24"
              max="120"
              // It had no name.
              aria-label={t("story.fontSize").replace(
                "{value}",
                String(text().fontSize),
              )}
              value={text().fontSize}
              onInput={(e) =>
                setText((prev) => ({
                  ...prev,
                  fontSize: parseInt(e.currentTarget.value),
                }))
              }
              class="flex-1 accent-white h-1"
            />
            <span class="text-white text-sm">A</span>
          </div>

          {/* Bold / Italic toggle */}
          <div class="flex justify-center gap-2">
            {/* Toggles: their state was only the colour. */}
            <button
              type="button"
              aria-pressed={text().fontWeight === "bold"}
              onClick={() =>
                setText((prev) => ({
                  ...prev,
                  fontWeight: prev.fontWeight === "bold" ? "normal" : "bold",
                }))
              }
              class={`w-12 h-10 rounded-lg flex items-center justify-center font-bold transition-colors ${
                text().fontWeight === "bold"
                  ? "bg-white text-black"
                  : "bg-white/20 text-white"
              }`}
            >
              B
            </button>
            <button
              type="button"
              aria-pressed={text().fontStyle === "italic"}
              onClick={() =>
                setText((prev) => ({
                  ...prev,
                  fontStyle: prev.fontStyle === "italic" ? "normal" : "italic",
                }))
              }
              class={`w-12 h-10 rounded-lg flex items-center justify-center italic transition-colors ${
                text().fontStyle === "italic"
                  ? "bg-white text-black"
                  : "bg-white/20 text-white"
              }`}
            >
              I
            </button>
            <button
              type="button"
              // It read 「A」, like the background styles.
              aria-label={t("story.stroke")}
              aria-pressed={!!text().stroke}
              onClick={() =>
                setText((prev) => ({
                  ...prev,
                  stroke: prev.stroke
                    ? undefined
                    : { color: "#000000", width: 3 },
                }))
              }
              class={`w-12 h-10 rounded-lg flex items-center justify-center font-bold transition-colors ${
                text().stroke ? "bg-white text-black" : "bg-white/20 text-white"
              }`}
              style={{
                "text-shadow":
                  "1px 1px 0 #666, -1px -1px 0 #666, 1px -1px 0 #666, -1px 1px 0 #666",
              }}
            >
              A
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

export default TextEditorModal;
