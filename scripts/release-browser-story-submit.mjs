import { isDeepStrictEqual } from "node:util";

// Snapshot/freeze qualification for a real Story upload and D1 commit. The
// upload response is held only after the Worker has stored the rendered bytes.

function requireEffect(condition, message) {
  if (!condition) throw new Error(`browser-story-submit-green ${message}`);
}

function bounded(promise, label, timeout = 15_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
  });
  deadline.catch(() => {});
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function waitForResponse(page, pathname, method, label) {
  return page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === pathname &&
        response.request().method() === method,
      { timeout: 15_000 },
    )
    .catch((error) => {
      throw new Error(`${label} response was not observed: ${String(error)}`);
    });
}

function payloadFile(request) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(
    request.headers()["content-type"] ?? "",
  );
  const body = request.postDataBuffer();
  requireEffect(
    boundary && body,
    "rendered photo upload had no multipart body",
  );
  const boundaryValue = (boundary[1] ?? boundary[2]).trim();
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"));
  requireEffect(headerEnd >= 0, "rendered photo multipart header was missing");
  const headers = body.subarray(0, headerEnd).toString("utf8");
  const start = headerEnd + 4;
  const end = body.indexOf(Buffer.from(`\r\n--${boundaryValue}`), start);
  requireEffect(end > start, "rendered photo bytes were missing");
  return {
    filename: /filename="([^"]*)"/i.exec(headers)?.[1],
    contentType: /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim(),
    bytes: body.subarray(start, end),
  };
}

async function readJson(response, label) {
  const body = JSON.parse((await response.body()).toString("utf8"));
  requireEffect(
    response.ok(),
    `${label} failed (${response.status()}): ${JSON.stringify(body)}`,
  );
  return body;
}

