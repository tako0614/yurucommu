/** A truthy SDK result alone does not acknowledge the submitted post. */
export function acknowledgesPost(
  value: unknown,
  actorApId: string | undefined,
  content: string,
): boolean {
  if (!value || typeof value !== "object" || !actorApId) return false;
  const post = value as {
    ap_id?: unknown;
    type?: unknown;
    content?: unknown;
    author?: { ap_id?: unknown };
  };
  if (
    typeof post.ap_id !== "string" ||
    post.type !== "Note" ||
    post.content !== content ||
    post.author?.ap_id !== actorApId
  )
    return false;
  try {
    const id = new URL(post.ap_id);
    return id.protocol === "https:" || id.protocol === "http:";
  } catch {
    return false;
  }
}
