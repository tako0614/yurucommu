// Parse ISO 8601 duration (e.g., "PT5S", "PT1M30S", "PT1H2M30S" -> ms)
export function parseStoryDuration(duration: string): number {
  let totalMs = 0;

  const hoursMatch = duration.match(/(\d+)H/);
  const minutesMatch = duration.match(/(\d+)M/);
  const secondsMatch = duration.match(/(\d+)S/);

  if (hoursMatch) totalMs += parseInt(hoursMatch[1]) * 3600000;
  if (minutesMatch) totalMs += parseInt(minutesMatch[1]) * 60000;
  if (secondsMatch) totalMs += parseInt(secondsMatch[1]) * 1000;

  // Default 5 seconds, max 60 seconds
  return totalMs > 0 ? Math.min(totalMs, 60000) : 5000;
}

/**
 * Where "previous" goes from a story: the story before it in the same
 * person's set, else the previous person's LAST story, else null (restart the
 * current one). `storyCounts[i]` is how many stories person i has.
 */
export function previousStoryPosition(
  storyCounts: readonly number[],
  actorIndex: number,
  storyIndex: number,
): { actorIndex: number; storyIndex: number } | null {
  if (storyIndex > 0) return { actorIndex, storyIndex: storyIndex - 1 };
  if (actorIndex > 0) {
    const prev = actorIndex - 1;
    return {
      actorIndex: prev,
      storyIndex: Math.max(0, (storyCounts[prev] ?? 0) - 1),
    };
  }
  return null;
}
