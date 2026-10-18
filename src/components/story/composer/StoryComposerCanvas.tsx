import { onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useI18n } from "../../../lib/i18n.tsx";

interface StoryComposerCanvasProps {
  // Callback refs: the parent owns these elements (for hit-testing, display
  // scale, and blitting the authoring canvas), so they must be wired back via a
  // setter — passing a bare `let` by value never assigns the parent's binding.
  canvasContainerRef: (el: HTMLDivElement) => void;
  displayCanvasRef: (el: HTMLCanvasElement) => void;
  displayDimensions: { width: number; height: number };
  videoPreview: string | null;
  onVideoRef: (element: HTMLVideoElement) => void;
  videoPosition: { x: number; y: number };
  videoScale: number;
  videoRotation: number;
  onCanvasPointerDown: (e: MouseEvent | TouchEvent) => void;
  onCanvasWheel: (e: WheelEvent) => void;
  /** With a video: whether a press here belongs to the canvas (drawing, or
   *  a placed layer under it) rather than to moving the video. */
  routeToCanvas: (e: PointerEvent) => boolean;
  /** With a video: whether the wheel resizes the selected layer. */
  wheelToCanvas: () => boolean;
  /** With a video: a press that moves the video clears the selection. */
  onVideoPress: () => void;
  onVideoPointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent>;
  onVideoPointerMove: JSX.EventHandler<HTMLDivElement, PointerEvent>;
  onVideoPointerUp: JSX.EventHandler<HTMLDivElement, PointerEvent>;
  onVideoWheel: JSX.EventHandler<HTMLDivElement, WheelEvent>;
  onVideoTouchStart: JSX.EventHandler<HTMLDivElement, TouchEvent>;
  onVideoTouchMove: JSX.EventHandler<HTMLDivElement, TouchEvent>;
  onVideoTouchEnd: JSX.EventHandler<HTMLDivElement, TouchEvent>;
}

export function StoryComposerCanvas(props: StoryComposerCanvasProps) {
  const { t } = useI18n();
  // With a video, the video's gesture layer is what a press lands on (the
  // canvas above it lets presses through), and it used to take every press:
  // placed text, photos and emoji could not be moved, and a drawing stroke
  // moved the video. A press is routed here, in the capture phase before the
  // video's handlers: the mouse or first finger decides, and a second finger
  // follows it (pinching the selected layer, or the video).
  let container: HTMLDivElement | undefined;
  let toCanvas = false;
  onMount(() => {
    const el = container;
    if (!el) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!props.videoPreview) return;
      if (e.isPrimary) toCanvas = props.routeToCanvas(e);
      if (toCanvas) e.stopPropagation();
    };
    const onPress = (e: MouseEvent | TouchEvent) => {
      if (!props.videoPreview || !toCanvas) return;
      e.stopPropagation();
      props.onCanvasPointerDown(e);
    };
    const onWheel = (e: WheelEvent) => {
      if (!props.videoPreview || !props.wheelToCanvas()) return;
      e.stopPropagation();
      props.onCanvasWheel(e);
    };
    el.addEventListener("pointerdown", onPointerDown, true);
    el.addEventListener("mousedown", onPress, true);
    el.addEventListener("touchstart", onPress, {
      capture: true,
      passive: false,
    });
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    onCleanup(() => {
      el.removeEventListener("pointerdown", onPointerDown, true);
      el.removeEventListener("mousedown", onPress, true);
      el.removeEventListener("touchstart", onPress, true);
      el.removeEventListener("wheel", onWheel, true);
    });
  });
  return (
    <div
      ref={(el) => {
        container = el;
        props.canvasContainerRef(el);
      }}
      class="absolute inset-0 flex items-center justify-center"
      // Event props are bound once, so the video case is decided per press:
      // a press the capture phase left to the video only clears the
      // selection (the canvas's own hit test would grab the drawing, whose
      // area is the whole canvas, and drag it along with the video).
      onMouseDown={(e) =>
        props.videoPreview ? props.onVideoPress() : props.onCanvasPointerDown(e)
      }
      onTouchStart={(e) =>
        props.videoPreview ? props.onVideoPress() : props.onCanvasPointerDown(e)
      }
      onWheel={(e) => {
        if (!props.videoPreview) props.onCanvasWheel(e);
      }}
    >
      <Show when={props.videoPreview}>
        {/* Under the canvas (DOM order, no z-index): the canvas draws the
            placed layers over the video, as the posted video has them, and
            the poll / note / link layer stays above both. With z-10 the
            video covered them all while editing. */}
        <div
          class="absolute inset-0 overflow-hidden touch-none"
          onPointerDown={props.onVideoPointerDown}
          onPointerMove={props.onVideoPointerMove}
          onPointerUp={props.onVideoPointerUp}
          onPointerCancel={props.onVideoPointerUp}
          onWheel={props.onVideoWheel}
          onTouchStart={props.onVideoTouchStart}
          onTouchMove={props.onVideoTouchMove}
          onTouchEnd={props.onVideoTouchEnd}
        >
          <video
            ref={(element) => props.onVideoRef(element)}
            src={props.videoPreview!}
            class="absolute w-full h-full object-cover origin-center"
            style={{
              transform: `translate(${props.videoPosition.x}px, ${props.videoPosition.y}px) scale(${props.videoScale}) rotate(${props.videoRotation}deg)`,
            }}
            autoplay
            loop
            muted
            playsinline
          />
          <Show
            when={
              props.videoScale === 1 &&
              props.videoPosition.x === 0 &&
              props.videoPosition.y === 0 &&
              props.videoRotation === 0
            }
          >
            <div class="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-black/70 rounded-full pointer-events-none">
              <span class="text-white/80 text-xs">
                {t("story.gestureHint")}
              </span>
            </div>
          </Show>
        </div>
      </Show>

      <canvas
        ref={props.displayCanvasRef}
        width={props.displayDimensions.width}
        height={props.displayDimensions.height}
        class={`w-full h-full object-contain ${
          props.videoPreview ? "absolute inset-0" : ""
        }`}
        style={
          props.videoPreview
            ? { "mix-blend-mode": "normal", "pointer-events": "none" }
            : undefined
        }
      />
    </div>
  );
}
