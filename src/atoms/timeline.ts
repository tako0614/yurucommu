import { atom } from "jotai/vanilla";
import { atomWithStorage } from "jotai/vanilla/utils";
import {
  feedItemKey,
  type ActorStories,
  type Post,
  type PostWithRepost,
} from "../types/index.ts";
import { tAtom } from "./i18n.ts";
import {
  type AccountInfo,
  allowedMimeTypes,
  createAccount,
  createPost,
  fetchAccounts,
  fetchStories,
  fetchTimeline,
  maxImageFileSize,
  maxVideoFileSize,
  switchAccount,
  uploadMedia,
} from "../lib/api.ts";
import { fetchFollowingTimeline } from "../lib/api/posts.ts";
import type { UploadedMedia } from "../components/timeline/types.ts";
import { ApiError } from "../lib/api/fetch.ts";
import { pushToast, toastWriter } from "./toast.ts";
import { scopeQueryAtom } from "./scope.ts";
// Mirrors the backend MAX_POST_CONTENT_LENGTH (posts/transformers.ts), used to
// surface a specific message when the server rejects an over-length post.
const MAX_POST_CONTENT_LENGTH = 5000;
// Ceiling on the in-memory infinite-scroll feed (auto-loaded on scroll). Keeps
// the live <For> DOM + memory bounded; older posts drop out of the window and
// re-load on a fresh scroll/reload.
const MAX_TIMELINE_POSTS = 300;

export type PostVisibility = "public" | "unlisted" | "followers" | "direct";

export type CreatePostOptions = {
  content: string;
  summary?: string;
  visibility?: PostVisibility;
  // When set, the post is bound to this community (audience = its members). It
  // comes from the inhabited scope, not a visibility control: default post
  // visibility stays public. Community-scoped posts only surface in that
  // community's reach, so a created one is not prepended to the personal head.
  community_ap_id?: string;
};

// --- Post state ---
export const timelinePostsAtom = atom<Post[]>([]);
export const timelineLoadingAtom = atom(true);
export const timelineLoadingMoreAtom = atom(false);
export const timelineHasMoreAtom = atom(true);
// Server-issued composite cursor (`published apId`) for the next older page.
// loadMore echoes this back as `before`; a post's ap_id must NOT be used (it
// decodes as a legacy published-only cursor that matches every row → the feed
// re-serves page 1 forever). Reset on every full reload.
export const timelineCursorAtom = atom<string | null>(null);
// Timestamp of the last successful full timeline load. A home re-mount (e.g.
// back from a post detail) skips the head refetch while the in-memory feed is
// still fresh, so loaded pages and the reading position survive the round trip
// instead of resetting to page 1.
export const timelineLoadedAtAtom = atom<number | null>(null);
// Scroll offset of the home feed's scroll container, captured on unmount and
// restored on the next mount when the fresh in-memory feed is reused.
export const timelineScrollTopAtom = atom(0);
// Primary-load failure (shown inline with a Retry button).
export const timelineLoadErrorAtom = atom<string | null>(null);

// --- Home feed tab ---
//
// "all" = the unified home (own + follows + communities, optionally narrowed
// by the community view filter); "following" = the following-only feed
// (GET /api/timeline/following). TRANSIENT like the scope filter: it survives
// route round trips (post detail and back) but resets to "all" on reload.
export type HomeFeedTab = "all" | "following";
export const homeFeedTabAtom = atom<HomeFeedTab>("all");

// --- Following feed state ---
//
// The following tab keeps its OWN page/cursor/scroll state (mirroring the
// unified atoms above) so switching tabs never resets the other tab's loaded
// pages or reading position, and the unified feed's 60s freshness-reuse
// semantics stay untouched.
export const followingPostsAtom = atom<Post[]>([]);
export const followingLoadingAtom = atom(true);
export const followingLoadingMoreAtom = atom(false);
export const followingHasMoreAtom = atom(true);
// Server-issued composite cursor — same semantics as timelineCursorAtom.
export const followingCursorAtom = atom<string | null>(null);
// Freshness timestamp — same reuse semantics as timelineLoadedAtAtom.
export const followingLoadedAtAtom = atom<number | null>(null);
// Reading position of the following tab, captured on tab switch / unmount.
export const followingScrollTopAtom = atom(0);
export const followingLoadErrorAtom = atom<string | null>(null);

