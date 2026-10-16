import { describe, expect, test } from "bun:test";
import { formatMessageDay, messageDayKey } from "./message-day.ts";

// Local-time dates, so the tests hold in any TZ the suite runs under.
const now = new Date(2026, 9, 16, 15, 0);
const at = (...parts: [number, number, number, number]) =>
  new Date(...parts).toISOString();

describe("formatMessageDay", () => {
  test("names today and yesterday", () => {
    expect(formatMessageDay(at(2026, 9, 16, 0), "ja", now)).toBe("今日");
    expect(formatMessageDay(at(2026, 9, 15, 23), "ja", now)).toBe("昨日");
    expect(formatMessageDay(at(2026, 9, 16, 0), "en", now)).toBe("Today");
    expect(formatMessageDay(at(2026, 9, 15, 23), "en", now)).toBe("Yesterday");
  });

  test("dates older days with the weekday, and the year once it differs", () => {
    expect(formatMessageDay(at(2026, 6, 5, 14), "ja", now)).toBe("7月5日(日)");
    expect(formatMessageDay(at(2025, 11, 31, 9), "ja", now)).toBe(
      "2025年12月31日(水)",
    );
    expect(formatMessageDay(at(2026, 6, 5, 14), "en", now)).toBe("Sun, July 5");
  });

  test("returns nothing for an unparsable timestamp", () => {
    expect(formatMessageDay("not a date", "ja", now)).toBe("");
  });
});

describe("messageDayKey", () => {
  test("groups by local calendar day", () => {
    expect(messageDayKey(at(2026, 6, 5, 0))).toBe(
      messageDayKey(at(2026, 6, 5, 23)),
    );
    expect(messageDayKey(at(2026, 6, 5, 23))).not.toBe(
      messageDayKey(at(2026, 6, 6, 0)),
    );
    expect(messageDayKey("not a date")).toBe("");
  });
});
