import { createSignal, createEffect } from "solid-js";
import type { StoryCanvas, TextLayer } from "../../../lib/story-canvas.ts";
import type { StoryOverlay } from "../../../types/index.ts";
import { createStory } from "../../../lib/api.ts";
import { getApiTransport } from "../../../lib/plugin.ts";
import {
  createStoryIntentCoordinator,
  type StoryIntentSnapshot,
  type StoryIntentOutcome,
} from "../../../lib/story-intent.ts";
import { uploadProductMedia } from "../../../lib/media-upload.ts";
import { runAcknowledgedStoryEffects } from "../../../lib/story-ack-lifecycle.ts";
import { useI18n } from "../../../lib/i18n.tsx";
import {
  captureStorySubmission,
  copyStorySubmissionCanvas,
} from "../../../lib/story-submission.ts";
import { exportCanvasWithVideo, FFmpegError } from "../../../lib/ffmpeg.ts";

interface UseStoryPostOptions {
  actorApId: string;
  storyCanvas: StoryCanvas | null;
  videoFile: File | null;
  videoScale: number;
  videoPosition: { x: number; y: number };
  videoRotation: number;
  displayScale: number;
  ffmpegReady: boolean;
  busy: boolean;
  onStart: () => void;
  onResumeEditing: () => void;
  overlays: StoryOverlay[];
  // Optional caption/text the user typed in the composer footer. Persisted with
  // the story and rendered in the viewer.
  caption?: string;
  // Audience seam (B0.3): when the composer is opened inside a community scope,
  // the story is bound to that community (reach == community members). Personal
  // scope leaves this undefined so the story stays a personal (self + followed)
  // story. Mirrors the post composer's `community_ap_id`.
  communityApId?: string;
  setError: (message: string | null) => void;
  onSuccess: () => void | Promise<void>;
  onClose: () => void;
}

