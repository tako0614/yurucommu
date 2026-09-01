import { describe, expect, test } from "bun:test";
import type { Translate } from "../../atoms/i18n.ts";
import { NAV_ITEMS, projectNavItem } from "./navItems.ts";

const translate: Translate = (key) => {
  if (key === "nav.messages") return "Messages";
  if (key === "nav.notifications") return "Notifications";
  if (key === "nav.unreadBadge") return "{label} ({count} unread)";
  return key;
};

function project(id: (typeof NAV_ITEMS)[number]["id"], pathname: string) {
  const item = NAV_ITEMS.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`missing nav item ${id}`);
  return projectNavItem(item, {
    pathname,
    notificationUnreadCount: 7,
    directMessageUnreadCount: 3,
    translate,
  });
}

describe("projectNavItem", () => {
  test("keeps root and own-profile routes exact", () => {
    expect(project("home", "/").active).toBe(true);
    expect(project("home", "/search").active).toBe(false);
    expect(project("profile", "/profile").active).toBe(true);
    expect(project("profile", "/profile/remote-actor").active).toBe(false);
  });

  test("matches nested destination routes by prefix", () => {
    expect(project("messages", "/dm/conversation-1").active).toBe(true);
    expect(project("activity", "/notifications/archive").active).toBe(true);
    expect(project("search", "/profile").active).toBe(false);
    expect(project("create", "/").active).toBe(false);
  });

  test("selects the badge count and accessible label from the nav item", () => {
    expect(project("messages", "/").badge).toEqual({
      count: 3,
      label: "Messages (3 unread)",
    });
    expect(project("activity", "/").badge).toEqual({
      count: 7,
      label: "Notifications (7 unread)",
    });
    expect(project("home", "/").badge).toBeNull();
  });
});
