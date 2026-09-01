import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "#test/assert";
import { test } from "bun:test";
import {
  StoryCanvas,
  type BackgroundLayer,
  type Layer,
} from "./story-canvas.ts";

function createCanvasHarness() {
  const fillOrder: string[] = [];
  const context = {
    fillStyle: "",
    clearRect: () => {},
    fillRect: () => {
      fillOrder.push(String(context.fillStyle));
    },
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    getContext: () => context,
  } as unknown as HTMLCanvasElement;

  return { canvas, fillOrder };
}

function backgroundLayer(color: string, id?: string) {
  return {
    id,
    type: "background" as const,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: { type: "solid" as const, color },
  };
}

function asBackground(layer: Layer): BackgroundLayer {
  if (layer.type !== "background") {
    throw new Error(`Expected background layer, got ${layer.type}`);
  }
  return layer;
}

async function withSortSpy(
  run: (getSortCalls: () => number) => Promise<void>,
): Promise<void> {
  const originalSort = Array.prototype.sort;
  let sortCalls = 0;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "sort");
  Object.defineProperty(Array.prototype, "sort", {
    ...descriptor,
    value(this: unknown[], compareFn?: (a: unknown, b: unknown) => number) {
      sortCalls += 1;
      return originalSort.call(this, compareFn);
    },
  });

  try {
    await run(() => sortCalls);
  } finally {
    Object.defineProperty(Array.prototype, "sort", descriptor!);
  }
}

test("sorts on first render and reuses unchanged render order", async () => {
  const harness = createCanvasHarness();
  const story = new StoryCanvas(harness.canvas);
  const first = story.addLayer(backgroundLayer("#first", "first"));
  const second = story.addLayer(backgroundLayer("#second", "second"));
  first.zIndex = 2;
  second.zIndex = 1;

  await withSortSpy(async (getSortCalls) => {
    await story.render();
    assertEquals(getSortCalls(), 1);
    assertEquals(harness.fillOrder, ["#000000", "#second", "#first"]);
    harness.fillOrder.length = 0;
    await story.render();
    assertEquals(getSortCalls(), 1);
    assertEquals(harness.fillOrder, ["#000000", "#second", "#first"]);

    const third = story.addLayer(backgroundLayer("#third", "third"));
    assertEquals(third.zIndex, 3);
    harness.fillOrder.length = 0;
    await story.render();
    assertEquals(getSortCalls(), 2);
    assertEquals(harness.fillOrder, ["#000000", "#second", "#first", "#third"]);

    harness.fillOrder.length = 0;
    await story.render();
    assertEquals(getSortCalls(), 2);
    assertEquals(harness.fillOrder, ["#000000", "#second", "#first", "#third"]);
  });
});

test("setBackground is visible without sorting again", async () => {
  const harness = createCanvasHarness();
  const story = new StoryCanvas(harness.canvas);

  await withSortSpy(async (getSortCalls) => {
    await story.render();
    assertEquals(getSortCalls(), 1);
    harness.fillOrder.length = 0;

    story.setBackground({ type: "solid", color: "#updated" });
    await story.render();

    assertEquals(getSortCalls(), 1);
    assertEquals(harness.fillOrder, ["#updated"]);
  });
});

test("direct z-index mutation through exposed refs re-sorts", async () => {
  const harness = createCanvasHarness();
  const story = new StoryCanvas(harness.canvas);
  const first = story.addLayer(backgroundLayer("#first", "first"));
  const second = story.addLayer(backgroundLayer("#second", "second"));
  first.zIndex = 1;
  second.zIndex = 2;

  await withSortSpy(async (getSortCalls) => {
    await story.render();
    assertEquals(getSortCalls(), 1);
    harness.fillOrder.length = 0;

    const exposedFirst = story
      .getLayers()
      .find((layer) => layer.id === "first")!;
    exposedFirst.zIndex = 3;
    await story.render();

    assertEquals(getSortCalls(), 2);
    assertEquals(harness.fillOrder, ["#000000", "#second", "#first"]);
    harness.fillOrder.length = 0;

    first.zIndex = 0;
    await story.render();

    assertEquals(getSortCalls(), 3);
    assertEquals(harness.fillOrder, ["#000000", "#first", "#second"]);
  });
});

