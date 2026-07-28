export * from "@takosjp/yurucommu-api";
import type { Post, PostAuthor } from "@takosjp/yurucommu-api";

/**
 * Forward-compatible feed-entry shape: the next yurucommu-core release
 * surfaces boosts (reposts) in the home/following feeds as the ORIGINAL post
 * annotated with the booster (`reposted_by`), the Announce activity's ap_id
 * (`repost_ap_id`) and the announce timestamp (`repost_published`). The base
 * `Post` shape stays canonical, so when the fields are absent everything
 * renders exactly as today. Local extension only — do not fold these fields
 * into the published package type until the server actually ships them.
 */
export type PostWithRepost = Post & {
  reposted_by?: PostAuthor;
  repost_ap_id?: string | null;
  repost_published?: string | null;
};

/**
 * Identity key of a feed ENTRY (not the underlying post): a boost entry shares
 * the boosted post's `ap_id`, so keying/deduping by `ap_id` alone would
 * collapse a boost and the original into one. The Announce's own ap_id
 * disambiguates when present.
 */
export function feedItemKey(post: Post): string {
  const p = post as PostWithRepost;
  return p.repost_ap_id ?? post.ap_id;
}
