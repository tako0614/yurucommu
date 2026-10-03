import { createHash } from "node:crypto";
export { createSettingsSignoutIssuer } from "./release-browser-settings-signout.mjs";

const TIMEOUT = 15_000;
const SESSION_SALT = "settings-signout-session-salt";
const RETRY_COPY = "ログアウトできたか確認できません。もう一度お試しください。";

function need(ok, label) {
  if (!ok) throw new Error(`logout-outcome:${label}`);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function nativeSnapshot(db, expectedSessionId) {
  const counts = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE expires_at > datetime('now')",
    )
    .first();
  const session = await db
    .prepare("SELECT id, member_id, expires_at FROM sessions WHERE id = ?")
    .bind(expectedSessionId)
    .first();
  const owners = await db
    .prepare(
      "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
    )
    .all();
  return {
    liveSessionCount: Number(counts?.count ?? -1),
    session: session
      ? {
          id: session.id,
          memberId: session.member_id,
          expiresAt: session.expires_at,
        }
      : null,
    owners: owners.results ?? [],
  };
}

async function issueOwnerSession({ worker, db, origin, issuer, sessionSalt }) {
  const issued = await issuer.login(worker);
  const cookie = issued.value;
  const response = await worker.dispatchFetch(`${origin}/api/auth/me`, {
    headers: { cookie: `session=${cookie}` },
  });
  need(response.status === 200, "oidc-issued-cookie-authenticated");
  const actor = (await response.json()).actor;
  need(
    actor?.role === "owner" && typeof actor.ap_id === "string",
    "oidc-callback-created-owner",
  );
  const sessionId = `sha256:${sha(`${sessionSalt}:${cookie}`)}`;
  const seeded = await nativeSnapshot(db, sessionId);
  need(
    seeded.liveSessionCount === 1 &&
      seeded.session?.id === sessionId &&
      seeded.session.memberId === actor.ap_id,
    "exactly-one-live-salted-session",
  );
  need(
    seeded.owners.length === 1 &&
      seeded.owners[0].ap_id === actor.ap_id &&
      seeded.owners[0].role === "owner",
    "single-owner-row",
  );
  return {
    cookie,
    cookieAttributes: issued.cookieAttributes,
    actorApId: actor.ap_id,
    sessionId,
    seeded,
  };
}

async function readAuthResponse(response, actorApId) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return {
    status: response.status(),
    actorApId: body.actor?.ap_id ?? null,
    role: body.actor?.role ?? null,
    expected: body.actor?.ap_id === actorApId && body.actor?.role === "owner",
  };
}

function waitForBrowserAuth(page, origin) {
  const response = page.waitForResponse(
    (value) => {
      const url = new URL(value.url());
      return (
        value.request().method() === "GET" &&
        url.origin === origin &&
        url.pathname === "/api/auth/me"
      );
    },
    { timeout: TIMEOUT },
  );
  response.catch(() => {});
  return response;
}

async function browserAuth(page, actorApId) {
  return page.evaluate(async (expectedActor) => {
    const response = await fetch("/api/auth/me", { credentials: "include" });
    let body;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    return {
      status: response.status,
      actorApId: body.actor?.ap_id ?? null,
      role: body.actor?.role ?? null,
      expected:
        body.actor?.ap_id === expectedActor && body.actor?.role === "owner",
    };
  }, actorApId);
}

function watchPage(page, origin) {
  const observations = {
    logoutPosts: 0,
    fixed503s: 0,
    loginStarts: 0,
    callbacks: 0,
    authorize: 0,
    blockedOutbound: 0,
    pageErrors: 0,
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    if (request.method() === "POST" && url.pathname === "/api/auth/logout")
      observations.logoutPosts += 1;
    if (request.method() === "GET" && url.pathname === "/api/auth/login/takos")
      observations.loginStarts += 1;
    if (url.pathname === "/api/auth/callback/takos")
      observations.callbacks += 1;
  });
  page.on("pageerror", () => {
    observations.pageErrors += 1;
  });
  return observations;
}

