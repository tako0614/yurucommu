/**
 * Calendar-day key for a message timestamp in the viewer's time zone, so two
 * messages share a day divider only when they were sent on the same local day.
 * Returns "" for an unparsable timestamp.
 */
export function messageDayKey(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Label for the divider above the first message of a day: "今日" / "昨日" for
 * the two most recent days, otherwise the date with its weekday ("7月5日(日)"),
 * adding the year once it is not the current one. Uses Intl only, so it follows
 * the UI language without strings of its own.
 */
export function formatMessageDay(
  dateString: string,
  locale: string,
  now: Date = new Date(),
): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "";
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000);
  if (days === 0 || days === -1) {
    const word = new Intl.RelativeTimeFormat(locale, {
      numeric: "auto",
    }).format(days, "day");
    return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
  }
  return new Intl.DateTimeFormat(locale, {
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}