// --- Post composition ---
//
// The composer draft (body + content warning + chosen audience) is persisted to
// localStorage so an unsent post survives a reload or a navigation away and is
// restored the next time the composer opens — the composer atoms are mounted
// once at shell level (GlobalPostComposer), so on app load they re-sync from
// storage. A successful post and an explicit discard both clear these
// (createPostAtom / closePostModalAtom), so nothing stale lingers. Visibility is
// persisted alongside the text so restoring a draft can never silently widen a
// followers-only post back to public. Staged media is NOT part of the draft
// (blob URLs / File handles are not serializable); text is.
export const postContentAtom = atomWithStorage("compose.draft.content", "");
export const postSummaryAtom = atomWithStorage("compose.draft.summary", "");
// Default visibility is public and is never changed implicitly.
export const postVisibilityAtom = atomWithStorage<PostVisibility>(
  "compose.draft.visibility",
  "public",
);
export const postingAtom = atom(false);
export const uploadedMediaAtom = atom<UploadedMedia[]>([]);
export const uploadingAtom = atom(false);
export const uploadErrorAtom = atom<string | null>(null);
export const showPostModalAtom = atom(false);
// Whether the shell-level ScopeSwitcherSheet is open. It is mounted once (in
// GlobalPostComposer) so the home header pill, the scope rail's "+", and the
// composer's audience re-aim all drive the same single instance rather than
// each page owning a private copy (single-modal shell design).
export const showScopeSwitcherAtom = atom(false);

// --- New-posts indicator ---
// Posts fetched from the timeline head that are newer than what is currently
// displayed. They are staged here (not prepended automatically) so the user
// keeps their scroll position; a pill surfaces the count and prepends on click.
export const pendingNewPostsAtom = atom<Post[]>([]);

// Ordering key of the newest post ever incorporated into the visible feed,
// mirroring the server feed order `desc(published), desc(apId)`. "Newer" = a
// lexically greater key. Tracked SEPARATELY from timelinePostsAtom because the
// feed cap (MAX_TIMELINE_POSTS) evicts the newest head once the user scrolls
// deep; without this watermark, checkNewPosts would re-stage already-seen head
// posts (they fall out of the known-id set) and the "N new" pill would lie.
// A boost entry (forward-compat, see PostWithRepost) sorts at the ANNOUNCE's
// timestamp on the server, so its sort key uses repost_published when present
// — identical to `published` for every entry the current server emits.
const postKey = (p: Post): string =>
  `${(p as PostWithRepost).repost_published ?? p.published} ${p.ap_id}`;
export const newestSeenKeyAtom = atom<string | null>(null);
// Advance the watermark to the newest of its current value and the given post.
const bumpNewestSeen = (
  get: (a: typeof newestSeenKeyAtom) => string | null,
  set: (a: typeof newestSeenKeyAtom, v: string | null) => void,
  head: Post | undefined,
): void => {
  if (!head) return;
  const k = postKey(head);
  const cur = get(newestSeenKeyAtom);
  if (cur === null || k > cur) set(newestSeenKeyAtom, k);
};

// Poll the timeline head and stage any posts newer than the current top one.
// Cheap and idempotent: it only stages posts not already shown or staged, and
// silently no-ops on error (the indicator is non-critical).
export const checkNewPostsAtom = atom(null, async (get, set) => {
  const current = get(timelinePostsAtom);
  // Nothing to compare against yet (or the primary list never loaded).
  if (current.length === 0) return;

  try {
    const scope = get(scopeQueryAtom);
    const { posts: head } = await fetchTimeline({
      limit: 20,
      community: scope?.community,
    });
    if (head.length === 0) return;

    // Keyed by feed-ENTRY identity (feedItemKey): a boost entry shares the
    // boosted post's ap_id, so an ap_id set would wrongly swallow a new boost
    // of an already-shown post (and vice versa).
    const knownIds = new Set([
      ...current.map(feedItemKey),
      ...get(pendingNewPostsAtom).map(feedItemKey),
    ]);
    const watermark = get(newestSeenKeyAtom);
    // A head post is genuinely new only if it is BOTH unseen AND strictly newer
    // than the watermark. The watermark gate is what keeps an evicted-then-
    // refetched head post (no longer in knownIds, but not actually new) from
    // being re-staged as "new".
    const fresh = head.filter(
      (p) =>
        !knownIds.has(feedItemKey(p)) &&
        (watermark === null || postKey(p) > watermark),
    );
    if (fresh.length === 0) return;

    set(pendingNewPostsAtom, (prev) => {
      const prevIds = new Set(prev.map(feedItemKey));
      const merged = [
        ...fresh.filter((p) => !prevIds.has(feedItemKey(p))),
        ...prev,
      ];
      // Bound the staged buffer so a busy timeline can't grow it unbounded.
      return merged.slice(0, 100);
    });
  } catch (e) {
    console.error("Failed to check for new posts:", e);
  }
});

