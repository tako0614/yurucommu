import { describe, it } from "bun:test";
import { assertEquals } from "#test/assert";
import { APP_TITLE, formatDocumentTitle } from "./useDocumentTitle.ts";

describe("formatDocumentTitle", () => {
  it("returns the product name when section is omitted or blank", () => {
    assertEquals(formatDocumentTitle(), APP_TITLE);
    assertEquals(formatDocumentTitle(null), APP_TITLE);
    assertEquals(formatDocumentTitle(""), APP_TITLE);
    assertEquals(formatDocumentTitle("   "), APP_TITLE);
  });

  it("avoids duplicating the product name", () => {
    assertEquals(formatDocumentTitle(APP_TITLE), APP_TITLE);
    assertEquals(formatDocumentTitle(`  ${APP_TITLE}  `), APP_TITLE);
  });

  it("prefixes the trimmed screen title before the product name", () => {
    assertEquals(formatDocumentTitle("通知"), `通知 — ${APP_TITLE}`);
    assertEquals(
      formatDocumentTitle("  Notifications  "),
      `Notifications — ${APP_TITLE}`,
    );
    assertEquals(
      formatDocumentTitle("Akari (@akari@example.test)"),
      `Akari (@akari@example.test) — ${APP_TITLE}`,
    );
  });
});
