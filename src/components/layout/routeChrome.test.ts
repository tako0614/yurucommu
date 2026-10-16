import { describe, expect, test } from "bun:test";
import { hasOwnBackHeader } from "./routeChrome.ts";

describe("hasOwnBackHeader", () => {
  test("screens with their own back button", () => {
    for (const path of [
      "/post/https%3A%2F%2Fexample.com%2Fap%2Fobjects%2F1",
      "/profile/https%3A%2F%2Fexample.com%2Fap%2Fusers%2Fakari",
      "/groups/kissa-builders",
      "/friends",
      "/friends/list",
      "/friends/",
      "/friends/list/",
      "/groups/kissa-builders/",
    ]) {
      expect(hasOwnBackHeader(path)).toBe(true);
    }
  });

  test("top-level screens keep the avatar bar", () => {
    for (const path of [
      "/",
      "/profile",
      "/users/you",
      "/search",
      "/notifications",
      "/bookmarks",
      "/settings",
      // An open conversation is detected from the panel, not the URL.
      "/dm",
      "/dm/abc",
      // Redirects to the conversation; shows no back button of its own.
      "/groups/kissa-builders/chat",
      // Unknown paths render the not-found page, which has no back button.
      "/friends/unknown",
    ]) {
      expect(hasOwnBackHeader(path)).toBe(false);
    }
  });
});
