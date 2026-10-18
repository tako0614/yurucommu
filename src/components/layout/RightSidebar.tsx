import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { useSetAtom } from "solid-jotai";
import { useRequiredActor } from "../../hooks/useRequiredActor.ts";
import type { RecommendedUser } from "../../lib/api/recommendations.ts";
import { fetchRecommendedUsers, follow } from "../../lib/api.ts";
import { UserAvatar } from "../UserAvatar.tsx";
import { PluginSlot } from "../PluginSlot.tsx";
import { FollowByAddressForm } from "../connect/FollowByAddressForm.tsx";
import { OwnAddressPanel } from "../connect/OwnAddressPanel.tsx";
import { firstConnectionOnScreen } from "../connect/presence.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { pushToast, toastsAtom } from "../../atoms/toast.ts";

function RecommendedUserCard(props: {
  user: RecommendedUser;
  /** hadFocus: the card's button had focus as it went away. */
  onFollowed: (apId: string, hadFocus: boolean) => void;
}) {
  const { t } = useI18n();
  const nameId = createUniqueId();
  let buttonRef: HTMLButtonElement | undefined;
  const setToasts = useSetAtom(toastsAtom);
  const [following, setFollowing] = createSignal(false);
  const [requested, setRequested] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  // Clear the post-follow dismissal timer if the card unmounts first, so the
  // 600ms callback can't fire onFollowed on a torn-down parent.
  let followTimeout: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(followTimeout));

  const handleFollow = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (loading() || following() || requested()) return;

    setLoading(true);
    try {
      const { status } = await follow(props.user.ap_id);
      if (status === "pending") {
        // A private/remote follow lands as a pending request, NOT an accepted
        // follow — show "Requested" and keep the card rather than claiming
        // "Following" and dismissing it.
        setRequested(true);
      } else {
        setFollowing(true);
        followTimeout = setTimeout(
          () =>
            props.onFollowed(
              props.user.ap_id,
              document.activeElement === buttonRef,
            ),
          600,
        );
      }
    } catch (e) {
      // Surface the failure: the card reverts to "Follow", but without feedback
      // the user can't tell a tap failed (network/4xx/rate-limit) vs did nothing.
      console.error("Follow failed:", e);
      pushToast(setToasts, t("feedback.followFailed"), { kind: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    /* The profile link and the follow button are SIBLINGS — a <button> nested
       inside an <A> is invalid interactive nesting and breaks SR/keyboard
       focus order (same pattern as the SearchPage discover rows). */
    <div class="flex items-center gap-3 px-4 py-3 hover:bg-neutral-800/50 transition-colors">
      <A
        href={`/profile/${encodeURIComponent(props.user.ap_id)}`}
        class="flex min-w-0 flex-1 items-center gap-3"
      >
        <UserAvatar
          avatarUrl={props.user.icon_url}
          name={props.user.name || props.user.preferred_username}
          size="small"
        />
        <div class="flex-1 min-w-0">
          <div id={nameId} class="text-sm font-bold text-white truncate">
            {props.user.name || props.user.preferred_username}
          </div>
          <div class="text-xs text-neutral-500 truncate">
            @{props.user.username}
          </div>
        </div>
      </A>
      {/* Described by whose card it is (every one read only フォロー). Not
          disabled while following, so the focus stays on it (it fell to
          <body>); a press then is refused. */}
      <button
        ref={buttonRef}
        type="button"
        data-rec-follow
        aria-describedby={nameId}
        onClick={handleFollow}
        aria-disabled={
          loading() || following() || requested() ? "true" : undefined
        }
        class={`px-3 py-1 rounded-full text-xs font-bold transition-colors shrink-0 ${
          following() || requested()
            ? "bg-transparent text-neutral-500 border border-neutral-700"
            : "bg-white text-black hover:bg-neutral-200"
        }`}
      >
        {following()
          ? t("profile.following")
          : requested()
            ? t("profile.followRequested")
            : t("profile.follow")}
      </button>
    </div>
  );
}

export function RightSidebar() {
  const { t } = useI18n();
  const actor = useRequiredActor();
  const [users, setUsers] = createSignal<RecommendedUser[]>([]);
  const [loading, setLoading] = createSignal(true);

  createEffect(
    on(
      () => actor.ap_id,
      () => {
        let cancelled = false;
        // Solid does NOT treat a value returned from an effect/on() callback as
        // cleanup (on() forwards it as the next prevInput), so register the
        // cancel flag via onCleanup — it runs before the next actor change and
        // on unmount, preventing a stale in-flight response from overwriting a
        // newer actor's recommendations.
        onCleanup(() => {
          cancelled = true;
        });
        fetchRecommendedUsers()
          .then((data) => {
            if (!cancelled) setUsers(data);
          })
          .catch((e) => {
            // Non-critical feature: log instead of leaving an unhandled rejection.
            if (!cancelled) console.error("Failed to load recommendations", e);
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
    ),
  );

  // A followed card goes away; if its button had focus, focus moves to the
  // follow button of the card now in its place (or the last one), or, after
  // the last card, to the connect panel that replaces the list.
  let listRef: HTMLDivElement | undefined;
  const handleFollowed = (apId: string, hadFocus: boolean) => {
    const at = users().findIndex((u) => u.ap_id === apId);
    setUsers((prev) => prev.filter((u) => u.ap_id !== apId));
    if (!hadFocus || at === -1) return;
    queueMicrotask(() => {
      // After the last card the list is gone, but the ref still holds it and
      // its detached buttons, which cannot take focus.
      const buttons = listRef?.isConnected
        ? listRef.querySelectorAll<HTMLElement>("[data-rec-follow]")
        : [];
      const next =
        buttons[Math.min(at, buttons.length - 1)] ??
        document.querySelector<HTMLElement>("[data-sidebar-connect]");
      next?.focus();
    });
  };

  const showRecommendations = () => loading() || users().length > 0;
  // Recommendations are friends-of-friends from this server's follow table,
  // so on a single-owner server they are almost always empty and the column
  // stayed blank. Offer the two ways to grow connections instead, except where
  // the page already shows them: the empty home's first-connection panel and
  // the search page's own box.
  const location = useLocation();
  const showConnect = () =>
    !showRecommendations() &&
    !firstConnectionOnScreen() &&
    !location.pathname.startsWith("/search");

  return (
    <div class="sticky top-0">
      {/* Each panel is a named landmark of its own (they were outside every
          landmark). Not the column: often neither panel shows, and an empty
          unnamed aside beside the left sidebar's was a new violation. */}
      <Show when={showRecommendations()}>
        <aside aria-labelledby="sidebar-suggested-title" class="p-4 pb-0">
          <div
            ref={listRef}
            class="bg-neutral-900/50 rounded-2xl overflow-hidden"
          >
            <h2
              id="sidebar-suggested-title"
              class="text-lg font-bold px-4 pt-4 pb-2"
            >
              {t("profile.suggestedUsers")}
            </h2>
            <Show
              when={!loading()}
              fallback={
                <div class="px-4 py-6 text-center text-sm text-neutral-500">
                  {t("common.loading")}
                </div>
              }
            >
              <For each={users()}>
                {(user) => (
                  <RecommendedUserCard
                    user={user}
                    onFollowed={handleFollowed}
                  />
                )}
              </For>
            </Show>
          </div>
        </aside>
      </Show>
      <Show when={showConnect()}>
        <aside
          aria-labelledby="sidebar-connect-title"
          data-sidebar-connect
          tabindex="-1"
          class="focus-card p-4 pb-0"
        >
          <div class="space-y-6 rounded-2xl bg-neutral-900/50 p-4">
            <h2 id="sidebar-connect-title" class="text-lg font-bold">
              {t("firstFeed.sidebarTitle")}
            </h2>
            <FollowByAddressForm id="sidebar-connect-address" compact />
            <OwnAddressPanel compact />
          </div>
        </aside>
      </Show>
      <PluginSlot name="right-sidebar.below-recommendations" />
    </div>
  );
}
