import { expect, test } from "bun:test";

import type { StampDMMessage } from "../../lib/api/stamps.ts";
import { mergeMessagesById } from "./chat-message-merge.ts";

test("message polling adopts a verified local Stamp asset without duplicating the row", () => {
  const existing = stampMessage("https://remote.example/stamp.png");
  const fetched = stampMessage(`/media/stamps/${"c".repeat(64)}.png`);
  const current = [existing];

  const merged = mergeMessagesById(current, [fetched]);
  expect(merged).toHaveLength(1);
  expect(merged).not.toBe(current);
  expect(merged[0]?.stamp?.asset.url).toBe(
    `/media/stamps/${"c".repeat(64)}.png`,
  );
});

test("an unchanged poll preserves the previous array reference", () => {
  const existing = stampMessage("https://remote.example/stamp.png");
  const fetched = stampMessage("https://remote.example/stamp.png");
  const current = [existing];

  expect(mergeMessagesById(current, [fetched])).toBe(current);
});

function stampMessage(assetUrl: string): StampDMMessage {
  return {
    id: "https://chat.example/ap/objects/one",
    sender: {
      ap_id: "https://chat.example/ap/users/alice",
      username: "alice@chat.example",
      preferred_username: "alice",
      name: "Alice",
      icon_url: null,
    },
    content: "[Stamp: OK]",
    attachments: [],
    stamp: {
      id: "https://remote.example/stamp-packs/cat/stamps/okay",
      pack_id: "https://remote.example/stamp-packs/cat",
      revision: `sha256:${"a".repeat(64)}`,
      asset: {
        url: assetUrl,
        media_type: "image/png",
        width: 512,
        height: 512,
        sha256: "c".repeat(64),
      },
      alt: "OK",
    },
    created_at: "2026-08-10T00:00:00.000Z",
  };
}
