import { randomUUID } from "node:crypto";

const TIMEOUT = 15_000;
const AUTH_WAIT_MAX = 61_000;
const AUTH_READ_BUDGET = 8;
const WARNING =
  "投稿結果を確認できません。すでに投稿されている可能性があります。再投稿する前にフィードを確認してください。";
const need = (value, label) => {
  if (!value) throw new Error(`release-browser-post-reload:${label}`);
};

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("release-browser-post-reload:commit-timeout")),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareBrowserAuthCapacity(
  page,
  origin,
  minimum = AUTH_READ_BUDGET,
) {
  need(
    Number.isInteger(minimum) && minimum > 0 && minimum < 20,
    "auth-capacity-budget",
  );
  let waited = false;
  for (let read = 0; read < 2; read++) {
    const response = await page.request.get(`${origin}/api/auth/providers`, {
      timeout: TIMEOUT,
    });
    const headers = response.headers();
    const limit = Number(headers["x-ratelimit-limit"]);
    const remaining = Number(headers["x-ratelimit-remaining"]);
    const reset = Number(headers["x-ratelimit-reset"]);
    need(
      limit === 20 &&
        Number.isFinite(remaining) &&
        remaining >= 0 &&
        remaining <= limit &&
        Number.isFinite(reset) &&
        reset > 0,
      "public-auth-capacity-shape",
    );
    need(
      response.status() === 200 || response.status() === 429,
      "public-auth-capacity-status",
    );
    // Five document loads plus room for in-flight UI reads. Do not reset KV,
    // alter the product limit, or let this appended cohort starve earlier cases.
    if (response.status() === 200 && remaining >= minimum)
      return { remaining, waited };
    need(!waited, "public-auth-capacity-after-one-reset");
    const waitMs = Math.max(1, reset * 1000 - Date.now());
    // The advertised 60 s window is rounded up to an integer second.
    need(waitMs <= AUTH_WAIT_MAX, "public-auth-reset-within-one-window");
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error("release-browser-post-reload:auth-capacity-unavailable");
}

/** Ordinary App POST, committed native data, lost browser ACK, then real reload. */
export async function qualifyBrowserPostReload({
  page,
  db,
  origin,
  actorApId,
  checks = [],
}) {
  const content = `post-reload-${randomUUID()}`;
  const authBudget = await prepareBrowserAuthCapacity(page, origin);
  const postUrl = new URL("/api/posts", origin).href;
  let attempts = 0;
  let retryPhase = false;
  let acceptedRetryPhase = false;
  let expectedNotes = 1;
  let otherPage;
  let resolveAccepted;
  let releaseAccepted;
  const acceptedRetry = new Promise((resolve) => {
    resolveAccepted = resolve;
  });
  const acceptedRelease = new Promise((resolve) => {
    releaseAccepted = resolve;
  });
  let resolveRetry;
  const rejectedRetry = new Promise((resolve) => {
    resolveRetry = resolve;
  });
  let routeError = null;
  let resolveCommit;
  const committed = new Promise((resolve) => {
    resolveCommit = resolve;
  });
  const counts = async (id) => {
    const post = await db
      .prepare(
        "SELECT ap_id, type, attributed_to, content FROM objects WHERE ap_id = ?",
      )
      .bind(id)
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
      .bind(actorApId, id)
      .first();
    need(
      post?.type === "Note" &&
        post.attributed_to === actorApId &&
        post.content === content &&
        notes?.count === expectedNotes &&
        creates?.count === 1,
      "one-native-note-and-create",
    );
    return { notes: notes.count, creates: creates.count };
  };
  const routePost = async (route) => {
    const request = route.request();
    if (
      request.method() !== "POST" ||
      request.postDataJSON()?.content !== content
    )
      return route.continue();
    attempts++;
    try {
      if (acceptedRetryPhase) {
        need(attempts === 3, "one-explicit-accepted-retry");
        const response = await route.fetch({ timeout: TIMEOUT });
        need(response.status() === 200, "real-worker-accepted-retry");
        const ack = await response.json();
        const id = ack.post?.ap_id;
        need(typeof id === "string", "accepted-retry-real-id");
        expectedNotes = 2;
        await counts(id);
        resolveAccepted(id);
        await acceptedRelease;
        await route.fulfill({ response });
        return;
      }
      if (retryPhase) {
        need(attempts === 2, "one-explicit-retry");
        const wire = { ...request.postDataJSON(), content: "" };
        const response = await route.fetch({
          postData: JSON.stringify(wire),
          timeout: TIMEOUT,
        });
        need(
          response.status() === 400,
          "real-worker-rejects-retry-without-note",
        );
        await route.fulfill({ response });
        resolveRetry(400);
        return;
      }
      need(attempts === 1, "no-automatic-resend");
      const response = await route.fetch({ timeout: TIMEOUT });
      need(response.status() === 200, "real-worker-ack");
      const ack = await response.json();
      const id = ack.post?.ap_id;
      need(typeof id === "string", "real-post-id");
      await counts(id);
      await route.abort("failed");
      resolveCommit(id);
    } catch (error) {
      routeError = error;
      await route.abort("failed").catch(() => {});
      resolveCommit(null);
      resolveRetry(null);
      resolveAccepted(null);
    }
  };
  const open = async (target = page) => {
    const button = target
      .getByRole("button", { name: "投稿", exact: true })
      .first();
    await button.waitFor({ state: "visible", timeout: TIMEOUT });
    await button.click();
    const dialog = target.getByRole("dialog", { name: "今なにしてる？" });
    await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
    return dialog;
  };
  await page.route(postUrl, routePost);
  try {
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    let dialog = await open();
    await dialog.getByPlaceholder("今なにしてる？").fill(content);
    await dialog.getByRole("button", { name: "投稿", exact: true }).click();
    const id = await bounded(committed);
    if (routeError) throw routeError;
    need(id, "native-commit-observed");
    await dialog
      .getByText(WARNING, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
    dialog = await open();
    await page.waitForFunction(
      (text) =>
        Array.from(document.querySelectorAll("textarea")).some(
          (node) => node.value === text,
        ),
      content,
      { timeout: TIMEOUT },
    );
    await dialog
      .getByText(WARNING, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await dialog.getByPlaceholder("今なにしてる？").inputValue()) ===
        content,
      "draft-restored",
    );
    need(attempts === 1, "reload-does-not-resend");
    await counts(id);
    retryPhase = true;
    await dialog.getByRole("button", { name: "投稿", exact: true }).click();
    need((await bounded(rejectedRetry)) === 400, "explicit-retry-rejected");
    if (routeError) throw routeError;
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[role="dialog"] button')).some(
          (button) => button.textContent?.trim() === "投稿" && !button.disabled,
        ),
      undefined,
      { timeout: TIMEOUT },
    );
    need(
      await dialog.getByText(WARNING, { exact: true }).isVisible(),
      "prior-uncertainty-remains-after-rejection",
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
    dialog = await open();
    await page.waitForFunction(
      (text) =>
        Array.from(document.querySelectorAll("textarea")).some(
          (n) => n.value === text,
        ),
      content,
      { timeout: TIMEOUT },
    );
    const caution = await dialog
      .getByText(WARNING, { exact: true })
      .isVisible();
    const nativeBeforeDiscard = await counts(id);
    console.log(
      JSON.stringify({
        kind: "prior-caution-after-real-rejected-retry",
        warningVisible: caution,
        manualAttempts: attempts,
        rejectedStatus: 400,
        ...nativeBeforeDiscard,
      }),
    );
    need(caution, "prior-uncertainty-survives-rejected-retry-and-reload");
    // A further explicit retry may succeed while another tab edits the draft.
    // Hold only its browser ACK after the real Worker has committed that retry.
    acceptedRetryPhase = true;
    await dialog.getByRole("button", { name: "投稿", exact: true }).click();
    const acceptedId = await bounded(acceptedRetry);
    if (routeError) throw routeError;
    need(acceptedId && acceptedId !== id, "second-native-note-is-distinct");
    otherPage = await page.context().newPage();
    await otherPage.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const otherDialog = await open(otherPage);
    const newer = `newer-draft-${randomUUID()}`;
    await otherDialog.getByPlaceholder("今なにしてる？").fill(newer);
    await page.waitForFunction(
      (text) =>
        Array.from(document.querySelectorAll("textarea")).some(
          (node) => node.value === text,
        ),
      newer,
      { timeout: TIMEOUT },
    );
    releaseAccepted();
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[role="dialog"] button')).some(
          (button) => button.textContent?.trim() === "投稿" && !button.disabled,
        ),
      undefined,
      { timeout: TIMEOUT },
    );
    const notice = dialog.getByRole("status");
    await notice.waitFor({ state: "visible", timeout: TIMEOUT });
    const noticeText = (await notice.textContent())?.trim();
    need(
      noticeText && noticeText !== WARNING,
      "accepted-retry-retained-draft-receipt",
    );
    need(
      await dialog.getByText(WARNING, { exact: true }).isVisible(),
      "accepted-retry-retains-earlier-uncertain-warning",
    );
    need(
      (await dialog.getByPlaceholder("今なにしてる？").inputValue()) === newer,
      "other-tab-newer-draft-kept",
    );
    need(attempts === 3, "only-three-explicit-attempts");
    const acceptedNative = await counts(acceptedId);
    const outcomeKey = await otherPage.evaluate(
      (text) =>
        Object.keys(localStorage).find(
          (key) =>
            key.startsWith("compose.draft.v2.") &&
            key.endsWith(".outcome") &&
            localStorage.getItem(
              key.slice(0, -".outcome".length) + ".content",
            ) === JSON.stringify(text),
        ),
      newer,
    );
    need(typeof outcomeKey === "string", "actual-newer-draft-outcome-key");
    await page.evaluate((key) => {
      globalThis.__postOutcomeFaultEvent = new Promise((resolve) => {
        const changed = (event) => {
          if (event.key === key && event.storageArea === localStorage) {
            removeEventListener("storage", changed);
            resolve(true);
          }
        };
        addEventListener("storage", changed);
      });
    }, outcomeKey);
    await otherPage.evaluate(
      (key) => localStorage.setItem(key, "{broken"),
      outcomeKey,
    );
    await bounded(page.evaluate(() => globalThis.__postOutcomeFaultEvent));
    const warningAfterCorruption = await dialog
      .getByText(WARNING, { exact: true })
      .isVisible();
    console.log(
      JSON.stringify({
        kind: "corrupt-journal-after-known-receipt",
        warningVisible: warningAfterCorruption,
        manualAttempts: attempts,
        notes: acceptedNative.notes,
      }),
    );
    need(
      warningAfterCorruption,
      "corrupt-journal-caution-survives-known-receipt",
    );
    await otherPage.close();
    otherPage = null;
    console.log(
      JSON.stringify({
        kind: "accepted-retry-retains-prior-caution",
        warningVisible: true,
        newerDraftRetained: true,
        manualAttempts: attempts,
        notes: acceptedNative.notes,
        totalCreates: acceptedNative.creates + 1,
      }),
    );
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    const discard = page.getByRole("alertdialog", {
      name: "下書きを破棄しますか？",
    });
    await discard.waitFor({ state: "visible", timeout: TIMEOUT });
    await discard.getByRole("button", { name: "破棄", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: TIMEOUT });
    await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
    dialog = await open();
    need(
      (await dialog.getByPlaceholder("今なにしてる？").inputValue()) === "",
      "explicit-discard-survives-reload",
    );
    need(
      (await dialog.getByText(WARNING, { exact: true }).count()) === 0,
      "explicit-discard-clears-caution",
    );
    need(attempts === 3, "discard-does-not-resend");
    const native = await counts(id);
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    checks.push(
      "post-ack-loss-warning-and-draft-survive-reload-without-resend",
    );
    checks.push("post-prior-uncertainty-survives-a-real-rejected-manual-retry");
    checks.push(
      "post-prior-uncertainty-remains-alongside-successful-retry-retained-draft-notice",
    );
    checks.push(
      "post-explicit-discard-clears-reload-caution-without-deleting-accepted-notes",
    );
    return {
      status: "PASSED",
      matchingPostAttempts: attempts,
      definiteRejectedRetries: 1,
      acceptedAttempts: 2,
      totalCreates: native.creates + acceptedNative.creates,
      authBudget,
      ...native,
    };
  } finally {
    releaseAccepted();
    await otherPage?.close();
    await page.unroute(postUrl, routePost);
  }
}
