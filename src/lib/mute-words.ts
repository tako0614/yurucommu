// Client-side keyword ("mute word") content filter — a Mastodon-parity
// "filters" feature kept entirely in the browser. The mute list lives in
// localStorage (see atoms/mute-words.ts); nothing is sent to the server. A post
// whose visible text matches a mute word is collapsed behind a reveal in the
// feed (see components/timeline/FilteredPost.tsx).
//
// This module is a PURE string transform (no DOM, no storage) so it behaves
// identically in the browser and under `bun test`.

// Reduce remote ActivityPub HTML to visible text so a mute word matches what
// the reader actually sees, not tag/attribute names — e.g. muting "art" must
// not trip on `href="…/chart…"`. Local posts are plain text and pass through
// unchanged. A handful of common entities are decoded so a muted word still
// matches text that arrived encoded.
function toPlainText(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

// The subset of a post the filter reads. Kept structural (not the full `Post`
// type) so the matcher is trivially unit-testable and reusable.
export interface MuteMatchable {
  content?: string | null;
  // The content warning / summary is matched too: a CW is reader-visible text
  // and a mute word that only appeared there should still hide the post.
  summary?: string | null;
}

// Lowercased searchable text of a post (body + content warning). Attachment alt
// text is intentionally excluded — the filter matches the visible reading text.
export function muteHaystack(post: MuteMatchable): string {
  const parts: string[] = [];
  if (post.content) parts.push(toPlainText(post.content));
  if (post.summary) parts.push(post.summary);
  return parts.join(" \n ").toLowerCase();
}

// Normalize a raw mute-word entry for storage: trim, collapse to null when
// empty. Case is preserved for display; matching lowercases both sides.
export function normalizeMuteWord(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// The first mute word (in list order) that occurs in the post's text, or null
// when nothing matches. Case-insensitive SUBSTRING match — chosen over
// word-boundary matching because the primary audience writes Japanese, which
// has no whitespace word breaks, so a boundary rule would silently never fire.
export function matchMuteWord(
  post: MuteMatchable,
  words: readonly string[],
): string | null {
  if (words.length === 0) return null;
  const hay = muteHaystack(post);
  if (!hay) return null;
  for (const word of words) {
    const needle = word.trim().toLowerCase();
    if (needle && hay.includes(needle)) return word;
  }
  return null;
}
