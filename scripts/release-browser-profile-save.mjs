// Disposable native-browser fixture for profile save acknowledgements and
// uploads. route.fetch() always reaches the real local Worker; only delivery
// of its already-committed response is held. It does not seed actors or prove
// remote federation behavior.

function requireProfile(condition, reason) {
  if (!condition) throw new Error(`browser-profile-save ${reason}`);
}

function bounded(promise, label, timeout = 15_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`browser-profile-save ${label} timed out`)),
      timeout,
    );
  });
  deadline.catch(() => {});
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function gate(label) {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  promise.catch(() => {});
  return { label, promise, resolve, reject };
}

async function nativeProfile(db, actorApId) {
  const row = await db
    .prepare(
      "SELECT ap_id, name, summary, fields_json, is_private, icon_url, header_url FROM actors WHERE ap_id = ?",
    )
    .bind(actorApId)
    .first();
  requireProfile(row?.ap_id === actorApId, "owner actor row was not found");
  let fields;
  try {
    fields = JSON.parse(row.fields_json ?? "[]");
  } catch {
    throw new Error("browser-profile-save native fields_json was invalid");
  }
  return {
    name: row.name ?? "",
    summary: row.summary ?? "",
    fields,
    isPrivate: Boolean(row.is_private),
    iconUrl: row.icon_url ?? null,
    headerUrl: row.header_url ?? null,
  };
}

async function openOwnProfile(page, origin, path = "/profile") {
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  const editButton = page.getByRole("button", {
    name: "プロフィールを編集",
    exact: true,
  });
  await editButton.waitFor({ state: "visible", timeout: 15_000 });
  await editButton.click();
  const dialog = page.getByRole("dialog", {
    name: "プロフィールを編集",
  });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  return dialog;
}

async function setProfileDraft(dialog, draft) {
  await dialog.locator("#profile-edit-name").fill(draft.name);
  await dialog.locator("#profile-edit-bio").fill(draft.summary);
  const fieldNames = dialog.getByRole("textbox", { name: "ラベル" });
  const fieldValues = dialog.getByRole("textbox", { name: "内容" });
  if ((await fieldNames.count()) === 0) {
    await dialog.getByRole("button", { name: "項目を追加" }).click();
  }
  await dialog
    .getByRole("textbox", { name: "ラベル" })
    .first()
    .fill(draft.fieldName);
  await dialog
    .getByRole("textbox", { name: "内容" })
    .first()
    .fill(draft.fieldValue);
  const isPrivate = await dialog
    .getByRole("switch", { name: "フォロー許可制" })
    .getAttribute("aria-checked");
  if ((isPrivate === "true") !== draft.isPrivate) {
    await dialog.getByRole("switch", { name: "フォロー許可制" }).click();
  }
}

function actorPayload(request) {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

async function holdRealResponse(page, matcher, predicate, label) {
  const ready = gate(`${label} ready`);
  const release = gate(`${label} release`);
  const handled = gate(`${label} handled`);
  let captured = false;
  let routeError;
  const handler = async (route) => {
    if (captured || !predicate(route.request())) {
      await route.continue();
      return;
    }
    captured = true;
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      const body = await response.json().catch(() => null);
      ready.resolve({ response, body, request: route.request() });
      await release.promise;
      await route.fulfill({ response });
    } catch (error) {
      routeError = error;
      ready.reject(error);
      try {
        await route.abort("failed");
      } catch {
        // Preserve the original failure.
      }
    } finally {
      handled.resolve();
    }
  };
  await page.route(matcher, handler);
  return {
    ready: bounded(ready.promise, `${label} response`, 20_000),
    release: () => release.resolve(),
    handled: bounded(handled.promise, `${label} handler`, 20_000),
    get error() {
      return routeError;
    },
    dispose: () => page.unroute(matcher, handler),
  };
}

