import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { useAtom, useAtomValue, useSetAtom } from "solid-jotai";
import { tAtom } from "../atoms/i18n.ts";
import { hydrateScopeAtom, scopeQueryAtom } from "../atoms/scope.ts";
import { pushToast, toastsAtom } from "../atoms/toast.ts";
import {
  actorStoriesAtom,
  applyNewPostsAtom,
  checkNewPostsAtom,
  followingHasMoreAtom,
  followingLoadedAtAtom,
  followingLoadErrorAtom,
  followingLoadingAtom,
  followingLoadingMoreAtom,
  followingPostsAtom,
  followingScrollTopAtom,
  homeFeedTabAtom,
  loadFollowingTimelineAtom,
  loadMoreFollowingTimelineAtom,
  loadMoreTimelineAtom,
  loadStoriesAtom,
  loadTimelineAtom,
  pendingNewPostsAtom,
  showStoryComposerAtom,
  showStoryViewerAtom,
  storiesErrorAtom,
  storiesLoadingAtom,
  storyViewerActorIndexAtom,
  timelineHasMoreAtom,
  timelineLoadedAtAtom,
  timelineLoadErrorAtom,
  timelineLoadingAtom,
  timelineLoadingMoreAtom,
  timelinePostsAtom,
  timelineScrollTopAtom,
  type HomeFeedTab,
} from "../atoms/timeline.ts";
import { toggleBookmark, toggleLike, toggleRepost } from "../atoms/posts.ts";
import { deletePost, editPost } from "../lib/api/posts.ts";
import { blockUser, muteUser } from "../lib/api/actors.ts";
import { reportContent } from "../lib/api/moderation.ts";
import type { ActorStories, Post } from "../types/index.ts";

