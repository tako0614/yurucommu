/**
 * Overlay editor modal — authors an interactive Story overlay (poll / note /
 * link). Produces a `StoryOverlay` whose `position` is preserved when editing
 * or defaulted (canvas center) when creating. Client-side validation mirrors
 * the backend `validateOverlays` rules.
 */

import { createEffect, createSignal, Index, Show } from "solid-js";
import { useI18n } from "../../../lib/i18n.tsx";
import { useDialog } from "../../../lib/useDialog.ts";
import type { StoryOverlay } from "../../../types/index.ts";
import {
  defaultOverlayPosition,
  type OverlayKind,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
} from "./useStoryOverlays.ts";

interface StoryOverlayEditorModalProps {
  open: boolean;
  kind: OverlayKind;
  initial?: StoryOverlay | null;
  onSave: (overlay: StoryOverlay) => void;
  onClose: () => void;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function StoryOverlayEditorModal(props: StoryOverlayEditorModalProps) {
  const { t } = useI18n();
  let rootRef: HTMLDivElement | undefined;

  const [question, setQuestion] = createSignal("");
  const [options, setOptions] = createSignal<string[]>(["", ""]);
  const [noteText, setNoteText] = createSignal("");
  const [linkLabel, setLinkLabel] = createSignal("");
  const [linkUrl, setLinkUrl] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  useDialog({
    isOpen: () => props.open,
    onClose: props.onClose,
    container: () => rootRef,
  });

  // Seed the form whenever the modal opens (create → blank/defaults, edit →
  // hydrate from the existing overlay).
  createEffect(() => {
    if (!props.open) return;
    setError(null);
    const init = props.initial ?? null;
    if (props.kind === "Question") {
      setQuestion(init?.name ?? "");
      const opts = init?.oneOf?.map((o) => o.name) ?? ["", ""];
      setOptions(opts.length >= POLL_MIN_OPTIONS ? opts : ["", ""]);
    } else if (props.kind === "Note") {
      setNoteText(init?.name ?? "");
    } else {
      setLinkLabel(init?.name ?? "");
      setLinkUrl(typeof init?.href === "string" ? init.href : "");
    }
  });

  const position = () =>
    props.initial?.position ?? defaultOverlayPosition(props.kind);

  const addOption = () => {
    if (options().length >= POLL_MAX_OPTIONS) return;
    setOptions((prev) => [...prev, ""]);
  };
  const removeOption = (index: number) => {
    if (options().length <= POLL_MIN_OPTIONS) return;
    setOptions((prev) => prev.filter((_, i) => i !== index));
  };
  const setOption = (index: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  };

  const submit = (event: Event) => {
    event.preventDefault();
    if (props.kind === "Question") {
      const name = question().trim();
      const opts = options()
        .map((o) => o.trim())
        .filter(Boolean);
      if (!name) return setError(t("story.overlay.required"));
      if (opts.length < POLL_MIN_OPTIONS) {
        return setError(t("story.overlay.pollNeedsOptions"));
      }
      props.onSave({
        type: "Question",
        position: position(),
        name,
        oneOf: opts.map((o) => ({ type: "Note", name: o })),
      });
    } else if (props.kind === "Note") {
      const name = noteText().trim();
      if (!name) return setError(t("story.overlay.required"));
      props.onSave({ type: "Note", position: position(), name });
    } else {
      const href = linkUrl().trim();
      if (!isValidUrl(href)) return setError(t("story.overlay.invalidUrl"));
      const overlay: StoryOverlay = {
        type: "Link",
        position: position(),
        href,
      };
      const label = linkLabel().trim();
      if (label) overlay.name = label;
      props.onSave(overlay);
    }
    props.onClose();
  };

  const title = () =>
    props.kind === "Question"
      ? t("story.overlay.poll")
      : props.kind === "Note"
        ? t("story.overlay.note")
        : t("story.overlay.link");

  return (
    <Show when={props.open}>
      <div
        ref={(el) => (rootRef = el)}
        role="dialog"
        aria-modal="true"
        aria-label={title()}
        class="fixed inset-0 z-[62] flex items-center justify-center bg-black/70 p-4"
      >
        <form
          onSubmit={submit}
          class="w-full max-w-sm rounded-2xl bg-neutral-900 p-5 text-white shadow-2xl"
        >
          <h3 class="mb-4 text-lg font-semibold">{title()}</h3>

          <Show when={props.kind === "Question"}>
            <label class="mb-2 block text-sm text-white/70">
              {t("story.overlay.pollQuestion")}
            </label>
            <input
              value={question()}
              onInput={(e) => setQuestion(e.currentTarget.value)}
              maxLength={80}
              placeholder={t("story.overlay.pollQuestionPlaceholder")}
              class="mb-3 w-full rounded-lg bg-white/10 px-3 py-2 text-white placeholder-white/40 outline-none focus:ring-2 focus:ring-white/40"
            />
            <label class="mb-2 block text-sm text-white/70">
              {t("story.overlay.pollOptions")}
            </label>
            <div class="space-y-2">
              {/* Index (not For): the options are editable primitives, so the
                  inputs must stay mounted per slot — For would re-key by value
                  and remount the field on each keystroke, dropping all but the
                  first character. */}
              <Index each={options()}>
                {(option, index) => (
                  <div class="flex items-center gap-2">
                    <input
                      value={option()}
                      onInput={(e) => setOption(index, e.currentTarget.value)}
                      maxLength={30}
                      placeholder={`${t("story.overlay.pollOption")} ${index + 1}`}
                      class="flex-1 rounded-lg bg-white/10 px-3 py-2 text-white placeholder-white/40 outline-none focus:ring-2 focus:ring-white/40"
                    />
                    <Show when={options().length > POLL_MIN_OPTIONS}>
                      <button
                        type="button"
                        onClick={() => removeOption(index)}
                        aria-label={t("story.overlay.remove")}
                        class="rounded-lg px-2 py-2 text-white/60 hover:text-white"
                      >
                        ✕
                      </button>
                    </Show>
                  </div>
                )}
              </Index>
            </div>
            <Show when={options().length < POLL_MAX_OPTIONS}>
              <button
                type="button"
                onClick={addOption}
                class="mt-2 text-sm text-white/70 hover:text-white"
              >
                + {t("story.overlay.addOption")}
              </button>
            </Show>
          </Show>

          <Show when={props.kind === "Note"}>
            <label class="mb-2 block text-sm text-white/70">
              {t("story.overlay.noteText")}
            </label>
            <textarea
              value={noteText()}
              onInput={(e) => setNoteText(e.currentTarget.value)}
              maxLength={120}
              rows={3}
              placeholder={t("story.overlay.notePlaceholder")}
              class="w-full resize-none rounded-lg bg-white/10 px-3 py-2 text-white placeholder-white/40 outline-none focus:ring-2 focus:ring-white/40"
            />
          </Show>

          <Show when={props.kind === "Link"}>
            <label class="mb-2 block text-sm text-white/70">
              {t("story.overlay.linkLabel")}
            </label>
            <input
              value={linkLabel()}
              onInput={(e) => setLinkLabel(e.currentTarget.value)}
              maxLength={40}
              placeholder={t("story.overlay.linkLabelPlaceholder")}
              class="mb-3 w-full rounded-lg bg-white/10 px-3 py-2 text-white placeholder-white/40 outline-none focus:ring-2 focus:ring-white/40"
            />
            <label class="mb-2 block text-sm text-white/70">
              {t("story.overlay.linkUrl")}
            </label>
            <input
              value={linkUrl()}
              onInput={(e) => setLinkUrl(e.currentTarget.value)}
              type="url"
              inputmode="url"
              placeholder="https://…"
              class="w-full rounded-lg bg-white/10 px-3 py-2 text-white placeholder-white/40 outline-none focus:ring-2 focus:ring-white/40"
            />
          </Show>

          <Show when={error()}>
            {(message) => <p class="mt-3 text-sm text-red-400">{message()}</p>}
          </Show>

          <div class="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={props.onClose}
              class="rounded-lg px-4 py-2 text-sm text-white/70 hover:text-white"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              class="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90"
            >
              {t("story.done")}
            </button>
          </div>
        </form>
      </div>
    </Show>
  );
}

export default StoryOverlayEditorModal;
