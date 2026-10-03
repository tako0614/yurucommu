import type { Story, StoryOverlay } from "../types/index.ts";
import { ApiError } from "./api/fetch.ts";

/** Only rendered media references and user-visible metadata are stored. */
export interface StoryCreatePayload {
  attachment: { url?: string; r2_key: string; content_type: string };
  displayDuration: string;
  caption?: string;
  overlays?: StoryOverlay[];
  community_ap_id?: string;
}

export interface StoryIntentScope {
  origin: string;
  principal: string;
  endpoint?: string;
}

export interface StoryIntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoryIntentRecord {
  version: 1;
  intentId: string;
  origin: string;
  principal: string;
  endpoint: string;
  status: "ready" | "pending" | "unconfirmed" | "rejected" | "confirmed";
  payload: StoryCreatePayload;
  serverId?: string;
}

export interface StoryIntentSnapshot {
  record: StoryIntentRecord | null;
  /** Storage is inaccessible, corrupt, or changed outside this coordinator. */
  failed: boolean;
}

export interface StoryIntentOutcome extends StoryIntentSnapshot {
  kind: "confirmed" | "unconfirmed" | "rejected" | "blocked";
  error?: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function onlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function localUrl(value: unknown, origin: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value &&
      url.pathname !== "/"
    );
  } catch {
    return false;
  }
}

function validPayload(value: unknown): value is StoryCreatePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<StoryCreatePayload>;
  const attachment = payload.attachment;
  if (
    !onlyKeys(value, [
      "attachment",
      "displayDuration",
      "caption",
      "overlays",
      "community_ap_id",
    ]) ||
    !attachment ||
    !onlyKeys(attachment, ["url", "r2_key", "content_type"])
  )
    return false;
  const overlays = payload.overlays;
  if (
    overlays !== undefined &&
    (!Array.isArray(overlays) ||
      overlays.length > 20 ||
      !overlays.every((item) => {
        if (
          !item ||
          typeof item !== "object" ||
          !onlyKeys(item, ["type", "position", "name", "oneOf", "href"])
        )
          return false;
        const position = item.position;
        return (
          typeof item.type === "string" &&
          ["Question", "Note", "Link"].includes(item.type) &&
          !!position &&
          typeof position === "object" &&
          onlyKeys(position, ["x", "y", "width", "height"]) &&
          [position.x, position.y, position.width, position.height].every(
            (n) =>
              typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
          ) &&
          (item.name === undefined ||
            (typeof item.name === "string" && item.name.length <= 10000)) &&
          (item.href === undefined ||
            (typeof item.href === "string" && item.href.length <= 2048)) &&
          (item.oneOf === undefined ||
            (Array.isArray(item.oneOf) &&
              item.oneOf.length <= 4 &&
              item.oneOf.every(
                (option) =>
                  option &&
                  typeof option === "object" &&
                  onlyKeys(option, ["type", "name"]) &&
                  option.type === "Note" &&
                  typeof option.name === "string" &&
                  option.name.length <= 10000,
              )))
        );
      }))
  )
    return false;
  return (
    typeof attachment.r2_key === "string" &&
    attachment.r2_key.length > 0 &&
    attachment.r2_key.length <= 2048 &&
    typeof attachment.content_type === "string" &&
    ["image/jpeg", "video/mp4"].includes(attachment.content_type) &&
    (attachment.url === undefined ||
      attachment.url === mediaPath(attachment.r2_key)) &&
    typeof payload.displayDuration === "string" &&
    payload.displayDuration.length <= 32 &&
    /^PT(?:\d+(?:\.\d+)?S)$/.test(payload.displayDuration) &&
    (payload.caption === undefined ||
      (typeof payload.caption === "string" &&
        payload.caption.length <= 10000)) &&
    (payload.community_ap_id === undefined ||
      (typeof payload.community_ap_id === "string" &&
        payload.community_ap_id.length <= 2048))
  );
}

