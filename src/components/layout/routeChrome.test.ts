import { describe, expect, test } from "bun:test";
import { hasOwnBackHeader, isConversationOpen } from "./routeChrome.ts";

describe("hasOwnBackHeader", () => {
  test("screens with their own back button", () => {
    for (const path of [
      "/post/https%3A%2F%2Fexample.com%2Fap%2Fobjects%2F1",
      "/profile/https%3A%2F%2Fexample.com%2Fap%2Fusers%2Fakari",
      "/groups/kissa-builders",
      "/friends",
      "/friends/list",
      "/dm/abc",
    ]) {
      expect(hasOwnBackHeader(path, "")).toBe(true);
    }
    expect(hasOwnBackHeader("/dm", "?c=https%3A%2F%2Fx%2Fu")).toBe(true);
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
      "/dm",
      // Redirects to the conversation; shows no back button of its own.
      "/groups/kissa-builders/chat",
    ]) {
      expect(hasOwnBackHeader(path, "")).toBe(false);
    }
  });
});

describe("isConversationOpen", () => {
  test("only an open thread", () => {
    expect(isConversationOpen("/dm", "?c=x")).toBe(true);
    expect(isConversationOpen("/dm/x", "")).toBe(true);
    expect(isConversationOpen("/dm", "")).toBe(false);
    expect(isConversationOpen("/dm", "?tab=requests")).toBe(false);
    expect(isConversationOpen("/", "?c=x")).toBe(false);
  });
});
