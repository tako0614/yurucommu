import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import type { ActorStories, StoryAttachment } from "../../types/index.ts";
import {
  deleteStory,
  likeStory,
  markStoryViewed,
  sendUserDMMessage,
  shareStory,
  unlikeStory,
  voteOnStory,
} from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { useDialog } from "../../lib/useDialog.ts";
import { formatRelativeTime } from "../../lib/datetime.ts";
import { ErrorIcon } from "./viewer/StoryViewerIcons.tsx";
import { StoryViewerActionBar } from "./viewer/StoryViewerActionBar.tsx";
import { StoryViewerDeleteDialog } from "./viewer/StoryViewerDeleteDialog.tsx";
import { StoryViewerHeader } from "./viewer/StoryViewerHeader.tsx";
import { renderStoryOverlay } from "./viewer/StoryViewerOverlays.tsx";
import { StoryViewerProgress } from "./viewer/StoryViewerProgress.tsx";
import { StoryInsightsSheet } from "./viewer/StoryInsightsSheet.tsx";
import { parseStoryDuration } from "./viewer/storyViewerUtils.ts";

interface StoryViewerProps {
  actorStories: ActorStories[];
  initialActorIndex: number;
  initialStoryIndex?: number;
  currentUserApId?: string;
  onClose: () => void;
}

// How long a video may sit un-ready (never reaching loadedmetadata) before the
// watchdog advances past it, so a stalled/broken video can't freeze the viewer.
const VIDEO_STALL_TIMEOUT_MS = 8000;

function getStoryMediaUrl(attachment: StoryAttachment): string {
  return (
    attachment.url || `/media/${attachment.r2_key.replace(/^uploads\//, "")}`
  );
}

