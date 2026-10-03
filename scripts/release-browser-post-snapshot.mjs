// Candidate green qualification for preserving a post draft while asynchronous
// media uploads and the final post acknowledgement are in flight. This uses a
// real browser against the caller's disposable local Worker and native stores.
import { createHash, randomUUID } from "node:crypto";

const TIMEOUT_MS = 15_000;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==",
  "base64",
);

function assert(condition, label, detail = "") {
  if (!condition) {
    throw new Error(
      `browser-post-snapshot ${label}${detail ? `: ${detail}` : ""}`,
    );
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
      () => reject(new Error(`browser-post-snapshot ${item.label} timed out`)),
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
    throw new Error(`browser-post-snapshot ${label} did not become visible`);
  }
}

async function ensureContentWarningVisible(dialog) {
  const toggle = dialog.getByRole("button", { name: "注釈を追加" });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await waitVisible(
    dialog.getByPlaceholder("内容に関する注釈（任意）"),
    "content-warning-input",
  );
}

function readMultipartFile(request) {
  const contentType = request.headers()["content-type"] ?? "";
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const body = request.postDataBuffer();
  assert(boundaryMatch && body, "multipart-upload-body-missing");
  const boundary = (boundaryMatch[1] ?? boundaryMatch[2]).trim();
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"));
  assert(headerEnd >= 0, "multipart-file-header-missing");
  const headers = body.subarray(0, headerEnd).toString("utf8");
  const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
  const mime = /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim();
  const start = headerEnd + 4;
  const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), start);
  assert(filename && mime && end >= start, "multipart-file-bytes-missing");
  return { filename, mime, bytes: body.subarray(start, end) };
}

function replaceMultipartFileMime(request, expectedMime, replacementMime) {
  const rawBody = request.postDataBuffer();
  assert(rawBody, "multipart-request-body-missing-for-mime-control");
  const rawText = rawBody.toString("latin1");
  const mimeHeader = new RegExp(
    `content-type:\\s*${expectedMime.replace("/", "\\/")}`,
    "ig",
  );
  const matches = rawText.match(mimeHeader) ?? [];
  assert(
    matches.length === 1,
    "expected-one-selected-file-mime-header",
    `matches=${matches.length}`,
  );
  const rewritten = rawText.replace(mimeHeader, (header) =>
    header.replace(
      new RegExp(expectedMime.replace("/", "\\/"), "i"),
      replacementMime,
    ),
  );
  const changedBody = Buffer.from(rewritten, "latin1");
  assert(!changedBody.equals(rawBody), "mime-control-did-not-change-wire-body");
  return changedBody;
}

async function assertNativeUpload({
  db,
  media,
  actorApId,
  responseBody,
  bytes,
}) {
  const {
    id,
    url,
    r2_key: r2Key,
    content_type: contentType,
  } = responseBody ?? {};
  assert(
    typeof id === "string" &&
      url === `/media/${id}.png` &&
      r2Key === `uploads/${id}.png` &&
      contentType === "image/png",
    "real-upload-response-shape",
  );
  const row = await db
    .prepare(
      "SELECT id, uploader_ap_id, content_type, size, r2_key FROM media_uploads WHERE id = ?",
    )
    .bind(id)
    .first();
  const object = await media.get(r2Key);
  const storedBytes = object ? Buffer.from(await object.arrayBuffer()) : null;
  const digest = sha256(bytes);
  assert(
    row?.id === id &&
      row.uploader_ap_id === actorApId &&
      row.content_type === "image/png" &&
      row.size === bytes.length &&
      row.r2_key === r2Key &&
      storedBytes?.equals(bytes),
    "native-upload-d1-r2-readback",
  );
  return {
    id,
    r2Key,
    size: bytes.length,
    sha256: digest,
    d1Matches: true,
    r2Matches: true,
  };
}

async function readMediaSnapshot(db, media, actorApId) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM media_uploads WHERE uploader_ap_id = ?",
    )
    .bind(actorApId)
    .first();
  const listed = await media.list({ prefix: "uploads/", limit: 1000 });
  assert(!listed.truncated, "native-r2-fixture-list-was-truncated");
  return {
    d1Rows: row?.count ?? -1,
    r2Keys: (listed.objects ?? []).map((object) => object.key).sort(),
  };
}

async function readPostState(db, actorApId, postId, content) {
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
  return { note, notes: notes?.count, creates: creates?.count };
}

async function chooseFiles(page, dialog, files) {
  const chooserPromise = page.waitForEvent("filechooser", {
    timeout: TIMEOUT_MS,
  });
  chooserPromise.catch(() => {});
  await dialog.getByRole("button", { name: "画像・動画を追加" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}

async function composerSnapshot(dialog) {
  return dialog.evaluate((element) => {
    const controls = [...element.querySelectorAll("input, textarea, select")];
    const buttons = [...element.querySelectorAll("button")];
    return {
      visible: element.getClientRects().length > 0,
      controls: controls.map((control) => ({
        type: control.tagName.toLowerCase(),
        disabled: control.matches(":disabled"),
      })),
      allButtonsDisabled:
        buttons.length > 0 &&
        buttons.every((button) => button.matches(":disabled")),
      buttonCount: buttons.length,
      busy:
        element.getAttribute("aria-busy") === "true" ||
        Boolean(element.querySelector('[aria-busy="true"]')),
      mediaAltCount: element.querySelectorAll(
        'input[placeholder="画像の説明（任意）"]',
      ).length,
      mediaRemoveCount: [...buttons].filter(
        (button) => button.getAttribute("aria-label") === "メディアを削除",
      ).length,
      emojiChoiceCount: element.querySelectorAll(
        ".mt-3.rounded-xl.border button",
      ).length,
      allEmojiChoicesDisabled: [
        ...element.querySelectorAll(".mt-3.rounded-xl.border button"),
      ].every((button) => button.matches(":disabled")),
      cwPressed: element
        .querySelector('button[aria-label="注釈を追加"]')
        ?.getAttribute("aria-pressed"),
      emojiPressed: element
        .querySelector('button[aria-label="絵文字を追加"]')
        ?.getAttribute("aria-pressed"),
    };
  });
}

async function readCreateCount(db, actorApId) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND direction = 'outbound'",
    )
    .bind(actorApId)
    .first();
  return row?.count ?? -1;
}

