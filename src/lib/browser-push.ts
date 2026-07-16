import {
  clearBrowserNotificationPush,
  disableBrowserNotificationPush,
  fetchNotificationPusherPublicConfig,
  type BrowserNotificationPushConfig,
} from "@takosjp/yurucommu-api";

const browserPushIdentity = {
  product: "yurucommu" as const,
  appId: "jp.takos.yurucommu.web",
  serviceWorkerPath: "/notification-push-sw.js",
};

export function yurucommuBrowserPushConfig(): BrowserNotificationPushConfig | null {
  const env = (
    import.meta as unknown as {
      readonly env?: Readonly<Record<string, string | undefined>>;
    }
  ).env;
  const gatewayUrl = env?.VITE_YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_URL?.trim();
  const vapidPublicKey = env?.VITE_YURUCOMMU_WEB_PUSH_PUBLIC_KEY?.trim();
  if (!gatewayUrl || !vapidPublicKey) return null;
  return createConfig(gatewayUrl, vapidPublicKey);
}

export async function resolveYurucommuBrowserPushConfig(): Promise<BrowserNotificationPushConfig | null> {
  try {
    const runtime = await fetchNotificationPusherPublicConfig();
    if (
      !runtime.enabled ||
      !runtime.gateway_url ||
      !runtime.web_push_public_key
    ) {
      return null;
    }
    return createConfig(runtime.gateway_url, runtime.web_push_public_key);
  } catch {
    // Compatibility with older servers while they roll forward. Build-time
    // public values are a fallback only; a responding runtime config is the
    // deployment authority.
    return yurucommuBrowserPushConfig();
  }
}

function createConfig(
  gatewayUrl: string,
  vapidPublicKey: string,
): BrowserNotificationPushConfig | null {
  if (typeof window === "undefined") return null;
  return {
    ...browserPushIdentity,
    appDisplayName: "Yurucommu",
    serverOrigin: window.location.origin,
    gatewayUrl,
    vapidPublicKey,
  };
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
