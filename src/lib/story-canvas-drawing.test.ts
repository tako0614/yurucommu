import { assertEquals } from "#test/assert";
import { test } from "bun:test";
import type { ImageFilter } from "./story-canvas.ts";
import { getFilterString } from "./story-canvas-drawing.ts";

const DEFAULT_FILTER: ImageFilter = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  blur: 0,
  sepia: 0,
  grayscale: 0,
  hueRotate: 0,
};

test("getFilterString returns none for the default filter", () => {
  assertEquals(getFilterString(DEFAULT_FILTER), "none");
});

test("getFilterString emits active filters in stable CSS order", () => {
  assertEquals(
    getFilterString({
      brightness: 125,
      contrast: 80,
      saturation: 140,
      blur: 2.5,
      sepia: 35,
      grayscale: 60,
      hueRotate: 270,
    }),
    "brightness(125%) contrast(80%) saturate(140%) blur(2.5px) sepia(35%) grayscale(60%) hue-rotate(270deg)",
  );
});

test("getFilterString omits default and inactive filter values", () => {
  assertEquals(
    getFilterString({
      ...DEFAULT_FILTER,
      contrast: 101,
      blur: -1,
      sepia: -1,
      grayscale: -1,
    }),
    "contrast(101%)",
  );
});