async function readContentPostCounts(db, actorApId, content) {
  const rows = await db
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
  return { notes: rows?.count ?? -1, creates: creates?.count ?? -1 };
}

export async function qualifyBrowserPostSnapshot({
  page,
  worker,
  db,
  origin,
  actorApId,
  checks,
}) {
  assert(page && worker && db, "browser-worker-and-d1-required");
  assert(Array.isArray(checks), "check-accumulator-required");
  const appOrigin = new URL(origin).origin;
  assert(new URL(actorApId).origin === appOrigin, "owner-origin-mismatch");
  const media = await worker.getR2Bucket("MEDIA");
  assert(media, "native-media-bucket-required");

  const content = `release-post-snapshot-${randomUUID()}`;
  const summary = `snapshot-cw-${randomUUID()}`;
  const postUrl = new URL("/api/posts", appOrigin).href;
  const uploadUrl = new URL("/api/media/upload", appOrigin).href;
  const homeUrl = new URL("/", appOrigin).href;
  const mediaPlans = [
    {
      bytes: PNG,
      filename: "snapshot-first.png",
      committed: gate("first-upload-commit"),
      release: gate("first-upload-ack-release"),
      acked: gate("first-upload-ack"),
      proof: null,
    },
    {
      bytes: Buffer.from(PNG),
      filename: "snapshot-second.png",
      committed: gate("second-upload-commit"),
      release: gate("second-upload-ack-release"),
      acked: gate("second-upload-ack"),
      proof: null,
    },
    {
      bytes: Buffer.from(PNG),
      filename: "failed-batch-first.png",
      committed: gate("failed-batch-first-commit"),
      release: gate("failed-batch-first-ack-release"),
      acked: gate("failed-batch-first-ack"),
      proof: null,
    },
    {
      bytes: Buffer.from(PNG),
      filename: "failed-batch-second.png",
      mutateMime: true,
      expectedFailure: true,
      committed: gate("failed-batch-second-refusal"),
      release: gate("failed-batch-second-ack-release"),
      acked: gate("failed-batch-second-ack"),
      proof: null,
    },
  ];
  const postPlans = new Map();
  const makePostPlan = (draft, label, attachments = [], held = false) => {
    const plan = {
      content: draft.content,
      summary: draft.summary,
      visibility: draft.visibility,
      attachments,
      held,
      attempts: 0,
      committed: gate(`${label}-native-commit`),
      release: gate(`${label}-ack-release`),
      acked: gate(`${label}-browser-ack`),
      proof: null,
    };
    postPlans.set(plan.content, plan);
    return plan;
  };
  const initialPostPlan = makePostPlan(
    { content, summary, visibility: "unlisted" },
    "attachment-post",
    [],
    true,
  );
  const routeHandlers = [];
  let uploadRequests = 0;
  let postRequests = 0;
  let primaryError = null;
  const postCommits = [];
  let finalPostState = null;
  let secondaryPage = null;
  let initialPostAttemptsAtHeldAck = null;
  let initialUploadAttemptsAtHeldAck = null;
  let crossTabPostAttemptsAtHeldAck = null;
  const uploadGateSnapshots = [];
  let initialPostHeldSnapshot = null;
  let crossTabPostHeldSnapshot = null;
  let crossTabPreservedSnapshot = null;
  let cleanReopenSnapshot = null;
  let failedBatchSnapshot = null;

  const failRoute = async (route, error) => {
    primaryError =
      primaryError ??
      (error instanceof Error
        ? error
        : new Error("browser-post-snapshot route failure"));
    try {
      await route.abort("failed");
    } catch {
      // Preserve the first route failure.
    }
  };

  const uploadRoute = async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    uploadRequests += 1;
    const plan = mediaPlans[uploadRequests - 1];
    if (!plan) {
      await failRoute(
        route,
        new Error("unexpected extra media upload request"),
      );
      return;
    }
    try {
      const file = readMultipartFile(request);
      assert(
        file.filename === "media.png",
        "transport-filename-not-product-compatible",
      );
      assert(
        file.mime === "image/png" && file.bytes.equals(plan.bytes),
        "wire-png-did-not-match-selection",
      );
      const beforeRefusal = plan.expectedFailure
        ? await readMediaSnapshot(db, media, actorApId)
        : null;
      let fetchOptions;
      let mutationProof = null;
      if (plan.mutateMime) {
        const originalWire = request.postDataBuffer();
        const mutatedWire = replaceMultipartFileMime(
          request,
          file.mime,
          "application/octet-stream",
        );
        const headers = { ...request.headers() };
        delete headers["content-length"];
        delete headers["Content-Length"];
        fetchOptions = { postData: mutatedWire, headers };
        mutationProof = {
          originalRequestSha256: sha256(originalWire),
          mutatedRequestSha256: sha256(mutatedWire),
        };
      }
      const response = fetchOptions
        ? await route.fetch(fetchOptions)
        : await route.fetch();
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error("native media upload response was not JSON");
      }
      if (plan.expectedFailure) {
        const afterRefusal = await readMediaSnapshot(db, media, actorApId);
        assert(
          response.status() === 400 &&
            body?.error === "Invalid file type" &&
            Array.isArray(body?.allowed) &&
            !body.allowed.includes("application/octet-stream") &&
            afterRefusal.d1Rows === beforeRefusal.d1Rows &&
            JSON.stringify(afterRefusal.r2Keys) ===
              JSON.stringify(beforeRefusal.r2Keys),
          "core-did-not-refuse-mutated-mime-before-native-write",
          `status=${response.status()}`,
        );
        plan.proof = {
          status: response.status(),
          error: body.error,
          allowedTypes: body.allowed,
          responseContentType: response.headers()["content-type"] ?? null,
          wireOriginalMime: file.mime,
          wireMutationMime: "application/octet-stream",
          selectedBytesSha256: sha256(file.bytes),
          ...mutationProof,
          nativeD1RowsBefore: beforeRefusal.d1Rows,
          nativeD1RowsAfter: afterRefusal.d1Rows,
          nativeR2ObjectCountBefore: beforeRefusal.r2Keys.length,
          nativeR2ObjectCountAfter: afterRefusal.r2Keys.length,
          nativeR2KeysUnchanged: true,
        };
        plan.committed.resolve(plan.proof);
        await route.fulfill({ response });
        plan.acked.resolve(plan.proof);
        return;
      }
      assert(
        response.status() === 200,
        "native-media-upload-not-200",
        `status=${response.status()}`,
      );
      plan.proof = await assertNativeUpload({
        db,
        media,
        actorApId,
        responseBody: body,
        bytes: plan.bytes,
      });
      const committed = {
        status: response.status(),
        ...plan.proof,
        requestFilename: file.filename,
        requestMime: file.mime,
      };
      plan.committed.resolve(committed);
      await waitGate(plan.release);
      await route.fulfill({ response });
      plan.acked.resolve(committed);
    } catch (error) {
      plan.committed.reject(error);
      plan.acked.reject(error);
      await failRoute(route, error);
    }
  };

  const postRoute = async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    postRequests += 1;
    try {
      const body = request.postDataJSON();
      const plan = postPlans.get(body?.content);
      assert(plan, "unexpected-post-content-intent");
      plan.attempts += 1;
      assert(plan.attempts === 1, "duplicate-post-attempt-for-intent");
      assert(body?.content === plan.content, "post-wire-content-mismatch");
      assert(
        body?.summary === plan.summary,
        "post-wire-content-warning-mismatch",
      );
      assert(
        body?.visibility === plan.visibility,
        "post-wire-visibility-mismatch",
      );
      assert(
        JSON.stringify(body?.attachments ?? []) ===
          JSON.stringify(plan.attachments),
        "post-wire-attachment-order-or-alt-mismatch",
      );

      const response = await route.fetch();
      let responseBody;
      try {
        responseBody = await response.json();
      } catch {
        throw new Error("native post response was not JSON");
      }
      const post = responseBody?.post;
      assert(
        response.status() === 200 &&
          post?.type === "Note" &&
          post.author?.ap_id === actorApId &&
          post.content === plan.content &&
          post.summary === plan.summary &&
          post.visibility === plan.visibility &&
          typeof post.ap_id === "string" &&
          JSON.stringify(post.attachments ?? []) ===
            JSON.stringify(plan.attachments),
        "native-post-response-did-not-confirm-exact-snapshot",
        `status=${response.status()}`,
      );
      const native = await readPostState(
        db,
        actorApId,
        post.ap_id,
        plan.content,
      );
      assert(
        native.note?.type === "Note" &&
          native.note.attributed_to === actorApId &&
          native.note.content === plan.content &&
          native.note.summary === plan.summary &&
          native.note.visibility === plan.visibility &&
          native.notes === 1 &&
          native.creates === 1 &&
          JSON.stringify(JSON.parse(native.note.attachments_json)) ===
            JSON.stringify(plan.attachments),
        "native-d1-note-create-or-attachment-projection-mismatch",
      );
      plan.proof = {
        status: response.status(),
        postId: post.ap_id,
        content: plan.content,
        summary: plan.summary,
        visibility: post.visibility,
        attachments: plan.attachments,
        native,
      };
      postCommits.push(plan.proof);
      plan.committed.resolve(plan.proof);
      if (plan.held) await waitGate(plan.release);
      await route.fulfill({ response });
      plan.acked.resolve(plan.proof);
    } catch (error) {
      try {
        const failedPlan = postPlans.get(request.postDataJSON()?.content);
        failedPlan?.committed.reject(error);
        failedPlan?.acked.reject(error);
      } catch {
        // Preserve the primary response or route failure.
      }
      await failRoute(route, error);
    }
  };

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route(uploadUrl, uploadRoute);
    routeHandlers.push([uploadUrl, uploadRoute]);
    await page.route(postUrl, postRoute);
    routeHandlers.push([postUrl, postRoute]);

    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "今なにしてる？" });
    await waitVisible(dialog, "composer-open");
    await dialog.getByPlaceholder("今なにしてる？").fill(content);
    await ensureContentWarningVisible(dialog);
    await dialog.getByPlaceholder("内容に関する注釈（任意）").fill(summary);
    await dialog.locator("#post-visibility").selectOption("unlisted");

    await chooseFiles(page, dialog, [
      { name: "first.png", mimeType: "image/png", buffer: PNG },
      { name: "second.png", mimeType: "image/png", buffer: PNG },
    ]);
    const firstCommit = await waitGate(mediaPlans[0].committed);
    const firstGateState = {
      upload: firstCommit,
      submitDisabled: await dialog
        .getByRole("button", { name: "投稿", exact: true })
        .isDisabled(),
      closeDisabled: await dialog
        .getByRole("button", { name: "閉じる", exact: true })
        .isDisabled(),
      postRequests: postRequests,
    };
    uploadGateSnapshots.push(firstGateState);
    assert(
      firstGateState.submitDisabled &&
        firstGateState.closeDisabled &&
        postRequests === 0,
      "first-upload-did-not-gate-submit-close",
    );
    const firstEditor = dialog.getByPlaceholder("今なにしてる？");
    const firstCw = dialog.getByPlaceholder("内容に関する注釈（任意）");
    await firstEditor.fill(`${content}-upload-edit`);
    await firstCw.fill(`${summary}-upload-edit`);
    const uploadDraftEditable =
      (await firstEditor.inputValue()) === `${content}-upload-edit` &&
      (await firstCw.inputValue()) === `${summary}-upload-edit`;
    assert(uploadDraftEditable, "body-and-cw-not-editable-during-upload");
    await firstEditor.fill(content);
    await firstCw.fill(summary);
    await page.keyboard.press("Escape");
    await waitVisible(dialog, "composer-stays-open-during-first-upload");
    assert(
      (await firstEditor.inputValue()) === content,
      "escape-lost-first-upload-draft",
    );
    mediaPlans[0].release.resolve();
    await waitGate(mediaPlans[0].acked);
    const secondCommit = await waitGate(mediaPlans[1].committed);
    const secondGateState = {
      upload: secondCommit,
      submitDisabled: await dialog
        .getByRole("button", { name: "投稿", exact: true })
        .isDisabled(),
      closeDisabled: await dialog
        .getByRole("button", { name: "閉じる", exact: true })
        .isDisabled(),
      stagedAltCount: await dialog
        .getByPlaceholder("画像の説明（任意）")
        .count(),
      postRequests,
    };
    uploadGateSnapshots.push(secondGateState);
    assert(
      secondGateState.submitDisabled &&
        secondGateState.closeDisabled &&
        secondGateState.stagedAltCount === 1 &&
        postRequests === 0,
      "second-upload-did-not-keep-submit-close-gated",
    );
    await page.keyboard.press("Escape");
    await waitVisible(dialog, "composer-stays-open-during-second-upload");
    const altInputs = dialog.getByPlaceholder("画像の説明（任意）");
    assert(
      (await altInputs.count()) === 1,
      "first-upload-not-staged-during-second-upload",
    );
    await altInputs.nth(0).fill("first attachment alt");
    mediaPlans[1].release.resolve();
    await waitGate(mediaPlans[1].acked);
    await altInputs.nth(1).waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await altInputs.nth(1).fill("second attachment alt");
    const stagedCount = await altInputs.count();
    assert(stagedCount === 2, "two-upload-batch-not-staged");
    initialPostPlan.attachments = [
      {
        url: `/media/${mediaPlans[0].proof.id}.png`,
        r2_key: mediaPlans[0].proof.r2Key,
        content_type: "image/png",
        name: "first attachment alt",
      },
      {
        url: `/media/${mediaPlans[1].proof.id}.png`,
        r2_key: mediaPlans[1].proof.r2Key,
        content_type: "image/png",
        name: "second attachment alt",
      },
    ];
    checks.push(
      "browser-post-snapshot-upload-acks-gate-submit-close-and-escape",
    );
    checks.push(
      "browser-post-snapshot-upload-batch-stages-two-native-media-in-order",
    );

    // Keep a picker open during the held post response so every action button
    // (including its emoji choices) is covered by the pending-submit lock.
    await dialog.getByRole("button", { name: "絵文字を追加" }).click();
    const emojiButtons = dialog.locator(".mt-3.rounded-xl.border button");
    const emojiButtonCount = await emojiButtons.count();
    assert(emojiButtonCount > 1, "emoji-picker-choice-buttons-did-not-open");

    const createsBefore = await readCreateCount(db, actorApId);
    await dialog.getByRole("button", { name: "投稿", exact: true }).click();
    const committed = await waitGate(initialPostPlan.committed);
    const busyPromise = page.waitForFunction(
      () => {
        const composer = document.querySelector(
          '[role="dialog"][aria-label="今なにしてる？"]',
        );
        return (
          composer?.getAttribute("aria-busy") === "true" ||
          Boolean(composer?.querySelector('[aria-busy="true"]'))
        );
      },
      undefined,
      { timeout: TIMEOUT_MS },
    );
    busyPromise.catch(() => {});
    try {
      await busyPromise;
    } catch {
      throw new Error(
        "browser-post-snapshot aria-busy-posting-state did not appear",
      );
    }
    const heldState = await composerSnapshot(dialog);
    initialPostHeldSnapshot = heldState;
    assert(
      heldState.visible &&
        heldState.busy &&
        heldState.allButtonsDisabled &&
        heldState.controls.every((control) => control.disabled) &&
        heldState.mediaAltCount === 2 &&
        heldState.emojiChoiceCount > 1 &&
        heldState.allEmojiChoicesDisabled,
      "submitted-composer-controls-not-locked-at-held-ack",
    );
    const noExtraPostBeforeAck = postRequests === 1;
    const noExtraUploadBeforeAck = uploadRequests === 2;
    assert(
      noExtraPostBeforeAck && noExtraUploadBeforeAck,
      "unexpected-extra-write-before-post-ack",
    );
    const createsHeld = await readCreateCount(db, actorApId);
    assert(
      createsHeld === createsBefore + 1,
      "create-count-not-exactly-one-at-held-ack",
    );
    initialPostAttemptsAtHeldAck = postRequests;
    initialUploadAttemptsAtHeldAck = uploadRequests;
    checks.push(
      "browser-post-snapshot-post-ack-locks-submitted-snapshot-and-actions",
    );

    initialPostPlan.release.resolve();
    await waitGate(initialPostPlan.acked);
    await dialog.waitFor({ state: "hidden", timeout: TIMEOUT_MS });
    finalPostState = await readPostState(
      db,
      actorApId,
      committed.postId,
      content,
    );
    assert(
      finalPostState.note?.content === content &&
        finalPostState.note.summary === summary &&
        finalPostState.note.visibility === "unlisted" &&
        finalPostState.notes === 1 &&
        finalPostState.creates === 1 &&
        JSON.stringify(JSON.parse(finalPostState.note.attachments_json)) ===
          JSON.stringify(committed.attachments) &&
        postRequests === 1 &&
        uploadRequests === 2,
      "ack-release-changed-or-duplicated-native-submission",
    );
    checks.push(
      "browser-post-snapshot-ack-release-preserves-single-native-note-and-attachments",
    );

    await page
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();
    const reopened = page.getByRole("dialog", { name: "今なにしてる？" });
    await waitVisible(reopened, "composer-reopened-after-success");
    const resetState = await composerSnapshot(reopened);
    cleanReopenSnapshot = resetState;
    assert(
      (await reopened.getByPlaceholder("今なにしてる？").inputValue()) === "" &&
        (await reopened.locator("#post-visibility").inputValue()) ===
          "public" &&
        resetState.mediaAltCount === 0 &&
        resetState.controls.every((control) => !control.disabled) &&
        resetState.allButtonsDisabled === false &&
        (await reopened
          .getByPlaceholder("内容に関する注釈（任意）")
          .inputValue()) === "" &&
        (await page.evaluate(() =>
          JSON.parse(localStorage.getItem("compose.draft.summary") ?? "null"),
        )) === "",
      "successful-composer-did-not-clear-and-reopen-cleanly",
    );
    const nextDraft = `release-post-snapshot-discard-${randomUUID()}`;
    await reopened.getByPlaceholder("今なにしてる？").fill(nextDraft);
    assert(
      (await reopened.getByPlaceholder("今なにしてる？").inputValue()) ===
        nextDraft,
      "next-draft-not-editable",
    );
    await reopened.getByRole("button", { name: "閉じる", exact: true }).click();
    const discard = page.getByRole("alertdialog", {
      name: "下書きを破棄しますか？",
    });
    await waitVisible(discard, "explicit-discard-confirmation");
    await discard.getByRole("button", { name: "破棄", exact: true }).click();
    await reopened.waitFor({ state: "hidden", timeout: TIMEOUT_MS });
    assert(
      postRequests === 1 && uploadRequests === 2,
      "discard-submitted-new-write",
    );
    checks.push(
      "browser-post-snapshot-success-clears-reopens-and-allows-explicit-discard",
    );

    const concurrentContent = `release-post-snapshot-inflight-${randomUUID()}`;
    const concurrentSummary = `snapshot-inflight-cw-${randomUUID()}`;
    const preservedContent = `release-post-snapshot-preserved-${randomUUID()}`;
    const preservedSummary = `snapshot-preserved-cw-${randomUUID()}`;
    const concurrentPlan = makePostPlan(
      {
        content: concurrentContent,
        summary: concurrentSummary,
        visibility: "unlisted",
      },
      "held-snapshot-post",
      [],
      true,
    );
    const preservedPlan = makePostPlan(
      {
        content: preservedContent,
        summary: preservedSummary,
        visibility: "unlisted",
      },
      "explicit-preserved-draft-post",
      [],
      false,
    );

    secondaryPage = await page.context().newPage();
    const secondaryPageProblems = [];
    secondaryPage.on("pageerror", (error) =>
      secondaryPageProblems.push(`pageerror:${error?.name ?? "Error"}`),
    );
    secondaryPage.on("response", (response) => {
      if (response.status() >= 500) {
        let path = "unknown";
        try {
          path = new URL(response.url()).pathname;
        } catch {
          // Do not put request URLs or credentials into diagnostics.
        }
        secondaryPageProblems.push(`http-${response.status()}:${path}`);
      }
    });
    await secondaryPage.setViewportSize({ width: 1280, height: 900 });
    await secondaryPage.goto(homeUrl, { waitUntil: "domcontentloaded" });
    const secondMe = await secondaryPage.evaluate(async () => {
      const response = await fetch("/api/auth/me", {
        credentials: "same-origin",
      });
      const body = await response.json().catch(() => null);
      return {
        status: response.status,
        actorApId: body?.actor?.ap_id ?? null,
        role: body?.actor?.role ?? null,
      };
    });
    assert(
      secondMe.status === 200 &&
        secondMe.actorApId === actorApId &&
        secondMe.role === "owner",
      "second-tab-did-not-use-same-authenticated-owner",
    );
    await secondaryPage
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();
    const secondDialog = secondaryPage.getByRole("dialog", {
      name: "今なにしてる？",
    });
    await waitVisible(secondDialog, "same-session-second-tab-composer");

    await page
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();
    const concurrentDialog = page.getByRole("dialog", {
      name: "今なにしてる？",
    });
    await waitVisible(concurrentDialog, "held-snapshot-composer");
    await concurrentDialog
      .getByPlaceholder("今なにしてる？")
      .fill(concurrentContent);
    await ensureContentWarningVisible(concurrentDialog);
    await concurrentDialog
      .getByPlaceholder("内容に関する注釈（任意）")
      .fill(concurrentSummary);
    await concurrentDialog.locator("#post-visibility").selectOption("unlisted");
    const createsBeforeConcurrent = await readCreateCount(db, actorApId);
    await concurrentDialog
      .getByRole("button", { name: "投稿", exact: true })
      .click();
    const concurrentCommit = await waitGate(concurrentPlan.committed);
    assert(
      concurrentCommit.status === 200,
      "second-held-post-did-not-commit-200",
    );
    assert(
      (await composerSnapshot(concurrentDialog)).allButtonsDisabled &&
        (await composerSnapshot(concurrentDialog)).controls.every(
          (control) => control.disabled,
        ),
      "second-held-post-controls-were-not-locked",
    );
    assert(
      (await readCreateCount(db, actorApId)) === createsBeforeConcurrent + 1,
      "second-held-post-create-count-not-one",
    );

    const preservedInput = secondDialog.getByPlaceholder("今なにしてる？");
    await preservedInput.fill(preservedContent);
    await ensureContentWarningVisible(secondDialog);
    await secondDialog
      .getByPlaceholder("内容に関する注釈（任意）")
      .fill(preservedSummary);
    await secondDialog.locator("#post-visibility").selectOption("unlisted");
    assert(
      (await preservedInput.inputValue()) === preservedContent &&
        (await secondDialog
          .getByPlaceholder("内容に関する注釈（任意）")
          .inputValue()) === preservedSummary &&
        (await secondDialog.locator("#post-visibility").inputValue()) ===
          "unlisted" &&
        (await secondaryPage.evaluate(() =>
          JSON.parse(localStorage.getItem("compose.draft.content") ?? "null"),
        )) === preservedContent &&
        (await secondaryPage.evaluate(() =>
          JSON.parse(localStorage.getItem("compose.draft.summary") ?? "null"),
        )) === preservedSummary &&
        (await secondaryPage.evaluate(() =>
          JSON.parse(
            localStorage.getItem("compose.draft.visibility") ?? "null",
          ),
        )) === "unlisted",
      "second-tab-draft-was-not-observed-in-storage-before-ack",
    );
    const firstTabBody = concurrentDialog.getByPlaceholder("今なにしてる？");
    const storageEventWait = page.waitForFunction(
      (expected) => {
        const dialogElement = document.querySelector(
          '[role="dialog"][aria-label="今なにしてる？"]',
        );
        const body = dialogElement?.querySelector("textarea")?.value;
        const summary = dialogElement?.querySelector(
          'input[placeholder="内容に関する注釈（任意）"]',
        )?.value;
        const visibility =
          dialogElement?.querySelector("#post-visibility")?.value;
        const stored = (key) => {
          try {
            return JSON.parse(localStorage.getItem(key) ?? "null");
          } catch {
            return null;
          }
        };
        return (
          body === expected.body &&
          summary === expected.summary &&
          visibility === expected.visibility &&
          stored("compose.draft.content") === expected.body &&
          stored("compose.draft.summary") === expected.summary &&
          stored("compose.draft.visibility") === expected.visibility
        );
      },
      {
        body: preservedContent,
        summary: preservedSummary,
        visibility: "unlisted",
      },
      { timeout: TIMEOUT_MS },
    );
    storageEventWait.catch(() => {});
    try {
      await storageEventWait;
    } catch {
      throw new Error(
        "browser-post-snapshot cross-tab-draft-change-did-not-reach-pending-tab",
      );
    }
    assert(
      await firstTabBody.isDisabled(),
      "pending-tab-draft-became-editable-before-ack",
    );
    const heldSecondTabState = await composerSnapshot(concurrentDialog);
    crossTabPostHeldSnapshot = heldSecondTabState;
    assert(
      heldSecondTabState.busy && heldSecondTabState.allButtonsDisabled,
      "held-post-lock-not-visible-during-cross-tab-update",
    );
    crossTabPostAttemptsAtHeldAck = postRequests;

    concurrentPlan.release.resolve();
    await waitGate(concurrentPlan.acked);
    await waitVisible(concurrentDialog, "cross-tab-draft-preserved-after-ack");
    await concurrentDialog
      .getByPlaceholder("今なにしてる？")
      .waitFor({ state: "visible", timeout: TIMEOUT_MS });
    const preservedAfterAck = {
      body: await concurrentDialog
        .getByPlaceholder("今なにしてる？")
        .inputValue(),
      summary: await concurrentDialog
        .getByPlaceholder("内容に関する注釈（任意）")
        .inputValue(),
      visibility: await concurrentDialog
        .locator("#post-visibility")
        .inputValue(),
      submitDisabled: await concurrentDialog
        .getByRole("button", { name: "投稿", exact: true })
        .isDisabled(),
      alertCount: await concurrentDialog.getByRole("alert").count(),
    };
    crossTabPreservedSnapshot = preservedAfterAck;
    assert(
      preservedAfterAck.body === preservedContent &&
        preservedAfterAck.summary === preservedSummary &&
        preservedAfterAck.visibility === "unlisted" &&
        !preservedAfterAck.submitDisabled &&
        preservedAfterAck.alertCount === 0 &&
        postRequests === 2 &&
        (
          await readPostState(
            db,
            actorApId,
            concurrentCommit.postId,
            concurrentContent,
          )
        ).notes === 1,
      "acknowledgement-cleared-or-submitted-newer-cross-tab-draft",
    );
    const unsentNativeCounts = await readContentPostCounts(
      db,
      actorApId,
      preservedContent,
    );
    const totalCreatesAfterConcurrent = await readCreateCount(db, actorApId);
    const secondTabAfterAck = {
      body: await secondDialog.getByPlaceholder("今なにしてる？").inputValue(),
      summary: await secondDialog
        .getByPlaceholder("内容に関する注釈（任意）")
        .inputValue(),
      visibility: await secondDialog.locator("#post-visibility").inputValue(),
      storedBody: await secondaryPage.evaluate(() =>
        JSON.parse(localStorage.getItem("compose.draft.content") ?? "null"),
      ),
      storedSummary: await secondaryPage.evaluate(() =>
        JSON.parse(localStorage.getItem("compose.draft.summary") ?? "null"),
      ),
      storedVisibility: await secondaryPage.evaluate(() =>
        JSON.parse(localStorage.getItem("compose.draft.visibility") ?? "null"),
      ),
    };
    assert(
      unsentNativeCounts.notes === 0 &&
        unsentNativeCounts.creates === 0 &&
        totalCreatesAfterConcurrent === createsBeforeConcurrent + 1 &&
        secondTabAfterAck.body === preservedContent &&
        secondTabAfterAck.summary === preservedSummary &&
        secondTabAfterAck.visibility === "unlisted" &&
        secondTabAfterAck.storedBody === preservedContent &&
        secondTabAfterAck.storedSummary === preservedSummary &&
        secondTabAfterAck.storedVisibility === "unlisted",
      "newer-draft-was-not-unsent-and-stored-in-both-tabs-after-ack",
    );
    crossTabPreservedSnapshot = {
      ...preservedAfterAck,
      secondTab: secondTabAfterAck,
      nativeBeforeExplicitSend: unsentNativeCounts,
      ownerCreatesBeforeExplicitSend: totalCreatesAfterConcurrent,
    };
    assert(
      secondaryPageProblems.length === 0,
      "second-tab-observed-pageerror-or-http-5xx",
      secondaryPageProblems.join(","),
    );
    checks.push("browser-post-snapshot-observed-cross-tab-draft-survives-ack");

    await secondaryPage.close();
    secondaryPage = null;
    await concurrentDialog
      .getByRole("button", { name: "投稿", exact: true })
      .click();
    await waitGate(preservedPlan.acked);
    await concurrentDialog.waitFor({ state: "hidden", timeout: TIMEOUT_MS });
    const preservedPostState = await readPostState(
      db,
      actorApId,
      preservedPlan.proof.postId,
      preservedContent,
    );
    const explicitNativeCounts = await readContentPostCounts(
      db,
      actorApId,
      preservedContent,
    );
    const totalCreatesAfterExplicit = await readCreateCount(db, actorApId);
    assert(
      preservedPlan.proof.status === 200 &&
        preservedPostState.note?.content === preservedContent &&
        preservedPostState.note.summary === preservedSummary &&
        preservedPostState.note.visibility === "unlisted" &&
        preservedPostState.notes === 1 &&
        preservedPostState.creates === 1 &&
        explicitNativeCounts.notes === 1 &&
        explicitNativeCounts.creates === 1 &&
        totalCreatesAfterExplicit === createsBeforeConcurrent + 2 &&
        concurrentPlan.attempts === 1 &&
        preservedPlan.attempts === 1 &&
        postRequests === 3,
      "explicit-next-submit-did-not-create-the-preserved-snapshot-once",
    );
    checks.push("browser-post-snapshot-preserved-draft-next-explicit-post");

    const failureContent = `release-post-snapshot-failed-batch-${randomUUID()}`;
    const failureSummary = `snapshot-failed-batch-cw-${randomUUID()}`;
    await page
      .getByRole("button", { name: "投稿", exact: true })
      .first()
      .click();
    const failureDialog = page.getByRole("dialog", { name: "今なにしてる？" });
    await waitVisible(failureDialog, "failed-batch-composer-open");
    await failureDialog.getByPlaceholder("今なにしてる？").fill(failureContent);
    await ensureContentWarningVisible(failureDialog);
    await failureDialog
      .getByPlaceholder("内容に関する注釈（任意）")
      .fill(failureSummary);
    await failureDialog.locator("#post-visibility").selectOption("unlisted");
    await chooseFiles(page, failureDialog, [
      { name: "failed-batch-first.png", mimeType: "image/png", buffer: PNG },
      { name: "failed-batch-second.png", mimeType: "image/png", buffer: PNG },
    ]);

    const retainedUploadCommit = await waitGate(mediaPlans[2].committed);
    assert(
      retainedUploadCommit.status === 200 && mediaPlans[2].proof?.r2Matches,
      "first-failed-batch-file-did-not-persist-natively",
    );
    const failureBatchPending = {
      submitDisabled: await failureDialog
        .getByRole("button", { name: "投稿", exact: true })
        .isDisabled(),
      closeDisabled: await failureDialog
        .getByRole("button", { name: "閉じる", exact: true })
        .isDisabled(),
      uploadDisabled: await failureDialog
        .getByRole("button", { name: "画像・動画を追加" })
        .isDisabled(),
      stagedMediaCount: await failureDialog
        .getByPlaceholder("画像の説明（任意）")
        .count(),
      postAttempts: postRequests,
    };
    assert(
      failureBatchPending.submitDisabled &&
        failureBatchPending.closeDisabled &&
        failureBatchPending.uploadDisabled &&
        failureBatchPending.stagedMediaCount === 0 &&
        failureBatchPending.postAttempts === 3,
      "first-file-pending-batch-did-not-block-composer-actions",
    );
    await page.keyboard.press("Escape");
    await waitVisible(failureDialog, "failed-batch-escape-keeps-composer-open");
    mediaPlans[2].release.resolve();
    await waitGate(mediaPlans[2].acked);
    const rejectedUpload = await waitGate(mediaPlans[3].committed);
    await waitGate(mediaPlans[3].acked);
    await waitVisible(
      failureDialog.getByRole("alert").first(),
      "failed-second-upload-visible-error",
    );

    const batchReady = page.waitForFunction(
      () => {
        const dialogElement = document.querySelector(
          '[role="dialog"][aria-label="今なにしてる？"]',
        );
        const submit = [
          ...(dialogElement?.querySelectorAll("button") ?? []),
        ].find((button) => button.textContent?.trim() === "投稿");
        const close = dialogElement?.querySelector(
          'button[aria-label="閉じる"]',
        );
        const upload = dialogElement?.querySelector(
          'button[aria-label="画像・動画を追加"]',
        );
        return Boolean(
          submit &&
          close &&
          upload &&
          !submit.matches(":disabled") &&
          !close.matches(":disabled") &&
          !upload.matches(":disabled"),
        );
      },
      undefined,
      { timeout: TIMEOUT_MS },
    );
    batchReady.catch(() => {});
    try {
      await batchReady;
    } catch {
      throw new Error(
        "browser-post-snapshot failed-batch-selection-pending-did-not-release",
      );
    }
    const failureAlert = await failureDialog
      .getByRole("alert")
      .first()
      .innerText();
    const retainedAltInputs =
      failureDialog.getByPlaceholder("画像の説明（任意）");
    const afterFailedBatch = {
      body: await failureDialog.getByPlaceholder("今なにしてる？").inputValue(),
      summary: await failureDialog
        .getByPlaceholder("内容に関する注釈（任意）")
        .inputValue(),
      visibility: await failureDialog.locator("#post-visibility").inputValue(),
      alertVisible: failureAlert.trim().length > 0,
      submitEnabled: await failureDialog
        .getByRole("button", { name: "投稿", exact: true })
        .isEnabled(),
      closeEnabled: await failureDialog
        .getByRole("button", { name: "閉じる", exact: true })
        .isEnabled(),
      uploadEnabled: await failureDialog
        .getByRole("button", { name: "画像・動画を追加" })
        .isEnabled(),
      stagedMediaCount: await retainedAltInputs.count(),
      postAttempts: postRequests,
    };
    assert(
      rejectedUpload.status === 400 &&
        rejectedUpload.error === "Invalid file type" &&
        rejectedUpload.nativeD1RowsBefore ===
          rejectedUpload.nativeD1RowsAfter &&
        rejectedUpload.nativeR2KeysUnchanged &&
        afterFailedBatch.body === failureContent &&
        afterFailedBatch.summary === failureSummary &&
        afterFailedBatch.visibility === "unlisted" &&
        afterFailedBatch.alertVisible &&
        afterFailedBatch.submitEnabled &&
        afterFailedBatch.closeEnabled &&
        afterFailedBatch.uploadEnabled &&
        afterFailedBatch.stagedMediaCount === 1 &&
        afterFailedBatch.postAttempts === 3,
      "failed-second-file-did-not-release-batch-while-preserving-draft-and-first-media",
    );
    const retainedFirst = await db
      .prepare(
        "SELECT uploader_ap_id, content_type, size, r2_key FROM media_uploads WHERE id = ?",
      )
      .bind(mediaPlans[2].proof.id)
      .first();
    const retainedFirstObject = await media.get(mediaPlans[2].proof.r2Key);
    assert(
      retainedFirst?.uploader_ap_id === actorApId &&
        retainedFirst.content_type === "image/png" &&
        retainedFirst.size === PNG.length &&
        retainedFirst.r2_key === mediaPlans[2].proof.r2Key &&
        retainedFirstObject &&
        Buffer.from(await retainedFirstObject.arrayBuffer()).equals(PNG),
      "first-successful-upload-was-not-still-native-after-second-file-refusal",
    );
    failedBatchSnapshot = {
      firstUpload: mediaPlans[2].proof,
      secondUpload: rejectedUpload,
      pending: failureBatchPending,
      afterFailure: afterFailedBatch,
    };
    await failureDialog
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    const failureDiscard = page.getByRole("alertdialog", {
      name: "下書きを破棄しますか？",
    });
    await waitVisible(
      failureDiscard,
      "failed-batch-explicit-discard-confirmation",
    );
    await failureDiscard
      .getByRole("button", { name: "破棄", exact: true })
      .click();
    await failureDialog.waitFor({ state: "hidden", timeout: TIMEOUT_MS });
    assert(
      postRequests === 3 && uploadRequests === 4,
      "failed-batch-discard-submitted-or-retried",
    );
    checks.push(
      "browser-post-snapshot-failed-second-upload-releases-batch-and-retains-first-media",
    );
  } catch (error) {
    primaryError = primaryError ?? error;
  } finally {
    for (const plan of mediaPlans) plan.release.resolve();
    for (const plan of postPlans.values()) plan.release.resolve();
    if (secondaryPage) {
      try {
        await secondaryPage.close();
      } catch {
        if (!primaryError)
          primaryError = new Error(
            "browser-post-snapshot secondary-page cleanup failed",
          );
      }
    }
    if (routeHandlers.length > 0) {
      for (const [url, handler] of routeHandlers) {
        try {
          await page.unroute(url, handler);
        } catch {
          if (!primaryError)
            primaryError = new Error(
              "browser-post-snapshot route cleanup failed",
            );
        }
      }
    }
  }

  if (primaryError) throw primaryError;
  return {
    kind: "yurucommu.browser-post-snapshot@v1",
    checks: [
      "browser-post-snapshot-upload-acks-gate-submit-close-and-escape",
      "browser-post-snapshot-upload-batch-stages-two-native-media-in-order",
      "browser-post-snapshot-post-ack-locks-submitted-snapshot-and-actions",
      "browser-post-snapshot-ack-release-preserves-single-native-note-and-attachments",
      "browser-post-snapshot-success-clears-reopens-and-allows-explicit-discard",
      "browser-post-snapshot-observed-cross-tab-draft-survives-ack",
      "browser-post-snapshot-preserved-draft-next-explicit-post",
      "browser-post-snapshot-failed-second-upload-releases-batch-and-retains-first-media",
    ],
    uploadAttempts: uploadRequests,
    uploads: mediaPlans.map((plan) => plan.proof),
    failedBatch: failedBatchSnapshot,
    uploadGateSnapshots,
    postAttempts: postRequests,
    posts: postCommits.map((post) => ({
      status: post.status,
      postId: post.postId,
      content: post.content,
      summary: post.summary,
      visibility: post.visibility,
      noteCount: post.native.notes,
      createCount: post.native.creates,
      attachmentCount: post.attachments.length,
      attachmentOrder: post.attachments.map((item) => item.r2_key),
      nativeAttachmentOrderPreserved:
        JSON.stringify(JSON.parse(post.native.note.attachments_json)) ===
        JSON.stringify(post.attachments),
    })),
    heldAck: {
      firstPost: initialPostHeldSnapshot,
      crossTabPost: crossTabPostHeldSnapshot,
      uploadSubmitAndCloseDisabled: uploadGateSnapshots.every(
        (snapshot) => snapshot.submitDisabled && snapshot.closeDisabled,
      ),
      bodyAndContentWarningRemainEditableDuringUpload: true,
      escapeKeptComposerOpen: uploadGateSnapshots.length === 2,
      postBusy: Boolean(
        initialPostHeldSnapshot?.busy && crossTabPostHeldSnapshot?.busy,
      ),
      postAllComposerControlsDisabled: Boolean(
        initialPostHeldSnapshot?.allButtonsDisabled &&
        initialPostHeldSnapshot?.controls.every((control) => control.disabled),
      ),
      initialPostAttemptsAtHeldAck,
      crossTabPostAttemptsAtHeldAck,
      postAttemptsFinal: postRequests,
      uploadAttemptsBeforePostAck: initialUploadAttemptsAtHeldAck,
    },
    afterReopen: {
      controlsEnabled: Boolean(
        cleanReopenSnapshot?.controls.every((control) => !control.disabled),
      ),
      mediaCount: cleanReopenSnapshot?.mediaAltCount ?? null,
      explicitDiscardCompleted: true,
    },
    crossTabDraftAfterAck: crossTabPreservedSnapshot,
    scope:
      "local native Worker and browser UI only; no shared idempotency or live-service claim",
  };
}
