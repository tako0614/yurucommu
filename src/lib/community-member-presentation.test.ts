import { expect, test } from "bun:test";

import {
  canChangeCommunityMemberRole,
  communityMemberDisplayName,
} from "./community-member-presentation.ts";

test("federated roster rows do not expose an impossible local role mutation", () => {
  expect(canChangeCommunityMemberRole({ can_change_role: false })).toBe(false);
  expect(canChangeCommunityMemberRole({ can_change_role: true })).toBe(true);
  expect(canChangeCommunityMemberRole({})).toBe(true);
});

test("a cache-missing member retains a visible and actionable label", () => {
  expect(
    communityMemberDisplayName({
      ap_id: "https://remote.example/users/raider",
      username: "raider@remote.example",
      preferred_username: null,
      name: null,
    }),
  ).toBe("raider@remote.example");
  expect(
    communityMemberDisplayName({
      ap_id: "https://remote.example/actor/opaque-id",
      username: null,
      preferred_username: " ",
      name: " ",
    }),
  ).toBe("https://remote.example/actor/opaque-id");
});
