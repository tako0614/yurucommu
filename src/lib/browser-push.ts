import {
  clearBrowserNotificationPush,
  createBrowserPushConfigResolver,
  disableBrowserNotificationPush,
  type BrowserNotificationPushConfig,
} from "@takosjp/yurucommu-api";

const browserPushIdentity = {
  product: "yurucommu" as const,
  appId: "jp.takos.yurucommu.web",
  appDisplayName: "Yurucommu",
  serviceWorkerPath: "/notification-push-sw.js",
};

/**
 * The shared yurucommu-core resolver owns which runtime values enable browser
 * push: the instance's own VAPID key from
 * `GET /api/notifications/pushers/config`. There is no build-time fallback
 * and no gateway: the instance sends standard Web Push itself.
 */
function resolver() {
  return createBrowserPushConfigResolver({
    identity: {
      ...browserPushIdentity,
      ...(currentLanguage() ? { lang: currentLanguage()! } : {}),
    },
    resolveServerOrigin: () =>
      typeof window === "undefined" ? null : window.location.origin,
  });
}

/** The UI language (<html lang>, kept in sync by atoms/i18n.ts) for push text. */
function currentLanguage(): string | null {
  if (typeof document === "undefined") return null;
  const lang = document.documentElement.lang.trim();
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null;
}

export async function resolveYurucommuBrowserPushConfig(): Promise<BrowserNotificationPushConfig | null> {
  return resolver().resolveConfig();
}

export async function clearYurucommuBrowserPushBeforeSignOut(): Promise<void> {
  const config = await resolveYurucommuBrowserPushConfig().catch(() => null);
  if (config) {
    try {
      await disableBrowserNotificationPush(config);
      return;
    } catch {
      // Fall through to local endpoint invalidation.
    }
  }
  await clearBrowserNotificationPush(browserPushIdentity).catch(
    () => undefined,
  );
}