async function qualifyHeldProfileSave({
  page,
  db,
  origin,
  actorApId,
  checks,
  mode,
}) {
  const before = await nativeProfile(db, actorApId);
  const suffix = crypto.randomUUID();
  const saved = {
    name: `Save A ${suffix.slice(0, 12)}`,
    summary: `Profile summary A ${suffix}`,
    fieldName: `Field A ${suffix.slice(0, 12)}`,
    fieldValue: `Value A ${suffix.slice(0, 12)}`,
    isPrivate: !before.isPrivate,
  };
  const later = {
    name: `Save B ${suffix.slice(0, 12)}`,
    summary: `Profile summary B ${suffix}`,
  };
  const dialog = await openOwnProfile(page, origin);
  await setProfileDraft(dialog, saved);

  const held = await holdRealResponse(
    page,
    `${new URL(origin).origin}/api/actors/me`,
    (request) =>
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/actors/me",
    "profile save",
  );
  const saveClick = dialog
    .getByRole("button", { name: "保存", exact: true })
    .click();
  saveClick.catch(() => {});
  const committed = await held.ready;
  const payload = actorPayload(committed.request);
  requireProfile(
    committed.response.status() === 200 &&
      committed.body?.success === true &&
      payload?.name === saved.name &&
      payload?.summary === saved.summary &&
      payload?.fields?.[0]?.name === saved.fieldName &&
      payload?.fields?.[0]?.value === saved.fieldValue &&
      payload?.is_private === saved.isPrivate,
    `held native PUT did not commit the expected snapshot: ${JSON.stringify({ status: committed.response.status(), body: committed.body, payload })}`,
  );
  const nativeAtHold = await nativeProfile(db, actorApId);
  requireProfile(
    nativeAtHold.name === saved.name &&
      nativeAtHold.summary === saved.summary &&
      nativeAtHold.fields[0]?.name === saved.fieldName &&
      nativeAtHold.fields[0]?.value === saved.fieldValue &&
      nativeAtHold.isPrivate === saved.isPrivate,
    "native actor row did not contain the committed A snapshot while ACK was held",
  );

  if (mode === "baseline-red") {
    const name = dialog.locator("#profile-edit-name");
    const summary = dialog.locator("#profile-edit-bio");
    const nameEnabled = await name.isEnabled();
    const summaryEnabled = await summary.isEnabled();
    requireProfile(
      nameEnabled && summaryEnabled,
      `expected immutable regression was absent: nameEnabled=${nameEnabled}, summaryEnabled=${summaryEnabled}`,
    );
    await name.fill(later.name);
    await summary.fill(later.summary);
    requireProfile(
      (await name.inputValue()) === later.name &&
        (await summary.inputValue()) === later.summary,
      "baseline could not reproduce editing name and summary before ACK",
    );
    held.release();
    await held.handled;
    await bounded(saveClick, "profile save click completion");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const afterAck = await nativeProfile(db, actorApId);
    const visible = await page.locator("main").innerText();
    const reproduced =
      afterAck.name === saved.name &&
      afterAck.summary === saved.summary &&
      visible.includes(later.name) &&
      visible.includes(later.summary);
    requireProfile(
      reproduced,
      `expected red must show UI B over native A after ACK: ${JSON.stringify({ native: afterAck, nameBVisible: visible.includes(later.name), summaryBVisible: visible.includes(later.summary) })}`,
    );
    checks.push(
      "browser-profile-save-baseline-red-edit-during-held-ack-reproduced",
    );
    await held.dispose();
    return {
      result: "expected-red",
      artifact: {
        defect:
          "profile editor accepts name and summary changes while save A is awaiting its real Worker acknowledgement",
        nativeAfterAck: afterAck,
        visibleAfterAck: { name: later.name, summary: later.summary },
        requestSnapshot: payload,
      },
    };
  }

  const disabled = {
    name: !(await dialog.locator("#profile-edit-name").isEnabled()),
    summary: !(await dialog.locator("#profile-edit-bio").isEnabled()),
    fieldName: !(await dialog
      .getByRole("textbox", { name: "ラベル" })
      .first()
      .isEnabled()),
    fieldValue: !(await dialog
      .getByRole("textbox", { name: "内容" })
      .first()
      .isEnabled()),
    privacy: !(await dialog
      .getByRole("switch", { name: "フォロー許可制" })
      .isEnabled()),
    files: await dialog
      .locator('input[type="file"]')
      .evaluateAll((nodes) => nodes.every((node) => node.matches(":disabled"))),
  };
  requireProfile(
    Object.values(disabled).every(Boolean),
    `profile controls remained mutable during save: ${JSON.stringify(disabled)}`,
  );
  requireProfile(
    (await dialog.getAttribute("aria-busy")) === "true" &&
      (await dialog.evaluate((node) => document.activeElement === node)),
    "saving did not announce busy state and focus the dialog",
  );
  await page.keyboard.press("Tab");
  requireProfile(
    await dialog.evaluate((node) => document.activeElement === node),
    "Tab escaped the busy profile dialog",
  );
  const close = dialog.getByRole("button", { name: "閉じる" });
  requireProfile(
    await close.isDisabled(),
    "close control was not disabled while saving",
  );
  await close.evaluate((node) => node.click());
  requireProfile(
    await page.getByRole("dialog", { name: "プロフィールを編集" }).isVisible(),
    "close button dismissed the profile editor while saving",
  );
  await page.keyboard.press("Escape");
  requireProfile(
    await page.getByRole("dialog", { name: "プロフィールを編集" }).isVisible(),
    "Escape dismissed the profile editor while saving",
  );
  await page
    .locator("div.fixed.inset-0")
    .first()
    .click({ position: { x: 2, y: 2 } });
  requireProfile(
    await page.getByRole("dialog", { name: "プロフィールを編集" }).isVisible(),
    "backdrop click dismissed the profile editor while saving",
  );
  held.release();
  await held.handled;
  await bounded(saveClick, "profile save click completion");
  await page.getByRole("dialog", { name: "プロフィールを編集" }).waitFor({
    state: "hidden",
    timeout: 10_000,
  });
  const afterAck = await nativeProfile(db, actorApId);
  requireProfile(
    afterAck.name === saved.name &&
      afterAck.summary === saved.summary &&
      afterAck.fields[0]?.name === saved.fieldName &&
      afterAck.fields[0]?.value === saved.fieldValue &&
      afterAck.isPrivate === saved.isPrivate,
    "native actor changed after acknowledged profile save",
  );
  const displayedAfterAck = await page.locator("main").innerText();
  requireProfile(
    displayedAfterAck.includes(saved.name) &&
      displayedAfterAck.includes(saved.summary) &&
      !displayedAfterAck.includes(later.name),
    "acknowledged profile display disagreed with submitted A",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "プロフィールを編集", exact: true })
    .waitFor({ state: "visible" });
  const visibleAfterReload = await page.locator("main").innerText();
  requireProfile(
    visibleAfterReload.includes(saved.name) &&
      visibleAfterReload.includes(saved.summary) &&
      visibleAfterReload.includes(saved.fieldName) &&
      visibleAfterReload.includes(saved.fieldValue),
    "profile A values did not survive reload",
  );
  checks.push(
    "browser-profile-save-freezes-editor-until-native-ack-and-reloads-a",
  );
  await held.dispose();
  return { result: "green", saved, nativeAfterAck: afterAck };
}