// Prepend staged posts to the visible timeline and clear the indicator.
export const applyNewPostsAtom = atom(null, (get, set) => {
  const pending = get(pendingNewPostsAtom);
  if (pending.length === 0) return;
  const current = get(timelinePostsAtom);
  // Feed-ENTRY identity, so a staged boost is not dropped just because the
  // boosted post is already visible (they are distinct feed entries).
  const currentIds = new Set(current.map(feedItemKey));
  const deduped = pending.filter((p) => !currentIds.has(feedItemKey(p)));
  set(timelinePostsAtom, [...deduped, ...current]);
  set(pendingNewPostsAtom, []);
  // The applied posts are now incorporated at the head; advance the watermark.
  bumpNewestSeen(get, set, deduped[0]);
});

// --- Story state ---
export const actorStoriesAtom = atom<ActorStories[]>([]);
export const storiesLoadingAtom = atom(true);
export const storiesErrorAtom = atom<string | null>(null);
export const showStoryViewerAtom = atom(false);
export const storyViewerActorIndexAtom = atom(0);
export const showStoryComposerAtom = atom(false);

// --- Account state ---
export const accountsAtom = atom<AccountInfo[]>([]);
export const currentApIdAtom = atom("");
export const accountsLoadingAtom = atom(false);
export const accountsErrorAtom = atom<string | null>(null);
export const showAccountSwitcherAtom = atom(false);

// --- Actions ---

// Monotonic generation guards. Switching the home filter fires a fresh load; a
// slow prior fetch must NOT land its result over a newer view (last-writer-wins
// would let a slow "すべて" response overwrite the community you just picked).
// Each full reload bumps the counter and bails if superseded; loadMore captures
// the counter and bails if a reload happened mid-flight.
let timelineLoadGen = 0;
let storiesLoadGen = 0;

export const loadTimelineAtom = atom(null, async (get, set) => {
  const gen = ++timelineLoadGen;
  if (get(timelinePostsAtom).length === 0) set(timelineLoadingAtom, true);
  set(timelineLoadErrorAtom, null);
  set(timelineHasMoreAtom, true);
  set(timelineCursorAtom, null);
  try {
    const scope = get(scopeQueryAtom);
    const page = await fetchTimeline({
      limit: 20,
      community: scope?.community,
    });
    if (gen !== timelineLoadGen) return; // a newer load superseded this one
    set(timelinePostsAtom, page.posts);
    set(timelineCursorAtom, page.nextCursor);
    set(timelineHasMoreAtom, page.hasMore);
    set(timelineLoadedAtAtom, Date.now());
    // A full reload already shows the freshest head; drop any staged posts and
    // reset the new-posts watermark to this fresh head (page is newest-first).
    set(pendingNewPostsAtom, []);
    set(
      newestSeenKeyAtom,
      page.posts.length > 0 ? postKey(page.posts[0]) : null,
    );
  } catch (e) {
    if (gen !== timelineLoadGen) return;
    console.error("Failed to load timeline:", e);
    set(timelineLoadErrorAtom, get(tAtom)("common.loadFailed"));
  } finally {
    if (gen === timelineLoadGen) set(timelineLoadingAtom, false);
  }
});

