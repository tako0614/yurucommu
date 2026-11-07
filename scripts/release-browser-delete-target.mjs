// Actual password-UI owner, real API posts and native D1; delayed DELETE ACKs must stay with their original target.
import { randomUUID } from "node:crypto";

const TIMEOUT = 15_000;
const DELETED = "投稿を削除しました";
const need = (value, label) => {
  if (!value) throw new Error("browser-delete-target " + label);
};
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("browser-delete-target " + label)),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function nativeObject(db, id) {
  return db
    .prepare(
      "SELECT ap_id, type, attributed_to, deleted_at, in_reply_to FROM objects WHERE ap_id = ?",
    )
    .bind(id)
    .first();
}
async function createPost(page, db, origin, actorApId, marker, replyTo) {
  const response = await page.request.post(origin + "/api/posts", {
    headers: { Origin: origin },
    data: {
      content: marker,
      summary: "",
      visibility: "public",
      ...(replyTo ? { in_reply_to: replyTo } : {}),
    },
    timeout: TIMEOUT,
  });
  const post = (await response.json().catch(() => null))?.post;
  need(
    response.status() === 200 &&
      post?.type === "Note" &&
      post.author?.ap_id === actorApId &&
      post.content === marker,
    "real-post-create",
  );
  const native = await nativeObject(db, post.ap_id);
  need(
    native?.type === "Note" &&
      native.attributed_to === actorApId &&
      native.deleted_at === null,
    "created-native-note",
  );
  if (replyTo) need(native.in_reply_to === replyTo, "real-native-reply-parent");
  return post;
}
async function replyCount(page) {
  return page
    .getByRole("button", { name: "返信", exact: true })
    .first()
    .evaluate(
      (button) =>
        button.parentElement?.previousElementSibling?.querySelector(
          "span.font-bold",
        )?.textContent ?? null,
    );
}
async function goHomeAndOpen(page, origin, post) {
  await page.getByRole("link", { name: "ホーム", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: TIMEOUT });
  const tab = page.getByRole("tab", { name: "すべて", exact: true });
  await tab.waitFor({ state: "visible", timeout: TIMEOUT });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  const body = page.getByText(post.content, { exact: true }).first();
  await body.waitFor({ state: "visible", timeout: TIMEOUT });
  await body.click();
  await page.waitForURL(
    (url) => url.pathname === "/post/" + encodeURIComponent(post.ap_id),
    { timeout: TIMEOUT },
  );
  await page
    .getByText(post.content, { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: TIMEOUT });
  need(new URL(page.url()).origin === origin, "same-origin-navigation");
}
export async function qualifyBrowserDeleteTarget({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  need(page && db && Array.isArray(checks), "real-browser-native-d1-required");
  const owner = await db
    .prepare("SELECT ap_id, role, deleted_at FROM actors WHERE ap_id = ?")
    .bind(actorApId)
    .first();
  need(
    owner?.role === "owner" && owner.deleted_at === null,
    "existing-real-owner-required",
  );
  const results = [];
  for (const kind of ["post", "reply"]) {
    const marker = "delete-target-" + kind + "-" + randomUUID();
    const parent = await createPost(page, db, origin, actorApId, marker + "-A");
    const target =
      kind === "post"
        ? parent
        : await createPost(
            page,
            db,
            origin,
            actorApId,
            marker + "-reply-A",
            parent.ap_id,
          );
    const other = await createPost(page, db, origin, actorApId, marker + "-B");
    if (kind === "reply")
      await createPost(
        page,
        db,
        origin,
        actorApId,
        marker + "-reply-B",
        other.ap_id,
      );
    await page.goto(origin + "/post/" + encodeURIComponent(parent.ap_id), {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    await page
      .getByText(target.content, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT });
    const committed = gate();
    const release = gate();
    const done = gate();
    const deleteUrl = origin + "/api/posts/" + encodeURIComponent(target.ap_id);
    let attempts = 0;
    let routeError = null;
    const handler = async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      attempts++;
      try {
        need(attempts === 1, "no-duplicate-delete");
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: TIMEOUT,
        });
        need(response.ok(), "real-delete-success");
        need(
          (await nativeObject(db, target.ap_id)) === null,
          "real-target-deleted-before-ack",
        );
        committed.resolve(true);
        await release.promise;
        await route.fulfill({ response });
      } catch (error) {
        routeError = error instanceof Error ? error.message : String(error);
        committed.resolve(false);
        await route.abort("failed").catch(() => {});
      } finally {
        done.resolve(true);
      }
    };
    await page.route(deleteUrl, handler);
    try {
      const buttons = page.getByRole("button", { name: "削除", exact: true });
      need(
        (await buttons.count()) === (kind === "post" ? 1 : 2),
        "actual-own-delete-controls",
      );
      await buttons.nth(kind === "post" ? 0 : 1).click();
      const dialog = page.getByRole("alertdialog", {
        name: "投稿を削除しますか？",
      });
      await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
      await dialog.getByRole("button", { name: "削除", exact: true }).click();
      need(
        await bounded(committed.promise, "native-commit-timeout"),
        routeError ?? "native-delete-not-committed",
      );
      await goHomeAndOpen(page, origin, other);
      const beforeCount = await replyCount(page);
      need(
        beforeCount === (kind === "reply" ? "1" : "0"),
        "B-native-reply-count-before-ack",
      );
      const expectedPath = new URL(page.url()).pathname;
      const targetReceipt = DELETED + " (" + target.ap_id + ")";
      const responseWait = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          response.url() === deleteUrl,
        { timeout: TIMEOUT },
      );
      responseWait.catch(() => {});
      release.resolve(true);
      await bounded(done.promise, "delete-response-delivery");
      await bounded(responseWait, "browser-delete-response");
      await page.waitForFunction(
        ({ path, receipt, count, isReply }) => {
          if (
            location.pathname !== path ||
            document.body.textContent.includes(receipt)
          )
            return true;
          const button = Array.from(document.querySelectorAll("button")).find(
            (item) => item.getAttribute("aria-label") === "返信",
          );
          const shown =
            button?.parentElement?.previousElementSibling?.querySelector(
              "span.font-bold",
            )?.textContent;
          return isReply && shown !== count;
        },
        {
          path: expectedPath,
          receipt: targetReceipt,
          count: beforeCount,
          isReply: kind === "reply",
        },
        { timeout: TIMEOUT },
      );
      const routeStillB = new URL(page.url()).pathname === expectedPath;
      const afterCount = routeStillB ? await replyCount(page) : null;
      const serverDeletedA = (await nativeObject(db, target.ap_id)) === null;
      const kept = await nativeObject(db, other.ap_id);
      const serverKeptB = kept?.type === "Note" && kept.deleted_at === null;
      const targetNotice = await page
        .getByText(targetReceipt, { exact: true })
        .isVisible();
      console.log(
        JSON.stringify({
          kind: "delete-target-native-settlement",
          case: kind,
          routeStillB,
          beforeCount,
          afterCount,
          serverDeletedA,
          serverKeptB,
          targetNotice,
          attempts,
        }),
      );
      need(
        !routeError && attempts === 1 && serverDeletedA && serverKeptB,
        "native-effect-only-on-A",
      );
      need(
        routeStillB && afterCount === beforeCount,
        "late-delete-changed-B-route-or-count",
      );
      need(targetNotice, "late-delete-receipt-does-not-identify-A");
      checks.push(
        "delete-" + kind + "-ack-after-SPA-navigation-keeps-B-and-identifies-A",
      );
      results.push({
        case: kind,
        attempts,
        routeStillB,
        beforeCount,
        afterCount,
        serverDeletedA,
        serverKeptB,
        targetNotice,
      });
    } finally {
      release.resolve(true);
      await bounded(done.promise, "route-finally-close").catch(() => {});
      await page.unroute(deleteUrl, handler);
    }
  }
  results.push(
    await qualifyBrowserDeleteRemount({ page, db, origin, actorApId, checks }),
  );
  return {
    kind: "yurucommu.browser-delete-target@v1",
    status: "PASSED",
    cases: results,
  };
}

