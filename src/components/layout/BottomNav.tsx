import { A, useLocation } from "@solidjs/router";
import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useAtomValue, useSetAtom } from "solid-jotai";
import { useI18n } from "../../lib/i18n.tsx";
import { notificationUnreadAtom } from "../../atoms/notifications.ts";
import { dmUnreadCountAtom } from "../../atoms/dm-unread.ts";
import { showPostModalAtom } from "../../atoms/timeline.ts";
import { NavBadge } from "./NavBadge.tsx";
import { MOBILE_NAV_ITEMS, type NavItem } from "./navItems.ts";
import { CreateNavIcon } from "./NavIcons.tsx";
import { conversationOnScreen } from "./routeChrome.ts";

// X-like mobile bar: keep only core destinations in the bottom rail. Compose is
// a floating action button; Profile stays in the avatar menu.
export function BottomNav() {
  const { t } = useI18n();
  const location = useLocation();
  const unreadCount = useAtomValue(notificationUnreadAtom);
  const dmUnread = useAtomValue(dmUnreadCountAtom);
  const openComposer = useSetAtom(showPostModalAtom);

  // The compose button floats over the last row of every scrolling page (a
  // post's その他, the settings buttons). Hide it while the reader scrolls
  // down and bring it back on the way up, at the top, and on a new page, as
  // feed apps do. Scroll events do not bubble, so listen in the capture phase
  // for whichever container scrolls.
  const [fabHidden, setFabHidden] = createSignal(false);
  const lastScrollTop = new WeakMap<EventTarget, number>();
  const handleScroll = (e: Event) => {
    const el =
      e.target instanceof Element ? e.target : document.scrollingElement;
    // Horizontal scrollers (the story bar) say nothing about reading position.
    if (!el || el.scrollHeight <= el.clientHeight) return;
    const top = el.scrollTop;
    // Scrollers start at the top, so the first event measures from 0.
    const previous = lastScrollTop.get(el) ?? 0;
    lastScrollTop.set(el, top);
    // At the end it stays hidden, so an iOS bounce back from the bottom does
    // not bring it back over the last row.
    const atEnd = top >= el.scrollHeight - el.clientHeight - 2;
    if (top <= 8) setFabHidden(false);
    else if (atEnd || top - previous > 4) setFabHidden(true);
    else if (previous - top > 4) setFabHidden(false);
  };
  onMount(() =>
    document.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    }),
  );
  onCleanup(() =>
    document.removeEventListener("scroll", handleScroll, { capture: true }),
  );
  createEffect(
    on(
      () => location.pathname,
      () => setFabHidden(false),
    ),
  );

  // The badge count source depends on which nav item it is.
  const badgeCount = (item: NavItem) =>
    item.id === "messages" ? dmUnread() : unreadCount();
  // Compose the unread COUNT into the badge's accessible name — NavBadge is a
  // role="img" leaf whose visible digit is not exposed, so the bare nav name
  // would announce "Messages" instead of "Messages (3 unread)".
  const badgeLabel = (item: NavItem) => {
    const name =
      item.id === "messages" ? t("nav.messages") : t("nav.notifications");
    return t("nav.unreadBadge")
      .replace("{label}", name)
      .replace("{count}", String(badgeCount(item)));
  };

  const isActive = (route: string) => {
    if (route === "/") return location.pathname === "/";
    // "/profile" is the OWN profile; foreign profiles live at
    // "/profile/:actorId" and must not light up the Profile tab.
    if (route === "/profile") return location.pathname === "/profile";
    return location.pathname.startsWith(route);
  };
  const active = (item: NavItem) =>
    item.route !== undefined && isActive(item.route);

  const itemClass = (item: NavItem) =>
    `flex flex-col items-center justify-center p-2 ${
      active(item) ? "text-white" : "text-neutral-500"
    }`;

  return (
    <>
      <Show
        when={
          location.pathname !== "/dm" && !location.pathname.startsWith("/dm/")
        }
      >
        <button
          type="button"
          onClick={() => openComposer(true)}
          aria-label={t("posts.post")}
          aria-hidden={fabHidden() ? "true" : undefined}
          tabindex={fabHidden() ? -1 : undefined}
          class={`md:hidden fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 grid h-14 w-14 place-items-center rounded-full bg-accent text-white shadow-2xl shadow-black/40 transition-[translate,scale,opacity] duration-200 active:scale-95 motion-reduce:transition-none ${
            fabHidden()
              ? "pointer-events-none translate-y-[calc(100%+5rem)] opacity-0"
              : ""
          }`}
        >
          <CreateNavIcon active={false} />
        </button>
      </Show>
      <Show when={!conversationOnScreen()}>
        <nav class="md:hidden fixed bottom-0 left-0 right-0 h-[calc(3.5rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] bg-neutral-900 border-t border-neutral-900 flex items-center justify-around z-50">
          <For each={MOBILE_NAV_ITEMS}>
            {(item) => {
              const Icon = item.icon;
              const badge = () => (
                <Show when={item.badge && badgeCount(item) > 0}>
                  <span class="absolute -top-1 -right-2">
                    <NavBadge
                      count={badgeCount(item)}
                      label={badgeLabel(item)}
                    />
                  </span>
                </Show>
              );
              return (
                <A
                  href={item.route!}
                  aria-label={t(item.labelKey)}
                  aria-current={active(item) ? "page" : undefined}
                  class={itemClass(item)}
                >
                  <span class="relative inline-flex">
                    <Icon active={active(item)} />
                    {badge()}
                  </span>
                </A>
              );
            }}
          </For>
        </nav>
      </Show>
    </>
  );
}
