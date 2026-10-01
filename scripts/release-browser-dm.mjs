// Real-browser DM outcome qualification against the authenticated product UI.
// The recipient is an existing owner-linked persona created by the caller.

const UNCONFIRMED =
  "送信結果を確認できません。再送すると重複する可能性があります。履歴を確認してください。";
const REJECTED = "送信を受け付けられませんでした";
const BEFORE_WRITE_CONTENT = "Browser DM outcome: pre-commit transport failure";
const AFTER_COMMIT_CONTENT =
  "Browser DM outcome: committed acknowledgement loss";
const REJECTED_CONTENT = "x".repeat(5001);
const HISTORY_CONTENTS = Array.from({ length: 8 }, (_, index) => {
  const entry = String(index + 1).padStart(2, "0");
  return `Browser DM visibility history ${entry}\n${Array.from(
    { length: 6 },
    (_, line) =>
      `History entry ${entry}, line ${line + 1}: this authenticated fixture creates real multiline content so the message log must scroll.`,
  ).join("\n")}`;
});
const EVENT_TIMEOUT_MS = 15_000;

function requireEffect(condition, message) {
  if (!condition) throw new Error(`browser-dm ${message}`);
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

function observe(promise, label) {
  const settlement = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  settlement.catch(() => {});
  return { label, settlement };
}

async function awaitObserved(observation) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`browser-dm ${observation.label} timed out`)),
      EVENT_TIMEOUT_MS,
    );
  });
  deadline.catch(() => {});
  try {
    const outcome = await Promise.race([observation.settlement, deadline]);
    if (Object.hasOwn(outcome, "error")) throw outcome.error;
    return outcome.value;
  } finally {
    clearTimeout(timer);
  }
}

async function effectsFor(
  db,
  actorApId,
  recipientApId,
  content,
  expectedCount,
) {
  const notes = (
    await db
      .prepare(
        "SELECT ap_id, attributed_to, content, visibility FROM objects WHERE type = 'Note' AND attributed_to = ? AND content = ? ORDER BY ap_id",
      )
      .bind(actorApId, content)
      .all()
  ).results;
  const noteIds = notes.map((note) => note.ap_id);
  const inClause = noteIds.length ? noteIds.map(() => "?").join(",") : "NULL";
  const activities = (
    await db
      .prepare(
        `SELECT ap_id, object_ap_id, actor_ap_id FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id IN (${inClause})`,
      )
      .bind(actorApId, ...noteIds)
      .all()
  ).results;
  const recipients = (
    await db
      .prepare(
        `SELECT object_ap_id, recipient_ap_id, type FROM object_recipients WHERE recipient_ap_id = ? AND type = 'to' AND object_ap_id IN (${inClause})`,
      )
      .bind(recipientApId, ...noteIds)
      .all()
  ).results;
  const inbox = (
    await db
      .prepare(
        `SELECT i.activity_ap_id, a.object_ap_id FROM inbox i JOIN activities a ON a.ap_id = i.activity_ap_id WHERE i.actor_ap_id = ? AND a.actor_ap_id = ? AND a.type = 'Create' AND a.object_ap_id IN (${inClause})`,
      )
      .bind(recipientApId, actorApId, ...noteIds)
      .all()
  ).results;
  const valid =
    notes.length === expectedCount &&
    activities.length === expectedCount &&
    recipients.length === expectedCount &&
    inbox.length === expectedCount &&
    new Set(noteIds).size === expectedCount &&
    notes.every(
      (note) =>
        note.attributed_to === actorApId && note.visibility === "direct",
    ) &&
    activities.every((row) => noteIds.includes(row.object_ap_id)) &&
    recipients.every((row) => noteIds.includes(row.object_ap_id)) &&
    inbox.every((row) => noteIds.includes(row.object_ap_id));
  requireEffect(valid, `native DM effects did not equal ${expectedCount}`);
  return {
    notes: notes.length,
    creates: activities.length,
    recipients: recipients.length,
    localInbox: inbox.length,
    noteIds,
  };
}

