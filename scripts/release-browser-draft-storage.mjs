// Browser/native qualification for post acknowledgement racing with a newer
// same-origin persisted draft. This candidate does not seed actors or sessions.
import { createHash, randomUUID } from "node:crypto";

const TIMEOUT_MS = 15_000;
const DRAFT_KEYS = [
  "compose.draft.content",
  "compose.draft.summary",
  "compose.draft.visibility",
];
const RETAINED_STATUS =
  "投稿は送信済みです。下書きが変わったか、保存状態を確認できないため残しています。続ける前に送信済みの投稿を確認してください。";

function assert(condition, label, detail = "") {
  if (!condition) {
    throw new Error(
      `browser-draft-storage ${label}${detail ? `: ${detail}` : ""}`,
    );
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gate(label) {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { label, promise, resolve, reject };
}

async function waitGate(item, timeoutMs = TIMEOUT_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`browser-draft-storage ${item.label} timed out`)),
      timeoutMs,
    );
  });
  deadline.catch(() => {});
  try {
    return await Promise.race([item.promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitVisible(locator, label) {
  const pending = locator.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  pending.catch(() => {});
  try {
    await pending;
  } catch {
    throw new Error(`browser-draft-storage ${label} did not become visible`);
  }
}

function installDelayedDraftStorageEvents(page) {
  return page.addInitScript((draftKeys) => {
    const queue = [];
    let replaying = false;
    window.addEventListener(
      "storage",
      (event) => {
        if (
          !replaying &&
          (event.key === null || draftKeys.includes(event.key))
        ) {
          queue.push({
            key: event.key,
            oldValue: event.oldValue,
            newValue: event.newValue,
          });
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    window.__draftStorageEventCount = () => queue.length;
    window.__takeDraftStorageEvents = () => queue.splice(0, queue.length);
    window.__dispatchDraftStorageEvents = (descriptors) => {
      replaying = true;
      try {
        for (const descriptor of descriptors) {
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: descriptor.key,
              oldValue: descriptor.oldValue,
              newValue: descriptor.newValue,
              url: location.href,
              storageArea: localStorage,
            }),
          );
        }
      } finally {
        replaying = false;
      }
    };
  }, DRAFT_KEYS);
}

async function readDraftStorage(page) {
  return page.evaluate(() => {
    const read = (key) => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "null");
      } catch {
        return { invalidJson: true };
      }
    };
    return {
      body: read("compose.draft.content"),
      summary: read("compose.draft.summary"),
      visibility: read("compose.draft.visibility"),
    };
  });
}

async function readDraftDom(dialog) {
  return {
    body: await dialog.getByPlaceholder("今なにしてる？").inputValue(),
    summary: (await dialog.getByPlaceholder("内容に関する注釈（任意）").count())
      ? await dialog.getByPlaceholder("内容に関する注釈（任意）").inputValue()
      : "",
    visibility: await dialog.locator("#post-visibility").inputValue(),
  };
}

async function observeBootAuthMe(page, appUrl, label) {
  const responsePromise = page.waitForResponse(
    (response) => {
      try {
        const request = response.request();
        return (
          request.method() === "GET" &&
          new URL(response.url()).pathname === "/api/auth/me"
        );
      } catch {
        return false;
      }
    },
    { timeout: TIMEOUT_MS },
  );
  responsePromise.catch(() => {});
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  let response;
  try {
    response = await responsePromise;
  } catch {
    throw new Error(
      `browser-draft-storage ${label} did not observe the app boot session request`,
    );
  }
  const body = await response.json().catch(() => null);
  const identity = {
    status: response.status(),
    actorApId: body?.actor?.ap_id ?? null,
    role: body?.actor?.role ?? null,
  };
  assert(
    identity.status === 200 && identity.actorApId && identity.role === "owner",
    `${label}-boot-session-response-invalid`,
  );
  return identity;
}

