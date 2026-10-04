import { createSignal, Show } from "solid-js";
import type { StoryOverlay } from "../../../types/index.ts";
import type { StoryIntentSnapshot } from "../../../lib/story-intent.ts";
import { useI18n } from "../../../lib/i18n.tsx";
import { ConfirmSheet } from "../../ConfirmSheet.tsx";

interface StoryComposerRecoveryProps {
  snapshot: StoryIntentSnapshot;
  identityChanged: boolean;
  fallbackCaption: string;
  fallbackOverlays: StoryOverlay[];
  onRetry: () => void;
  expired: boolean;
  canRenew: boolean;
  hasRetainedFile: boolean;
  renewError: string | null;
  onRenew: (replacement?: File) => void;
  onDiscard: () => void;
  canResumeEditing: boolean;
  onResumeEditing: () => void;
  onClose: () => void;
  ref: (el: HTMLDivElement) => void;
}

export function StoryComposerRecovery(props: StoryComposerRecoveryProps) {
  const { t } = useI18n();
  const [confirm, setConfirm] = createSignal<
    "retry" | "renew" | "discard" | null
  >(null);
  const [replacement, setReplacement] = createSignal<File | null>(null);
  const record = () => props.snapshot.record;
  const confirmed = () => record()?.status === "confirmed";
  const ready = () => record()?.status === "ready";
  const retryable = () =>
    !!record() &&
    !props.identityChanged &&
    !confirmed() &&
    !props.expired &&
    (!props.snapshot.failed || ready());
  const message = () =>
    confirmed()
      ? t("story.recoveryConfirmed")
      : record()?.status === "rejected"
        ? t("story.recoveryRejected")
        : ready()
          ? t("story.recoveryReady")
          : t("story.recoveryUnconfirmed");
  const retryLabel = () =>
    ready() ? t("story.recoverySend") : t("story.recoveryRetry");
  return (
    <div
      ref={props.ref}
      tabindex="-1"
      role="region"
      aria-label={t("story.recoveryTitle")}
      class="absolute inset-y-0 left-1/2 z-40 flex w-full max-w-xl -translate-x-1/2 flex-col gap-4 overflow-y-auto bg-neutral-950 p-6 text-white [&>*]:shrink-0"
    >
      <h2 class="text-lg font-semibold">{t("story.recoveryTitle")}</h2>
      <div role="alert" class="space-y-2">
        <Show when={record()}>
          <p>{message()}</p>
        </Show>
        <Show when={props.identityChanged}>
          <p>{t("story.recoveryIdentityChanged")}</p>
        </Show>
        <Show when={props.snapshot.failed}>
          <p>{t("story.recoveryStorageFailed")}</p>
          <Show when={confirmed()}>
            <p>{t("story.recoveryConfirmedUnsaved")}</p>
          </Show>
        </Show>
        <Show when={props.expired}>
          <p>{t("story.recoveryMediaExpired")}</p>
          <Show
            when={
              !props.canRenew &&
              !props.identityChanged &&
              !props.snapshot.failed &&
              !confirmed()
            }
          >
            <p>{t("story.recoveryRenewUnsafe")}</p>
          </Show>
        </Show>
        <Show when={props.renewError}>
          <p>{props.renewError}</p>
        </Show>
      </div>
      <Show when={!record()}>
        <textarea
          readonly
          aria-label={t("story.recoveryCaption")}
          value={props.fallbackCaption}
          class="w-full rounded-lg bg-white/10 p-3 min-h-20"
        />
        <textarea
          readonly
          aria-label={t("story.recoveryOverlays")}
          value={props.fallbackOverlays
            .map((overlay) =>
              [
                overlay.name,
                overlay.href,
                ...(overlay.oneOf?.map((option) => option.name) ?? []),
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n")}
          class="w-full rounded-lg bg-white/10 p-3 min-h-20"
        />
      </Show>
      <Show when={record()}>
        {(saved) => (
          <>
            <textarea
              readonly
              aria-label={t("story.recoveryCaption")}
              value={saved().payload.caption ?? ""}
              class="w-full rounded-lg bg-white/10 p-3 min-h-20"
            />
            <Show when={saved().payload.overlays?.length}>
              <textarea
                readonly
                aria-label={t("story.recoveryOverlays")}
                value={
                  saved()
                    .payload.overlays?.map((overlay) =>
                      [
                        overlay.name,
                        overlay.href,
                        ...(overlay.oneOf?.map((option) => option.name) ?? []),
                      ]
                        .filter(Boolean)
                        .join("\n"),
                    )
                    .join("\n\n") ?? ""
                }
                class="w-full rounded-lg bg-white/10 p-3 min-h-20"
              />
            </Show>
            <Show
              when={!props.snapshot.failed && !confirmed() && !props.expired}
            >
              <p class="text-sm text-white/70">{t("story.recoverySaved")}</p>
            </Show>
            <Show when={confirmed()}>
              <p class="text-sm break-all">{saved().serverId}</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.canResumeEditing}>
        <button
          class="rounded-full border border-white/40 px-4 py-3"
          onClick={props.onResumeEditing}
        >
          {t("story.recoveryEdit")}
        </button>
      </Show>
      <Show when={retryable()}>
        <button
          class="rounded-full bg-accent px-4 py-3"
          onClick={() => setConfirm("retry")}
        >
          {retryLabel()}
        </button>
      </Show>
      <Show when={props.canRenew}>
        <p class="text-sm text-white/70">
          {t("story.recoveryRenewExplanation")}
        </p>
        <Show when={!props.hasRetainedFile || !!props.renewError}>
          <label class="text-sm" for="story-recovery-replacement">
            {t("story.recoverySelectReplacement")}
          </label>
          <input
            id="story-recovery-replacement"
            type="file"
            accept="image/jpeg,video/mp4"
            class="block w-full text-sm text-white"
            onChange={(event) =>
              setReplacement(event.currentTarget.files?.[0] ?? null)
            }
          />
          <Show when={replacement()}>
            <p class="text-sm break-all">{replacement()?.name}</p>
          </Show>
        </Show>
        <button
          class="rounded-full border border-white/40 px-4 py-3 disabled:opacity-50"
          disabled={!props.hasRetainedFile && !replacement()}
          onClick={() => setConfirm("renew")}
        >
          {t("story.recoveryRenew")}
        </button>
      </Show>
      <button
        class="rounded-full border border-white/40 px-4 py-3"
        onClick={props.onClose}
      >
        {props.snapshot.failed
          ? t("story.recoveryCloseUnsaved")
          : t("story.recoveryClose")}
      </button>
      <Show when={record() && !props.snapshot.failed}>
        <button
          class="rounded-full px-4 py-3 text-red-300"
          onClick={() => setConfirm("discard")}
        >
          {t("story.recoveryDiscard")}
        </button>
      </Show>
      <ConfirmSheet
        open={confirm() !== null}
        zIndex={53}
        title={
          confirm() === "retry"
            ? retryLabel()
            : confirm() === "renew"
              ? t("story.recoveryRenew")
              : t("story.recoveryDiscard")
        }
        body={
          confirm() === "retry"
            ? ready()
              ? t("story.recoverySendBody")
              : t("story.recoveryRetryBody")
            : confirm() === "renew"
              ? t("story.recoveryRenewBody")
              : t("story.recoveryDiscardBody")
        }
        confirmLabel={
          confirm() === "retry"
            ? retryLabel()
            : confirm() === "renew"
              ? t("story.recoveryRenew")
              : t("story.recoveryDiscard")
        }
        cancelLabel={t("posts.keepEditing")}
        destructive={confirm() === "discard"}
        onConfirm={() => {
          const action = confirm();
          setConfirm(null);
          if (action === "retry") props.onRetry();
          else if (action === "renew")
            props.onRenew(replacement() ?? undefined);
          else props.onDiscard();
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
