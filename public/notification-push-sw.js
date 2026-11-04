// Shows standard Web Push messages from this Yurucommu instance. The payload
// is Declarative Web Push ({"web_push": 8030, "notification": {...}}), which
// Safari 18.4+ and Takosumi Mobile display without this worker; Chrome,
// Firefox and older Safari display the same fields here.
const fallbackUrl = "/notifications";

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event.data));
});

async function showPush(data) {
  let message;
  try {
    message = data?.json();
  } catch {
    message = undefined;
  }
  const n =
    message?.web_push === 8030 && typeof message.notification === "object"
      ? message.notification
      : undefined;
  const text = (value) =>
    typeof value === "string" && value ? value : undefined;
  const shown = self.registration.showNotification(
    text(n?.title) ?? "Yurucommu",
    {
      body: n
        ? text(n.body)
        : "新しい通知があります。Yurucommuで確認してください。",
      tag: text(n?.tag) ?? "yurucommu-notification",
      lang: text(n?.lang),
      icon: "/icons/yurucommu.svg",
      data: { url: sameOriginUrl(n?.navigate) },
    },
  );
  const badge = Number(n?.app_badge);
  const badged =
    n?.app_badge !== undefined && Number.isSafeInteger(badge) && badge >= 0
      ? (badge === 0
          ? self.navigator.clearAppBadge?.()
          : self.navigator.setAppBadge?.(badge)
        )?.catch(() => undefined)
      : undefined;
  await Promise.all([shown, badged]);
}

// Never open another origin from a push, whatever the payload says.
function sameOriginUrl(value) {
  try {
    if (typeof value !== "string" || !value) throw new TypeError("no url");
    const url = new URL(value, self.location.origin);
    if (url.origin === self.location.origin) return url.href;
  } catch {
    // fall through
  }
  return new URL(fallbackUrl, self.location.origin).href;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openProductWindow(event.notification.data?.url));
});

async function openProductWindow(url) {
  const target = sameOriginUrl(url);
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    try {
      await client.navigate(target);
    } catch {
      // A window this worker does not control yet cannot be navigated.
    }
    return await client.focus();
  }
  return await self.clients.openWindow(target);
}
