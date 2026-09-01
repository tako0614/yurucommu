import { assert, assertAlmostEquals, assertEquals } from "#test/assert";
import { test } from "bun:test";
import type { Layer } from "./story-canvas.ts";
import {
  getLayerCorners,
  hitTest,
  isPointInLayer,
} from "./story-canvas-transforms.ts";

function mediaLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: "layer",
    type: "media",
    x: 100,
    y: 100,
    width: 100,
    height: 50,
    rotation: 90,
    opacity: 1,
    zIndex: 1,
    visible: true,
    locked: false,
    src: "image.png",
    originalWidth: 100,
    originalHeight: 50,
    ...overrides,
  } as Layer;
}

test("isPointInLayer accounts for layer rotation", () => {
  const layer = mediaLayer();

  assert(isPointInLayer(150, 170, layer));
  assertEquals(isPointInLayer(195, 125, layer), false);
});

test("hitTest uses rotated layer bounds and zIndex order", () => {
  const lower = mediaLayer({ id: "lower", zIndex: 1 });
  const upper = mediaLayer({ id: "upper", zIndex: 2 });

  assertEquals(hitTest([lower, upper], 150, 170)?.id, "upper");
  assertEquals(hitTest([lower, upper], 195, 125), null);
});

test("hitTest keeps the first intersecting layer for equal zIndex", () => {
  const first = mediaLayer({ id: "first", zIndex: 3 });
  const second = mediaLayer({ id: "second", zIndex: 3 });

  assertEquals(hitTest([first, second], 150, 170)?.id, "first");
});

test("hitTest excludes invisible, locked, and background layers", () => {
  const invisible = mediaLayer({
    id: "invisible",
    zIndex: 4,
    visible: false,
  });
  const locked = mediaLayer({ id: "locked", zIndex: 5, locked: true });
  const background = mediaLayer({
    id: "background",
    type: "background",
    zIndex: 6,
  });
  const eligible = mediaLayer({ id: "eligible", zIndex: 1 });

  assertEquals(
    hitTest([invisible, locked, background, eligible], 150, 170)?.id,
    "eligible",
  );
});

test("hitTest reads each eligible zIndex once without sorting", () => {
  const layerCount = 1_024;
  let zIndexReads = 0;
  const layers = Array.from({ length: layerCount }, (_, index) => {
    const layer = mediaLayer({ id: `layer-${index}`, zIndex: index });
    Object.defineProperty(layer, "zIndex", {
      configurable: true,
      enumerable: true,
      get() {
        zIndexReads += 1;
        return index;
      },
    });
    return layer;
  });

  assertEquals(hitTest(layers, 150, 170)?.id, `layer-${layerCount - 1}`);
  assertEquals(zIndexReads, layerCount);
});

test("getLayerCorners returns rotated canvas-space corners", () => {
  const corners = getLayerCorners(mediaLayer());
  const expected = [
    { x: 175, y: 75 },
    { x: 175, y: 175 },
    { x: 125, y: 175 },
    { x: 125, y: 75 },
  ];

  corners.forEach((corner, index) => {
    assertAlmostEquals(corner.x, expected[index].x);
    assertAlmostEquals(corner.y, expected[index].y);
  });
});
