import { createSignal, createEffect, onCleanup } from "solid-js";
import { useAtomValue } from "solid-jotai";
import {
  actorAtom,
  authSessionEpochAtom,
  hostedUserAtom,
  logoutBusyAtom,
  selectedInstanceIdAtom,
} from "../../../atoms/auth.ts";
import type { StoryCanvas, TextLayer } from "../../../lib/story-canvas.ts";
import type { StoryOverlay } from "../../../types/index.ts";
import { createStory } from "../../../lib/api.ts";
import { maxImageFileSize, maxVideoFileSize } from "@takosjp/yurucommu-api";
import { getApiTransport, getAuthStrategy } from "../../../lib/plugin.ts";
import {
  canRenewStoryMedia,
  createStoryIntentCoordinator,
  storyMediaExpired,
  type StoryIntentRecord,
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
  const [hasRetainedFile, setHasRetainedFile] = createSignal(false);
  const [renewError, setRenewError] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const actor = useAtomValue(actorAtom);
  const authEpoch = useAtomValue(authSessionEpochAtom);
  const instanceId = useAtomValue(selectedInstanceIdAtom);
  const hostedUser = useAtomValue(hostedUserAtom);
  const logoutBusy = useAtomValue(logoutBusyAtom);
  let rejectionMessage: string | null = null;
  const [identityChanged, setIdentityChanged] = createSignal(false);
  const [recovery, setRecovery] = createSignal<StoryIntentSnapshot>({
    record: null,
    failed: false,
  });
  let coordinator: ReturnType<typeof createStoryIntentCoordinator> | null =
    null;
  let mounted = true;
  let retained: { intentId: string; file: File } | null = null;
  const releaseFile = () => {
    retained = null;
    setHasRetainedFile(false);
  };
  const currentScope = () => {
    const transport = getApiTransport();
    const uploadEndpoint = new URL(
      transport.resolveUrl("/api/media/upload"),
      window.location.href,
    ).href;
    const storyEndpoint = new URL(
      transport.resolveUrl("/api/stories"),
      window.location.href,
    ).href;
    return {
      actorApId: actor()?.ap_id ?? null,
      propActorApId: opts.actorApId,
      authEpoch: authEpoch(),
      instanceId: instanceId(),
      hostedUserId: hostedUser()?.id ?? null,
      logoutBusy: logoutBusy(),
      authStrategy: getAuthStrategy(),
      transport,
      uploadEndpoint,
      storyEndpoint,
    };
  };
  type MountScope = ReturnType<typeof currentScope>;
  let mountScope: MountScope | null = null;
  const sameScope = (next: MountScope, original: MountScope) =>
    !next.logoutBusy &&
    next.actorApId === original.actorApId &&
    next.propActorApId === original.propActorApId &&
    next.authEpoch === original.authEpoch &&
    next.instanceId === original.instanceId &&
    next.hostedUserId === original.hostedUserId &&
    next.authStrategy === original.authStrategy &&
    next.transport === original.transport &&
    next.uploadEndpoint === original.uploadEndpoint &&
    next.storyEndpoint === original.storyEndpoint;
  const retireIdentity = () => {
    releaseFile();
    setIdentityChanged(true);
  };
  // A mounted draft remains bound to its original backend and principal.
  // Reopening creates a new coordinator; a mid-upload switch cannot re-aim it.
  createEffect(() => {
    try {
      const next = currentScope();
      if (mountScope) {
        if (!sameScope(next, mountScope)) retireIdentity();
        return;
      }
      if (
        !next.actorApId ||
        next.actorApId !== next.propActorApId ||
        next.logoutBusy
      ) {
        retireIdentity();
        return;
      }
      mountScope = next;
      coordinator = createStoryIntentCoordinator({
        origin: new URL(next.storyEndpoint).origin,
        endpoint: next.storyEndpoint,
        principal: next.actorApId,
      });
      setRecovery(coordinator.read());
    } catch {
      if (mountScope) retireIdentity();
      else {
        coordinator = null;
        setRecovery({ record: null, failed: true });
      }
    }
  });
  const identityMatches = () => {
    try {
      if (
        mounted &&
        !identityChanged() &&
        mountScope &&
        sameScope(currentScope(), mountScope)
      )
        return true;
    } catch {
      /* Fail closed on an unavailable transport. */
    }
    if (mounted) retireIdentity();
    return false;
  };
  onCleanup(() => {
    mounted = false;
    releaseFile();
  });
  createEffect(() => {
    const deadline = recovery().record?.mediaExpiresAt;
    setNow(Date.now());
    if (!deadline) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      const remaining = Date.parse(deadline) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) return;
      timer = setTimeout(
        () => {
          if (cancelled) return;
          setNow(Date.now());
          schedule();
        },
        Math.min(remaining + 1, 2_147_483_647),
      );
    };
    schedule();
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
  });
  const expired = () => {
    const record = recovery().record;
    return !!record && storyMediaExpired(record, Math.max(now(), Date.now()));
  };
  const canRenew = () => {
    const saved = recovery();
    return (
      !posting() &&
      !identityChanged() &&
      !saved.failed &&
      !!saved.record &&
      canRenewStoryMedia(saved.record, Math.max(now(), Date.now()))
    );
  };
  const retainedFor = (record: StoryIntentRecord) =>
    retained?.intentId === record.intentId ? retained.file : null;
  const sameRecord = (expected: StoryIntentRecord, allowFailed = false) => {
    if (!coordinator) return false;
    const current = coordinator.read();
    return (
      (allowFailed || !current.failed) &&
      JSON.stringify(current.record) === JSON.stringify(expected)
    );
  };
  const scopedCreate: typeof createStory = (payload) => {
    if (!identityMatches())
      return Promise.reject(new Error("Story scope changed"));
    return createStory(payload);
  };
  const editingLocked = () =>
    posting() || identityChanged() || recovery().failed || !!recovery().record;
  const applyOutcome = (result: StoryIntentOutcome) => {
    if (result.kind === "rejected")
      rejectionMessage =
        result.error instanceof Error ? result.error.message : null;
    if (result.kind === "confirmed") releaseFile();
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
    if (
      saved.record?.status === "confirmed" ||
      (saved.record && storyMediaExpired(saved.record, Date.now()))
    )
      return;
    const attemptCoordinator = coordinator;
    const expected = saved.record;
    if (!expected || !sameRecord(expected, saved.failed)) return;
    setPosting(true);
    setProgress(90);
    try {
      opts.onStart();
      if (saved.failed && expected.status === "ready") {
        const staged = attemptCoordinator.stage(
          expected.payload,
          expected.mediaExpiresAt,
        );
        setRecovery(staged);
        if (staged.failed) return;
      }
      if (
        !identityMatches() ||
        coordinator !== attemptCoordinator ||
        storyMediaExpired(attemptCoordinator.read().record, Date.now())
      )
        return;
      const result =
        attemptCoordinator.read().record?.status === "ready"
          ? await attemptCoordinator.submit(scopedCreate)
          : await attemptCoordinator.retry(scopedCreate);
      if (identityMatches() && coordinator === attemptCoordinator)
        applyOutcome(result);
    } catch (error) {
      console.error("Story recovery action failed:", error);
      if (identityMatches() && coordinator === attemptCoordinator)
        setRecovery({ record: attemptCoordinator.read().record, failed: true });
    } finally {
      setPosting(false);
      setProgress(0);
    }
  };
  const renewMedia = async (replacement?: File) => {
    if (!canRenew() || !coordinator || !identityMatches()) return;
    const attemptCoordinator = coordinator;
    const expected = recovery().record;
    if (!expected || !sameRecord(expected)) return;
    const file = replacement ?? retainedFor(expected);
    if (!file) {
      setRenewError(t("story.recoverySelectReplacement"));
      return;
    }
    if (
      !["image/jpeg", "video/mp4"].includes(file.type) ||
      file.size === 0 ||
      file.size >
        (file.type === "video/mp4" ? maxVideoFileSize : maxImageFileSize)
    ) {
      setRenewError(t("story.recoveryInvalidReplacement"));
      return;
    }
    setRenewError(null);
    // Keep the complete replacement for another explicit attempt if upload fails.
    retained = { intentId: expected.intentId, file };
    setHasRetainedFile(true);
    setPosting(true);
    setProgress(70);
    try {
      const uploaded = await uploadProductMedia(file, identityMatches);
      if (!identityMatches() || coordinator !== attemptCoordinator) return;
      if (!sameRecord(expected)) {
        setRecovery(attemptCoordinator.read());
        setRenewError(t("story.recoveryRenewConflict"));
        return;
      }
      const next = attemptCoordinator.replaceExpiredAttachment(
        expected,
        {
          url: uploaded.url,
          r2_key: uploaded.r2_key,
          content_type: file.type,
        },
        uploaded.expires_at,
      );
      setRecovery(next);
      if (
        next.failed ||
        !next.record ||
        next.record.intentId === expected.intentId
      ) {
        setRenewError(t("story.recoveryRenewConflict"));
        return;
      }
      retained = { intentId: next.record.intentId, file };
      setHasRetainedFile(true);
    } catch (error) {
      if (identityMatches()) {
        setRenewError(
          t("story.recoveryRenewFailed").replace(
            "{message}",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    } finally {
      if (mounted) {
        setPosting(false);
        setProgress(0);
      }
    }
  };
  const discardRecovery = () => {
    if (posting() || !coordinator) return;
    const state = coordinator.dismiss();
    setRecovery(state);
    if (!state.failed && !state.record) {
      releaseFile();
      opts.onClose();
    }
  };
  const canResumeEditing = () =>
    hasMountedDraft() &&
    !identityChanged() &&
    !recovery().failed &&
    recovery().record?.status === "rejected" &&
    recovery().record?.writeHistory === "no-unknown";
  const resumeEditing = () => {
    if (posting() || !coordinator || !canResumeEditing() || !identityMatches())
      return;
    const state = coordinator.dismiss();
    setRecovery(state);
    if (!state.failed && !state.record) {
      releaseFile();
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
      if (!identityMatches() || coordinator !== attemptCoordinator) return;
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
      if (!identityMatches() || coordinator !== attemptCoordinator) return;

      // Upload to server
      setProgress(70);
      const filename = captured.videoFile ? "story.mp4" : "story.jpg";
      const file = new File([blob], filename, { type: contentType });
      if (!identityMatches() || coordinator !== attemptCoordinator) return;
      const result = await uploadProductMedia(file, identityMatches);
      if (!identityMatches() || coordinator !== attemptCoordinator) return;

      // Create story
      setProgress(90);
      const staged = attemptCoordinator.stage(
        {
          attachment: {
            url: result.url,
            r2_key: result.r2_key,
            content_type: contentType,
          },
          displayDuration: `PT${Math.round(duration)}S`,
          caption: captured.caption,
          overlays:
            captured.overlays.length > 0 ? captured.overlays : undefined,
          // Bind to the inhabited community scope when present (else personal).
          community_ap_id: captured.communityApId,
        },
        result.expires_at,
      );

      setRecovery(staged);
      if (staged.record) {
        retained = { intentId: staged.record.intentId, file };
        setHasRetainedFile(true);
      }
      if (
        staged.failed ||
        !identityMatches() ||
        coordinator !== attemptCoordinator
      )
        return;
      const outcome = await attemptCoordinator.submit(scopedCreate);
      setProgress(outcome.kind === "confirmed" ? 100 : 0);
      if (identityMatches() && coordinator === attemptCoordinator)
        applyOutcome(outcome);
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
    expired,
    canRenew,
    hasRetainedFile,
    renewError,
    renewMedia,
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