async function createHistoryFixture(
  page,
  db,
  endpoint,
  actorApId,
  recipientApId,
) {
  for (const content of HISTORY_CONTENTS) {
    const response = await page.evaluate(
      async ({ endpoint, content }) => {
        try {
          const result = await fetch(endpoint, {
            method: "POST",
            credentials: "same-origin",
            redirect: "error",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content }),
          });
          let body;
          try {
            body = await result.json();
          } catch {
            body = null;
          }
          return {
            status: result.status,
            messageId: body?.message?.id ?? null,
          };
        } catch {
          return { status: 0, messageId: null };
        }
      },
      { endpoint, content },
    );
    requireEffect(
      response.status === 201 && typeof response.messageId === "string",
      "real history fixture did not receive HTTP 201 with a message ID",
    );
    const native = await effectsFor(db, actorApId, recipientApId, content, 1);
    requireEffect(
      native.noteIds[0] === response.messageId,
      "real history fixture response did not match its persisted Note",
    );
  }
  return { messages: HISTORY_CONTENTS.length };
}

async function globalIdSnapshot(db, actorApId, recipientApId) {
  const notes = (
    await db
      .prepare(
        "SELECT ap_id FROM objects WHERE type = 'Note' AND attributed_to = ?",
      )
      .bind(actorApId)
      .all()
  ).results;
  const creates = (
    await db
      .prepare(
        "SELECT ap_id, object_ap_id FROM activities WHERE type = 'Create' AND actor_ap_id = ?",
      )
      .bind(actorApId)
      .all()
  ).results;
  const recipientTo = (
    await db
      .prepare(
        "SELECT object_ap_id FROM object_recipients WHERE recipient_ap_id = ? AND type = 'to'",
      )
      .bind(recipientApId)
      .all()
  ).results;
  const inboxCreates = (
    await db
      .prepare(
        "SELECT i.activity_ap_id, a.object_ap_id FROM inbox i JOIN activities a ON a.ap_id = i.activity_ap_id WHERE i.actor_ap_id = ? AND a.actor_ap_id = ? AND a.type = 'Create'",
      )
      .bind(recipientApId, actorApId)
      .all()
  ).results;
  return {
    senderNotes: new Set(notes.map((row) => row.ap_id)),
    senderCreates: new Map(creates.map((row) => [row.ap_id, row.object_ap_id])),
    recipientTo: new Set(recipientTo.map((row) => row.object_ap_id)),
    localInboxCreates: new Map(
      inboxCreates.map((row) => [row.activity_ap_id, row.object_ap_id]),
    ),
  };
}

function setDelta(before, after) {
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  return { added, removed };
}

function assertGlobalDelta(before, after, expectedDelta, label) {
  const notes = setDelta(before.senderNotes, after.senderNotes);
  const creates = setDelta(
    new Set(before.senderCreates.keys()),
    new Set(after.senderCreates.keys()),
  );
  const recipients = setDelta(before.recipientTo, after.recipientTo);
  const inboxCreates = setDelta(
    new Set(before.localInboxCreates.keys()),
    new Set(after.localInboxCreates.keys()),
  );
  const diffs = { notes, creates, recipients, inboxCreates };
  requireEffect(
    Object.values(diffs).every(
      ({ added, removed }) =>
        added.length === expectedDelta && removed.length === 0,
    ),
    `${label} changed global Note/Create/recipient/inbox IDs by an unexpected amount`,
  );
  if (expectedDelta === 1) {
    const [noteId] = notes.added;
    const [activityId] = creates.added;
    requireEffect(
      recipients.added[0] === noteId &&
        after.senderCreates.get(activityId) === noteId &&
        inboxCreates.added[0] === activityId &&
        after.localInboxCreates.get(activityId) === noteId,
      `${label} did not correlate the Note, Create, recipient, and inbox IDs`,
    );
  }
  return {
    before: {
      senderNotes: before.senderNotes.size,
      senderCreates: before.senderCreates.size,
      recipientTo: before.recipientTo.size,
      localInboxCreates: before.localInboxCreates.size,
    },
    after: {
      senderNotes: after.senderNotes.size,
      senderCreates: after.senderCreates.size,
      recipientTo: after.recipientTo.size,
      localInboxCreates: after.localInboxCreates.size,
    },
    delta: expectedDelta,
  };
}