async function waitDraftDom(page, draft, label) {
  const pending = page.waitForFunction(
    (expected) => {
      const dialog = document.querySelector(
        '[role="dialog"][aria-label="今なにしてる？"]',
      );
      if (!dialog) return false;
      const body = dialog.querySelector(
        'textarea[placeholder="今なにしてる？"]',
      )?.value;
      const summary =
        dialog.querySelector('input[placeholder="内容に関する注釈（任意）"]')
          ?.value ?? "";
      const visibility = dialog.querySelector("#post-visibility")?.value;
      return (
        body === expected.body &&
        summary === expected.summary &&
        visibility === expected.visibility
      );
    },
    draft,
    { timeout: TIMEOUT_MS },
  );
  pending.catch(() => {});
  try {
    await pending;
  } catch {
    throw new Error(
      `browser-draft-storage ${label} timed out waiting for shared draft UI`,
    );
  }
}

async function waitCapturedStorageEvents(page, expectedCount, label) {
  const pending = page.waitForFunction(
    (count) =>
      typeof window.__draftStorageEventCount === "function" &&
      window.__draftStorageEventCount() >= count,
    expectedCount,
    { timeout: TIMEOUT_MS },
  );
  pending.catch(() => {});
  try {
    await pending;
  } catch {
    throw new Error(
      `browser-draft-storage ${label} timed out waiting for storage events`,
    );
  }
}

async function readNativePost(db, actorApId, content, postId) {
  const note = await db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, summary, visibility, attachments_json FROM objects WHERE ap_id = ?",
    )
    .bind(postId)
    .first();
  const notes = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND attributed_to = ? AND content = ?",
    )
    .bind(actorApId, content)
    .first();
  const creates = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id = ? AND direction = 'outbound'",
    )
    .bind(actorApId, postId)
    .first();
  return { note, notes: notes?.count ?? -1, creates: creates?.count ?? -1 };
}

async function countCreates(db, actorApId) {
  const result = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND direction = 'outbound'",
    )
    .bind(actorApId)
    .first();
  return result?.count ?? -1;
}

async function countContentPosts(db, actorApId, content) {
  const notes = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND attributed_to = ? AND content = ?",
    )
    .bind(actorApId, content)
    .first();
  const creates = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM activities a JOIN objects o ON o.ap_id = a.object_ap_id WHERE a.type = 'Create' AND a.actor_ap_id = ? AND a.direction = 'outbound' AND o.type = 'Note' AND o.attributed_to = ? AND o.content = ?",
    )
    .bind(actorApId, actorApId, content)
    .first();
  return { notes: notes?.count ?? -1, creates: creates?.count ?? -1 };
}

