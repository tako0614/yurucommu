import { createSignal, For, Show } from "solid-js";
import { useAtomValue, useSetAtom } from "solid-jotai";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";
import {
  addMuteWordAtom,
  muteWordsAtom,
  removeMuteWordAtom,
} from "../../atoms/mute-words.ts";
import type { Translate } from "../../lib/i18n.tsx";

interface SettingsFiltersSectionProps {
  onBack: () => void;
  t: Translate;
}

// Client-side keyword filter editor (Mastodon-parity "filters"). The list is
// persisted in localStorage via muteWordsAtom and applied at render in the feed
// (FilteredPost) — there is no server round-trip, so this section has no
// loading/error states, only an empty state.
export function SettingsFiltersSection(props: SettingsFiltersSectionProps) {
  const words = useAtomValue(muteWordsAtom);
  const addWord = useSetAtom(addMuteWordAtom);
  const removeWord = useSetAtom(removeMuteWordAtom);
  const [input, setInput] = createSignal("");

  const handleAdd = () => {
    const value = input().trim();
    if (!value) return;
    addWord(value);
    setInput("");
  };

  const inputClass =
    "flex-1 min-w-0 bg-neutral-800 rounded-lg px-3 py-2 text-white placeholder-neutral-500 outline-none focus:ring-2 focus:ring-accent";

  return (
    <div class="flex flex-col h-full">
      <SettingsSectionHeader
        title={props.t("settings.filters")}
        onBack={props.onBack}
      />
      <div class="flex-1 overflow-y-auto">
        <p class="px-4 pt-4 text-sm text-neutral-500">
          {props.t("filters.description")}
        </p>
        <div class="px-4 py-4 flex gap-2">
          <input
            type="text"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder={props.t("filters.addPlaceholder")}
            aria-label={props.t("filters.addLabel")}
            class={inputClass}
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={input().trim().length === 0}
            class="px-4 py-2 bg-accent rounded-lg font-bold disabled:opacity-50"
          >
            {props.t("filters.add")}
          </button>
        </div>

        <Show
          when={words().length > 0}
          fallback={
            <div class="px-4 py-8 text-center text-neutral-500">
              {props.t("filters.empty")}
            </div>
          }
        >
          <ul class="border-t border-neutral-900">
            <For each={words()}>
              {(word) => (
                <li class="flex items-center justify-between px-4 py-3 border-b border-neutral-900">
                  <span class="truncate text-white">{word}</span>
                  <button
                    type="button"
                    onClick={() => removeWord(word)}
                    aria-label={`${props.t("filters.remove")}: ${word}`}
                    class="text-sm text-accent hover:underline ml-3 shrink-0"
                  >
                    {props.t("filters.remove")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
