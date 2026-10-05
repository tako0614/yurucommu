import { createEffect, createSignal, onCleanup } from "solid-js";
import type {
  BackgroundFill,
  BackgroundLayer,
  StoryCanvas,
} from "../../../lib/story-canvas.ts";
import {
  getVideoDuration,
  initFFmpeg,
  isVideoFile,
} from "../../../lib/ffmpeg.ts";
import { useI18n } from "../../../lib/i18n.tsx";

interface UseStoryVideoOptions {
  storyCanvas: StoryCanvas | null;
  setUploading: (value: boolean) => void;
  setError: (message: string) => void;
  maxVideoSize: number;
  onBackgroundChange: () => void;
  canEdit: () => boolean;
  canApply: () => boolean;
}

export function useStoryVideo(opts: UseStoryVideoOptions) {
  const { t } = useI18n();
  const [videoFile, setVideoFile] = createSignal<File | null>(null);
  const [videoPreview, setVideoPreview] = createSignal<string | null>(null);
  let videoPreviewRef: string | null = null;
  const [videoDuration, setVideoDuration] = createSignal<number>(5);
  const [savedBackground, setSavedBackground] =
    createSignal<BackgroundFill | null>(null);
  const [videoScale, setVideoScale] = createSignal(1);
  const [videoPosition, setVideoPosition] = createSignal({ x: 0, y: 0 });
  const [videoRotation, setVideoRotation] = createSignal(0);
  const [ffmpegReady, setFfmpegReady] = createSignal(false);
  const [ffmpegLoading, setFfmpegLoading] = createSignal(false);
  let videoInputRef!: HTMLInputElement;
  let videoRef!: HTMLVideoElement;
  let selecting = false;
  let mounted = true;
  let inspection: AbortController | null = null;

  // Keep ref in sync for cleanup on unmount
  createEffect(() => {
    videoPreviewRef = videoPreview();
  });

  // Cleanup video preview URL on unmount
  onCleanup(() => {
    mounted = false;
    inspection?.abort();
    if (videoPreviewRef) URL.revokeObjectURL(videoPreviewRef);
  });
  createEffect(() => {
    if (!opts.canApply()) inspection?.abort();
  });

  createEffect(() => {
    const file = videoFile();
    if (!file) return;
    if (ffmpegReady()) return;

    const loadFFmpeg = async () => {
      setFfmpegLoading(true);
      const current = () => mounted && opts.canApply() && videoFile() === file;
      try {
        await initFFmpeg();
        if (current()) setFfmpegReady(true);
      } catch (e) {
        if (!current()) return;
        console.error("Failed to load FFmpeg:", e);
        opts.setError(t("story.videoLoadFailed"));
        // FFmpeg can't load → the video can never be processed and the Post
        // button stays disabled, with no remove-video control to recover. Clear
        // the selection so the composer falls back to a usable image/text state
        // instead of trapping the user.
        clearVideo();
      } finally {
        if (mounted) setFfmpegLoading(false);
      }
    };
    loadFFmpeg();
  });

  const handleVideoSelect = async (
    e: Event & { currentTarget: HTMLInputElement },
  ) => {
    if (!mounted || selecting || !opts.canEdit()) return;
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    const canvas = opts.storyCanvas;
    if (!file || !canvas) return;

    if (!isVideoFile(file)) {
      opts.setError(t("story.selectVideoFile"));
      return;
    }

    if (file.size > opts.maxVideoSize) {
      opts.setError(
        t("story.videoTooLarge").replace(
          "{size}",
          String(opts.maxVideoSize / 1024 / 1024),
        ),
      );
      return;
    }

    selecting = true;
    const controller = new AbortController();
    inspection = controller;
    opts.setUploading(true);
    try {
      const duration = await getVideoDuration(file, controller.signal);
      if (
        !mounted ||
        controller.signal.aborted ||
        !opts.canApply() ||
        opts.storyCanvas !== canvas
      )
        return;
      const currentPreview = videoPreview();
      if (currentPreview) {
        URL.revokeObjectURL(currentPreview);
      }
      const preview = URL.createObjectURL(file);
      const bgLayer = canvas
        .getLayers()
        .find((layer) => layer.type === "background") as
        BackgroundLayer | undefined;
      if (bgLayer) {
        // Replacement previews share the original image/text background. A
        // later selection must not save the transparent video overlay instead.
        if (!savedBackground()) setSavedBackground(bgLayer.fill);
        canvas.setBackground({ type: "transparent" });
        opts.onBackgroundChange();
      }

      setVideoFile(file);
      setVideoPreview(preview);
      setVideoDuration(duration);
    } catch (err) {
      if (!mounted || controller.signal.aborted || !opts.canApply()) return;
      console.error("Failed to process video:", err);
      opts.setError(t("story.videoProcessFailed"));
    } finally {
      selecting = false;
      if (inspection === controller) inspection = null;
      if (mounted) {
        opts.setUploading(false);
        if (videoInputRef) videoInputRef.value = "";
      }
    }
  };

  const clearVideo = () => {
    const currentPreview = videoPreview();
    if (currentPreview) {
      URL.revokeObjectURL(currentPreview);
    }
    setVideoFile(null);
    setVideoPreview(null);
    setVideoScale(1);
    setVideoPosition({ x: 0, y: 0 });
    setVideoRotation(0);

    const bg = savedBackground();
    if (bg && opts.storyCanvas) {
      opts.storyCanvas.setBackground(bg);
      setSavedBackground(null);
      opts.onBackgroundChange();
    }
  };

  return {
    videoFile,
    videoPreview,
    videoDuration,
    get videoInputRef() {
      return videoInputRef;
    },
    set videoInputRef(el: HTMLInputElement) {
      videoInputRef = el;
    },
    get videoRef() {
      return videoRef;
    },
    set videoRef(el: HTMLVideoElement) {
      videoRef = el;
    },
    videoScale,
    setVideoScale,
    videoPosition,
    setVideoPosition,
    videoRotation,
    setVideoRotation,
    ffmpegReady,
    ffmpegLoading,
    handleVideoSelect,
    clearVideo,
  };
}
