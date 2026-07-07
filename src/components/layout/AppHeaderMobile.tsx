import { Show } from "solid-js";
import { useLocation } from "@solidjs/router";
import { useAtomValue, useSetAtom } from "solid-jotai";
import { useI18n } from "../../lib/i18n.tsx";
import { actorAtom } from "../../atoms/auth.ts";
import { appMenuOpenAtom } from "../../atoms/shell.ts";
import { UserAvatar } from "../UserAvatar.tsx";

// Minimal app-shell mobile header, mounted once in AppLayout so the AppMenu
// trigger (avatar) is reachable from secondary mobile routes. Home owns its
// own scope header, and primary navigation lives in the bottom bar.

export function AppHeaderMobile() {
  const { t } = useI18n();
  const actor = useAtomValue(actorAtom);
  const openMenu = useSetAtom(appMenuOpenAtom);
  const location = useLocation();

  // On the home route the ScopeHeader owns the menu trigger; suppress this bar
  // there so the two never stack.
  const onHome = () => location.pathname === "/";

  return (
    <Show when={onHome() ? null : actor()}>
      {(current) => (
        <header class="md:hidden sticky top-0 z-30 flex min-h-14 items-center px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-800">
          {/* Avatar / menu trigger — opens the global AppMenu drawer. */}
          <button
            type="button"
            onClick={() => openMenu(true)}
            aria-label={t("menu.open")}
            aria-haspopup="dialog"
            class="rounded-full ring-1 ring-neutral-700 transition-colors hover:ring-neutral-500"
          >
            <UserAvatar
              avatarUrl={current().icon_url}
              name={current().name || current().preferred_username}
              size={32}
            />
          </button>
        </header>
      )}
    </Show>
  );
}
