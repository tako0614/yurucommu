import { For, Show } from "solid-js";
import type { Actor } from "../../types/index.ts";
import { UserAvatar } from "../UserAvatar.tsx";
import { UserListSkeleton } from "../skeletons/PageSkeletons.tsx";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";
import type { Translate } from "../../lib/i18n.tsx";

interface SettingsUserListProps {
  title: string;
  emptyLabel: string;
  actionLabel: string;
  loading: boolean;
  users: Actor[];
  onBack: () => void;
  onAction: (apId: string) => void;
  t: Translate;
}

export function SettingsUserList(props: SettingsUserListProps) {
  return (
    <div class="flex flex-col h-full">
      <SettingsSectionHeader title={props.title} onBack={props.onBack} />
      <div class="flex-1 overflow-y-auto">
        <Show when={!props.loading} fallback={<UserListSkeleton count={5} />}>
          <Show
            when={props.users.length > 0}
            fallback={
              <div class="p-8 text-center text-neutral-500">
                {props.emptyLabel}
              </div>
            }
          >
            <For each={props.users}>
              {(user) => (
                <div class="flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
                  <UserAvatar
                    avatarUrl={user.icon_url}
                    name={user.name || user.preferred_username}
                    size={48}
                  />
                  <div class="flex-1 min-w-0">
                    <div class="font-bold text-white truncate">
                      {user.name || user.preferred_username}
                    </div>
                    <div class="text-neutral-500 truncate">
                      @{user.username}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => props.onAction(user.ap_id)}
                    class="min-h-11 md:min-h-0 px-3 py-1.5 border border-neutral-600 rounded-full text-sm hover:bg-neutral-800 transition-colors"
                  >
                    {props.actionLabel}
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