export const loadMoreTimelineAtom = atom(null, async (get, set) => {
  const loadingMore = get(timelineLoadingMoreAtom);
  const hasMore = get(timelineHasMoreAtom);
  const posts = get(timelinePostsAtom);
  const cursor = get(timelineCursorAtom);
  // No server cursor means there is no defined "next older" boundary to resume
  // from — stop rather than refetch the head (which would re-serve page 1).
  if (loadingMore || !hasMore || posts.length === 0 || !cursor) return;

  set(timelineLoadingMoreAtom, true);
  const gen = timelineLoadGen;
  try {
    const scope = get(scopeQueryAtom);
    const page = await fetchTimeline({
      limit: 20,
      // The server-issued composite cursor — NOT lastPost.ap_id, which decodes
      // as a legacy published-only cursor that matches every row (the feed would
      // re-serve page 1 forever and stall).
      before: cursor,
      community: scope?.community,
    });
    // A full reload (e.g. filter switch) happened mid-flight → these are the
    // previous scope's next page; do not append them onto the new feed.
    if (gen !== timelineLoadGen) return;
    if (page.posts.length > 0) {
      // Cap the in-memory feed: the IntersectionObserver auto-fires load-more on
      // scroll, so an unbounded append would grow the live <For> DOM, memory, and
      // the per-interaction O(n) array realloc without limit. The feed is
      // newest-first and load-more appends OLDER posts at the tail, so slice(-N)
      // keeps the window the user is actively scrolling through (the oldest tail)
      // and evicts the already-scrolled-past newest head (a scroll back to the
      // very top then re-fetches). The staging buffer is likewise capped.
      const merged = [...get(timelinePostsAtom), ...page.posts];
      set(
        timelinePostsAtom,
        merged.length > MAX_TIMELINE_POSTS
          ? merged.slice(-MAX_TIMELINE_POSTS)
          : merged,
      );
    }
    set(timelineCursorAtom, page.nextCursor);
    set(timelineHasMoreAtom, page.hasMore);
  } catch (e) {
    console.error("Failed to load more:", e);
    pushToast(toastWriter(set), get(tAtom)("common.loadFailed"), {
      kind: "error",
    });
  } finally {
    set(timelineLoadingMoreAtom, false);
  }
});

// Monotonic generation guard for the following feed — same last-writer-wins
// protection as timelineLoadGen, tracked separately per tab.
let followingLoadGen = 0;

// Full (re)load of the following-only feed. Mirrors loadTimelineAtom minus the
// pieces that are unified-home-only (scope filter, staged new-posts buffer).
export const loadFollowingTimelineAtom = atom(null, async (get, set) => {
  const gen = ++followingLoadGen;
  if (get(followingPostsAtom).length === 0) set(followingLoadingAtom, true);
  set(followingLoadErrorAtom, null);
  set(followingHasMoreAtom, true);
  set(followingCursorAtom, null);
  try {
    const page = await fetchFollowingTimeline({ limit: 20 });
    if (gen !== followingLoadGen) return; // a newer load superseded this one
    set(followingPostsAtom, page.posts);
    set(followingCursorAtom, page.nextCursor);
    set(followingHasMoreAtom, page.hasMore);
    set(followingLoadedAtAtom, Date.now());
  } catch (e) {
    if (gen !== followingLoadGen) return;
    console.error("Failed to load following timeline:", e);
    set(followingLoadErrorAtom, get(tAtom)("common.loadFailed"));
  } finally {
    if (gen === followingLoadGen) set(followingLoadingAtom, false);
  }
});

// Older-page append for the following feed. Same cursor semantics and
// in-memory cap as loadMoreTimelineAtom.
export const loadMoreFollowingTimelineAtom = atom(null, async (get, set) => {
  const loadingMore = get(followingLoadingMoreAtom);
  const hasMore = get(followingHasMoreAtom);
  const posts = get(followingPostsAtom);
  const cursor = get(followingCursorAtom);
  if (loadingMore || !hasMore || posts.length === 0 || !cursor) return;

  set(followingLoadingMoreAtom, true);
  const gen = followingLoadGen;
  try {
    const page = await fetchFollowingTimeline({ limit: 20, before: cursor });
    // A full reload happened mid-flight → do not append a stale older page.
    if (gen !== followingLoadGen) return;
    if (page.posts.length > 0) {
      const merged = [...get(followingPostsAtom), ...page.posts];
      set(
        followingPostsAtom,
        merged.length > MAX_TIMELINE_POSTS
          ? merged.slice(-MAX_TIMELINE_POSTS)
          : merged,
      );
    }
    set(followingCursorAtom, page.nextCursor);
    set(followingHasMoreAtom, page.hasMore);
  } catch (e) {
    console.error("Failed to load more:", e);
    pushToast(toastWriter(set), get(tAtom)("common.loadFailed"), {
      kind: "error",
    });
  } finally {
    set(followingLoadingMoreAtom, false);
  }
});

