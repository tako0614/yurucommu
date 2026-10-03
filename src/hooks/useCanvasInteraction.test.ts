import { expect, test } from "bun:test";
import { useCanvasInteraction } from "./useCanvasInteraction.ts";
import type { Layer, StoryCanvas } from "../lib/story-canvas.ts";

test("canvas loaded after mount stays editable, then submission fences late gestures", () => {
  let canvas: StoryCanvas | null = null;
  let editable = true;
  const updates: Partial<Layer>[] = [];
  const layer: Layer = {
    id: "photo",
    type: "media",
    src: "blob:fixture",
    originalWidth: 100,
    originalHeight: 100,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    zIndex: 1,
    visible: true,
    locked: false,
  };
  const hook = useCanvasInteraction({
    get canvas() {
      return canvas;
    },
    displayScale: 1,
    canEdit: () => editable,
    onUpdate: () => {},
  });
  canvas = {
    getLayer: () => layer,
    hitTest: () => layer,
    updateLayer: (_id: string, update: Partial<Layer>) => updates.push(update),
  } as unknown as StoryCanvas;
  const down = { clientX: 25, clientY: 30 } as MouseEvent;
  hook.handlePointerDown(down);
  expect(hook.state().selectedLayerId).toBe("photo");
  expect(hook.state().isDragging).toBe(true);
  expect(hook.getSelectedLayer()).toBe(layer);
  hook.handleWheel({ deltaY: -1, preventDefault() {} } as WheelEvent);
  expect(updates.length).toBe(1);

  editable = false;
  hook.finishInteraction();
  expect(hook.state().isDragging).toBe(false);
  hook.handlePointerDown(down);
  hook.handleWheel({ deltaY: -1, preventDefault() {} } as WheelEvent);
  expect(hook.state().isDragging).toBe(false);
  expect(updates.length).toBe(1);
  canvas = null;
  expect(hook.getSelectedLayer()).toBeNull();
});
