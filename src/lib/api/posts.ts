export * from "@takosjp/yurucommu-api";
import {
  apiFetch,
  assertOk,
  normalizePost,
  type TimelinePage,
} from "@takosjp/yurucommu-api";

/**
 * Fetch the following-only home feed (GET /api/timeline/following).
 *
 * Local shim: the deployed server (yurucommu-core 3.4.x) already serves this
 * endpoint, but the published @takosjp/yurucommu-api client has no function
 * for it yet. Mirrors `fetchTimeline` exactly (same transport, cursor and
 * normalization semantics) so it can be replaced by the package export once
 * one ships.
 */
export async function fetchFollowingTimeline(options?: {
  limit?: number;
  before?: string;
}): Promise<TimelinePage> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.before) params.set("before", options.before);
  const query = params.toString() ? `?${params}` : "";
  const res = await apiFetch(`/api/timeline/following${query}`);
  await assertOk(res, "Failed to load timeline");
  const data = (await res.json()) as {
    posts?: Parameters<typeof normalizePost>[0][];
    next_cursor?: string | null;
    has_more?: boolean;
  };
  return {
    posts: (data.posts || []).map(normalizePost),
    nextCursor: data.next_cursor ?? null,
    hasMore: data.has_more ?? false,
  };
}