export const loadStoriesAtom = atom(null, async (get, set) => {
  const gen = ++storiesLoadGen;
  set(storiesErrorAtom, null);
  try {
    // Filter the StoryBar by the inhabited scope: personal observes self +
    // followed (no community param); a community scope passes its ap_id so the
    // backend returns only that community's members' stories (member-gated).
    const scope = get(scopeQueryAtom);
    const data = await fetchStories(scope?.community);
    if (gen !== storiesLoadGen) return; // superseded by a newer scope load
    set(actorStoriesAtom, data);
  } catch (e) {
    if (gen !== storiesLoadGen) return;
    console.error("Failed to load stories:", e);
    set(storiesErrorAtom, get(tAtom)("story.loadFailed"));
  } finally {
    if (gen === storiesLoadGen) set(storiesLoadingAtom, false);
  }
});

export const createPostAtom = atom(
  null,
  async (get, set, options: CreatePostOptions) => {
    const { content } = options;
    const media = get(uploadedMediaAtom);
    if ((!content.trim() && media.length === 0) || get(postingAtom)) {
      return false;
    }

    set(postingAtom, true);
    try {
      const summary = options.summary?.trim();
      const newPost = await createPost({
        content: content.trim(),
        summary: summary ? summary : undefined,
        // Default visibility stays public; only forward an explicit choice.
        visibility:
          options.visibility && options.visibility !== "public"
            ? options.visibility
            : undefined,
        // Bind the post to the inhabited community scope (audience = members).
        community_ap_id: options.community_ap_id,
        attachments:
          media.length > 0
            ? media.map((m) => ({
                url: m.url,
                r2_key: m.r2_key,
                content_type: m.content_type,
                name: m.name?.trim() ? m.name.trim() : undefined,
              }))
            : undefined,
      });
      if (newPost) {
        // Optimistically prepend ONLY when the post would actually appear in the
        // feed the timeline is currently observing, so it can't show then vanish
        // on the next reload:
        //  - unified/personal home (no active community filter): the author's own
        //    post always belongs here.
        //  - community-narrowed view (filter = C): a post narrowed to C belongs;
        //    a PERSONAL post (no community) only surfaces in C's member feed when
        //    it is public/unlisted — a followers-only/private personal post does
        //    NOT (it lives in the unified home), so don't prepend it here.
        const activeFilter = get(scopeQueryAtom)?.community;
        const vis = options.visibility ?? "public";
        const showsInActiveFeed = !activeFilter
          ? true
          : options.community_ap_id === activeFilter
            ? true
            : !options.community_ap_id &&
              (vis === "public" || vis === "unlisted");
        if (showsInActiveFeed) {
          set(timelinePostsAtom, (prev) => [newPost, ...prev]);
          // The own post is now the freshest head; advance the watermark so a
          // head-poll doesn't later re-stage it as "new" if it gets evicted.
          bumpNewestSeen(get, set, newPost);
        }
        // The following feed's own-posts leg includes every personal
        // (non-community, non-direct) post of yours, so mirror the prepend
        // there — but only once that tab has actually loaded (prepending into
        // a never-loaded feed would fake a head that the first real load
        // replaces anyway).
        if (
          !options.community_ap_id &&
          vis !== "direct" &&
          get(followingLoadedAtAtom) !== null
        ) {
          set(followingPostsAtom, (prev) => [newPost, ...prev]);
        }
        set(postContentAtom, "");
        media.forEach((m) => m.preview && URL.revokeObjectURL(m.preview));
        set(uploadedMediaAtom, []);
        pushToast(toastWriter(set), get(tAtom)("feedback.postCreated"), {
          kind: "success",
        });
        return true;
      }
      return false;
    } catch (e) {
      console.error("Failed to create post:", e);
      // Map a server-side length rejection to a specific message so an
      // over-length post is explained rather than a generic failure. A summary
      // (content warning) overflow is mapped to its own message so it is never
      // mislabelled as a body-too-long error.
      const isLengthRejection =
        e instanceof ApiError &&
        e.status === 400 &&
        /too long/i.test(e.message);
      const isSummaryRejection =
        isLengthRejection && /summary|content warning/i.test(e.message);
      let message: string;
      if (isSummaryRejection) {
        message = get(tAtom)("compose.cwTooLong");
      } else if (isLengthRejection) {
        message = get(tAtom)("posts.tooLong").replace(
          "{max}",
          String(MAX_POST_CONTENT_LENGTH),
        );
      } else {
        message = get(tAtom)("feedback.postFailed");
      }
      pushToast(toastWriter(set), message, {
        kind: "error",
      });
      return false;
    } finally {
      set(postingAtom, false);
    }
  },
);

