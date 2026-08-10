export function localizedStampText(
  values: Record<string, string>,
  language: string,
): string {
  const normalized = language.toLowerCase();
  return (
    values[normalized] ??
    values[normalized.split("-", 1)[0] ?? ""] ??
    values.ja ??
    values.en ??
    Object.values(values)[0] ??
    ""
  );
}
