import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test/assert";
import { APP_TITLE, formatDocumentTitle } from "./useDocumentTitle.ts";

const fixture = fileURLToPath(
  new URL("./__fixtures__/useDocumentTitle.fixture.ts", import.meta.url),
);

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

describe("useDocumentTitle", () => {
  for (const scenario of ["sync-and-cleanup", "no-clobber-newer-view"]) {
    it(`reactive lifecycle: ${scenario}`, () => {
      const child = Bun.spawnSync(
        [process.execPath, "--conditions=browser", fixture, scenario],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        },
      );
      expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual(
        {
          code: 0,
          stderr: "",
        },
      );
      expect(JSON.parse(child.stdout.toString())).toEqual({
        scenario,
        passed: true,
      });
    }, 15_000);
  }
});
