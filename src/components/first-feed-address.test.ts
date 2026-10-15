import { describe, expect, test } from "bun:test";
import { toFollowSearchQuery } from "./first-feed-address.ts";

describe("toFollowSearchQuery", () => {
  test("keeps a full address and adds a missing leading @", () => {
    expect(toFollowSearchQuery("@alice@mastodon.social")).toBe(
      "@alice@mastodon.social",
    );
    expect(toFollowSearchQuery("alice@mastodon.social")).toBe(
      "@alice@mastodon.social",
    );
  });

  test("accepts full-width ＠ and surrounding spaces", () => {
    expect(toFollowSearchQuery("  ＠alice＠mastodon.social ")).toBe(
      "@alice@mastodon.social",
    );
  });

  test("turns a copied /@user profile link into an address", () => {
    expect(toFollowSearchQuery("https://mastodon.social/@alice")).toBe(
      "@alice@mastodon.social",
    );
    expect(toFollowSearchQuery("https://misskey.example/@bob/")).toBe(
      "@bob@misskey.example",
    );
  });

  test("passes names and other links through unchanged", () => {
    expect(toFollowSearchQuery(" akari ")).toBe("akari");
    expect(toFollowSearchQuery("https://social.example/users/alice")).toBe(
      "https://social.example/users/alice",
    );
    expect(toFollowSearchQuery("")).toBe("");
  });
});