async function qualifyUploadIsolation({ page, db, origin, actorApId, checks }) {
  const before = await nativeProfile(db, actorApId);
  const dialog = await openOwnProfile(page, origin);
  const suffix = crypto.randomUUID();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==",
    "base64",
  );
  const upload = async (label) => {
    const held = await holdRealResponse(
      page,
      `${new URL(origin).origin}/api/media/upload`,
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/media/upload",
      label,
    );
    // Modal DOM order is header then avatar; the fixture targets the avatar
    // upload whose URL is verified in the actor row below.
    await dialog
      .locator('input[type="file"]')
      .last()
      .setInputFiles({
        name: `${label}-${suffix}.png`,
        mimeType: "image/png",
        buffer: png,
      });
    const committed = await held.ready;
    requireProfile(
      committed.response.status() === 200 &&
        typeof committed.body?.url === "string" &&
        committed.body.content_type === "image/png",
      `${label} real upload response was invalid: ${JSON.stringify({ status: committed.response.status(), body: committed.body })}`,
    );
    return { held, committed };
  };

  const oldUpload = await upload("profile-old-upload");
  const oldUrl = oldUpload.committed.body.url;
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await page
    .getByRole("dialog", { name: "プロフィールを編集" })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "プロフィールを編集", exact: true })
    .click();
  const reopened = page.getByRole("dialog", { name: "プロフィールを編集" });
  await reopened.waitFor({ state: "visible", timeout: 10_000 });
  requireProfile(
    !(await reopened.locator(`img[src="${oldUrl}"]`).count()) &&
      !(await reopened.getByRole("alert").count()),
    "reopened editor inherited image or error state before old upload ACK",
  );
  const oldAck = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/media/upload" &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  oldAck.catch(() => {});
  oldUpload.held.release();
  await oldUpload.held.handled;
  const oldAckResponse = await oldAck;
  requireProfile(
    oldAckResponse.status() === 200,
    "old upload ACK was not delivered successfully",
  );
  await oldAckResponse.finished();
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await reopened.waitFor({ state: "visible" });
  requireProfile(
    !(await reopened.locator(`img[src="${oldUrl}"]`).count()) &&
      !(await reopened.getByRole("alert").count()),
    "old upload ACK modified the newly opened editor",
  );
  await oldUpload.held.dispose();

  const fresh = await upload("profile-fresh-upload");
  const freshUrl = fresh.committed.body.url;
  const freshAck = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/media/upload" &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  freshAck.catch(() => {});
  fresh.held.release();
  await fresh.held.handled;
  const freshAckResponse = await freshAck;
  requireProfile(
    freshAckResponse.status() === 200,
    "fresh upload ACK was not delivered successfully",
  );
  await reopened
    .locator(`img[src="${freshUrl}"]`)
    .waitFor({ state: "visible", timeout: 10_000 });
  await fresh.held.dispose();
  const saveAck = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/actors/me" &&
      response.request().method() === "PUT",
    { timeout: 15_000 },
  );
  saveAck.catch(() => {});
  await reopened.getByRole("button", { name: "保存", exact: true }).click();
  requireProfile(
    (await saveAck).status() === 200,
    "fresh image profile save did not succeed",
  );
  await page
    .getByRole("dialog", { name: "プロフィールを編集" })
    .waitFor({ state: "hidden", timeout: 10_000 });
  const after = await nativeProfile(db, actorApId);
  requireProfile(
    after.iconUrl === freshUrl &&
      after.name === before.name &&
      after.summary === before.summary,
    `fresh profile upload/save did not persist the new image only: ${JSON.stringify({ before, after, freshUrl })}`,
  );
  checks.push(
    "browser-profile-upload-old-ack-isolated-from-reopened-editor-and-fresh-save-works",
  );
  return { result: "green", oldUrl, freshUrl, nativeAfter: after };
}

