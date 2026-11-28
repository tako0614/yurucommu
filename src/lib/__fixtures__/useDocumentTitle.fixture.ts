import assert from "node:assert/strict";
import { createRoot, createSignal } from "solid-js";
import { APP_TITLE, useDocumentTitle } from "../useDocumentTitle.ts";

const doc = { title: APP_TITLE };
Object.defineProperty(globalThis, "document", {
  value: doc,
  configurable: true,
  writable: true,
});

const scenario = process.argv[2];

if (scenario === "sync-and-cleanup") {
  let setSection!: (next: string | null | undefined) => void;
  const dispose = createRoot((d) => {
    const [section, update] = createSignal<string | null | undefined>("通知");
    setSection = update;
    useDocumentTitle(section);
    return d;
  });
  try {
    assert.equal(doc.title, `通知 — ${APP_TITLE}`);

    setSection("Notifications");
    assert.equal(doc.title, `Notifications — ${APP_TITLE}`);

    setSection("");
    assert.equal(doc.title, APP_TITLE);

    setSection("プロフィール");
    assert.equal(doc.title, `プロフィール — ${APP_TITLE}`);
  } finally {
    dispose();
  }
  assert.equal(doc.title, APP_TITLE);
} else if (scenario === "no-clobber-newer-view") {
  const disposeOld = createRoot((d) => {
    const [section] = createSignal("設定");
    useDocumentTitle(section);
    return d;
  });
  assert.equal(doc.title, `設定 — ${APP_TITLE}`);

  const disposeNew = createRoot((d) => {
    const [section] = createSignal("ホーム");
    useDocumentTitle(section);
    return d;
  });
  assert.equal(doc.title, `ホーム — ${APP_TITLE}`);

  // Disposing the older view after a newer view already updated document.title
  // must not reset the tab title back to APP_TITLE.
  disposeOld();
  assert.equal(doc.title, `ホーム — ${APP_TITLE}`);

  // Disposing the active view that still owns document.title restores APP_TITLE.
  disposeNew();
  assert.equal(doc.title, APP_TITLE);
} else {
  throw new Error(`Unknown scenario: ${scenario}`);
}

console.log(JSON.stringify({ scenario, passed: true }));
