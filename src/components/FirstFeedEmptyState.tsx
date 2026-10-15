import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useI18n } from "../lib/i18n.tsx";
import { FollowByAddressForm } from "./connect/FollowByAddressForm.tsx";
import { OwnAddressPanel } from "./connect/OwnAddressPanel.tsx";
import { markFirstConnectionOnScreen } from "./connect/presence.ts";
import { WordBreakText } from "./WordBreakText.tsx";

interface FirstFeedEmptyStateProps {
  /** Triggers the Story composer (wired by the timeline). */
  onCreateStory: () => void;
  /** Opens the community composer (CreateScopeModal). */
  onCreateCommunity: () => void;
  /** Routes to the discovery surface to find/join existing communities. */
  onDiscoverCommunities: () => void;
  /**
   * The active community scope, or null/undefined when the inhabited scope is
   * personal. When a community is active the empty state swaps its personal
   * "grow your reach" CTAs for community-appropriate ones (post / invite).
   */
  communityScope?: { name: string } | null;
}

const CommunitiesIcon = () => (
  <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
    />
  </svg>
);

const InviteIcon = () => (
  <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
    />
  </svg>
);

const StoryIcon = () => (
  <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
    />
  </svg>
);

type EmptyStateAction = {
  icon: JSX.Element;
  label: string;
  onClick: () => void;
  primary?: boolean;
};

/**
 * Personal-scope first run. A new single-owner server has nobody to read yet,
 * and Yurucommu's point is reaching people on other ActivityPub servers, so the
 * empty home leads with the two things that make a first connection: follow
 * someone by their address, and hand out your own. Communities and a first
 * Story stay available as secondary actions.
 */
function FirstConnection(props: {
  onCreateStory: () => void;
  onCreateCommunity: () => void;
  onDiscoverCommunities: () => void;
}) {
  const { t } = useI18n();
  markFirstConnectionOnScreen();

  const secondaryActions = (): EmptyStateAction[] => [
    {
      icon: <CommunitiesIcon />,
      label: t("firstFeed.createCommunity"),
      onClick: () => props.onCreateCommunity(),
    },
    {
      icon: <CommunitiesIcon />,
      label: t("firstFeed.discoverCommunities"),
      onClick: () => props.onDiscoverCommunities(),
    },
    {
      icon: <StoryIcon />,
      label: t("firstFeed.firstStory"),
      onClick: () => props.onCreateStory(),
    },
  ];

  return (
    <section
      aria-labelledby="first-connection-title"
      class="mx-auto w-full max-w-md px-4 pt-10 pb-24 sm:px-6"
    >
      <h2
        id="first-connection-title"
        class="text-xl font-bold text-neutral-100 break-keep wrap-anywhere"
      >
        <WordBreakText text={t("firstFeed.title")} />
      </h2>
      <p class="mt-2 text-sm leading-relaxed text-neutral-400">
        {t("firstFeed.description")}
      </p>

      <div class="mt-6">
        <FollowByAddressForm id="first-connection-address" />
      </div>

      <OwnAddressPanel class="mt-8 rounded-2xl border border-neutral-800 p-4" />

      <div class="mt-8 border-t border-neutral-800 pt-4">
        <p class="text-xs text-neutral-400">{t("firstFeed.moreActions")}</p>
        <div class="mt-2 flex flex-wrap gap-2">
          <For each={secondaryActions()}>
            {(action) => (
              <button
                type="button"
                onClick={action.onClick}
                class="flex items-center gap-2 rounded-full border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
              >
                {action.icon}
                {action.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}

/**
 * Empty state for the first-run timeline. In the personal scope it walks the
 * owner to a first connection (see FirstConnection); in a community scope it
 * points to the community's own surface.
 */
export function FirstFeedEmptyState(props: FirstFeedEmptyStateProps) {
  const { t } = useI18n();
  const navigate = useNavigate();

  // Community-scope CTAs. This is a FILTERED VIEW of home (posts by this
  // community's members); an empty view just means none of them have posted yet.
  // Posting goes to your personal reach (not bound to a community), so we do NOT
  // offer a "seed this circle" post CTA here — that would broadcast to your whole
  // reach, not the community. Instead point to the community's own surface (open
  // it / invite members).
  const communityActions = (name: string): EmptyStateAction[] => [
    {
      icon: <CommunitiesIcon />,
      label: t("scope.communityOpen"),
      onClick: () => navigate(`/groups/${encodeURIComponent(name)}`),
      primary: true,
    },
    {
      icon: <InviteIcon />,
      label: t("scope.communityInvite"),
      onClick: () => navigate(`/groups/${encodeURIComponent(name)}`),
    },
  ];

  return (
    <Show
      when={props.communityScope}
      fallback={
        <FirstConnection
          onCreateStory={props.onCreateStory}
          onCreateCommunity={props.onCreateCommunity}
          onDiscoverCommunities={props.onDiscoverCommunities}
        />
      }
    >
      {(community) => (
        <div class="flex min-h-[50vh] flex-col items-center justify-center p-8 text-center">
          <h2 class="text-xl font-bold text-neutral-100">
            {t("scope.communityEmptyTitle")}
          </h2>
          <p class="mt-2 max-w-xs text-sm text-neutral-400">
            {t("scope.communityEmptyBody")}
          </p>
          <div class="mt-6 w-full max-w-xs space-y-3">
            <For each={communityActions(community().name)}>
              {(action) => (
                <button
                  type="button"
                  onClick={action.onClick}
                  class={
                    action.primary
                      ? "flex w-full items-center justify-center gap-3 rounded-full bg-accent px-5 py-3 text-sm font-medium text-white transition-colors"
                      : "flex w-full items-center justify-center gap-3 rounded-full border border-neutral-700 px-5 py-3 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
                  }
                >
                  {action.icon}
                  {action.label}
                </button>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
}

export default FirstFeedEmptyState;
