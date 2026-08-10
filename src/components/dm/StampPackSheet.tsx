import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";

import {
  installStampPack,
  type MessageStampSnapshot,
} from "../../lib/api/stamps.ts";
import { useI18n } from "../../lib/i18n.tsx";

interface StampPackSheetProps {
  stamp: MessageStampSnapshot | null;
  onClose: () => void;
}

export function StampPackSheet(props: StampPackSheetProps) {
  const [installing, setInstalling] = createSignal(false);
  const [installed, setInstalled] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const { t } = useI18n();

  const publisher = createMemo(() => {
    const stamp = props.stamp;
    if (!stamp) return "";
    try {
      return new URL(stamp.pack_id).host;
    } catch {
      return stamp.pack_id;
    }
  });

  createEffect(() => {
    if (!props.stamp) return;
    setInstalled(false);
    setCopied(false);
    setError(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  const install = async () => {
    const stamp = props.stamp;
    if (!stamp || installing()) return;
    setInstalling(true);
    setError(null);
    try {
      await installStampPack(stamp.pack_id);
      setInstalled(true);
    } catch (cause) {
      console.error("Failed to install Stamp pack:", cause);
      setError(cause instanceof Error ? cause.message : t("common.error"));
    } finally {
      setInstalling(false);
    }
  };

  const copyLink = async () => {
    const stamp = props.stamp;
    if (!stamp) return;
    try {
      await navigator.clipboard.writeText(stamp.pack_id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (cause) {
      console.error("Failed to copy Stamp pack link:", cause);
    }
  };

  return (
    <Show when={props.stamp}>
      {(stamp) => (
        <div
          class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) props.onClose();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t("dm.stampPack")}
            class="w-full max-w-sm rounded-3xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
          >
            <div class="flex items-start justify-between">
              <div>
                <div class="text-lg font-semibold text-white">
                  {t("dm.stampPack")}
                </div>
                <div class="mt-0.5 text-xs text-neutral-500">{publisher()}</div>
              </div>
              <button
                type="button"
                onClick={props.onClose}
                aria-label={t("common.close")}
                class="rounded-full p-2 text-neutral-500 hover:bg-neutral-800 hover:text-white"
              >
                <svg
                  class="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-width="2"
                    d="M6 6l12 12M18 6L6 18"
                  />
                </svg>
              </button>
            </div>

            <div class="my-5 grid place-items-center">
              <img
                src={stamp().asset.url}
                alt={stamp().alt}
                class="h-36 w-36 object-contain"
              />
              <div class="mt-2 text-sm text-neutral-300">{stamp().alt}</div>
            </div>

            <Show when={error()}>
              <div class="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error()}
              </div>
            </Show>

            <div class="flex gap-2">
              <button
                type="button"
                onClick={copyLink}
                class="flex-1 rounded-full bg-neutral-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700"
              >
                {copied() ? t("dm.stampLinkCopied") : t("dm.stampShare")}
              </button>
              <button
                type="button"
                onClick={install}
                disabled={installing() || installed()}
                class="flex-1 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              >
                {installed()
                  ? t("dm.stampAdded")
                  : installing()
                    ? t("dm.stampAdding")
                    : t("dm.stampAddPack")}
              </button>
            </div>
          </section>
        </div>
      )}
    </Show>
  );
}
