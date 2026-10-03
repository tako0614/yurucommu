import { expect, test } from "bun:test";
import { captureStorySubmission } from "./story-submission.ts";
import type { StorySubmissionDraft } from "./story-submission.ts";

test("delayed export/upload cannot mix later caption, poll or video edits", async () => {
  const file = new File(["video fixture"], "draft.mp4", { type: "video/mp4" });
  const draft: StorySubmissionDraft = {
    caption: " before upload ",
    communityApId: "https://example.test/ap/groups/original",
    overlays: [
      {
        type: "Question",
        name: "Original question",
        oneOf: [
          { type: "Note", name: "Yes" },
          { type: "Note", name: "No" },
        ],
        position: { x: 0.5, y: 0.5, width: 0.7, height: 0.2 },
      },
    ],
    text: ["Original text"],
    videoFile: file,
    videoScale: 1.2,
    videoPosition: { x: 10, y: 20 },
    videoRotation: 15,
    displayScale: 2,
  };
  const captured = captureStorySubmission(draft);
  await Promise.resolve();
  draft.caption = "Later caption";
  draft.communityApId = "https://example.test/ap/groups/later";
  draft.overlays[0].name = "Later question";
  draft.overlays[0].oneOf![0].name = "Later option";
  draft.overlays[0].position.x = 0.8;
  draft.overlays.push({
    type: "Note",
    name: "Later note",
    position: { x: 0.5, y: 0.5, width: 0.4, height: 0.1 },
  });
  draft.text.push("Later text");
  draft.videoPosition.x = 99;
  draft.videoScale = 2;
  draft.videoRotation = 90;
  draft.displayScale = 4;
  draft.videoFile = new File(["later"], "later.mp4");
  expect(captured.caption).toBe("before upload");
  expect(captured.communityApId).toBe(
    "https://example.test/ap/groups/original",
  );
  expect(captured.overlays).toEqual([
    {
      type: "Question",
      name: "Original question",
      oneOf: [
        { type: "Note", name: "Yes" },
        { type: "Note", name: "No" },
      ],
      position: { x: 0.5, y: 0.5, width: 0.7, height: 0.2 },
    },
  ]);
  expect(captured.transform).toEqual({
    scale: 1.2,
    position: { x: 10, y: 20 },
    rotation: 15,
    displayScale: 2,
  });
  expect(captured.videoFile).toBe(file);
  expect(captured.imageDuration).toBe(10);
});

test("image duration uses captured text and overlays, bounded to 3–15 seconds", () => {
  const draft: StorySubmissionDraft = {
    caption: "   ",
    overlays: [],
    text: [],
    videoFile: null,
    videoScale: 1,
    videoPosition: { x: 0, y: 0 },
    videoRotation: 0,
    displayScale: 1,
  };
  expect(captureStorySubmission(draft).caption).toBeUndefined();
  expect(captureStorySubmission(draft).imageDuration).toBe(3);
  draft.text = ["x".repeat(1000)];
  expect(captureStorySubmission(draft).imageDuration).toBe(15);
});