export function StoryViewer(props: StoryViewerProps) {
  const { t, language } = useI18n();
  const [localActorStories, setLocalActorStories] = createSignal(
    props.actorStories,
  );
  const [actorIndex, setActorIndex] = createSignal(props.initialActorIndex);
  const [storyIndex, setStoryIndex] = createSignal(
    props.initialStoryIndex ?? 0,
  );
  const [progress, setProgress] = createSignal(0);
  const [isPaused, setIsPaused] = createSignal(false);
  let isPausedRef = false;
  const [containerSize, setContainerSize] = createSignal({
    width: 0,
    height: 0,
  });
  // Bumped on every video progress event (canplay/timeupdate). The stall
  // watchdog depends on it so genuine-but-slow playback resets the timer
  // instead of being cut off.
  const [videoActivityTick, setVideoActivityTick] = createSignal(0);
  const [mediaError, setMediaError] = createSignal(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [showInsights, setShowInsights] = createSignal(false);
  const [isMuted, setIsMuted] = createSignal(true);
  const [toastMessage, setToastMessage] = createSignal<string | null>(null);
  let containerRef!: HTMLDivElement;
  let storyContainerRef!: HTMLDivElement;
  let videoRef: HTMLVideoElement | undefined;
  let timerRef: ReturnType<typeof setTimeout> | null = null;
  let progressTimerRef: ReturnType<typeof setInterval> | null = null;

  const currentActorStories = createMemo(
    () => localActorStories()[actorIndex()],
  );
  const currentStory = createMemo(
    () => currentActorStories()?.stories[storyIndex()],
  );
  const isOwnStory = createMemo(
    () =>
      props.currentUserApId != null &&
      currentActorStories()?.actor.ap_id === props.currentUserApId,
  );
  const isLiked = createMemo(() => !!currentStory()?.liked);

  // Shared modal-dialog primitive: focus moves into the viewer, Tab is trapped
  // inside it (previously it could reach the feed behind the aria-modal
  // dialog), Escape closes via the shared dialog stack (so the delete-confirm
  // dialog, which registers on top, receives Escape first), and background
  // scroll is ref-count locked — replacing the viewer's ad-hoc overflow toggle.
  useDialog({
    isOpen: () => true,
    onClose: () => {
      // Escape while typing a reply steps back to the story (blur the input),
      // it does NOT close the whole viewer and throw the draft away; a second
      // Escape then closes the viewer.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.tagName === "INPUT" &&
        containerRef?.contains(active)
      ) {
        active.blur();
        return;
      }
      props.onClose();
    },
    container: () => containerRef,
  });

  createEffect(() => {
    setLocalActorStories(props.actorStories);
  });

  createEffect(() => {
    const msg = toastMessage();
    if (!msg) return;
    const timeoutId = window.setTimeout(() => setToastMessage(null), 2000);
    onCleanup(() => window.clearTimeout(timeoutId));
  });

  // Update container size for overlay positioning
  createEffect(() => {
    // Track currentStory to re-run when story changes
    currentStory();
    const updateSize = () => {
      if (storyContainerRef) {
        const rect = storyContainerRef.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    onCleanup(() => window.removeEventListener("resize", updateSize));
  });

  // Mark story as viewed when displaying. Track the ap_ids we've already POSTed
  // a view for in a Set: a like / vote / share replaces the current story object
  // (new identity, `viewed` still false locally), which re-emits currentStory()
  // and would otherwise re-fire the view write for an already-viewed story. The
  // server is idempotent, but this avoids the wasted request; a failed write is
  // un-recorded so the next emit can retry.
  const viewedMarked = new Set<string>();
  createEffect(() => {
    const story = currentStory();
    if (story && !story.viewed && !viewedMarked.has(story.ap_id)) {
      viewedMarked.add(story.ap_id);
      markStoryViewed(story.ap_id).catch((e) => {
        viewedMarked.delete(story.ap_id);
        console.error(e);
      });
    }
  });

  // Reset media states when story changes
  createEffect(() => {
    // Track both indices
    actorIndex();
    storyIndex();
    setMediaError(false);
    setVideoActivityTick(0);
    setShowDeleteConfirm(false);
  });

  // Check if current story is a video
  const isVideo = createMemo(
    () => currentStory()?.attachment?.mediaType?.startsWith("video/") ?? false,
  );

  // Keep ref in sync with state for use in interval callback, and drive the
  // current video's playback from the pause state (hold-to-pause). Without this
  // a held video would keep playing and progress would keep advancing.
  createEffect(() => {
    const paused = isPaused();
    isPausedRef = paused;
    if (isVideo() && videoRef) {
      if (paused) {
        videoRef.pause();
      } else {
        videoRef.play().catch(() => setMediaError(true));
      }
    }
  });

  // Navigation functions
  const goNext = () => {
    const cas = currentActorStories();
    if (!cas?.stories) return;

    const currentStoriesLen = cas.stories.length;

    // Next story from same user
    if (storyIndex() < currentStoriesLen - 1) {
      setStoryIndex(storyIndex() + 1);
      return;
    }

    // Next user
    if (actorIndex() < localActorStories().length - 1) {
      setActorIndex(actorIndex() + 1);
      setStoryIndex(0);
      return;
    }

    // End of all stories
    props.onClose();
  };

  const goPrev = () => {
    // Previous story from same user
    if (storyIndex() > 0) {
      setStoryIndex(storyIndex() - 1);
      return;
    }

    // Previous user
    if (actorIndex() > 0) {
      setActorIndex(actorIndex() - 1);
      const prevActorStories = localActorStories()[actorIndex() - 1];
      const lastStoryIndex = prevActorStories.stories.length - 1;
      setStoryIndex(lastStoryIndex);
      return;
    }

    // At the beginning, restart current story
    setProgress(0);
  };

  // Auto-advance timer (for images only, videos use onEnded). Elapsed is
  // accumulated tick-by-tick and ONLY while not paused, so a hold-to-pause does
  // not lose progress and auto-advance is itself pause-aware. (Previously a fixed
  // setTimeout(duration) fired even while held, and the effect tracked isPaused
  // so every pause/release rebuilt the timer with a fresh startTime → progress
  // jumped back to 0.)
  const TICK_MS = 50;
  const startTimer = () => {
    const story = currentStory();
    if (!story || isVideo()) return;

    const duration = parseStoryDuration(story.displayDuration);

    if (timerRef) clearTimeout(timerRef);
    if (progressTimerRef) clearInterval(progressTimerRef);

    let elapsed = 0;
    progressTimerRef = setInterval(() => {
      if (isPausedRef) return;
      elapsed += TICK_MS;
      setProgress(Math.min((elapsed / duration) * 100, 100));
      if (elapsed >= duration) {
        if (progressTimerRef) clearInterval(progressTimerRef);
        goNext();
      }
    }, TICK_MS);
  };

  // Re-arm only when the story IDENTITY (ap_id) changes — NOT on pause toggle
  // (the interval's isPausedRef guard handles pausing without restarting
  // progress), and NOT when a like/vote/share replaces the story OBJECT (same
  // ap_id): startTimer() reads currentStory() internally, so a bare
  // createEffect tracked it and every like reset the progress bar to 0.
  // `on(...)` keys strictly on the ap_id and runs the body untracked. Deleting
  // a story still re-arms (the story sliding into the index has a new ap_id).
  createEffect(
    on(
      () => currentStory()?.ap_id,
      () => {
        if (!isVideo()) {
          setProgress(0);
          startTimer();
        }

        onCleanup(() => {
          if (timerRef) clearTimeout(timerRef);
          if (progressTimerRef) clearInterval(progressTimerRef);
        });
      },
    ),
  );

  // Video stall watchdog: a broken or stalled video never fires `onEnded`
  // (auto-advance relies on it) and the image timer bails on `isVideo()`, so
  // without this a frozen video would trap the viewer forever. If the media
  // errors, advance promptly; otherwise the timer is (re)armed on every
  // progress event (canplay/timeupdate via `videoActivityTick`), so a slow but
  // genuinely-progressing video keeps resetting it and is never cut off. This
  // also covers the "metadata ready but still paused / never progressing" case:
  // if no progress arrives within the timeout, advance.
  createEffect(() => {
    // Re-run when the story, error state, or video progress changes.
    actorIndex();
    storyIndex();
    const video = isVideo();
    const errored = mediaError();
    // Track progress so each event re-arms the timer below.
    videoActivityTick();

    if (!video) return;

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    if (errored) {
      // Show the error fallback briefly, then move on.
      stallTimer = setTimeout(goNext, 1500);
    } else if (!isPaused()) {
      // Only arm the watchdog while we expect playback to progress; a
      // user-held pause must not trip it.
      stallTimer = setTimeout(goNext, VIDEO_STALL_TIMEOUT_MS);
    }

    onCleanup(() => {
      if (stallTimer) clearTimeout(stallTimer);
    });
  });

  const handleVote = async (storyApId: string, optionIndex: number) => {
    try {
      const result = await voteOnStory(storyApId, optionIndex);
      setLocalActorStories((prev) =>
        prev.map((group) => ({
          ...group,
          stories: group.stories.map((story) => {
            if (story.ap_id !== storyApId) return story;
            return {
              ...story,
              votes: result.votes,
              votes_total: result.total,
              user_vote: result.user_vote,
            };
          }),
        })),
      );
    } catch (err) {
      console.error("Failed to vote on story:", err);
      setToastMessage(t("common.error"));
    }
  };

  // Guard against a double-tap firing two like/unlike requests off the same
  // stale `story.liked` baseline (the server is idempotent, but two requests
  // race a transient flicker).
  let likeInFlight = false;
  const handleLike = async () => {
    const story = currentStory();
    if (!story || likeInFlight) return;
    likeInFlight = true;
    try {
      const result = story.liked
        ? await unlikeStory(story.ap_id)
        : await likeStory(story.ap_id);
      setLocalActorStories((prev) =>
        prev.map((group) => ({
          ...group,
          stories: group.stories.map((s) =>
            s.ap_id === story.ap_id
              ? { ...s, liked: result.liked, like_count: result.like_count }
              : s,
          ),
        })),
      );
    } catch (err) {
      console.error("Failed to toggle story like:", err);
      setToastMessage(t("common.error"));
    } finally {
      likeInFlight = false;
    }
  };

  const handleShare = async () => {
    const story = currentStory();
    if (!story) return;
    const shareUrl = story.ap_id;
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${
            currentActorStories()?.actor?.name ||
            currentActorStories()?.actor?.preferred_username ||
            "Story"
          }`,
          url: shareUrl,
        });
        try {
          const result = await shareStory(story.ap_id);
          setLocalActorStories((prev) =>
            prev.map((group) => ({
              ...group,
              stories: group.stories.map((s) =>
                s.ap_id === story.ap_id
                  ? { ...s, share_count: result.share_count }
                  : s,
              ),
            })),
          );
        } catch (err) {
          console.error("Failed to record story share:", err);
          setToastMessage(t("story.shareRecordFailed"));
        }
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareUrl);
        setToastMessage(t("story.shareCopied"));
        try {
          const result = await shareStory(story.ap_id);
          setLocalActorStories((prev) =>
            prev.map((group) => ({
              ...group,
              stories: group.stories.map((s) =>
                s.ap_id === story.ap_id
                  ? { ...s, share_count: result.share_count }
                  : s,
              ),
            })),
          );
        } catch (err) {
          console.error("Failed to record story share:", err);
          setToastMessage(t("story.shareRecordFailed"));
        }
      } else {
        // No Web Share and no Clipboard API: surface a message rather than
        // leaving the Share button a silent dead no-op.
        setToastMessage(t("story.shareUnavailable"));
      }
    } catch (err) {
      // A user dismissing the native share sheet rejects with AbortError —
      // that's a cancel, not a failure, so don't show an error toast for it.
      if (err instanceof Error && err.name === "AbortError") return;
      console.error("Failed to share story:", err);
      setToastMessage(t("story.shareFailed"));
    }
  };

  // Reply target, captured when the reply input gains focus (and re-captured on
  // every focus). The DM must go to the author whose story the draft was typed
  // for — resolving the author only at submit time could mis-aim the message if
  // the viewer advanced to another actor mid-draft.
  let replyTargetApId: string | null = null;

  // Focusing the reply input pauses playback (like holding the story): without
  // this the auto-advance timer keeps running under the keyboard, the story
  // flips mid-typing, and the draft re-aims at the next actor.
  const handleReplyFocusChange = (focused: boolean) => {
    setIsPaused(focused);
    if (focused) {
      replyTargetApId = currentActorStories()?.actor.ap_id ?? null;
    }
  };

  // Send a reply to the story author as a direct message (Note). Returns true
  // on success so the action bar can clear its input.
  const handleReply = async (text: string): Promise<boolean> => {
    const authorApId = replyTargetApId ?? currentActorStories()?.actor.ap_id;
    if (!authorApId) return false;
    try {
      await sendUserDMMessage(authorApId, text);
      setToastMessage(t("story.replySent"));
      return true;
    } catch (err) {
      console.error("Failed to send story reply:", err);
      setToastMessage(t("story.replyFailed"));
      return false;
    }
  };

  // Handle video ended event
  const handleVideoEnded = () => {
    goNext();
  };

  // Handle video time update for progress bar
  const handleVideoTimeUpdate = (e: Event) => {
    const video = e.currentTarget as HTMLVideoElement;
    if (video.duration) {
      setProgress((video.currentTime / video.duration) * 100);
    }
    // Real playback progress: reset the stall watchdog.
    setVideoActivityTick((n) => n + 1);
  };

  // Handle video loaded metadata: the element has no `autoplay`, so kick off
  // playback explicitly (subject to the browser's autoplay policy — muted
  // playback is allowed). Failure surfaces the media-error fallback.
  const handleVideoLoadedMetadata = () => {
    setProgress(0);
    setVideoActivityTick((n) => n + 1);
    if (videoRef && !isPaused()) {
      videoRef.play().catch(() => setMediaError(true));
    }
  };

  // `canplay` also indicates the pipeline is alive; reset the watchdog and
  // ensure playback is running if it hasn't started yet.
  const handleVideoCanPlay = () => {
    setVideoActivityTick((n) => n + 1);
    if (videoRef && !isPaused() && videoRef.paused) {
      videoRef.play().catch(() => setMediaError(true));
    }
  };

  // Handle media error
  const handleMediaError = () => {
    setMediaError(true);
  };

  // Handle delete story
  const handleDeleteStory = () => {
    setShowDeleteConfirm(true);
  };

  // Confirm delete story
  const confirmDelete = async () => {
    const story = currentStory();
    if (!story) return;

    try {
      await deleteStory(story.ap_id);
      // Prune the deleted story from local state — otherwise it lingers in the
      // array: the progress-bar count is wrong, goPrev returns into the gone
      // story (404 on view/like), and emptying an actor's group can collapse the
      // viewer to a blank screen.
      const ai = actorIndex();
      const si = storyIndex();
      const groupSurvives = localActorStories()[ai].stories.length > 1;
      const groups = localActorStories()
        .map((g, i) =>
          i === ai
            ? { ...g, stories: g.stories.filter((_, j) => j !== si) }
            : g,
        )
        .filter((g) => g.stories.length > 0);

      if (groups.length === 0) {
        props.onClose();
        return;
      }
      setLocalActorStories(groups);
      if (groupSurvives) {
        // Same actor: the next story slid into this index (clamp to new last).
        setStoryIndex(Math.min(si, groups[ai].stories.length - 1));
      } else {
        // The actor's group was removed; move to the next available actor.
        setActorIndex(Math.min(ai, groups.length - 1));
        setStoryIndex(0);
      }
    } catch (e) {
      console.error("Failed to delete story:", e);
      setToastMessage(t("common.error"));
    } finally {
      setShowDeleteConfirm(false);
    }
  };

  // Handle click/tap navigation
  const handleClick = (e: MouseEvent) => {
    // Belt-and-braces with the controls' own stopPropagation: a tap that
    // lands on any interactive control (header buttons, action bar, insights
    // sheet) is never ALSO a tap-zone navigation.
    if ((e.target as HTMLElement).closest("button,a,input")) return;
    const rect = containerRef?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const width = rect.width;

    // Left third: go back, Right two-thirds: go forward
    if (x < width / 3) {
      goPrev();
    } else {
      goNext();
    }
  };

  // Handle keyboard navigation. Escape is owned by the shared dialog stack
  // (useDialog above; the delete-confirm dialog registers on top of it and
  // receives Escape first), so only the arrow/space navigation lives here.
  createEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // While the delete-confirmation prompt or the insights sheet is open it
      // owns the keyboard: navigation keys must not advance stories behind it.
      if (showDeleteConfirm() || showInsights()) return;
      // Keys aimed at a focused control belong to that control: typing in an
      // input moves the caret, and Space on a button activates the button —
      // neither may double as story navigation.
      const active = document.activeElement;
      const activeTag = active instanceof HTMLElement ? active.tagName : "";
      if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") {
        goPrev();
      } else if (e.key === "ArrowRight" || e.key === " ") {
        if (e.key === " ") {
          if (activeTag === "BUTTON") return;
          // Space must not also scroll the page behind the viewer.
          e.preventDefault();
        }
        goNext();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  // Pause on touch/hold. `holdActive` marks a pause that came from a press so
  // that only that pause is released on mouseup/touchend — pauses owned by the
  // insights sheet or the focused reply input must not be resumed by a stray
  // release. The release also listens on window: dragging off the card and
  // releasing OUTSIDE the container previously never resumed (the story froze).
  let holdActive = false;
  const handleTouchStart = () => {
    holdActive = true;
    setIsPaused(true);
  };
  const handleTouchEnd = () => {
    if (!holdActive) return;
    holdActive = false;
    setIsPaused(false);
  };
  window.addEventListener("mouseup", handleTouchEnd);
  onCleanup(() => window.removeEventListener("mouseup", handleTouchEnd));

  return (
    <Show when={currentActorStories() && currentStory()}>
      <div
        class="fixed inset-0 z-51 flex items-center justify-center bg-black"
        role="dialog"
        aria-modal="true"
        aria-label={t("story.viewerAriaLabel")}
      >
        {/* Stage = the 9:16 story card. All chrome (progress, header, action
            bar, insights) lives INSIDE this so on desktop it aligns to the card
            instead of spanning the whole window. Tap zones (containerRef) and
            overlay coords (storyContainerRef) are both measured from it. */}
        <div
          ref={containerRef}
          class="relative w-full h-full cursor-pointer overflow-hidden bg-neutral-900 sm:h-[calc(100vh-2rem)] sm:aspect-[9/16] sm:w-auto sm:max-h-[900px] sm:rounded-xl"
          onClick={handleClick}
          onMouseDown={handleTouchStart}
          onMouseUp={handleTouchEnd}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <StoryViewerProgress
            totalStories={currentActorStories()!.stories.length}
            storyIndex={storyIndex()}
            progress={progress()}
          />

          <StoryViewerHeader
            actor={currentActorStories()!.actor}
            timeLabel={formatRelativeTime(currentStory()!.published, {
              maxDays: 1,
              locale: language(),
            })}
            isVideo={isVideo()}
            isMuted={isMuted()}
            isOwnStory={Boolean(isOwnStory())}
            onToggleMute={() => setIsMuted(!isMuted())}
            onDelete={handleDeleteStory}
            onClose={props.onClose}
          />

          {/* Media / caption / overlays — measured box for overlay coords. */}
          <div ref={storyContainerRef} class="absolute inset-0">
            {/* Media content - directly from story.attachment */}
            <Show
              when={
                !mediaError() &&
                currentStory()!.attachment.mediaType.startsWith("image/")
              }
            >
              <img
                src={getStoryMediaUrl(currentStory()!.attachment)}
                alt=""
                class="w-full h-full object-cover"
                draggable={false}
                onError={handleMediaError}
              />
            </Show>
            <Show
              when={
                !mediaError() &&
                currentStory()!.attachment.mediaType.startsWith("video/")
              }
            >
              <video
                ref={videoRef}
                src={getStoryMediaUrl(currentStory()!.attachment)}
                class="w-full h-full object-cover"
                muted={isMuted()}
                playsinline
                onEnded={handleVideoEnded}
                onTimeUpdate={handleVideoTimeUpdate}
                onLoadedMetadata={handleVideoLoadedMetadata}
                onCanPlay={handleVideoCanPlay}
                onError={handleMediaError}
              />
            </Show>

            {/* Media error fallback */}
            <Show when={mediaError()}>
              <div class="absolute inset-0 flex items-center justify-center bg-neutral-900">
                <div class="text-center text-neutral-400">
                  <ErrorIcon />
                  <p class="mt-2">{t("story.mediaLoadFailed")}</p>
                </div>
              </div>
            </Show>

            {/* Caption (user-authored text shown over the story) */}
            <Show when={currentStory()!.caption}>
              <div class="absolute bottom-4 left-0 right-0 px-4 pointer-events-none">
                <p class="text-white text-sm leading-snug whitespace-pre-wrap drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
                  {currentStory()!.caption}
                </p>
              </div>
            </Show>

            {/* Overlays rendering */}
            <Show when={currentStory()!.overlays && containerSize().width > 0}>
              <div class="absolute inset-0 pointer-events-none">
                <div class="pointer-events-auto">
                  <For each={currentStory()!.overlays}>
                    {(overlay) => (
                      <div>
                        {renderStoryOverlay(
                          t,
                          overlay,
                          containerSize(),
                          currentStory()!.ap_id,
                          currentStory()!.votes,
                          currentStory()!.votes_total,
                          currentStory()!.user_vote,
                          handleVote,
                          isOwnStory(),
                        )}
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>

          <Show when={toastMessage()}>
            <div
              role="status"
              aria-live="polite"
              class="absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg"
            >
              {toastMessage()}
            </div>
          </Show>

          {/* Own-story insights entry (author-only "seen by"). Opening it pauses
            playback so the sheet isn't dismissed by auto-advance. */}
          <Show when={isOwnStory()}>
            <button
              type="button"
              class="absolute bottom-6 left-4 z-30 flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 text-sm text-white backdrop-blur-sm"
              onClick={(e) => {
                e.stopPropagation();
                setIsPaused(true);
                setShowInsights(true);
              }}
            >
              <svg
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              {t("story.insights.title")}
            </button>
          </Show>

          <StoryViewerActionBar
            isLiked={isLiked()}
            placeholder={t("story.replyPlaceholder")}
            sendLabel={t("dm.send")}
            onReply={isOwnStory() ? undefined : handleReply}
            onReplyFocusChange={handleReplyFocusChange}
            onLike={handleLike}
            onShare={handleShare}
          />

          <StoryInsightsSheet
            open={showInsights()}
            story={currentStory()!}
            locale={language()}
            onClose={() => {
              setShowInsights(false);
              setIsPaused(false);
            }}
          />
        </div>

        <StoryViewerDeleteDialog
          open={showDeleteConfirm()}
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={confirmDelete}
        />
      </div>
    </Show>
  );
}

export default StoryViewer;
