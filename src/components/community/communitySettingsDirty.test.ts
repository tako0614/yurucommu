import { expect, test } from "bun:test";
import type { CommunityDetail } from "../../lib/api.ts";
import {
  initialCommunitySettingsForm,
  isCommunitySettingsDirty,
} from "./communitySettingsDirty.ts";

const baseCommunity: CommunityDetail = {
  ap_id: "https://example.test/ap/groups/kissa",
  name: "kissa",
  display_name: "Kissa Builders",
  summary: "Coffee & build notes",
  icon_url: "https://example.test/media/icon.png",
  visibility: "public",
  join_policy: "open",
  post_policy: "members",
  member_count: 10,
  post_count: 5,
  created_by: "https://example.test/ap/users/you",
  created_at: "2026-07-01T10:00:00.000Z",
  is_member: true,
  member_role: "owner",
};

test("initial form matches saved community and is clean", () => {
  const form = initialCommunitySettingsForm(baseCommunity);
  expect(isCommunitySettingsDirty(baseCommunity, form, false)).toBe(false);
  expect(isCommunitySettingsDirty(null, form, false)).toBe(false);
});

test("whitespace-only padding on display_name or summary does not mark dirty", () => {
  const form = {
    ...initialCommunitySettingsForm(baseCommunity),
    display_name: "  Kissa Builders  ",
    summary: "  Coffee & build notes ",
  };
  expect(isCommunitySettingsDirty(baseCommunity, form, false)).toBe(false);
});

test("detects edits across text fields, policies, and pending icon uploads", () => {
  const clean = initialCommunitySettingsForm(baseCommunity);
  expect(
    isCommunitySettingsDirty(
      baseCommunity,
      { ...clean, display_name: "Kissa Club" },
      false,
    ),
  ).toBe(true);
  expect(
    isCommunitySettingsDirty(
      baseCommunity,
      { ...clean, summary: "Updated summary" },
      false,
    ),
  ).toBe(true);
  expect(
    isCommunitySettingsDirty(
      baseCommunity,
      { ...clean, visibility: "private" },
      false,
    ),
  ).toBe(true);
  expect(
    isCommunitySettingsDirty(
      baseCommunity,
      { ...clean, join_policy: "approval" },
      false,
    ),
  ).toBe(true);
  expect(
    isCommunitySettingsDirty(
      baseCommunity,
      { ...clean, post_policy: "mods" },
      false,
    ),
  ).toBe(true);
  expect(isCommunitySettingsDirty(baseCommunity, clean, true)).toBe(true);
  expect(
    isCommunitySettingsDirty(
      baseCommunity,
      { ...clean, icon_url: "https://example.test/media/icon-2.png" },
      false,
    ),
  ).toBe(true);
});