export function useTimelineState() {
  const t = useAtomValue(tAtom);
  const setToasts = useSetAtom(toastsAtom);
  const toastError = (key: Parameters<ReturnType<typeof t>>[0]) =>
    pushToast(setToasts, t()(key), { kind: "error" });
  let scrollContainerRef!: HTMLDivElement;
  // The sentinel is rendered only after posts load, so it appears (and can be
  // re-created when the list re-mounts) after onMount. Track it as a signal so
  // the IntersectionObserver effect can attach once the element exists.
  const [loadMoreSentinel, setLoadMoreSentinel] =
    createSignal<HTMLDivElement | null>(null);

  // State atoms — unified ("all") feed
  const [allPosts, setAllPosts] = useAtom(timelinePostsAtom);
  const setPendingNewPosts = useSetAtom(pendingNewPostsAtom);
  const scopeQuery = useAtomValue(scopeQueryAtom);
  const allLoading = useAtomValue(timelineLoadingAtom);
  const allLoadingMore = useAtomValue(timelineLoadingMoreAtom);
  const allHasMore = useAtomValue(timelineHasMoreAtom);
  const allLoadError = useAtomValue(timelineLoadErrorAtom);

  // State atoms — following feed (independent page/cursor/scroll state)
  const [followingPosts, setFollowingPosts] = useAtom(followingPostsAtom);
  const followingLoading = useAtomValue(followingLoadingAtom);
  const followingLoadingMore = useAtomValue(followingLoadingMoreAtom);
  const followingHasMore = useAtomValue(followingHasMoreAtom);
  const followingLoadError = useAtomValue(followingLoadErrorAtom);
  const followingLoadedAt = useAtomValue(followingLoadedAtAtom);
  const [savedFollowingScrollTop, setSavedFollowingScrollTop] = useAtom(
    followingScrollTopAtom,
  );

  // The home feed tab. Only meaningful on the unfiltered (personal) home: a
  // community view filter replaces the tab bar, so the EFFECTIVE tab snaps to
  // "all" whenever a community lens is active.
  const [feedTab, setFeedTab] = useAtom(homeFeedTabAtom);
  const activeTab = (): HomeFeedTab => (scopeQuery() ? "all" : feedTab());

  // Feed mutations (like/delete/edit/mute/...) must land in BOTH tabs' lists —
  // a post can be visible in each — plus the staged new-posts buffer where the
  // existing call sites already did.
  const setBothFeeds = (fn: (prev: Post[]) => Post[]) => {
    setAllPosts(fn);
    setFollowingPosts(fn);
  };

  // Story state
  const actorStories = useAtomValue(actorStoriesAtom);
  const setActorStories = useSetAtom(actorStoriesAtom);
  const storiesLoading = useAtomValue(storiesLoadingAtom);
  const setStoriesLoading = useSetAtom(storiesLoadingAtom);
  const storiesError = useAtomValue(storiesErrorAtom);
  const [showStoryViewer, setShowStoryViewer] = useAtom(showStoryViewerAtom);
  const storyViewerActorIndex = useAtomValue(storyViewerActorIndexAtom);
  const [showStoryComposer, setShowStoryComposer] = useAtom(
    showStoryComposerAtom,
  );
  const setStoryViewerActorIndex = useSetAtom(storyViewerActorIndexAtom);

  // Actions
  const loadTimeline = useSetAtom(loadTimelineAtom);
  const loadMoreAll = useSetAtom(loadMoreTimelineAtom);
  const loadFollowing = useSetAtom(loadFollowingTimelineAtom);
  const loadMoreFollowing = useSetAtom(loadMoreFollowingTimelineAtom);
  const loadStories = useSetAtom(loadStoriesAtom);
  const hydrateScope = useSetAtom(hydrateScopeAtom);

  // New-posts indicator
  const pendingNewPosts = useAtomValue(pendingNewPostsAtom);
  const checkNewPosts = useSetAtom(checkNewPostsAtom);
  const applyNewPosts = useSetAtom(applyNewPostsAtom);

  // Freshness window inside which a home re-mount (or a tab switch back)
  // reuses the in-memory feed instead of resetting it to page 1 (the 30s head
  // poll keeps the unified feed current). Applies per tab: each feed carries
  // its own loadedAt/scroll atoms so one tab's reuse never disturbs the other.
  const TIMELINE_FRESH_MS = 60_000;
  const timelineLoadedAt = useAtomValue(timelineLoadedAtAtom);
  const [savedScrollTop, setSavedScrollTop] = useAtom(timelineScrollTopAtom);

  type TimelineFeedView = {
    posts: () => Post[];
    loading: () => boolean;
    loadingMore: () => boolean;
    hasMore: () => boolean;
    loadError: () => string | null;
    loadedAt: () => number | null;
    scrollTop: () => number;
    setScrollTop: (offset: number) => void;
    reload: () => void;
    loadMore: () => void;
  };

  // Keep the two feeds' tab-specific state behind one private view descriptor.
  // The page can then render and operate on the active feed without repeating
  // the all/following choice at every lifecycle seam.
  const allFeed: TimelineFeedView = {
    posts: allPosts,
    loading: allLoading,
    loadingMore: allLoadingMore,
    hasMore: allHasMore,
    loadError: allLoadError,
    loadedAt: timelineLoadedAt,
    scrollTop: savedScrollTop,
    setScrollTop: (offset) => setSavedScrollTop(offset),
    reload: () => loadTimeline(),
    loadMore: () => loadMoreAll(),
  };
  const followingFeed: TimelineFeedView = {
    posts: followingPosts,
    loading: followingLoading,
    loadingMore: followingLoadingMore,
    hasMore: followingHasMore,
    loadError: followingLoadError,
    loadedAt: followingLoadedAt,
    scrollTop: savedFollowingScrollTop,
    setScrollTop: (offset) => setSavedFollowingScrollTop(offset),
    reload: () => loadFollowing(),
    loadMore: () => loadMoreFollowing(),
  };
  const feedFor = (tab: HomeFeedTab): TimelineFeedView =>
    tab === "following" ? followingFeed : allFeed;
  const activeFeed = () => feedFor(activeTab());

  // Tab-dispatched views over the two feeds. Every consumer below (list,
  // skeleton, sentinel, retry) reads these so the markup stays tab-agnostic.
  const posts = () => activeFeed().posts();
  const loading = () => activeFeed().loading();
  const loadingMore = () => activeFeed().loadingMore();
  const hasMore = () => activeFeed().hasMore();
  const loadError = () => activeFeed().loadError();
  const reload = () => activeFeed().reload();
  const loadMore = () => activeFeed().loadMore();

  const feedIsFresh = (tab: HomeFeedTab) => {
    const feed = feedFor(tab);
    const loadedAt = feed.loadedAt();
    return (
      feed.posts().length > 0 &&
      loadedAt !== null &&
      Date.now() - loadedAt < TIMELINE_FRESH_MS
    );
  };
  const savedScrollFor = (tab: HomeFeedTab) => feedFor(tab).scrollTop();
  const saveScrollFor = (tab: HomeFeedTab, offset: number) =>
    feedFor(tab).setScrollTop(offset);

  // Switch between the unified ("all") and following-only home feeds. The
  // outgoing tab's reading position is parked in its scroll atom; the incoming
  // tab either restores its own (fresh feed) or reloads page 1 (stale/never
  // loaded) — mirroring the re-mount freshness semantics above.
  const handleTabChange = (tab: HomeFeedTab) => {
    if (tab === activeTab()) return;
    if (scrollContainerRef)
      saveScrollFor(activeTab(), scrollContainerRef.scrollTop);
    setFeedTab(tab);
    if (feedIsFresh(tab)) {
      const offset = savedScrollFor(tab);
      requestAnimationFrame(() => {
        if (scrollContainerRef) scrollContainerRef.scrollTop = offset;
      });
    } else {
      // The saved position belonged to pages this reload discards.
      saveScrollFor(tab, 0);
      if (scrollContainerRef) scrollContainerRef.scrollTop = 0;
      void feedFor(tab).reload();
    }
  };

  // Initial load. The unified home defaults to PERSONAL scope ("everything you
  // can see") and `inhabitedScopeAtom` is NOT persisted — it resets to personal
  // on every load — so the first timeline/story fetch never depends on a
  // resolved scope (no stale stored community to reconcile away first). Fire
  // them in PARALLEL with scope hydration instead of waiting a round-trip on the
  // communities fetch. hydrateScope still runs (idempotent; AppLayout also kicks
  // it, deduped) to populate the community filter picker, and since it only
  // reconciles personal -> personal on cold load, the deferred scope-change
  // effect below never refires (no double-fetch).
  //
  // Re-mounts (back from a post detail / profile) previously ALWAYS refetched,
  // which replaced the loaded pages with page 1 and snapped the reader to the
  // top. When the in-memory feed is still fresh, skip the refetch and restore
  // the saved scroll offset instead; the atoms already hold the posts.
  onMount(() => {
    void hydrateScope();
    // The tab atom survives route round trips, so a return from a post detail
    // lands back on the tab (and reading position) the user left.
    const tab = activeTab();
    if (feedIsFresh(tab)) {
      const offset = savedScrollFor(tab);
      if (offset > 0) {
        // After the current render commits (the <For> list is synchronous, so
        // the content height is already there; images may still stream in).
        requestAnimationFrame(() => {
          if (scrollContainerRef) scrollContainerRef.scrollTop = offset;
        });
      }
    } else {
      feedFor(tab).reload();
    }
    loadStories();
  });

  // Preserve the reading position across unmounts (route round trips).
  onCleanup(() => {
    if (scrollContainerRef) {
      saveScrollFor(activeTab(), scrollContainerRef.scrollTop);
    }
  });

  // Reactively reload when the inhabited scope changes (personal <-> a
  // community). `defer: true` leaves the initial fetch to onMount above, so the
  // effect only fires on a real scope switch. We key on the community ap_id (or
  // "" for personal) so unrelated re-renders don't retrigger a fetch, and reset
  // the list + hasMore before reloading so stale posts and the bottom sentinel
  // don't survive the switch. loadTimeline() owns the loading/error/staged-head
  // resets and the IntersectionObserver/poll guards stay intact (they read the
  // same atoms loadTimeline mutates).
  createEffect(
    on(
      () => scopeQuery()?.community ?? "",
      () => {
        // A scope switch always lands on the unified feed: the community lens
        // replaces the tab bar, and returning to personal starts from "all"
        // rather than surprising the user with a parked "following" tab.
        setFeedTab("all");
        setAllPosts([]);
        // The saved reading position belongs to the PREVIOUS scope's feed; a
        // later re-mount must not restore it into this one.
        setSavedScrollTop(0);
        loadTimeline();
        // The StoryBar is scope-filtered too (loadStoriesAtom reads the same
        // scope): clear the stale group list and show the skeleton while the
        // new scope's stories load so the bar never flashes the prior scope.
        setActorStories([]);
        setStoriesLoading(true);
        loadStories();
      },
      { defer: true },
    ),
  );

  // Infinite scroll — auto-load when the bottom sentinel becomes visible.
  // loadMore() internally guards on loadingMore()/hasMore()/empty list, so
  // repeated intersection callbacks never trigger duplicate fetches. The
  // sentinel only exists once posts have rendered, so observe it reactively
  // (createEffect re-runs and re-attaches whenever the element changes).
  createEffect(() => {
    const sentinel = loadMoreSentinel();
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      {
        root: scrollContainerRef ?? null,
        rootMargin: "400px",
      },
    );
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  });

  // New-posts polling — check the timeline head every ~30s. Pauses while the
  // tab is hidden and refreshes immediately on return. checkNewPosts() guards
  // on an empty list internally and de-dupes, so this never disrupts scroll.
  onMount(() => {
    const NEW_POSTS_POLL_MS = 30000;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        void checkNewPosts();
      }, NEW_POSTS_POLL_MS);
    };
    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void checkNewPosts();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", handleVisibility);

    onCleanup(() => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibility);
    });
  });

  // Prepend staged new posts and scroll the list back to the top.
  const handleShowNewPosts = () => {
    applyNewPosts();
    if (scrollContainerRef) scrollContainerRef.scrollTop = 0;
  };

  // Story handlers
  const handleStoryClick = (stories: ActorStories, _index: number) => {
    const actualIndex = actorStories().findIndex(
      (as) => as.actor.ap_id === stories.actor.ap_id,
    );
    if (actualIndex >= 0) {
      setStoryViewerActorIndex(actualIndex);
      setShowStoryViewer(true);
    }
  };

  // Post interactions using shared helpers
  const handleLike = async (post: Parameters<typeof toggleLike>[0]) => {
    try {
      await toggleLike(post, setBothFeeds);
    } catch (e) {
      console.error("Failed to toggle like:", e);
      toastError("common.error");
    }
  };

  const handleBookmark = async (post: Parameters<typeof toggleBookmark>[0]) => {
    try {
      await toggleBookmark(post, setBothFeeds);
    } catch (e) {
      console.error("Failed to toggle bookmark:", e);
      toastError("common.error");
    }
  };

  const handleRepost = async (post: Parameters<typeof toggleRepost>[0]) => {
    try {
      await toggleRepost(post, setBothFeeds);
    } catch (e) {
      console.error("Failed to toggle repost:", e);
      toastError("common.error");
    }
  };

  // Remove a single post (after deleting your own) from the timeline.
  // Filtering by the post's own ap_id is deliberate: it also removes any boost
  // entries of the deleted post (they share the original's ap_id).
  const handleDelete = async (post: Post) => {
    try {
      await deletePost(post.ap_id);
      setBothFeeds((prev) => prev.filter((p) => p.ap_id !== post.ap_id));
      pushToast(setToasts, t()("feedback.postDeleted"), { kind: "success" });
    } catch (e) {
      console.error("Failed to delete post:", e);
      toastError("feedback.deleteFailed");
    }
  };

  // Edit your own post. The modal is opened by stashing the target post; saving
  // PATCHes content/summary and merges the server's confirmed fields back into
  // the in-memory feed (also into the staged "new posts" buffer in case the
  // edited post is still queued there) so the change shows without a refetch.
  const [editingPost, setEditingPost] = createSignal<Post | null>(null);
  const [savingEdit, setSavingEdit] = createSignal(false);

  const handleEdit = (post: Post) => setEditingPost(post);

  const handleSaveEdit = async (data: {
    content: string;
    summary: string | null;
  }) => {
    const target = editingPost();
    if (!target || savingEdit()) return;
    setSavingEdit(true);
    try {
      const updated = await editPost(target.ap_id, data);
      const apply = (p: Post) =>
        p.ap_id === target.ap_id
          ? { ...p, content: updated.content, summary: updated.summary }
          : p;
      setBothFeeds((prev) => prev.map(apply));
      setPendingNewPosts((prev) => prev.map(apply));
      setEditingPost(null);
      pushToast(setToasts, t()("feedback.postEdited"), { kind: "success" });
    } catch (e) {
      console.error("Failed to edit post:", e);
      toastError("feedback.editFailed");
    } finally {
      setSavingEdit(false);
    }
  };

  // Mute/block an author and drop all of their posts — from the live timeline AND
  // the staged "new posts" buffer (otherwise a muted author's already-fetched
  // posts re-enter the feed when the user taps "show new posts").
  const dropAuthorPosts = (authorApId: string) => {
    setBothFeeds((prev) => prev.filter((p) => p.author.ap_id !== authorApId));
    setPendingNewPosts((prev) =>
      prev.filter((p) => p.author.ap_id !== authorApId),
    );
  };

  const handleMute = async (post: Post) => {
    try {
      await muteUser(post.author.ap_id);
      dropAuthorPosts(post.author.ap_id);
      pushToast(setToasts, t()("feedback.muted"), { kind: "success" });
    } catch (e) {
      console.error("Failed to mute user:", e);
      toastError("feedback.muteFailed");
    }
  };

  const handleBlock = async (post: Post) => {
    try {
      await blockUser(post.author.ap_id);
      dropAuthorPosts(post.author.ap_id);
      pushToast(setToasts, t()("feedback.blocked"), { kind: "success" });
    } catch (e) {
      console.error("Failed to block user:", e);
      toastError("feedback.blockFailed");
    }
  };

  // Outbound report flow: a menu pick opens the reason sheet; submit files the
  // Flag to the remote author's instance.
  const [reportingPost, setReportingPost] = createSignal<Post | null>(null);
  const [reportBusy, setReportBusy] = createSignal(false);
  const handleReport = (post: Post) => setReportingPost(post);
  const cancelReport = () => setReportingPost(null);
  const submitReport = async (reason: string) => {
    const post = reportingPost();
    if (!post || reportBusy()) return;
    setReportBusy(true);
    try {
      await reportContent({
        targetActorApId: post.author.ap_id,
        postApId: post.ap_id,
        reason: reason || undefined,
      });
      pushToast(setToasts, t()("report.submitted"), { kind: "success" });
      setReportingPost(null);
    } catch (e) {
      console.error("Failed to submit report:", e);
      toastError("report.failed");
    } finally {
      setReportBusy(false);
    }
  };

  return {
    t: () => t(),
    get scrollContainerRef() {
      return scrollContainerRef;
    },
    set scrollContainerRef(el: HTMLDivElement) {
      scrollContainerRef = el;
    },
    set loadMoreSentinelRef(el: HTMLDivElement) {
      setLoadMoreSentinel(el ?? null);
    },
    posts,
    loading,
    loadingMore,
    hasMore,
    loadError,
    reload,
    loadMore,
    feedTab: activeTab,
    setFeedTab: handleTabChange,
    // The new-posts pill belongs to the unified feed's head poll only.
    newPostsCount: () => (activeTab() === "all" ? pendingNewPosts().length : 0),
    handleShowNewPosts,
    actorStories,
    storiesLoading,
    storiesError,
    showStoryViewer,
    setShowStoryViewer,
    storyViewerActorIndex,
    setStoryViewerActorIndex,
    showStoryComposer,
    setShowStoryComposer,
    handleStoryClick,
    handleAddStory: () => setShowStoryComposer(true),
    handleStorySuccess: loadStories,
    loadStories,
    handleLike,
    handleBookmark,
    handleRepost,
    handleDelete,
    handleMute,
    handleBlock,
    handleReport,
    reportingPost,
    reportBusy,
    submitReport,
    cancelReport,
    editingPost,
    setEditingPost,
    savingEdit,
    handleEdit,
    handleSaveEdit,
  };
}
