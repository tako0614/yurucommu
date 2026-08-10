import { expect, test } from "bun:test";

import { localizedStampText } from "./stamp-picker-model.ts";

test("localizedStampText follows exact, base, Japanese, English, then first", () => {
  expect(localizedStampText({ "ja-jp": "日本", en: "English" }, "ja-JP")).toBe(
    "日本",
  );
  expect(localizedStampText({ ja: "日本", en: "English" }, "ja-JP")).toBe(
    "日本",
  );
  expect(localizedStampText({ ja: "日本", en: "English" }, "fr")).toBe("日本");
  expect(localizedStampText({ en: "English" }, "fr")).toBe("English");
});
