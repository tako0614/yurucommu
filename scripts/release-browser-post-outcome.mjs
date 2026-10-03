// Disposable native fixture for a real Worker commit whose browser acknowledgement
// is then lost. This does not qualify publication, shared API idempotency, or
// Core behavior beyond the exact disposable local request observed here.

const UNCONFIRMED =
  "投稿結果を確認できません。すでに投稿されている可能性があります。再投稿する前にフィードを確認してください。";
const EVENT_TIMEOUT_MS = 15_000;

function requireEffect(condition, message) {
  if (!condition) throw new Error("browser-post-outcome " + message);
}

function eventGate(label) {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  promise.catch(() => {});
  return { label, promise, resolve, reject };
}

async function waitForGate(gate, timeout = EVENT_TIMEOUT_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error("browser-post-outcome " + gate.label + " timed out")),
      timeout,
    );
  });
  deadline.catch(() => {});
  try {
    return await Promise.race([gate.promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForText(page, text, label, timeout = EVENT_TIMEOUT_MS) {
  const waiter = page
    .getByRole("alert")
    .filter({ hasText: text })
    .waitFor({ state: "visible", timeout });
  waiter.catch(() => {});
  try {
    await waiter;
  } catch (error) {
    const visibleAlerts = await page
      .getByRole("alert")
      .allTextContents()
      .catch(() => []);
    throw new Error(
      label +
        " did not appear; visibleAlerts=" +
        JSON.stringify(visibleAlerts) +
        "; " +
        String(error),
    );
  }
}

async function readPersistedPost(db, actorApId, postId, content) {
  const post = await db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility FROM objects WHERE ap_id = ?",
    )
    .bind(postId)
    .first();
  const matchingPosts = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND attributed_to = ? AND content = ?",
    )
    .bind(actorApId, content)
    .first();
  const create = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id = ? AND direction = 'outbound'",
    )
    .bind(actorApId, postId)
    .first();
  return { post, matchingPosts, create };
}

function summarizeCommit(commit) {
  if (!commit) return null;
  return {
    status: commit.status,
    postId: commit.postId,
    type: commit.type,
    authorApId: commit.authorApId,
    content: commit.content,
    visibility: commit.visibility,
    native: commit.native,
  };
}

