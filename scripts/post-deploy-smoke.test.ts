import { describe, expect, test } from "bun:test";

import { assertNoteAbsent, verifyPostAbsent } from "./post-deploy-smoke.ts";

describe("post-deploy cleanup readback", () => {
  test("accepts a post detail that is no longer present", async () => {
    await expect(
      verifyPostAbsent("post-123", async (path) => {
        expect(path).toBe("/api/posts/post-123");
        return new Response(JSON.stringify({ error: "Post not found" }), {
          status: 404,
        });
      }),
    ).resolves.toBeUndefined();
  });

  test("fails closed when DELETE returns 200 but the post still reads", async () => {
    const marker = "e2e-post-marker";

    const failure = verifyPostAbsent("post-123", async () => {
      return new Response(
        JSON.stringify({ post: { ap_id: "post-123", content: marker } }),
        { status: 200 },
      );
    });

    await expect(failure).rejects.toThrow(
      "post cleanup readback still found the probe post",
    );
    await expect(failure).rejects.not.toThrow(marker);
  });

  test("requires the exact note marker to be absent from the notes list", () => {
    const marker = "e2e-note-marker";

    expect(() =>
      assertNoteAbsent({ notes: [{ content: "another-note" }] }, marker),
    ).not.toThrow();
    let thrown: unknown;
    try {
      assertNoteAbsent({ notes: [{ content: marker }] }, marker);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "notes cleanup readback still found the probe note",
    );
    expect((thrown as Error).message).not.toContain(marker);
  });

  test("fails closed when the notes readback shape is not a list", () => {
    expect(() => assertNoteAbsent({}, "e2e-note-marker")).toThrow(
      "notes cleanup readback did not return notes",
    );
  });
});
