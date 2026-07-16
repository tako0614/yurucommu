const notificationUrl = "/notifications";

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Yurucommu", {
      body: "新しい通知があります。Yurucommuで確認してください。",
      tag: "yurucommu-notification",
      icon: "/icons/yurucommu.svg",
      data: { url: notificationUrl },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openProductWindow(event.notification.data?.url));
});

async function openProductWindow(path) {
  const target = new URL(path || notificationUrl, self.location.origin).href;
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    await client.navigate(target);
    return await client.focus();
  }
  return await self.clients.openWindow(target);
}
