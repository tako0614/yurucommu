import type { CommunityMember } from "./api/communities.ts";

export function canChangeCommunityMemberRole(
  member: Pick<CommunityMember, "can_change_role">,
): boolean {
  // Older 3.4.3 servers omit the capability and retain the prior editable
  // behavior. A current server explicitly denies role changes for federated
  // Follow-backed membership, which has no local role row to mutate.
  return member.can_change_role !== false;
}

type CommunityMemberIdentity = {
  ap_id: string;
  username?: string | null;
  preferred_username?: string | null;
  name?: string | null;
};

/** Never render a blank member or destructive confirmation label. */
export function communityMemberDisplayName(
  member: CommunityMemberIdentity,
): string {
  return (
    member.name?.trim() ||
    member.preferred_username?.trim() ||
    member.username?.trim() ||
    member.ap_id
  );
}
