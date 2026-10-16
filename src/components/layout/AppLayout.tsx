import { onMount, type JSX } from "solid-js";
import { useSetAtom } from "solid-jotai";
import { Sidebar } from "./Sidebar.tsx";
import { BottomNav } from "./BottomNav.tsx";
import { RightSidebar } from "./RightSidebar.tsx";
import { AppHeaderMobile } from "./AppHeaderMobile.tsx";
import { AppMenu } from "./AppMenu.tsx";
import { conversationOnScreen } from "./routeChrome.ts";
import { GlobalPostComposer } from "./GlobalPostComposer.tsx";
import { ToastLayer } from "../ToastLayer.tsx";
import { useNotificationPolling } from "../../hooks/useNotificationPolling.ts";
import { useDmUnreadPolling } from "../../hooks/useDmUnreadPolling.ts";
import { hydrateScopeAtom } from "../../atoms/scope.ts";

export function AppLayout(props: { children?: JSX.Element }) {
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
      <Sidebar />
      <main
        class={`flex-1 flex flex-col min-h-screen pt-[env(safe-area-inset-top)] ${mainPadding()} md:pt-0 md:pb-0 overflow-hidden border-x border-neutral-800 max-w-2xl`}
      >
        {/* Mobile-only app-shell header: the AppMenu trigger, on screens
            without a header of their own (see routeChrome.ts). */}
        <AppHeaderMobile />
        {props.children}
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