function mediaPath(key: string): string {
  const withoutUploads = key.startsWith("uploads/")
    ? key.slice("uploads/".length)
    : key;
  return `/media/${withoutUploads}`;
}

function validRecord(
  value: unknown,
  scope: Required<StoryIntentScope>,
): value is StoryIntentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoryIntentRecord>;
  return (
    record.version === 1 &&
    onlyKeys(value, [
      "version",
      "intentId",
      "origin",
      "principal",
      "endpoint",
      "status",
      "payload",
      "serverId",
    ]) &&
    typeof record.intentId === "string" &&
    /^[0-9a-f-]{36}$/.test(record.intentId) &&
    record.origin === scope.origin &&
    record.principal === scope.principal &&
    record.endpoint === scope.endpoint &&
    ["ready", "pending", "unconfirmed", "rejected", "confirmed"].includes(
      record.status || "",
    ) &&
    validPayload(record.payload) &&
    (record.payload.community_ap_id === undefined ||
      localCommunityId(record.payload.community_ap_id, scope.origin)) &&
    (record.status === "confirmed"
      ? localStoryId(record.serverId, scope.origin)
      : record.serverId === undefined)
  );
}

function localStoryId(value: unknown, origin: string): value is string {
  return (
    localUrl(value, origin) &&
    /^\/ap\/objects\/[^/]+$/.test(new URL(value).pathname)
  );
}

function localCommunityId(value: unknown, origin: string): value is string {
  return (
    localUrl(value, origin) &&
    /^\/ap\/groups\/[^/]+$/.test(new URL(value).pathname)
  );
}

function canonicalTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : null;
}

/** Check the actual SDK Story response, never an echoed request or history text. */
export function acknowledgesStory(
  response: unknown,
  scope: StoryIntentScope,
  payload: StoryCreatePayload,
): response is Story {
  if (!response || typeof response !== "object") return false;
  const story = response as Partial<Story>;
  const published = canonicalTime(story.published);
  const end = canonicalTime(story.end_time);
  const media = story.attachment;
  try {
    return (
      localStoryId(story.ap_id, scope.origin) &&
      story.author?.ap_id === scope.principal &&
      !!media &&
      media.r2_key === payload.attachment.r2_key &&
      media.url === mediaPath(payload.attachment.r2_key) &&
      media.mediaType === payload.attachment.content_type &&
      media.type ===
        (payload.attachment.content_type.startsWith("video/")
          ? "Video"
          : "Document") &&
      (story.caption?.trim() || undefined) ===
        (payload.caption?.trim() || undefined) &&
      story.displayDuration === payload.displayDuration &&
      canonical(story.overlays || []) === canonical(payload.overlays || []) &&
      published !== null &&
      end !== null &&
      end > published
    );
  } catch {
    return false;
  }
}

/** Only documented, received pre-write Story rejections establish non-creation. */
function storyFailure(error: unknown): "rejected" | "unconfirmed" {
  return error instanceof ApiError &&
    [400, 401, 403, 404, 429].includes(error.status)
    ? "rejected"
    : "unconfirmed";
}

