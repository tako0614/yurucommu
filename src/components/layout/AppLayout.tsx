import { onMount, type JSX } from "solid-js";
import { useSetAtom } from "solid-jotai";
import { useI18n } from "../../lib/i18n.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { BottomNav } from "./BottomNav.tsx";
import { RightSidebar } from "./RightSidebar.tsx";
import { AppHeaderMobile } from "./AppHeaderMobile.tsx";
import { AppMenu } from "./AppMenu.tsx";
import { conversationOnScreen, rememberHistoryStart } from "./routeChrome.ts";
import { GlobalPostComposer } from "./GlobalPostComposer.tsx";
import { ToastLayer } from "../ToastLayer.tsx";
import { useNotificationPolling } from "../../hooks/useNotificationPolling.ts";
import { useDmUnreadPolling } from "../../hooks/useDmUnreadPolling.ts";
import { hydrateScopeAtom } from "../../atoms/scope.ts";

export function AppLayout(props: { children?: JSX.Element }) {
  const { t } = useI18n();
  rememberHistoryStart();
  // Single mount point for unread polling (both pause when the tab is hidden).
  useNotificationPolling();
  useDmUnreadPolling();

  // Hydrate the inhabited-scope rail once per authenticated shell: reconcile the
  // stored scope against live membership and populate the ScopeBar / switcher
  // source. Runs here (not per-page) so the rail is ready on first paint.
  const hydrateScope = useSetAtom(hydrateScopeAtom);
  onMount(() => {
    void hydrateScope();
  });

  // The phone's bottom nav steps aside in an open conversation (BottomNav), so
  // only keep room for it where it is shown. The top inset lives here, not in
  // a header, because several screens draw their own top bar.
  const mainPadding = () =>
    conversationOnScreen()
      ? "pb-[env(safe-area-inset-bottom)]"
      : "pb-[calc(3.5rem+env(safe-area-inset-bottom))]";

  return (
    <div class="flex justify-center h-screen h-[100dvh] bg-neutral-900 text-white">
      <a
        href="#main-content"
        class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-white"
      >
        {t("nav.skipToContent")}
      </a>
      <Sidebar />
      <main
        id="main-content"
        tabindex="-1"
        class={`flex-1 flex flex-col min-h-screen pt-[env(safe-area-inset-top)] ${mainPadding()} md:pt-0 md:pb-0 overflow-hidden border-x border-neutral-800 max-w-2xl focus:outline-none`}
      >
        {/* Mobile-only app-shell header: the AppMenu trigger, on screens
            without a header of their own (see routeChrome.ts). */}
        <AppHeaderMobile />
        {/* The page fills what the avatar bar leaves. Pages size themselves
            with h-full; as a direct child of <main> that was main's full
            height, so on screens with the bar the page ran 56px under the
            bottom nav and its last row could not be reached. */}
        <div class="flex min-h-0 flex-1 flex-col">{props.children}</div>
      </main>
      <div class="hidden lg:block w-80 bg-neutral-900 shrink-0">
        <RightSidebar />
      </div>
      <BottomNav />
      {/* App-shell overlays mounted once so they work from any route. */}
      <AppMenu />
      <GlobalPostComposer />
      <ToastLayer />
    </div>
  );
}
