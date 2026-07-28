import { expect, test } from "bun:test";
import {
  matchMuteWord,
  muteHaystack,
  normalizeMuteWord,
  type MuteMatchable,
} from "./mute-words.ts";

const post = (over: Partial<MuteMatchable> = {}): MuteMatchable => ({
  content: "",
  summary: null,
  ...over,
});

test("matches a case-insensitive substring in the body", () => {
  expect(
    matchMuteWord(post({ content: "big SPOILER ahead" }), ["spoiler"]),
  ).toBe("spoiler");
});

test("returns null with no words or no match", () => {
  expect(matchMuteWord(post({ content: "hello world" }), [])).toBeNull();
  expect(
    matchMuteWord(post({ content: "hello world" }), ["spoiler"]),
  ).toBeNull();
});

test("matches Japanese substrings (no word boundary needed)", () => {
  expect(
    matchMuteWord(post({ content: "今日はネタバレ注意" }), ["ネタバレ"]),
  ).toBe("ネタバレ");
});

test("strips remote HTML so tags/attributes never trip the filter", () => {
  // The muted word "art" appears only inside an href attribute, not the text.
  const html = '<p>see <a href="https://ex.com/chart">the graph</a></p>';
  expect(matchMuteWord(post({ content: html }), ["art"])).toBeNull();
  // But visible text inside tags still matches.
  expect(
    matchMuteWord(post({ content: "<p>hidden <b>keyword</b> here</p>" }), [
      "keyword",
    ]),
  ).toBe("keyword");
});

test("matches text that only appears in the content warning", () => {
  expect(
    matchMuteWord(post({ content: "photo", summary: "election results" }), [
      "election",
    ]),
  ).toBe("election");
});

test("returns the first matching word in list order", () => {
  expect(
    matchMuteWord(post({ content: "cats and dogs" }), ["dogs", "cats"]),
  ).toBe("dogs");
});

test("decodes common entities before matching", () => {
  expect(
    matchMuteWord(post({ content: "Tom &amp; Jerry" }), ["tom & jerry"]),
  ).toBe("tom & jerry");
});

test("ignores blank stored entries", () => {
  expect(matchMuteWord(post({ content: "anything" }), ["   "])).toBeNull();
});

test("muteHaystack lowercases and joins body + summary", () => {
  expect(muteHaystack(post({ content: "Body", summary: "CW" }))).toContain(
    "body",
  );
  expect(muteHaystack(post({ content: "Body", summary: "CW" }))).toContain(
    "cw",
  );
});

test("normalizeMuteWord trims and rejects empty", () => {
  expect(normalizeMuteWord("  hi  ")).toBe("hi");
  expect(normalizeMuteWord("   ")).toBeNull();
});
