import { expect, test } from "bun:test";

import { canChangeCommunityMemberRole } from "./community-member-capabilities.ts";

test("federated roster rows do not expose an impossible local role mutation", () => {
  expect(canChangeCommunityMemberRole({ can_change_role: false })).toBe(false);
  expect(canChangeCommunityMemberRole({ can_change_role: true })).toBe(true);
  expect(canChangeCommunityMemberRole({})).toBe(true);
});
