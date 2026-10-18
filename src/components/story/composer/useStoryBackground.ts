import { createEffect } from "solid-js";
import type { BackgroundFill, StoryCanvas } from "../../../lib/story-canvas.ts";

interface StoryBackgroundOptions {
  storyCanvas: StoryCanvas | null;
  backgroundType: "solid" | "gradient";
  solidColor: string;
  gradientColors: string[];
  gradientAngle: number;
  /** A video is the background: the canvas stays transparent over it. */
  keepTransparent: boolean;
  onUpdate: () => void;
}

export function useStoryBackground(opts: StoryBackgroundOptions) {
  createEffect(() => {
    if (!opts.storyCanvas) return;
    // A colour here would be drawn over the video in the posted story (the
    // canvas is composited on top), hiding it.
    if (opts.keepTransparent) return;

    let fill: BackgroundFill;
    if (opts.backgroundType === "solid") {
      fill = { type: "solid", color: opts.solidColor };
    } else {
      fill = {
        type: "gradient",
        colors: opts.gradientColors,
        angle: opts.gradientAngle,
      };
    }

    opts.storyCanvas.setBackground(fill);
    opts.onUpdate();
  });
}