async function createOwnerPage({
  browser,
  worker,
  db,
  origin,
  issuer,
  sessionSalt,
  path,
  lane,
}) {
  const seeded = await issueOwnerSession({
    worker,
    db,
    origin,
    issuer,
    sessionSalt,
  });
  const context = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const parsed = new URL(origin);
  await context.addCookies([
    {
      name: "session",
      value: seeded.cookie,
      domain: parsed.hostname,
      path: seeded.cookieAttributes.path,
      httpOnly: seeded.cookieAttributes.httpOnly,
      secure: seeded.cookieAttributes.secure,
      sameSite: seeded.cookieAttributes.sameSite,
    },
  ]);
  const page = await context.newPage();
  const observed = watchPage(page, origin);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (["data:", "blob:"].includes(url.protocol) || url.origin === origin)
      return route.continue();
    observed.blockedOutbound += 1;
    return route.abort("blockedbyclient");
  });
  let logoutAttempt = 0;
  let releaseFixed503;
  let fixed503Entered;
  const fixed503Gate = new Promise((resolve) => {
    releaseFixed503 = resolve;
  });
  const fixed503Request = new Promise((resolve) => {
    fixed503Entered = resolve;
  });
  let committedResponse = null;
  await page.route("**/api/auth/logout", async (route) => {
    const request = route.request();
    need(
      request.method() === "POST" && new URL(request.url()).origin === origin,
      `${lane}-local-logout-post`,
    );
    logoutAttempt += 1;
    if (lane !== "ack-loss" && logoutAttempt === 1) {
      observed.fixed503s += 1;
      fixed503Entered();
      await fixed503Gate;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    }
    if (lane === "ack-loss") {
      const upstream = await fetch(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postDataBuffer() ?? undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const afterCommit = await nativeSnapshot(db, seeded.sessionId);
      need(
        upstream.status === 200 && bytes.byteLength > 0,
        "ack-loss-real-worker-200-body-read",
      );
      need(
        afterCommit.liveSessionCount === 0 && afterCommit.session === null,
        "ack-loss-native-revocation-before-response-drop",
      );
      committedResponse = {
        status: upstream.status,
        bodyBytes: bytes.byteLength,
        bodySha256: sha(bytes),
        nativeSessionCount: afterCommit.liveSessionCount,
        nativeSession: afterCommit.session,
      };
      return route.abort("failed");
    }
    return route.continue();
  });
  const initialAuthResponse = waitForBrowserAuth(page, origin);
  await page.goto(`${origin}${path}`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  const initialAuth = await readAuthResponse(
    await initialAuthResponse,
    seeded.actorApId,
  );
  need(
    initialAuth.status === 200 && initialAuth.expected,
    `${lane}-authenticated-initial-render`,
  );
  return {
    context,
    page,
    seeded,
    observed,
    fixed503Entered,
    releaseFixed503,
    logoutAttempt: () => logoutAttempt,
    committedResponse: () => committedResponse,
  };
}

async function openAndConfirmLogout(page, caller) {
  if (caller === "settings") {
    const logout = page.getByRole("button", { name: "ログアウト" });
    await logout.waitFor({ state: "visible", timeout: TIMEOUT });
    need((await logout.count()) === 1, "settings-has-one-logout-action");
    await logout.click({ timeout: TIMEOUT });
  } else {
    const trigger = page.locator(
      'button[aria-haspopup="dialog"][title="メニューを開く"]',
    );
    await trigger.waitFor({ state: "visible", timeout: TIMEOUT });
    await trigger.click({ timeout: TIMEOUT });
    const menu = page.getByRole("dialog", { name: "メニュー" });
    await menu.waitFor({ state: "visible", timeout: TIMEOUT });
    await menu
      .getByRole("button", { name: "ログアウト" })
      .click({ timeout: TIMEOUT });
  }
  const confirm = page.getByRole("alertdialog");
  await confirm.waitFor({ state: "visible", timeout: TIMEOUT });
  return confirm;
}

async function submitLogout(confirm) {
  const submit = confirm.getByRole("button", { name: "ログアウト" });
  await submit.waitFor({ state: "visible", timeout: TIMEOUT });
  need(await submit.isEnabled(), "logout-confirm-enabled-for-explicit-action");
  const responsePromise = confirm.page().waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === "/api/auth/logout"
      );
    },
    { timeout: TIMEOUT },
  );
  const clickPromise = submit.click({ timeout: TIMEOUT });
  const [response] = await Promise.all([responsePromise, clickPromise]);
  return response;
}

