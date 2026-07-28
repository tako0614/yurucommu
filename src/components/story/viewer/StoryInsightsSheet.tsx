/**
 * Author-only Story insights ("seen by") bottom sheet.
 *
 * Surfaces the analytics the backend already collects but never showed the
 * author: who viewed the story (from the new `GET /stories/:id/views`), the poll
 * tally (embedded on the story), and the share count. Opening it pauses story
 * playback (handled by the parent viewer).
 */

import { createResource, For, Show } from "solid-js";
import type { Story, StoryOverlay } from "../../../types/index.ts";
import { getStoryViewers } from "../../../lib/api.ts";
import { useI18n } from "../../../lib/i18n.tsx";
import { useDialog } from "../../../lib/useDialog.ts";
import { formatRelativeTime } from "../../../lib/datetime.ts";

interface StoryInsightsSheetProps {
  open: boolean;
  story: Story;
  locale: string;
  onClose: () => void;
}

function questionOverlay(story: Story): StoryOverlay | undefined {
  return story.overlays?.find((o) => o.type === "Question" && o.oneOf);
}

export function StoryInsightsSheet(props: StoryInsightsSheetProps) {
  const { t } = useI18n();
  let sheetRef: HTMLDivElement | undefined;
  // Shared dialog primitive (same as StoryViewerDeleteDialog): registers on
  // top of the viewer's own dialog-stack entry, so Escape closes the SHEET
  // (not the whole viewer), Tab is trapped inside it, and focus is restored
  // to the opener on close.
  useDialog({
    isOpen: () => props.open,
    onClose: () => props.onClose(),
    container: () => sheetRef,
  });

  // Fetch viewers whenever the sheet is open for a given story.
  const [viewers, { refetch }] = createResource(
    () => (props.open ? props.story.ap_id : null),
    (apId) => getStoryViewers(apId),
  );

  const poll = () => questionOverlay(props.story);
  const votes = () => props.story.votes ?? {};
  const votesTotal = () => props.story.votes_total ?? 0;

  return (
    <Show when={props.open}>
      {/* stopPropagation (click AND press events): the sheet renders inside
          the viewer's tap-zone container — a bubbled click would navigate the
          story underneath (swapping the sheet's data mid-read), and a bubbled
          mousedown/touchstart would arm the viewer's hold-to-pause whose
          release then resumes playback behind the open sheet. */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("story.insights.title")}
        class="absolute inset-0 z-40 flex items-end"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label={t("common.close")}
          class="absolute inset-0 bg-black/50"
          onClick={props.onClose}
        />
        <div class="relative max-h-[70%] w-full overflow-y-auto rounded-t-2xl bg-neutral-900 p-4 text-white">
          <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-white/30" />

          <div class="mb-4 flex items-baseline justify-between">
            <h3 class="text-base font-semibold">{t("story.insights.title")}</h3>
            {/* On a failed fetch the count is unknown — showing "seen by 0"
                would be a lie; the error + retry renders in the list below. */}
            <Show when={!viewers.error}>
              <span class="text-sm text-white/60">
                {t("story.insights.seenBy").replace(
                  "{count}",
                  String(viewers()?.view_count ?? 0),
                )}
              </span>
            </Show>
          </div>

          {/* Poll results (if the story has a poll) */}
          <Show when={poll()}>
            {(p) => (
              <div class="mb-4 rounded-xl bg-white/5 p-3">
                <p class="mb-2 text-sm font-medium">
                  {t("story.insights.pollResults")}
                </p>
                <p class="mb-2 text-sm text-white/80">{p().name}</p>
                <div class="space-y-1.5">
                  <For each={p().oneOf}>
                    {(option, index) => {
                      const count = () => votes()[index()] ?? 0;
                      const pct = () =>
                        votesTotal() > 0
                          ? Math.round((count() / votesTotal()) * 100)
                          : 0;
                      return (
                        <div class="relative overflow-hidden rounded-lg bg-white/10 px-3 py-1.5 text-sm">
                          <div
                            class="absolute inset-y-0 left-0 bg-white/15"
                            style={{ width: `${pct()}%` }}
                          />
                          <span class="relative flex items-center justify-between">
                            <span>{option.name}</span>
                            <span class="text-xs text-white/70">
                              {pct()}% · {count()}
                            </span>
                          </span>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            )}
          </Show>

          {/* Share count */}
          <Show when={(props.story.share_count ?? 0) > 0}>
            <p class="mb-4 text-sm text-white/70">
              {t("story.insights.shares")}: {props.story.share_count}
            </p>
          </Show>

          {/* Viewer list */}
          <p class="mb-2 text-sm font-medium">{t("story.insights.viewers")}</p>
          <Show
            when={!viewers.error}
            fallback={
              <div class="flex items-center gap-3">
                <p class="text-sm text-white/50">
                  {t("story.insights.loadFailed")}
                </p>
                <button
                  type="button"
                  class="text-sm font-medium text-white underline underline-offset-2"
                  onClick={() => void refetch()}
                >
                  {t("common.retry")}
                </button>
              </div>
            }
          >
            <Show
              when={(viewers()?.viewers.length ?? 0) > 0}
              fallback={
                <p class="text-sm text-white/50">
                  {t("story.insights.noViews")}
                </p>
              }
            >
              <ul class="space-y-2">
                <For each={viewers()!.viewers}>
                  {(v) => (
                    <li class="flex items-center gap-3">
                      <img
                        src={
                          v.actor.icon_url ??
                          `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(
                            v.actor.preferred_username,
                          )}`
                        }
                        alt=""
                        class="h-8 w-8 rounded-full object-cover"
                      />
                      <span class="flex-1 truncate text-sm">
                        {v.actor.name || v.actor.preferred_username}
                      </span>
                      <span class="text-xs text-white/50">
                        {formatRelativeTime(v.viewed_at, {
                          maxDays: 1,
                          locale: props.locale,
                        })}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}

export default StoryInsightsSheet;
