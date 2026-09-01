import { A, useLocation } from "@solidjs/router";
import { For, Show } from "solid-js";
import { useAtomValue, useSetAtom } from "solid-jotai";
import { useI18n } from "../../lib/i18n.tsx";
import { notificationUnreadAtom } from "../../atoms/notifications.ts";
import { dmUnreadCountAtom } from "../../atoms/dm-unread.ts";
import { showPostModalAtom } from "../../atoms/timeline.ts";
import { NavBadge } from "./NavBadge.tsx";
import { MOBILE_NAV_ITEMS, projectNavItem, type NavItem } from "./navItems.ts";
import { CreateNavIcon } from "./NavIcons.tsx";

// X-like mobile bar: keep only core destinations in the bottom rail. Compose is
// a floating action button; Profile stays in the avatar menu.
export function BottomNav() {
  const { t } = useI18n();
  const location = useLocation();
  const unreadCount = useAtomValue(notificationUnreadAtom);
  const dmUnread = useAtomValue(dmUnreadCountAtom);
  const openComposer = useSetAtom(showPostModalAtom);

  const project = (item: NavItem) =>
    projectNavItem(item, {
      pathname: location.pathname,
      notificationUnreadCount:
        item.badge && item.id !== "messages" ? unreadCount() : 0,
      directMessageUnreadCount:
        item.badge && item.id === "messages" ? dmUnread() : 0,
      translate: t,
    });

  const itemClass = (active: boolean) =>
    `flex flex-col items-center justify-center p-2 ${
      active ? "text-white" : "text-neutral-500"
    }`;

  return (
    <>
      <button
        type="button"
        onClick={() => openComposer(true)}
        aria-label={t("posts.post")}
        class="md:hidden fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 grid h-14 w-14 place-items-center rounded-full bg-accent text-white shadow-2xl shadow-black/40 transition-transform active:scale-95"
      >
        <CreateNavIcon active={false} />
      </button>
      <nav class="md:hidden fixed bottom-0 left-0 right-0 h-[calc(3.5rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] bg-neutral-900 border-t border-neutral-900 flex items-center justify-around z-50">
        <For each={MOBILE_NAV_ITEMS}>
          {(item) => {
            const Icon = item.icon;
            const projection = () => project(item);
            const visibleBadge = () => {
              const badge = projection().badge;
              return badge && badge.count > 0 ? badge : undefined;
            };
            return (
              <A
                href={item.route!}
                aria-label={t(item.labelKey)}
                aria-current={projection().active ? "page" : undefined}
                class={itemClass(projection().active)}
              >
                <span class="relative inline-flex">
                  <Icon active={projection().active} />
                  <Show when={visibleBadge()}>
                    {(badge) => (
                      <span class="absolute -top-1 -right-2">
                        <NavBadge count={badge().count} label={badge().label} />
                      </span>
                    )}
                  </Show>
                </span>
              </A>
            );
          }}
        </For>
      </nav>
    </>
  );
}