async function qualifyStaleSaveNavigation({
  page,
  db,
  origin,
  actorApId,
  checks,
  mode,
}) {
  const suffix = crypto.randomUUID().slice(0, 12);
  const submittedName = `Route A ${suffix}`;
  const remoteApId = `https://profile-${suffix}.example.test/ap/users/peer`;
  const encodedId = encodeURIComponent(remoteApId);
  // Reuse the same wildcard Route declaration on both sides. Starting at
  // /profile would switch declarations and could pass merely by unmounting.
  const dialog = await openOwnProfile(
    page,
    origin,
    `/profile/${encodeURIComponent(actorApId)}`,
  );
  await dialog.locator("#profile-edit-name").fill(submittedName);
  await dialog.locator("#profile-edit-bio").fill(`Route summary ${suffix}`);
  const held = await holdRealResponse(
    page,
    `${new URL(origin).origin}/api/actors/me`,
    (request) =>
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/actors/me",
    "profile route change save",
  );
  const saveClick = dialog
    .getByRole("button", { name: "保存", exact: true })
    .click();
  saveClick.catch(() => {});
  const committed = await held.ready;
  requireProfile(
    committed.response.status() === 200 &&
      committed.body?.success === true &&
      actorPayload(committed.request)?.name === submittedName,
    "route-change profile save was not committed by the real Worker",
  );
  const nativeCommitted = await nativeProfile(db, actorApId);
  requireProfile(
    nativeCommitted.name === submittedName,
    "native owner row did not commit before route change",
  );

  const actorEndpoint = `${new URL(origin).origin}/api/actors/${encodedId}`;
  const postsEndpoint = `${actorEndpoint}/posts`;
  const syntheticActor = {
    ap_id: remoteApId,
    type: "Person",
    username: `peer@profile-${suffix}.example.test`,
    preferred_username: "peer",
    name: `Synthetic profile ${suffix}`,
    summary: "Synthetic fixture profile",
    icon_url: null,
    header_url: null,
    fields: [],
    is_private: false,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    created_at: new Date().toISOString(),
    is_following: false,
  };
  const actorHandler = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ actor: syntheticActor }),
    });
  const postsHandler = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ posts: [], nextCursor: null, hasMore: false }),
    });
  await page.route(actorEndpoint, actorHandler);
  await page.route(`${postsEndpoint}**`, postsHandler);
  try {
    // The app router listens to popstate; this keeps the current SPA document
    // alive while switching ProfilePage params and exercising its generation guard.
    await page.evaluate((path) => {
      history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    }, `/profile/${encodedId}`);
    await page
      .getByText(syntheticActor.name, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    const ack = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/actors/me" &&
        response.request().method() === "PUT",
      { timeout: 15_000 },
    );
    ack.catch(() => {});
    held.release();
    await held.handled;
    await bounded(saveClick, "profile save after SPA route change");
    await (await ack).finished();
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const visible = await page.locator("main").innerText();
    if (mode === "navigation-red") {
      requireProfile(
        !visible.includes(syntheticActor.name) &&
          visible.includes(submittedName),
        "immutable late-ACK target overwrite regression was not reproduced",
      );
      checks.push("browser-profile-save-baseline-red-overwrites-spa-target");
      return {
        result: "expected-red",
        remoteActorApId: remoteApId,
        incorrectlyDisplayedOwnerName: submittedName,
        nativeOwnerAfterAck: await nativeProfile(db, actorApId),
      };
    }
    requireProfile(
      visible.includes(syntheticActor.name) && !visible.includes(submittedName),
      "late owner profile acknowledgement changed the newly navigated synthetic remote profile",
    );
    requireProfile(
      (await page.getByText("保存しました", { exact: true }).count()) === 0,
      "late owner profile acknowledgement announced success on another profile",
    );
    checks.push(
      "browser-profile-save-late-ack-does-not-overwrite-spa-target-profile",
    );
    return {
      result: "green",
      remoteActorApId: remoteApId,
      nativeOwnerAfterAck: await nativeProfile(db, actorApId),
    };
  } finally {
    held.release();
    await held.dispose();
    await page.unroute(actorEndpoint, actorHandler);
    await page.unroute(`${postsEndpoint}**`, postsHandler);
  }
}

