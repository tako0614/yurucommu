import type { StoryOverlay } from "../types/index.ts";
import type { VideoTransform } from "./ffmpeg.ts";

export interface StorySubmissionDraft {
  caption?: string;
  communityApId?: string;
  overlays: StoryOverlay[];
  text: string[];
  videoFile: File | null;
  videoScale: number;
  videoPosition: { x: number; y: number };
  videoRotation: number;
  displayScale: number;
}

/** Capture the whole metadata draft before export/upload can yield. */
export function captureStorySubmission(draft: StorySubmissionDraft) {
  const overlays = structuredClone(draft.overlays);
  const text = [...draft.text];
  let duration = 3 + text.length * 2;
  for (const content of text) duration += Math.ceil(content.length / 20);
  for (const overlay of overlays)
    duration += overlay.type === "Question" ? 4 : 2;
  const transform: VideoTransform = {
    scale: draft.videoScale,
    position: { ...draft.videoPosition },
    rotation: draft.videoRotation,
    displayScale: draft.displayScale,
  };
  return {
    caption: draft.caption?.trim() || undefined,
    communityApId: draft.communityApId,
    overlays,
    videoFile: draft.videoFile,
    transform,
    imageDuration: Math.max(3, Math.min(15, duration)),
  };
}

/** FFmpeg and image encoding must not read the live preview canvas later. */
export function copyStorySubmissionCanvas(source: HTMLCanvasElement) {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext("2d");
  if (!context) throw new Error("Failed to capture story canvas");
  context.drawImage(source, 0, 0);
  return copy;
}
