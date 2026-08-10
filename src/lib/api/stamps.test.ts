import { afterEach, expect, test } from "bun:test";

import { clearYurucommuFrontendPlugin } from "../plugin.ts";
import {
  fetchStampPacks,
  installStampPack,
  sendCommunityStamp,
  sendUserDMStamp,
  setStampFavorite,
  uninstallStampPack,
} from "./stamps.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearYurucommuFrontendPlugin();
});

test("Stamp client helpers send only logical ids and pack authority", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const url = String(input);
    if (url.endsWith("/api/stamps/packs")) {
      return Response.json({ packs: [] });
    }
    if (url.includes("/api/dm/user/")) {
      return Response.json({
        conversation_id: "conversation-1",
        message: message("dm-1"),
      });
    }
    if (url.includes("/api/communities/")) {
      return Response.json({ message: message("community-1") });
    }
    return Response.json({ success: true });
  }) as typeof fetch;

  const packId = "https://alice.example/stamp-packs/cat";
  const stampId = `${packId}/stamps/okay`;
  expect(await fetchStampPacks()).toEqual([]);
  await installStampPack(packId);
  await uninstallStampPack(packId);
  await setStampFavorite(stampId, true);
  await sendUserDMStamp("https://chat.example/ap/users/bob", stampId);
  await sendCommunityStamp("https://chat.example/ap/groups/friends", stampId);

  expect(requests.map(({ method, body }) => ({ method, body }))).toEqual([
    { method: "GET", body: undefined },
    { method: "POST", body: { pack_id: packId } },
    { method: "DELETE", body: { pack_id: packId } },
    { method: "POST", body: { stamp_id: stampId, favorite: true } },
    { method: "POST", body: { stamp: { stamp_id: stampId } } },
    { method: "POST", body: { stamp: { stamp_id: stampId } } },
  ]);
});

function message(id: string) {
  return {
    id,
    sender: {
      ap_id: "https://chat.example/ap/users/alice",
      username: "alice@chat.example",
      preferred_username: "alice",
      name: "Alice",
      icon_url: null,
    },
    content: "[Stamp: OK]",
    attachments: [],
    created_at: "2026-08-10T00:00:00.000Z",
  };
}