async function createPhotoAndPoll(
  page,
  dialog,
  question,
  verifyPhotoEditing = false,
) {
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await dialog.getByRole("button", { name: "写真を追加" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "story-submit-photo.png",
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
  if (verifyPhotoEditing) {
    const canvas = dialog.locator("canvas");
    const bounds = await canvas.boundingBox();
    requireEffect(bounds, "pre-submit Story canvas had no visible bounds");
    const beforeResize = await canvas.evaluate((node) => node.toDataURL());
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await dialog
      .locator("button[title]")
      .first()
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(
      (before) => {
        const canvasNode = document.querySelector('[role="dialog"] canvas');
        return (
          canvasNode instanceof HTMLCanvasElement &&
          canvasNode.toDataURL() !== before
        );
      },
      beforeResize,
      { timeout: 5_000 },
    );
  }
  await dialog.getByRole("button", { name: "スタンプ" }).click();
  await dialog.getByRole("button", { name: "投票" }).click();
  const pollDialog = page.getByRole("dialog", { name: "投票" });
  await pollDialog.waitFor({ state: "visible", timeout: 10_000 });
  await pollDialog.getByPlaceholder("質問を入力").fill(question);
  await pollDialog.getByPlaceholder("選択肢 1").fill("story-green-option-one");
  await pollDialog.getByPlaceholder("選択肢 2").fill("story-green-option-two");
  await pollDialog.getByRole("button", { name: "完了" }).click();
  await pollDialog.waitFor({ state: "hidden", timeout: 10_000 });
  return [
    {
      type: "Question",
      position: { x: 0.5, y: 0.5, width: 0.74, height: 0.18 },
      name: question,
      oneOf: [
        { type: "Note", name: "story-green-option-one" },
        { type: "Note", name: "story-green-option-two" },
      ],
    },
  ];
}

export async function qualifyBrowserStorySubmit({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  requireEffect(
    page && db && Array.isArray(checks),
    "page, D1, and checks are required",
  );
  const base = new URL(origin).origin;
  requireEffect(
    new URL(actorApId).origin === base,
    "actor must belong to fixture origin",
  );

  const captionA = `story-green-caption-A-${crypto.randomUUID()}`;
  const question = `story-green-poll-${crypto.randomUUID()}`;
  const dialog = page.getByRole("dialog", { name: "ストーリー作成" });
  let releaseUpload;
  let notifyUploadHeld;
  let resolveRouteFinished;
  const uploadGate = new Promise((resolve) => (releaseUpload = resolve));
  const uploadHeld = new Promise((resolve) => (notifyUploadHeld = resolve));
  const routeFinished = new Promise(
    (resolve) => (resolveRouteFinished = resolve),
  );
  uploadHeld.catch(() => {});
  let routeEntered = false;
  let routeInstalled = false;
  let routeError = null;
  let uploadRequest = null;
  let uploadResponse = null;
  let uploadBytes = null;
  let uploadBody = null;
  let primaryError = null;
  let abortRouteEntered = false;
  let abortRouteCount = 0;
  let abortRouteInstalled = false;
  let abortRenderedUpload = null;
  let notifyAbortRoute;
  let resolveAbortRoute;
  const abortRouteIntercepted = new Promise(
    (resolve) => (notifyAbortRoute = resolve),
  );
  const abortRouteFinished = new Promise(
    (resolve) => (resolveAbortRoute = resolve),
  );
  let retryRouteEntered = false;
  let retryRouteCount = 0;
  let retryRouteInstalled = false;
  let retryRenderedUpload = null;
  let notifyRetryRoute;
  let resolveRetryRoute;
  const retryRouteIntercepted = new Promise(
    (resolve) => (notifyRetryRoute = resolve),
  );
  const retryRouteFinished = new Promise(
    (resolve) => (resolveRetryRoute = resolve),
  );
  let releaseRetryUpload;
  const retryUploadGate = new Promise(
    (resolve) => (releaseRetryUpload = resolve),
  );
  let storyRequestCount = 0;
  const storyRequests = [];
  const storyRequestTargets = [];
  const recordStoryRequest = (request) => {
    if (
      request.method() !== "POST" ||
      new URL(request.url()).pathname !== "/api/stories"
    )
      return;
    storyRequestCount += 1;
    storyRequestTargets.push(new URL(request.url()).href);
    try {
      storyRequests.push(request.postDataJSON());
    } catch {
      storyRequests.push(null);
    }
  };
  const holdRenderedUpload = async (route) => {
    const request = route.request();
    if (
      request.method() !== "POST" ||
      new URL(request.url()).origin !== base ||
      new URL(request.url()).pathname !== "/api/media/upload"
    ) {
      await route.fallback();
      return;
    }
    routeEntered = true;
    uploadRequest = request;
    try {
      uploadResponse = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      uploadBytes = await uploadResponse.body();
      uploadBody = JSON.parse(uploadBytes.toString("utf8"));
      notifyUploadHeld();
      await uploadGate;
      await route.fulfill({
        status: uploadResponse.status(),
        headers: uploadResponse.headers(),
        body: uploadBytes,
      });
    } catch (error) {
      routeError = error instanceof Error ? error.message : String(error);
      try {
        await route.abort("failed");
      } catch {
        // Keep the primary upload or fixture failure.
      }
      notifyUploadHeld();
    } finally {
      resolveRouteFinished();
    }
  };

  try {
    await page.goto(`${base}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    const addStoryButton = page
      .getByRole("button", { name: "ストーリーを追加" })
      .first();
    await addStoryButton.waitFor({ state: "visible", timeout: 10_000 });
    await addStoryButton.click({ timeout: 10_000 });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const overlays = await createPhotoAndPoll(page, dialog, question, true);
    const caption = dialog.getByPlaceholder("キャプションを追加...");
    await caption.fill(captionA);
    await page.route("**/api/media/upload", holdRenderedUpload);
    routeInstalled = true;
    page.on("request", recordStoryRequest);

    const uploadResponseWait = waitForResponse(
      page,
      "/api/media/upload",
      "POST",
      "Story image upload",
    );
    const storyResponseWait = waitForResponse(
      page,
      "/api/stories",
      "POST",
      "Story create",
    );
    await dialog.getByRole("button", { name: "ストーリーズに投稿" }).click();
    await bounded(uploadHeld, "Story upload hold");
    requireEffect(
      !routeError &&
        uploadResponse?.status() === 200 &&
        uploadRequest &&
        uploadBytes,
      `real media upload failed: ${routeError ?? `status=${uploadResponse?.status()}`}`,
    );
    const photo = payloadFile(uploadRequest);
    requireEffect(
      uploadResponse.status() === 200 &&
        uploadBody?.content_type === "image/jpeg" &&
        typeof uploadBody.url === "string" &&
        typeof uploadBody.r2_key === "string" &&
        photo.filename === "media.jpg" &&
        photo.contentType === "image/jpeg" &&
        photo.bytes.length > 0,
      "held Worker upload was not the real rendered Story JPEG",
    );
    const mediaRow = await db
      .prepare(
        "SELECT uploader_ap_id, content_type, size, r2_key FROM media_uploads WHERE id = ?",
      )
      .bind(uploadBody.id)
      .first();
    requireEffect(
      mediaRow?.uploader_ap_id === actorApId &&
        mediaRow.content_type === "image/jpeg" &&
        mediaRow.size === photo.bytes.length &&
        mediaRow.r2_key === uploadBody.r2_key,
      `real rendered Story upload was absent from native media D1: ${JSON.stringify(mediaRow)}`,
    );

    const captionField = dialog.getByPlaceholder("キャプションを追加...");
    const status = dialog.getByText("投稿中...", { exact: true });
    await status.waitFor({ state: "visible", timeout: 10_000 });
    const editability = await page.evaluate((questionText) => {
      const dialogRoot = document.querySelector(
        '[role="dialog"][aria-label="ストーリー作成"]',
      );
      const captionNode = [
        ...(dialogRoot?.querySelectorAll("input") ?? []),
      ].find(
        (node) => node.getAttribute("placeholder") === "キャプションを追加...",
      );
      const canvasNode = dialogRoot?.querySelector("canvas");
      const headerNode = dialogRoot?.querySelector(
        'button[aria-label="テキスト"]',
      );
      const overlayNode = [
        ...(dialogRoot?.querySelectorAll(
          ".pointer-events-auto.absolute.flex",
        ) ?? []),
      ].find((node) => node.textContent?.includes(questionText));
      const statusText = [...(dialogRoot?.querySelectorAll("*") ?? [])].find(
        (node) =>
          node.childElementCount === 0 &&
          node.textContent?.trim() === "投稿中...",
      );
      const statusNode =
        statusText?.closest('[role="status"], [tabindex]') ?? statusText;
      const inertRoot = captionNode?.closest("[inert]");
      const active = document.activeElement;
      return {
        captionFrozen: Boolean(
          inertRoot && captionNode?.closest("[inert]") === inertRoot,
        ),
        canvasFrozen: Boolean(
          inertRoot && canvasNode?.closest("[inert]") === inertRoot,
        ),
        headerFrozen: Boolean(
          inertRoot && headerNode?.closest("[inert]") === inertRoot,
        ),
        overlayFrozen: Boolean(
          inertRoot && overlayNode?.closest("[inert]") === inertRoot,
        ),
        statusOutsideEditingRoot: Boolean(
          statusNode && statusNode.closest("[inert]") !== inertRoot,
        ),
        statusFocused: Boolean(
          statusNode && (statusNode === active || statusNode.contains(active)),
        ),
        focusInsideDialog: Boolean(
          dialogRoot && active && dialogRoot.contains(active),
        ),
        captionValue: captionNode?.value ?? null,
        canvasData:
          canvasNode instanceof HTMLCanvasElement
            ? canvasNode.toDataURL()
            : null,
        overlayBounds: overlayNode?.getBoundingClientRect().toJSON() ?? null,
      };
    }, question);
    requireEffect(
      editability.captionFrozen &&
        editability.canvasFrozen &&
        editability.headerFrozen &&
        editability.overlayFrozen &&
        editability.statusOutsideEditingRoot &&
        editability.statusFocused &&
        editability.focusInsideDialog &&
        editability.captionValue === captionA &&
        editability.canvasData,
      `posting state did not freeze the complete draft while keeping status focused: ${JSON.stringify(editability)}`,
    );

    await page.keyboard.press("Escape");
    requireEffect(
      await dialog.isVisible(),
      "Escape closed the Story composer while the actual upload response was held",
    );
    await page.keyboard.press("Tab");
    const afterKeyboard = await page.evaluate(() => {
      const dialogRoot = document.querySelector(
        '[role="dialog"][aria-label="ストーリー作成"]',
      );
      const statusNode = dialogRoot?.querySelector('[role="status"]');
      const active = document.activeElement;
      const captionNode = [
        ...(dialogRoot?.querySelectorAll("input") ?? []),
      ].find(
        (node) => node.getAttribute("placeholder") === "キャプションを追加...",
      );
      return {
        focusInsideDialog: Boolean(
          dialogRoot && active && dialogRoot.contains(active),
        ),
        focusInsideInertDraft: Boolean(
          active instanceof HTMLElement && active.closest("[inert]"),
        ),
        statusMounted: Boolean(statusNode && statusNode.isConnected),
        statusFocused: Boolean(statusNode && statusNode === active),
        caption: captionNode?.value ?? null,
      };
    });
    requireEffect(
      afterKeyboard.focusInsideDialog &&
        !afterKeyboard.focusInsideInertDraft &&
        afterKeyboard.statusMounted &&
        afterKeyboard.statusFocused &&
        afterKeyboard.caption === captionA,
      `Tab/Escape moved focus into the inert draft or changed the caption: ${JSON.stringify(afterKeyboard)}`,
    );
    await page.keyboard.press("Shift+Tab");
    const afterShiftTab = await page.evaluate(() => {
      const root = document.querySelector(
        '[role="dialog"][aria-label="ストーリー作成"]',
      );
      const statusNode = root?.querySelector('[role="status"]');
      const active = document.activeElement;
      return {
        statusMounted: Boolean(statusNode && statusNode.isConnected),
        statusFocused: Boolean(statusNode && active === statusNode),
        focusInsideDialog: Boolean(root && active && root.contains(active)),
      };
    });
    requireEffect(
      afterShiftTab.statusMounted &&
        afterShiftTab.statusFocused &&
        afterShiftTab.focusInsideDialog,
      `Shift+Tab moved focus away from the mounted submission status: ${JSON.stringify(afterShiftTab)}`,
    );

    const canvas = dialog.locator("canvas");
    const canvasBounds = await canvas.boundingBox();
    requireEffect(
      canvasBounds,
      "Story canvas had no visible bounds during submission",
    );
    const imageBefore = await page.evaluate(
      () =>
        document
          .querySelector('[role="dialog"][aria-label="ストーリー作成"] canvas')
          ?.toDataURL() ?? null,
    );
    await page.mouse.move(
      canvasBounds.x + canvasBounds.width * 0.2,
      canvasBounds.y + canvasBounds.height * 0.7,
    );
    await page.mouse.down();
    await page.mouse.move(
      canvasBounds.x + canvasBounds.width * 0.35,
      canvasBounds.y + canvasBounds.height * 0.78,
      { steps: 3 },
    );
    await page.mouse.up();
    const afterCanvasGesture = await page.evaluate(
      () =>
        document
          .querySelector('[role="dialog"][aria-label="ストーリー作成"] canvas')
          ?.toDataURL() ?? null,
    );
    const overlayBounds = editability.overlayBounds;
    requireEffect(
      overlayBounds,
      "interactive overlay had no bounds during submission",
    );
    await page.mouse.move(
      overlayBounds.x + overlayBounds.width / 2,
      overlayBounds.y + overlayBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      overlayBounds.x + overlayBounds.width / 2 + 35,
      overlayBounds.y + overlayBounds.height / 2 + 20,
      { steps: 3 },
    );
    await page.mouse.up();
    const afterOverlayPointer = await page.evaluate((questionText) => {
      const root = document.querySelector(
        '[role="dialog"][aria-label="ストーリー作成"]',
      );
      const overlay = [
        ...(root?.querySelectorAll(".pointer-events-auto.absolute.flex") ?? []),
      ].find((node) => node.textContent?.includes(questionText));
      return overlay?.getBoundingClientRect().toJSON() ?? null;
    }, question);
    requireEffect(
      afterCanvasGesture === imageBefore &&
        isDeepStrictEqual(afterOverlayPointer, editability.overlayBounds),
      "canvas gesture changed rendered draft or overlay position during submission",
    );

    const textTool = dialog.getByRole("button", { name: "テキスト" });
    try {
      await textTool.click({ timeout: 750 });
    } catch {
      // Inert ancestry can make the header tool unreachable to pointer input.
    }
    requireEffect(
      (await page.getByRole("dialog", { name: "テキストを編集" }).count()) ===
        0 && (await captionField.inputValue()) === captionA,
      "header edit control opened a nested editor or changed the frozen caption",
    );
    const pollOverlay = dialog
      .locator(".pointer-events-auto.absolute.flex")
      .filter({ hasText: question });
    try {
      await pollOverlay
        .getByRole("button", { name: "編集" })
        .click({ timeout: 750 });
    } catch {
      // The overlay editor affordance is in the same inert editing subtree.
    }
    requireEffect(
      (await page.getByRole("dialog", { name: "投票" }).count()) === 0 &&
        (await captionField.inputValue()) === captionA,
      "interactive overlay opened its nested editor or changed the frozen caption",
    );

    releaseUpload();
    const [mediaResponse, storyResponse] = await Promise.all([
      uploadResponseWait,
      storyResponseWait,
    ]);
    requireEffect(
      mediaResponse.status() === 200,
      "held rendered upload did not reach the browser successfully",
    );
    const posted = storyRequests[0] ?? null;
    requireEffect(
      storyRequestCount === 1 &&
        storyRequestTargets.length === 1 &&
        new URL(storyRequestTargets[0]).origin === base &&
        new URL(storyRequestTargets[0]).pathname === "/api/stories" &&
        posted?.caption === captionA &&
        posted?.attachment?.url === uploadBody.url &&
        posted?.attachment?.r2_key === uploadBody.r2_key &&
        posted?.attachment?.content_type === "image/jpeg" &&
        isDeepStrictEqual(posted?.overlays ?? [], overlays),
      `frozen actual Story POST did not preserve captured caption/photo/overlay: ${JSON.stringify(posted)}`,
    );
    const responseBody = await readJson(storyResponse, "real Story create");
    const story = responseBody.story;
    requireEffect(
      storyResponse.status() === 201 &&
        typeof story?.ap_id === "string" &&
        story.author?.ap_id === actorApId &&
        story.caption === captionA &&
        story.attachment?.url === uploadBody.url &&
        story.attachment?.r2_key === uploadBody.r2_key &&
        story.attachment?.mediaType === "image/jpeg" &&
        isDeepStrictEqual(story.overlays ?? [], overlays),
      `real Story ACK did not preserve frozen payload: ${JSON.stringify(responseBody)}`,
    );
    const nativeStory = await db
      .prepare(
        `SELECT o.ap_id, o.type, o.attributed_to, o.attachments_json,
          (SELECT COUNT(*) FROM activities a WHERE a.object_ap_id = o.ap_id
            AND a.type = 'Create' AND a.actor_ap_id = ? AND a.direction = 'outbound') AS create_count
         FROM objects o WHERE o.ap_id = ?`,
      )
      .bind(actorApId, story.ap_id)
      .first();
    const data = JSON.parse(nativeStory?.attachments_json ?? "{}");
    const exactStories = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM objects WHERE type = 'Story' AND attributed_to = ? AND json_extract(attachments_json, '$.caption') = ?",
      )
      .bind(actorApId, captionA)
      .first();
    requireEffect(
      nativeStory?.ap_id === story.ap_id &&
        nativeStory.type === "Story" &&
        nativeStory.attributed_to === actorApId &&
        data.caption === captionA &&
        data.attachment?.url === uploadBody.url &&
        data.attachment?.r2_key === uploadBody.r2_key &&
        data.attachment?.content_type === "image/jpeg" &&
        isDeepStrictEqual(data.overlays ?? [], overlays) &&
        nativeStory.create_count === 1 &&
        exactStories?.count === 1,
      `native D1 Story/Create did not match the frozen actual POST: ${JSON.stringify({ nativeStory, exactStories })}`,
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    checks.push(
      "browser-story-submit-freezes-photo-caption-overlays-through-real-upload-and-ack",
    );

    // Independent negative control: stop the rendered upload at the browser
    // route boundary, before route.fetch can reach the Worker.
    await page
      .getByRole("button", { name: "ストーリーを追加" })
      .first()
      .click({ timeout: 10_000 });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const abortQuestion = `${question}-abort-control`;
    await createPhotoAndPoll(page, dialog, abortQuestion);
    const abortCaptionA = `story-green-abort-A-${crypto.randomUUID()}`;
    const abortCaptionB = `story-green-abort-B-${crypto.randomUUID()}`;
    const abortCaption = dialog.getByPlaceholder("キャプションを追加...");
    const postButton = dialog.getByRole("button", {
      name: "ストーリーズに投稿",
    });
    await abortCaption.fill(abortCaptionA);
    abortRenderedUpload = async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        new URL(request.url()).origin !== base ||
        new URL(request.url()).pathname !== "/api/media/upload"
      ) {
        await route.fallback();
        return;
      }
      abortRouteEntered = true;
      abortRouteCount += 1;
      notifyAbortRoute();
      try {
        await route.abort("failed");
      } finally {
        resolveAbortRoute();
      }
    };
    const storyCountBeforeAbort = storyRequestCount;
    await page.route("**/api/media/upload", abortRenderedUpload);
    abortRouteInstalled = true;
    await postButton.click({ timeout: 10_000 });
    await bounded(abortRouteIntercepted, "pre-Worker Story upload abort");
    await bounded(abortRouteFinished, "pre-Worker Story upload abort route");
    await dialog.getByText("投稿中...", { exact: true }).waitFor({
      state: "hidden",
      timeout: 15_000,
    });
    requireEffect(
      abortRouteEntered,
      "pre-Worker upload abort did not intercept a request",
    );
    await page.waitForFunction(
      () => {
        const root = document.querySelector(
          '[role="dialog"][aria-label="ストーリー作成"]',
        );
        const button = [...(root?.querySelectorAll("button") ?? [])].find(
          (node) => node.textContent?.trim() === "ストーリーズに投稿",
        );
        return Boolean(button && document.activeElement === button);
      },
      undefined,
      { timeout: 10_000 },
    );
    const afterAbortFocus = await page.evaluate(() => {
      const root = document.querySelector(
        '[role="dialog"][aria-label="ストーリー作成"]',
      );
      const active = document.activeElement;
      return {
        focusInsideDialog: Boolean(root && active && root.contains(active)),
        focusInsideInertDraft: Boolean(
          active instanceof HTMLElement && active.closest("[inert]"),
        ),
      };
    });
    const abortPostButtonFocusRestored = await postButton.evaluate(
      (button) => button === document.activeElement,
    );
    requireEffect(
      abortPostButtonFocusRestored,
      "first upload failure did not restore focus to the original Story Post button",
    );
    await abortCaption.fill(abortCaptionB);
    requireEffect(
      afterAbortFocus.focusInsideDialog &&
        !afterAbortFocus.focusInsideInertDraft &&
        (await abortCaption.inputValue()) === abortCaptionB,
      `upload failure did not restore editable Story focus: ${JSON.stringify(afterAbortFocus)}`,
    );
    const abortPollOverlay = dialog
      .locator(".pointer-events-auto.absolute.flex")
      .filter({ hasText: abortQuestion });
    const pollTextBeforeRetry = await abortPollOverlay.textContent();
    await page.waitForTimeout(300);
    const abortStory = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM objects WHERE type = 'Story' AND attributed_to = ? AND json_extract(attachments_json, '$.caption') = ?",
      )
      .bind(actorApId, abortCaptionA)
      .first();
    const abortCreate = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM activities a
         JOIN objects o ON o.ap_id = a.object_ap_id
         WHERE a.actor_ap_id = ? AND a.type = 'Create' AND a.direction = 'outbound'
           AND o.type = 'Story' AND o.attributed_to = ?
           AND json_extract(o.attachments_json, '$.caption') = ?`,
      )
      .bind(actorApId, actorApId, abortCaptionA)
      .first();
    requireEffect(
      abortRouteCount === 1 &&
        storyRequestCount === storyCountBeforeAbort &&
        abortStory?.count === 0 &&
        abortCreate?.count === 0,
      `pre-Worker upload abort created a Story POST or native D1 Story/Create: ${JSON.stringify({ storyRequestCount, storyCountBeforeAbort, abortStory, abortCreate })}`,
    );

    // Retry the same draft once. Hold the retry at the route boundary and abort
    // it only after checking status focus in both Tab directions. This proves
    // local failure recovery; it makes no idempotency or lost-ACK claim.
    await page.unroute("**/api/media/upload", abortRenderedUpload);
    abortRouteInstalled = false;
    retryRenderedUpload = async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        new URL(request.url()).origin !== base ||
        new URL(request.url()).pathname !== "/api/media/upload"
      ) {
        await route.fallback();
        return;
      }
      retryRouteEntered = true;
      retryRouteCount += 1;
      notifyRetryRoute();
      try {
        await retryUploadGate;
        await route.abort("failed");
      } finally {
        resolveRetryRoute();
      }
    };
    await page.route("**/api/media/upload", retryRenderedUpload);
    retryRouteInstalled = true;
    const storyCountBeforeRetry = storyRequestCount;
    await postButton.click({ timeout: 10_000 });
    await bounded(retryRouteIntercepted, "pre-Worker Story upload retry hold");
    const retryStatus = dialog.getByRole("status");
    await retryStatus.waitFor({ state: "visible", timeout: 10_000 });
    const retryStatusNode = await retryStatus.elementHandle();
    requireEffect(
      retryStatusNode,
      "retry posting status did not mount a focus target",
    );
    const inspectRetryPostingState = async () =>
      page.evaluate(
        ({ expectedCaption, expectedQuestion }) => {
          const root = document.querySelector(
            '[role="dialog"][aria-label="ストーリー作成"]',
          );
          const status = root?.querySelector('[role="status"]');
          const captionNode = [...(root?.querySelectorAll("input") ?? [])].find(
            (node) =>
              node.getAttribute("placeholder") === "キャプションを追加...",
          );
          const pollNode = [
            ...(root?.querySelectorAll(".pointer-events-auto.absolute.flex") ??
              []),
          ].find((node) => node.textContent?.includes(expectedQuestion));
          const active = document.activeElement;
          return {
            statusMounted: Boolean(status && status.isConnected),
            statusFocused: Boolean(status && active === status),
            focusInsideDialog: Boolean(root && active && root.contains(active)),
            captionFrozen: Boolean(captionNode?.closest("[inert]")),
            caption: captionNode?.value ?? null,
            captionMatches: captionNode?.value === expectedCaption,
            pollMounted: Boolean(pollNode),
          };
        },
        { expectedCaption: abortCaptionB, expectedQuestion: abortQuestion },
      );
    const retryStatusBeforeKeys = await inspectRetryPostingState();
    requireEffect(
      retryStatusBeforeKeys.statusMounted &&
        retryStatusBeforeKeys.statusFocused &&
        retryStatusBeforeKeys.focusInsideDialog &&
        retryStatusBeforeKeys.captionFrozen &&
        retryStatusBeforeKeys.caption === abortCaptionB &&
        retryStatusBeforeKeys.captionMatches &&
        retryStatusBeforeKeys.pollMounted,
      `retry did not hold the frozen same-composer draft with mounted status focused: ${JSON.stringify(retryStatusBeforeKeys)}`,
    );
    await page.keyboard.press("Tab");
    const retryAfterTab = await inspectRetryPostingState();
    await page.keyboard.press("Shift+Tab");
    const retryAfterShiftTab = await inspectRetryPostingState();
    requireEffect(
      retryAfterTab.statusFocused &&
        retryAfterShiftTab.statusFocused &&
        retryAfterTab.caption === abortCaptionB &&
        retryAfterShiftTab.caption === abortCaptionB &&
        retryAfterTab.pollMounted &&
        retryAfterShiftTab.pollMounted,
      `retry Tab/Shift+Tab changed draft or moved focus off mounted status: ${JSON.stringify({ retryAfterTab, retryAfterShiftTab })}`,
    );
    releaseRetryUpload();
    await bounded(
      retryRouteFinished,
      "pre-Worker Story upload retry abort route",
    );
    await retryStatus.waitFor({ state: "hidden", timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const root = document.querySelector(
          '[role="dialog"][aria-label="ストーリー作成"]',
        );
        const button = [...(root?.querySelectorAll("button") ?? [])].find(
          (node) => node.textContent?.trim() === "ストーリーズに投稿",
        );
        return Boolean(button && document.activeElement === button);
      },
      undefined,
      { timeout: 10_000 },
    );
    const retryPostButtonFocusRestored = await postButton.evaluate(
      (button) => button === document.activeElement,
    );
    requireEffect(
      retryPostButtonFocusRestored,
      "retry upload failure did not restore focus to the original Story Post button",
    );
    const retryOverlay = await abortPollOverlay.textContent();
    const retryDraftCaptionPreserved =
      (await abortCaption.inputValue()) === abortCaptionB;
    requireEffect(
      retryDraftCaptionPreserved &&
        retryOverlay === pollTextBeforeRetry &&
        retryOverlay?.includes(abortQuestion) &&
        retryOverlay.includes("story-green-option-one") &&
        retryOverlay.includes("story-green-option-two"),
      "same-composer retry changed the edited caption or captured poll draft",
    );
    const retryStatusDetached = await retryStatusNode.evaluate(
      (node) => !node.isConnected,
    );
    requireEffect(
      retryStatusDetached,
      "retry submission status remained mounted after failure cleanup",
    );
    const retryPollDraftPreserved =
      retryAfterShiftTab.pollMounted && retryOverlay === pollTextBeforeRetry;
    const retryStory = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM objects WHERE type = 'Story' AND attributed_to = ? AND json_extract(attachments_json, '$.caption') = ?",
      )
      .bind(actorApId, abortCaptionB)
      .first();
    const retryCreate = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM activities a
         JOIN objects o ON o.ap_id = a.object_ap_id
         WHERE a.actor_ap_id = ? AND a.type = 'Create' AND a.direction = 'outbound'
           AND o.type = 'Story' AND o.attributed_to = ?
           AND json_extract(o.attachments_json, '$.caption') = ?`,
      )
      .bind(actorApId, actorApId, abortCaptionB)
      .first();
    requireEffect(
      retryRouteEntered &&
        retryRouteCount === 1 &&
        storyRequestCount === storyCountBeforeRetry &&
        storyRequests.length === 1 &&
        storyRequestTargets.length === 1 &&
        retryStory?.count === 0 &&
        retryCreate?.count === 0,
      `pre-Worker retry abort created another Story POST or native Story/Create: ${JSON.stringify({ retryRouteEntered, storyRequestCount, storyCountBeforeRetry, retryStory, retryCreate })}`,
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("alertdialog", { name: "下書きを破棄しますか？" })
      .getByRole("button", { name: "破棄" })
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    checks.push(
      "browser-story-submit-pre-worker-abort-retry-restores-post-focus-and-preserves-draft-with-zero-story-post-create",
    );
    checks.push(
      "browser-story-submit-pre-worker-upload-abort-recovers-focus-with-zero-post-and-d1-story",
    );
    return {
      captionAtSubmitStart: captionA,
      captionAtActualPost: posted.caption,
      target: "/api/stories",
      requestUrl: storyRequestTargets[0],
      posted: {
        caption: posted.caption,
        attachment: posted.attachment,
        overlays: posted.overlays ?? [],
      },
      upload: {
        url: uploadBody.url,
        r2_key: uploadBody.r2_key,
        content_type: uploadBody.content_type,
        renderedBytes: photo.bytes.length,
      },
      story: {
        ap_id: story.ap_id,
        createCount: nativeStory.create_count,
      },
      dialogClosed: true,
      abortControl: {
        uploadAbortedBeforeWorker: abortRouteEntered,
        uploadCount: abortRouteCount,
        storyPostCount: storyRequestCount - storyCountBeforeAbort,
        nativeStoryCount: abortStory.count,
        nativeCreateCount: abortCreate.count,
        focusRecovered:
          afterAbortFocus.focusInsideDialog &&
          !afterAbortFocus.focusInsideInertDraft &&
          abortPostButtonFocusRestored,
        postButtonFocusRestored: abortPostButtonFocusRestored,
        captionEditable: true,
      },
      retryControl: {
        uploadAbortedBeforeWorker: retryRouteEntered,
        uploadCount: retryRouteCount,
        retryPostCount: storyRequestCount - storyCountBeforeRetry,
        nativeStoryCount: retryStory.count,
        nativeCreateCount: retryCreate.count,
        retryStatusMountedAndFocused:
          retryStatusBeforeKeys.statusMounted &&
          retryAfterShiftTab.statusFocused,
        tabAndShiftTabKeptStatusFocused:
          retryAfterTab.statusFocused && retryAfterShiftTab.statusFocused,
        draftCaptionPreserved: retryDraftCaptionPreserved,
        pollDraftPreserved: retryPollDraftPreserved,
        postButtonFocusRestored: retryPostButtonFocusRestored,
        retryStatusDetachedAfterFailure: retryStatusDetached,
        workerReached: false,
        idempotencyClaim: false,
        lostAckClaim: false,
      },
      postingBoundary: {
        editingInert: true,
        statusOutsideInertRoot: editability.statusOutsideEditingRoot,
        statusInitiallyFocused: editability.statusFocused,
        tabEscapeKeptFocusInDialog: afterKeyboard.focusInsideDialog,
        tabShiftTabKeptStatusFocused:
          afterKeyboard.statusFocused && afterShiftTab.statusFocused,
      },
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    releaseUpload();
    releaseRetryUpload();
    if (routeInstalled) {
      try {
        await page.unroute("**/api/media/upload", holdRenderedUpload);
        if (routeEntered)
          await bounded(routeFinished, "Story upload route cleanup", 10_000);
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
      }
    }
    if (abortRouteInstalled) {
      try {
        if (abortRenderedUpload)
          await page.unroute("**/api/media/upload", abortRenderedUpload);
        if (abortRouteEntered)
          await bounded(
            abortRouteFinished,
            "pre-Worker Story upload abort cleanup",
            10_000,
          );
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
      }
    }
    if (retryRouteInstalled) {
      try {
        if (retryRenderedUpload)
          await page.unroute("**/api/media/upload", retryRenderedUpload);
        if (retryRouteEntered)
          await bounded(
            retryRouteFinished,
            "pre-Worker Story retry cleanup",
            10_000,
          );
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
      }
    }
    page.off("request", recordStoryRequest);
  }
}
