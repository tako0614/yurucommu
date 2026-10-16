import {
  createSignal,
  ErrorBoundary,
  lazy,
  onCleanup,
  Show,
  Suspense,
} from "solid-js";
import { useAtomValue } from "solid-jotai";
import { actorAtom } from "../../atoms/auth.ts";
import { useI18n } from "../../lib/i18n.tsx";

// The QR sheet (and its scanner) only loads when the owner asks for it.
const QRCodeModal = lazy(() =>
  import("../QRCodeModal.tsx").then((m) => ({ default: m.QRCodeModal })),
);

/**
 * `@user@host` with a line break offered before the host, so a narrow screen
 * wraps "@you / @social.example" instead of mid-word.
 */
function AddressText(props: { address: string }) {
  const split = () => props.address.lastIndexOf("@");
  return (
    <Show when={split() > 0} fallback={props.address}>
      {props.address.slice(0, split())}
      <wbr />
      {props.address.slice(split())}
    </Show>
  );
}

/**
 * The owner's own federated address with copy and the QR sheet, so people on
 * other servers can find and follow them. Renders nothing until the actor's
 * `username` (user@host) is known.
 */
export function OwnAddressPanel(props: {
  /** Narrow placement (the desktop right column): smaller address text. */
  compact?: boolean;
  /** Classes for the panel's outer element (not rendered without an address). */
  class?: string;
}) {
  const { t } = useI18n();
  const actor = useAtomValue(actorAtom);
  // Short-lived status next to the buttons (also announced).
  const [notice, setNotice] = createSignal<
    "copied" | "copyFailed" | "qrFailed" | null
  >(null);
  const [showQr, setShowQr] = createSignal(false);
  let addressText: HTMLParagraphElement | undefined;
  let noticeReset: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(noticeReset));

  const announce = (next: "copied" | "copyFailed" | "qrFailed") => {
    clearTimeout(noticeReset);
    // Clear first, then set after a beat, so a repeated message is a new
    // announcement rather than a no-op change screen readers may merge.
    setNotice(null);
    noticeReset = setTimeout(() => {
      setNotice(next);
      noticeReset = setTimeout(() => setNotice(null), 3000);
    }, 100);
  };

  // `username` is the federated handle (user@host) others search for.
  const ownAddress = () => {
    const username = actor()?.username;
    return username?.includes("@") ? `@${username}` : null;
  };

  const noticeText = () => {
    switch (notice()) {
      case "copied":
        return t("firstFeed.copied");
      case "copyFailed":
        return t("firstFeed.copyFailed");
      case "qrFailed":
        return t("firstFeed.qrFailed");
      default:
        return "";
    }
  };

  const copyAddress = async () => {
    const address = ownAddress();
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      announce("copied");
    } catch {
      // No clipboard (e.g. a plain-HTTP self-host): select the address so it
      // can be copied by hand.
      if (addressText) {
        const range = document.createRange();
        range.selectNodeContents(addressText);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      announce("copyFailed");
    }
  };

  return (
    <Show when={ownAddress()}>
      {(address) => (
        <div class={props.class}>
          <p class="text-sm font-medium text-neutral-200">
            {t("firstFeed.yourAddress")}
          </p>
          <p
            ref={addressText}
            class={`mt-1 text-neutral-100 select-all wrap-anywhere ${
              props.compact ? "text-sm" : "text-base"
            }`}
          >
            <AddressText address={address()} />
          </p>
          <p class="mt-1 text-xs leading-relaxed text-neutral-400">
            {t("firstFeed.yourAddressHint")}
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copyAddress()}
              class="rounded-full border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
            >
              {t("firstFeed.copyAddress")}
            </button>
            <button
              type="button"
              onClick={() => setShowQr(true)}
              aria-haspopup="dialog"
              class="rounded-full border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
            >
              {t("firstFeed.showQr")}
            </button>
            <span role="status" class="self-center text-xs text-neutral-300">
              {noticeText()}
            </span>
          </div>
          <p class="mt-2 text-xs leading-relaxed text-neutral-400">
            {t("firstFeed.qrHint")}
          </p>

          <Show when={showQr() && actor()}>
            {(owner) => (
              <ErrorBoundary
                fallback={() => {
                  // The QR chunk failed to load: close instead of crashing.
                  queueMicrotask(() => {
                    setShowQr(false);
                    announce("qrFailed");
                  });
                  return null;
                }}
              >
                <Suspense>
                  <QRCodeModal
                    actor={owner()}
                    onClose={() => setShowQr(false)}
                  />
                </Suspense>
              </ErrorBoundary>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
