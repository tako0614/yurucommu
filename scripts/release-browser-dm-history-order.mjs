// Native Chrome regression for out-of-order DM history reads. The delayed
// snapshots below always come from the disposable local Worker via route.fetch.

import { createHash, randomUUID } from "node:crypto";

const TIMEOUT = 20_000;
const POLL_TIMEOUT = 45_000;

function need(condition, label, detail = "") {
  if (!condition) {
    throw new Error(
      `browser-dm-history-order:${label}${detail ? ` ${detail}` : ""}`,
    );
  }
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

async function bounded(promise, label, timeout = TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`browser-dm-history-order:${label}-timeout`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cookieFrom(response) {
  const header = response.headers.get("set-cookie") ?? "";
  return /(?:^|,\s*)session=([^;,]+)/i.exec(header)?.[1] ?? null;
}

function exactSessionId(salt, cookie) {
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

async function createActors({ worker, db, origin, password, sessionSalt }) {
  const [actors, sessions] = await Promise.all([
    db.prepare("SELECT ap_id FROM actors").all(),
    db.prepare("SELECT id FROM sessions").all(),
  ]);
  need(
    (actors.results ?? []).length === 0 &&
      (sessions.results ?? []).length === 0,
    "fresh-native-store-has-no-actor-or-session-seeds",
  );
  const login = await worker.dispatchFetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  need(login.status === 200, "public-password-creates-root", `${login.status}`);
  let rootCookie = cookieFrom(login);
  need(rootCookie, "root-session-cookie-issued");
  const rootMe = await workerRequest(
    worker,
    origin,
    rootCookie,
    "/api/auth/me",
  );
  const rootActor = (await rootMe.json()).actor;
  need(
    rootMe.status === 200 &&
      rootActor?.role === "owner" &&
      rootActor.ap_id === `${origin}/ap/users/tako`,
    "one-public-password-created-root-owner",
  );
  const rootRow = await db
    .prepare(
      "SELECT ap_id, role, owner_actor_ap_id FROM actors WHERE ap_id = ?",
    )
    .bind(rootActor.ap_id)
    .first();
  need(
    rootRow?.role === "owner" && rootRow.owner_actor_ap_id == null,
    "root-native-owner-readback",
  );
  const rootSessionId = exactSessionId(sessionSalt, rootCookie);
  const rootSession = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(rootSessionId)
    .first();
  need(
    rootSession?.id === rootSessionId &&
      rootSession.member_id === rootActor.ap_id,
    "exact-salted-root-session-readback",
  );

  const username = `dm_order_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
  const accountResponse = await workerRequest(
    worker,
    origin,
    rootCookie,
    "/api/auth/accounts",
    "POST",
    { username, name: "DM History Order Persona" },
  );
  need(
    accountResponse.status === 201 || accountResponse.status === 200,
    "public-accounts-api-creates-linked-persona",
    `${accountResponse.status}`,
  );
  const persona = (await accountResponse.json()).account;
  need(
    persona?.ap_id === `${origin}/ap/users/${username}`,
    "public-persona-response-id",
  );
  const personaSwitch = await workerRequest(
    worker,
    origin,
    rootCookie,
    "/api/auth/switch",
    "POST",
    { ap_id: persona.ap_id },
  );
  need(personaSwitch.status === 200, "public-session-switch-to-persona");
  const firstPersonaCookie = cookieFrom(personaSwitch);
  need(firstPersonaCookie, "persona-session-cookie-issued");
  const firstPersonaSessionId = exactSessionId(sessionSalt, firstPersonaCookie);
  const firstPersonaSession = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(firstPersonaSessionId)
    .first();
  need(
    firstPersonaSession?.id === firstPersonaSessionId &&
      firstPersonaSession.member_id === persona.ap_id,
    "exact-salted-persona-session-readback",
  );
  const personaRow = await db
    .prepare("SELECT role, owner_actor_ap_id FROM actors WHERE ap_id = ?")
    .bind(persona.ap_id)
    .first();
  need(
    personaRow?.role === "member" &&
      personaRow.owner_actor_ap_id === rootActor.ap_id,
    "api-created-persona-links-to-root-owner",
  );
  const backToRoot = await workerRequest(
    worker,
    origin,
    firstPersonaCookie,
    "/api/auth/switch",
    "POST",
    { ap_id: rootActor.ap_id },
  );
  need(backToRoot.status === 200, "public-session-switch-back-to-root");
  rootCookie = cookieFrom(backToRoot);
  need(rootCookie, "rotated-root-session-cookie-issued");
  const finalSessionId = exactSessionId(sessionSalt, rootCookie);
  const finalSession = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(finalSessionId)
    .first();
  need(
    finalSession?.id === finalSessionId &&
      finalSession.member_id === rootActor.ap_id,
    "exact-salted-root-session-restored",
  );
  const secondLogin = await worker.dispatchFetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  need(
    secondLogin.status === 200,
    "second-public-login-keeps-root-session",
    `${secondLogin.status}`,
  );
  const secondCookie = cookieFrom(secondLogin);
  need(secondCookie, "second-public-session-cookie-issued");
  const secondRootSessionId = exactSessionId(sessionSalt, secondCookie);
  const secondRootSession = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(secondRootSessionId)
    .first();
  need(
    secondRootSession?.id === secondRootSessionId &&
      secondRootSession.member_id === rootActor.ap_id,
    "second-exact-salted-session-is-same-root-owner",
  );
  const switchPersona = await workerRequest(
    worker,
    origin,
    secondCookie,
    "/api/auth/switch",
    "POST",
    { ap_id: persona.ap_id },
  );
  need(
    switchPersona.status === 200,
    "second-public-session-switches-to-linked-persona",
  );
  const personaCookie = cookieFrom(switchPersona);
  need(personaCookie, "second-session-persona-cookie-issued");
  const personaSessionId = exactSessionId(sessionSalt, personaCookie);
  const secondPersonaSession = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(personaSessionId)
    .first();
  need(
    secondPersonaSession?.id === personaSessionId &&
      secondPersonaSession.member_id === persona.ap_id,
    "second-exact-salted-session-is-linked-persona",
  );
  const actorRows = await db
    .prepare("SELECT ap_id, role, owner_actor_ap_id FROM actors ORDER BY ap_id")
    .all();
  const sessionRows = await db
    .prepare("SELECT id, member_id FROM sessions ORDER BY id")
    .all();
  need(
    (actorRows.results ?? []).length === 2 &&
      actorRows.results.some(
        (row) =>
          row.ap_id === rootActor.ap_id &&
          row.role === "owner" &&
          row.owner_actor_ap_id == null,
      ) &&
      actorRows.results.some(
        (row) =>
          row.ap_id === persona.ap_id &&
          row.role === "member" &&
          row.owner_actor_ap_id === rootActor.ap_id,
      ),
    "exact-root-and-linked-persona-actor-snapshot",
  );
  need(
    (sessionRows.results ?? []).length === 2 &&
      sessionRows.results.some(
        (row) => row.id === finalSessionId && row.member_id === rootActor.ap_id,
      ) &&
      sessionRows.results.some(
        (row) => row.id === personaSessionId && row.member_id === persona.ap_id,
      ),
    "exact-two-public-session-snapshot",
  );
  return {
    rootActor,
    rootCookie,
    persona,
    personaCookie,
    rootSessionId: finalSessionId,
    personaSessionId,
    authoritySnapshot: JSON.stringify({
      actors: actorRows.results,
      sessions: sessionRows.results,
    }),
  };
}

async function sendIncoming({ worker, db, origin, auth, text, sessionSalt }) {
  const personaCookie = auth.personaCookie;
  const personaId = auth.personaSessionId;
  const personaSession = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(personaId)
    .first();
  need(
    personaSession?.id === personaId &&
      personaSession.member_id === auth.persona.ap_id,
    "exact-salted-persona-session-for-incoming-dm",
  );
  const path = `/api/dm/user/${encodeURIComponent(auth.rootActor.ap_id)}/messages`;
  const response = await workerRequest(
    worker,
    origin,
    personaCookie,
    path,
    "POST",
    { content: text },
  );
  const body = await response.json().catch(() => null);
  need(
    response.status === 201 &&
      body?.message?.content === text &&
      body.message.sender?.ap_id === auth.persona.ap_id &&
      typeof body.message.id === "string",
    "public-persona-incoming-dm-post-201",
    `${response.status}`,
  );
  const currentRoot = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(auth.rootSessionId)
    .first();
  need(
    currentRoot?.id === auth.rootSessionId &&
      currentRoot.member_id === auth.rootActor.ap_id,
    "root-session-still-valid-after-incoming-dm",
  );
  return { id: body.message.id, text, status: response.status, path };
}

async function publicReverseHandshake({ worker, db, origin, auth }) {
  const openingText = `dm-history-public-opening-${randomUUID()}`;
  const replyText = `dm-history-public-reply-${randomUUID()}`;
  const incoming = await sendIncoming({
    worker,
    db,
    origin,
    auth,
    text: openingText,
  });
  const replyPath = `/api/dm/user/${encodeURIComponent(auth.persona.ap_id)}/messages`;
  const reply = await workerRequest(
    worker,
    origin,
    auth.rootCookie,
    replyPath,
    "POST",
    { content: replyText },
  );
  const replyBody = await reply.json().catch(() => null);
  need(
    reply.status === 201 &&
      replyBody?.message?.content === replyText &&
      replyBody.message.sender?.ap_id === auth.rootActor.ap_id,
    "public-root-reverse-dm-handshake-201",
    `${reply.status}`,
  );
  const rows = await db
    .prepare(
      "SELECT o.ap_id, o.attributed_to, o.conversation, o.content, o.visibility, r.recipient_ap_id, r.type FROM objects o LEFT JOIN object_recipients r ON r.object_ap_id = o.ap_id WHERE o.ap_id IN (?, ?) ORDER BY o.published, o.ap_id",
    )
    .bind(incoming.id, replyBody.message.id)
    .all();
  const byId = new Map((rows.results ?? []).map((row) => [row.ap_id, row]));
  const incomingRow = byId.get(incoming.id);
  const replyRow = byId.get(replyBody.message.id);
  need(
    (rows.results ?? []).length === 2 &&
      incomingRow?.attributed_to === auth.persona.ap_id &&
      incomingRow.recipient_ap_id === auth.rootActor.ap_id &&
      incomingRow.type === "to" &&
      incomingRow.content === openingText &&
      incomingRow.visibility === "direct" &&
      replyRow?.attributed_to === auth.rootActor.ap_id &&
      replyRow.recipient_ap_id === auth.persona.ap_id &&
      replyRow.type === "to" &&
      replyRow.content === replyText &&
      replyRow.visibility === "direct" &&
      replyRow.conversation === incomingRow.conversation,
    "public-reverse-handshake-native-note-sender-recipient-readback",
    JSON.stringify({ incomingRow, replyRow }),
  );
  return {
    incoming: { id: incoming.id, text: openingText },
    reply: { id: replyBody.message.id, text: replyText },
    conversation: incomingRow.conversation,
  };
}

async function verifyAuthCapacity(worker, origin, rootCookie, actorApId) {
  const read = () => workerRequest(worker, origin, rootCookie, "/api/auth/me");
  let response = await read();
  const evidence = { initialStatus: response.status, retried: false };
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    need(
      /^\d+$/.test(retryAfter ?? "") &&
        Number(retryAfter) >= 1 &&
        Number(retryAfter) <= 60,
      "public-auth-capacity-retry-after-is-bounded-to-60-seconds",
      `${retryAfter}`,
    );
    evidence.retryAfterSeconds = Number(retryAfter);
    await new Promise((resolve) =>
      setTimeout(resolve, Number(retryAfter) * 1000),
    );
    response = await read();
    evidence.retried = true;
  }
  need(
    response.status === 200,
    "public-auth-capacity-readback-200",
    `${response.status}`,
  );
  const body = await response.json();
  need(
    body.actor?.ap_id === actorApId,
    "public-auth-capacity-readback-root-identity",
  );
  const limit = Number(response.headers.get("x-ratelimit-limit"));
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const resetAt = Number(response.headers.get("x-ratelimit-reset"));
  need(
    limit === 20 &&
      Number.isFinite(remaining) &&
      remaining >= 0 &&
      Number.isFinite(resetAt) &&
      resetAt > 0,
    "public-auth-capacity-has-limit-20-and-reset-headers",
    JSON.stringify({ limit, remaining, resetAt }),
  );
  evidence.headers = { limit, remaining, resetAt };
  const waitMs = Math.max(0, resetAt * 1_000 - Date.now() + 10);
  if (remaining <= 3 && waitMs > 0) {
    need(
      waitMs <= 60_000,
      "public-auth-capacity-reset-window-at-most-60-seconds",
      `${waitMs}`,
    );
    evidence.resetWaitMs = waitMs;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const afterReset = await read();
    evidence.resetStatus = afterReset.status;
    need(
      afterReset.status === 200,
      "public-auth-capacity-reset-readback-200",
      `${afterReset.status}`,
    );
    const resetBody = await afterReset.json();
    need(
      resetBody.actor?.ap_id === actorApId,
      "public-auth-capacity-reset-preserves-root-identity",
    );
  }
  return evidence;
}

async function verifyDMCapacity(worker, origin, rootCookie, actorApId) {
  const response = await workerRequest(
    worker,
    origin,
    rootCookie,
    "/api/dm/contacts",
  );
  need(
    response.status === 200,
    "public-dm-capacity-readback-200",
    `${response.status}`,
  );
  const body = await response.json();
  need(
    body.actor?.ap_id === undefined || body.actor.ap_id === actorApId,
    "dm-capacity-does-not-change-root-identity",
  );
  const limit = Number(response.headers.get("x-ratelimit-limit"));
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const resetAt = Number(response.headers.get("x-ratelimit-reset"));
  need(
    limit === 600 &&
      Number.isFinite(remaining) &&
      remaining >= 0 &&
      Number.isFinite(resetAt) &&
      resetAt > 0,
    "public-dm-capacity-has-limit-600-and-reset-headers",
    JSON.stringify({ limit, remaining, resetAt }),
  );
  const waitMs = Math.max(0, resetAt * 1_000 - Date.now() + 10);
  if (remaining < 80 && waitMs > 0) {
    need(
      waitMs <= 60_000,
      "public-dm-capacity-reset-window-at-most-60-seconds",
      `${waitMs}`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const reset = await workerRequest(
      worker,
      origin,
      rootCookie,
      "/api/dm/contacts",
    );
    need(
      reset.status === 200,
      "public-dm-capacity-reset-readback-200",
      `${reset.status}`,
    );
    const resetRemaining = Number(reset.headers.get("x-ratelimit-remaining"));
    need(
      resetRemaining > remaining,
      "public-dm-capacity-reset-increases-remaining",
      `${remaining}->${resetRemaining}`,
    );
  }
  return {
    limit,
    remaining,
    resetAt,
    waitMs: waitMs && remaining < 80 ? waitMs : 0,
  };
}

async function respectDMBudgetBetweenWrites(worker, origin, rootCookie) {
  const response = await workerRequest(
    worker,
    origin,
    rootCookie,
    "/api/dm/contacts",
  );
  need(
    response.status === 200,
    "dm-write-budget-readback-200",
    `${response.status}`,
  );
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const resetAt = Number(response.headers.get("x-ratelimit-reset"));
  need(
    Number.isFinite(remaining) &&
      remaining >= 0 &&
      Number.isFinite(resetAt) &&
      resetAt > 0,
    "dm-write-budget-has-public-remaining-and-reset",
  );
  if (remaining <= 2) {
    const waitMs = Math.max(0, resetAt * 1_000 - Date.now() + 10);
    need(
      waitMs <= 60_000,
      "dm-write-budget-reset-window-at-most-60-seconds",
      `${waitMs}`,
    );
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const reset = await workerRequest(
      worker,
      origin,
      rootCookie,
      "/api/dm/contacts",
    );
    need(
      reset.status === 200 &&
        Number(reset.headers.get("x-ratelimit-remaining")) > remaining,
      "dm-write-budget-reset-restores-public-capacity",
      `${reset.status}`,
    );
    return { remaining, resetAt, waitMs };
  }
  return { remaining, resetAt, waitMs: 0 };
}

async function waitForNextPublicationSecond() {
  const current = Math.floor(Date.now() / 1_000);
  const deadline = Date.now() + 1_500;
  while (Math.floor(Date.now() / 1_000) === current && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  need(
    Math.floor(Date.now() / 1_000) > current,
    "paging-poll-message-has-a-distinct-later-publication-second",
  );
}

async function newPage(browser, origin, rootCookie) {
  const parsed = new URL(origin);
  const context = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 1000, height: 850 },
    serviceWorkers: "block",
  });
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
  await context.addInitScript(() => {
    const probe = (window.__dmHistoryOrderProbe = { consumed: [] });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const requestUrl = new URL(
        typeof args[0] === "string" ? args[0] : args[0].url,
        location.href,
      );
      const isHistoryRead =
        requestUrl.pathname.startsWith("/api/dm/user/") &&
        requestUrl.pathname.endsWith("/messages") &&
        (args[1]?.method ?? "GET").toUpperCase() === "GET";
      let record;
      if (isHistoryRead) {
        record = {
          url: requestUrl.href,
          status: null,
          done: false,
          networkError: false,
          jsonStarted: false,
          jsonDone: false,
          cloneBodyDone: false,
        };
        probe.consumed.push(record);
      }
      try {
        const response = await originalFetch(...args);
        if (record) {
          record.status = response.status;
          const originalJson = response.json.bind(response);
          response.json = async (...jsonArgs) => {
            record.jsonStarted = true;
            try {
              return await originalJson(...jsonArgs);
            } finally {
              record.jsonDone = true;
              record.done = true;
            }
          };
          void response
            .clone()
            .arrayBuffer()
            .then(() => {
              record.cloneBodyDone = true;
            })
            .catch(() => {
              record.cloneBodyDone = true;
            });
        }
        return response;
      } catch (error) {
        if (record) {
          record.networkError = true;
          record.done = true;
        }
        throw error;
      }
    };
  });
  let outboundBlocked = 0;
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
  return { context, page, pageErrors, outboundBlocked: () => outboundBlocked };
}

function historyPath(personaApId) {
  return `/api/dm/user/${encodeURIComponent(personaApId)}/messages`;
}

async function enterConversation(page, origin, personaApId) {
  await page.goto(`${origin}/dm?c=${encodeURIComponent(personaApId)}`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  await page
    .getByRole("textbox", { name: "メッセージを入力...", exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  await page.getByRole("log").waitFor({ state: "visible", timeout: TIMEOUT });
}

function holdHistoryReads(page, origin, pathname, policy) {
  const ready = gate("initial-native-history-ready");
  const release = gate("initial-native-history-release");
  const completed = gate("initial-native-history-completed");
  const pollReady = gate("newer-native-poll-ready");
  const failureReady = gate("post-poll-browser-network-failure-ready");
  const unexpected = [];
  const held = [];
  let count = 0;
  const handler = async (route) => {
    const request = route.request();
    if (
      new URL(request.url()).origin !== origin ||
      new URL(request.url()).pathname !== pathname ||
      request.method() !== "GET"
    ) {
      await route.fallback();
      return;
    }
    count++;
    const index = count;
    if (index > policy.maxSuccessReads) {
      const failure = { index, method: request.method(), forwarded: false };
      if (policy.failAt !== null && index >= policy.failAt) {
        failureReady.resolve(failure);
      } else {
        unexpected.push(
          `unexpected-extra-history-read:${JSON.stringify(failure)}`,
        );
      }
      try {
        await route.abort("failed");
      } catch (error) {
        unexpected.push(`network-failure-abort:${String(error)}`);
      }
      return;
    }
    try {
      const response = await route.fetch({
        maxRedirects: 0,
        maxRetries: 0,
        timeout: TIMEOUT,
      });
      const bytes = await response.body();
      const body = JSON.parse(bytes.toString("utf8"));
      const snapshot = {
        index,
        status: response.status(),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        body,
        ids: (body.messages ?? []).map((message) => message.id),
        contents: (body.messages ?? []).map((message) => message.content),
        createdAts: (body.messages ?? []).map((message) => message.created_at),
      };
      if (index === 1) {
        held.push(snapshot);
        ready.resolve(snapshot);
        await release.promise;
        if (policy.abortInitialAfterPoll) {
          await route.abort("failed");
          failureReady.resolve({
            index,
            method: request.method(),
            forwarded: true,
            workerStatus: snapshot.status,
            browserDelivery: "aborted-after-worker-response",
          });
        } else {
          await route.fulfill({ response, body: bytes });
          completed.resolve(snapshot);
        }
      } else if (index === 2) {
        held.push(snapshot);
        pollReady.resolve(snapshot);
        await route.fulfill({ response, body: bytes });
      } else {
        await route.fulfill({ response, body: bytes });
      }
    } catch (error) {
      unexpected.push(`route-${index}:${String(error)}`);
      if (index === 1) ready.reject(error);
      if (index === 2) pollReady.reject(error);
      try {
        await route.abort("failed");
      } catch {}
    }
  };
  const escaped = `${origin}${pathname}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const installed = page.route(new RegExp(`^${escaped}(?:\\?.*)?$`), handler);
  return {
    installed,
    ready,
    release,
    completed,
    pollReady,
    failureReady,
    unexpected,
    held,
    count: () => count,
  };
}

async function waitConsumed(page, count) {
  await page.waitForFunction(
    (minimum) => {
      const reads = window.__dmHistoryOrderProbe?.consumed ?? [];
      return (
        reads.length >= minimum &&
        reads
          .slice(0, minimum)
          .every((read) => read.jsonDone || read.networkError)
      );
    },
    count,
    { timeout: TIMEOUT },
  );
  return page.evaluate(
    (minimum) => window.__dmHistoryOrderProbe.consumed.slice(0, minimum),
    count,
  );
}

async function waitConsumedAt(page, index) {
  await page.waitForFunction(
    (position) => {
      const read = window.__dmHistoryOrderProbe?.consumed?.[position];
      return read?.jsonDone === true || read?.networkError === true;
    },
    index,
    { timeout: TIMEOUT },
  );
  return page.evaluate(
    (position) => window.__dmHistoryOrderProbe.consumed[position],
    index,
  );
}

async function uiSnapshot(page, text) {
  const input = page.getByRole("textbox", {
    name: "メッセージを入力...",
    exact: true,
  });
  return {
    bubbleCount: await page.getByText(text, { exact: true }).count(),
    visible: await page
      .getByText(text, { exact: true })
      .first()
      .isVisible()
      .catch(() => false),
    loadingVisible: await page
      .getByRole("log")
      .getByText(/^読み込み中/)
      .isVisible()
      .catch(() => false),
    alertCount: await page.locator("form").getByRole("alert").count(),
    alertTexts: await page.locator("form").getByRole("alert").allTextContents(),
    globalAlertCount: await page.getByRole("alert").count(),
    inputValue: await input.inputValue(),
  };
}

async function runCase({ browser, worker, db, origin, auth, checks, kind }) {
  // Each case gets its own native Worker-backed message fixture. The same
  // public root/persona identities and session authority are reused.
  const incomingText = `dm-history-${kind}-incoming-${randomUUID()}`;
  const incoming = await sendIncoming({
    worker,
    db,
    origin,
    auth,
    text: incomingText,
    sessionSalt: auth.sessionSalt,
  });
  const { context, page, pageErrors, outboundBlocked } = await newPage(
    browser,
    origin,
    auth.rootCookie,
  );
  const endpoint = historyPath(auth.persona.ap_id);
  const reads = holdHistoryReads(page, origin, endpoint, {
    failAt: null,
    maxSuccessReads: 2,
    abortInitialAfterPoll: kind === "poll-failure",
  });
  let error;
  try {
    // Open the controlled conversation only after its native GET route is
    // installed, making its first matching request the initial history load.
    await enterConversation(page, origin, auth.persona.ap_id);
    const old = await bounded(reads.ready.promise, `${kind}-initial-snapshot`);
    need(
      old.status === 200,
      `${kind}-initial-history-get-200`,
      `${old.status}`,
    );
    need(
      old.contents.includes(incomingText),
      `${kind}-initial-snapshot-contains-opening-native-dm`,
      JSON.stringify({ contents: old.contents, incomingText }),
    );

    if (kind === "initial-vs-poll") {
      // The opening message above is already in old history. Add a distinct
      // public incoming DM while that exact response is held; wait for the
      // application's regular four-second poll to consume the newer snapshot.
      const newerText = `dm-history-newer-${randomUUID()}`;
      const newer = await sendIncoming({
        worker,
        db,
        origin,
        auth,
        text: newerText,
        sessionSalt: auth.sessionSalt,
      });
      need(
        !old.contents.includes(newerText),
        "initial-native-response-predates-injected-public-dm",
        JSON.stringify({ old: old.contents, newerText }),
      );
      const poll = await bounded(
        reads.pollReady.promise,
        "newer-four-second-poll",
        POLL_TIMEOUT,
      );
      need(
        poll.status === 200 && poll.contents.includes(newerText),
        "poll-snapshot-is-real-newer-worker-history-200",
        JSON.stringify({
          status: poll.status,
          contents: poll.contents,
          newerText,
        }),
      );
      const pollConsumed = await waitConsumedAt(page, 1);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const beforeOldRelease = await uiSnapshot(page, newerText);
      need(
        beforeOldRelease.visible &&
          beforeOldRelease.bubbleCount === 1 &&
          !beforeOldRelease.loadingVisible,
        "successful-poll-shows-new-message-before-old-initial-release",
        JSON.stringify({
          initial: {
            status: old.status,
            sha256: old.sha256,
            ids: old.ids,
            contents: old.contents,
          },
          poll: {
            status: poll.status,
            sha256: poll.sha256,
            ids: poll.ids,
            contents: poll.contents,
          },
          pollConsumed,
          ui: beforeOldRelease,
        }),
      );
      reads.release.resolve();
      const oldConsumed = await bounded(
        reads.completed.promise,
        "old-initial-response-delivered",
      );
      const consumed = await waitConsumed(page, 2);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const afterOldRelease = await uiSnapshot(page, newerText);
      need(
        afterOldRelease.visible &&
          afterOldRelease.bubbleCount === 1 &&
          !afterOldRelease.loadingVisible,
        "late-old-initial-response-cannot-replace-newer-poll-state",
        JSON.stringify({
          beforeOldRelease,
          afterOldRelease,
          oldHash: old.sha256,
          pollHash: poll.sha256,
        }),
      );
      checks.push(
        "browser-dm-history-old-initial-does-not-overwrite-newer-poll",
      );
      return {
        kind,
        initial: { status: old.status, sha256: old.sha256, ids: old.ids },
        poll: {
          status: poll.status,
          sha256: poll.sha256,
          ids: poll.ids,
          consumed: pollConsumed,
        },
        incoming: newer,
        oldDelivered: { sha256: oldConsumed.sha256, consumed: consumed[1] },
        ui: { beforeOldRelease, afterOldRelease },
        routeCount: reads.count(),
      };
    }

    if (kind === "poll-failure") {
      const newerText = `dm-history-failure-newer-${randomUUID()}`;
      const newer = await sendIncoming({
        worker,
        db,
        origin,
        auth,
        text: newerText,
        sessionSalt: auth.sessionSalt,
      });
      need(
        !old.contents.includes(newerText),
        "failure-case-old-initial-predates-incoming-dm",
      );
      const poll = await bounded(
        reads.pollReady.promise,
        "failure-case-newer-poll",
        POLL_TIMEOUT,
      );
      need(
        poll.status === 200 && poll.contents.includes(newerText),
        "failure-case-poll-first-succeeds-with-new-message",
      );
      await waitConsumedAt(page, 1);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const beforeInitialFailure = await uiSnapshot(page, newerText);
      need(
        beforeInitialFailure.visible &&
          beforeInitialFailure.bubbleCount === 1 &&
          !beforeInitialFailure.loadingVisible,
        "successful-poll-shows-message-before-initial-browser-failure",
        JSON.stringify(beforeInitialFailure),
      );
      reads.release.resolve();
      const failure = await bounded(
        reads.failureReady.promise,
        "held-successful-initial-browser-failure",
      );
      need(
        failure.index === 1 &&
          failure.forwarded &&
          failure.workerStatus === 200,
        "initial-worker-success-only-lost-during-browser-delivery",
        JSON.stringify(failure),
      );
      await waitConsumed(page, 2);
      await page.waitForTimeout(250);
      const duringFailure = await uiSnapshot(page, newerText);
      need(
        duringFailure.visible &&
          duringFailure.bubbleCount === 1 &&
          duringFailure.alertCount === 0 &&
          !duringFailure.loadingVisible,
        "late-initial-browser-failure-keeps-newer-poll-state-silent",
        JSON.stringify(duringFailure),
      );
      checks.push("browser-dm-history-late-initial-failure-keeps-newer-poll");
      return {
        kind,
        initial: { status: old.status, sha256: old.sha256, ids: old.ids },
        poll: { status: poll.status, sha256: poll.sha256, ids: poll.ids },
        incoming: newer,
        failure,
        ui: { beforeInitialFailure, duringFailure },
        routeCount: reads.count(),
      };
    }

    // The UI sends while the actual initial success response is held. Its 201
    // acknowledgement and optimistic bubble must survive that older snapshot.
    const input = page.getByRole("textbox", {
      name: "メッセージを入力...",
      exact: true,
    });
    const sendButton = page.getByRole("button", { name: "送信", exact: true });
    const sentText = `dm-history-ack-${randomUUID()}`;
    const sendPath = `/api/dm/user/${encodeURIComponent(auth.persona.ap_id)}/messages`;
    let sendAttempts = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === sendPath &&
        request.method() === "POST"
      )
        sendAttempts++;
    });
    const ackPromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === sendPath &&
        response.request().method() === "POST",
      { timeout: TIMEOUT },
    );
    await input.fill(sentText);
    await sendButton.click();
    const ack = await ackPromise;
    const ackBody = await ack.json();
    need(
      ack.status() === 201 &&
        ackBody.message?.content === sentText &&
        ackBody.message.sender?.ap_id === auth.rootActor.ap_id &&
        sendAttempts === 1,
      "real-ui-dm-post-acknowledges-201",
      `${ack.status()}`,
    );
    await page.waitForFunction(
      () =>
        document.querySelector('input[placeholder="メッセージを入力..."]')
          ?.value === "",
      { timeout: TIMEOUT },
    );
    const beforeOldRelease = await uiSnapshot(page, sentText);
    need(
      beforeOldRelease.visible &&
        beforeOldRelease.bubbleCount === 1 &&
        beforeOldRelease.inputValue === "" &&
        !beforeOldRelease.loadingVisible,
      "real-201-acknowledged-message-visible-while-initial-is-held",
      JSON.stringify(beforeOldRelease),
    );
    reads.release.resolve();
    const oldDelivered = await bounded(
      reads.completed.promise,
      "ack-case-initial-delivery",
    );
    await waitConsumed(page, 1);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const afterOldRelease = await uiSnapshot(page, sentText);
    need(
      afterOldRelease.visible &&
        afterOldRelease.bubbleCount === 1 &&
        afterOldRelease.inputValue === "" &&
        !afterOldRelease.loadingVisible,
      "late-initial-history-cannot-erase-acknowledged-ui-message",
      JSON.stringify({
        beforeOldRelease,
        afterOldRelease,
        oldHash: old.sha256,
      }),
    );
    checks.push("browser-dm-history-late-initial-keeps-acknowledged-message");
    return {
      kind,
      initial: { status: old.status, sha256: old.sha256, ids: old.ids },
      incoming,
      acknowledgement: {
        status: ack.status(),
        messageId: ackBody.message.id,
        text: sentText,
      },
      oldDelivered: { sha256: oldDelivered.sha256 },
      ui: { beforeOldRelease, afterOldRelease },
      routeCount: reads.count(),
    };
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    reads.release.resolve();
    try {
      await context.close();
    } catch (closeError) {
      if (!error) throw closeError;
    }
    need(outboundBlocked() === 0, `${kind}-no-browser-external-fetch`);
    need(
      pageErrors.length === 0,
      `${kind}-no-browser-page-errors`,
      JSON.stringify(pageErrors),
    );
    need(
      reads.unexpected.length === 0,
      `${kind}-all-held-worker-responses-settled`,
      JSON.stringify(reads.unexpected),
    );
  }
}

