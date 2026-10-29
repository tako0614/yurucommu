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
 * push: the instance's `GET /api/notifications/pushers/config`, with the
 * build-time values below only as an offline fallback. On a core that sends
 * standard Web Push itself, the instance's own VAPID key is enough.
 */
function resolver() {
  return createBrowserPushConfigResolver({
    identity: {
      ...browserPushIdentity,
      ...(currentLanguage() ? { lang: currentLanguage()! } : {}),
    },
    resolveServerOrigin: () =>
      typeof window === "undefined" ? null : window.location.origin,
    buildTimeValues: () => {
      const env = (
        import.meta as unknown as {
          readonly env?: Readonly<Record<string, string | undefined>>;
        }
      ).env;
      return {
        gatewayUrl: env?.VITE_YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_URL,
        vapidPublicKey: env?.VITE_YURUCOMMU_WEB_PUSH_PUBLIC_KEY,
      };
    },
  });
}

/** The UI language (<html lang>, kept in sync by atoms/i18n.ts) for push text. */
function currentLanguage(): string | null {
  if (typeof document === "undefined") return null;
  const lang = document.documentElement.lang.trim();
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null;
}

export function yurucommuBrowserPushConfig(): BrowserNotificationPushConfig | null {
  return resolver().buildTimeConfig();
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
