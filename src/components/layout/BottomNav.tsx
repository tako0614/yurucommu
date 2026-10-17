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
import { composeAsideOnScreen, conversationOnScreen } from "./routeChrome.ts";

// X-like mobile bar: keep only core destinations in the bottom rail. Compose is
// a floating action button; Profile stays in the avatar menu.
export function BottomNav() {
  const { t } = useI18n();
  const location = useLocation();
  const unreadCount = useAtomValue(notificationUnreadAtom);
  const dmUnread = useAtomValue(dmUnreadCountAtom);
  const openComposer = useSetAtom(showPostModalAtom);

  // The compose button floats over the last row of every scrolling page (a
  // post's その他, a community's last member). Hide it once the reader has
  // scrolled 24px down, keep it hidden at the end of the page (so an iOS
  // bounce does not bring it back over the last row), and show it again after
  // 16px up, at the top, on a new page, or when the page that hid it is gone.
  // Distances add up across events, so a slow scroll counts too.
  //
  // Scroll events do not bubble, so one capture-phase listener follows the
  // page's own scrollers: only inside <main>, never a text field, and only
  // ones that scroll vertically. An element's first event is just its
  // starting point (a restored scroll position is not a scroll down).
  const HIDE_AFTER_PX = 24;
  const SHOW_AFTER_PX = 16;
  const [fabHidden, setFabHidden] = createSignal(false);
  let fabRef: HTMLButtonElement | undefined;
  let hiddenBy: Element | null = null;
  let travel = 0; // px since the last change of direction; + is down
  const lastScrollTop = new WeakMap<Element, number>();
  const showFab = () => {
    hiddenBy = null;
    travel = 0;
    setFabHidden(false);
  };
  const hideFab = (el: Element) => {
    // Keep it for a keyboard user who is on it; focus returned to it after a
    // tap (closing the composer) is not keyboard focus and must not pin it.
    if (fabRef?.matches(":focus-visible")) return;
    hiddenBy = el;
    setFabHidden(true);
  };
  const handleScroll = (e: Event) => {
    const el = e.target;
    if (!(el instanceof Element) || !el.closest("main")) return;
    if (el.matches("input, textarea") || el.scrollHeight <= el.clientHeight)
      return;
    const top = el.scrollTop;
    const previous = lastScrollTop.get(el);
    lastScrollTop.set(el, top);
    if (previous === undefined) return;
    if (top <= 8) return showFab();
    if (top >= el.scrollHeight - el.clientHeight - 2) return hideFab(el);
    const delta = top - previous;
    if (delta === 0) return;
    travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;
    if (travel >= HIDE_AFTER_PX) hideFab(el);
    else if (travel <= -SHOW_AFTER_PX) showFab();
  };
  // A click can swap the page under the button without a scroll (a community
  // tab, 戻る): show it once the scroller that hid it is gone, back at the
  // top, or no longer scrolls.
  const recheckFab = () => {
    const el = hiddenBy;
    if (!el) return;
    if (
      !el.isConnected ||
      el.scrollTop <= 8 ||
      el.scrollHeight <= el.clientHeight
    )
      showFab();
  };
  const handleClick = () => setTimeout(recheckFab, 0);
  onMount(() => {
    document.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    });
    document.addEventListener("click", handleClick, { capture: true });
  });
  onCleanup(() => {
    document.removeEventListener("scroll", handleScroll, { capture: true });
    document.removeEventListener("click", handleClick, { capture: true });
  });
  createEffect(
    on(
      () => location.pathname,
      () => showFab(),
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

  // Not in messages (the composer is the conversation's own) or settings:
  // nobody posts from a form, and the button sat over its last action, such
  // as 「フォロワーを別のアカウントへ移行」 on a 320px phone where the page
  // scrolls too little for the button to step aside.
  const fabRoute = () => {
    const path = location.pathname;
    return !["/dm", "/settings"].some(
      (base) => path === base || path.startsWith(`${base}/`),
    );
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
      <Show when={fabRoute() && !composeAsideOnScreen()}>
        <button
          ref={fabRef}
          type="button"
          onClick={() => openComposer(true)}
          // Focus coming back after the composer closes shows it again.
          onFocus={showFab}
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
                // With unread items the link's own name carries the count:
                // aria-label="メッセージ" overrode the badge, so a screen
                // reader heard no count at all.
                <A
                  href={item.route!}
                  aria-label={
                    item.badge && badgeCount(item) > 0
                      ? badgeLabel(item)
                      : t(item.labelKey)
                  }
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
