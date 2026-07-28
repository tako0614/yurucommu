import { createMemo, createSignal, Show, type JSX } from "solid-js";
import { useAtomValue } from "solid-jotai";
import type { Post } from "../../types/index.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { muteWordsAtom } from "../../atoms/mute-words.ts";
import { matchMuteWord } from "../../lib/mute-words.ts";

interface FilteredPostProps {
  post: Post;
  children: JSX.Element;
}

// Collapses a post whose visible text matches a client-side mute word behind a
// reveal, mirroring the content-warning pattern used elsewhere. Fully
// client-side: the mute list lives in localStorage and nothing is sent to the
// server. When no word matches — the overwhelmingly common case — the child
// post card renders untouched (and, because `children` is Solid's lazy prop, it
// is not even created while a post stays filtered).
export function FilteredPost(props: FilteredPostProps) {
  const { t } = useI18n();
  const muteWords = useAtomValue(muteWordsAtom);
  const [revealed, setRevealed] = createSignal(false);
  const matched = createMemo(() => matchMuteWord(props.post, muteWords()));
  const filtered = () => matched() !== null && !revealed();

  return (
    <Show when={filtered()} fallback={props.children}>
      <div class="border-b border-neutral-900 px-4 py-3">
        <div class="flex items-center justify-between gap-3 rounded-xl bg-neutral-900/60 px-4 py-3">
          <span class="min-w-0 truncate text-sm text-neutral-400">
            {t("filters.hiddenPost").replace("{word}", matched() ?? "")}
          </span>
          <button
            type="button"
            onClick={() => setRevealed(true)}
            class="shrink-0 rounded-full bg-neutral-800 px-3 py-1 text-sm font-bold text-neutral-200 transition-colors hover:bg-neutral-700"
          >
            {t("filters.showAnyway")}
          </button>
        </div>
      </div>
    </Show>
  );
}