test("equal z-index layers retain canonical stable order after mutation", async () => {
  const harness = createCanvasHarness();
  const story = new StoryCanvas(harness.canvas);
  const first = story.addLayer(backgroundLayer("#first", "first"));
  const second = story.addLayer(backgroundLayer("#second", "second"));
  first.zIndex = 2;
  second.zIndex = 1;

  await withSortSpy(async (getSortCalls) => {
    await story.render();
    assertEquals(harness.fillOrder, ["#000000", "#second", "#first"]);
    harness.fillOrder.length = 0;

    story.getLayer("first")!.zIndex = 1;
    await story.render();

    assertEquals(getSortCalls(), 2);
    assertEquals(harness.fillOrder, ["#000000", "#first", "#second"]);
  });
});

test("updateLayer invalidates the cache and replaces the layer ref", async () => {
  const harness = createCanvasHarness();
  const story = new StoryCanvas(harness.canvas);
  const original = story.addLayer(backgroundLayer("#original", "layer"));

  await withSortSpy(async (getSortCalls) => {
    await story.render();
    assertEquals(getSortCalls(), 1);
    harness.fillOrder.length = 0;

    story.updateLayer("layer", {
      fill: { type: "solid", color: "#updated" },
    });
    const replacement = story.getLayer("layer");
    assertNotStrictEquals(replacement, original);
    await story.render();

    assertEquals(getSortCalls(), 2);
    assertEquals(harness.fillOrder, ["#000000", "#updated"]);
  });
});

test("duplicate IDs use the first layer for get/update and remove all", async () => {
  const harness = createCanvasHarness();
  const story = new StoryCanvas(harness.canvas);
  const first = story.addLayer(backgroundLayer("#first", "duplicate"));
  const second = story.addLayer(backgroundLayer("#second", "duplicate"));

  assertStrictEquals(story.getLayer("duplicate"), first);

  await withSortSpy(async (getSortCalls) => {
    await story.render();
    assertEquals(getSortCalls(), 1);
    harness.fillOrder.length = 0;

    story.updateLayer("duplicate", {
      fill: { type: "solid", color: "#updated" },
    });
    const updated = story.getLayer("duplicate");
    assertNotStrictEquals(updated, first);
    assertEquals(asBackground(updated!).fill, {
      type: "solid",
      color: "#updated",
    });
    assertEquals(asBackground(second).fill, {
      type: "solid",
      color: "#second",
    });

    await story.render();
    assertEquals(getSortCalls(), 2);
    harness.fillOrder.length = 0;

    story.removeLayer("duplicate");
    assertEquals(story.getLayer("duplicate"), undefined);
    assertEquals(
      story.getLayers().filter((layer) => layer.id === "duplicate"),
      [],
    );
    await story.render();

    assertEquals(getSortCalls(), 3);
    assertEquals(harness.fillOrder, ["#000000"]);
  });
});

test("deserialize invalidates the render-order cache", async () => {
  const harness = createCanvasHarness();
  const story = new StoryCanvas(harness.canvas);
  const first = story.addLayer(backgroundLayer("#first", "first"));
  const second = story.addLayer(backgroundLayer("#second", "second"));
  first.zIndex = 1;
  second.zIndex = 3;

  await withSortSpy(async (getSortCalls) => {
    await story.render();
    assertEquals(harness.fillOrder, ["#000000", "#first", "#second"]);
    harness.fillOrder.length = 0;

    const restoredLayers = story.getLayers().map((layer) => ({ ...layer }));
    (restoredLayers[1] as typeof first).zIndex = 3;
    (restoredLayers[2] as typeof second).zIndex = 1;
    story.deserialize(JSON.stringify({ version: 1, layers: restoredLayers }));
    await story.render();

    assertEquals(getSortCalls(), 2);
    assertEquals(harness.fillOrder, ["#000000", "#second", "#first"]);
  });
});
