import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Runs the real public/notification-push-sw.js against a fake
// ServiceWorkerGlobalScope and dispatches push / notificationclick events.
const source = readFileSync(
  new URL("../../public/notification-push-sw.js", import.meta.url),
  "utf8",
);
const ORIGIN = "https://yurucommu.example";

type Shown = { title: string; options: Record<string, unknown> };

function loadWorker(options: { badging?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const badges: Array<number | "cleared"> = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const focused: string[] = [];
  const windows: Array<{
    url: string;
    navigate(url: string): Promise<unknown>;
    focus(): Promise<unknown>;
  }> = [];
  const scope = {
    location: new URL(`${ORIGIN}/notification-push-sw.js`),
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, listener);
    },
    registration: {
      async showNotification(title: string, opts: Record<string, unknown>) {
        shown.push({ title, options: opts });
      },
    },
    navigator: options.badging
      ? {
          async setAppBadge(count: number) {
            badges.push(count);
          },
          async clearAppBadge() {
            badges.push("cleared");
          },
        }
      : {},
    clients: {
      async matchAll() {
        return windows;
      },
      async openWindow(url: string) {
        opened.push(url);
        return null;
      },
    },
  };
  new Function("self", source)(scope);

  async function push(data: unknown) {
    const pending: Promise<unknown>[] = [];
    listeners.get("push")!({
      data:
        data === undefined
          ? null
          : {
              json() {
                if (typeof data === "string") return JSON.parse(data);
                return data;
              },
            },
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    });
    await Promise.all(pending);
  }

  async function click(url: unknown) {
    const pending: Promise<unknown>[] = [];
    listeners.get("notificationclick")!({
      notification: { data: { url }, close() {} },
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    });
    await Promise.all(pending);
  }

  function addWindow(url: string, controlled = true) {
    windows.push({
      url,
      async navigate(target: string) {
        if (!controlled) throw new TypeError("not controlled");
        navigated.push(target);
        return this;
      },
      async focus() {
        focused.push(url);
        return this;
      },
    });
  }

  return { push, click, addWindow, shown, badges, opened, navigated, focused };
}

test("a Declarative Web Push message is shown with its own fields", async () => {
  const worker = loadWorker({ badging: true });
  await worker.push({
    web_push: 8030,
    notification: {
      title: "Yurucommu",
      body: "さくらさんがあなたをフォローしました",
      navigate: `${ORIGIN}/notifications`,
      lang: "ja-JP",
      tag: "notifications",
      app_badge: "3",
    },
  });
  expect(worker.shown).toEqual([
    {
      title: "Yurucommu",
      options: {
        body: "さくらさんがあなたをフォローしました",
        tag: "notifications",
        lang: "ja-JP",
        icon: "/icons/yurucommu.svg",
        data: { url: `${ORIGIN}/notifications` },
      },
    },
  ]);
  expect(worker.badges).toEqual([3]);

  await worker.push({
    web_push: 8030,
    notification: { title: "Yurucommu", navigate: "/", app_badge: "0" },
  });
  expect(worker.badges).toEqual([3, "cleared"]);
});

test("unknown, empty or broken payloads still show a generic notification", async () => {
  const worker = loadWorker();
  await worker.push(undefined);
  await worker.push("{not json");
  await worker.push({ notification: { title: "no magic number" } });
  expect(worker.shown).toHaveLength(3);
  for (const { title, options } of worker.shown) {
    expect(title).toBe("Yurucommu");
    expect(options.body).toBe(
      "新しい通知があります。Yurucommuで確認してください。",
    );
    expect(options.data).toEqual({ url: `${ORIGIN}/notifications` });
  }
});

test("a navigate target on another origin is replaced by the app's own page", async () => {
  const worker = loadWorker();
  for (const navigate of [
    "https://evil.example/phish",
    "//evil.example/x",
    "javascript:alert(1)",
    42,
  ]) {
    await worker.push({
      web_push: 8030,
      notification: { title: "Yurucommu", navigate },
    });
  }
  expect(worker.shown.map(({ options }) => options.data)).toEqual(
    Array(4).fill({ url: `${ORIGIN}/notifications` }),
  );
});

test("a click focuses a same-origin window, navigating it when it is controlled", async () => {
  const worker = loadWorker();
  worker.addWindow("https://other.example/");
  worker.addWindow(`${ORIGIN}/home`);
  await worker.click(`${ORIGIN}/notifications`);
  expect(worker.navigated).toEqual([`${ORIGIN}/notifications`]);
  expect(worker.focused).toEqual([`${ORIGIN}/home`]);
  expect(worker.opened).toEqual([]);

  const uncontrolled = loadWorker();
  uncontrolled.addWindow(`${ORIGIN}/home`, false);
  await uncontrolled.click(`${ORIGIN}/notifications`);
  expect(uncontrolled.focused).toEqual([`${ORIGIN}/home`]);

  const fresh = loadWorker();
  await fresh.click("https://evil.example/");
  expect(fresh.opened).toEqual([`${ORIGIN}/notifications`]);
});
