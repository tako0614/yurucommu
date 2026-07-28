import { atom } from "jotai/vanilla";
import { atomWithStorage } from "jotai/vanilla/utils";
import { normalizeMuteWord } from "../lib/mute-words.ts";

// Persisted, client-only mute-word list (Mastodon-parity content filter). Lives
// in localStorage under this key and is never sent to the server; a post whose
// text matches a word is collapsed behind a reveal in the feed (FilteredPost).
export const MUTE_WORDS_STORAGE_KEY = "muteWords";

// Bounds so a runaway paste can't bloat localStorage or the per-post match loop
// that runs while scrolling the feed.
const MAX_MUTE_WORDS = 100;
const MAX_MUTE_WORD_LENGTH = 100;

export const muteWordsAtom = atomWithStorage<string[]>(
  MUTE_WORDS_STORAGE_KEY,
  [],
);

// Add a mute word: trimmed, length-capped, deduped case-insensitively, newest
// first. No-op on empty input, a duplicate, or once the count cap is reached.
export const addMuteWordAtom = atom(null, (get, set, raw: string) => {
  const normalized = normalizeMuteWord(raw);
  if (!normalized) return;
  const word = normalized.slice(0, MAX_MUTE_WORD_LENGTH);
  const current = get(muteWordsAtom);
  if (current.length >= MAX_MUTE_WORDS) return;
  const lower = word.toLowerCase();
  if (current.some((w) => w.toLowerCase() === lower)) return;
  set(muteWordsAtom, [word, ...current]);
});

export const removeMuteWordAtom = atom(null, (get, set, word: string) => {
  set(
    muteWordsAtom,
    get(muteWordsAtom).filter((w) => w !== word),
  );
});
