import { Show } from "solid-js";
import { useLocation } from "@solidjs/router";
import { useAtomValue, useSetAtom } from "solid-jotai";
import { useI18n } from "../../lib/i18n.tsx";
import { actorAtom } from "../../atoms/auth.ts";
import { appMenuOpenAtom } from "../../atoms/shell.ts";
import { UserAvatar } from "../UserAvatar.tsx";
import {
  backHeaderOnScreen,
  conversationOnScreen,
  hasOwnBackHeader,
} from "./routeChrome.ts";

// Minimal app-shell mobile header, mounted once in AppLayout so the AppMenu
// trigger (avatar) is reachable from secondary mobile routes. Home owns its
// own scope header, screens with a back button own theirs (routeChrome.ts),
// and primary navigation lives in the bottom bar.

export function AppHeaderMobile() {
  const { t } = useI18n();
  const actor = useAtomValue(actorAtom);
  const openMenu = useSetAtom(appMenuOpenAtom);
  const location = useLocation();

  // On the home route the ScopeHeader owns the menu trigger, and a screen with
  // its own back header needs back top-left, not the menu; suppress this bar
  // there so the two never stack.
  const hidden = () =>
    location.pathname === "/" ||
    hasOwnBackHeader(location.pathname) ||
    backHeaderOnScreen() ||
    conversationOnScreen();

  return (
    <Show when={hidden() ? null : actor()}>
      {(current) => (
        <header class="md:hidden sticky top-0 z-30 flex min-h-14 items-center px-4 py-3 bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-800">
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
