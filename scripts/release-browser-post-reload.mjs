import { randomUUID } from "node:crypto";

const TIMEOUT = 15_000;
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

/** Ordinary App POST, committed native data, lost browser ACK, then real reload. */
export async function qualifyBrowserPostReload({
  page,
  db,
  origin,
  actorApId,
  checks = [],
}) {
  const content = `post-reload-${randomUUID()}`;
  const postUrl = new URL("/api/posts", origin).href;
  let attempts = 0;
  let retryPhase = false;
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
        notes?.count === 1 &&
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
    }
  };
  const open = async () => {
    const button = page
      .getByRole("button", { name: "投稿", exact: true })
      .first();
    await button.waitFor({ state: "visible", timeout: TIMEOUT });
    await button.click();
    const dialog = page.getByRole("dialog", { name: "今なにしてる？" });
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
    need(attempts === 2, "discard-does-not-resend");
    const native = await counts(id);
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    checks.push(
      "post-ack-loss-warning-and-draft-survive-reload-without-resend",
    );
    checks.push("post-prior-uncertainty-survives-a-real-rejected-manual-retry");
    checks.push(
      "post-explicit-discard-clears-reload-caution-and-keeps-one-native-note",
    );
    return {
      status: "PASSED",
      matchingPostAttempts: attempts,
      definiteRejectedRetries: 1,
      ...native,
    };
  } finally {
    await page.unroute(postUrl, routePost);
  }
}