export function createStoryIntentCoordinator(
  scope: StoryIntentScope,
  storage?: StoryIntentStorage,
) {
  let endpoint: string;
  try {
    const candidate = new URL(scope.endpoint ?? `${scope.origin}/api/stories`);
    if (
      (candidate.protocol !== "https:" && candidate.protocol !== "http:") ||
      candidate.origin !== scope.origin ||
      candidate.username ||
      candidate.password ||
      candidate.hash ||
      candidate.href !== (scope.endpoint ?? `${scope.origin}/api/stories`) ||
      !candidate.pathname.startsWith("/")
    )
      throw new Error("Invalid Story endpoint");
    endpoint = candidate.href;
  } catch {
    throw new Error("Story intent requires a canonical same-origin endpoint");
  }
  const resolvedScope: Required<StoryIntentScope> = { ...scope, endpoint };
  if (
    !["http:", "https:"].includes(new URL(scope.origin).protocol) ||
    new URL(scope.origin).origin !== scope.origin ||
    !localUrl(scope.principal, scope.origin) ||
    !/^\/ap\/users\/[^/]+$/.test(new URL(scope.principal).pathname)
  ) {
    throw new Error("Story intent requires a canonical local principal");
  }
  const key = `yurucommu:story-intent:v1:${encodeURIComponent(scope.origin)}:${encodeURIComponent(scope.principal)}:${encodeURIComponent(endpoint)}`;
  let backing: StoryIntentStorage | undefined = storage;
  let inaccessible = false;
  if (!backing) {
    try {
      backing = globalThis.sessionStorage;
    } catch {
      inaccessible = true;
    }
  }
  let record: StoryIntentRecord | null = null;
  let raw: string | null = null;
  let failed = inaccessible || !backing;
  let corrupt = false;
  let conflict = false;
  let stageRecoverable = false;
  let busy = false;

  const snapshot = (): StoryIntentSnapshot => ({
    record: record ? structuredClone(record) : null,
    failed,
  });
  const current = (): string | null | undefined => {
    try {
      return backing?.getItem(key);
    } catch {
      failed = true;
      return undefined;
    }
  };
  const unchanged = (): boolean => {
    const saved = current();
    if (saved === undefined || saved !== raw) {
      failed = true;
      if (saved !== undefined && saved !== raw) conflict = true;
      return false;
    }
    return true;
  };
  const save = (next: StoryIntentRecord): boolean => {
    if (!backing || failed || !unchanged()) return false;
    const nextRaw = JSON.stringify(next);
    try {
      backing.setItem(key, nextRaw);
    } catch {
      failed = true;
      return false;
    }
    if (current() !== nextRaw) {
      failed = true;
      return false;
    }
    raw = nextRaw;
    record = next;
    return true;
  };
  const remove = (): boolean => {
    if (!backing || failed || !unchanged()) return false;
    try {
      backing.removeItem(key);
    } catch {
      failed = true;
      return false;
    }
    if (current() !== null) {
      failed = true;
      return false;
    }
    raw = null;
    record = null;
    return true;
  };

  const initial = current();
  if (initial !== undefined && initial !== null) {
    raw = initial;
    try {
      if (initial.length > 150000)
        throw new Error("Story intent exceeds local limit");
      const parsed: unknown = JSON.parse(initial);
      if (validRecord(parsed, resolvedScope)) {
        record =
          parsed.status === "pending"
            ? { ...parsed, status: "unconfirmed" }
            : parsed;
      } else {
        failed = true;
        corrupt = true;
      }
    } catch {
      failed = true;
      corrupt = true;
    }
  } else if (initial === undefined) failed = true;

  const read = (): StoryIntentSnapshot => {
    if (!failed) unchanged();
    return snapshot();
  };
  const stage = (payload: StoryCreatePayload): StoryIntentSnapshot => {
    if (busy || (record && record.status !== "ready") || (record && !failed))
      return snapshot();
    if (!failed && !unchanged() && conflict) return snapshot();
    // JSON round trip removes caller-owned references and cannot serialize Files.
    let captured: StoryCreatePayload;
    try {
      captured = JSON.parse(
        JSON.stringify({
          attachment: {
            url: payload.attachment.url,
            r2_key: payload.attachment.r2_key,
            content_type: payload.attachment.content_type,
          },
          displayDuration: payload.displayDuration,
          caption: payload.caption,
          overlays: payload.overlays,
          community_ap_id: payload.community_ap_id,
        }),
      ) as StoryCreatePayload;
      if (
        !validPayload(captured) ||
        (captured.community_ap_id !== undefined &&
          !localCommunityId(captured.community_ap_id, scope.origin)) ||
        JSON.stringify(captured).length > 131072
      )
        throw new Error("Invalid Story payload");
    } catch {
      failed = true;
      return snapshot();
    }
    const next: StoryIntentRecord = {
      version: 1,
      intentId: record?.intentId ?? crypto.randomUUID(),
      origin: scope.origin,
      principal: scope.principal,
      endpoint,
      status: "ready",
      payload: captured,
    };
    if (failed) {
      if (!record) {
        if (!corrupt && !conflict && raw === null) {
          record = next;
          stageRecoverable = true;
        }
        return snapshot();
      }
      // A failed first stage may be retried explicitly. It must be the same
      // payload, and no unknown or malformed value may have appeared in storage.
      if (
        conflict ||
        !stageRecoverable ||
        canonical(record.payload) !== canonical(next.payload)
      )
        return snapshot();
      const saved = current();
      if (
        saved === undefined ||
        (saved !== raw && saved !== JSON.stringify(next))
      )
        return snapshot();
      if (saved === JSON.stringify(next)) {
        raw = saved;
        record = next;
        failed = false;
        stageRecoverable = false;
        return snapshot();
      }
      failed = false;
    }
    if (!save(next)) {
      if (!conflict) {
        record = next; // Keep rendered refs in memory if persistence failed.
        stageRecoverable = true;
      }
    } else stageRecoverable = false;
    return snapshot();
  };
  const blocked = (): StoryIntentOutcome => ({
    ...snapshot(),
    kind: "blocked",
  });
  // `create` must be the direct Story SDK write. Post-ACK UI work belongs
  // outside this callback so an unrelated ApiError cannot be a rejection.
  const attempt = async (
    create: (payload: StoryCreatePayload) => Promise<unknown>,
    retry: boolean,
  ): Promise<StoryIntentOutcome> => {
    if (busy || failed || !record || !unchanged()) return blocked();
    if (
      retry
        ? !["unconfirmed", "rejected"].includes(record.status)
        : record.status !== "ready"
    ) {
      return blocked();
    }
    busy = true;
    try {
      const pending: StoryIntentRecord = { ...record, status: "pending" };
      if (!save(pending)) {
        record = { ...pending, status: "unconfirmed" };
        return blocked();
      }
      let response: unknown;
      try {
        response = await create(structuredClone(pending.payload));
      } catch (error) {
        const kind = storyFailure(error);
        const next: StoryIntentRecord = { ...pending, status: kind };
        if (!save(next)) record = { ...pending, status: "unconfirmed" };
        return { ...snapshot(), kind: failed ? "unconfirmed" : kind, error };
      }
      if (!acknowledgesStory(response, scope, pending.payload)) {
        const next: StoryIntentRecord = { ...pending, status: "unconfirmed" };
        if (!save(next)) record = next;
        return { ...snapshot(), kind: "unconfirmed" };
      }
      const acknowledged = response as Story;
      const confirmed: StoryIntentRecord = {
        ...pending,
        status: "confirmed",
        serverId: acknowledged.ap_id,
      };
      if (!save(confirmed)) {
        // The server ACK is already conclusive for this tab. A local storage
        // fault must not turn it into a retryable unknown in memory.
        record = confirmed;
        return {
          ...snapshot(),
          kind: "confirmed",
          record: structuredClone(confirmed),
        };
      }
      // The response is confirmed even if local cleanup is denied. Keep it locked.
      remove();
      return {
        ...snapshot(),
        kind: "confirmed",
        record: structuredClone(confirmed),
      };
    } finally {
      busy = false;
    }
  };
  const dismiss = (): StoryIntentSnapshot => {
    if (!busy && record) remove();
    return snapshot();
  };
  const clearConfirmed = (): StoryIntentSnapshot => {
    if (!busy && record?.status === "confirmed") remove();
    return snapshot();
  };
  return {
    key,
    read,
    stage,
    submit: (create: (payload: StoryCreatePayload) => Promise<unknown>) =>
      attempt(create, false),
    retry: (create: (payload: StoryCreatePayload) => Promise<unknown>) =>
      attempt(create, true),
    dismiss,
    clearConfirmed,
  };
}