export async function qualifyBrowserDeleteRemount({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  const marker = "delete-remount-" + randomUUID();
  const target = await createPost(page, db, origin, actorApId, marker + "-A");
  const other = await createPost(page, db, origin, actorApId, marker + "-B");
  const path = "/post/" + encodeURIComponent(target.ap_id);
  await page.goto(origin + path, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  await page
    .getByText(target.content, { exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  const entered = gate();
  const release = gate();
  const done = gate();
  const url = origin + "/api/posts/" + encodeURIComponent(target.ap_id);
  let attempts = 0;
  let routeError = null;
  const handler = async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    attempts++;
    try {
      entered.resolve(true);
      await release.promise;
      need(attempts === 1, "remount-no-duplicate-delete");
      const response = await route.fetch({ maxRedirects: 0, timeout: TIMEOUT });
      need(
        response.ok() && (await nativeObject(db, target.ap_id)) === null,
        "remount-real-delete-effect",
      );
      await route.fulfill({ response });
    } catch (error) {
      routeError = error instanceof Error ? error.message : String(error);
      await route.abort("failed").catch(() => {});
    } finally {
      done.resolve(true);
    }
  };
  await page.route(url, handler);
  try {
    await page.getByRole("button", { name: "削除", exact: true }).click();
    const confirm = page.getByRole("alertdialog", {
      name: "投稿を削除しますか？",
    });
    await confirm.waitFor({ state: "visible", timeout: TIMEOUT });
    await confirm.getByRole("button", { name: "削除", exact: true }).click();
    await bounded(entered.promise, "remount-delete-not-entered");
    await goHomeAndOpen(page, origin, other);
    await page.goBack();
    await page.waitForURL((current) => current.pathname === "/", {
      timeout: TIMEOUT,
    });
    await page.goBack();
    await page.waitForURL((current) => current.pathname === path, {
      timeout: TIMEOUT,
    });
    await page
      .getByText(target.content, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    const button = page.getByRole("button", { name: "削除", exact: true });
    const pendingControlBlocked =
      (await button.getAttribute("aria-disabled")) === "true";
    await button.press("Enter");
    const dialogOpened = await page
      .getByRole("alertdialog", { name: "投稿を削除しますか？" })
      .isVisible();
    const nativeStillA =
      (await nativeObject(db, target.ap_id))?.type === "Note";
    console.log(
      JSON.stringify({
        kind: "delete-target-pending-remount",
        pendingControlBlocked,
        dialogOpened,
        attempts,
        nativeStillA,
      }),
    );
    need(
      pendingControlBlocked && !dialogOpened && attempts === 1 && nativeStillA,
      "remount-pending-delete-can-be-confirmed-again",
    );
    release.resolve(true);
    await bounded(done.promise, "remount-delivery-timeout");
    const receipt = DELETED + " (" + target.ap_id + ")";
    await page
      .getByText(receipt, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await page
      .getByText(target.content, { exact: true })
      .waitFor({ state: "hidden", timeout: TIMEOUT });
    need(
      new URL(page.url()).pathname === path &&
        !routeError &&
        attempts === 1 &&
        (await nativeObject(db, target.ap_id)) === null &&
        (await nativeObject(db, other.ap_id))?.type === "Note",
      "remount-reconciled-wrong-target",
    );
    checks.push(
      "delete-pending-remount-blocks-second-confirm-and-refreshes-original-A-on-ack",
    );
    return {
      case: "pending-remount",
      attempts,
      pendingControlBlocked,
      dialogOpened,
      nativeStillA,
      reconciledOriginalA: true,
    };
  } finally {
    release.resolve(true);
    await bounded(done.promise, "remount-final-close").catch(() => {});
    await page.unroute(url, handler);
  }
}