async function assertOwnerScope(db, actorApId, recipientApId) {
  const actors = (
    await db
      .prepare(
        "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
      )
      .all()
  ).results;
  const sessions = (
    await db.prepare("SELECT member_id FROM sessions ORDER BY member_id").all()
  ).results;
  const root = actors.find((actor) => actor.ap_id === actorApId);
  const recipient = actors.find((actor) => actor.ap_id === recipientApId);
  const personas = actors.filter((actor) => actor.ap_id !== actorApId);
  requireEffect(
    actors.length === 3 &&
      actors.filter(
        (actor) => actor.role === "owner" && actor.deleted_at === null,
      ).length === 1 &&
      root?.role === "owner" &&
      root.owner_actor_ap_id === null &&
      recipient?.role === "member" &&
      recipient.owner_actor_ap_id === actorApId &&
      recipient.deleted_at === null &&
      personas.length === 2 &&
      personas.every(
        (actor) =>
          actor.role === "member" &&
          actor.owner_actor_ap_id === actorApId &&
          actor.deleted_at === null,
      ) &&
      sessions.length === 1 &&
      sessions[0]?.member_id === actorApId,
    "DM qualification changed owner, persona, or session scope",
  );
  return { owners: 1, personas: 2, sessions: 1 };
}

function dmEndpoint(recipientApId) {
  return `/api/dm/user/${encodeURIComponent(recipientApId)}/messages`;
}

async function reloadWithAuthRecovery(page, actorApId, allowRecovery) {
  const reloadAuthResponse = observe(
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/me",
      { timeout: EVENT_TIMEOUT_MS },
    ),
    "DM history reload authentication",
  );
  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: EVENT_TIMEOUT_MS,
  });
  const reloadAuth = await awaitObserved(reloadAuthResponse);
  let authRecovery = { reloadStatus: reloadAuth.status(), retried: false };
  if (reloadAuth.status() === 429) {
    requireEffect(
      allowRecovery,
      "auth quota blocked a second reload after recovery",
    );
    const retryAfter = reloadAuth.headers()["retry-after"];
    requireEffect(
      /^\d+$/.test(retryAfter ?? "") &&
        Number(retryAfter) >= 1 &&
        Number(retryAfter) <= 60,
      "auth quota returned an invalid or excessive Retry-After",
    );
    const retry = page.getByRole("button", { name: "再試行", exact: true });
    await retry.waitFor({ state: "visible", timeout: EVENT_TIMEOUT_MS });
    await page.waitForTimeout(Number(retryAfter) * 1000);
    await page.waitForTimeout(150);
    const retryAuthResponse = observe(
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/auth/me",
        { timeout: EVENT_TIMEOUT_MS },
      ),
      "explicit auth quota recovery",
    );
    await retry.click();
    const recovered = await awaitObserved(retryAuthResponse);
    requireEffect(
      recovered.status() === 200,
      "one explicit auth retry did not recover HTTP 200",
    );
    const identity = await recovered.json();
    requireEffect(
      identity.actor?.ap_id === actorApId && identity.actor?.role === "owner",
      "auth quota recovery changed the authenticated owner",
    );
    authRecovery = {
      reloadStatus: 429,
      retryAfterSeconds: Number(retryAfter),
      retried: true,
      retryStatus: 200,
    };
  } else {
    requireEffect(
      reloadAuth.status() === 200,
      "DM reload authentication failed unexpectedly",
    );
    const identity = await reloadAuth.json();
    requireEffect(
      identity.actor?.ap_id === actorApId && identity.actor?.role === "owner",
      "DM reload changed the authenticated owner",
    );
  }
  return authRecovery;
}

