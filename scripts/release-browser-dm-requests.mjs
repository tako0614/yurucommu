// Native-browser regression for AP-native DM requests. A request remains
// pending until the recipient's first real reply is acknowledged.

import { createHash, randomUUID } from "node:crypto";

const TIMEOUT = 15_000;
const REQUEST_TEXT = `dm-request-opening-${randomUUID()}`;
const REFUSAL_TEXT = `dm-request-refusal-${randomUUID()}`;
const REPLY_TEXT = `dm-request-real-reply-${randomUUID()}`;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`browser-dm-requests:${label}-timeout`)),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function need(condition, label, detail = "") {
  if (!condition)
    throw new Error(
      `browser-dm-requests:${label}${detail ? ` ${detail}` : ""}`,
    );
}

function cookieFrom(response) {
  const header = response.headers.get("set-cookie") ?? "";
  return /(?:^|,\s*)session=([^;,]+)/i.exec(header)?.[1] ?? null;
}

function sessionId(salt, cookie) {
  return `sha256:${createHash("sha256").update(`${salt}:${cookie}`).digest("hex")}`;
}

async function workerRequest(
  worker,
  origin,
  cookie,
  path,
  method = "GET",
  body,
) {
  return worker.dispatchFetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      cookie: `session=${cookie}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function loginOwner(worker, db, origin, password, salt) {
  const beforeActors = await db
    .prepare("SELECT ap_id, role FROM actors ORDER BY ap_id")
    .all();
  const beforeSessions = await db
    .prepare("SELECT id, member_id FROM sessions ORDER BY id")
    .all();
  need(
    (beforeActors.results ?? []).length === 0 &&
      (beforeSessions.results ?? []).length === 0,
    "fresh-store-has-no-actor-or-session-seeds",
  );
  const response = await worker.dispatchFetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  need(
    response.status === 200,
    "password-creates-root-owner",
    `${response.status}`,
  );
  const cookie = cookieFrom(response);
  need(cookie, "owner-session-cookie-issued");
  const me = await workerRequest(worker, origin, cookie, "/api/auth/me");
  need(me.status === 200, "root-session-authenticates");
  const actor = (await me.json()).actor;
  need(
    actor?.role === "owner" && actor.ap_id === `${origin}/ap/users/tako`,
    "one-password-created-root-owner",
  );
  const actorRows = await db
    .prepare(
      "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
    )
    .all();
  need(
    (actorRows.results ?? []).length === 1 &&
      actorRows.results[0].ap_id === actor.ap_id &&
      actorRows.results[0].role === "owner" &&
      actorRows.results[0].owner_actor_ap_id == null &&
      actorRows.results[0].deleted_at == null,
    "root-owner-native-readback",
  );
  const exactSessionId = sessionId(salt, cookie);
  const session = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(exactSessionId)
    .first();
  need(
    session?.id === exactSessionId && session.member_id === actor.ap_id,
    "exact-salted-root-session-readback",
  );
  return { actor, cookie, exactSessionId };
}

async function switchActor(worker, db, origin, cookie, targetApId, salt) {
  const response = await workerRequest(
    worker,
    origin,
    cookie,
    "/api/auth/switch",
    "POST",
    { ap_id: targetApId },
  );
  need(
    response.status === 200,
    "real-owner-linked-session-switch",
    `${response.status}`,
  );
  const nextCookie = cookieFrom(response);
  need(nextCookie, "session-rotation-cookie-issued");
  const exactSessionId = sessionId(salt, nextCookie);
  const row = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(exactSessionId)
    .first();
  need(
    row?.id === exactSessionId && row.member_id === targetApId,
    "switched-exact-salted-session-readback",
  );
  return { cookie: nextCookie, exactSessionId };
}

async function createPersona(worker, db, origin, auth, salt) {
  const username = `dm_request_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const response = await workerRequest(
    worker,
    origin,
    auth.cookie,
    "/api/auth/accounts",
    "POST",
    {
      username,
      name: "DM Request Fixture Persona",
    },
  );
  need(
    response.status === 201 || response.status === 200,
    "public-owner-account-api-creates-persona",
    `${response.status}`,
  );
  const account = (await response.json()).account;
  need(
    account?.ap_id === `${origin}/ap/users/${username}`,
    "persona-response-ap-id",
  );
  const actors = await db
    .prepare(
      "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
    )
    .all();
  need(
    (actors.results ?? []).length === 2 &&
      actors.results.some(
        (row) =>
          row.ap_id === auth.actor.ap_id &&
          row.role === "owner" &&
          row.owner_actor_ap_id == null &&
          row.deleted_at == null,
      ) &&
      actors.results.some(
        (row) =>
          row.ap_id === account.ap_id &&
          row.role === "member" &&
          row.owner_actor_ap_id === auth.actor.ap_id &&
          row.deleted_at == null,
      ),
    "exactly-one-api-created-owner-linked-persona",
  );
  const switched = await switchActor(
    worker,
    db,
    origin,
    auth.cookie,
    account.ap_id,
    salt,
  );
  const sender = await workerRequest(
    worker,
    origin,
    switched.cookie,
    "/api/auth/me",
  );
  need(
    sender.status === 200 &&
      (await sender.json()).actor?.ap_id === account.ap_id,
    "persona-session-is-current-sender",
  );
  const returned = await switchActor(
    worker,
    db,
    origin,
    switched.cookie,
    auth.actor.ap_id,
    salt,
  );
  const rootMe = await workerRequest(
    worker,
    origin,
    returned.cookie,
    "/api/auth/me",
  );
  need(
    rootMe.status === 200 &&
      (await rootMe.json()).actor?.ap_id === auth.actor.ap_id,
    "root-session-restored",
  );
  return {
    actor: account,
    rootCookie: returned.cookie,
    rootSessionId: returned.exactSessionId,
    personaSessionId: switched.exactSessionId,
  };
}