export async function qualifyBrowserPostOutcome({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  requireEffect(page && db, "qualification needs a browser page and D1");
  requireEffect(
    typeof origin === "string" && typeof actorApId === "string",
    "origin and owner AP ID are required",
  );
  const expectedOrigin = new URL(origin).origin;
  requireEffect(
    new URL(actorApId).origin === expectedOrigin,
    "owner AP ID must belong to this artifact origin",
  );
  requireEffect(Array.isArray(checks), "check accumulator is required");

  const owner = await db
    .prepare("SELECT ap_id FROM actors WHERE ap_id = ?")
    .bind(actorApId)
    .first();
  requireEffect(
    owner?.ap_id === actorApId,
    "authenticated owner is absent from D1",
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  const homeUrl = new URL("/", expectedOrigin).href;
  const postUrl = new URL("/api/posts", expectedOrigin).href;
  const content = "release-post-outcome-" + crypto.randomUUID();
  let matchingPostAttempts = 0;
  let commit = null;
  let primaryError = null;
  const committed = eventGate("real Worker post commit and browser ACK loss");
  const rejected = eventGate("real Worker validation refusal");
  let handlerInstalled = false;
  let rejectionHandlerInstalled = false;
  const rejectedContent = "release-post-rejected-" + crypto.randomUUID();
  let rejectedPostAttempts = 0;
  let rejection = null;

  const selectedPostRoute = async (route) => {
    const request = route.request();
    let body;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    if (
      request.method() !== "POST" ||
      new URL(request.url()).pathname !== "/api/posts" ||
      body?.content !== content
    ) {
      await route.continue();
      return;
    }

    matchingPostAttempts += 1;
    if (matchingPostAttempts > 1) {
      // Observe and block any retry so the qualification never creates a
      // duplicate object if the product unexpectedly retries automatically.
      await route.abort("failed");
      return;
    }

    try {
      const response = await route.fetch();
      let responseBody;
      try {
        responseBody = await response.json();
      } catch (error) {
        throw new Error(
          "real Worker POST returned non-JSON after status " +
            response.status() +
            ": " +
            String(error),
        );
      }
      const post = responseBody?.post;
      requireEffect(
        response.status() === 200 &&
          post?.type === "Note" &&
          post?.author?.ap_id === actorApId &&
          post?.content === content &&
          post?.visibility === "public" &&
          typeof post?.ap_id === "string",
        "real Worker response did not confirm the exact public Note: " +
          JSON.stringify({
            status: response.status(),
            post: post
              ? {
                  ap_id: post.ap_id,
                  type: post.type,
                  author: post.author?.ap_id,
                  content: post.content,
                  visibility: post.visibility,
                }
              : null,
          }),
      );

      const native = await readPersistedPost(
        db,
        actorApId,
        post.ap_id,
        content,
      );
      requireEffect(
        native.post?.ap_id === post.ap_id &&
          native.post.type === "Note" &&
          native.post.attributed_to === actorApId &&
          native.post.content === content &&
          native.post.visibility === "public" &&
          native.matchingPosts?.count === 1 &&
          native.create?.count === 1,
        "Worker HTTP 200 was not backed by exactly one native Note/Create: " +
          JSON.stringify(native),
      );
      commit = {
        status: response.status(),
        postId: post.ap_id,
        type: post.type,
        authorApId: post.author.ap_id,
        content: post.content,
        visibility: post.visibility,
        native,
      };

      // The response above is the real committed Worker response. Deliberately
      // drop only its browser-facing acknowledgement after validating SQL.
      await route.abort("failed");
      committed.resolve(commit);
    } catch (error) {
      try {
        await route.abort("failed");
      } catch {
        // Preserve the original route/response/SQL failure.
      }
      committed.reject(error);
    }
  };

  const rejectedPostRoute = async (route) => {
    const request = route.request();
    let body;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    if (
      request.method() !== "POST" ||
      new URL(request.url()).pathname !== "/api/posts" ||
      body?.content !== rejectedContent
    ) {
      await route.continue();
      return;
    }

    rejectedPostAttempts += 1;
    if (rejectedPostAttempts > 1) {
      await route.abort("failed");
      return;
    }

    try {
      requireEffect(
        body.attachments === undefined &&
          (body.visibility === undefined || body.visibility === "public"),
        "validation-control UI request was not the expected normal public text post",
      );
      // Core's published validator rejects non-array attachments with a real
      // 400 before any post/activity write. This changes only the wire payload
      // for this no-write control; the browser receives the actual response.
      const createsBefore = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND direction = 'outbound'",
        )
        .bind(actorApId)
        .first();
      const response = await route.fetch({
        postData: JSON.stringify({
          ...body,
          attachments: "invalid-fixture-attachments",
        }),
      });
      let responseBody;
      try {
        responseBody = await response.json();
      } catch (error) {
        throw new Error(
          "real Worker validation response was non-JSON: " + String(error),
        );
      }
      requireEffect(
        response.status() === 400 &&
          responseBody?.error === "attachments must be an array" &&
          responseBody?.code === "BAD_REQUEST",
        "Core did not return the expected native 400 validation refusal: " +
          JSON.stringify({
            status: response.status(),
            body: responseBody,
          }),
      );

      const noWrite = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND attributed_to = ? AND content = ?",
        )
        .bind(actorApId, rejectedContent)
        .first();
      const noCreate = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM activities a JOIN objects o ON o.ap_id = a.object_ap_id WHERE a.type = 'Create' AND a.actor_ap_id = ? AND o.type = 'Note' AND o.attributed_to = ? AND o.content = ?",
        )
        .bind(actorApId, actorApId, rejectedContent)
        .first();
      const createsAfter = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND direction = 'outbound'",
        )
        .bind(actorApId)
        .first();
      requireEffect(
        noWrite?.count === 0 &&
          noCreate?.count === 0 &&
          createsAfter?.count === createsBefore?.count,
        "native 400 validation refusal left a Note or Create activity: " +
          JSON.stringify({ noWrite, noCreate }),
      );
      rejection = {
        status: response.status(),
        body: responseBody,
        nativeNotes: noWrite.count,
        nativeCreates: noCreate.count,
        ownOutboundCreatesBefore: createsBefore.count,
        ownOutboundCreatesAfter: createsAfter.count,
        wireMutation:
          "route deliberately changes attachments only for this native no-write 400 control",
      };

      // Pass through the unchanged response produced by the real Worker.
      await route.fulfill({ response });
      rejected.resolve(rejection);
    } catch (error) {
      try {
        await route.abort("failed");
      } catch {
        // Preserve the original route/response/SQL failure.
      }
      rejected.reject(error);
    }
  };

  try {
    await page.route(postUrl, selectedPostRoute);
    handlerInstalled = true;

    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .waitFor({ state: "visible", timeout: EVENT_TIMEOUT_MS });
    await page
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();

    const dialog = page.getByRole("dialog", { name: "今なにしてる？" });
    await dialog.waitFor({ state: "visible", timeout: EVENT_TIMEOUT_MS });
    const editor = dialog.getByPlaceholder("今なにしてる？");
    await editor.fill(content);
    const submit = dialog.getByRole("button", { name: "投稿", exact: true });
    await submit.click();

    await waitForGate(committed);
    const nativeAfterCommit = await readPersistedPost(
      db,
      actorApId,
      commit.postId,
      content,
    );
    const diagnostic = () => ({
      commit: summarizeCommit(commit),
      matchingPostAttempts,
    });
    try {
      await waitForText(
        dialog,
        UNCONFIRMED,
        "post-specific unconfirmed warning",
      );
    } catch (error) {
      const state = {
        ...diagnostic(),
        draft: await editor.inputValue().catch(() => "<composer unavailable>"),
        dialogVisible: await dialog.isVisible().catch(() => false),
      };
      throw new Error(
        "committed-post ACK-loss outcome was not shown as unconfirmed; " +
          JSON.stringify(state) +
          "; sourceExpected=DM classifier semantics with post-specific copy; " +
          String(error),
      );
    }

    requireEffect(
      (await editor.inputValue()) === content &&
        (await dialog.isVisible()) &&
        matchingPostAttempts === 1 &&
        nativeAfterCommit.matchingPosts?.count === 1 &&
        nativeAfterCommit.create?.count === 1,
      "unconfirmed state lost the draft, retried, or changed the committed native post: " +
        JSON.stringify({
          commit: summarizeCommit(commit),
          nativeAfterCommit,
          matchingPostAttempts,
          draft: await editor.inputValue().catch(() => null),
          dialogVisible: await dialog.isVisible().catch(() => false),
        }),
    );

    // Give any immediate retry logic a bounded observation window. Every
    // matching retry remains intercepted and aborted by the route above.
    await page.waitForTimeout(750);
    requireEffect(
      matchingPostAttempts === 1,
      "product automatically retried a committed post after ACK loss",
    );

    // Explicitly leave the failed/unknown composer, then reload the real feed.
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    const discard = page.getByRole("alertdialog", {
      name: "下書きを破棄しますか？",
    });
    await discard.waitFor({ state: "visible", timeout: EVENT_TIMEOUT_MS });
    await discard.getByRole("button", { name: "破棄", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: EVENT_TIMEOUT_MS });
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    const postInFeed = page.getByText(content, { exact: true });
    await postInFeed.first().waitFor({
      state: "visible",
      timeout: EVENT_TIMEOUT_MS,
    });
    await page.waitForTimeout(500);
    const feedCopies = await postInFeed.count();
    const nativeAfterReload = await readPersistedPost(
      db,
      actorApId,
      commit.postId,
      content,
    );
    requireEffect(
      feedCopies === 1 &&
        matchingPostAttempts === 1 &&
        nativeAfterReload.post?.ap_id === commit.postId &&
        nativeAfterReload.matchingPosts?.count === 1 &&
        nativeAfterReload.create?.count === 1,
      "feed reload did not reconcile to the one committed Note without retry: " +
        JSON.stringify({
          commit: summarizeCommit(commit),
          feedCopies,
          matchingPostAttempts,
          nativeAfterReload,
        }),
    );

    // Positive control for the product's definite-rejection path. The UI
    // submits an ordinary public text post; only the intercepted wire body is
    // made invalid, and the browser receives the real Worker HTTP 400.
    await page.route(postUrl, rejectedPostRoute);
    rejectionHandlerInstalled = true;
    await page
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();
    const rejectedDialog = page.getByRole("dialog", {
      name: "今なにしてる？",
    });
    await rejectedDialog.waitFor({
      state: "visible",
      timeout: EVENT_TIMEOUT_MS,
    });
    const rejectedEditor = rejectedDialog.getByPlaceholder("今なにしてる？");
    await rejectedEditor.fill(rejectedContent);
    await rejectedDialog
      .getByRole("button", { name: "投稿", exact: true })
      .click();
    await waitForGate(rejected);
    const rejectedAlert = rejectedDialog
      .getByRole("alert")
      .filter({ hasText: "投稿に失敗しました" });
    const rejectedAlertWait = rejectedAlert.waitFor({
      state: "visible",
      timeout: EVENT_TIMEOUT_MS,
    });
    rejectedAlertWait.catch(() => {});
    try {
      await rejectedAlertWait;
    } catch (error) {
      throw new Error(
        "real native 400 did not show the definite post-failure alert; " +
          JSON.stringify({
            rejection,
            rejectedPostAttempts,
            draft: await rejectedEditor
              .inputValue()
              .catch(() => "<composer unavailable>"),
            alerts: await page
              .getByRole("alert")
              .allTextContents()
              .catch(() => []),
          }) +
          "; " +
          String(error),
      );
    }
    requireEffect(
      (await rejectedEditor.inputValue()) === rejectedContent &&
        (await rejectedDialog.isVisible()) &&
        !(await page.getByText(UNCONFIRMED, { exact: true }).count()) &&
        rejectedPostAttempts === 1 &&
        rejection.status === 400 &&
        rejection.nativeNotes === 0 &&
        rejection.nativeCreates === 0,
      "real 400 was not classified as rejected with its draft preserved and no native write: " +
        JSON.stringify({
          rejection,
          rejectedPostAttempts,
          draft: await rejectedEditor.inputValue().catch(() => null),
          dialogVisible: await rejectedDialog.isVisible().catch(() => false),
        }),
    );
    await page.waitForTimeout(500);
    requireEffect(
      rejectedPostAttempts === 1,
      "product automatically retried a rejected post",
    );
    const rejectedInFeed = await page
      .getByText(rejectedContent, { exact: true })
      .count();
    requireEffect(
      rejectedInFeed === 0,
      "rejected post was rendered in the feed before discard",
    );
    await rejectedDialog
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    const rejectedDiscard = page.getByRole("alertdialog", {
      name: "下書きを破棄しますか？",
    });
    await rejectedDiscard.waitFor({
      state: "visible",
      timeout: EVENT_TIMEOUT_MS,
    });
    await rejectedDiscard
      .getByRole("button", { name: "破棄", exact: true })
      .click();
    await rejectedDialog.waitFor({
      state: "hidden",
      timeout: EVENT_TIMEOUT_MS,
    });
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.getByText(content, { exact: true }).waitFor({
      state: "visible",
      timeout: EVENT_TIMEOUT_MS,
    });
    requireEffect(
      !(await page.getByText(rejectedContent, { exact: true }).count()) &&
        rejectedPostAttempts === 1,
      "post-400 discard did not return to the existing home feed cleanly",
    );

    const result = {
      scope:
        "one real committed public text Note plus a separate real native 400 no-write control from the existing authenticated owner; no new actor/session, fake successful response, automatic retry, or shared idempotency claim",
      outcome:
        "real Worker committed HTTP 200, then browser-facing ACK aborted",
      ownerActorApId: actorApId,
      postApId: commit.postId,
      workerStatus: commit.status,
      nativeNoteCount: nativeAfterReload.matchingPosts.count,
      outboundCreateCount: nativeAfterReload.create.count,
      browserRequestAttempts: matchingPostAttempts,
      visibleUnconfirmedWarning: UNCONFIRMED,
      feedCopiesAfterReload: feedCopies,
      rejectionControl: {
        ...rejection,
        requestAttempts: rejectedPostAttempts,
        visibleAlert: "投稿に失敗しました",
        draftPreservedUntilExplicitDiscard: true,
        noUnconfirmedWarning: true,
        postCopiesInFeed: rejectedInFeed,
      },
      checks: [
        "browser-post-worker-commit-before-ack-loss",
        "browser-post-lost-ack-shown-unconfirmed-with-draft",
        "browser-post-no-automatic-retry",
        "browser-post-feed-reload-reconciles-one-committed-note",
        "browser-post-real-native-400-rejected-with-draft",
        "browser-post-real-native-400-produces-no-note-or-create",
        "browser-post-real-native-400-discard-returns-home",
      ],
    };
    checks.push(...result.checks);
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError;
    for (const handler of [
      ...(rejectionHandlerInstalled ? [rejectedPostRoute] : []),
      ...(handlerInstalled ? [selectedPostRoute] : []),
    ]) {
      try {
        await page.unroute(postUrl, handler);
      } catch (error) {
        cleanupError ??= error;
        process.stderr.write("browser-post-outcome route cleanup failed\n");
      }
    }
    if (cleanupError && !primaryError) throw cleanupError;
  }
}