async function alertState(page, expected, expectedDraft) {
  const input = page.getByRole("textbox", {
    name: "メッセージを入力...",
    exact: true,
  });
  const alert = input.locator("xpath=ancestor::form").getByRole("alert");
  await alert.waitFor({ state: "visible", timeout: EVENT_TIMEOUT_MS });
  requireEffect(
    (await alert.count()) === 1 && (await alert.innerText()) === expected,
    "DM outcome was not shown in the expected single alert",
  );
  const send = page.getByRole("button", { name: "送信", exact: true });
  const log = page.getByRole("log");
  const alertBox = await alert.boundingBox();
  const inputBox = await input.boundingBox();
  const composerBox = await input.locator("xpath=ancestor::form").boundingBox();
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    viewportHeight: window.innerHeight,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  const logState = await log.evaluate((element) => ({
    scrollTop: element.scrollTop,
    overflow: element.scrollHeight - element.clientHeight,
    alertInsideLog: Boolean(element.querySelector('[role="alert"]')),
  }));
  requireEffect(
    geometry.viewport === 390 &&
      geometry.document <= geometry.viewport &&
      geometry.body <= geometry.viewport &&
      alertBox &&
      alertBox.x >= 0 &&
      alertBox.x + alertBox.width <= geometry.viewport &&
      alertBox.y >= 0 &&
      alertBox.y + alertBox.height <= geometry.viewportHeight &&
      inputBox &&
      inputBox.x >= 0 &&
      inputBox.x + inputBox.width <= geometry.viewport &&
      inputBox.y >= 0 &&
      inputBox.y + inputBox.height <= geometry.viewportHeight &&
      composerBox &&
      composerBox.x >= 0 &&
      composerBox.x + composerBox.width <= geometry.viewport &&
      composerBox.y >= 0 &&
      composerBox.y + composerBox.height <= geometry.viewportHeight,
    "DM outcome state overflowed the 390px viewport",
  );
  if (expected === UNCONFIRMED) {
    requireEffect(
      (await log.count()) === 1 &&
        logState.overflow > 120 &&
        logState.scrollTop <= 1 &&
        !logState.alertInsideLog,
      "unconfirmed warning depended on the scrolled message log or was inside it",
    );
  }
  const draft = await input.inputValue();
  return {
    alertText: expected,
    alertCount: 1,
    draftPreserved: draft === expectedDraft,
    draftLength: draft.length,
    sendEnabled: await send.isEnabled(),
    viewportWidth: geometry.viewport,
    documentWidth: geometry.document,
    bodyWidth: geometry.body,
    logScrollTop: logState.scrollTop,
    logOverflow: logState.overflow,
    alertOutsideLog: !logState.alertInsideLog,
  };
}

/**
 * Qualify DM delivery outcomes with a real product UI, worker, and D1 store.
 * The helper uses only the root session and the already-created local persona.
 */