async function readJSON(worker, origin, cookie, path, status = 200) {
  const response = await workerRequest(worker, origin, cookie, path);
  need(
    response.status === status,
    `worker-api-${path}-${status}`,
    `${response.status}`,
  );
  return response.json();
}

async function requestState(worker, db, origin, cookie, rootApId, senderApId) {
  const [requestBody, contactsBody] = await Promise.all([
    readJSON(worker, origin, cookie, "/api/dm/requests"),
    readJSON(worker, origin, cookie, "/api/dm/contacts"),
  ]);
  const requests = requestBody.requests ?? [];
  const request = requests.find((item) => item.sender?.ap_id === senderApId);
  const messageRows = await db
    .prepare(
      "SELECT o.ap_id, o.attributed_to, o.conversation, o.content, o.visibility, o.published, r.recipient_ap_id, r.type FROM objects o LEFT JOIN object_recipients r ON r.object_ap_id = o.ap_id WHERE o.visibility = 'direct' AND (o.attributed_to = ? OR r.recipient_ap_id = ?) ORDER BY o.published, o.ap_id",
    )
    .bind(senderApId, rootApId)
    .all();
  const inboxRows = await db
    .prepare(
      "SELECT i.actor_ap_id, i.activity_ap_id, a.object_ap_id, a.type, a.direction FROM inbox i JOIN activities a ON a.ap_id = i.activity_ap_id WHERE i.actor_ap_id = ? AND a.actor_ap_id = ? ORDER BY a.object_ap_id",
    )
    .bind(rootApId, senderApId)
    .all();
  return {
    requests,
    request: request ?? null,
    requestCount: contactsBody.request_count,
    rows: messageRows.results ?? [],
    inbox: inboxRows.results ?? [],
  };
}

function requirePending(state, senderApId, rootApId, text, label) {
  need(
    state.request?.sender?.ap_id === senderApId &&
      state.request.content === text,
    `${label}-api-has-pending-native-persona-request`,
  );
  need(
    state.requestCount === 1,
    `${label}-api-request-count-one`,
    `${state.requestCount}`,
  );
  need(
    state.rows.length === 1 &&
      state.rows[0].attributed_to === senderApId &&
      state.rows[0].recipient_ap_id === rootApId &&
      state.rows[0].type === "to" &&
      state.rows[0].visibility === "direct" &&
      state.rows[0].content === text,
    `${label}-native-request-note-and-recipient`,
  );
  need(
    state.inbox.length === 1 &&
      state.inbox[0].actor_ap_id === rootApId &&
      state.inbox[0].object_ap_id === state.rows[0]?.ap_id &&
      state.inbox[0].type === "Create" &&
      state.inbox[0].direction === "inbound",
    `${label}-native-recipient-inbox-create`,
    JSON.stringify({ rows: state.rows, inbox: state.inbox }),
  );
}

