import {
  createEffect,
  createSignal,
  For,
  lazy,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { useAtomValue, useSetAtom } from "solid-jotai";
import { useRequiredActor } from "../hooks/useRequiredActor.ts";
import { StoryBar } from "../components/story/StoryBar.tsx";
import { ScopeHeader } from "../components/scope/ScopeHeader.tsx";
import { createScopeOpenAtom } from "../atoms/shell.ts";
import { showScopeSwitcherAtom } from "../atoms/timeline.ts";
import { inhabitedScopeAtom } from "../atoms/scope.ts";
import type { HomeFeedTab } from "../atoms/timeline.ts";
import { handleTablistKeydown } from "../lib/tablistNav.ts";
import { LoadingSpinner } from "../components/LoadingSpinner.tsx";

// Lazy load heavy components
const StoryViewer = lazy(() => import("../components/story/StoryViewer.tsx"));
const StoryComposer = lazy(
  () => import("../components/story/composer/StoryComposer.tsx"),
);
import { InlineErrorRetry } from "../components/InlineErrorRetry.tsx";
import { FirstFeedEmptyState } from "../components/FirstFeedEmptyState.tsx";
import { TimelinePostItem } from "../components/timeline/TimelinePostItem.tsx";
import { FilteredPost } from "../components/timeline/FilteredPost.tsx";
import { EditPostModal } from "../components/timeline/EditPostModal.tsx";
import { ReportSheet } from "../components/ReportSheet.tsx";
import { PostSkeleton } from "../components/timeline/PostSkeleton.tsx";
import { PluginSlot } from "../components/PluginSlot.tsx";
import { useTimelineState } from "./useTimelineState.ts";

// Home feed tabs: the unified home ("すべて") and the following-only feed.
const FEED_TABS: {
  key: HomeFeedTab;
  labelKey: "timeline.all" | "timeline.following";
}[] = [
  { key: "all", labelKey: "timeline.all" },
  { key: "following", labelKey: "timeline.following" },
];

export function TimelinePage() {
  const actor = useRequiredActor();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useTimelineState();
  const [linkedStoryIndex, setLinkedStoryIndex] = createSignal<
    number | undefined
  >(undefined);

  // Notification push/list links use `/?story=<AP id>`. Stories are already
  // fetched for the home bar, so resolve the id against that authoritative
  // list and open the exact item without inventing a second story-detail API.
  // Expired/deleted stories safely leave the user on home.
  createEffect(() => {
    const raw = searchParams.story;
    const storyApId = Array.isArray(raw) ? raw[0] : raw;
    if (!storyApId || state.storiesLoading() || state.storiesError()) return;

    for (const [actorIndex, group] of state.actorStories().entries()) {
      const storyIndex = group.stories.findIndex(
        (story) => story.ap_id === storyApId,
      );
      if (storyIndex < 0) continue;
      setLinkedStoryIndex(storyIndex);
      state.setStoryViewerActorIndex(actorIndex);
      state.setShowStoryViewer(true);
      return;
    }

    // The story has expired, was deleted, or is no longer readable.
    setSearchParams({ story: undefined }, { replace: true });
  });

  const closeStoryViewer = () => {
    state.setShowStoryViewer(false);
    setLinkedStoryIndex(undefined);
    if (searchParams.story) {
      setSearchParams({ story: undefined }, { replace: true });
    }
    state.loadStories();
  };

  // The scope switcher sheet and the "create a community" modal are mounted
  // once at shell level (GlobalPostComposer). The home header pill, the scope
  // rail's "+", and the first-feed empty state drive those single instances via
  // the shared atoms instead of mounting private duplicates here.
  const openSwitcher = useSetAtom(showScopeSwitcherAtom);
  const openCreateScope = useSetAtom(createScopeOpenAtom);

  // The inhabited scope drives whether the first-feed empty state shows the
  // personal "grow your reach" CTAs or the community "seed the room you are in"
  // CTAs. Inside a community, the personal CTAs (find people / create / discover
  // communities) are nonsensical.
  const inhabitedScope = useAtomValue(inhabitedScopeAtom);
  const communityScope = () => {
    const scope = inhabitedScope();
    return scope.kind === "community" ? { name: scope.name } : null;
  };

  // Prefetch the lazy story chunks once the home view is up, so the first tap on
  // a story (view) or "+" (compose) opens instantly instead of flashing the
  // Suspense spinner while the chunk downloads. The StoryBar — and thus both
  // actions — is always present on home; preload is idempotent and non-blocking.
  onMount(() => {
    void StoryViewer.preload?.();
    void StoryComposer.preload?.();
  });

  return (
    <div class="relative flex flex-col h-full">
      {/* Story Viewer Modal */}
      <Show when={state.showStoryViewer() && state.actorStories().length > 0}>
        <Suspense fallback={<LoadingSpinner fullScreen={true} />}>
          <StoryViewer
            actorStories={state.actorStories()}
            initialActorIndex={state.storyViewerActorIndex()}
            initialStoryIndex={linkedStoryIndex()}
            currentUserApId={actor.ap_id}
            onClose={closeStoryViewer}
          />
        </Suspense>
      </Show>

      {/* Story Composer Modal */}
      <Show when={state.showStoryComposer()}>
        <Suspense fallback={<LoadingSpinner fullScreen={true} />}>
          <StoryComposer
            onClose={() => state.setShowStoryComposer(false)}
            onSuccess={state.handleStorySuccess}
          />
        </Suspense>
      </Show>

      {/* Edit-post modal. Keyed so re-opening on a different post re-mounts the
          modal and re-initialises its content/CW signals from that post. */}
      <Show when={state.editingPost()} keyed>
        {(post) => (
          <EditPostModal
            post={post}
            saving={state.savingEdit()}
            onClose={() => state.setEditingPost(null)}
            onSave={state.handleSaveEdit}
          />
        )}
      </Show>

      <ReportSheet
        open={state.reportingPost() !== null}
        busy={state.reportBusy()}
        onSubmit={state.submitReport}
        onCancel={state.cancelReport}
      />

      {/* Home header. The individual is the base, so there is no scope to name or
          switch; the optional home view filter ("すべて" + each joined community)
          is folded inline into this single bar instead of a third stacked rail. */}
      <ScopeHeader onOpenSwitcher={() => openSwitcher(true)} />

      {/* Home feed tabs — unified ("すべて") vs following-only. Shown only on
          the unfiltered personal home: a community view filter already narrows
          the feed, so the tab bar hides while a lens is active. */}
      <Show when={!communityScope()}>
        <div
          role="tablist"
          aria-label={state.t()("timeline.feedTabs")}
          class="flex border-b border-neutral-800"
          onKeyDown={(e) => {
            const cur = FEED_TABS.findIndex(
              (tab) => tab.key === state.feedTab(),
            );
            handleTablistKeydown(e, FEED_TABS.length, cur < 0 ? 0 : cur, (i) =>
              state.setFeedTab(FEED_TABS[i].key),
            );
          }}
        >
          <For each={FEED_TABS}>
            {(tab) => (
              <button
                role="tab"
                aria-selected={state.feedTab() === tab.key}
                tabindex={state.feedTab() === tab.key ? 0 : -1}
                onClick={() => state.setFeedTab(tab.key)}
                class={`flex-1 px-4 py-2.5 text-sm font-bold whitespace-nowrap transition-colors border-b-2 ${
                  state.feedTab() === tab.key
                    ? "text-white border-accent"
                    : "text-neutral-500 border-transparent hover:text-neutral-300"
                }`}
              >
                {state.t()(tab.labelKey)}
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Story Bar */}
      <StoryBar
        actor={actor}
        actorStories={state.actorStories()}
        loading={state.storiesLoading()}
        error={state.storiesError()}
        onRetry={state.loadStories}
        onStoryClick={(stories, actorListIndex) => {
          setLinkedStoryIndex(0);
          state.handleStoryClick(stories, actorListIndex);
        }}
        onAddStory={state.handleAddStory}
      />

      <div
        ref={(el) => {
          state.scrollContainerRef = el;
        }}
        class="relative flex-1 overflow-y-auto"
      >
        {/* New-posts pill — anchored to the scroll container (sticky to its
            viewport top) so it never collides with the header / story / scope
            bars stacked above the scroll area. */}
        <Show when={state.newPostsCount() > 0}>
          <div
            role="status"
            aria-live="polite"
            class="pointer-events-none sticky top-2 z-20 flex h-0 justify-center"
          >
            <button
              onClick={state.handleShowNewPosts}
              class="pointer-events-auto flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-bold text-white shadow-lg transition-colors"
            >
              <svg
                class="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M5 15l7-7 7 7"
                />
              </svg>
              {state
                .t()("timeline.newPosts")
                .replace("{count}", String(state.newPostsCount()))}
            </button>
          </div>
        </Show>

        <Show
          when={!(state.loadError() && state.posts().length === 0)}
          fallback={
            <InlineErrorRetry
              message={state.loadError()!}
              retryLabel={state.t()("common.retry")}
              onRetry={state.reload}
            />
          }
        >
          <Show
            when={!(state.loading() && state.posts().length === 0)}
            fallback={<PostSkeleton count={6} />}
          >
            <Show
              when={state.posts().length > 0}
              fallback={
                <Show
                  when={state.feedTab() === "following"}
                  fallback={
                    <FirstFeedEmptyState
                      communityScope={communityScope()}
                      onCreateStory={state.handleAddStory}
                      onCreateCommunity={() => openCreateScope(true)}
                      onDiscoverCommunities={() => navigate("/search")}
                    />
                  }
                >
                  {/* Following-only empty state: the community/story CTAs of
                      the first-feed empty state don't apply here. */}
                  <div class="flex min-h-[50vh] flex-col items-center justify-center p-8 text-center">
                    <p class="max-w-xs text-sm text-neutral-400">
                      {state.t()("timeline.followingEmpty")}
                    </p>
                    <button
                      type="button"
                      onClick={() => navigate("/search")}
                      class="mt-6 rounded-full border border-neutral-700 px-5 py-3 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
                    >
                      {state.t()("timeline.findPeople")}
                    </button>
                  </div>
                </Show>
              }
            >
              <For each={state.posts()}>
                {(post, index) => (
                  <div>
                    <FilteredPost post={post}>
                      <TimelinePostItem
                        post={post}
                        onReply={() =>
                          navigate(`/post/${encodeURIComponent(post.ap_id)}`)
                        }
                        onRepost={state.handleRepost}
                        onLike={state.handleLike}
                        onBookmark={state.handleBookmark}
                        currentActorApId={actor.ap_id}
                        onDelete={state.handleDelete}
                        onMute={state.handleMute}
                        onBlock={state.handleBlock}
                        onEdit={state.handleEdit}
                        onReport={state.handleReport}
                      />
                    </FilteredPost>
                    <Show
                      when={
                        index() === 2 ||
                        (index() > 2 && (index() - 2) % 8 === 0)
                      }
                    >
                      <PluginSlot name="timeline.between-posts" />
                    </Show>
                  </div>
                )}
              </For>
              {/* Auto-load sentinel: observed by IntersectionObserver. */}
              <div
                ref={(el) => {
                  state.loadMoreSentinelRef = el;
                }}
                class="h-px w-full"
                aria-hidden="true"
              />
              {/* Keyboard/SR-reachable equivalent of the scroll sentinel: the
                  IntersectionObserver only fires on scroll, leaving keyboard and
                  screen-reader users with no way to page. loadMore() self-guards
                  on loadingMore/hasMore. */}
              <Show
                when={
                  state.hasMore() &&
                  !state.loadingMore() &&
                  state.posts().length > 0
                }
              >
                <div class="flex justify-center py-4">
                  <button
                    onClick={() => state.loadMore()}
                    class="px-4 py-2 text-sm text-neutral-400 hover:text-white rounded-full border border-neutral-800 hover:bg-neutral-800/50 transition-colors"
                  >
                    {state.t()("common.loadMore")}
                  </button>
                </div>
              </Show>
              <Show when={state.loadingMore()}>
                <div
                  class="flex justify-center py-4"
                  role="status"
                  aria-label={state.t()("common.loading")}
                >
                  <div class="w-6 h-6 border-2 border-neutral-700 border-t-neutral-400 rounded-full animate-spin" />
                </div>
              </Show>
              <Show when={!state.hasMore() && state.posts().length > 0}>
                <div class="p-4 text-center text-neutral-600 text-sm">
                  {state.t()("timeline.noMorePosts")}
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

export default TimelinePage;