export async function qualifyBrowserDM({
  page,
  db,
  origin,
  actorApId,
  recipientApId,
  checks,
}) {
  requireEffect(
    page &&
      db &&
      Array.isArray(checks) &&
      actorApId === `${origin}/ap/users/tako` &&
      typeof recipientApId === "string" &&
      recipientApId !== actorApId,
    "qualification needs the authenticated root and an existing persona",
  );
  await assertOwnerScope(db, actorApId, recipientApId);
  const originalSessions = (
    await db.prepare("SELECT id, member_id FROM sessions ORDER BY id").all()
  ).results;

  const passed = [];
  const mark = (name) => {
    passed.push(name);
    checks.push(name);
  };
  const endpoint = dmEndpoint(recipientApId);
  const requestCounts = new Map();
  const gates = new Map([
    [BEFORE_WRITE_CONTENT, eventGate("pre-write abort")],
    [AFTER_COMMIT_CONTENT, eventGate("committed acknowledgement loss")],
  ]);
  const routePattern = new RegExp(
    `^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/dm/user/.+/messages$`,
  );
  const routeHandler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== endpoint || request.method() !== "POST") {
      await route.continue();
      return;
    }
    let body;
    try {
      body = request.postDataJSON();
    } catch {
      await route.continue();
      return;
    }
    if (typeof body?.content !== "string") {
      await route.continue();
      return;
    }
    const requestCount = (requestCounts.get(body.content) ?? 0) + 1;
    requestCounts.set(body.content, requestCount);
    const gate = gates.get(body?.content);
    if (!gate || requestCount !== 1) {
      await route.continue();
      return;
    }

    try {
      if (body.content === BEFORE_WRITE_CONTENT) {
        const empty = await effectsFor(
          db,
          actorApId,
          recipientApId,
          BEFORE_WRITE_CONTENT,
          0,
        );
        await route.abort("failed");
        gate.resolve({
          mode: "aborted-before-backend",
          method: request.method(),
          path: url.pathname,
          effectsBeforeAbort: empty,
        });
        return;
      }

      const upstream = await route.fetch({
        maxRedirects: 0,
        timeout: EVENT_TIMEOUT_MS,
      });
      let bodyJson;
      try {
        bodyJson = await upstream.json();
      } catch {
        bodyJson = null;
      }
      const committed = await effectsFor(
        db,
        actorApId,
        recipientApId,
        AFTER_COMMIT_CONTENT,
        1,
      );
      requireEffect(
        upstream.status() === 201 &&
          typeof bodyJson?.message?.id === "string" &&
          bodyJson.message.id === committed.noteIds[0],
        "backend did not commit the expected 201 DM before acknowledgement drop",
      );
      await route.abort("failed");
      gate.resolve({
        mode: "real-backend-201-then-ack-abort",
        method: request.method(),
        path: url.pathname,
        upstreamStatus: upstream.status(),
        committedBeforeAbort: committed,
      });
    } catch (error) {
      gate.reject(error);
      try {
        await route.abort("failed");
      } catch {
        // Preserve the primary artifact assertion/transport failure.
      }
    }
  };

  let primaryError;
  try {
    await page.context().route(routePattern, routeHandler);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/dm?c=${encodeURIComponent(recipientApId)}`, {
      waitUntil: "domcontentloaded",
      timeout: EVENT_TIMEOUT_MS,
    });
    const input = page.getByRole("textbox", {
      name: "メッセージを入力...",
      exact: true,
    });
    const send = page.getByRole("button", { name: "送信", exact: true });
    await input.waitFor({ state: "visible", timeout: EVENT_TIMEOUT_MS });

    const history = await createHistoryFixture(
      page,
      db,
      endpoint,
      actorApId,
      recipientApId,
    );
    const historyReloadAuth = await reloadWithAuthRecovery(
      page,
      actorApId,
      true,
    );
    const log = page.getByRole("log");
    await log.waitFor({ state: "visible", timeout: EVENT_TIMEOUT_MS });
    await page
      .getByText("Browser DM visibility history 08", { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: EVENT_TIMEOUT_MS });
    const scrolledHistory = await log.evaluate((element) => {
      element.scrollTop = 0;
      return {
        scrollTop: element.scrollTop,
        overflow: element.scrollHeight - element.clientHeight,
      };
    });
    requireEffect(
      scrolledHistory.overflow > 120 &&
        scrolledHistory.scrollTop <= 1 &&
        (await input.isVisible()) &&
        (await input.locator("xpath=ancestor::form").isVisible()),
      "real DM history did not leave a scrolled log and visible composer",
    );

    // A transport failure before the server receives the request is still
    // unconfirmed to the user, even though native D1 shows no committed row.
    const beforeAbortSnapshot = await globalIdSnapshot(
      db,
      actorApId,
      recipientApId,
    );
    const beforeGate = observe(
      gates.get(BEFORE_WRITE_CONTENT).promise,
      "pre-write failure",
    );
    await input.fill(BEFORE_WRITE_CONTENT);
    requireEffect(
      await send.isEnabled(),
      "pre-write fixture send button was disabled",
    );
    await send.click();
    const beforeResult = await awaitObserved(beforeGate);
    const beforeAlert = await alertState(
      page,
      UNCONFIRMED,
      BEFORE_WRITE_CONTENT,
    );
    await page.waitForTimeout(500);
    requireEffect(
      beforeAlert.draftPreserved &&
        beforeAlert.sendEnabled &&
        beforeAlert.logScrollTop <= 1 &&
        beforeAlert.logOverflow > 120 &&
        beforeAlert.alertOutsideLog &&
        requestCounts.get(BEFORE_WRITE_CONTENT) === 1,
      "pre-write transport failure did not remain unconfirmed with a retained draft",
    );
    const afterAbortSnapshot = await globalIdSnapshot(
      db,
      actorApId,
      recipientApId,
    );
    const beforeAbortGlobalEffects = assertGlobalDelta(
      beforeAbortSnapshot,
      afterAbortSnapshot,
      0,
      "pre-backend abort",
    );
    mark("browser-dm-scrolled-history-warning-visible");
    mark("browser-dm-before-write-unconfirmed-draft-preserved");

    // This is an explicit user retry after the no-commit failure. It creates
    // exactly one Note and is not an automatic retry by the application.
    const firstRetryResponse = observe(
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === endpoint &&
          response.request().method() === "POST" &&
          response.request().postDataJSON()?.content === BEFORE_WRITE_CONTENT,
        { timeout: EVENT_TIMEOUT_MS },
      ),
      "pre-write manual retry response",
    );
    await send.click();
    const firstRetry = await awaitObserved(firstRetryResponse);
    requireEffect(
      firstRetry.status() === 201,
      "pre-write manual retry did not receive HTTP 201",
    );
    const afterFirstRetrySnapshot = await globalIdSnapshot(
      db,
      actorApId,
      recipientApId,
    );
    const firstRetryGlobalEffects = assertGlobalDelta(
      afterAbortSnapshot,
      afterFirstRetrySnapshot,
      1,
      "explicit pre-write retry",
    );
    const afterFirstRetry = await effectsFor(
      db,
      actorApId,
      recipientApId,
      BEFORE_WRITE_CONTENT,
      1,
    );
    await page.getByText(BEFORE_WRITE_CONTENT, { exact: true }).waitFor({
      state: "visible",
      timeout: EVENT_TIMEOUT_MS,
    });
    const retryBubbleCount = await page
      .getByText(BEFORE_WRITE_CONTENT, { exact: true })
      .count();
    requireEffect(
      retryBubbleCount === 1 &&
        (await input.inputValue()) === "" &&
        requestCounts.get(BEFORE_WRITE_CONTENT) === 2,
      "manual retry did not clear the draft or had unexpected request count",
    );
    mark("browser-dm-before-write-manual-retry-committed-once");

    // This request commits, returns 201 from the real Worker, and only then
    // loses its acknowledgement. It is deliberately not retried in this case.
    const beforeAckLossSnapshot = afterFirstRetrySnapshot;
    const afterGate = observe(
      gates.get(AFTER_COMMIT_CONTENT).promise,
      "post-commit acknowledgement loss",
    );
    await input.fill(AFTER_COMMIT_CONTENT);
    await send.click();
    const afterResult = await awaitObserved(afterGate);
    const afterAlert = await alertState(
      page,
      UNCONFIRMED,
      AFTER_COMMIT_CONTENT,
    );
    await page.waitForTimeout(500);
    requireEffect(
      afterAlert.draftPreserved &&
        afterAlert.sendEnabled &&
        requestCounts.get(AFTER_COMMIT_CONTENT) === 1,
      "committed lost acknowledgement was not kept unconfirmed without auto-retry",
    );
    const afterAckLossSnapshot = await globalIdSnapshot(
      db,
      actorApId,
      recipientApId,
    );
    const ackLossGlobalEffects = assertGlobalDelta(
      beforeAckLossSnapshot,
      afterAckLossSnapshot,
      1,
      "committed acknowledgement loss",
    );
    mark("browser-dm-committed-ack-loss-unconfirmed-no-retry");

    // Clear only the local draft, then prove that the committed message remains
    // in history. No retry is sent for this case.
    await input.fill("");
    const afterManualClear = await effectsFor(
      db,
      actorApId,
      recipientApId,
      AFTER_COMMIT_CONTENT,
      1,
    );
    const ackLossReloadAuth = await reloadWithAuthRecovery(
      page,
      actorApId,
      !historyReloadAuth.retried,
    );
    mark("browser-dm-history-reload-auth-result");
    await page.getByText(AFTER_COMMIT_CONTENT, { exact: true }).waitFor({
      state: "visible",
      timeout: EVENT_TIMEOUT_MS,
    });
    const ackLostBubblesAfterReload = await page
      .getByText(AFTER_COMMIT_CONTENT, { exact: true })
      .count();
    requireEffect(
      ackLostBubblesAfterReload === 1 &&
        requestCounts.get(AFTER_COMMIT_CONTENT) === 1,
      "ack-loss history did not reload one committed message without retry",
    );

    // A real server 400 (Core's published 5,000-character limit) is a known
    // rejection, unlike either transport failure above.
    const beforeRejectedSnapshot = await globalIdSnapshot(
      db,
      actorApId,
      recipientApId,
    );
    const rejectedResponse = observe(
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === endpoint &&
          response.request().method() === "POST" &&
          response.request().postDataJSON()?.content?.length === 5001,
        { timeout: EVENT_TIMEOUT_MS },
      ),
      "real 400 DM rejection",
    );
    await input.fill(REJECTED_CONTENT);
    requireEffect(
      await send.isEnabled(),
      "oversize API-refusal fixture was blocked by the UI",
    );
    await send.click();
    const rejected = await awaitObserved(rejectedResponse);
    requireEffect(
      rejected.status() === 400,
      "Core did not reject the over-limit DM with HTTP 400",
    );
    const rejectedAlert = await alertState(page, REJECTED, REJECTED_CONTENT);
    requireEffect(
      rejectedAlert.draftPreserved &&
        rejectedAlert.sendEnabled &&
        !(await page.getByText(UNCONFIRMED, { exact: true }).count()),
      "real 400 was not classified as rejected with its draft preserved",
    );
    const rejectedEffects = await effectsFor(
      db,
      actorApId,
      recipientApId,
      REJECTED_CONTENT,
      0,
    );
    const afterRejectedSnapshot = await globalIdSnapshot(
      db,
      actorApId,
      recipientApId,
    );
    const rejectedGlobalEffects = assertGlobalDelta(
      beforeRejectedSnapshot,
      afterRejectedSnapshot,
      0,
      "real 400 refusal",
    );
    requireEffect(
      requestCounts.get(REJECTED_CONTENT) === 1,
      "real 400 produced an unexpected second send request",
    );
    await assertOwnerScope(db, actorApId, recipientApId);
    const finalSessions = (
      await db.prepare("SELECT id, member_id FROM sessions ORDER BY id").all()
    ).results;
    requireEffect(
      JSON.stringify(finalSessions) === JSON.stringify(originalSessions),
      "DM verification changed the existing salted session credential",
    );
    mark("browser-dm-real-400-rejected-no-native-write");

    return {
      scope:
        "same-owner local persona DM; no remote delivery, idempotency, or OIDC claim",
      checks: passed,
      checkCount: passed.length,
      ownerCount: 1,
      personaCount: 2,
      sessionCount: 1,
      sessionCredentialUnchanged: true,
      authRecovery: {
        historyReload: historyReloadAuth,
        ackLossReload: ackLossReloadAuth,
      },
      requestsPerCase: {
        beforeWrite: requestCounts.get(BEFORE_WRITE_CONTENT),
        afterCommitAckLoss: requestCounts.get(AFTER_COMMIT_CONTENT),
        rejected400: requestCounts.get(REJECTED_CONTENT),
      },
      outcomes: {
        beforeWrite: {
          ack: beforeResult,
          client: beforeAlert,
          afterExplicitRetry: afterFirstRetry,
          bubblesAfterExplicitRetry: retryBubbleCount,
          globalIdDelta: beforeAbortGlobalEffects,
          retryGlobalIdDelta: firstRetryGlobalEffects,
        },
        afterCommitAckLoss: {
          ack: afterResult,
          client: afterAlert,
          effectsAfterLocalDraftClear: afterManualClear,
          bubblesAfterReload: ackLostBubblesAfterReload,
          globalIdDelta: ackLossGlobalEffects,
        },
        rejected400: {
          status: rejected.status(),
          contentLength: 5001,
          client: rejectedAlert,
          nativeEffects: rejectedEffects,
          globalIdDelta: rejectedGlobalEffects,
        },
      },
      mobileWidth: 390,
      scrolledHistory: {
        messages: history.messages,
        overflowBeforeFailure: scrolledHistory.overflow,
        scrollTopBeforeFailure: scrolledHistory.scrollTop,
        alertOutsideLog: beforeAlert.alertOutsideLog,
        warningViewportHeight: 844,
      },
      lostAckDuplicateRisk:
        "confirmed: an explicit retry after an ambiguous committed result would create another Note; no retry was sent in that case",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await page.context().unroute(routePattern, routeHandler);
    } catch {
      if (!primaryError) {
        throw new Error("browser-dm route cleanup failed");
      }
      process.stderr.write("browser-dm route cleanup also failed\n");
    }
  }
}