async function uiRequestState(
  page,
  senderName,
  requestText,
  waitForRow = false,
) {
  const tab = page.getByRole("tab", { name: /リクエスト|Requests/ });
  await tab.waitFor({ state: "visible", timeout: TIMEOUT });
  const selected = (await tab.getAttribute("aria-selected")) === "true";
  if (!selected) await tab.click();
  if (waitForRow)
    await page
      .getByText(requestText, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
  else
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const text = await tab.innerText();
  const badge = await tab.locator("span").allTextContents();
  return {
    rowVisible:
      (await page.getByText(requestText, { exact: true }).count()) > 0,
    senderVisible:
      (await page.getByText(senderName, { exact: true }).count()) > 0,
    tabText: text,
    badge: badge.map((value) => value.trim()).filter(Boolean),
  };
}

async function openRequest(page, requestText) {
  const row = page
    .locator("div.flex.items-start.gap-3")
    .filter({ has: page.getByText(requestText, { exact: true }) });
  const open = row.getByRole("button", {
    name: /^(承認|開いて返信|Accept|Open to reply)$/,
  });
  await open.waitFor({ state: "visible", timeout: TIMEOUT });
  await open.click();
  await page.waitForURL(
    (url) => url.pathname === "/dm" && url.searchParams.has("c"),
    { timeout: TIMEOUT },
  );
  await page
    .getByRole("textbox", { name: "メッセージを入力...", exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT });
}

async function backToList(page) {
  const requestRefresh = page
    .waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/dm/requests" &&
          response.request().method() === "GET"
        );
      },
      { timeout: 1_500 },
    )
    .then(
      async (response) => {
        const bytes = await response.body();
        return {
          status: response.status(),
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
      () => null,
    );
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === "/dm" && !url.searchParams.has("c"),
    { timeout: TIMEOUT },
  );
  return requestRefresh;
}

async function pendingRowsSnapshot(db, senderApId, rootApId) {
  const rows = await db
    .prepare(
      "SELECT o.ap_id, o.attributed_to, o.conversation, o.content, o.visibility, o.published, r.recipient_ap_id, r.type FROM objects o LEFT JOIN object_recipients r ON r.object_ap_id = o.ap_id WHERE o.visibility = 'direct' AND o.conversation IN (SELECT conversation FROM objects incoming INNER JOIN object_recipients ir ON ir.object_ap_id = incoming.ap_id WHERE incoming.visibility = 'direct' AND incoming.attributed_to = ? AND ir.recipient_ap_id = ? AND ir.type = 'to') ORDER BY o.published, o.ap_id",
    )
    .bind(senderApId, rootApId)
    .all();
  const inbox = await db
    .prepare(
      "SELECT i.actor_ap_id, i.activity_ap_id, a.object_ap_id, a.type, a.direction FROM inbox i JOIN activities a ON a.ap_id = i.activity_ap_id WHERE i.actor_ap_id = ? AND a.actor_ap_id = ? ORDER BY a.object_ap_id",
    )
    .bind(rootApId, senderApId)
    .all();
  return { rows: rows.results ?? [], inbox: inbox.results ?? [] };
}

