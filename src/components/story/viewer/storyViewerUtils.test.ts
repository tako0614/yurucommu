import { describe, expect, test } from "bun:test";
import { previousStoryPosition } from "./storyViewerUtils.ts";

describe("previousStoryPosition", () => {
  test("steps back within one person's stories", () => {
    expect(previousStoryPosition([3, 2], 1, 1)).toEqual({
      actorIndex: 1,
      storyIndex: 0,
    });
  });

  test("from a person's first story goes to the previous person's last", () => {
    expect(previousStoryPosition([3, 2], 1, 0)).toEqual({
      actorIndex: 0,
      storyIndex: 2,
    });
    // The second person back to the first: this read one person too far and
    // threw before.
    expect(previousStoryPosition([1, 4, 2], 1, 0)).toEqual({
      actorIndex: 0,
      storyIndex: 0,
    });
    expect(previousStoryPosition([1, 4, 2], 2, 0)).toEqual({
      actorIndex: 1,
      storyIndex: 3,
    });
  });

  test("at the very first story there is nowhere to go", () => {
    expect(previousStoryPosition([3, 2], 0, 0)).toBeNull();
  });

  test("a previous person with no stories lands on index 0", () => {
    expect(previousStoryPosition([0, 2], 1, 0)).toEqual({
      actorIndex: 0,
      storyIndex: 0,
    });
  });
});