async function waitForFailureAndRetry({ fixture, origin, caller }) {
  const { page, seeded, observed } = fixture;
  const confirmation = await openAndConfirmLogout(page, caller);
  const firstResponse = submitLogout(confirmation);
  // Handle early cleanup rejection while the pending response is held below.
  firstResponse.catch(() => {});
  let gateTimeout;
  try {
    await Promise.race([
      fixture.fixed503Entered,
      firstResponse.then(() => {
        throw new Error("logout-outcome:response-before-held-503");
      }),
      new Promise((_, reject) => {
        gateTimeout = setTimeout(() => {
          reject(new Error("logout-outcome:held-503-request-deadline"));
        }, TIMEOUT);
      }),
    ]);
  } finally {
    clearTimeout(gateTimeout);
  }
  // The pending request must keep the confirmation controls locked. Releasing
  // the deterministic failure only happens after those states are observed.
  const retry = confirmation.getByRole("button", { name: "ログアウト" });
  const cancel = confirmation.getByRole("button", { name: "キャンセル" });
  // Network interception can precede Solid's DOM update. Wait for the actual
  // disabled controls while the request remains deterministically held.
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const buttons = Array.from(dialog?.querySelectorAll("button") ?? []);
      return buttons.length === 2 && buttons.every((button) => button.disabled);
    },
    undefined,
    { timeout: TIMEOUT },
  );
  need(!(await retry.isEnabled()), `${caller}-confirm-locked-while-pending`);
  need(!(await cancel.isEnabled()), `${caller}-cancel-locked-while-pending`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  need(
    (await confirmation.isVisible()) && fixture.logoutAttempt() === 1,
    `${caller}-pending-escape-does-not-dismiss-or-resend`,
  );
  const failedAuthResponse = waitForBrowserAuth(page, origin);
  fixture.releaseFixed503();
  const response = await firstResponse;
  need(response.status() === 503, `${caller}-fixed-503-response`);
  await confirmation
    .getByRole("alert")
    .getByText(RETRY_COPY, { exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  need(
    new URL(page.url()).pathname ===
      (caller === "settings" ? "/settings" : "/"),
    `${caller}-remains-on-current-surface`,
  );
  need(await confirmation.isVisible(), `${caller}-confirmation-remains-open`);
  need(await retry.isEnabled(), `${caller}-explicit-retry-available`);
  const auth = await readAuthResponse(
    await failedAuthResponse,
    seeded.actorApId,
  );
  need(
    (await fixture.context.cookies(origin)).some(
      (cookie) => cookie.name === "session" && cookie.value === seeded.cookie,
    ),
    `${caller}-same-browser-cookie-retained-after-503`,
  );
  need(
    auth.status === 200 && auth.expected,
    `${caller}-same-owner-retained-after-503`,
  );
  const afterFailure = await nativeSnapshot(fixture.db, seeded.sessionId);
  need(
    afterFailure.liveSessionCount === 1 &&
      JSON.stringify(afterFailure.session) ===
        JSON.stringify(seeded.seeded.session),
    `${caller}-session-row-unchanged-after-503`,
  );
  need(
    JSON.stringify(afterFailure.owners) ===
      JSON.stringify(seeded.seeded.owners),
    `${caller}-owner-row-unchanged-after-503`,
  );
  need(
    observed.loginStarts === 0 &&
      observed.callbacks === 0 &&
      observed.blockedOutbound === 0,
    `${caller}-no-oidc-after-503`,
  );
  // Allow a bounded settlement window before explicit input to catch any
  // accidental automatic duplicate while the same confirmation stays open.
  await page.waitForTimeout(200);
  need(
    observed.logoutPosts === 1 && fixture.logoutAttempt() === 1,
    `${caller}-no-automatic-post-before-explicit-retry`,
  );
  const retryResponse = submitLogout(confirmation);
  const secondResponse = await retryResponse;
  need(secondResponse.status() === 200, `${caller}-retry-real-worker-ack`);
  await page
    .locator('a[href="/api/auth/login/takos"]')
    .waitFor({ state: "visible", timeout: TIMEOUT });
  const oldCookieResponse = await page.request.get(`${origin}/api/auth/me`, {
    headers: { cookie: `session=${seeded.cookie}` },
  });
  const afterRetry = await nativeSnapshot(fixture.db, seeded.sessionId);
  need(
    oldCookieResponse.status() === 401,
    `${caller}-old-cookie-rejected-after-retry`,
  );
  need(
    afterRetry.liveSessionCount === 0 && afterRetry.session === null,
    `${caller}-retry-removes-native-session`,
  );
  need(
    JSON.stringify(afterRetry.owners) === JSON.stringify(seeded.seeded.owners),
    `${caller}-retry-preserves-owner`,
  );
  need(
    observed.logoutPosts === 2 && observed.fixed503s === 1,
    `${caller}-exactly-one-explicit-retry`,
  );
  need(
    observed.loginStarts === 0 &&
      observed.callbacks === 0 &&
      observed.blockedOutbound === 0 &&
      observed.pageErrors === 0,
    `${caller}-retry-no-auto-oidc-or-pageerror`,
  );
  need(
    !(await fixture.context.cookies(origin)).some(
      (cookie) => cookie.name === "session",
    ),
    `${caller}-retry-clears-browser-cookie`,
  );
  return {
    caller,
    failedAttempt: {
      status: 503,
      postCount: 1,
      oldCookieStatus: auth.status,
      liveSessionCount: afterFailure.liveSessionCount,
      errorVisible: true,
    },
    retry: {
      status: secondResponse.status(),
      oldCookieStatus: oldCookieResponse.status(),
      liveSessionCount: afterRetry.liveSessionCount,
      ownerUnchanged:
        JSON.stringify(afterRetry.owners) ===
        JSON.stringify(seeded.seeded.owners),
    },
    observations: { ...observed },
    authBudget: {
      limit: Number(oldCookieResponse.headers()["x-ratelimit-limit"]),
      resetAt: Number(oldCookieResponse.headers()["x-ratelimit-reset"]),
    },
  };
}

async function respectAuthBudgetBetweenCases(budget) {
  // The independent cases share the native runtime's anonymous IP bucket.
  // Respect its public reset header; do not erase KV, spoof a client IP, or
  // accept 429 as anonymous authentication. No logout request is retried here.
  need(
    budget.limit > 0 && Number.isFinite(budget.resetAt) && budget.resetAt > 0,
    "auth-budget-reset-header-required",
  );
  const waitMs = Math.max(0, budget.resetAt * 1_000 - Date.now() + 10);
  need(waitMs <= 60_000, "auth-budget-spacing-deadline");
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  return {
    ...budget,
    waitMs,
    policy: "public-reset-header-between-independent-cases",
  };
}

async function qualifyAckLoss({
  browser,
  worker,
  db,
  origin,
  issuer,
  sessionSalt,
}) {
  const fixture = await createOwnerPage({
    browser,
    worker,
    db,
    origin,
    issuer,
    sessionSalt,
    path: "/settings",
    lane: "ack-loss",
  });
  try {
    const confirmation = await openAndConfirmLogout(fixture.page, "settings");
    await confirmation
      .getByRole("button", { name: "ログアウト" })
      .click({ timeout: TIMEOUT });
    const loginLink = fixture.page.locator('a[href="/api/auth/login/takos"]');
    await loginLink.waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      fixture.logoutAttempt() === 1 &&
        fixture.committedResponse()?.status === 200,
      "ack-loss-one-real-committed-post",
    );
    need(
      fixture.committedResponse().bodyBytes > 0 &&
        fixture.committedResponse().nativeSessionCount === 0 &&
        fixture.committedResponse().nativeSession === null,
      "ack-loss-body-consumed-before-browser-drop",
    );
    const currentAuth = await browserAuth(
      fixture.page,
      fixture.seeded.actorApId,
    );
    need(
      currentAuth.status === 401 && currentAuth.actorApId === null,
      "ack-loss-read-only-auth-reconciles-401",
    );
    const oldCookieResponse = await fixture.page.request.get(
      `${origin}/api/auth/me`,
      { headers: { cookie: `session=${fixture.seeded.cookie}` } },
    );
    const after = await nativeSnapshot(db, fixture.seeded.sessionId);
    need(
      oldCookieResponse.status() === 401 &&
        after.liveSessionCount === 0 &&
        after.session === null,
      "ack-loss-native-and-old-cookie-confirm-revocation",
    );
    need(
      JSON.stringify(after.owners) ===
        JSON.stringify(fixture.seeded.seeded.owners),
      "ack-loss-owner-unchanged",
    );
    need(
      fixture.observed.logoutPosts === 1 &&
        fixture.observed.loginStarts === 0 &&
        fixture.observed.callbacks === 0 &&
        fixture.observed.blockedOutbound === 0 &&
        fixture.observed.pageErrors === 0,
      "ack-loss-no-retry-or-oidc-or-pageerror",
    );
    const browserJarRetainsStaleCookie = (
      await fixture.context.cookies(origin)
    ).some((cookie) => cookie.name === "session");
    need(
      browserJarRetainsStaleCookie,
      "ack-loss-browser-did-not-receive-cookie-clear",
    );
    return {
      lane: "real-commit-response-lost",
      status: fixture.committedResponse().status,
      responseBodyBytes: fixture.committedResponse().bodyBytes,
      responseBodySha256: fixture.committedResponse().bodySha256,
      browserOldCookieStatus: oldCookieResponse.status(),
      browserJarRetainsStaleCookie,
      nativeLiveSessionCount: after.liveSessionCount,
      nativeSessionRow: after.session,
      ownerUnchanged: true,
      logoutPosts: fixture.observed.logoutPosts,
      loginStarts: fixture.observed.loginStarts,
    };
  } finally {
    await fixture.context.close();
  }
}

/** Exercise Settings, AppMenu, and a committed logout whose browser ACK is lost. */
export async function qualifyLogoutOutcome({
  browser,
  worker,
  db,
  origin,
  issuer,
  checks = [],
  sessionSalt = SESSION_SALT,
}) {
  need(issuer && typeof issuer.login === "function", "issuer-required");
  const initial = await nativeSnapshot(db, "__no_session__");
  need(
    initial.liveSessionCount === 0 && initial.owners.length === 0,
    "fresh-database-empty",
  );
  const settings = await createOwnerPage({
    browser,
    worker,
    db,
    origin,
    issuer,
    sessionSalt,
    path: "/settings",
    lane: "settings",
  });
  let settingsResult;
  try {
    settingsResult = await waitForFailureAndRetry({
      fixture: { ...settings, db },
      origin,
      caller: "settings",
    });
  } finally {
    settings.releaseFixed503();
    await settings.context.close();
  }

  const appMenu = await createOwnerPage({
    browser,
    worker,
    db,
    origin,
    issuer,
    sessionSalt,
    path: "/",
    lane: "app-menu",
  });
  let appMenuResult;
  try {
    appMenuResult = await waitForFailureAndRetry({
      fixture: { ...appMenu, db },
      origin,
      caller: "app-menu",
    });
  } finally {
    appMenu.releaseFixed503();
    await appMenu.context.close();
  }

  const caseSpacing = await respectAuthBudgetBetweenCases(
    appMenuResult.authBudget,
  );
  const ackLoss = await qualifyAckLoss({
    browser,
    worker,
    db,
    origin,
    issuer,
    sessionSalt,
  });
  const final = await nativeSnapshot(db, "__no_session__");
  need(
    final.liveSessionCount === 0 &&
      final.owners.length === 1 &&
      JSON.stringify(final.owners) ===
        JSON.stringify(settings.seeded.seeded.owners),
    "final-owner-and-session-counts",
  );
  const counts = issuer.snapshot();
  need(
    counts.logins === 3 &&
      counts.token === 3 &&
      counts.userinfo === 3 &&
      counts.blocked === 0 &&
      counts.jwks >= 1 &&
      counts.jwks <= 3,
    "three-bounded-signed-oidc-callbacks",
  );
  checks.push("logout-outcome-settings-503-visible-error-explicit-retry");
  checks.push("logout-outcome-app-menu-503-visible-error-explicit-retry");
  checks.push(
    "logout-outcome-real-commit-response-loss-readonly-reconciliation",
  );
  return {
    checks,
    mode: "candidate",
    settings: settingsResult,
    appMenu: appMenuResult,
    ackLoss,
    caseSpacing,
    final: {
      liveSessionCount: final.liveSessionCount,
      ownerRows: final.owners,
    },
    issuer: counts,
  };
}
