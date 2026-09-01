import type { Component } from "solid-js";
import type { Translate, TranslationKey } from "../../atoms/i18n.ts";
import {
  CreateNavIcon,
  HomeNavIcon,
  MessagesNavIcon,
  ProfileNavIcon,
  ActivityNavIcon,
  SearchNavIcon,
} from "./NavIcons.tsx";

// Primary navigation model. Desktop keeps the fuller app map, while mobile uses
// a reduced X-like bottom bar and leaves compose/profile to the floating action
// button and account menu.
export interface NavItem {
  id: "home" | "search" | "create" | "messages" | "activity" | "profile";
  // Icons receive an `active` flag so projections can render a filled vs.
  // outlined glyph.
  icon: Component<{ active: boolean }>;
  labelKey: TranslationKey;
  // Exactly one of `route` / `onAction` is set.
  route?: string;
  // Center affordance: handled by the host (opens the post composer for now).
  onAction?: "create";
  // Surfaces an unread badge. The count source depends on `id`: the activity
  // item uses the notification unread count, the messages item uses the DM
  // unread count.
  badge?: boolean;
}

export interface NavItemProjection {
  readonly active: boolean;
  readonly badge: {
    readonly count: number;
    readonly label: string;
  } | null;
}

export function projectNavItem(
  item: NavItem,
  input: {
    readonly pathname: string;
    readonly notificationUnreadCount: number;
    readonly directMessageUnreadCount: number;
    readonly translate: Translate;
  },
): NavItemProjection {
  const route = item.route;
  const active =
    route === undefined
      ? false
      : route === "/" || route === "/profile"
        ? input.pathname === route
        : input.pathname.startsWith(route);
  if (!item.badge) return { active, badge: null };

  const count =
    item.id === "messages"
      ? input.directMessageUnreadCount
      : input.notificationUnreadCount;
  const name =
    item.id === "messages"
      ? input.translate("nav.messages")
      : input.translate("nav.notifications");
  return {
    active,
    badge: {
      count,
      label: input
        .translate("nav.unreadBadge")
        .replace("{label}", name)
        .replace("{count}", String(count)),
    },
  };
}

export const NAV_ITEMS: NavItem[] = [
  { id: "home", icon: HomeNavIcon, labelKey: "nav.home", route: "/" },
  {
    id: "search",
    icon: SearchNavIcon,
    labelKey: "nav.search",
    route: "/search",
  },
  {
    id: "create",
    icon: CreateNavIcon,
    labelKey: "posts.post",
    onAction: "create",
  },
  {
    id: "messages",
    icon: MessagesNavIcon,
    labelKey: "nav.messages",
    route: "/dm",
    badge: true,
  },
  {
    id: "activity",
    icon: ActivityNavIcon,
    labelKey: "nav.notifications",
    route: "/notifications",
    badge: true,
  },
  {
    id: "profile",
    icon: ProfileNavIcon,
    labelKey: "nav.profile",
    route: "/profile",
  },
];

export const MOBILE_NAV_ITEMS: NavItem[] = [
  { id: "home", icon: HomeNavIcon, labelKey: "nav.home", route: "/" },
  {
    id: "search",
    icon: SearchNavIcon,
    labelKey: "nav.search",
    route: "/search",
  },
  {
    id: "activity",
    icon: ActivityNavIcon,
    labelKey: "nav.notifications",
    route: "/notifications",
    badge: true,
  },
  {
    id: "messages",
    icon: MessagesNavIcon,
    labelKey: "nav.messages",
    route: "/dm",
    badge: true,
  },
];
