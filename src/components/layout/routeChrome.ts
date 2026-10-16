/**
 * Which shell chrome a phone screen needs, from its route alone.
 *
 * Screens with their own top bar and back button (a post, someone's profile,
 * a community, the friends list, an open conversation) do not get the shell's
 * avatar bar: stacked above their header it pushed back to a second row and
 * put the menu where back belongs.
 */
export function hasOwnBackHeader(pathname: string, search: string): boolean {
  return (
    pathname.startsWith("/post/") ||
    /^\/profile\/.+/.test(pathname) ||
    /^\/groups\/[^/]+\/?$/.test(pathname) ||
    pathname === "/friends" ||
    pathname.startsWith("/friends/") ||
    isConversationOpen(pathname, search)
  );
}

/**
 * An open DM or community conversation (`/dm?c=<id>`, or the legacy
 * `/dm/<id>`). Its composer owns the bottom of the screen, so the bottom nav
 * steps aside there, as in other messaging apps.
 */
export function isConversationOpen(pathname: string, search: string): boolean {
  if (pathname.startsWith("/dm/")) return true;
  return pathname === "/dm" && new URLSearchParams(search).has("c");
}