async function runPagingCase({ browser, worker, db, origin, auth, checks }) {
  const texts = Array.from(
    { length: 70 },
    (_, index) =>
      `dm-history-page-${String(index + 1).padStart(2, "0")}-${randomUUID()}`,
  );
  const created = [];
  for (const text of texts) {
    await respectDMBudgetBetweenWrites(worker, origin, auth.personaCookie);
    created.push(await sendIncoming({ worker, db, origin, auth, text }));
  }
  const fullPath = `${historyPath(auth.persona.ap_id)}?limit=100`;
  const fullResponse = await workerRequest(
    worker,
    origin,
    auth.rootCookie,
    fullPath,
  );
  need(
    fullResponse.status === 200,
    "paging-native-canonical-history-get-100-200",
    `${fullResponse.status}`,
  );
  const fullBody = await fullResponse.json();
  const expectedTexts = (fullBody.messages ?? []).map(
    (message) => message.content,
  );
  const expectedIds = (fullBody.messages ?? []).map((message) => message.id);
  need(
    expectedTexts.length >= 70 &&
      expectedTexts.length < 100 &&
      expectedIds.length === expectedTexts.length &&
      texts.every((text) => expectedTexts.includes(text)),
    "paging-canonical-native-history-contains-all-70-public-dms",
    JSON.stringify({ count: expectedTexts.length }),
  );
  const nativeRows = await db
    .prepare(
      `SELECT o.ap_id, o.attributed_to, o.content, o.visibility, r.recipient_ap_id, r.type
       FROM objects o JOIN object_recipients r ON r.object_ap_id = o.ap_id
       WHERE o.ap_id IN (${created.map(() => "?").join(",")}) ORDER BY o.published DESC, o.ap_id DESC`,
    )
    .bind(...created.map((message) => message.id))
    .all();
  need(
    (nativeRows.results ?? []).length === 70 &&
      nativeRows.results.every(
        (row) =>
          row.attributed_to === auth.persona.ap_id &&
          row.recipient_ap_id === auth.rootActor.ap_id &&
          row.type === "to" &&
          row.visibility === "direct",
      ),
    "paging-70-native-notes-are-persona-direct-recipient-rows",
    JSON.stringify({
      count: nativeRows.results?.length,
      example: nativeRows.results?.[0],
    }),
  );
  const { context, page, pageErrors, outboundBlocked } = await newPage(
    browser,
    origin,
    auth.rootCookie,
  );
  const endpoint = historyPath(auth.persona.ap_id);
  const pages = [];
  const pollObserved = gate("newest poll native snapshot captured");
  let pollTargetText = null;
  let targetProbeIndex = -1;
  let targetDelivered = false;
  let unexpected = [];
  const recordHistory = (route) => {
    const request = route.request();
    if (
      new URL(request.url()).origin !== origin ||
      new URL(request.url()).pathname !== endpoint ||
      request.method() !== "GET"
    )
      return route.fallback();
    if (targetDelivered) {
      unexpected.push(
        "history GET occurred after paging poll assertion window began",
      );
      return route.abort("failed");
    }
    const requestIndex = pages.length;
    return route
      .fetch({ maxRedirects: 0, maxRetries: 0, timeout: TIMEOUT })
      .then(async (response) => {
        const bytes = await response.body();
        const body = JSON.parse(bytes.toString("utf8"));
        const pageSnapshot = {
          requestUrl: request.url(),
          status: response.status(),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ids: (body.messages ?? []).map((message) => message.id),
          contents: (body.messages ?? []).map((message) => message.content),
          hasMore: body.has_more,
          createdAts: (body.messages ?? []).map(
            (message) => message.created_at,
          ),
          cursor: new URL(request.url()).searchParams.get("before"),
        };
        pages.push(pageSnapshot);
        if (pollTargetText && pageSnapshot.contents.includes(pollTargetText)) {
          targetProbeIndex = requestIndex;
          targetDelivered = true;
          pollObserved.resolve(pageSnapshot);
        }
        await route.fulfill({ response, body: bytes });
      })
      .catch(async (error) => {
        unexpected.push(String(error));
        await route.abort("failed").catch(() => {});
      });
  };
  const routePattern = `${origin}${endpoint}`.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  await page.route(new RegExp(`^${routePattern}(?:\\?.*)?$`), recordHistory);
  try {
    await enterConversation(page, origin, auth.persona.ap_id);
    await page
      .getByText(expectedTexts.at(-1), { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    const firstPage = pages.find((snapshot) => !snapshot.cursor);
    need(
      firstPage?.status === 200 &&
        firstPage.ids.length === 50 &&
        firstPage.hasMore === true &&
        firstPage.contents.join("\n") === expectedTexts.slice(-50).join("\n"),
      "paging-first-worker-page-is-50-newest-with-has-more",
      JSON.stringify(pages),
    );
    const firstUi = await page
      .getByRole("log")
      .locator("p.text-sm")
      .allTextContents();
    need(
      firstUi.length === 50 &&
        firstUi[49] === expectedTexts.at(-1) &&
        firstUi[0] === expectedTexts.at(-50),
      "paging-first-ui-page-is-oldest-to-newest-of-newest-50",
      JSON.stringify({
        first: firstUi[0],
        last: firstUi.at(-1),
        length: firstUi.length,
      }),
    );
    const loadOlder = page.getByRole("button", {
      name: "過去のメッセージを読み込む",
      exact: true,
    });
    await loadOlder.click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('[role="log"] p.text-sm').length === count,
      expectedTexts.length,
      { timeout: TIMEOUT },
    );
    const olderPage = pages.find((snapshot) => snapshot.cursor);
    need(
      olderPage?.status === 200 &&
        olderPage.ids.length === expectedTexts.length - 50 &&
        olderPage.hasMore === false &&
        olderPage.cursor === `${firstPage.createdAts[0]} ${firstPage.ids[0]}` &&
        olderPage.contents.join("\n") ===
          expectedTexts.slice(0, -50).join("\n"),
      "paging-load-older-uses-composite-cursor-and-returns-older-prefix",
      JSON.stringify(pages),
    );
    const allBeforePoll = await page
      .getByRole("log")
      .locator("p.text-sm")
      .allTextContents();
    need(
      allBeforePoll.length === expectedTexts.length &&
        allBeforePoll.join("\n") === expectedTexts.join("\n"),
      "paging-all-public-dms-have-exact-chronological-order",
      JSON.stringify({
        count: allBeforePoll.length,
        first: allBeforePoll[0],
        last: allBeforePoll.at(-1),
      }),
    );

    await waitForNextPublicationSecond();
    const newestText = `dm-history-page-newer-${randomUUID()}`;
    pollTargetText = newestText;
    const writeBudget = await respectDMBudgetBetweenWrites(
      worker,
      origin,
      auth.personaCookie,
    );
    const newest = await sendIncoming({
      worker,
      db,
      origin,
      auth,
      text: newestText,
    });
    const latestPoll = await bounded(
      pollObserved.promise,
      "paging-newest-poll-native-response",
      POLL_TIMEOUT,
    );
    need(
      latestPoll.status === 200 && latestPoll.contents.includes(newestText),
      "paging-newest-poll-is-real-worker-200-with-new-dm",
      JSON.stringify(latestPoll),
    );
    await waitConsumedAt(page, targetProbeIndex);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const afterPoll = await page
      .getByRole("log")
      .locator("p.text-sm")
      .allTextContents();
    need(
      afterPoll.length === expectedTexts.length + 1 &&
        afterPoll[0] === expectedTexts[0] &&
        afterPoll.at(-1) === newestText &&
        new Set(afterPoll).size === expectedTexts.length + 1 &&
        afterPoll.slice(0, -1).join("\n") === expectedTexts.join("\n"),
      "regular-poll-preserves-loaded-oldest-page-order-and-appends-newest-once",
      JSON.stringify({
        count: afterPoll.length,
        first: afterPoll[0],
        last: afterPoll.at(-1),
        unique: new Set(afterPoll).size,
      }),
    );
    need(
      latestPoll.status === 200 && latestPoll.contents.includes(newestText),
      "paging-poll-is-real-worker-200-containing-new-note",
      JSON.stringify(latestPoll),
    );
    checks.push("browser-dm-history-paging-poll-preserves-order-and-cursor");
    return {
      kind: "older-page-then-newest-poll",
      createdCount: created.length,
      pages,
      newest,
      writeBudget,
      uiCounts: {
        firstPage: firstUi.length,
        olderPage: olderPage.ids.length,
        allBeforePoll: allBeforePoll.length,
        afterPoll: afterPoll.length,
      },
      routeCount: pages.length,
    };
  } finally {
    await context.close();
    need(outboundBlocked() === 0, "paging-case-no-browser-external-fetch");
    need(
      pageErrors.length === 0,
      "paging-case-no-browser-page-errors",
      JSON.stringify(pageErrors),
    );
    need(
      unexpected.length === 0,
      "paging-case-worker-reads-all-settled",
      JSON.stringify(unexpected),
    );
  }
}

/** Qualify initial and regular-poll DM history order in a native browser. */
export async function qualifyDMHistoryOrder({
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
  const auth = await createActors({
    worker,
    db,
    origin,
    password,
    sessionSalt,
  });
  auth.sessionSalt = sessionSalt;
  const authCapacity = await verifyAuthCapacity(
    worker,
    origin,
    auth.rootCookie,
    auth.rootActor.ap_id,
  );
  const handshake = await publicReverseHandshake({ worker, db, origin, auth });
  const cases = [];
  for (const kind of ["initial-vs-poll", "poll-failure", "acknowledged-send"]) {
    const capacity = await verifyAuthCapacity(
      worker,
      origin,
      auth.rootCookie,
      auth.rootActor.ap_id,
    );
    cases.push(
      await runCase({ browser, worker, db, origin, auth, checks, kind }),
    );
    cases[cases.length - 1].authCapacity = capacity;
  }
  const capacity = await verifyDMCapacity(
    worker,
    origin,
    auth.rootCookie,
    auth.rootActor.ap_id,
  );
  const pagingCase = await runPagingCase({
    browser,
    worker,
    db,
    origin,
    auth,
    checks,
  });
  pagingCase.dmCapacity = capacity;
  cases.push(pagingCase);
  const [finalActors, finalSessions] = await Promise.all([
    db
      .prepare(
        "SELECT ap_id, role, owner_actor_ap_id FROM actors ORDER BY ap_id",
      )
      .all(),
    db.prepare("SELECT id, member_id FROM sessions ORDER BY id").all(),
  ]);
  const finalAuthority = JSON.stringify({
    actors: finalActors.results ?? [],
    sessions: finalSessions.results ?? [],
  });
  need(
    finalAuthority === auth.authoritySnapshot,
    "dm-history-fixtures-preserve-exact-actor-and-session-authority",
    JSON.stringify({
      before: JSON.parse(auth.authoritySnapshot),
      after: JSON.parse(finalAuthority),
    }),
  );
  checks.push("browser-dm-history-native-actor-session-authority-unchanged");
  return {
    kind: "yurucommu.dm-history-order@v1",
    status: "PASSED",
    checks,
    checkCount: checks.length,
    outboundBlocked: 0,
    pageErrors: [],
    ownerCount: 1,
    personaCount: 1,
    actorCount: 2,
    sessionCount: 2,
    authCapacity,
    handshake,
    scope: "same-owner local persona DMs; no remote delivery or retry claim",
    cases,
  };
}
