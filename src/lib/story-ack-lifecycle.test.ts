import { expect, test } from "bun:test";
import { ApiError } from "./api/fetch.ts";
import { runAcknowledgedStoryEffects } from "./story-ack-lifecycle.ts";
import { createStoryIntentCoordinator } from "./story-intent.ts";

const origin = "https://social.example";
const principal = `${origin}/ap/users/owner`;
const payload = {
  attachment: {
    url: "/media/ack.jpg",
    r2_key: "uploads/ack.jpg",
    content_type: "image/jpeg",
  },
  caption: "acknowledged",
  displayDuration: "PT5S",
};

for (const phase of ["refresh", "close"] as const) {
  for (const asynchronous of [false, true]) {
    test(`an acknowledged Story cannot be retried after ${asynchronous ? "async" : "sync"} ${phase} failure`, async () => {
      const values = new Map<string, string>();
      const intent = createStoryIntentCoordinator(
        { origin, principal },
        {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => {
            values.set(key, value);
          },
          removeItem: (key) => {
            values.delete(key);
          },
        },
      );
      expect(intent.stage(payload).failed).toBe(false);
      let creates = 0;
      const create = async () => {
        creates++;
        return {
          ap_id: `${origin}/ap/objects/story-ack`,
          author: { ap_id: principal },
          attachment: {
            type: "Document",
            url: payload.attachment.url,
            r2_key: payload.attachment.r2_key,
            mediaType: payload.attachment.content_type,
          },
          caption: payload.caption,
          displayDuration: payload.displayDuration,
          published: "2026-10-02T00:00:00.000Z",
          end_time: "2026-10-03T00:00:00.000Z",
        };
      };
      const outcome = await intent.submit(create);
      expect(outcome.kind).toBe("confirmed");
      expect(outcome.failed).toBe(false);
      // A received 400 from UI work must never be classified as create refusal.
      const failure = new ApiError(400, "UI callback failed after ACK");
      const called: string[] = [];
      const diagnostics: unknown[] = [];
      const effect = (name: "refresh" | "close") => {
        called.push(name);
        if (name !== phase) return;
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      };
      await runAcknowledgedStoryEffects(
        { onSuccess: () => effect("refresh"), onClose: () => effect("close") },
        (name, error) => {
          diagnostics.push([name, error]);
        },
      );
      expect(called).toEqual(["refresh", "close"]);
      expect(diagnostics).toEqual([[phase, failure]]);
      expect(outcome.kind).toBe("confirmed");
      expect(outcome.record?.serverId).toBe(`${origin}/ap/objects/story-ack`);
      expect((await intent.retry(create)).kind).toBe("blocked");
      expect((await intent.submit(create)).kind).toBe("blocked");
      expect(creates).toBe(1);
    });
  }
}

test("close runs once without waiting for refresh, even when diagnostics throw", async () => {
  let finish!: () => void;
  const calls: string[] = [];
  const completion = runAcknowledgedStoryEffects(
    {
      onSuccess: () => {
        calls.push("refresh");
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      onClose: () => {
        calls.push("close");
        throw new Error("close failed");
      },
    },
    () => {
      throw new Error("diagnostic failed");
    },
  );
  expect(calls).toEqual(["refresh", "close"]);
  finish();
  await completion;
  expect(calls).toEqual(["refresh", "close"]);
});