async function qualifyFailedProfileSave({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  const before = await nativeProfile(db, actorApId);
  const suffix = crypto.randomUUID().slice(0, 12);
  const draft = {
    name: `Retry ${suffix}`,
    summary: `Retry profile summary ${suffix}`,
  };
  const dialog = await openOwnProfile(page, origin);
  const name = dialog.locator("#profile-edit-name");
  const summary = dialog.locator("#profile-edit-bio");
  await name.fill(draft.name);
  await summary.fill(draft.summary);

  let intercepted = 0;
  const aborted = gate("profile save transport abort");
  const matcher = `${new URL(origin).origin}/api/actors/me`;
  const abortSave = async (route) => {
    const request = route.request();
    if (
      request.method() !== "PUT" ||
      new URL(request.url()).pathname !== "/api/actors/me"
    ) {
      await route.continue();
      return;
    }
    intercepted += 1;
    try {
      // Abort before route.fetch(): the Worker must never see this request.
      await route.abort("failed");
      aborted.resolve();
    } catch (error) {
      aborted.reject(error);
    }
  };
  await page.route(matcher, abortSave);
  const failedRequest = page.waitForEvent("requestfailed", {
    predicate: (request) =>
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/actors/me",
    timeout: 10_000,
  });
  failedRequest.catch(() => {});
  const saveButton = dialog.getByRole("button", {
    name: "保存",
    exact: true,
  });
  await saveButton.click();
  await bounded(aborted.promise, "profile save transport abort");
  await bounded(failedRequest, "profile save failed request");
  await page
    .getByRole("alert")
    .filter({ hasText: "保存に失敗しました" })
    .waitFor({ state: "visible", timeout: 10_000 });

  const afterFailure = await nativeProfile(db, actorApId);
  const failedState = {
    dialogVisible: await dialog.isVisible(),
    nameRetained: (await name.inputValue()) === draft.name,
    summaryRetained: (await summary.inputValue()) === draft.summary,
    nameEnabled: await name.isEnabled(),
    summaryEnabled: await summary.isEnabled(),
    fieldsEnabled: await dialog
      .locator('input[aria-label="ラベル"], input[aria-label="内容"]')
      .evaluateAll((nodes) =>
        nodes.every((node) => !node.matches(":disabled")),
      ),
    privacyEnabled: await dialog
      .getByRole("switch", { name: "フォロー許可制" })
      .isEnabled(),
    filesEnabled: await dialog
      .locator('input[type="file"]')
      .evaluateAll((nodes) =>
        nodes.every((node) => !node.matches(":disabled")),
      ),
    busyCleared: (await dialog.getAttribute("aria-busy")) === "false",
    focusRetained: await dialog.evaluate((node) =>
      node.contains(document.activeElement),
    ),
    nativeUnchanged: JSON.stringify(afterFailure) === JSON.stringify(before),
  };
  requireProfile(
    Object.values(failedState).every(Boolean),
    `transport failure did not preserve an editable unsaved draft: ${JSON.stringify(failedState)}`,
  );
  // Give any accidental retry effect a short observation window while the
  // failed editor remains open. Only the operator's next click may resubmit.
  await page.waitForTimeout(500);
  requireProfile(
    intercepted === 1,
    `profile save automatically retried after transport failure (${intercepted} PUTs)`,
  );
  await page.unroute(matcher, abortSave);

  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/actors/me" &&
      response.request().method() === "PUT",
    { timeout: 15_000 },
  );
  accepted.catch(() => {});
  await saveButton.click();
  const success = await accepted;
  const successBody = await success.json().catch(() => null);
  requireProfile(
    success.status() === 200 && successBody?.success === true,
    `explicit profile retry did not succeed: ${JSON.stringify({ status: success.status(), body: successBody })}`,
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  const afterRetry = await nativeProfile(db, actorApId);
  requireProfile(
    afterRetry.name === draft.name &&
      afterRetry.summary === draft.summary &&
      JSON.stringify(afterRetry.fields) === JSON.stringify(before.fields) &&
      afterRetry.isPrivate === before.isPrivate &&
      afterRetry.iconUrl === before.iconUrl &&
      afterRetry.headerUrl === before.headerUrl,
    `explicit profile retry did not commit the retained name/bio only: ${JSON.stringify({ before, afterRetry })}`,
  );
  checks.push(
    "browser-profile-save-transport-failure-retains-draft-for-explicit-retry",
  );
  return {
    result: "green",
    before,
    afterFailure,
    afterRetry,
    transportAttempts: intercepted,
  };
}

export async function qualifyBrowserProfileSave({
  page,
  db,
  origin,
  actorApId,
  checks,
  mode,
}) {
  requireProfile(
    page && db,
    "qualification needs a browser page and native D1",
  );
  requireProfile(
    typeof origin === "string" && typeof actorApId === "string",
    "origin and owner AP ID are required",
  );
  requireProfile(Array.isArray(checks), "check accumulator is required");
  requireProfile(
    new URL(actorApId).origin === new URL(origin).origin,
    "owner actor must belong to the fixture origin",
  );
  requireProfile(
    mode === undefined || mode === "baseline-red" || mode === "navigation-red",
    "unknown profile fixture mode",
  );

  if (mode === "navigation-red")
    return qualifyStaleSaveNavigation({
      page,
      db,
      origin,
      actorApId,
      checks,
      mode,
    });
  const save = await qualifyHeldProfileSave({
    page,
    db,
    origin,
    actorApId,
    checks,
    mode,
  });
  if (mode === "baseline-red") return save;
  const navigation = await qualifyStaleSaveNavigation({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  const upload = await qualifyUploadIsolation({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  const failure = await qualifyFailedProfileSave({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  return { result: "green", save, navigation, upload, failure };
}
