import { Show } from "solid-js";
import type { CommunityDetail, CommunitySettings } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { markComposeAside } from "../layout/routeChrome.ts";

interface CommunitySettingsPanelProps {
  community: CommunityDetail;
  settingsForm: CommunitySettings;
  settingsError: string | null;
  savingSettings: boolean;
  uploadingIcon: boolean;
  iconPreview: string | null;
  isDirty: boolean;
  onChangeSettings: (
    updater: (prev: CommunitySettings) => CommunitySettings,
  ) => void;
  onUploadIcon: (event: Event & { currentTarget: HTMLInputElement }) => void;
  onSaveSettings: () => void;
  onDiscardSettings: () => void;
}

export function CommunitySettingsPanel(props: CommunitySettingsPanelProps) {
  const { t } = useI18n();
  // On a phone the compose button sat over the 説明 field.
  markComposeAside();
  let panelRef: HTMLDivElement | undefined;
  let displayNameInputRef: HTMLInputElement | undefined;

  const handleInlineDiscard = () => {
    const active = document.activeElement;
    const discardWasFocused =
      active instanceof Node && (panelRef?.contains(active) ?? false);
    props.onDiscardSettings();
    if (discardWasFocused) {
      queueMicrotask(() => {
        if (!panelRef?.contains(document.activeElement)) {
          displayNameInputRef?.focus();
        }
      });
    }
  };

  return (
    <div ref={panelRef} class="p-4 space-y-6">
      <Show when={props.settingsError}>
        <div
          role="alert"
          class="p-3 bg-red-500/20 border border-red-500 rounded-lg text-red-400 text-sm"
        >
          {props.settingsError}
        </div>
      </Show>

      <Show when={props.isDirty}>
        <div
          role="status"
          class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
        >
          <span>{t("community.unsavedChanges")}</span>
          <button
            type="button"
            onClick={handleInlineDiscard}
            disabled={props.savingSettings || props.uploadingIcon}
            class="inline-flex min-h-11 md:min-h-0 items-center rounded-full px-3 py-1.5 md:py-1 text-xs font-medium text-amber-100 underline underline-offset-2 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
          >
            {t("community.discardChanges")}
          </button>
        </div>
      </Show>

      {/* Icon Upload */}
      <div>
        <label
          for="community-icon-upload"
          class="block text-sm font-semibold text-neutral-300 mb-2"
        >
          {t("community.icon")}
        </label>
        <div class="flex items-center gap-4">
          <div class="w-20 h-20 rounded-xl overflow-hidden bg-neutral-800 flex items-center justify-center">
            <Show
              when={props.iconPreview || props.community.icon_url}
              fallback={
                <span class="text-2xl font-bold text-white">
                  {(props.community.display_name || props.community.name)
                    .charAt(0)
                    .toUpperCase()}
                </span>
              }
            >
              <img
                src={props.iconPreview || props.community.icon_url || ""}
                alt=""
                class="w-full h-full object-cover"
              />
            </Show>
          </div>
          {/* Visually hidden but focusable file input (class="hidden" made it
              unreachable by keyboard Tab and screen readers); focus outlines
              the visible trigger button. */}
          <label class="inline-flex min-h-11 md:min-h-0 items-center px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg cursor-pointer transition-colors has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent">
            {props.uploadingIcon
              ? t("common.uploading")
              : t("community.selectImage")}
            <input
              id="community-icon-upload"
              type="file"
              accept="image/*"
              aria-disabled={props.uploadingIcon ? "true" : undefined}
              onClick={(e) => {
                if (props.uploadingIcon) e.preventDefault();
              }}
              onChange={props.onUploadIcon}
              class="sr-only"
            />
          </label>
        </div>
      </div>

      {/* Display Name */}
      <div>
        <label
          for="community-display-name"
          class="block text-sm font-semibold text-neutral-300 mb-2"
        >
          {t("settings.displayName")}
        </label>
        <input
          ref={displayNameInputRef}
          id="community-display-name"
          type="text"
          value={props.settingsForm.display_name || ""}
          onInput={(e) =>
            props.onChangeSettings((prev) => ({
              ...prev,
              display_name: e.currentTarget.value,
            }))
          }
          class="w-full min-h-11 md:min-h-0 px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:border-[var(--accent)] focus:outline-none"
          placeholder={t("community.displayNamePlaceholder")}
        />
      </div>

      {/* Summary */}
      <div>
        <label
          for="community-summary"
          class="block text-sm font-semibold text-neutral-300 mb-2"
        >
          {t("groups.description")}
        </label>
        <textarea
          id="community-summary"
          value={props.settingsForm.summary || ""}
          onInput={(e) =>
            props.onChangeSettings((prev) => ({
              ...prev,
              summary: e.currentTarget.value,
            }))
          }
          rows={4}
          class="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:border-[var(--accent)] focus:outline-none resize-none"
          placeholder={t("groups.descriptionPlaceholder")}
        />
      </div>

      {/* Visibility */}
      <fieldset>
        <legend class="block text-sm font-semibold text-neutral-300 mb-2">
          {t("community.visibility")}
        </legend>
        <div class="space-y-2">
          <label class="flex items-center gap-3 p-3 bg-neutral-900 border border-neutral-700 rounded-lg cursor-pointer hover:border-neutral-600">
            <input
              type="radio"
              name="visibility"
              checked={props.settingsForm.visibility === "public"}
              onChange={() =>
                props.onChangeSettings((prev) => ({
                  ...prev,
                  visibility: "public",
                }))
              }
              class="w-4 h-4 shrink-0 text-accent"
            />
            <div>
              <div class="text-white font-medium">{t("community.public")}</div>
              <div class="text-sm text-neutral-500">
                {t("community.publicDesc")}
              </div>
            </div>
          </label>
          <label class="flex items-center gap-3 p-3 bg-neutral-900 border border-neutral-700 rounded-lg cursor-pointer hover:border-neutral-600">
            <input
              type="radio"
              name="visibility"
              checked={props.settingsForm.visibility === "private"}
              onChange={() =>
                props.onChangeSettings((prev) => ({
                  ...prev,
                  visibility: "private",
                }))
              }
              class="w-4 h-4 shrink-0 text-accent"
            />
            <div>
              <div class="text-white font-medium">{t("community.private")}</div>
              <div class="text-sm text-neutral-500">
                {t("community.privateDesc")}
              </div>
            </div>
          </label>
        </div>
      </fieldset>

      {/* Join Policy */}
      <fieldset>
        <legend class="block text-sm font-semibold text-neutral-300 mb-2">
          {t("community.joinPolicy")}
        </legend>
        <div class="space-y-2">
          <label class="flex items-center gap-3 p-3 bg-neutral-900 border border-neutral-700 rounded-lg cursor-pointer hover:border-neutral-600">
            <input
              type="radio"
              name="join_policy"
              checked={props.settingsForm.join_policy === "open"}
              onChange={() =>
                props.onChangeSettings((prev) => ({
                  ...prev,
                  join_policy: "open",
                }))
              }
              class="w-4 h-4 shrink-0 text-accent"
            />
            <div>
              <div class="text-white font-medium">
                {t("community.joinOpen")}
              </div>
              <div class="text-sm text-neutral-500">
                {t("community.joinOpenDesc")}
              </div>
            </div>
          </label>
          <label class="flex items-center gap-3 p-3 bg-neutral-900 border border-neutral-700 rounded-lg cursor-pointer hover:border-neutral-600">
            <input
              type="radio"
              name="join_policy"
              checked={props.settingsForm.join_policy === "approval"}
              onChange={() =>
                props.onChangeSettings((prev) => ({
                  ...prev,
                  join_policy: "approval",
                }))
              }
              class="w-4 h-4 shrink-0 text-accent"
            />
            <div>
              <div class="text-white font-medium">
                {t("community.joinApproval")}
              </div>
              <div class="text-sm text-neutral-500">
                {t("community.joinApprovalDesc")}
              </div>
            </div>
          </label>
          <label class="flex items-center gap-3 p-3 bg-neutral-900 border border-neutral-700 rounded-lg cursor-pointer hover:border-neutral-600">
            <input
              type="radio"
              name="join_policy"
              checked={props.settingsForm.join_policy === "invite"}
              onChange={() =>
                props.onChangeSettings((prev) => ({
                  ...prev,
                  join_policy: "invite",
                }))
              }
              class="w-4 h-4 shrink-0 text-accent"
            />
            <div>
              <div class="text-white font-medium">
                {t("community.joinInvite")}
              </div>
              <div class="text-sm text-neutral-500">
                {t("community.joinInviteDesc")}
              </div>
            </div>
          </label>
        </div>
      </fieldset>

      {/* Post Policy */}
      <fieldset>
        <legend class="block text-sm font-semibold text-neutral-300 mb-2">
          {t("community.postPolicy")}
        </legend>
        <div class="space-y-2">
          <label class="flex items-center gap-3 p-3 bg-neutral-900 border border-neutral-700 rounded-lg cursor-pointer hover:border-neutral-600">
            <input
              type="radio"
              name="post_policy"
              checked={props.settingsForm.post_policy === "anyone"}
              onChange={() =>
                props.onChangeSettings((prev) => ({
                  ...prev,
                  post_policy: "anyone",
                }))
              }
              class="w-4 h-4 shrink-0 text-accent"
            />
            <div>
              <div class="text-white font-medium">
                {t("community.postAnyone")}
              </div>
              <div class="text-sm text-neutral-500">
                {t("community.postAnyoneDesc")}
              </div>
            </div>
          </label>
          <label class="flex items-center gap-3 p-3 bg-neutral-900 border border-neutral-700 rounded-lg cursor-pointer hover:border-neutral-600">
            <input
              type="radio"
              name="post_policy"
              checked={props.settingsForm.post_policy === "members"}
              onChange={() =>
                props.onChangeSettings((prev) => ({
                  ...prev,
                  post_policy: "members",
                }))
              }
              class="w-4 h-4 shrink-0 text-accent"
            />
            <div>
              <div class="text-white font-medium">
                {t("community.postMembers")}
              </div>
              <div class="text-sm text-neutral-500">
                {t("community.postMembersDesc")}
              </div>
            </div>
          </label>
          <label class="flex items-center gap-3 p-3 bg-neutral-900 border border-neutral-700 rounded-lg cursor-pointer hover:border-neutral-600">
            <input
              type="radio"
              name="post_policy"
              checked={props.settingsForm.post_policy === "mods"}
              onChange={() =>
                props.onChangeSettings((prev) => ({
                  ...prev,
                  post_policy: "mods",
                }))
              }
              class="w-4 h-4 shrink-0 text-accent"
            />
            <div>
              <div class="text-white font-medium">
                {t("community.postModerators")}
              </div>
              <div class="text-sm text-neutral-500">
                {t("community.postModeratorsDesc")}
              </div>
            </div>
          </label>
          <label class="flex items-center gap-3 p-3 bg-neutral-900 border border-neutral-700 rounded-lg cursor-pointer hover:border-neutral-600">
            <input
              type="radio"
              name="post_policy"
              checked={props.settingsForm.post_policy === "owners"}
              onChange={() =>
                props.onChangeSettings((prev) => ({
                  ...prev,
                  post_policy: "owners",
                }))
              }
              class="w-4 h-4 shrink-0 text-accent"
            />
            <div>
              <div class="text-white font-medium">
                {t("community.postOwner")}
              </div>
              <div class="text-sm text-neutral-500">
                {t("community.postOwnerDesc")}
              </div>
            </div>
          </label>
        </div>
      </fieldset>

      {/* Save Button */}
      <div class="pt-4">
        <button
          type="button"
          onClick={props.onSaveSettings}
          disabled={
            props.savingSettings || props.uploadingIcon || !props.isDirty
          }
          class="w-full min-h-11 md:min-h-0 px-6 py-3 bg-accent text-white rounded-full font-bold transition-colors disabled:bg-neutral-700 disabled:text-neutral-400 disabled:opacity-70"
        >
          {props.savingSettings
            ? t("common.saving")
            : t("community.saveSettings")}
        </button>
      </div>
    </div>
  );
}
