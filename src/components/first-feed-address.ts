/**
 * Turn what the owner typed into the home "find someone to follow" box into a
 * search query the search page understands. People paste addresses in several
 * shapes, so normalize the common ones to `@user@host`:
 *
 * - `alice@mastodon.social` (no leading @)
 * - `＠alice＠mastodon.social` (full-width ＠ from a Japanese IME)
 * - `https://mastodon.social/@alice` (a copied profile link)
 *
 * Anything else (a display name, a local username) is passed through trimmed.
 */
export function toFollowSearchQuery(input: string): string {
  const query = input.trim().replaceAll("＠", "@");
  if (/^@?[^@\s/]+@[^@\s/]+$/.test(query)) {
    return query.startsWith("@") ? query : `@${query}`;
  }
  const profileLink = query.match(/^https?:\/\/([^/\s]+)\/@([^/@\s]+)\/?$/);
  if (profileLink) return `@${profileLink[2]}@${profileLink[1]}`;
  return query;
}
