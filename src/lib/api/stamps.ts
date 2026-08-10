import type { CommunityMessage, DMMessage } from "@takosjp/yurucommu-api";
import {
  apiDelete,
  apiFetch,
  apiPost,
  assertOk,
  normalizeActor,
} from "@takosjp/yurucommu-api";

/**
 * Client seam for the Stamp contract introduced by yurucommu-core 3.4.4.
 * Keep this small local shim until that API package version is published; the
 * owning package already carries the same wire types and helpers.
 */
export interface MessageStampSnapshot {
  id: string;
  pack_id: string;
  revision: `sha256:${string}`;
  asset: {
    url: string;
    media_type: "image/webp" | "image/png";
    width: number;
    height: number;
    sha256: string;
  };
  alt: string;
}

export type StampDMMessage = DMMessage & {
  stamp?: MessageStampSnapshot;
};

export type StampCommunityMessage = CommunityMessage & {
  stamp?: MessageStampSnapshot;
};

export interface InstalledStamp {
  id: string;
  key: string;
  favorite: boolean;
  recent: { last_used_at: string; use_count: number } | null;
  revision: {
    id: string;
    digest: `sha256:${string}`;
    asset: MessageStampSnapshot["asset"];
    alt: Record<string, string>;
    tags: string[];
  };
}

export interface InstalledStampPack {
  id: string;
  share_url: string;
  publisher_actor_id: string;
  slug: string;
  name: Record<string, string>;
  description: Record<string, string> | null;
  release: {
    id: string;
    number: number;
    published_at: string;
  };
  rights: Array<"install" | "send">;
  stamps: InstalledStamp[];
}

export async function fetchStampPacks(): Promise<InstalledStampPack[]> {
  const res = await apiFetch("/api/stamps/packs");
  await assertOk(res, "Failed to load Stamp packs");
  const data = (await res.json()) as { packs?: InstalledStampPack[] };
  return data.packs ?? [];
}

export async function installStampPack(packId: string): Promise<void> {
  const res = await apiPost("/api/stamps/install", { pack_id: packId });
  await assertOk(res, "Failed to install Stamp pack");
}

export async function uninstallStampPack(packId: string): Promise<void> {
  const res = await apiDelete("/api/stamps/install", { pack_id: packId });
  await assertOk(res, "Failed to remove Stamp pack");
}

export async function setStampFavorite(
  stampId: string,
  favorite: boolean,
): Promise<void> {
  const res = await apiPost("/api/stamps/favorite", {
    stamp_id: stampId,
    favorite,
  });
  await assertOk(res, "Failed to update Stamp favorite");
}

export async function sendUserDMStamp(
  userApId: string,
  stampId: string,
): Promise<{ message: StampDMMessage; conversation_id: string }> {
  const res = await apiPost(
    `/api/dm/user/${encodeURIComponent(userApId)}/messages`,
    { stamp: { stamp_id: stampId } },
  );
  await assertOk(res, "Failed to send Stamp");
  const data = (await res.json()) as {
    message: StampDMMessage;
    conversation_id: string;
  };
  return {
    ...data,
    message: {
      ...data.message,
      sender: normalizeActor(data.message.sender),
    },
  };
}

export async function sendCommunityStamp(
  identifier: string,
  stampId: string,
): Promise<StampCommunityMessage> {
  const res = await apiPost(
    `/api/communities/${encodeURIComponent(identifier)}/messages`,
    { stamp: { stamp_id: stampId } },
  );
  await assertOk(res, "Failed to send Stamp");
  const data = (await res.json()) as { message: StampCommunityMessage };
  return {
    ...data.message,
    sender: normalizeActor(data.message.sender),
  };
}
