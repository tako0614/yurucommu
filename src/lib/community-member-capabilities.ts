import type { CommunityMember } from "./api/communities.ts";

export function canChangeCommunityMemberRole(
  member: Pick<CommunityMember, "can_change_role">,
): boolean {
  // Older 3.4.3 servers omit the capability and retain the prior editable
  // behavior. A current server explicitly denies role changes for federated
  // Follow-backed membership, which has no local role row to mutate.
  return member.can_change_role !== false;
}
