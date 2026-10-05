import { fetchUnreadCount } from "../lib/api.ts";
import { createUnreadCountAtoms } from "./unread-count.ts";

// Shared, app-wide unread notification count. A single poller (mounted once in
// the app layout) writes this; nav surfaces (sidebar bell, mobile header) read
// it, and the notifications page re-fetches it after marking visible items read.
const unread = createUnreadCountAtoms(
  "/api/notifications/unread/count",
  fetchUnreadCount,
  "Failed to fetch unread notification count:",
);
export const notificationUnreadAtom = unread.count;
export const refreshNotificationUnreadAtom = unread.refresh;
