import { fetchDMUnreadCount } from "../lib/api.ts";
import { createUnreadCountAtoms } from "./unread-count.ts";

// Shared, app-wide unread DM count. A single poller (mounted once in the app
// layout / nav) writes this; nav surfaces (Messages destination badge) read it.
// The total sums unread across both one-to-one DM contacts and joined community
// group chats — the same total GET /dm/contacts would yield, but read from the
// lightweight GET /dm/unread/count endpoint (a backend parity test pins the two
// together) so the 30s badge poll does not refetch the whole contacts list with
// actor enrichment + last-message previews on every tick.
const unread = createUnreadCountAtoms(
  "/api/dm/unread/count",
  async () => (await fetchDMUnreadCount()).total,
  "Failed to fetch unread DM count:",
);
export const dmUnreadCountAtom = unread.count;
export const refreshDmUnreadAtom = unread.refresh;
