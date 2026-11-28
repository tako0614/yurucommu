import { expect, test } from "bun:test";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  type Layer,
  type StoryCanvas,
} from "../../../lib/story-canvas.ts";
import {
  computeMovedLayerPosition,
  computeResizedLayerBounds,
  computeRotatedLayerAngle,
  LAYER_MAX_WIDTH,
  LAYER_MIN_SIZE,
  useStoryLayerActions,
} from "./useStoryLayerActions.ts";

function makeTextLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: "text-1",
    type: "text",
    content: "Hello",
    fontFamily: "sans-serif",
    fontSize: 64,
    fontWeight: "bold",
    fontStyle: "normal",
    color: "#ffffff",
    backgroundPadding: 16,
    backgroundRadius: 12,
    textAlign: "center",
    lineHeight: 1.4,
    letterSpacing: 0,
    x: 440,
    y: 860,
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    zIndex: 1,
    visible: true,
    locked: false,
    ...overrides,
  } as Layer;
}

test("computeMovedLayerPosition nudges and clamps center inside canvas", () => {
  const layer = makeTextLayer();
  expect(computeMovedLayerPosition(layer, 24, -48)).toEqual({
    x: 464,
    y: 812,
  });

  // Pushing far past left/top clamps center to 0 (keeping half on-canvas)
  const clampedMin = computeMovedLayerPosition(layer, -5000, -5000);
  expect(clampedMin.x + layer.width / 2).toBe(0);
  expect(clampedMin.y + layer.height / 2).toBe(0);

  // Pushing far past right/bottom clamps center to canvas bounds
  const clampedMax = computeMovedLayerPosition(layer, 5000, 5000);
  expect(clampedMax.x + layer.width / 2).toBe(CANVAS_WIDTH);
  expect(clampedMax.y + layer.height / 2).toBe(CANVAS_HEIGHT);
});

test("computeResizedLayerBounds scales around center and respects min/max bounds", () => {
  const layer = makeTextLayer();
  const centerX = layer.x + layer.width / 2;
  const centerY = layer.y + layer.height / 2;

  const grown = computeResizedLayerBounds(layer, 1.5);
  expect(grown.width).toBeCloseTo(300, 5);
  expect(grown.height).toBeCloseTo(150, 5);
  expect(grown.x + grown.width / 2).toBeCloseTo(centerX, 5);
  expect(grown.y + grown.height / 2).toBeCloseTo(centerY, 5);

  const shrunk = computeResizedLayerBounds(layer, 0.01);
  expect(shrunk.height).toBeGreaterThanOrEqual(LAYER_MIN_SIZE);
  expect(shrunk.width).toBeGreaterThanOrEqual(LAYER_MIN_SIZE);

  const huge = computeResizedLayerBounds(layer, 100);
  expect(huge.width).toBeLessThanOrEqual(LAYER_MAX_WIDTH);
});

test("computeRotatedLayerAngle wraps into [0, 360)", () => {
  expect(computeRotatedLayerAngle(0, 15)).toBe(15);
  expect(computeRotatedLayerAngle(0, -15)).toBe(345);
  expect(computeRotatedLayerAngle(350, 20)).toBe(10);
});

test("useStoryLayerActions moves, resizes, rotates, and deletes target layers", () => {
  let layer = makeTextLayer();
  let updates = 0;
  let selectedId: string | null = layer.id;

  const canvas = {
    getLayer: (id: string) => (id === layer.id ? layer : undefined),
    updateLayer: (_id: string, patch: Partial<Layer>) => {
      layer = { ...layer, ...patch } as Layer;
    },
    removeLayer: () => {
      layer = { ...layer, id: "removed" } as Layer;
    },
    bringToFront: () => {},
    sendToBack: () => {},
  } as unknown as StoryCanvas;

  const actions = useStoryLayerActions({
    get storyCanvas() {
      return canvas;
    },
    get selectedLayerId() {
      return selectedId;
    },
    selectLayer: (id) => {
      selectedId = id;
    },
    onUpdate: () => {
      updates += 1;
    },
  });

  actions.handleMoveLayer(24, -24);
  expect(layer.x).toBe(464);
  expect(layer.y).toBe(836);

  actions.handleResizeLayer(1.2);
  expect(layer.width).toBeCloseTo(240, 5);
  expect(layer.height).toBeCloseTo(120, 5);

  actions.handleRotateLayer(-15);
  expect(layer.rotation).toBe(345);
  expect(updates).toBe(3);

  actions.handleDeleteLayer();
  expect(selectedId).toBeNull();
  expect(updates).toBe(4);
});
