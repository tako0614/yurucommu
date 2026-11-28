import { For } from "solid-js";
import { useI18n } from "../../lib/i18n.tsx";

/**
 * Loading skeleton for PostDetailPage: mirrors the main post header, body,
 * metadata, action bar, and two reply rows to prevent layout jump.
 */
export function PostDetailSkeleton() {
  return (
    <div aria-hidden="true" class="flex-1 overflow-hidden">
      <div class="border-b border-neutral-800 px-4 py-4">
        <div class="flex items-center gap-3">
          <div class="h-12 w-12 shrink-0 rounded-full bg-neutral-800 animate-pulse" />
          <div class="flex-1 min-w-0 space-y-2">
            <div class="h-4 w-36 rounded bg-neutral-800 animate-pulse" />
            <div class="h-3.5 w-24 rounded bg-neutral-800/70 animate-pulse" />
          </div>
        </div>
        <div class="mt-4 space-y-2.5">
          <div class="h-4 w-full rounded bg-neutral-800 animate-pulse" />
          <div class="h-4 w-11/12 rounded bg-neutral-800 animate-pulse" />
          <div class="h-4 w-2/3 rounded bg-neutral-800 animate-pulse" />
        </div>
        <div class="mt-4 h-3.5 w-40 rounded bg-neutral-800/70 animate-pulse" />
        <div class="mt-4 flex items-center justify-around border-t border-neutral-800 pt-3">
          <div class="h-5 w-8 rounded bg-neutral-800/70 animate-pulse" />
          <div class="h-5 w-8 rounded bg-neutral-800/70 animate-pulse" />
          <div class="h-5 w-8 rounded bg-neutral-800/70 animate-pulse" />
          <div class="h-5 w-8 rounded bg-neutral-800/70 animate-pulse" />
        </div>
      </div>
      <For each={[0, 1]}>
        {() => (
          <div class="flex gap-3 border-b border-neutral-800 px-4 py-3">
            <div class="h-10 w-10 shrink-0 rounded-full bg-neutral-800 animate-pulse" />
            <div class="flex-1 min-w-0 space-y-2">
              <div class="flex items-center gap-2">
                <div class="h-3.5 w-24 rounded bg-neutral-800 animate-pulse" />
                <div class="h-3 w-16 rounded bg-neutral-800/70 animate-pulse" />
              </div>
              <div class="h-3.5 w-5/6 rounded bg-neutral-800 animate-pulse" />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

/**
 * Loading skeleton for user/member list rows (FriendsListPage, community
 * profiles, etc.): avatar + display name + @handle + trailing action slot.
 */
export function UserListSkeleton(props: { count?: number; label?: string }) {
  const { t } = useI18n();
  const rows = () => Array.from({ length: props.count ?? 6 });
  return (
    <div role="status">
      <span class="sr-only">{props.label ?? t("common.loading")}</span>
      <div aria-hidden="true">
        <For each={rows()}>
          {() => (
            <div class="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
              <div class="h-12 w-12 shrink-0 rounded-full bg-neutral-800 animate-pulse" />
              <div class="flex-1 min-w-0 space-y-2">
                <div class="h-4 w-32 rounded bg-neutral-800 animate-pulse" />
                <div class="h-3.5 w-24 rounded bg-neutral-800/70 animate-pulse" />
              </div>
              <div class="h-9 w-9 shrink-0 rounded-full bg-neutral-800/70 animate-pulse" />
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/**
 * Loading skeleton for DM / community chat message threads: alternating
 * incoming and outgoing message bubbles.
 */
export function ChatMessagesSkeleton() {
  return (
    <div aria-hidden="true" class="space-y-3 py-2">
      <div class="flex items-end gap-2">
        <div class="h-8 w-8 shrink-0 rounded-full bg-neutral-800 animate-pulse" />
        <div class="h-12 w-48 max-w-[70%] rounded-2xl bg-neutral-800 animate-pulse" />
      </div>
      <div class="flex justify-end">
        <div class="h-10 w-40 max-w-[70%] rounded-2xl bg-neutral-800/80 animate-pulse" />
      </div>
      <div class="flex items-end gap-2">
        <div class="h-8 w-8 shrink-0 rounded-full bg-neutral-800 animate-pulse" />
        <div class="h-16 w-56 max-w-[70%] rounded-2xl bg-neutral-800 animate-pulse" />
      </div>
      <div class="flex justify-end">
        <div class="h-12 w-44 max-w-[70%] rounded-2xl bg-neutral-800/80 animate-pulse" />
      </div>
    </div>
  );
}
