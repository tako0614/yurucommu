import type { Actor } from "../../types/index.ts";
import type { Translate } from "../../lib/i18n.tsx";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";

interface SettingsDeleteSectionProps {
  actor: Actor;
  deleteConfirm: string;
  // True while the delete request is in flight.
  deleting?: boolean;
  onChangeConfirm: (value: string) => void;
  onDelete: () => void;
  onBack: () => void;
  t: Translate;
}

export function SettingsDeleteSection(props: SettingsDeleteSectionProps) {
  return (
    <div class="flex flex-col h-full">
      <SettingsSectionHeader
        title={props.t("settings.deleteAccountButton")}
        accent="danger"
        onBack={props.onBack}
      />
      <div class="p-4 space-y-4">
        <div class="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p class="text-red-400 text-sm">
            {props.t("settings.deleteAccountWarning")}
          </p>
        </div>
        <div>
          <label
            for="delete-account-confirm"
            class="block text-sm text-neutral-400 mb-2"
          >
            {props
              .t("settings.deleteAccountConfirmLabel")
              .replace("{username}", props.actor.preferred_username)}
          </label>
          <input
            id="delete-account-confirm"
            type="text"
            value={props.deleteConfirm}
            onInput={(e) => props.onChangeConfirm(e.currentTarget.value)}
            placeholder={props.t("settings.deleteAccountConfirmPlaceholder")}
            // bg-neutral-800 like the other settings fields: on the page's
            // own neutral-900 only the placeholder showed where to type. The
            // transparent border draws an edge in forced-colors mode.
            class="w-full bg-neutral-800 border border-transparent rounded-lg px-3 py-2 text-white outline-none focus:ring-2 focus:ring-red-500"
          />
        </div>
        <button
          onClick={props.onDelete}
          disabled={
            props.deleting ||
            props.deleteConfirm !== props.actor.preferred_username
          }
          // Disabled stays a faded red: neutral-800 matched the field above,
          // two identical grey boxes.
          class="w-full py-3 bg-red-600 hover:bg-red-700 disabled:bg-red-600/25 disabled:text-white/50 border border-transparent rounded-lg font-bold"
        >
          {props.deleting
            ? props.t("settings.deletingAccount")
            : props.t("settings.deleteAccountButton")}
        </button>
      </div>
    </div>
  );
}
