import { createSignal, onCleanup, onMount } from "solid-js";

/**
 * Which shell chrome a phone screen needs.
 *
 * Screens with their own top bar and back button (a post, someone's profile,
 * a community, the friends list, an open conversation) do not get the shell's
 * avatar bar: stacked above their header it pushed back to a second row and
 * put the menu where back belongs.
 */
export function hasOwnBackHeader(pathname: string): boolean {
  return (
    pathname.startsWith("/post/") ||
    /^\/profile\/.+/.test(pathname) ||
    /^\/groups\/[^/]+\/?$/.test(pathname) ||
    // The router also matches these with one trailing slash.
    /^\/friends(\/list)?\/?$/.test(pathname)
  );
}

// How many open conversations are mounted (DMChatPanel; at most one).
const [conversations, setConversations] = createSignal(0);

/**
 * True while a DM or community conversation is on screen. Its composer owns
 * the bottom of the screen, so the bottom nav steps aside, as in other
 * messaging apps. Taken from what is drawn rather than the URL: `/dm?c=` also
 * shows the contact list while the contact loads or when it is not found.
 */
export const conversationOnScreen = () => conversations() > 0;

/** Call from the conversation panel. */
export function markConversationOnScreen(): void {
  onMount(() => setConversations((n) => n + 1));
  onCleanup(() => setConversations((n) => Math.max(0, n - 1)));
}

// How many back-button headers that the URL cannot reveal are mounted: the
// settings sub-screens all stay on /settings, and /users/<name> is another
// user's profile or the owner's own.
const [backHeaders, setBackHeaders] = createSignal(0);

/** True while such a header is on screen; the avatar bar steps aside. */
export const backHeaderOnScreen = () => backHeaders() > 0;

/** Call from a back-button header whose URL alone does not say it has one. */
export function markBackHeaderOnScreen(): void {
  onMount(() => setBackHeaders((n) => n + 1));
  onCleanup(() => setBackHeaders((n) => Math.max(0, n - 1)));
}