export async function qualifyBrowserDraftStorage({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  assert(page && db, "browser-page-and-native-d1-required");
  assert(Array.isArray(checks), "check-accumulator-required");
  const appOrigin = new URL(origin).origin;
  assert(new URL(actorApId).origin === appOrigin, "owner-origin-mismatch");
  const owner = await db
    .prepare("SELECT ap_id, role, deleted_at FROM actors WHERE ap_id = ?")
    .bind(actorApId)
    .first();
  assert(
    owner?.role === "owner" && owner.deleted_at === null,
    "native-root-owner-required",
  );

  const context = page.context();
  const firstPage = await context.newPage();
  const secondPage = await context.newPage();
  let clearPage = null;
  const appUrl = new URL("/", appOrigin).href;
  const postUrl = new URL("/api/posts", appOrigin).href;
  const originalDraft = {
    body: `draft-storage-original-${randomUUID()}`,
    summary: `draft-storage-original-cw-${randomUUID()}`,
    visibility: "public",
  };
  const newerDraft = {
    body: `draft-storage-newer-${randomUUID()}`,
    summary: `draft-storage-newer-cw-${randomUUID()}`,
    visibility: "unlisted",
  };
  const latestDraft = {
    body: `draft-storage-latest-${randomUUID()}`,
    summary: `draft-storage-latest-cw-${randomUUID()}`,
    visibility: "followers",
  };
  const cleanDraft = {
    body: `draft-storage-clean-success-${randomUUID()}`,
    summary: `draft-storage-clean-success-cw-${randomUUID()}`,
    visibility: "unlisted",
  };
  const intents = new Map();
  const makeIntent = (draft, label, hold) => {
    const intent = {
      ...draft,
      hold,
      attempts: 0,
      committed: gate(`${label}-native-commit`),
      release: gate(`${label}-ack-release`),
      acked: gate(`${label}-browser-ack`),
      proof: null,
    };
    intents.set(intent.body, intent);
    return intent;
  };
  const originalIntent = makeIntent(originalDraft, "held-original-post", true);
  const cleanIntent = makeIntent(cleanDraft, "no-edit-control-post", false);
  const routeHandlers = [];
  const failures = [];
  let postAttempts = 0;
  let totalCreatesBefore = -1;
  let primaryError = null;
  let firstNoteProof = null;
  let cleanNoteProof = null;
  let statusText = null;
  let retainedEventDescriptors = [];
  let latestEventDescriptors = [];
  let nullKeyEventDescriptors = [];
  let newerNoAutoPostCounts = null;
  let latestNoAutoPostCounts = null;
  let createsAfterRetainedAck = null;
  let firstPageProblems = [];
  let secondPageProblems = [];
  let clearPageProblems = [];
  const bootAuth = [];

  const observePage = (target, problems) => {
    target.on("pageerror", (error) =>
      problems.push(`pageerror:${error?.name ?? "Error"}`),
    );
    target.on("response", (response) => {
      if (response.status() >= 500) {
        let path = "unknown";
        try {
          path = new URL(response.url()).pathname;
        } catch {
          // Record only a fixed fallback path on malformed URLs.
        }
        problems.push(`http-${response.status()}:${path}`);
      }
    });
  };

  const routeFailure = async (route, error) => {
    primaryError =
      primaryError ??
      (error instanceof Error
        ? error
        : new Error("browser-draft-storage route failure"));
    try {
      await route.abort("failed");
    } catch {
      // Preserve the first route failure.
    }
  };

  const postRoute = async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    postAttempts += 1;
    let intent;
    try {
      const body = request.postDataJSON();
      intent = intents.get(body?.content);
      assert(intent, "unexpected-post-intent");
      intent.attempts += 1;
      assert(intent.attempts === 1, "duplicate-post-for-intent");
      assert(
        body.content === intent.body && body.summary === intent.summary,
        "post-wire-body-or-cw-mismatch",
      );
      assert(
        (intent.visibility === "public" &&
          (body.visibility === undefined || body.visibility === "public")) ||
          body.visibility === intent.visibility,
        "post-wire-visibility-mismatch",
      );
      assert(
        (body.attachments ?? []).length === 0,
        "draft-storage-control-post-unexpected-attachments",
      );

      const response = await route.fetch();
      let responseBody;
      try {
        responseBody = await response.json();
      } catch {
        throw new Error("real Worker post response was not JSON");
      }
      const post = responseBody?.post;
      assert(
        response.status() === 200 &&
          post?.type === "Note" &&
          post.author?.ap_id === actorApId &&
          post.content === intent.body &&
          post.summary === intent.summary &&
          post.visibility === intent.visibility &&
          typeof post.ap_id === "string" &&
          (post.attachments ?? []).length === 0,
        "real-worker-post-response-did-not-match-submitted-snapshot",
        `status=${response.status()}`,
      );
      const native = await readNativePost(
        db,
        actorApId,
        intent.body,
        post.ap_id,
      );
      assert(
        native.note?.type === "Note" &&
          native.note.attributed_to === actorApId &&
          native.note.content === intent.body &&
          native.note.summary === intent.summary &&
          native.note.visibility === intent.visibility &&
          native.notes === 1 &&
          native.creates === 1 &&
          JSON.stringify(JSON.parse(native.note.attachments_json)) === "[]",
        "native-note-create-did-not-match-exact-submitted-snapshot",
      );
      intent.proof = {
        status: response.status(),
        postId: post.ap_id,
        body: intent.body,
        bodySha256: hash(intent.body),
        summarySha256: hash(intent.summary),
        visibility: intent.visibility,
        native: { notes: native.notes, creates: native.creates },
      };
      intent.committed.resolve(intent.proof);
      if (intent.hold) await waitGate(intent.release);
      await route.fulfill({ response });
      intent.acked.resolve(intent.proof);
    } catch (error) {
      intent?.committed.reject(error);
      intent?.acked.reject(error);
      await routeFailure(route, error);
    }
  };

  const takeEvents = async (target) => {
    const take = await target.evaluate(
      () => window.__takeDraftStorageEvents?.() ?? [],
    );
    return take;
  };

  const dispatchEvents = async (target, descriptors) => {
    await target.evaluate((events) => {
      window.__dispatchDraftStorageEvents?.(events);
    }, descriptors);
  };

  const eventMetadata = (descriptors) =>
    descriptors.map((event) => ({
      key: event.key,
      oldValueSha256: event.oldValue === null ? null : hash(event.oldValue),
      newValueSha256: event.newValue === null ? null : hash(event.newValue),
    }));

  const setDraft = async (dialog, draft) => {
    await dialog.getByPlaceholder("今なにしてる？").fill(draft.body);
    if (
      (await dialog.getByPlaceholder("内容に関する注釈（任意）").count()) === 0
    ) {
      await dialog.getByRole("button", { name: "注釈を追加" }).click();
    }
    await dialog
      .getByPlaceholder("内容に関する注釈（任意）")
      .fill(draft.summary);
    await dialog.locator("#post-visibility").selectOption(draft.visibility);
  };

  let routed = false;
  try {
    await firstPage.setViewportSize({ width: 1280, height: 900 });
    await secondPage.setViewportSize({ width: 1280, height: 900 });
    await installDelayedDraftStorageEvents(firstPage);
    observePage(firstPage, firstPageProblems);
    observePage(secondPage, secondPageProblems);
    await firstPage.route(postUrl, postRoute);
    routeHandlers.push([postUrl, postRoute]);
    routed = true;

    const firstMe = await observeBootAuthMe(firstPage, appUrl, "first-tab");
    assert(
      firstMe.actorApId === actorApId,
      "first-tab-authenticated-owner-mismatch",
    );
    bootAuth.push(firstMe);
    await firstPage
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();
    const firstDialog = firstPage.getByRole("dialog", {
      name: "今なにしてる？",
    });
    await waitVisible(firstDialog, "first-owner-composer-open");
    await setDraft(firstDialog, originalDraft);

    const secondMe = await observeBootAuthMe(secondPage, appUrl, "second-tab");
    assert(
      secondMe.actorApId === actorApId,
      "second-tab-authenticated-owner-mismatch",
    );
    bootAuth.push(secondMe);
    await secondPage
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();
    const secondDialog = secondPage.getByRole("dialog", {
      name: "今なにしてる？",
    });
    await waitVisible(secondDialog, "second-owner-composer-open");
    await secondDialog.getByRole("button", { name: "注釈を追加" }).click();
    await waitDraftDom(
      secondPage,
      originalDraft,
      "second-tab-initial-shared-draft",
    );
    assert(
      JSON.stringify(await readDraftDom(secondDialog)) ===
        JSON.stringify(originalDraft),
      "second-tab-did-not-load-existing-same-owner-draft",
    );

    totalCreatesBefore = await countCreates(db, actorApId);
    await firstDialog
      .getByRole("button", { name: "投稿", exact: true })
      .click();
    const originalProof = await waitGate(originalIntent.committed);
    assert(originalProof.status === 200, "held-original-real-post-not-200");
    const firstDomBeforeAck = await readDraftDom(firstDialog);
    assert(
      JSON.stringify(firstDomBeforeAck) === JSON.stringify(originalDraft),
      "first-tab-original-dom-changed-before-newer-storage-event",
    );
    const nativeHeldCounts = await countContentPosts(
      db,
      actorApId,
      originalDraft.body,
    );
    assert(
      nativeHeldCounts.notes === 1 &&
        nativeHeldCounts.creates === 1 &&
        (await countCreates(db, actorApId)) === totalCreatesBefore + 1,
      "held-first-post-was-not-exactly-one-native-note-create",
    );
    const attemptsBeforeAck = postAttempts;

    await setDraft(secondDialog, newerDraft);
    await waitCapturedStorageEvents(
      firstPage,
      DRAFT_KEYS.length,
      "newer-draft-events",
    );
    await waitDraftDom(secondPage, newerDraft, "second-tab-newer-draft");
    const sharedRawBeforeAck = await readDraftStorage(secondPage);
    const capturedNewerEvents = await takeEvents(firstPage);
    retainedEventDescriptors = capturedNewerEvents;
    assert(
      JSON.stringify(sharedRawBeforeAck) === JSON.stringify(newerDraft) &&
        JSON.stringify(await readDraftDom(firstDialog)) ===
          JSON.stringify(originalDraft) &&
        capturedNewerEvents.length === DRAFT_KEYS.length &&
        capturedNewerEvents.every((event) => DRAFT_KEYS.includes(event.key)),
      "cross-tab-newer-raw-draft-or-delayed-real-events-not-observed-before-ack",
    );
    assert(postAttempts === 1, "extra-post-before-held-ack");
    firstNoteProof = originalProof;

    originalIntent.release.resolve();
    await waitGate(originalIntent.acked);
    const status = firstPage
      .getByRole("status")
      .filter({ hasText: RETAINED_STATUS });
    await waitVisible(status, "acknowledged-draft-retained-status");
    statusText = await status.innerText();
    await waitDraftDom(
      firstPage,
      newerDraft,
      "first-tab-acknowledged-newer-draft",
    );
    const afterAckFirst = await readDraftDom(firstDialog);
    const afterAckStorage = await readDraftStorage(firstPage);
    const modalAfterAck = await firstDialog.isVisible();
    const currentNoteCounts = await countContentPosts(
      db,
      actorApId,
      originalDraft.body,
    );
    newerNoAutoPostCounts = await countContentPosts(
      db,
      actorApId,
      newerDraft.body,
    );
    createsAfterRetainedAck = await countCreates(db, actorApId);
    assert(
      modalAfterAck &&
        JSON.stringify(afterAckFirst) === JSON.stringify(newerDraft) &&
        JSON.stringify(afterAckStorage) === JSON.stringify(newerDraft) &&
        currentNoteCounts.notes === 1 &&
        currentNoteCounts.creates === 1 &&
        newerNoAutoPostCounts.notes === 0 &&
        newerNoAutoPostCounts.creates === 0 &&
        createsAfterRetainedAck === totalCreatesBefore + 1 &&
        postAttempts === attemptsBeforeAck,
      "ack-cleared-newer-draft-closed-modal-or-created-a-second-post",
    );
    checks.push("browser-draft-storage-cross-tab-newer-draft-during-held-note");
    checks.push(
      "browser-draft-storage-ack-retains-newer-state-and-reports-success",
    );

    await dispatchEvents(firstPage, capturedNewerEvents);
    await waitDraftDom(
      firstPage,
      newerDraft,
      "first-tab-replayed-newer-events",
    );
    await waitDraftDom(
      secondPage,
      newerDraft,
      "second-tab-replayed-newer-events",
    );
    assert(
      JSON.stringify(await readDraftDom(firstDialog)) ===
        JSON.stringify(newerDraft) &&
        JSON.stringify(await readDraftDom(secondDialog)) ===
          JSON.stringify(newerDraft),
      "replayed-newer-storage-events-did-not-update-both-owner-tabs",
    );
    checks.push(
      "browser-draft-storage-replays-buffered-events-into-subscribers",
    );

    await setDraft(secondDialog, latestDraft);
    await waitCapturedStorageEvents(
      firstPage,
      DRAFT_KEYS.length,
      "latest-draft-events",
    );
    await waitDraftDom(secondPage, latestDraft, "second-tab-latest-draft");
    latestEventDescriptors = await takeEvents(firstPage);
    assert(
      latestEventDescriptors.length === DRAFT_KEYS.length &&
        JSON.stringify(await readDraftStorage(secondPage)) ===
          JSON.stringify(latestDraft),
      "latest-storage-events-not-captured",
    );
    await dispatchEvents(firstPage, latestEventDescriptors);
    await waitDraftDom(firstPage, latestDraft, "first-tab-latest-events");
    assert(
      JSON.stringify(await readDraftDom(firstDialog)) ===
        JSON.stringify(latestDraft),
      "fresh-draft-events-did-not-update-first-tab",
    );
    await dispatchEvents(firstPage, capturedNewerEvents);
    await waitDraftDom(
      firstPage,
      latestDraft,
      "first-tab-stale-event-resisted",
    );
    await waitDraftDom(
      secondPage,
      latestDraft,
      "second-tab-stale-event-resisted",
    );
    assert(
      JSON.stringify(await readDraftDom(firstDialog)) ===
        JSON.stringify(latestDraft) &&
        JSON.stringify(await readDraftStorage(firstPage)) ===
          JSON.stringify(latestDraft) &&
        JSON.stringify(await readDraftDom(secondDialog)) ===
          JSON.stringify(latestDraft),
      "stale-storage-event-regressed-the-latest-draft",
    );
    latestNoAutoPostCounts = await countContentPosts(
      db,
      actorApId,
      latestDraft.body,
    );
    assert(
      latestNoAutoPostCounts.notes === 0 &&
        latestNoAutoPostCounts.creates === 0 &&
        (await countCreates(db, actorApId)) === totalCreatesBefore + 1,
      "latest-unsent-draft-created-native-post-before-explicit-submit",
    );
    checks.push("browser-draft-storage-stale-replay-uses-current-values");

    clearPage = await context.newPage();
    clearPage.setDefaultTimeout(TIMEOUT_MS);
    clearPage.on("pageerror", (error) =>
      clearPageProblems.push(`pageerror:${error?.name ?? "Error"}`),
    );
    clearPage.on("response", (response) => {
      if (response.status() >= 500)
        clearPageProblems.push(`http-${response.status()}`);
    });
    await clearPage.goto(appUrl, { waitUntil: "domcontentloaded" });
    await clearPage.evaluate(() => {
      const keep = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      )
        .filter((key) => key && !key.startsWith("compose.draft."))
        .map((key) => [key, localStorage.getItem(key)]);
      localStorage.clear();
      for (const [key, value] of keep) localStorage.setItem(key, value);
    });
    await waitCapturedStorageEvents(firstPage, 1, "native-key-null-event");
    await waitDraftDom(
      secondPage,
      { body: "", summary: "", visibility: "public" },
      "second-tab-key-null-defaults",
    );
    nullKeyEventDescriptors = await takeEvents(firstPage);
    assert(
      nullKeyEventDescriptors.length === 1 &&
        nullKeyEventDescriptors[0].key === null &&
        JSON.stringify(await readDraftDom(secondDialog)) ===
          JSON.stringify({ body: "", summary: "", visibility: "public" }),
      "native-key-null-clear-did-not-reload-second-tab-defaults",
    );
    await dispatchEvents(firstPage, nullKeyEventDescriptors);
    await waitDraftDom(
      firstPage,
      { body: "", summary: "", visibility: "public" },
      "first-tab-replayed-key-null-defaults",
    );
    await waitDraftDom(
      secondPage,
      { body: "", summary: "", visibility: "public" },
      "second-tab-replayed-key-null-defaults",
    );
    assert(
      JSON.stringify(await readDraftDom(firstDialog)) ===
        JSON.stringify({ body: "", summary: "", visibility: "public" }) &&
        JSON.stringify(await readDraftStorage(firstPage)) ===
          JSON.stringify({ body: null, summary: null, visibility: null }) &&
        JSON.stringify(await readDraftDom(secondDialog)) ===
          JSON.stringify({ body: "", summary: "", visibility: "public" }) &&
        JSON.stringify(await readDraftStorage(secondPage)) ===
          JSON.stringify({ body: null, summary: null, visibility: null }),
      "key-null-storage-event-did-not-reset-both-composers-to-defaults",
    );
    checks.push("browser-draft-storage-clear-key-null-reloads-defaults");

    await setDraft(firstDialog, cleanDraft);
    await waitDraftDom(
      secondPage,
      cleanDraft,
      "second-tab-clean-success-draft",
    );
    assert(
      JSON.stringify(await readDraftDom(secondDialog)) ===
        JSON.stringify(cleanDraft),
      "second-tab-did-not-observe-control-draft-before-submit",
    );
    await firstDialog
      .getByRole("button", { name: "投稿", exact: true })
      .click();
    cleanNoteProof = await waitGate(cleanIntent.acked);
    await firstDialog.waitFor({ state: "hidden", timeout: TIMEOUT_MS });
    const cleanNative = await readNativePost(
      db,
      actorApId,
      cleanDraft.body,
      cleanNoteProof.postId,
    );
    assert(
      cleanNoteProof.status === 200 &&
        cleanNative.notes === 1 &&
        cleanNative.creates === 1 &&
        (await countCreates(db, actorApId)) === totalCreatesBefore + 2 &&
        JSON.stringify(await readDraftStorage(firstPage)) ===
          JSON.stringify({ body: "", summary: "", visibility: "public" }),
      "unchanged-success-control-did-not-clear-default-draft-after-one-native-post",
    );
    const secondTabResetWait = secondPage.waitForFunction(
      () => {
        const d = document.querySelector(
          '[role="dialog"][aria-label="今なにしてる？"]',
        );
        const body = d?.querySelector("textarea")?.value;
        const summary =
          d?.querySelector('input[placeholder="内容に関する注釈（任意）"]')
            ?.value ?? "";
        const visibility = d?.querySelector("#post-visibility")?.value;
        return body === "" && summary === "" && visibility === "public";
      },
      undefined,
      { timeout: TIMEOUT_MS },
    );
    secondTabResetWait.catch(() => {});
    try {
      await secondTabResetWait;
    } catch {
      throw new Error(
        "browser-draft-storage-clean-success-did-not-sync-defaults-to-second-tab",
      );
    }
    await firstPage
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();
    await waitVisible(
      firstDialog,
      "no-edit-success-control-reopened-default-composer",
    );
    assert(
      JSON.stringify(await readDraftDom(firstDialog)) ===
        JSON.stringify({ body: "", summary: "", visibility: "public" }) &&
        JSON.stringify(await readDraftDom(secondDialog)) ===
          JSON.stringify({ body: "", summary: "", visibility: "public" }),
      "reopened-control-composer-did-not-show-defaults-in-both-tabs",
    );
    await firstDialog
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    checks.push("browser-draft-storage-no-edit-success-clears-and-closes");

    assert(
      firstPageProblems.length === 0 &&
        secondPageProblems.length === 0 &&
        clearPageProblems.length === 0,
      "browser-pageerror-or-http-5xx",
      [...firstPageProblems, ...secondPageProblems, ...clearPageProblems].join(
        ",",
      ),
    );
  } catch (error) {
    primaryError = primaryError ?? error;
  } finally {
    for (const intent of intents.values()) intent.release.resolve();
    if (routed) {
      for (const [url, handler] of routeHandlers) {
        try {
          await firstPage.unroute(url, handler);
        } catch {
          if (!primaryError)
            primaryError = new Error(
              "browser-draft-storage route cleanup failed",
            );
        }
      }
    }
    for (const target of [clearPage, secondPage, firstPage]) {
      if (!target) continue;
      try {
        await target.close();
      } catch {
        if (!primaryError)
          primaryError = new Error("browser-draft-storage page cleanup failed");
      }
    }
  }

  if (primaryError) throw primaryError;
  const result = {
    kind: "yurucommu.browser-draft-storage@v1",
    checks: [
      "browser-draft-storage-cross-tab-newer-draft-during-held-note",
      "browser-draft-storage-ack-retains-newer-state-and-reports-success",
      "browser-draft-storage-replays-buffered-events-into-subscribers",
      "browser-draft-storage-stale-replay-uses-current-values",
      "browser-draft-storage-clear-key-null-reloads-defaults",
      "browser-draft-storage-no-edit-success-clears-and-closes",
    ],
    posts: [firstNoteProof, cleanNoteProof].map((post) => ({
      status: post.status,
      postId: post.postId,
      bodySha256: post.bodySha256,
      summarySha256: post.summarySha256,
      visibility: post.visibility,
      noteCount: post.native.notes,
      createCount: post.native.creates,
    })),
    totalPostAttempts: postAttempts,
    bootAuth,
    totalOwnerCreatesBefore: totalCreatesBefore,
    totalOwnerCreatesAfter: await countCreates(db, actorApId).catch(() => null),
    retainedStatus: statusText,
    delayedEvents: eventMetadata(retainedEventDescriptors),
    latestEvents: eventMetadata(latestEventDescriptors),
    clearEvents: nullKeyEventDescriptors.map((event) => ({
      key: event.key,
      isNullKey: event.key === null,
    })),
    ackRetainedDraft: {
      bodySha256: hash(newerDraft.body),
      summarySha256: hash(newerDraft.summary),
      visibility: newerDraft.visibility,
      bodyKept: true,
      summaryKept: true,
      visibilityKept: true,
      modalStayedOpen: true,
      nativeNewerNoteCounts: newerNoAutoPostCounts,
      ownerCreatesAfterRetainedAck: createsAfterRetainedAck,
      postAttemptsExactlyOnePerIntent: postAttempts === 2,
    },
    latestDraftNativePostCountsBeforeExplicitSend: latestNoAutoPostCounts,
    staleReplayDidNotRegress: true,
    keyNullDefaults: { body: "", summary: "", visibility: "public" },
    noEditControlCleared: true,
    scope:
      "local authenticated same-owner browser tabs and native Worker D1 only; no CAS, idempotency, or live-service claim",
  };
  return result;
}
