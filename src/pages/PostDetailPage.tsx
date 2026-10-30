import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import { useRequiredActor } from "../hooks/useRequiredActor.ts";
import { MediaAttachment, Post } from "../types/index.ts";
import {
  bookmarkPost,
  createPost,
  editPost,
  fetchPost,
  fetchReplies,
  getYurucommuApiTransport,
  likePost,
  repostPost,
  unbookmarkPost,
  unlikePost,
  unrepostPost,
} from "../lib/api.ts";
import { ApiError } from "../lib/api/fetch.ts";
import { EditPostModal } from "../components/timeline/EditPostModal.tsx";
import { PostVisibilityIndicator } from "../components/timeline/PostVisibilityIndicator.tsx";
import { useI18n } from "../lib/i18n.tsx";
import { decodeApIdParam } from "../lib/routeApId.ts";
import { useAtom, useAtomValue, useSetAtom, useStore } from "solid-jotai";
import { atom } from "jotai/vanilla";
import {
  actorAtom,
  authSessionEpochAtom,
  hostedUserAtom,
  logoutBusyAtom,
  selectedInstanceIdAtom,
} from "../atoms/auth.ts";
import { pushToast, toastsAtom } from "../atoms/toast.ts";
import {
  acknowledgeTimelineBookmarkAtom,
  deleteTimelinePostAtom,
  timelinePostsAtom,
} from "../atoms/timeline.ts";
import { ConfirmSheet } from "../components/ConfirmSheet.tsx";
import { formatDateTime } from "../lib/datetime.ts";
import { UserAvatar } from "../components/UserAvatar.tsx";
import { PostContent } from "../components/PostContent.tsx";
import {
  BookmarkIcon,
  HeartIcon,
  ReplyIcon,
  RepostIcon,
} from "../components/icons/SocialIcons.tsx";
import { InlineErrorBanner } from "../components/InlineErrorBanner.tsx";
import { InlineErrorRetry } from "../components/InlineErrorRetry.tsx";
import { acknowledgesPost } from "../lib/post-acknowledgement.ts";
import { classifyWriteFailure } from "../lib/write-outcome.ts";
import { getAuthStrategy } from "../lib/plugin.ts";
import {
  mediaAttachmentUrl,
  MediaLightbox,
  useMediaLightbox,
} from "../components/MediaLightbox.tsx";

// Mirrors the backend MAX_POST_CONTENT_LENGTH (posts/transformers.ts). The
// server stays the authority (it rejects an over-length reply with 400); this
// only powers the counter + a local submit gate so the user sees the limit
// before the round-trip instead of an opaque error.
const MAX_REPLY_LENGTH = 5000;
// Provider-scoped so leaving and reopening a post cannot duplicate an in-flight send.
const pendingRepliesAtom = atom<ReadonlyMap<string, symbol>>(new Map());
type InteractionKind = "like" | "repost" | "bookmark";
type PendingInteractionKind = InteractionKind | "delete";
type InteractionSettlement = {
  kind: PendingInteractionKind;
  targetId: string;
  parentId: string;
  sameScope: () => boolean;
};
type InteractionObserver = (
  settlement: InteractionSettlement,
) => Promise<void> | void;
// Local to a Provider: neither map supplies a durable permission or receipt.
const pendingInteractionsAtom = atom<ReadonlyMap<string, symbol>>(new Map());
const interactionObserversAtom = atom<ReadonlySet<InteractionObserver>>(
  new Set<InteractionObserver>(),
);

const BackIcon = () => (
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M10 19l-7-7m0 0l7-7m-7 7h18"
    />
  </svg>
);

const TrashIcon = () => (
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
    />
  </svg>
);

const EditIcon = () => (
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
    />
  </svg>
);

