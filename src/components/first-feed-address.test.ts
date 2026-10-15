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

  test("accepts full-width input from an IME and surrounding spaces", () => {
    expect(toFollowSearchQuery("  ＠alice＠mastodon.social ")).toBe(
      "@alice@mastodon.social",
    );
    expect(
      toFollowSearchQuery("ａｌｉｃｅ＠ｍａｓｔｏｄｏｎ．ｓｏｃｉａｌ"),
    ).toBe("@alice@mastodon.social");
  });

  test("turns profile and actor links into an address", () => {
    expect(toFollowSearchQuery("https://mastodon.social/@alice")).toBe(
      "@alice@mastodon.social",
    );
    expect(toFollowSearchQuery("https://misskey.example/@bob/")).toBe(
      "@bob@misskey.example",
    );
    expect(toFollowSearchQuery("https://mastodon.social/@bob@misskey.io")).toBe(
      "@bob@misskey.io",
    );
    expect(toFollowSearchQuery("https://mastodon.social/users/alice")).toBe(
      "@alice@mastodon.social",
    );
    expect(toFollowSearchQuery("https://social.example/ap/users/kai")).toBe(
      "@kai@social.example",
    );
  });

  test("unwraps Yurucommu's own /profile/<actor id> share link", () => {
    const actorId = "https://social.example/ap/users/kai";
    expect(
      toFollowSearchQuery(
        `https://other.example/profile/${encodeURIComponent(actorId)}#kai`,
      ),
    ).toBe("@kai@social.example");
  });

  test("passes names and unrecognized links through unchanged", () => {
    expect(toFollowSearchQuery(" akari ")).toBe("akari");
    expect(toFollowSearchQuery("https://mastodon.social/@alice/1234")).toBe(
      "https://mastodon.social/@alice/1234",
    );
    expect(toFollowSearchQuery("https://other.example/profile/%E0%A4%A")).toBe(
      "https://other.example/profile/%E0%A4%A",
    );
    expect(toFollowSearchQuery("")).toBe("");
  });
});