export function useStoryPost(opts: UseStoryPostOptions) {
  const { t } = useI18n();
  const [posting, setPosting] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const [hasMountedDraft, setHasMountedDraft] = createSignal(false);
  let rejectionMessage: string | null = null;
  const [identityChanged, setIdentityChanged] = createSignal(false);
  const [recovery, setRecovery] = createSignal<StoryIntentSnapshot>({
    record: null,
    failed: false,
  });
  let coordinator: ReturnType<typeof createStoryIntentCoordinator> | null =
    null;
  let identity = "";
  const currentIdentity = () => {
    const target = new URL(
      getApiTransport().resolveUrl("/api/stories"),
      window.location.href,
    );
    return `${target.href}\n${opts.actorApId}`;
  };
  // A mounted draft remains bound to its original backend and principal.
  // Reopening creates a new coordinator; a mid-upload switch cannot re-aim it.
  createEffect(() => {
    try {
      const next = currentIdentity();
      if (identity) {
        if (next !== identity) setIdentityChanged(true);
        return;
      }
      identity = next;
      const [endpoint, principal] = next.split("\n");
      coordinator = createStoryIntentCoordinator({
        origin: new URL(endpoint).origin,
        endpoint,
        principal,
      });
      setRecovery(coordinator.read());
    } catch {
      if (identity && coordinator) setIdentityChanged(true);
      else {
        coordinator = null;
        setRecovery({ record: null, failed: true });
      }
    }
  });
  const identityMatches = () => {
    try {
      if (!identityChanged() && currentIdentity() === identity) return true;
    } catch {
      /* Fail closed on an unavailable transport. */
    }
    setIdentityChanged(true);
    return false;
  };
  const editingLocked = () =>
    posting() || identityChanged() || recovery().failed || !!recovery().record;
  const applyOutcome = (result: StoryIntentOutcome) => {
    if (result.kind === "rejected")
      rejectionMessage =
        result.error instanceof Error ? result.error.message : null;
    if (result.kind === "confirmed" && !result.failed) {
      // A UI refresh/close failure cannot relabel an acknowledged server write.
      setRecovery({ record: result.record, failed: false });
      void runAcknowledgedStoryEffects(
        {
          onSuccess: () => opts.onSuccess(),
          onClose: () => opts.onClose(),
        },
        (phase, error) =>
          console.error(`Story ${phase} after acknowledgement failed:`, error),
      );
      return;
    }
    setRecovery({ record: result.record, failed: result.failed });
  };
  const retry = async () => {
    if (posting() || !coordinator || !identityMatches()) return;
    const saved = recovery();
    if (saved.record?.status === "confirmed") return;
    setPosting(true);
    setProgress(90);
    try {
      opts.onStart();
      if (saved.failed && saved.record?.status === "ready") {
        const staged = coordinator.stage(saved.record.payload);
        setRecovery(staged);
        if (staged.failed) return;
      }
      if (!identityMatches()) return;
      const result =
        coordinator.read().record?.status === "ready"
          ? await coordinator.submit(createStory)
          : await coordinator.retry(createStory);
      if (identityMatches()) applyOutcome(result);
      else setRecovery({ record: result.record, failed: result.failed });
    } catch (error) {
      console.error("Story recovery action failed:", error);
      setRecovery({ record: coordinator.read().record, failed: true });
    } finally {
      setPosting(false);
      setProgress(0);
    }
  };
  const discardRecovery = () => {
    if (posting() || !coordinator) return;
    const state = coordinator.dismiss();
    setRecovery(state);
    if (!state.failed && !state.record) opts.onClose();
  };
  const canResumeEditing = () =>
    hasMountedDraft() &&
    !identityChanged() &&
    !recovery().failed &&
    recovery().record?.status === "rejected";
  const resumeEditing = () => {
    if (posting() || !coordinator || !canResumeEditing() || !identityMatches())
      return;
    const state = coordinator.dismiss();
    setRecovery(state);
    if (!state.failed && !state.record) {
      opts.setError(rejectionMessage ?? t("story.createFailed"));
      opts.onResumeEditing();
    }
  };
  const keepRecoveryAndClose = () => {
    if (!posting()) opts.onClose();
  };

  const handlePost = async () => {
    const storyCanvas = opts.storyCanvas;
    if (
      !storyCanvas ||
      editingLocked() ||
      opts.busy ||
      !coordinator ||
      !identityMatches()
    )
      return;
    const attemptCoordinator = coordinator;
    // Video mode requires FFmpeg to be ready
    if (opts.videoFile && !opts.ffmpegReady) {
      opts.setError(t("story.videoNotReady"));
      return;
    }

    try {
      // Finish active gestures before taking one immutable submission draft.
      opts.onStart();
      setPosting(true);
      setProgress(0);
      opts.setError(null);
      const captured = captureStorySubmission({
        caption: opts.caption,
        communityApId: opts.communityApId,
        overlays: opts.overlays,
        text: (
          storyCanvas
            .getLayers()
            .filter((l) => l.type === "text") as TextLayer[]
        ).map((l) => l.content),
        videoFile: opts.videoFile,
        videoScale: opts.videoScale,
        videoPosition: opts.videoPosition,
        videoRotation: opts.videoRotation,
        displayScale: opts.displayScale,
      });
      setHasMountedDraft(true);
      // Render canvas first
      await storyCanvas.render();
      const canvas = copyStorySubmissionCanvas(storyCanvas.getCanvas());

      let blob: Blob;
      let contentType: string;
      let duration: number;

      if (captured.videoFile) {
        // Video mode: export canvas overlay on video through FFmpeg
        setProgress(10);
        const result = await exportCanvasWithVideo(
          canvas,
          captured.videoFile,
          (p) => setProgress(10 + p * 0.6), // 10-70%
          captured.transform,
        );
        blob = result.blob;
        contentType = "video/mp4";
        duration = result.duration;
      } else {
        // Image mode: direct Canvas.toBlob() (no FFmpeg needed, faster)
        setProgress(10);
        blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (b) => {
              if (b) resolve(b);
              else reject(new Error("Failed to export canvas"));
            },
            "image/jpeg",
            0.92, // Quality 92%
          );
        });
        contentType = "image/jpeg";
        duration = captured.imageDuration;
        setProgress(50);
      }

      // Upload to server
      setProgress(70);
      const filename = captured.videoFile ? "story.mp4" : "story.jpg";
      const file = new File([blob], filename, { type: contentType });
      if (!identityMatches()) return;
      const result = await uploadProductMedia(file);

      // Create story
      setProgress(90);
      const staged = attemptCoordinator.stage({
        attachment: {
          url: result.url,
          r2_key: result.r2_key,
          content_type: contentType,
        },
        displayDuration: `PT${Math.round(duration)}S`,
        caption: captured.caption,
        overlays: captured.overlays.length > 0 ? captured.overlays : undefined,
        // Bind to the inhabited community scope when present (else personal).
        community_ap_id: captured.communityApId,
      });

      setRecovery(staged);
      if (staged.failed || !identityMatches()) return;
      const outcome = await attemptCoordinator.submit(createStory);
      setProgress(outcome.kind === "confirmed" ? 100 : 0);
      if (identityMatches()) applyOutcome(outcome);
      else setRecovery({ record: outcome.record, failed: outcome.failed });
    } catch (err) {
      console.error("Failed to create story:", err);
      if (err instanceof FFmpegError) {
        opts.setError(
          t("story.videoProcessError").replace("{message}", err.message),
        );
      } else if (err instanceof Error) {
        opts.setError(
          t("story.genericError").replace("{message}", err.message),
        );
      } else {
        opts.setError(t("story.createFailed"));
      }
    } finally {
      setPosting(false);
      setProgress(0);
    }
  };

  return {
    posting,
    progress,
    handlePost,
    recovery,
    identityChanged,
    editingLocked,
    retry,
    discardRecovery,
    canResumeEditing,
    resumeEditing,
    keepRecoveryAndClose,
  };
}