export function PostDetailPage() {
  const actor = useRequiredActor();
  const currentActor = useAtomValue(actorAtom);
  const currentInstance = useAtomValue(selectedInstanceIdAtom);
  const currentHostedUser = useAtomValue(hostedUserAtom);
  const store = useStore();
  const acknowledgeBookmark = useSetAtom(acknowledgeTimelineBookmarkAtom);
  const params = useParams();
  const navigate = useNavigate();
  const { t, language } = useI18n();
  const setToasts = useSetAtom(toastsAtom);
  const setTimelinePosts = useSetAtom(timelinePostsAtom);
  const deleteTimelinePost = useSetAtom(deleteTimelinePostAtom);
  const [error, setError] = createSignal<string | null>(null);
  const clearError = () => setError(null);
  const [post, setPost] = createSignal<Post | null>(null);
  const [replies, setReplies] = createSignal<Post[]>([]);
  const [repliesCursor, setRepliesCursor] = createSignal<string | null>(null);
  const [repliesHasMore, setRepliesHasMore] = createSignal(false);
  const [loadingMoreReplies, setLoadingMoreReplies] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [replyContent, setReplyContent] = createSignal("");
  // A pending send belongs to its target, even after navigating away and back.
  const [pendingReplies, setPendingReplies] = useAtom(pendingRepliesAtom);
  const [pendingInteractions, setPendingInteractions] = useAtom(
    pendingInteractionsAtom,
  );
  const replying = () => {
    const id = post()?.ap_id;
    return id ? pendingReplies().has(id) : false;
  };
  let replyDraftRevision = 0;
  let mounted = true;
  let resolveDisposed: () => void = () => {};
  const disposed = new Promise<void>((resolve) => {
    resolveDisposed = resolve;
  });
  onCleanup(() => {
    mounted = false;
    resolveDisposed();
  });
  // Reply composer textarea — the action-bar reply button focuses it.
  let replyInputRef: HTMLTextAreaElement | undefined;
  // Pending delete target, staged so the shared ConfirmSheet can gate it.
  const [pendingDelete, setPendingDelete] = createSignal<{
    post: Post;
    isReply: boolean;
    parentId: string;
    generation: number;
    sameScope: () => boolean;
  } | null>(null);
  const lightbox = useMediaLightbox();

  // Load failure states, split by cause: a non-404 post-load failure renders a
  // retry view (NOT the misleading "post not found" text — the post may exist
  // fine), and a replies-only failure keeps the successfully fetched post
  // visible with an inline retry for the replies (Promise.all would have
  // discarded the post along with the failed replies).
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [repliesFailed, setRepliesFailed] = createSignal(false);
  // Bumping this re-runs the load effect for the current post (retry).
  const [reloadKey, setReloadKey] = createSignal(0);
  const retryLoad = () => setReloadKey((k) => k + 1);

  // Generation guard: a fast post→post navigation must not let a slow prior
  // load land its post/replies under the new post.
  let postLoadGen = 0;
  let timelineBeforePostLoad: Post | undefined;
  createEffect(() => {
    const postId = params.postId;
    reloadKey();
    if (!postId) return;

    const gen = ++postLoadGen;
    setPendingDelete(null);
    setPost(null);
    setReplies([]);
    // Pagination belongs to this post/load, not the previous generation.
    setRepliesCursor(null);
    setRepliesHasMore(false);
    setLoadingMoreReplies(false);
    replyDraftRevision++;
    setReplyContent("");
    setError(null);
    setLoadFailed(false);
    setRepliesFailed(false);
    setLoading(true);

    const decodedPostId = decodeApIdParam(postId);
    timelineBeforePostLoad = store
      .get(timelinePostsAtom)
      .find((item) => item.ap_id === decodedPostId);
    Promise.allSettled([fetchPost(decodedPostId), fetchReplies(decodedPostId)])
      .then(([postResult, repliesResult]) => {
        if (gen !== postLoadGen) return;
        if (postResult.status === "rejected") {
          const e = postResult.reason;
          console.error("Failed to load post:", e);
          // A 404 is the expected "this post does not exist / was deleted"
          // case; the inline not-found view below already says so. Any other
          // failure gets the retry view instead.
          if (!(e instanceof ApiError && e.status === 404)) {
            setLoadFailed(true);
          }
          return;
        }
        setPost(postResult.value);
        if (repliesResult.status === "rejected") {
          console.error("Failed to load replies:", repliesResult.reason);
          setRepliesFailed(true);
          return;
        }
        setReplies(repliesResult.value.replies);
        setRepliesCursor(repliesResult.value.nextCursor);
        setRepliesHasMore(repliesResult.value.hasMore);
      })
      .finally(() => {
        if (gen === postLoadGen) setLoading(false);
      });
  });

  // Append the next page of replies. Guarded against a post→post navigation
  // mid-flight (capture the load generation) and deduped by ap_id.
  const loadMoreReplies = async () => {
    const cursor = repliesCursor();
    if (loadingMoreReplies() || !repliesHasMore() || !cursor) return;
    const decodedPostId = decodeApIdParam(params.postId);
    const gen = postLoadGen;
    setLoadingMoreReplies(true);
    try {
      const next = await fetchReplies(decodedPostId, { before: cursor });
      if (gen !== postLoadGen) return;
      setReplies((prev) => {
        const seen = new Set(prev.map((r) => r.ap_id));
        return [...prev, ...next.replies.filter((r) => !seen.has(r.ap_id))];
      });
      setRepliesCursor(next.nextCursor);
      setRepliesHasMore(next.hasMore);
    } catch (e) {
      console.error("Failed to load more replies:", e);
      if (gen === postLoadGen) setError(t("common.error"));
    } finally {
      if (gen === postLoadGen) setLoadingMoreReplies(false);
    }
  };

  // A repost is an Announce to Public, so only a publicly-reachable post may be
  // boosted — mirrors the backend gate and TimelinePostItem's isRepostable.
  const isRepostable = (p: Post): boolean =>
    (p.visibility === "public" || p.visibility === "unlisted") &&
    !p.community_ap_id;

  // Mirror an interaction-state change onto the timeline's cached copy of the
  // same post — the delete and reply-count paths already do this. Without it a
  // like/repost/bookmark toggled here shows stale on navigating back within
  // the feed's reuse window.
  const syncTimelinePost = (apId: string, patch: (p: Post) => Post) => {
    setTimelinePosts((prev) =>
      prev.map((p) => (p.ap_id === apId ? patch(p) : p)),
    );
  };

  // The Provider store outlives this page. Read it again after an await so a
  // response from an older session cannot update the new session's feed.
  const captureInteractionScope = (path: string) => {
    try {
      const actorApId = store.get(actorAtom)?.ap_id;
      if (!actorApId || store.get(logoutBusyAtom)) return null;
      const epoch = store.get(authSessionEpochAtom);
      const instanceId = store.get(selectedInstanceIdAtom);
      const hostedUserId = store.get(hostedUserAtom)?.id ?? null;
      const strategy = getAuthStrategy();
      const transport = getYurucommuApiTransport();
      const url = transport.resolveUrl(path);
      return () => {
        try {
          return (
            !store.get(logoutBusyAtom) &&
            store.get(actorAtom)?.ap_id === actorApId &&
            store.get(authSessionEpochAtom) === epoch &&
            store.get(selectedInstanceIdAtom) === instanceId &&
            (store.get(hostedUserAtom)?.id ?? null) === hostedUserId &&
            getAuthStrategy() === strategy &&
            getYurucommuApiTransport() === transport &&
            transport.resolveUrl(path) === url
          );
        } catch {
          return false;
        }
      };
    } catch {
      return null;
    }
  };

  const replaceInteractionFields = (
    old: Post,
    fresh: Post,
    kind: InteractionKind,
  ): Post =>
    kind === "like"
      ? { ...old, liked: fresh.liked, like_count: fresh.like_count }
      : kind === "repost"
        ? {
            ...old,
            reposted: fresh.reposted,
            announce_count: fresh.announce_count,
          }
        : { ...old, bookmarked: fresh.bookmarked };
  const reportInteractionRefreshFailure = () =>
    pushToast(
      setToasts,
      language() === "ja"
        ? "操作は受け付けられましたが、最新の投稿を取得できません。投稿を開き直して確認してください。"
        : "The action was accepted, but the post could not be refreshed. Reopen the post to check it.",
      { kind: "error", timeout: 0 },
    );
  const syncInteractionTimeline = (
    id: string,
    kind: Exclude<InteractionKind, "bookmark">,
    original: Post | undefined,
    patch: (post: Post) => Post,
    desired: boolean,
  ) => {
    const current = store.get(timelinePostsAtom).find((p) => p.ap_id === id);
    if (!current) return;
    if (current === original) {
      setTimelinePosts((old) => old.map((p) => (p === current ? patch(p) : p)));
      return;
    }
    // A changed row may contain a newer optimistic action still in flight.
    // Even a GET after this ACK could precede that newer action's commit.
    const matches =
      kind === "like"
        ? current.liked === desired
        : current.reposted === desired;
    if (!matches)
      pushToast(
        setToasts,
        language() === "ja"
          ? `操作は受け付けられました。表示が更新されているため、最新状態は元の投稿を開き直して確認してください。 (${id})`
          : `The action was accepted. This post changed; reopen the original post to check its latest state. (${id})`,
        { kind: "info", timeout: 0 },
      );
  };

  // Keep an unresolved action locked across an uncertain logout for the same
  // actor/instance. The original epoch is still checked before any update.
  const interactionKey = (kind: PendingInteractionKind, id: string) =>
    JSON.stringify([
      currentActor()?.ap_id ?? null,
      currentInstance(),
      currentHostedUser()?.id ?? null,
      kind,
      id,
    ]);
  const interactionReadTokens = new Map<string, symbol>();
  const beginInteraction = (kind: PendingInteractionKind, id: string) => {
    const key = interactionKey(kind, id);
    if (store.get(pendingInteractionsAtom).has(key)) return null;
    interactionReadTokens.delete(key);
    const token = Symbol();
    setPendingInteractions((pending) => new Map(pending).set(key, token));
    return { key, token };
  };
  const endInteraction = ({ key, token }: { key: string; token: symbol }) => {
    setPendingInteractions((pending) => {
      if (pending.get(key) !== token) return pending;
      const next = new Map(pending);
      next.delete(key);
      return next;
    });
  };

  // If the original page was replaced while a write was pending, ask the
  // currently mounted view to read the original target after the ACK. This
  // does not carry a response into another session or authorize a retry.
  const observeInteraction = (settlement: InteractionSettlement) => {
    if (!mounted || !settlement.sameScope()) return;
    const routeId = decodeApIdParam(params.postId);
    if (routeId !== settlement.targetId && routeId !== settlement.parentId)
      return;
    if (settlement.kind === "delete") {
      retryLoad();
      return;
    }
    const kind = settlement.kind;
    if (loading() || !post()) {
      retryLoad();
      return;
    }
    const isMain = post()?.ap_id === settlement.targetId;
    const isReply =
      post()?.ap_id === settlement.parentId &&
      replies().some((reply) => reply.ap_id === settlement.targetId);
    if (!isMain && !isReply) return;
    const generation = postLoadGen;
    const key = interactionKey(settlement.kind, settlement.targetId);
    const token = Symbol();
    interactionReadTokens.set(key, token);
    const refresh = Promise.resolve()
      .then(() =>
        settlement.sameScope() ? fetchPost(settlement.targetId) : null,
      )
      .then((fresh) => {
        if (
          !fresh ||
          !mounted ||
          !settlement.sameScope() ||
          postLoadGen !== generation ||
          interactionReadTokens.get(key) !== token ||
          fresh.ap_id !== settlement.targetId
        )
          return;
        const patch = (old: Post): Post =>
          replaceInteractionFields(old, fresh, kind);
        if (isMain) {
          setPost((old) =>
            old?.ap_id === settlement.targetId ? patch(old) : old,
          );
        } else {
          setReplies((old) =>
            old.map((reply) =>
              reply.ap_id === settlement.targetId ? patch(reply) : reply,
            ),
          );
        }
      })
      .catch((error) => {
        if (
          !mounted ||
          !settlement.sameScope() ||
          postLoadGen !== generation ||
          interactionReadTokens.get(key) !== token
        )
          return;
        console.error("Failed to refresh confirmed interaction:", error);
        reportInteractionRefreshFailure();
      });
    // A replaced page should not keep a request locked after it unmounts.
    return Promise.race([refresh, disposed]);
  };
  store.set(interactionObserversAtom, (old) =>
    new Set(old).add(observeInteraction),
  );
  onCleanup(() => {
    store.set(interactionObserversAtom, (old) => {
      const next = new Set(old);
      next.delete(observeInteraction);
      return next;
    });
  });
  const notifyInteraction = async (settlement: InteractionSettlement) => {
    const tasks: Promise<void>[] = [];
    for (const observe of store.get(interactionObserversAtom)) {
      try {
        const task = observe(settlement);
        if (task) tasks.push(task);
      } catch (error) {
        console.error("Failed to notify interaction observer:", error);
      }
    }
    await Promise.allSettled(tasks);
  };

  const reportInteractionError = (
    target: Post,
    action:
      | "posts.like"
      | "posts.unlike"
      | "posts.repost"
      | "posts.undoRepost"
      | "posts.bookmark"
      | "posts.removeBookmark"
      | "common.delete",
    failure: ReturnType<typeof classifyWriteFailure>,
  ) => {
    const username = target.author.username || target.author.preferred_username;
    const context = username ? ` @${username}` : "";
    const message =
      failure === "unconfirmed"
        ? language() === "ja"
          ? "結果を確認できません。すでに反映されている可能性があります。再操作する前に元の投稿を確認してください。"
          : "The result could not be confirmed. It may already have been applied. Check the original post before trying again."
        : t("common.error");
    pushToast(
      setToasts,
      `${t(action)}${context} (${target.ap_id}): ${message}`,
      { kind: "error", ...(failure === "unconfirmed" ? { timeout: 0 } : {}) },
    );
  };

  const handleRepost = async () => {
    const currentPost = post();
    if (!currentPost) return;
    if (
      store
        .get(pendingInteractionsAtom)
        .has(interactionKey("repost", currentPost.ap_id))
    )
      return;
    const sameScope = captureInteractionScope(
      `/api/posts/${encodeURIComponent(currentPost.ap_id)}/repost`,
    );
    if (!sameScope) {
      reportInteractionError(
        currentPost,
        currentPost.reposted ? "posts.undoRepost" : "posts.repost",
        "rejected",
      );
      return;
    }
    const generation = postLoadGen;
    const samePage = () =>
      mounted &&
      generation === postLoadGen &&
      post()?.ap_id === currentPost.ap_id;
    const reposted = !currentPost.reposted;
    const originalTimelinePost = store
      .get(timelinePostsAtom)
      .find((p) => p.ap_id === currentPost.ap_id);
    const patch = (p: Post): Post =>
      p.reposted === reposted
        ? p
        : {
            ...p,
            reposted,
            announce_count: Math.max(0, p.announce_count + (reposted ? 1 : -1)),
          };
    const attempt = beginInteraction("repost", currentPost.ap_id);
    if (!attempt) return;
    try {
      if (reposted) await repostPost(currentPost.ap_id);
      else await unrepostPost(currentPost.ap_id);
      if (!sameScope()) return;
      if (samePage()) setPost((prev) => (prev ? patch(prev) : prev));
      syncInteractionTimeline(
        currentPost.ap_id,
        "repost",
        originalTimelinePost,
        patch,
        reposted,
      );
      if (!samePage())
        await notifyInteraction({
          kind: "repost",
          targetId: currentPost.ap_id,
          parentId: currentPost.ap_id,
          sameScope,
        });
    } catch (e) {
      if (!sameScope()) return;
      console.error("Failed to toggle repost:", e);
      reportInteractionError(
        currentPost,
        reposted ? "posts.repost" : "posts.undoRepost",
        classifyWriteFailure(e),
      );
    } finally {
      endInteraction(attempt);
    }
  };

  const handleLike = async (targetPost: Post, isReply: boolean = false) => {
    if (
      store
        .get(pendingInteractionsAtom)
        .has(interactionKey("like", targetPost.ap_id))
    )
      return;
    const sameScope = captureInteractionScope(
      `/api/posts/${encodeURIComponent(targetPost.ap_id)}/like`,
    );
    if (!sameScope) {
      reportInteractionError(
        targetPost,
        targetPost.liked ? "posts.unlike" : "posts.like",
        "rejected",
      );
      return;
    }
    const generation = postLoadGen;
    const parentId = post()?.ap_id;
    const samePage = () =>
      mounted && generation === postLoadGen && post()?.ap_id === parentId;
    const liked = !targetPost.liked;
    const originalTimelinePost = store
      .get(timelinePostsAtom)
      .find((p) => p.ap_id === targetPost.ap_id);
    const patch = (p: Post): Post =>
      p.liked === liked
        ? p
        : {
            ...p,
            liked,
            like_count: Math.max(0, p.like_count + (liked ? 1 : -1)),
          };
    const attempt = beginInteraction("like", targetPost.ap_id);
    if (!attempt) return;
    try {
      if (liked) await likePost(targetPost.ap_id);
      else await unlikePost(targetPost.ap_id);
      if (!sameScope()) return;
      if (samePage()) {
        if (isReply) {
          setReplies((prev) =>
            prev.map((r) => (r.ap_id === targetPost.ap_id ? patch(r) : r)),
          );
        } else {
          setPost((prev) =>
            prev?.ap_id === targetPost.ap_id ? patch(prev) : prev,
          );
        }
      }
      syncInteractionTimeline(
        targetPost.ap_id,
        "like",
        originalTimelinePost,
        patch,
        liked,
      );
      if (!samePage() && parentId)
        await notifyInteraction({
          kind: "like",
          targetId: targetPost.ap_id,
          parentId,
          sameScope,
        });
    } catch (e) {
      if (!sameScope()) return;
      console.error("Failed to toggle like:", e);
      reportInteractionError(
        targetPost,
        liked ? "posts.like" : "posts.unlike",
        classifyWriteFailure(e),
      );
    } finally {
      endInteraction(attempt);
    }
  };

  const replyOverLimit = () => replyContent().length > MAX_REPLY_LENGTH;

  const handleReply = async () => {
    const target = post();
    const content = replyContent().trim();
    const actorApId = store.get(actorAtom)?.ap_id;
    if (
      !content ||
      !target ||
      !actorApId ||
      replyOverLimit() ||
      store.get(pendingRepliesAtom).has(target.ap_id) ||
      store.get(logoutBusyAtom)
    )
      return;
    const generation = postLoadGen;
    const draftRevision = replyDraftRevision;
    const olderTimelinePost = timelineBeforePostLoad;
    const sessionEpoch = store.get(authSessionEpochAtom);
    const instanceId = store.get(selectedInstanceIdAtom);
    const hostedUserId = store.get(hostedUserAtom)?.id ?? null;
    let strategy: ReturnType<typeof getAuthStrategy>;
    let transport: ReturnType<typeof getYurucommuApiTransport>;
    let postUrl: string;
    try {
      strategy = getAuthStrategy();
      transport = getYurucommuApiTransport();
      postUrl = transport.resolveUrl("/api/posts");
    } catch (e) {
      console.error("Failed to prepare reply:", e);
      setError(t("feedback.postFailed"));
      return;
    }
    const sameScope = () => {
      try {
        return (
          !store.get(logoutBusyAtom) &&
          store.get(actorAtom)?.ap_id === actorApId &&
          store.get(authSessionEpochAtom) === sessionEpoch &&
          store.get(selectedInstanceIdAtom) === instanceId &&
          (store.get(hostedUserAtom)?.id ?? null) === hostedUserId &&
          getAuthStrategy() === strategy &&
          getYurucommuApiTransport() === transport &&
          transport.resolveUrl("/api/posts") === postUrl
        );
      } catch {
        return false;
      }
    };
    const samePage = () =>
      mounted &&
      sameScope() &&
      generation === postLoadGen &&
      post()?.ap_id === target.ap_id;
    const attempt = Symbol();
    setPendingReplies((pending) => new Map(pending).set(target.ap_id, attempt));
    setError(null);
    try {
      const newReply = await createPost({
        content,
        in_reply_to: target.ap_id,
      });
      if (!sameScope()) return;
      if (!acknowledgesPost(newReply, actorApId, content)) {
        throw new Error(
          "Post response did not acknowledge the submitted reply",
        );
      }
      // A feed row retained from before the detail read is older. A replaced
      // row may already include this reply, so preserve a changed count.
      syncTimelinePost(target.ap_id, (p) => ({
        ...p,
        reply_count:
          p === olderTimelinePost
            ? target.reply_count + 1
            : p.reply_count === target.reply_count
              ? p.reply_count + 1
              : p.reply_count,
      }));
      if (!samePage()) {
        pushToast(setToasts, t("feedback.postCreated"), { kind: "success" });
        return;
      }
      if (!replies().some((reply) => reply.ap_id === newReply.ap_id)) {
        setReplies((prev) => [...prev, newReply]);
        setPost((prev) =>
          prev
            ? {
                ...prev,
                reply_count:
                  prev.reply_count === target.reply_count
                    ? prev.reply_count + 1
                    : prev.reply_count,
              }
            : null,
        );
      }
      if (replyDraftRevision === draftRevision) {
        setReplyContent("");
      } else {
        pushToast(setToasts, t("feedback.postDraftKept"), {
          kind: "info",
          timeout: 0,
        });
      }
    } catch (e) {
      if (!sameScope()) return;
      console.error("Failed to reply:", e);
      const failure = classifyWriteFailure(e);
      const message =
        failure === "unconfirmed"
          ? t("feedback.postUnconfirmed")
          : e instanceof ApiError && /too long/i.test(e.message)
            ? t("posts.tooLong").replace("{max}", String(MAX_REPLY_LENGTH))
            : t("feedback.postFailed");
      if (samePage()) {
        setError(message);
      } else {
        pushToast(setToasts, message, {
          kind: "error",
          ...(failure === "unconfirmed" ? { timeout: 0 } : {}),
        });
      }
    } finally {
      setPendingReplies((pending) => {
        if (pending.get(target.ap_id) !== attempt) return pending;
        const next = new Map(pending);
        next.delete(target.ap_id);
        return next;
      });
    }
  };

  const handleDelete = (targetPost: Post, isReply: boolean = false) => {
    const parent = post();
    if (
      !parent ||
      store
        .get(pendingInteractionsAtom)
        .has(interactionKey("delete", targetPost.ap_id))
    )
      return;
    const sameScope = captureInteractionScope(
      `/api/posts/${encodeURIComponent(targetPost.ap_id)}`,
    );
    if (!sameScope) {
      reportInteractionError(targetPost, "common.delete", "rejected");
      return;
    }
    setPendingDelete({
      post: targetPost,
      isReply,
      parentId: parent.ap_id,
      generation: postLoadGen,
      sameScope,
    });
  };

  // Edit your own post or reply. Mirrors the timeline edit path: PATCH the
  // content/CW and merge the server's confirmed fields into whichever of the
  // main post / replies matches by ap_id (no refetch). The same modal serves
  // both since a reply is just a Post.
  const [editingPost, setEditingPost] = createSignal<Post | null>(null);
  const [savingEdit, setSavingEdit] = createSignal(false);

  const handleSaveEdit = async (data: {
    content: string;
    summary: string | null;
  }) => {
    const target = editingPost();
    if (!target || savingEdit()) return;
    setSavingEdit(true);
    try {
      const updated = await editPost(target.ap_id, data);
      const merge = (p: Post) =>
        p.ap_id === target.ap_id
          ? { ...p, content: updated.content, summary: updated.summary }
          : p;
      setPost((prev) => (prev ? merge(prev) : prev));
      setReplies((prev) => prev.map(merge));
      setEditingPost(null);
      pushToast(setToasts, t("feedback.postEdited"), { kind: "success" });
    } catch (e) {
      console.error("Failed to edit post:", e);
      pushToast(setToasts, t("feedback.editFailed"), { kind: "error" });
    } finally {
      setSavingEdit(false);
    }
  };

  const confirmDelete = async () => {
    const pending = pendingDelete();
    if (!pending) return;
    setPendingDelete(null);
    const samePage = () =>
      mounted &&
      postLoadGen === pending.generation &&
      post()?.ap_id === pending.parentId;
    if (!samePage() || !pending.sameScope()) return;
    const attempt = beginInteraction("delete", pending.post.ap_id);
    if (!attempt) return;
    try {
      await deleteTimelinePost(pending.post.ap_id);
      if (!pending.sameScope()) return;
      if (!samePage()) {
        await notifyInteraction({
          kind: "delete",
          targetId: pending.post.ap_id,
          parentId: pending.parentId,
          sameScope: pending.sameScope,
        });
        if (pending.sameScope())
          pushToast(
            setToasts,
            `${t("feedback.postDeleted")} (${pending.post.ap_id})`,
            { kind: "success" },
          );
        return;
      }
      if (pending.isReply) {
        if (!replies().some((reply) => reply.ap_id === pending.post.ap_id)) {
          retryLoad();
          return;
        }
        setReplies((prev) =>
          prev.filter((r) => r.ap_id !== pending.post.ap_id),
        );
        const currentPost = post();
        if (currentPost) {
          setPost({
            ...currentPost,
            reply_count: Math.max(0, currentPost.reply_count - 1),
          });
        }
        pushToast(setToasts, t("feedback.postDeleted"), { kind: "success" });
      } else {
        // On a deep link / fresh tab there is no in-app history entry to go
        // back to — navigate(-1) would bounce out of the app (or nowhere).
        if (window.history.length > 1) {
          navigate(-1);
        } else {
          navigate("/", { replace: true });
        }
      }
    } catch (e) {
      if (!pending.sameScope()) return;
      console.error("Failed to delete:", e);
      reportInteractionError(
        pending.post,
        "common.delete",
        classifyWriteFailure(e),
      );
    } finally {
      endInteraction(attempt);
    }
  };

  const handleBookmark = async () => {
    const currentPost = post();
    const actorApId = store.get(actorAtom)?.ap_id;
    if (!currentPost || !actorApId) return;
    const bookmarked = !currentPost.bookmarked;
    const sameScope = captureInteractionScope(
      `/api/posts/${encodeURIComponent(currentPost.ap_id)}/bookmark`,
    );
    if (!sameScope) {
      reportInteractionError(
        currentPost,
        bookmarked ? "posts.bookmark" : "posts.removeBookmark",
        "rejected",
      );
      return;
    }
    const generation = postLoadGen;
    const samePage = () =>
      mounted &&
      generation === postLoadGen &&
      post()?.ap_id === currentPost.ap_id;
    const attempt = beginInteraction("bookmark", currentPost.ap_id);
    if (!attempt) return;
    try {
      if (bookmarked) await bookmarkPost(currentPost.ap_id);
      else await unbookmarkPost(currentPost.ap_id);
      if (!sameScope()) return;
      if (
        !acknowledgeBookmark({ actorApId, apId: currentPost.ap_id, bookmarked })
      )
        return;
      if (samePage()) {
        setPost((latest) =>
          latest?.ap_id === currentPost.ap_id
            ? { ...latest, bookmarked }
            : latest,
        );
      } else {
        await notifyInteraction({
          kind: "bookmark",
          targetId: currentPost.ap_id,
          parentId: currentPost.ap_id,
          sameScope,
        });
      }
    } catch (e) {
      if (!sameScope()) return;
      console.error("Failed to toggle bookmark:", e);
      reportInteractionError(
        currentPost,
        bookmarked ? "posts.bookmark" : "posts.removeBookmark",
        classifyWriteFailure(e),
      );
    } finally {
      endInteraction(attempt);
    }
  };

  return (
    <div class="flex flex-col h-full">
      <Show when={error()}>
        <InlineErrorBanner message={error()!} onClose={clearError} />
      </Show>
      <header class="sticky top-0 bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-900 z-10">
        <div class="flex items-center gap-4 px-4 py-3">
          <button
            onClick={() => navigate(-1)}
            aria-label={t("common.back")}
            class="p-1 hover:bg-neutral-800 rounded-full"
          >
            <BackIcon />
          </button>
          <h1 class="text-xl font-bold">{t("postDetail.title")}</h1>
        </div>
      </header>

      <Show when={loading()}>
        <div class="p-8 text-center text-neutral-500">
          {t("common.loading")}
        </div>
      </Show>

      {/* Retry view for unexpected load failures — "post not found" is
          reserved for the genuine 404 case below. */}
      <Show when={!loading() && !post() && loadFailed()}>
        <InlineErrorRetry
          message={t("common.loadFailed")}
          retryLabel={t("common.retry")}
          onRetry={retryLoad}
        />
      </Show>

      <Show when={!loading() && !post() && !loadFailed()}>
        <div class="p-8 text-center text-neutral-500">
          {t("posts.notFound")}
        </div>
      </Show>

      <Show when={!loading() && post()}>
        <div class="flex-1 overflow-y-auto">
          {/* Main Post */}
          <div class="px-4 py-4 border-b border-neutral-900">
            <div class="flex gap-3">
              <A href={`/profile/${encodeURIComponent(post()!.author.ap_id)}`}>
                <UserAvatar
                  avatarUrl={post()!.author.icon_url}
                  name={
                    post()!.author.name || post()!.author.preferred_username
                  }
                  size={48}
                />
              </A>
              <div class="flex-1 min-w-0">
                <A
                  href={`/profile/${encodeURIComponent(post()!.author.ap_id)}`}
                  class="font-bold text-white hover:underline break-all"
                >
                  {post()!.author.name || post()!.author.preferred_username}
                </A>
                <div class="text-neutral-500 break-all">
                  @{post()!.author.username}
                </div>
              </div>
              <Show when={post()!.author.ap_id === actor.ap_id}>
                <div class="flex items-center gap-1">
                  <button
                    onClick={() => setEditingPost(post()!)}
                    aria-label={t("posts.edit")}
                    class="p-2 text-neutral-500 hover:text-accent hover:bg-[var(--accent)]/10 rounded-full transition-colors"
                  >
                    <EditIcon />
                  </button>
                  <button
                    onClick={() => handleDelete(post()!)}
                    aria-label={t("common.delete")}
                    aria-disabled={pendingInteractions().has(
                      interactionKey("delete", post()!.ap_id),
                    )}
                    class="p-2 text-neutral-500 hover:text-red-500 hover:bg-red-500/10 rounded-full transition-colors aria-disabled:opacity-50 aria-disabled:cursor-wait"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </Show>
            </div>
            {/* Thread context: a reply carries its parent's ap_id, so opening a
                reply (e.g. from a notification) must not be an upward dead end. */}
            <Show when={post()!.in_reply_to}>
              <A
                href={`/post/${encodeURIComponent(post()!.in_reply_to!)}`}
                class="mt-2 inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
              >
                <ReplyIcon />
                {t("postDetail.viewParent")}
              </A>
            </Show>
            <PostContent
              content={post()!.content}
              summary={post()!.summary}
              class="text-lg text-neutral-100 mt-3"
            />
            {/* Post Images */}
            <Show when={post()!.attachments.length > 0}>
              <div
                class={`mt-3 grid gap-1 rounded-xl overflow-hidden ${
                  post()!.attachments.length === 1
                    ? "grid-cols-1"
                    : post()!.attachments.length === 2
                      ? "grid-cols-2"
                      : post()!.attachments.length === 3
                        ? "grid-cols-2"
                        : "grid-cols-2"
                }`}
              >
                <For each={post()!.attachments}>
                  {(m, idx) => (
                    <button
                      type="button"
                      aria-label={m.name || t("lightbox.zoomIn")}
                      onClick={(e) => {
                        e.stopPropagation();
                        lightbox.open(post()!.attachments, idx());
                      }}
                      class={`block w-full cursor-zoom-in ${
                        post()!.attachments.length === 1
                          ? "max-h-[500px]"
                          : post()!.attachments.length === 3 && idx() === 0
                            ? "row-span-2 h-full"
                            : "h-48"
                      }`}
                    >
                      <img
                        src={mediaAttachmentUrl(m)}
                        alt={m.name || ""}
                        class="w-full h-full object-cover pointer-events-none"
                      />
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="text-neutral-500 text-sm mt-3 flex items-center gap-2">
              <span>{formatDateTime(post()!.published, language())}</span>
              <PostVisibilityIndicator visibility={post()!.visibility} />
              <Show when={post()!.edited_at}>
                <span title={formatDateTime(post()!.edited_at!, language())}>
                  {"·"} {t("posts.edited")}
                </span>
              </Show>
            </div>
            <div class="flex items-center gap-6 mt-3 pt-3 border-t border-neutral-800">
              <div class="text-sm">
                <span class="font-bold text-white">{post()!.reply_count}</span>
                <span class="text-neutral-500 ml-1">
                  {t("postDetail.repliesLabel")}
                </span>
              </div>
              <Show when={post()!.author.ap_id === actor.ap_id}>
                <div class="text-sm">
                  <span class="font-bold text-white">{post()!.like_count}</span>
                  <span class="text-neutral-500 ml-1">
                    {t("posts.likesLabel")}
                  </span>
                </div>
              </Show>
            </div>
            <div class="flex items-center justify-around mt-3 pt-3 border-t border-neutral-800">
              <button
                onClick={() => {
                  replyInputRef?.focus();
                  replyInputRef?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  });
                }}
                aria-label={t("posts.reply")}
                class="flex items-center gap-2 p-2 text-neutral-500 hover:text-accent transition-colors"
              >
                <ReplyIcon />
              </button>
              <Show when={isRepostable(post()!)}>
                <button
                  onClick={handleRepost}
                  aria-label={
                    post()!.reposted ? t("posts.undoRepost") : t("posts.repost")
                  }
                  aria-pressed={post()!.reposted}
                  aria-disabled={pendingInteractions().has(
                    interactionKey("repost", post()!.ap_id),
                  )}
                  class={`flex items-center gap-2 p-2 transition-colors aria-disabled:opacity-50 aria-disabled:cursor-wait ${
                    post()!.reposted
                      ? "text-green-500"
                      : "text-neutral-500 hover:text-green-500"
                  }`}
                >
                  <RepostIcon filled={post()!.reposted} />
                </button>
              </Show>
              <button
                onClick={() => handleLike(post()!)}
                aria-label={post()!.liked ? t("posts.unlike") : t("posts.like")}
                aria-pressed={post()!.liked}
                aria-disabled={pendingInteractions().has(
                  interactionKey("like", post()!.ap_id),
                )}
                class={`flex items-center gap-2 p-2 transition-colors aria-disabled:opacity-50 aria-disabled:cursor-wait ${
                  post()!.liked
                    ? "text-pink-500"
                    : "text-neutral-500 hover:text-pink-500"
                }`}
              >
                <HeartIcon filled={post()!.liked || false} />
              </button>
              <button
                onClick={handleBookmark}
                aria-label={
                  post()!.bookmarked
                    ? t("posts.removeBookmark")
                    : t("posts.bookmark")
                }
                aria-pressed={post()!.bookmarked}
                aria-disabled={pendingInteractions().has(
                  interactionKey("bookmark", post()!.ap_id),
                )}
                class={`flex items-center gap-2 p-2 transition-colors aria-disabled:opacity-50 aria-disabled:cursor-wait ${
                  post()!.bookmarked
                    ? "text-accent"
                    : "text-neutral-500 hover:text-accent"
                }`}
              >
                <BookmarkIcon filled={post()!.bookmarked || false} />
              </button>
            </div>
          </div>

          {/* Reply Composer */}
          <div class="px-4 py-3 border-b border-neutral-900">
            <div class="flex gap-3">
              <UserAvatar
                avatarUrl={actor.icon_url}
                name={actor.name || actor.preferred_username}
                size={40}
              />
              <div class="flex-1">
                <textarea
                  ref={replyInputRef}
                  value={replyContent()}
                  onInput={(e) => {
                    replyDraftRevision++;
                    setReplyContent(e.currentTarget.value);
                  }}
                  placeholder={t("posts.replyPlaceholder")}
                  class="w-full bg-transparent text-white placeholder-neutral-500 resize-none outline-none"
                  rows={2}
                />
                <div class="flex items-center justify-end gap-3">
                  <Show when={replyContent().length > 0}>
                    <span
                      class={`text-xs tabular-nums ${
                        replyOverLimit() ? "text-red-500" : "text-neutral-500"
                      }`}
                    >
                      {t("posts.charCount")
                        .replace("{count}", String(replyContent().length))
                        .replace("{max}", String(MAX_REPLY_LENGTH))}
                    </span>
                  </Show>
                  <button
                    onClick={handleReply}
                    disabled={
                      !replyContent().trim() || replying() || replyOverLimit()
                    }
                    class="px-4 py-1.5 bg-accent disabled:bg-neutral-800 disabled:text-neutral-600 rounded-full text-sm font-bold transition-colors"
                  >
                    {t("posts.reply")}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Replies */}
          <For each={replies()}>
            {(reply) => (
              <div class="flex gap-3 px-4 py-3 border-b border-neutral-900 hover:bg-neutral-900/30 transition-colors">
                <A href={`/profile/${encodeURIComponent(reply.author.ap_id)}`}>
                  <UserAvatar
                    avatarUrl={reply.author.icon_url}
                    name={reply.author.name || reply.author.preferred_username}
                    size={40}
                  />
                </A>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <A
                      href={`/profile/${encodeURIComponent(
                        reply.author.ap_id,
                      )}`}
                      class="font-bold text-white truncate hover:underline"
                    >
                      {reply.author.name || reply.author.preferred_username}
                    </A>
                    <span class="text-neutral-500 truncate">
                      @{reply.author.username}
                    </span>
                    <span class="text-neutral-500">·</span>
                    <span class="text-neutral-500 text-sm">
                      {formatDateTime(reply.published, language())}
                    </span>
                    <PostVisibilityIndicator visibility={reply.visibility} />
                    <Show when={reply.edited_at}>
                      <span
                        class="text-neutral-500 text-sm"
                        title={formatDateTime(reply.edited_at!, language())}
                      >
                        {"·"} {t("posts.edited")}
                      </span>
                    </Show>
                    <Show when={reply.author.ap_id === actor.ap_id}>
                      <div class="ml-auto flex items-center gap-1">
                        <button
                          onClick={() => setEditingPost(reply)}
                          aria-label={t("posts.edit")}
                          class="p-1 text-neutral-500 hover:text-accent hover:bg-[var(--accent)]/10 rounded-full transition-colors"
                        >
                          <EditIcon />
                        </button>
                        <button
                          onClick={() => handleDelete(reply, true)}
                          aria-label={t("common.delete")}
                          aria-disabled={pendingInteractions().has(
                            interactionKey("delete", reply.ap_id),
                          )}
                          class="p-1 text-neutral-500 hover:text-red-500 hover:bg-red-500/10 rounded-full transition-colors aria-disabled:opacity-50 aria-disabled:cursor-wait"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </Show>
                  </div>
                  {/* The reply body links to the reply's OWN detail page — the
                      only surface where it can itself be replied to (threading
                      is one level per page). */}
                  <A
                    href={`/post/${encodeURIComponent(reply.ap_id)}`}
                    class="block"
                  >
                    <PostContent
                      content={reply.content}
                      summary={reply.summary}
                      class="text-[15px] text-neutral-200 mt-1"
                    />
                  </A>
                  <div class="flex items-center gap-6 mt-2">
                    <A
                      href={`/post/${encodeURIComponent(reply.ap_id)}`}
                      aria-label={
                        reply.reply_count
                          ? `${t("posts.reply")} ${reply.reply_count}`
                          : t("posts.reply")
                      }
                      class="flex items-center gap-2 text-neutral-500 hover:text-[var(--accent)] transition-colors"
                    >
                      <ReplyIcon />
                      <span class="text-sm">{reply.reply_count || ""}</span>
                    </A>
                    <button
                      onClick={() => handleLike(reply, true)}
                      aria-label={
                        reply.liked ? t("posts.unlike") : t("posts.like")
                      }
                      aria-pressed={reply.liked}
                      aria-disabled={pendingInteractions().has(
                        interactionKey("like", reply.ap_id),
                      )}
                      class={`flex items-center gap-2 transition-colors aria-disabled:opacity-50 aria-disabled:cursor-wait ${
                        reply.liked
                          ? "text-pink-500"
                          : "text-neutral-500 hover:text-pink-500"
                      }`}
                    >
                      <HeartIcon filled={reply.liked || false} />
                      <Show
                        when={
                          reply.author.ap_id === actor.ap_id &&
                          reply.like_count > 0
                        }
                      >
                        <span class="text-sm">{reply.like_count}</span>
                      </Show>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </For>

          <Show when={repliesHasMore()}>
            <div class="p-4 text-center">
              <button
                type="button"
                onClick={loadMoreReplies}
                disabled={loadingMoreReplies()}
                class="text-sm text-accent hover:underline disabled:opacity-50"
              >
                {loadingMoreReplies()
                  ? t("common.loading")
                  : t("common.loadMore")}
              </button>
            </div>
          </Show>

          {/* Replies failed but the post itself loaded: keep the post visible
              and offer a retry instead of silently claiming "no replies". */}
          <Show when={repliesFailed()}>
            <InlineErrorRetry
              message={t("common.loadFailed")}
              retryLabel={t("common.retry")}
              onRetry={retryLoad}
            />
          </Show>

          <Show when={replies().length === 0 && !repliesFailed()}>
            <div class="p-8 text-center text-neutral-500">
              {t("postDetail.noReplies")}
            </div>
          </Show>
        </div>
      </Show>
      <Show when={lightbox.isOpen()}>
        <MediaLightbox
          attachments={lightbox.attachments()}
          index={lightbox.index()}
          onClose={lightbox.close}
        />
      </Show>
      <ConfirmSheet
        open={pendingDelete() !== null}
        title={t("confirm.deletePostTitle")}
        body={t("confirm.deletePostBody")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {/* Edit modal — keyed so re-opening on a different post/reply re-mounts it
          and re-initialises its content/CW signals from that target. */}
      <Show when={editingPost()} keyed>
        {(target) => (
          <EditPostModal
            post={target}
            saving={savingEdit()}
            onClose={() => setEditingPost(null)}
            onSave={handleSaveEdit}
          />
        )}
      </Show>
    </div>
  );
}

export default PostDetailPage;
