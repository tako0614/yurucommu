const ADDRESS = /^@?([^@\s/]+)@([^@\s/]+)$/;
// Actor URLs that name the account in their last path segment: Yurucommu's
// /ap/users/<name> and Mastodon/Pleroma's /users/<name>.
const ACTOR_PATH = /\/users\/([^/@\s]+)\/?$/;
// Profile links: /@alice (local to the host) or /@alice@other.host (a remote
// account seen through that host).
const PROFILE_PATH = /^\/@([^/@\s]+)(?:@([^/@\s]+))?\/?$/;

function addressFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Yurucommu's own share/QR link wraps the actor id: /profile/<encoded ap_id>.
  const shared = url.pathname.match(/^\/profile\/([^/]+)\/?$/);
  if (shared) {
    try {
      return addressFromUrl(decodeURIComponent(shared[1]));
    } catch {
      return null;
    }
  }
  const profile = url.pathname.match(PROFILE_PATH);
  if (profile) return `@${profile[1]}@${profile[2] ?? url.host}`;
  const actor = url.pathname.match(ACTOR_PATH);
  if (actor) return `@${actor[1]}@${url.host}`;
  return null;
}

/**
 * Turn what the owner typed into the home "find someone to follow" box into a
 * search query the search page understands. People paste addresses in several
 * shapes, so normalize the common ones to `@user@host`:
 *
 * - `alice@mastodon.social` (no leading @)
 * - `＠ａｌｉｃｅ＠ｍａｓｔｏｄｏｎ．ｓｏｃｉａｌ` (full-width, from a Japanese IME)
 * - profile and actor links: `https://mastodon.social/@alice`,
 *   `https://mastodon.social/@bob@misskey.io`, `https://host/users/bob`, and
 *   Yurucommu's own `/profile/<actor id>` share link
 *
 * Anything else (a display name, a post link) is passed through trimmed.
 */
export function toFollowSearchQuery(input: string): string {
  const query = input.normalize("NFKC").trim();
  const address = query.match(ADDRESS);
  if (address) return `@${address[1]}@${address[2]}`;
  return addressFromUrl(query) ?? query;
}
