export * from "@takosjp/yurucommu-api";

import type { CommunityMember as ApiCommunityMember } from "@takosjp/yurucommu-api";

/**
 * Added by server/API 3.4.4. Optional here while the product still accepts a
 * 3.4.3 host: omission preserves the prior role-editable behavior.
 */
export interface CommunityMember extends ApiCommunityMember {
  can_change_role?: boolean;
}
