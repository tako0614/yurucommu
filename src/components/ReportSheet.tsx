import { createSignal, createEffect, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useI18n } from "../lib/i18n.tsx";
import { useDialog } from "../lib/useDialog.ts";
import { isComposingKey } from "./ime.ts";
import { submitShortcutLabel } from "../lib/shortcuts.ts";

interface ReportSheetProps {
  open: boolean;
  busy?: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}

const MAX_REASON = 1000;

/**
 * Reason-collecting sheet for an outbound abuse report. Mirrors ConfirmSheet
 * (Portal + useDialog + bottom-sheet/centered card) but adds an optional reason
 * textarea. The reason is reset whenever the sheet opens.
 */
export function ReportSheet(props: ReportSheetProps) {
  const { t } = useI18n();
  const [reason, setReason] = createSignal("");
  let dialogRef: HTMLDivElement | undefined;

  // Clear the field each time the sheet (re)opens so a prior draft never leaks
  // into the next report.
  createEffect(() => {
    if (props.open) setReason("");
  });

  const requestClose = () => {
    if (!props.busy) props.onCancel();
  };

  useDialog({
    isOpen: () => props.open,
    onClose: requestClose,
    container: () => dialogRef,
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) requestClose();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("report.title")}
            class="w-full max-w-sm rounded-t-2xl border border-neutral-800 bg-neutral-900 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:pb-5"
          >
            <h2 class="text-base font-bold text-white">{t("report.title")}</h2>
            <p class="mt-2 text-sm text-neutral-400">{t("report.hint")}</p>
            <textarea
              value={reason()}
              maxLength={MAX_REASON}
              disabled={props.busy}
              onInput={(e) =>
                setReason(e.currentTarget.value.slice(0, MAX_REASON))
              }
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === "Enter" &&
                  !isComposingKey(e)
                ) {
                  e.preventDefault();
                  if (!props.busy) props.onSubmit(reason().trim());
                }
              }}
              placeholder={t("report.reasonPlaceholder")}
              aria-label={t("report.reasonPlaceholder")}
              rows={3}
              class="mt-3 w-full resize-none rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-accent focus:outline-none disabled:opacity-50"
            />
            <div class="mt-1.5 flex items-center justify-between text-xs text-neutral-500">
              <span class="hidden sm:inline">
                {t("report.submitHint").replace(
                  "{shortcut}",
                  submitShortcutLabel(),
                )}
              </span>
              <span class="ml-auto tabular-nums">
                {t("posts.charCount")
                  .replace("{count}", String(reason().length))
                  .replace("{max}", String(MAX_REASON))}
              </span>
            </div>
            <div class="mt-4 flex gap-2">
              <button
                type="button"
                onClick={requestClose}
                disabled={props.busy}
                class="flex-1 min-h-11 md:min-h-0 rounded-full bg-neutral-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => props.onSubmit(reason().trim())}
                disabled={props.busy}
                class="flex-1 min-h-11 md:min-h-0 rounded-full bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {t("report.submit")}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