/** Fresh password owner + API-created linked persona; no actor/session seeds. */
export async function qualifyDMRequests({
  browser,
  worker,
  db,
  origin,
  password,
  sessionSalt,
  checks = [],
}) {
  need(
    browser && worker && db && Array.isArray(checks),
    "browser-worker-native-db-and-checks-required",
  );
  const parsed = new URL(origin);
  need(
    ["localhost", "127.0.0.1"].includes(parsed.hostname) &&
      parsed.origin === origin,
    "loopback-origin-only",
  );
  need(
    typeof password === "string" &&
      password.length > 0 &&
      typeof sessionSalt === "string" &&
      sessionSalt.length > 0,
    "ephemeral-password-and-session-salt-required",
  );
  const root = await loginOwner(worker, db, origin, password, sessionSalt);
  const persona = await createPersona(worker, db, origin, root, sessionSalt);
  const personaSessionResponse = await workerRequest(
    worker,
    origin,
    persona.rootCookie,
    "/api/auth/switch",
    "POST",
    { ap_id: persona.actor.ap_id },
  );
  need(
    personaSessionResponse.status === 200,
    "persona-session-restored-for-dm-sender",
  );
  const personaCookie = cookieFrom(personaSessionResponse);
  need(personaCookie, "persona-cookie-after-switch");
  const sendPath = `/api/dm/user/${encodeURIComponent(root.actor.ap_id)}/messages`;
  const replyPath = `/api/dm/user/${encodeURIComponent(persona.actor.ap_id)}/messages`;
  const incoming = await workerRequest(
    worker,
    origin,
    personaCookie,
    sendPath,
    "POST",
    { content: REQUEST_TEXT },
  );
  need(
    incoming.status === 201,
    "persona-real-dm-request-create-201",
    `${incoming.status}`,
  );
  const incomingBody = await incoming.json();
  const incomingMessage = incomingBody.message;
  need(
    incomingMessage?.content === REQUEST_TEXT &&
      incomingMessage.sender?.ap_id === persona.actor.ap_id &&
      typeof incomingMessage.id === "string",
    "persona-dm-response-correlated",
  );
  const rootLogin = await workerRequest(
    worker,
    origin,
    personaCookie,
    "/api/auth/switch",
    "POST",
    { ap_id: root.actor.ap_id },
  );
  need(rootLogin.status === 200, "return-to-root-session");
  const rootCookie = cookieFrom(rootLogin);
  need(rootCookie, "root-cookie-restored");
  const rootSessionId = sessionId(sessionSalt, rootCookie);
  const rootSession = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(rootSessionId)
    .first();
  need(
    rootSession?.id === rootSessionId &&
      rootSession.member_id === root.actor.ap_id,
    "returned-root-exact-salted-session",
  );
  const initialActors = await db
    .prepare(
      "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
    )
    .all();
  const initialSessions = await db
    .prepare("SELECT id, member_id FROM sessions ORDER BY id")
    .all();
  need(
    (initialActors.results ?? []).length === 2 &&
      (initialSessions.results ?? []).length === 1,
    "fixture-has-only-root-persona-and-one-rotated-session",
  );
  const initial = await requestState(
    worker,
    db,
    origin,
    rootCookie,
    root.actor.ap_id,
    persona.actor.ap_id,
  );
  requirePending(
    initial,
    persona.actor.ap_id,
    root.actor.ap_id,
    REQUEST_TEXT,
    "initial",
  );

  const context = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 1000, height: 850 },
    serviceWorkers: "block",
  });
  const heldReleases = [];
  let primaryError;
  let outboundBlocked = 0;
  try {
    await context.addCookies([
      {
        name: "session",
        value: rootCookie,
        domain: parsed.hostname,
        path: "/",
        httpOnly: true,
        secure: parsed.protocol === "https:",
        sameSite: "Lax",
      },
    ]);
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["data:", "blob:"].includes(url.protocol))
        return route.continue();
      outboundBlocked++;
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    const nativeGetResponses = [];
    const nativeGetTasks = [];
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (
        url.origin !== origin ||
        !["/api/dm/requests", "/api/dm/contacts"].includes(url.pathname) ||
        response.request().method() !== "GET"
      )
        return;
      const task = (async () => {
        try {
          const bytes = await response.body();
          nativeGetResponses.push({
            path: url.pathname,
            status: response.status(),
            bodySha256: createHash("sha256").update(bytes).digest("hex"),
          });
        } catch {
          nativeGetResponses.push({
            path: url.pathname,
            status: response.status(),
            bodySha256: null,
          });
        }
      })();
      nativeGetTasks.push(task);
    });
    const forbidden = [];
    const uiPostAttempts = new Map();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/dm/requests/accept")
        forbidden.push(request.method());
      if (url.pathname === replyPath && request.method() === "POST") {
        const content = request.postDataJSON()?.content;
        uiPostAttempts.set(content, (uiPostAttempts.get(content) ?? 0) + 1);
      }
    });
    const initialContacts = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/dm/contacts" &&
        response.request().method() === "GET",
      { timeout: TIMEOUT },
    );
    await page.goto(`${origin}/dm`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const rootIdentity = await page.evaluate(async () => {
      const response = await fetch("/api/auth/me", { credentials: "include" });
      const body = await response.json();
      return { status: response.status, actor: body.actor };
    });
    need(
      rootIdentity.status === 200 &&
        rootIdentity.actor?.ap_id === root.actor.ap_id &&
        rootIdentity.actor.role === "owner",
      "chrome-authenticated-as-root-owner",
    );

    const initialUi = await uiRequestState(
      page,
      persona.actor.name,
      REQUEST_TEXT,
      true,
    );
    need(
      (await initialContacts).status() === 200,
      "initial-native-contacts-request-count-read-200",
    );
    need(
      initialUi.rowVisible &&
        initialUi.senderVisible &&
        initialUi.badge.includes("1"),
      "requests-tab-shows-native-request-and-badge-one",
      JSON.stringify(initialUi),
    );
    await openRequest(page, REQUEST_TEXT);
    const acceptedWithoutReply = await requestState(
      worker,
      db,
      origin,
      rootCookie,
      root.actor.ap_id,
      persona.actor.ap_id,
    );
    requirePending(
      acceptedWithoutReply,
      persona.actor.ap_id,
      root.actor.ap_id,
      REQUEST_TEXT,
      "open-without-reply",
    );
    const requestRefreshAfterOpen = await backToList(page);
    const afterBackUi = await uiRequestState(
      page,
      persona.actor.name,
      REQUEST_TEXT,
    );
    need(
      afterBackUi.rowVisible &&
        afterBackUi.senderVisible &&
        afterBackUi.badge.includes("1"),
      "back-to-requests-shows-pending-row-and-badge-one",
      JSON.stringify({
        ui: afterBackUi,
        refreshResponse: requestRefreshAfterOpen,
        api: {
          pending: acceptedWithoutReply.request !== null,
          requestCount: acceptedWithoutReply.requestCount,
        },
        native: {
          rows: acceptedWithoutReply.rows.length,
          inbox: acceptedWithoutReply.inbox.length,
        },
      }),
    );
    need(
      requestRefreshAfterOpen?.status === 200 &&
        /^[a-f0-9]{64}$/.test(requestRefreshAfterOpen.bodySha256),
      "back-to-requests-real-native-get-captured",
      JSON.stringify(requestRefreshAfterOpen),
    );
    const requestRow = page
      .locator("div.flex.items-start.gap-3")
      .filter({ has: page.getByText(REQUEST_TEXT, { exact: true }) });
    need(
      (await requestRow
        .getByRole("button", { name: "開いて返信", exact: true })
        .count()) === 1,
      "open-request-control-explains-reply-action",
    );
    need(
      (await requestRow.innerText()).includes(
        "返信を送るまでリクエストは保留されます",
      ),
      "open-request-explains-reply-is-required",
    );
    checks.push("dm-request-open-and-query-back-remain-pending");

    await openRequest(page, REQUEST_TEXT);
    const input = page.getByRole("textbox", {
      name: "メッセージを入力...",
      exact: true,
    });
    const send = page.getByRole("button", { name: "送信", exact: true });
    await input.fill(REFUSAL_TEXT);
    const refusalPath = replyPath;
    let refusedRequests = 0;
    const refuseOnlySend = async (route) => {
      const request = route.request();
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === refusalPath
      ) {
        refusedRequests++;
        const body = request.postDataJSON();
        need(
          body?.content === REFUSAL_TEXT,
          "scoped-refusal-matches-only-fixture-body",
        );
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "fixture unavailable" }),
        });
      }
      return route.fallback();
    };
    await page.route(`**${refusalPath}`, refuseOnlySend);
    const refusalResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === refusalPath &&
        response.request().method() === "POST",
      { timeout: TIMEOUT },
    );
    await send.click();
    const refusal = await refusalResponse;
    need(
      refusal.status() === 503 && refusedRequests === 1,
      "real-ui-send-refusal-is-single-fixed-503",
      `${refusal.status()}/${refusedRequests}`,
    );
    await page
      .getByText(
        "送信結果を確認できません。再送すると重複する可能性があります。履歴を確認してください。",
        { exact: true },
      )
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await input.inputValue()) === REFUSAL_TEXT && (await send.isEnabled()),
      "503-retains-reply-draft-and-enables-explicit-retry",
    );
    const afterRefusal = await requestState(
      worker,
      db,
      origin,
      rootCookie,
      root.actor.ap_id,
      persona.actor.ap_id,
    );
    requirePending(
      afterRefusal,
      persona.actor.ap_id,
      root.actor.ap_id,
      REQUEST_TEXT,
      "after-503",
    );
    need(
      uiPostAttempts.get(REFUSAL_TEXT) === 1,
      "503-reply-has-exactly-one-total-post-attempt",
      JSON.stringify(Object.fromEntries(uiPostAttempts)),
    );
    await page.unroute(`**${refusalPath}`, refuseOnlySend);
    const requestRefreshAfterRefusal = await backToList(page);
    const refusalList = await uiRequestState(
      page,
      persona.actor.name,
      REQUEST_TEXT,
    );
    need(
      refusalList.rowVisible &&
        refusalList.senderVisible &&
        refusalList.badge.includes("1"),
      "503-return-refreshes-pending-row-and-badge",
      JSON.stringify({
        ui: refusalList,
        refreshResponse: requestRefreshAfterRefusal,
        api: {
          pending: afterRefusal.request !== null,
          requestCount: afterRefusal.requestCount,
        },
        native: {
          rows: afterRefusal.rows.length,
          inbox: afterRefusal.inbox.length,
        },
      }),
    );
    need(
      requestRefreshAfterRefusal?.status === 200 &&
        /^[a-f0-9]{64}$/.test(requestRefreshAfterRefusal.bodySha256),
      "503-return-real-native-request-get-captured",
      JSON.stringify(requestRefreshAfterRefusal),
    );
    need(refusedRequests === 1, "503-path-has-no-automatic-retry");
    checks.push(
      "dm-request-send-refusal-preserves-draft-pending-row-and-badge",
    );

    await openRequest(page, REQUEST_TEXT);
    const replyInput = page.getByRole("textbox", {
      name: "メッセージを入力...",
      exact: true,
    });
    const replySend = page.getByRole("button", { name: "送信", exact: true });
    const pendingBeforeReply = await pendingRowsSnapshot(
      db,
      persona.actor.ap_id,
      root.actor.ap_id,
    );
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.__dmContactsReadbacks = [];
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const requestUrl = new URL(
          typeof args[0] === "string" ? args[0] : args[0].url,
          location.href,
        );
        const method =
          typeof args[1]?.method === "string"
            ? args[1].method.toUpperCase()
            : "GET";
        if (requestUrl.pathname === "/api/dm/contacts" && method === "GET") {
          try {
            const body = await response.clone().json();
            window.__dmContactsReadbacks.push({
              status: response.status,
              requestCount: body.request_count,
            });
          } catch {
            window.__dmContactsReadbacks.push({
              status: response.status,
              requestCount: null,
            });
          }
        }
        return response;
      };
    });
    const contactsReadStart = await page.evaluate(
      () => window.__dmContactsReadbacks.length,
    );
    const staleCaptured = deferred();
    const staleRelease = deferred();
    const staleDelivered = deferred();
    heldReleases.push(staleRelease);
    let heldContacts = null;
    let heldRequest = null;
    let contactsGets = 0;
    let holdReturnContacts = false;
    const returnContactsRelease = deferred();
    heldReleases.push(returnContactsRelease);
    const contactsRoute = async (route) => {
      const request = route.request();
      if (
        new URL(request.url()).pathname !== "/api/dm/contacts" ||
        request.method() !== "GET"
      )
        return route.fallback();
      contactsGets++;
      // Back must not repair an obsolete badge before the assertion below.
      if (holdReturnContacts) {
        await bounded(returnContactsRelease.promise, "return-contacts-release");
        return route.fallback();
      }
      if (contactsGets !== 1) return route.fallback();
      heldRequest = request;
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: TIMEOUT,
        });
        const bytes = await response.body();
        const body = JSON.parse(bytes.toString("utf8"));
        need(
          response.status() === 200 && body.request_count === 1,
          "held-old-contacts-is-native-pending-snapshot",
          JSON.stringify({
            status: response.status(),
            requestCount: body.request_count,
          }),
        );
        heldContacts = {
          status: response.status(),
          requestCount: body.request_count,
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
        };
        staleCaptured.resolve();
        await bounded(staleRelease.promise, "held-stale-contacts-release");
        await route.fulfill({ response, body: bytes });
        staleDelivered.resolve();
      } catch (error) {
        staleCaptured.reject(error);
        staleDelivered.reject(error);
        await route.abort().catch(() => {});
      }
    };
    await page.route("**/api/dm/contacts", contactsRoute);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await bounded(
      staleCaptured.promise,
      "real-stale-contacts-response-captured",
    );
    const staleRequestFinished = page.waitForEvent("requestfinished", {
      predicate: (request) => request === heldRequest,
      timeout: TIMEOUT,
    });
    const replyResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === replyPath &&
        response.request().method() === "POST",
      { timeout: TIMEOUT },
    );
    const freshContactsPromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/dm/contacts" &&
        response.request().method() === "GET",
      { timeout: TIMEOUT },
    );
    await replyInput.fill(REPLY_TEXT);
    await replySend.click();
    const replyAck = await replyResponse;
    need(
      replyAck.status() === 201,
      "real-ui-reply-acknowledged-201",
      `${replyAck.status()}`,
    );
    need(
      uiPostAttempts.get(REPLY_TEXT) === 1,
      "successful-reply-has-one-ui-post-attempt",
      JSON.stringify(Object.fromEntries(uiPostAttempts)),
    );
    const replyBody = await replyAck.json();
    const freshContactsResponse = await freshContactsPromise;
    need(
      freshContactsResponse.status() === 200,
      "reply-ack-fresh-contacts-read-200",
    );
    const freshContactsBytes = await freshContactsResponse.body();
    const freshContactsBody = JSON.parse(freshContactsBytes.toString("utf8"));
    need(
      freshContactsBody.request_count === 0,
      "reply-ack-fresh-contacts-read-count-zero",
      JSON.stringify(freshContactsBody),
    );
    await page.waitForFunction(
      ({ start }) =>
        window.__dmContactsReadbacks
          .slice(start)
          .some((read) => read.status === 200 && read.requestCount === 0),
      { start: contactsReadStart },
      { timeout: TIMEOUT },
    );
    staleRelease.resolve();
    await bounded(staleDelivered.promise, "stale-contacts-response-consumed");
    await bounded(staleRequestFinished, "old-native-contacts-request-finished");
    await page.waitForFunction(
      ({ start }) => {
        const reads = window.__dmContactsReadbacks.slice(start);
        const fresh = reads.findIndex(
          (read) => read.status === 200 && read.requestCount === 0,
        );
        return (
          fresh >= 0 &&
          reads
            .slice(fresh + 1)
            .some((read) => read.status === 200 && read.requestCount === 1)
        );
      },
      { start: contactsReadStart },
      { timeout: TIMEOUT },
    );
    const contactsConsumptionOrder = await page.evaluate(
      (start) => window.__dmContactsReadbacks.slice(start),
      contactsReadStart,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    need(
      replyBody.message?.content === REPLY_TEXT &&
        replyBody.message?.sender?.ap_id === root.actor.ap_id,
      "root-reply-response-correlated",
    );
    await page
      .getByText(REPLY_TEXT, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await replyInput.inputValue()) === "",
      "successful-reply-clears-composer-draft",
    );
    const afterReply = await requestState(
      worker,
      db,
      origin,
      rootCookie,
      root.actor.ap_id,
      persona.actor.ap_id,
    );
    need(
      !afterReply.request && afterReply.requestCount === 0,
      "real-reply-removes-request-and-count",
      JSON.stringify({
        pending: afterReply.request !== null,
        requestCount: afterReply.requestCount,
        nativeRows: afterReply.rows.length,
        inboxRows: afterReply.inbox.length,
      }),
    );
    const replyNote = await db
      .prepare(
        "SELECT ap_id, attributed_to, conversation, content, visibility, published FROM objects WHERE ap_id = ?",
      )
      .bind(replyBody.message.id)
      .first();
    need(
      replyNote?.ap_id === replyBody.message.id &&
        replyNote.attributed_to === root.actor.ap_id &&
        replyNote.conversation === pendingBeforeReply.rows[0]?.conversation &&
        replyNote.content === REPLY_TEXT &&
        replyNote.visibility === "direct",
      "native-root-reply-note-readback",
    );
    const recipient = await db
      .prepare(
        "SELECT recipient_ap_id, type FROM object_recipients WHERE object_ap_id = ?",
      )
      .bind(replyNote.ap_id)
      .first();
    need(
      recipient?.recipient_ap_id === persona.actor.ap_id &&
        recipient.type === "to",
      "native-reply-recipient-readback",
    );
    holdReturnContacts = true;
    const requestRefreshAfterReply = await backToList(page);
    // Absence while a skeleton hides the list is not successful resolution.
    await page
      .getByText("リクエストがありません", { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    const afterReplyUi = await uiRequestState(
      page,
      persona.actor.name,
      REQUEST_TEXT,
    );
    need(
      !afterReplyUi.rowVisible && afterReplyUi.badge.length === 0,
      "reply-and-immediate-back-hide-request-row-and-badge",
      JSON.stringify({
        ui: afterReplyUi,
        refreshResponse: requestRefreshAfterReply,
        api: { pending: false, requestCount: afterReply.requestCount },
        staleContacts: heldContacts,
        freshContacts: {
          status: freshContactsResponse.status(),
          requestCount: freshContactsBody.request_count,
          bodySha256: createHash("sha256")
            .update(freshContactsBytes)
            .digest("hex"),
        },
      }),
    );
    need(
      requestRefreshAfterReply?.status === 200 &&
        /^[a-f0-9]{64}$/.test(requestRefreshAfterReply.bodySha256),
      "reply-back-real-native-requests-get-captured",
      JSON.stringify(requestRefreshAfterReply),
    );
    returnContactsRelease.resolve();
    const immediateBackState = await requestState(
      worker,
      db,
      origin,
      rootCookie,
      root.actor.ap_id,
      persona.actor.ap_id,
    );
    need(
      !immediateBackState.request && immediateBackState.requestCount === 0,
      "immediate-query-back-api-request-count-zero",
      JSON.stringify({
        pending: immediateBackState.request !== null,
        requestCount: immediateBackState.requestCount,
        nativeRows: immediateBackState.rows.length,
        inboxRows: immediateBackState.inbox.length,
      }),
    );
    const allTab = page.getByRole("tab", { name: "すべて", exact: true });
    if ((await allTab.getAttribute("aria-selected")) !== "true")
      await allTab.click();
    await page
      .getByText(REPLY_TEXT, { exact: false })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    const contactBody = await readJSON(
      worker,
      origin,
      rootCookie,
      "/api/dm/contacts",
    );
    need(
      (contactBody.mutual_followers ?? []).some(
        (contact) => contact.ap_id === persona.actor.ap_id,
      ),
      "reply-creates-owner-visible-dm-contact",
    );
    const contactEntry = contactBody.mutual_followers.find(
      (contact) => contact.ap_id === persona.actor.ap_id,
    );
    need(
      (await page
        .getByText(contactEntry.name || contactEntry.preferred_username, {
          exact: true,
        })
        .count()) > 0,
      "reply-contact-visible-after-old-native-count-release",
    );
    const finalPending = await pendingRowsSnapshot(
      db,
      persona.actor.ap_id,
      root.actor.ap_id,
    );
    need(
      finalPending.rows.length === 2 &&
        finalPending.rows.some(
          (row) =>
            row.ap_id === incomingMessage.id &&
            row.attributed_to === persona.actor.ap_id,
        ) &&
        finalPending.rows.some(
          (row) =>
            row.ap_id === replyBody.message.id &&
            row.attributed_to === root.actor.ap_id,
        ),
      "native-request-and-reply-rows-preserved-after-resolution",
    );
    need(
      finalPending.inbox.length === 1,
      "native-original-request-inbox-preserved",
    );
    const finalActors = await db
      .prepare(
        "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
      )
      .all();
    const finalSessions = await db
      .prepare("SELECT id, member_id FROM sessions ORDER BY id")
      .all();
    need(
      JSON.stringify(finalActors.results ?? []) ===
        JSON.stringify(initialActors.results ?? []),
      "owner-persona-authority-rows-preserved",
    );
    need(
      JSON.stringify(finalSessions.results ?? []) ===
        JSON.stringify(initialSessions.results ?? []),
      "exact-root-session-rows-preserved",
    );
    await Promise.all(nativeGetTasks);
    need(
      nativeGetResponses.length >= 4 &&
        nativeGetResponses.every(
          (item) => item.status === 200 && typeof item.bodySha256 === "string",
        ),
      "native-request-and-contact-get-bytes-captured",
      JSON.stringify(nativeGetResponses),
    );
    need(
      forbidden.length === 0,
      "no-obsolete-requests-accept-endpoint-calls",
      JSON.stringify(forbidden),
    );
    need(
      outboundBlocked === 0 && pageErrors.length === 0,
      "no-external-browser-requests-or-page-errors",
      JSON.stringify({ outboundBlocked, pageErrors }),
    );
    checks.push("dm-request-real-reply-removes-request-and-adds-contact");
    return {
      status: "PASSED",
      ownerApId: root.actor.ap_id,
      personaApId: persona.actor.ap_id,
      sessions: {
        root: rootSessionId,
        personaWasSwitched: true,
        finalOwnerSession: rootSessionId,
      },
      request: {
        incomingStatus: incoming.status,
        incomingId: incomingMessage.id,
        openedWithoutReplyPending: true,
        afterBackRow: true,
        afterBackBadge: 1,
      },
      refusedReply: {
        status: refusal.status(),
        attempts: refusedRequests,
        draftPreserved: true,
        requestPreserved: true,
        badge: 1,
      },
      successfulReply: {
        status: replyAck.status(),
        messageId: replyBody.message.id,
        requestCountAfterBack: immediateBackState.requestCount,
        contactVisible: true,
      },
      staleContactsRace: {
        held: heldContacts,
        freshStatus: freshContactsResponse.status(),
        freshRequestCount: freshContactsBody.request_count,
        freshBodySha256: createHash("sha256")
          .update(freshContactsBytes)
          .digest("hex"),
        consumptionOrder: contactsConsumptionOrder,
        oldResponseReleasedAndConsumed: true,
      },
      forbiddenAcceptRequests: forbidden.length,
      outboundBlocked,
      pageErrors,
      checks,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    for (const release of heldReleases) release.resolve();
    try {
      await context.close();
    } catch (error) {
      if (!primaryError) throw error;
    }
  }
}
