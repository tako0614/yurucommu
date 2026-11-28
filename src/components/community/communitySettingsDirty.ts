import type { CommunityDetail, CommunitySettings } from "../../lib/api.ts";

export function initialCommunitySettingsForm(
  community: CommunityDetail,
): CommunitySettings {
  return {
    display_name: community.display_name || community.name,
    summary: community.summary || "",
    visibility: community.visibility,
    join_policy: community.join_policy,
    post_policy: community.post_policy,
  };
}

export function isCommunitySettingsDirty(
  community: CommunityDetail | null,
  form: CommunitySettings,
  hasIconPreview: boolean,
): boolean {
  if (!community) return false;
  if (hasIconPreview) return true;
  if (form.icon_url !== undefined && form.icon_url !== community.icon_url) {
    return true;
  }
  const savedDisplayName = (community.display_name || community.name).trim();
  const currentDisplayName = (form.display_name ?? "").trim();
  if (currentDisplayName !== savedDisplayName) return true;

  const savedSummary = (community.summary || "").trim();
  const currentSummary = (form.summary ?? "").trim();
  if (currentSummary !== savedSummary) return true;

  if (
    form.visibility !== undefined &&
    form.visibility !== community.visibility
  ) {
    return true;
  }
  if (
    form.join_policy !== undefined &&
    form.join_policy !== community.join_policy
  ) {
    return true;
  }
  if (
    form.post_policy !== undefined &&
    form.post_policy !== community.post_policy
  ) {
    return true;
  }
  return false;
}