export const uploadMediaAtom = atom(null, async (get, set, file: File) => {
  if (get(uploadedMediaAtom).length >= 4) {
    // Selecting more than 4 files at once lands here for the excess — surface
    // the limit instead of silently dropping them.
    set(uploadErrorAtom, get(tAtom)("posts.mediaLimit"));
    return;
  }
  // Mirror the server's accept list (JPEG/PNG/GIF/WebP + MP4/WebM) with a
  // specific message: the file input's `accept` is advisory only, and the
  // package-level validateFile rejection would otherwise surface as a generic
  // "upload failed".
  if (!(allowedMimeTypes as readonly string[]).includes(file.type)) {
    set(uploadErrorAtom, get(tAtom)("posts.unsupportedMediaType"));
    return;
  }
  // Server-mirrored size caps (video 40MB / image 20MB), surfaced as a
  // friendly per-kind message before the doomed round-trip.
  const isVideo = file.type.startsWith("video/");
  const maxSize = isVideo ? maxVideoFileSize : maxImageFileSize;
  if (file.size > maxSize) {
    set(
      uploadErrorAtom,
      get(tAtom)(
        isVideo ? "posts.videoTooLarge" : "story.imageTooLarge",
      ).replace("{size}", String(maxSize / 1024 / 1024)),
    );
    return;
  }

  set(uploadingAtom, true);
  set(uploadErrorAtom, null);
  try {
    const result = await uploadMedia(file);
    const preview = URL.createObjectURL(file);
    set(uploadedMediaAtom, (prev) => [
      ...prev,
      {
        url: result.url,
        r2_key: result.r2_key,
        content_type: result.content_type,
        preview,
      },
    ]);
  } catch (e) {
    console.error("Failed to upload:", e);
    set(uploadErrorAtom, get(tAtom)("common.uploadFailed"));
  } finally {
    set(uploadingAtom, false);
  }
});

export const removeMediaAtom = atom(null, (_get, set, index: number) => {
  set(uploadedMediaAtom, (prev) => {
    const media = prev[index];
    if (media?.preview) URL.revokeObjectURL(media.preview);
    return prev.filter((_, i) => i !== index);
  });
});

// Update the alt text (`name`) of an uploaded attachment. Client-only.
export const setMediaAltAtom = atom(
  null,
  (_get, set, payload: { index: number; alt: string }) => {
    set(uploadedMediaAtom, (prev) =>
      prev.map((m, i) =>
        i === payload.index ? { ...m, name: payload.alt } : m,
      ),
    );
  },
);

export const loadAccountsAtom = atom(null, async (get, set) => {
  set(accountsLoadingAtom, true);
  set(accountsErrorAtom, null);
  try {
    const data = await fetchAccounts();
    set(accountsAtom, data.accounts);
    set(currentApIdAtom, data.current_ap_id);
  } catch (e) {
    console.error("Failed to load accounts:", e);
    set(accountsErrorAtom, get(tAtom)("settings.accountsLoadFailed"));
  } finally {
    set(accountsLoadingAtom, false);
  }
});

export const switchAccountAtom = atom(null, async (get, _set, apId: string) => {
  if (apId === get(currentApIdAtom)) return;
  await switchAccount(apId);
  window.location.reload();
});

// Create a new account and push it into the shared account list so the
// switcher (AppMenu / Settings) stays current without a refetch. The newly
// created account is not made current here; the caller decides whether to
// switch to it.
export const createAccountAtom = atom(
  null,
  async (_get, set, payload: { username: string; name?: string }) => {
    const account = await createAccount(payload.username, payload.name);
    set(accountsAtom, (prev) => [...prev, account]);
    return account;
  },
);

export const closePostModalAtom = atom(null, (_get, set) => {
  set(showPostModalAtom, false);
  set(postContentAtom, "");
  set(postSummaryAtom, "");
  // Reset to the default reach (public).
  set(postVisibilityAtom, "public");
  set(uploadedMediaAtom, (prev) => {
    prev.forEach((m) => m.preview && URL.revokeObjectURL(m.preview));
    return [];
  });
  set(uploadErrorAtom, null);
});
