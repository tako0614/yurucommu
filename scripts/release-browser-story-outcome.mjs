// Focused browser qualification for retained Story publication outcomes. The
// fixture uses a disposable native Worker and never claims remote idempotency.

function requireEffect(condition, message) {
  if (!condition) throw new Error(`browser-story-outcome ${message}`);
}

function bounded(promise, label, timeoutMs = 15_000) {
  let timer;
  promise.catch(() => {});
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs,
    );
  });
  deadline.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function createPhotoAndPoll(page, dialog, question) {
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await dialog
    .getByRole("button", { name: "写真を追加" })
    .click({ timeout: 10_000 });
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "story-outcome-photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('[role="dialog"] canvas');
      if (
        !(canvas instanceof HTMLCanvasElement) ||
        !canvas.width ||
        !canvas.height
      )
        return false;
      const rgba = canvas
        .getContext("2d")
        ?.getImageData(
          Math.floor(canvas.width / 2),
          Math.floor(canvas.height / 2),
          1,
          1,
        ).data;
      return (
        rgba &&
        Math.abs(rgba[0] - 16) <= 3 &&
        Math.abs(rgba[1] - 80) <= 3 &&
        Math.abs(rgba[2] - 200) <= 3 &&
        rgba[3] === 255
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  await dialog
    .getByRole("button", { name: "スタンプ" })
    .click({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "投票" }).click({ timeout: 10_000 });
  const poll = page.getByRole("dialog", { name: "投票" });
  await poll.waitFor({ state: "visible", timeout: 10_000 });
  await poll.getByPlaceholder("質問を入力").fill(question);
  await poll.getByPlaceholder("選択肢 1").fill(`option-one-${question}`);
  await poll.getByPlaceholder("選択肢 2").fill(`option-two-${question}`);
  // Inputs enforce the product's length limits. Preserve their accepted values.
  const draft = {
    question: await poll.getByPlaceholder("質問を入力").inputValue(),
    options: [
      await poll.getByPlaceholder("選択肢 1").inputValue(),
      await poll.getByPlaceholder("選択肢 2").inputValue(),
    ],
  };
  await poll.getByRole("button", { name: "完了" }).click({ timeout: 10_000 });
  await poll.waitFor({ state: "hidden", timeout: 10_000 });
  return draft;
}

async function openComposer(page, dialog) {
  await page
    .getByRole("button", { name: "ストーリーを追加" })
    .first()
    .click({ timeout: 10_000 });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
}

async function waitForRecoveryFocus(page) {
  await page.waitForFunction(
    () => {
      const recovery = document.querySelector(
        '[role="region"][aria-label="ストーリーの投稿結果"]',
      );
      return recovery?.contains(document.activeElement);
    },
    undefined,
    { timeout: 10_000 },
  );
}

function intentKey(origin, actorApId) {
  const endpoint = new URL("/api/stories", origin).href;
  return `yurucommu:story-intent:v1:${encodeURIComponent(origin)}:${encodeURIComponent(actorApId)}:${encodeURIComponent(endpoint)}`;
}

async function readIntent(page, key) {
  return page.evaluate((storageKey) => {
    const raw = sessionStorage.getItem(storageKey);
    return { raw, record: raw ? JSON.parse(raw) : null };
  }, key);
}

async function nativeStory(db, actorApId, caption) {
  return db
    .prepare(
      `SELECT o.ap_id, o.type, o.attributed_to, o.attachments_json,
       (SELECT COUNT(*) FROM activities a WHERE a.object_ap_id = o.ap_id
         AND a.type = 'Create' AND a.actor_ap_id = ? AND a.direction = 'outbound') AS create_count,
       (SELECT COUNT(*) FROM objects exact_story WHERE exact_story.type = 'Story'
         AND exact_story.attributed_to = ?
         AND json_extract(exact_story.attachments_json, '$.caption') = ?) AS matching_story_count,
       (SELECT COUNT(*) FROM activities exact_create JOIN objects exact_story
         ON exact_story.ap_id = exact_create.object_ap_id
         WHERE exact_create.type = 'Create' AND exact_create.actor_ap_id = ?
           AND exact_create.direction = 'outbound' AND exact_story.type = 'Story'
           AND exact_story.attributed_to = ?
           AND json_extract(exact_story.attachments_json, '$.caption') = ?) AS matching_create_count
     FROM objects o WHERE o.type = 'Story' AND o.attributed_to = ?
       AND json_extract(o.attachments_json, '$.caption') = ?`,
    )
    .bind(
      actorApId,
      actorApId,
      caption,
      actorApId,
      actorApId,
      caption,
      actorApId,
      caption,
    )
    .first();
}

async function globalStoryCreateCount(db, actorApId) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM activities a JOIN objects o
         ON o.ap_id = a.object_ap_id
       WHERE a.type = 'Create' AND a.actor_ap_id = ? AND a.direction = 'outbound'
         AND o.type = 'Story' AND o.attributed_to = ?`,
    )
    .bind(actorApId, actorApId)
    .first();
  return row?.count ?? 0;
}

async function uploadedMedia(db, worker, mediaKey) {
  const row = await db
    .prepare(
      "SELECT id, uploader_ap_id, content_type, r2_key FROM media_uploads WHERE r2_key = ?",
    )
    .bind(mediaKey)
    .first();
  const object = await (await worker.getR2Bucket("MEDIA")).head(mediaKey);
  return {
    row,
    object: object
      ? {
          key: object.key,
          size: object.size,
          httpMetadata: object.httpMetadata,
        }
      : null,
  };
}

async function discardRecovery(page, region) {
  const discard = region.getByRole("button", {
    name: "このタブの投稿記録を破棄",
  });
  await discard.click({ timeout: 10_000 });
  const confirmation = page.getByRole("alertdialog", {
    name: "このタブの投稿記録を破棄",
  });
  await confirmation.waitFor({ state: "visible", timeout: 10_000 });
  await confirmation
    .getByRole("button", { name: "このタブの投稿記録を破棄" })
    .click({ timeout: 10_000 });
}

export async function qualifyBrowserStoryOutcome({
  page,
  db,
  worker,
  origin,
  actorApId,
  checks,
}) {
  requireEffect(
    page && db && worker && Array.isArray(checks),
    "page, D1, R2 Worker, and checks are required",
  );
  const base = new URL(origin).origin;
  requireEffect(
    new URL(actorApId).origin === base,
    "actor must belong to fixture origin",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  const dialog = page.getByRole("dialog", { name: "ストーリー作成" });
  const region = page.getByRole("region", { name: "ストーリーの投稿結果" });
  const key = intentKey(base, actorApId);
  const requests = [];
  const uploads = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.origin === base &&
      url.pathname === "/api/stories"
    ) {
      let body = null;
      try {
        body = request.postDataJSON();
      } catch {}
      requests.push({ url: url.href, body });
    }
    if (
      request.method() === "POST" &&
      url.origin === base &&
      url.pathname === "/api/media/upload"
    )
      uploads.push(url.href);
  };
  page.on("request", onRequest);
  let activeRoutes = [];
  const addRoute = async (handler) => {
    await page.route("**/api/stories", handler);
    activeRoutes.push(handler);
  };
  const removeRoutes = async () => {
    for (const handler of activeRoutes.splice(0))
      await page.unroute("**/api/stories", handler);
  };
  const cleanupStoragePatch = async () =>
    page
      .evaluate(() => {
        if (window.__storyOutcomeStorageOriginal) {
          Storage.prototype.setItem =
            window.__storyOutcomeStorageOriginal.setItem;
          Storage.prototype.removeItem =
            window.__storyOutcomeStorageOriginal.removeItem;
          delete window.__storyOutcomeStorageOriginal;
        }
      })
      .catch(() => {});
  const result = {
    kind: "yurucommu.story-outcome@v1",
    cases: [],
    finalIntent: null,
  };
  let primaryError;
  let pendingUploadCleanup = null;
  try {
    // 1. A real 201 is committed in D1/R2, then its browser ACK is dropped.
    const caption = `story-outcome-${crypto.randomUUID()}`;
    const question = `story-poll-${crypto.randomUUID()}`;
    await openComposer(page, dialog);
    await createPhotoAndPoll(page, dialog, question);
    await dialog.getByPlaceholder("キャプションを追加...").fill(caption);
    let workerResponse;
    let workerBody;
    let workerBytes;
    let routeCompleteResolve;
    const routeComplete = new Promise((resolve) => {
      routeCompleteResolve = resolve;
    });
    let commitResolve;
    const committed = new Promise((resolve) => {
      commitResolve = resolve;
    });
    committed.catch(() => {});
    let releaseAck;
    const ackGate = new Promise((resolve) => {
      releaseAck = resolve;
    });
    const lostAckRoute = async (route) => {
      const req = route.request();
      if (
        req.method() !== "POST" ||
        new URL(req.url()).pathname !== "/api/stories"
      )
        return route.fallback();
      try {
        workerResponse = await route.fetch({
          maxRedirects: 0,
          timeout: 15_000,
        });
        workerBytes = await workerResponse.body();
        workerBody = JSON.parse(workerBytes.toString("utf8"));
        commitResolve();
        await ackGate;
        await route.abort("failed");
      } catch (error) {
        commitResolve(error);
        try {
          await route.abort("failed");
        } catch {}
      } finally {
        routeCompleteResolve();
      }
    };
    await addRoute(lostAckRoute);
    await dialog
      .getByRole("button", { name: "ストーリーズに投稿" })
      .click({ timeout: 10_000 });
    const routeResult = await bounded(committed, "Story commit");
    requireEffect(
      !(routeResult instanceof Error) && workerResponse?.status() === 201,
      `real Story creation returned ${workerResponse?.status()}`,
    );
    const story = workerBody?.story;
    requireEffect(
      typeof story?.ap_id === "string" &&
        story.author?.ap_id === actorApId &&
        story.caption === caption &&
        story.attachment?.r2_key &&
        story.attachment?.url &&
        story.attachment?.mediaType === "image/jpeg",
      `Worker 201 did not acknowledge submitted Story: ${JSON.stringify(workerBody)}`,
    );
    const native = await nativeStory(db, actorApId, caption);
    const nativeData = JSON.parse(native?.attachments_json ?? "{}");
    requireEffect(
      native?.ap_id === story.ap_id &&
        native.type === "Story" &&
        nativeData.attachment?.r2_key === story.attachment.r2_key &&
        native.create_count === 1 &&
        native.matching_story_count === 1 &&
        native.matching_create_count === 1,
      `D1 did not persist exactly one Story/Create: ${JSON.stringify({ native, nativeData })}`,
    );
    requireEffect(
      requests.length === 1 && uploads.length === 1,
      `expected one Story POST and upload, got ${requests.length}/${uploads.length}`,
    );
    const firstIntent = await readIntent(page, key);
    requireEffect(
      firstIntent.record?.status === "pending" ||
        firstIntent.record?.status === "unconfirmed",
      `intent was not stored before POST: ${JSON.stringify(firstIntent.record)}`,
    );
    releaseAck();
    await bounded(routeComplete, "ACK loss route cleanup");
    await removeRoutes();
    await region.waitFor({ state: "visible", timeout: 15_000 });
    await region
      .getByText(/結果を確認できません/)
      .waitFor({ state: "visible", timeout: 10_000 });
    requireEffect(
      (await region
        .getByLabel("保持したストーリーのキャプション")
        .inputValue()) === caption,
      "lost ACK caption was not retained",
    );
    await page.waitForFunction(
      () => {
        const recovery = document.querySelector(
          '[role="region"][aria-label="ストーリーの投稿結果"]',
        );
        return recovery?.contains(document.activeElement);
      },
      undefined,
      { timeout: 10_000 },
    );
    const retainedCaption =
      region.getByLabel("保持したストーリーのキャプション");
    await retainedCaption.focus();
    await retainedCaption.press("ControlOrMeta+A");
    requireEffect(
      await retainedCaption.evaluate(
        (element) =>
          element.readOnly &&
          !element.disabled &&
          document.activeElement === element &&
          element.selectionStart === 0 &&
          element.selectionEnd === element.value.length,
      ),
      "retained caption could not be focused and selected for copying",
    );
    await page.keyboard.press("Tab");
    requireEffect(
      await region.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      "recovery keyboard focus escaped into the inert editor",
    );
    await page.waitForTimeout(300);
    requireEffect(
      requests.length === 1,
      "lost ACK triggered an automatic Story POST retry",
    );
    let persisted = await readIntent(page, key);
    requireEffect(
      persisted.record?.status === "unconfirmed" &&
        persisted.record.payload.caption === caption &&
        persisted.record.payload.attachment.r2_key === story.attachment.r2_key,
      "lost ACK did not persist exact unconfirmed intent",
    );
    result.cases.push({
      name: "lost-ack",
      storyId: story.ap_id,
      workerStatus: workerResponse.status(),
      postCount: requests.length,
      createCount: native.create_count,
      uploadCount: uploads.length,
      media: story.attachment.r2_key,
      intent: persisted.record,
    });
    checks.push(
      "browser-story-outcome-real-commit-lost-ack-retained-without-auto-retry",
    );

    // Close, reopen and same-tab reload must hydrate the identical intent.
    const identity = JSON.stringify(persisted.record);
    await region
      .getByRole("button", { name: "記録を残して閉じる" })
      .click({ timeout: 10_000 });
    await region.waitFor({ state: "hidden", timeout: 10_000 });
    await openComposer(page, dialog);
    await region.waitFor({ state: "visible", timeout: 10_000 });
    await waitForRecoveryFocus(page);
    requireEffect(
      JSON.stringify((await readIntent(page, key)).record) === identity &&
        requests.length === 1,
      "close/reopen changed intent or sent another POST",
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    await openComposer(page, dialog);
    await region.waitFor({ state: "visible", timeout: 15_000 });
    await waitForRecoveryFocus(page);
    persisted = await readIntent(page, key);
    requireEffect(
      persisted.record?.status === "unconfirmed" &&
        JSON.stringify(persisted.record) === identity &&
        requests.length === 1,
      "same-tab reload did not recover the same intent without POST",
    );
    checks.push(
      "browser-story-outcome-close-reopen-and-reload-recover-identical-intent",
    );

    // Explicit duplicate-risk confirmation is accepted; block the second POST
    // before Worker so this fixture can verify routing without making a duplicate.
    let retryIntercepts = 0;
    const retryRoute = async (route) => {
      const req = route.request();
      if (
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/stories"
      ) {
        retryIntercepts++;
        await route.abort("failed");
      } else await route.fallback();
    };
    await addRoute(retryRoute);
    const retry = region.getByRole("button", { name: "保持した内容を再送" });
    await retry.click({ timeout: 10_000 });
    const retryDialog = page.getByRole("alertdialog", {
      name: "保持した内容を再送",
    });
    await retryDialog
      .getByText(/重複/)
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.keyboard.press("Escape");
    await retryDialog.waitFor({ state: "hidden", timeout: 10_000 });
    requireEffect(
      (await dialog.isVisible()) &&
        (await region.evaluate((element) =>
          element.contains(document.activeElement),
        )) &&
        requests.length === 1,
      "Escape from retry confirmation lost recovery focus or sent a POST",
    );
    await retry.click({ timeout: 10_000 });
    await retryDialog.waitFor({ state: "visible", timeout: 10_000 });
    await retryDialog
      .getByRole("button", { name: "保持した内容を再送" })
      .click({ timeout: 10_000 });
    await page
      .getByText("投稿中...", { exact: true })
      .waitFor({ state: "hidden", timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(250);
    await removeRoutes();
    requireEffect(
      retryIntercepts === 1 &&
        requests.length === 2 &&
        uploads.length === 1 &&
        requests[1]?.body?.attachment?.r2_key === story.attachment.r2_key,
      `confirmed retry did not reuse stored upload or was repeated: ${JSON.stringify({ retryIntercepts, posts: requests.length, uploads: uploads.length, retry: requests[1]?.body })}`,
    );
    persisted = await readIntent(page, key);
    requireEffect(
      persisted.record?.status === "unconfirmed" &&
        persisted.record.payload.caption === caption,
      "blocked explicit retry lost retained intent",
    );
    result.cases[0].retry = {
      duplicateRiskConfirmed: true,
      interceptedBeforeWorker: true,
      postCount: requests.length,
      uploadCount: uploads.length,
      attachmentKey: requests[1].body.attachment.r2_key,
    };
    checks.push(
      "browser-story-outcome-explicit-retry-confirms-duplicate-risk-reuses-upload",
    );

    await discardRecovery(page, region);
    await region.waitFor({ state: "hidden", timeout: 10_000 });
    requireEffect(
      (await readIntent(page, key)).raw === null,
      "local discard did not remove only this tab intent",
    );
    const afterDiscard = await nativeStory(db, actorApId, caption);
    const retainedMedia = await uploadedMedia(
      db,
      worker,
      story.attachment.r2_key,
    );
    requireEffect(
      afterDiscard?.ap_id === story.ap_id &&
        afterDiscard.create_count === 1 &&
        afterDiscard.matching_story_count === 1 &&
        afterDiscard.matching_create_count === 1 &&
        retainedMedia.row?.r2_key === story.attachment.r2_key &&
        retainedMedia.object?.key === story.attachment.r2_key,
      "discard removed canonical Story/Create or uploaded media",
    );
    result.cases[0].afterDiscard = {
      storyId: afterDiscard.ap_id,
      createCount: afterDiscard.create_count,
      mediaKey: retainedMedia.row.r2_key,
      mediaExists: Boolean(retainedMedia.object),
      intent: null,
    };
    checks.push("browser-story-outcome-discard-clears-only-local-intent");

    // 2. Malformed/mismatching 201 after a second real native commit.
    const malformedCaption = `story-malformed-ack-${crypto.randomUUID()}`;
    await openComposer(page, dialog);
    await createPhotoAndPoll(page, dialog, `poll-${malformedCaption}`);
    await dialog
      .getByPlaceholder("キャプションを追加...")
      .fill(malformedCaption);
    let malformedStatus;
    let malformedStory;
    const malformedRoute = async (route) => {
      const req = route.request();
      if (
        req.method() !== "POST" ||
        new URL(req.url()).pathname !== "/api/stories"
      )
        return route.fallback();
      const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      malformedStatus = response.status();
      const body = await response.json();
      malformedStory = body?.story;
      await route.fulfill({
        response,
        body: JSON.stringify({
          ...body,
          story: { ...body.story, caption: `${malformedCaption}-mismatch` },
        }),
      });
    };
    await addRoute(malformedRoute);
    await dialog
      .getByRole("button", { name: "ストーリーズに投稿" })
      .click({ timeout: 10_000 });
    await region.waitFor({ state: "visible", timeout: 15_000 });
    await region
      .getByText(/結果を確認できません/)
      .waitFor({ state: "visible", timeout: 10_000 });
    await removeRoutes();
    const malformedNative = await nativeStory(db, actorApId, malformedCaption);
    requireEffect(
      malformedStatus === 201 &&
        malformedStory?.ap_id === malformedNative?.ap_id &&
        malformedNative.create_count === 1 &&
        malformedNative.matching_story_count === 1 &&
        malformedNative.matching_create_count === 1 &&
        (await readIntent(page, key)).record?.status === "unconfirmed",
      "mismatching 201 did not become unconfirmed after native commit",
    );
    const malformedMediaKey = (await readIntent(page, key)).record.payload
      .attachment.r2_key;
    await discardRecovery(page, region);
    await region.waitFor({ state: "hidden", timeout: 10_000 });
    const malformedAfter = await nativeStory(db, actorApId, malformedCaption);
    const malformedMedia = await uploadedMedia(db, worker, malformedMediaKey);
    requireEffect(
      malformedAfter?.ap_id === malformedNative.ap_id &&
        malformedAfter.create_count === 1 &&
        malformedAfter.matching_story_count === 1 &&
        malformedAfter.matching_create_count === 1 &&
        malformedMedia.row?.r2_key === malformedMediaKey,
      "malformed-ACK discard deleted canonical data",
    );
    result.cases.push({
      name: "mismatching-201",
      workerStatus: malformedStatus,
      storyId: malformedStory.ap_id,
      createCount: malformedNative.create_count,
      uploadCount: uploads.length,
      mediaKey: malformedMediaKey,
      afterDiscard: {
        storyId: malformedAfter.ap_id,
        createCount: malformedAfter.create_count,
        mediaExists: Boolean(malformedMedia.object),
      },
      intent: null,
    });
    checks.push(
      "browser-story-outcome-mismatching-201-retained-and-locally-discardable",
    );

    // 3. Core's 500-character refusal is a documented pre-write rejection.
    const longCaption = "x".repeat(501);
    await openComposer(page, dialog);
    await createPhotoAndPoll(page, dialog, `poll-${crypto.randomUUID()}`);
    await dialog.getByPlaceholder("キャプションを追加...").fill(longCaption);
    let rejectionStatus;
    const rejectedPost = (response) => {
      if (
        new URL(response.url()).pathname === "/api/stories" &&
        response.request().method() === "POST"
      )
        rejectionStatus = response.status();
    };
    page.on("response", rejectedPost);
    const postsBeforeRejected = requests.length;
    const storyCreatesBeforeRejected = await globalStoryCreateCount(
      db,
      actorApId,
    );
    await dialog
      .getByRole("button", { name: "ストーリーズに投稿" })
      .click({ timeout: 10_000 });
    await region.waitFor({ state: "visible", timeout: 15_000 });
    await region
      .getByText(/受け付けられません/)
      .waitFor({ state: "visible", timeout: 10_000 });
    page.off("response", rejectedPost);
    const rejectedIntent = await readIntent(page, key);
    requireEffect(
      rejectionStatus === 400 &&
        requests.length === postsBeforeRejected + 1 &&
        requests.at(-1)?.body?.caption === longCaption &&
        rejectedIntent.record?.status === "rejected" &&
        rejectedIntent.record.payload.caption === longCaption,
      `501-character caption did not reach Core and persist safe rejection: ${JSON.stringify({ rejectionStatus, request: requests.at(-1), intent: rejectedIntent.record?.status })}`,
    );
    const rejectedNative = await nativeStory(db, actorApId, longCaption);
    const rejectedCounts = await db
      .prepare(
        `SELECT COUNT(*) AS story_count,
           (SELECT COUNT(*) FROM activities a JOIN objects o ON o.ap_id = a.object_ap_id
            WHERE a.type = 'Create' AND a.actor_ap_id = ? AND a.direction = 'outbound'
              AND o.type = 'Story' AND o.attributed_to = ?
              AND json_extract(o.attachments_json, '$.caption') = ?) AS create_count
         FROM objects WHERE type = 'Story' AND attributed_to = ?
           AND json_extract(attachments_json, '$.caption') = ?`,
      )
      .bind(actorApId, actorApId, longCaption, actorApId, longCaption)
      .first();
    const storyCreatesAfterRejected = await globalStoryCreateCount(
      db,
      actorApId,
    );
    requireEffect(
      !rejectedNative &&
        rejectedCounts?.story_count === 0 &&
        rejectedCounts.create_count === 0 &&
        storyCreatesAfterRejected === storyCreatesBeforeRejected,
      `Core 400 unexpectedly created a Story/Create or changed total Story Creates: ${JSON.stringify({ rejectedCounts, storyCreatesBeforeRejected, storyCreatesAfterRejected })}`,
    );
    result.cases.push({
      name: "core-400-caption-501",
      status: rejectionStatus,
      postCount: requests.length,
      createCount: 0,
      uploadCount: uploads.length,
      retainedCaptionLength: rejectedIntent.record.payload.caption.length,
      intent: rejectedIntent.record.status,
      safeRetryAvailable: await region
        .getByRole("button", { name: "保持した内容を再送" })
        .isVisible(),
    });
    await region
      .getByRole("button", { name: "元の下書きの編集に戻る" })
      .click({ timeout: 10_000 });
    await region.waitFor({ state: "hidden", timeout: 10_000 });
    const restoredCaption = dialog.getByPlaceholder("キャプションを追加...");
    await page.waitForFunction(
      () => {
        const editor = document.querySelector(
          '[role="dialog"][aria-label="ストーリー作成"] fieldset',
        );
        return (
          editor?.contains(document.activeElement) &&
          !document.activeElement?.closest("[inert]")
        );
      },
      undefined,
      { timeout: 10_000 },
    );
    requireEffect(
      (await restoredCaption.inputValue()) === longCaption &&
        (await restoredCaption.isEditable()),
      "Core-rejected caption was not restored to the editable mounted draft",
    );
    const restoredPoll = dialog
      .locator(".pointer-events-auto.absolute.flex")
      .filter({ hasText: "option-one-poll-" });
    requireEffect(
      (await restoredPoll.count()) === 1 &&
        (await readIntent(page, key)).raw === null,
      "editing recovery did not retain the rendered poll or clear the rejected intent",
    );
    const correctedCaption = `corrected-${crypto.randomUUID()}`;
    await restoredCaption.fill(correctedCaption);
    requireEffect(
      requests.length === postsBeforeRejected + 1,
      "editing the rejected draft automatically resent it",
    );
    await dialog
      .locator('button[aria-label="閉じる"]')
      .click({ timeout: 10_000 });
    const discardDraft = page.getByRole("alertdialog", {
      name: "下書きを破棄しますか？",
    });
    await discardDraft.waitFor({ state: "visible", timeout: 10_000 });
    await discardDraft
      .getByRole("button", { name: "破棄", exact: true })
      .click({ timeout: 10_000 });
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    requireEffect(
      (await readIntent(page, key)).raw === null &&
        requests.length === postsBeforeRejected + 1 &&
        (await globalStoryCreateCount(db, actorApId)) ===
          storyCreatesBeforeRejected,
      "discarding the corrected rejected draft changed intent or created a Story",
    );
    checks.push(
      "browser-story-outcome-core-400-retains-501-character-prewrite-rejection",
    );

    // 4. A denied sessionStorage write after media upload must block Story POST.
    await page.evaluate((storageKey) => {
      window.__storyOutcomeStorageOriginal = {
        setItem: Storage.prototype.setItem,
        removeItem: Storage.prototype.removeItem,
      };
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (this === sessionStorage && name === storageKey)
          throw new DOMException(
            "fixture denied Story intent write",
            "QuotaExceededError",
          );
        return original.call(this, name, value);
      };
    }, key);
    await openComposer(page, dialog);
    await createPhotoAndPoll(page, dialog, `poll-${crypto.randomUUID()}`);
    const deniedCaption = `story-storage-denied-${crypto.randomUUID()}`;
    await dialog.getByPlaceholder("キャプションを追加...").fill(deniedCaption);
    const postsBeforeStorageDenial = requests.length;
    const uploadsBeforeStorageDenial = uploads.length;
    await dialog
      .getByRole("button", { name: "ストーリーズに投稿" })
      .click({ timeout: 10_000 });
    await region.waitFor({ state: "visible", timeout: 15_000 });
    await region
      .getByText(/安全に保存/)
      .waitFor({ state: "visible", timeout: 10_000 });
    requireEffect(
      requests.length === postsBeforeStorageDenial &&
        uploads.length === uploadsBeforeStorageDenial + 1 &&
        (await readIntent(page, key)).raw === null,
      "storage write denial did not block Story POST after one real upload",
    );
    result.cases.push({
      name: "session-storage-write-denied",
      storyPostCount: requests.length - postsBeforeStorageDenial,
      uploadCount: uploads.length - uploadsBeforeStorageDenial,
      intent: null,
      result: "blocked-before-story-post",
    });
    checks.push("browser-story-outcome-denied-intent-write-blocks-story-post");
    await cleanupStoragePatch();
    await region
      .getByRole("button", {
        name: "未保存の内容が失われる可能性を理解して閉じる",
      })
      .click({ timeout: 10_000 });
    await region.waitFor({ state: "hidden", timeout: 10_000 });

    // 5. A changed/corrupt intent key after a real upload blocks Story POST
    // and exposes mounted draft text for copying without overwriting that key.
    await openComposer(page, dialog);
    const conflictPoll = await createPhotoAndPoll(
      page,
      dialog,
      `poll-storage-conflict-${crypto.randomUUID()}`,
    );
    const conflictCaption = `story-storage-conflict-${crypto.randomUUID()}`;
    await dialog
      .getByPlaceholder("キャプションを追加...")
      .fill(conflictCaption);
    let uploadHeldResolve;
    const uploadHeld = new Promise((resolve) => {
      uploadHeldResolve = resolve;
    });
    let releaseUpload;
    const uploadGate = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    let heldUploadStatus;
    let heldUploadBytes;
    let heldUploadBody;
    let heldUploadCount = 0;
    let uploadRouteCompleteResolve;
    const uploadRouteComplete = new Promise((resolve) => {
      uploadRouteCompleteResolve = resolve;
    });
    const holdUploadAck = async (route) => {
      const req = route.request();
      if (
        req.method() !== "POST" ||
        new URL(req.url()).pathname !== "/api/media/upload"
      )
        return route.fallback();
      heldUploadCount++;
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: 15_000,
        });
        heldUploadStatus = response.status();
        heldUploadBytes = await response.body();
        heldUploadBody = JSON.parse(heldUploadBytes.toString("utf8"));
        uploadHeldResolve();
        await uploadGate;
        await route.fulfill({ response, body: heldUploadBytes });
      } catch (error) {
        uploadHeldResolve(error);
        try {
          await route.abort("failed");
        } catch {}
      } finally {
        uploadRouteCompleteResolve();
      }
    };
    await page.route("**/api/media/upload", holdUploadAck);
    pendingUploadCleanup = async () => {
      releaseUpload();
      await page.unroute("**/api/media/upload", holdUploadAck);
      await bounded(
        uploadRouteComplete,
        "held Story upload route cleanup",
        10_000,
      );
    };
    const conflictPostsBefore = requests.length;
    const conflictUploadsBefore = uploads.length;
    await dialog
      .getByRole("button", { name: "ストーリーズに投稿" })
      .click({ timeout: 10_000 });
    const heldOutcome = await bounded(uploadHeld, "held Story upload response");
    requireEffect(
      !(heldOutcome instanceof Error) &&
        heldUploadStatus === 200 &&
        typeof heldUploadBody?.r2_key === "string",
      `real media upload did not reach the held response: ${heldUploadStatus}`,
    );
    const corruptStorageBytes = "{fixture-local-corrupt-story-intent";
    await page.evaluate(
      ({ storageKey, bytes }) => sessionStorage.setItem(storageKey, bytes),
      { storageKey: key, bytes: corruptStorageBytes },
    );
    releaseUpload();
    await bounded(uploadRouteComplete, "held Story upload route completion");
    await page.unroute("**/api/media/upload", holdUploadAck);
    pendingUploadCleanup = null;
    await region.waitFor({ state: "visible", timeout: 15_000 });
    await region
      .getByText(/安全に保存/)
      .waitFor({ state: "visible", timeout: 10_000 });
    const copyCaption = region.getByLabel("保持したストーリーのキャプション");
    const copyOverlays = region.getByLabel("保持したストーリーの投票・リンク");
    const conflictObserved = {
      heldUploadCount,
      heldUploadStatus,
      uploads: uploads.length - conflictUploadsBefore,
      posts: requests.length - conflictPostsBefore,
      caption: await copyCaption.inputValue(),
      overlays: await copyOverlays.inputValue(),
      raw: await page.evaluate(
        (storageKey) => sessionStorage.getItem(storageKey),
        key,
      ),
    };
    requireEffect(
      heldUploadCount === 1 &&
        heldUploadStatus === 200 &&
        uploads.length === conflictUploadsBefore + 1 &&
        requests.length === conflictPostsBefore &&
        (await copyCaption.inputValue()) === conflictCaption &&
        (await copyOverlays.inputValue()) ===
          [conflictPoll.question, ...conflictPoll.options].join("\n") &&
        (await page.evaluate(
          (storageKey) => sessionStorage.getItem(storageKey),
          key,
        )) === corruptStorageBytes,
      `storage conflict did not preserve copy fallback and corrupt value while blocking Story POST: ${JSON.stringify(conflictObserved)}`,
    );
    const conflictMediaRow = await uploadedMedia(
      db,
      worker,
      heldUploadBody.r2_key,
    );
    requireEffect(
      conflictMediaRow.row?.r2_key === heldUploadBody.r2_key &&
        conflictMediaRow.object?.key === heldUploadBody.r2_key,
      "upload response hold did not leave its canonical media in D1/R2",
    );
    result.cases.push({
      name: "corrupt-intent-after-upload",
      storyPostCount: requests.length - conflictPostsBefore,
      uploadCount: uploads.length - conflictUploadsBefore,
      mediaKey: heldUploadBody.r2_key,
      fallbackCaption: conflictCaption,
      fallbackOverlayReadable: true,
      storageBytesUnchanged: true,
      intent: null,
    });
    checks.push(
      "browser-story-outcome-corrupt-intent-after-upload-blocks-post-and-preserves-copy-fallback",
    );
    // Remove only the exact corrupt value introduced by this disposable case.
    await page.evaluate(
      ({ storageKey, bytes }) => {
        if (sessionStorage.getItem(storageKey) === bytes)
          sessionStorage.removeItem(storageKey);
      },
      { storageKey: key, bytes: corruptStorageBytes },
    );
    await region
      .getByRole("button", {
        name: "未保存の内容が失われる可能性を理解して閉じる",
      })
      .click({ timeout: 10_000 });
    await region.waitFor({ state: "hidden", timeout: 10_000 });

    // 6. If cleanup is denied after a valid ACK, the confirmed record must stay
    // locked and must never expose the duplicate-risk retry action.
    await page.evaluate((storageKey) => {
      window.__storyOutcomeStorageOriginal = {
        setItem: Storage.prototype.setItem,
        removeItem: Storage.prototype.removeItem,
      };
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (name) {
        if (this === sessionStorage && name === storageKey)
          throw new DOMException(
            "fixture denied Story intent cleanup",
            "QuotaExceededError",
          );
        return original.call(this, name);
      };
    }, key);
    await openComposer(page, dialog);
    await createPhotoAndPoll(page, dialog, `poll-${crypto.randomUUID()}`);
    const confirmedCaption = `story-confirmed-cleanup-denied-${crypto.randomUUID()}`;
    await dialog
      .getByPlaceholder("キャプションを追加...")
      .fill(confirmedCaption);
    const beforeConfirmed = requests.length;
    await dialog
      .getByRole("button", { name: "ストーリーズに投稿" })
      .click({ timeout: 10_000 });
    await region.waitFor({ state: "visible", timeout: 15_000 });
    await region
      .getByText("ストーリーの投稿を確認しました。この内容を再送しません。", {
        exact: true,
      })
      .waitFor({ state: "visible", timeout: 10_000 });
    let confirmedState = await readIntent(page, key);
    requireEffect(
      confirmedState.record?.status === "confirmed" &&
        requests.length === beforeConfirmed + 1,
      "valid ACK cleanup denial did not retain a confirmed record",
    );
    requireEffect(
      !(await region
        .getByRole("button", { name: "保持した内容を再送" })
        .count()),
      "confirmed record exposed a retry control",
    );
    await page.waitForTimeout(300);
    requireEffect(
      requests.length === beforeConfirmed + 1,
      "cleanup-denied confirmed Story was resent",
    );
    const confirmedNative = await nativeStory(db, actorApId, confirmedCaption);
    requireEffect(
      confirmedNative?.create_count === 1 &&
        confirmedNative.matching_story_count === 1 &&
        confirmedNative.matching_create_count === 1,
      "confirmed cleanup-denial case lacks exactly one native Create",
    );
    result.cases.push({
      name: "confirmed-ack-cleanup-denied",
      storyId: confirmedNative.ap_id,
      status: confirmedState.record.status,
      postCount: requests.length - beforeConfirmed,
      createCount: confirmedNative.create_count,
      retryVisible: false,
      intent: confirmedState.record,
    });
    checks.push(
      "browser-story-outcome-confirmed-ack-cleanup-denial-remains-locked",
    );
    await cleanupStoragePatch();
    await page.evaluate(
      (storageKey) => sessionStorage.removeItem(storageKey),
      key,
    );
    await region
      .getByRole("button", {
        name: "未保存の内容が失われる可能性を理解して閉じる",
      })
      .click({ timeout: 10_000 });
    await region.waitFor({ state: "hidden", timeout: 10_000 });

    result.finalIntent = await readIntent(page, key);
    requireEffect(
      result.finalIntent.raw === null,
      "fixture ended with a Story intent record",
    );
    await page.goto(`${base}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupStoragePatch();
    if (pendingUploadCleanup) {
      try {
        await pendingUploadCleanup();
      } catch (error) {
        if (!primaryError) throw error;
      }
    }
    try {
      await removeRoutes();
    } catch (error) {
      if (!primaryError) throw error;
    }
    page.off("request", onRequest);
  }
}
