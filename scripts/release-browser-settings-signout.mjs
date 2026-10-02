import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";

const TIMEOUT = 15_000;
const SESSION_SALT = "settings-signout-session-salt";

function need(ok, label) {
  if (!ok) throw new Error(`settings-signout:${label}`);
}
function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
function b64url(value) {
  return Buffer.from(value).toString("base64url");
}
function json(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function cookieValues(response) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  return values.flatMap((value) =>
    value.split(/, (?=[^;,=\s]+=[^;,]*)/).map((entry) => entry.trim()),
  );
}
function cookiePair(response, name) {
  return cookieValues(response)
    .map((value) => value.split(";", 1)[0])
    .find((value) => value.startsWith(`${name}=`));
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`settings-signout:${label}-timeout`)),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function dbCounts(db) {
  const row = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now')) AS liveSessions",
    )
    .first();
  return {
    actors: Number(row?.actors ?? -1),
    liveSessions: Number(row?.liveSessions ?? -1),
  };
}

// The callback itself is a real Worker request. A local service fixture supplies
// signed OIDC protocol responses without exposing credentials to browser logs.
export async function createSettingsSignoutIssuer({ origin, sessionSalt }) {
  const appOrigin = new URL(origin).origin;
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const subject = `settings_${randomUUID().replaceAll("-", "")}`;
  const tokens = new Map();
  const codes = new Map();
  const counts = { logins: 0, jwks: 0, token: 0, userinfo: 0, blocked: 0 };
  async function idToken(nonce) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(
      JSON.stringify({ alg: "ES256", kid: "settings-signout-key", typ: "JWT" }),
    );
    const body = b64url(
      JSON.stringify({
        iss: "https://update-issuer.yurucommu.invalid",
        aud: "native-update-synthetic-public-client",
        exp: now + 300,
        iat: now,
        sub: subject,
        preferred_username: subject,
        name: "Synthetic Settings Owner",
        nonce,
      }),
    );
    const input = `${head}.${body}`;
    const sig = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${b64url(sig)}`;
  }
  need(
    typeof sessionSalt === "string" && sessionSalt.length > 0,
    "session-salt-required",
  );
  return {
    async close() {},
    bindings: {
      OIDC_ISSUER_URL: "https://update-issuer.yurucommu.invalid",
      OIDC_CLIENT_ID: "native-update-synthetic-public-client",
      OIDC_OWNER_SUB: subject,
    },
    subject,
    snapshot: () => ({ ...counts }),
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== "https://update-issuer.yurucommu.invalid") {
        counts.blocked += 1;
        return new Response(null, { status: 502 });
      }
      if (request.method === "GET" && url.pathname === "/oauth/jwks") {
        counts.jwks += 1;
        return json({
          keys: [
            { ...jwk, kid: "settings-signout-key", alg: "ES256", use: "sig" },
          ],
        });
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        const form = new URLSearchParams(await request.text());
        const code = codes.get(form.get("code"));
        const verifier = form.get("code_verifier") ?? "";
        const challenge = b64url(
          createHash("sha256").update(verifier).digest(),
        );
        if (
          !code ||
          code.used ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_id") !== "native-update-synthetic-public-client" ||
          form.get("redirect_uri") !== `${appOrigin}/api/auth/callback/takos` ||
          form.has("client_secret") ||
          !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) ||
          challenge !== code.challenge
        )
          return new Response(null, { status: 400 });
        code.used = true;
        counts.token += 1;
        const access = randomUUID();
        tokens.set(access, subject);
        return json({
          access_token: access,
          refresh_token: randomUUID(),
          token_type: "Bearer",
          expires_in: 300,
          id_token: await idToken(code.nonce),
        });
      }
      if (request.method === "GET" && url.pathname === "/oauth/userinfo") {
        const value = (request.headers.get("authorization") ?? "").replace(
          /^Bearer /,
          "",
        );
        if (!tokens.has(value)) return new Response(null, { status: 401 });
        counts.userinfo += 1;
        return json({ sub: subject });
      }
      counts.blocked += 1;
      return new Response(null, { status: 502 });
    },
    async login(worker) {
      const started = await worker.dispatchFetch(
        `${appOrigin}/api/auth/login/takos`,
        { redirect: "manual", headers: { origin: appOrigin } },
      );
      need(started.status === 302, "oidc-start-302");
      const location = new URL(started.headers.get("location") ?? "");
      need(
        location.origin === "https://update-issuer.yurucommu.invalid" &&
          location.pathname === "/oauth/authorize",
        "oidc-authorize-location",
      );
      const p = location.searchParams;
      const nonceCookie = cookiePair(started, "oauth_nonce");
      const nonceHeader =
        cookieValues(started).find((value) =>
          value.startsWith("oauth_nonce="),
        ) ?? "";
      need(
        /;\s*httponly/i.test(nonceHeader) &&
          /;\s*samesite=lax/i.test(nonceHeader) &&
          /;\s*path=\//i.test(nonceHeader) &&
          !/;\s*secure/i.test(nonceHeader),
        "http-origin-nonce-cookie-attributes",
      );
      need(
        p.get("response_type") === "code" &&
          p.get("client_id") === "native-update-synthetic-public-client" &&
          p.get("redirect_uri") === `${appOrigin}/api/auth/callback/takos` &&
          p.get("scope") === "openid profile email" &&
          p.get("code_challenge_method") === "S256" &&
          /^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? "") &&
          (p.get("state")?.length ?? 0) > 8 &&
          p.get("nonce") ===
            decodeURIComponent(nonceCookie?.slice("oauth_nonce=".length) ?? ""),
        "oidc-start-contract",
      );
      const code = randomBytes(32).toString("base64url");
      codes.set(code, {
        challenge: p.get("code_challenge"),
        nonce: p.get("nonce"),
        used: false,
      });
      const callback = await worker.dispatchFetch(
        `${appOrigin}/api/auth/callback/takos?code=${encodeURIComponent(code)}&state=${encodeURIComponent(p.get("state") ?? "")}`,
        {
          redirect: "manual",
          headers: { origin: appOrigin, cookie: nonceCookie },
        },
      );
      need(
        callback.status === 302 && callback.headers.get("location") === "/",
        "oidc-callback-success",
      );
      const pair = cookiePair(callback, "session");
      need(
        Boolean(
          pair && decodeURIComponent(pair.slice("session=".length)).length > 0,
        ),
        "oidc-session-cookie",
      );
      const header =
        cookieValues(callback).find((value) => value.startsWith("session=")) ??
        "";
      need(
        /;\s*secure/i.test(header) === appOrigin.startsWith("https:"),
        "session-cookie-secure-attribute-matches-origin",
      );
      need(
        header.length > 0 &&
          /;\s*httponly/i.test(header) &&
          /;\s*samesite=strict/i.test(header) &&
          /;\s*path=\//i.test(header),
        "session-cookie-attributes-readback",
      );
      counts.logins += 1;
      return {
        value: decodeURIComponent(pair.slice("session=".length)),
        cookieAttributes: {
          httpOnly: /;\s*httponly/i.test(header),
          secure: /;\s*secure/i.test(header),
          sameSite: /;\s*samesite=strict/i.test(header)
            ? "Strict"
            : /;\s*samesite=lax/i.test(header)
              ? "Lax"
              : "None",
          path: /;\s*path=([^;]+)/i.exec(header)?.[1] ?? "/",
        },
      };
    },
  };
}

async function seedSession({ worker, db, origin, issuer, sessionSalt }) {
  const issued = await issuer.login(worker);
  const cookie = issued.value;
  const response = await worker.dispatchFetch(`${origin}/api/auth/me`, {
    headers: { cookie: `session=${cookie}` },
  });
  need(response.status === 200, "seed-cookie-authenticated");
  const actor = (await response.json()).actor;
  need(
    typeof actor?.ap_id === "string" &&
      actor.role === "owner" &&
      new URL(actor.ap_id).origin === origin,
    "seed-owner-from-auth-me",
  );
  const expectedId = `sha256:${sha(`${sessionSalt}:${cookie}`)}`;
  const session = await db
    .prepare("SELECT id, member_id, expires_at FROM sessions WHERE id = ?")
    .bind(expectedId)
    .first();
  need(
    session?.id === expectedId &&
      session.member_id === actor.ap_id &&
      Date.parse(session.expires_at) > Date.now(),
    "seed-hashed-live-session",
  );
  const actors = await db
    .prepare(
      "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
    )
    .all();
  need(
    actors.results?.length === 1 &&
      actors.results[0].ap_id === actor.ap_id &&
      actors.results[0].role === "owner" &&
      actors.results[0].owner_actor_ap_id == null &&
      actors.results[0].deleted_at == null,
    "seed-single-root-owner",
  );
  return {
    cookie,
    cookieAttributes: issued.cookieAttributes,
    actorApId: actor.ap_id,
    expectedId,
    ownerRows: actors.results,
  };
}

async function providers(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/providers", {
      credentials: "include",
    });
    const body = await response.json();
    return (
      response.status === 200 &&
      body.password_enabled === false &&
      body.providers?.length === 1 &&
      body.providers[0]?.id === "takos"
    );
  });
}

async function setupContext({
  browser,
  origin,
  cookie,
  cookieAttributes,
  actorApId,
  mode,
  path = "/settings",
}) {
  const context = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const parsed = new URL(origin);
  try {
    await context.addCookies([
      {
        name: "session",
        value: cookie,
        domain: parsed.hostname,
        path: cookieAttributes.path,
        httpOnly: cookieAttributes.httpOnly,
        secure: cookieAttributes.secure,
        sameSite: cookieAttributes.sameSite,
      },
    ]);
    const page = await context.newPage();
    const events = {
      logoutPosts: 0,
      autoStarts: 0,
      authRedirects: 0,
      authorize: 0,
      callbacks: 0,
      pageErrors: 0,
      fiveHundreds: 0,
      blockedOutbound: 0,
    };
    const logoutResponses = [];
    page.on("pageerror", () => {
      events.pageErrors += 1;
    });
    page.on("request", (request) => {
      try {
        const u = new URL(request.url());
        if (u.origin !== origin) return;
        if (request.method() === "POST" && u.pathname === "/api/auth/logout")
          events.logoutPosts += 1;
        if (
          request.method() === "GET" &&
          u.pathname === "/api/auth/login/takos"
        )
          events.autoStarts += 1;
        if (u.pathname === "/api/auth/callback/takos") events.callbacks += 1;
      } catch {}
    });
    page.on("response", (response) => {
      try {
        const u = new URL(response.url());
        if (u.origin === origin && response.status() >= 500)
          events.fiveHundreds += 1;
        if (
          response.request().method() === "POST" &&
          u.pathname === "/api/auth/logout"
        )
          logoutResponses.push(response);
      } catch {}
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const u = new URL(request.url());
      if (
        u.origin === origin &&
        request.method() === "GET" &&
        u.pathname === "/api/auth/login/takos"
      ) {
        // Bun's Node IncomingMessage exposes a relative response.url here,
        // which Playwright 1.55 cannot parse with a Set-Cookie response.
        // Forward this exact observed browser request over real local HTTP and
        // deny redirects; never follow the synthetic issuer outside loopback.
        const response = await fetch(request.url(), {
          method: request.method(),
          headers: await request.allHeaders(),
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        });
        const location = new URL(
          response.headers.get("location") ?? "",
          origin,
        );
        need(
          response.status === 302 &&
            location.origin === "https://update-issuer.yurucommu.invalid" &&
            location.pathname === "/oauth/authorize",
          "real-local-worker-auth-redirect",
        );
        await response.arrayBuffer();
        await route.abort("blockedbyclient");
        events.authRedirects += 1;
        return;
      }
      if (["data:", "blob:"].includes(u.protocol) || u.origin === origin)
        return route.continue();
      if (
        u.origin === "https://update-issuer.yurucommu.invalid" &&
        u.pathname === "/oauth/authorize" &&
        request.method() === "GET"
      ) {
        events.authorize += 1;
        return route.abort("blockedbyclient");
      }
      events.blockedOutbound += 1;
      return route.abort("blockedbyclient");
    });
    await page.goto(`${origin}/`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    need(
      await page.evaluate(
        () =>
          sessionStorage.getItem("yurucommu:oidc-auto-start-attempted") ===
          null,
      ),
      "fresh-context-key-absent-before-settings",
    );
    if (path !== "/")
      await page.goto(`${origin}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT,
      });
    need(
      await page.evaluate(
        () =>
          sessionStorage.getItem("yurucommu:oidc-auto-start-attempted") ===
          null,
      ),
      "authenticated-page-breaker-key-still-absent",
    );
    need(
      await page.evaluate(async (expectedApId) => {
        const response = await fetch("/api/auth/me", {
          credentials: "include",
        });
        const body = await response.json();
        return (
          response.status === 200 &&
          body.actor?.role === "owner" &&
          body.actor?.ap_id === expectedApId
        );
      }, actorApId),
      "fresh-context-authenticated-session",
    );
    need(await providers(page), "oidc-only-provider-config");
    need(
      events.autoStarts === 0 && events.authRedirects === 0,
      "authenticated-page-did-not-auto-start",
    );
    return { context, page, events, logoutResponses };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function settingsLogout(page, logoutResponses, events) {
  const logoutButtons = await page
    .getByRole("button", { name: "ログアウト" })
    .all();
  const visibleLogoutButtons = [];
  for (const button of logoutButtons)
    if (await button.isVisible()) visibleLogoutButtons.push(button);
  need(visibleLogoutButtons.length === 1, "settings-logout-button-visible");
  await visibleLogoutButtons[0].click({ timeout: TIMEOUT });
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
  await dialog
    .getByRole("button", { name: "ログアウト" })
    .click({ timeout: TIMEOUT });
  const stage = "response-event";
  try {
    await bounded(
      (async () => {
        const deadline = Date.now() + TIMEOUT;
        while (logoutResponses.length === 0 && Date.now() < deadline)
          await page.waitForTimeout(10);
        need(logoutResponses.length === 1, "one-logout-response-arrived");
        // The SDK navigates after fetch headers, without consuming the body.
        // Response.finished() can remain pending across that hard navigation.
        // Verify response headers here, and require Cookie + native authority
        // readbacks below; never infer revocation from this event alone.
      })(),
      "logout-response-observed",
    );
  } catch (error) {
    // Bounded diagnostics contain counts/statuses only, never Cookie values.
    throw new Error(
      `settings-signout:logout-observation:${JSON.stringify({
        stage,
        logoutPosts: events.logoutPosts,
        responseCount: logoutResponses.length,
        responseStatuses: logoutResponses.map((response) => response.status()),
      })}`,
      { cause: error },
    );
  }
  need(logoutResponses.length === 1, "one-logout-response");
  const response = logoutResponses[0];
  const headers = await response.headersArray();
  const sessionHeaders = headers.filter(
    (entry) =>
      entry.name.toLowerCase() === "set-cookie" &&
      /^session=/i.test(entry.value),
  );
  const clear =
    sessionHeaders.length === 1 &&
    sessionHeaders.some(
      ({ value }) =>
        /^session=;/.test(value) && /;\s*max-age=0(?:;|$)/i.test(value),
    );
  need(response.status() === 200 && clear, "logout-200-clear-cookie");
  return { status: response.status(), cookieCleared: clear };
}

export async function qualifySettingsSignout({
  browser,
  worker,
  db,
  origin,
  mode,
  checks,
  issuer,
  sessionSalt = SESSION_SALT,
}) {
  need(mode === "baseline" || mode === "candidate", "mode-required");
  need(issuer && typeof issuer.login === "function", "issuer-required");
  let context;
  let primary;
  try {
    const empty = await dbCounts(db);
    need(
      empty.actors === 0 && empty.liveSessions === 0,
      "fresh-database-empty",
    );
    const seeded = await seedSession({
      worker,
      db,
      origin,
      issuer,
      sessionSalt,
    });
    const initialCounts = await dbCounts(db);
    need(
      initialCounts.actors === 1 && initialCounts.liveSessions === 1,
      "seed-counts",
    );
    const auth = await setupContext({
      browser,
      origin,
      cookie: seeded.cookie,
      cookieAttributes: seeded.cookieAttributes,
      actorApId: seeded.actorApId,
      mode,
    });
    context = auth.context;
    const settingsLogoutButton = auth.page.getByRole("button", {
      name: "ログアウト",
    });
    await settingsLogoutButton.waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await settingsLogoutButton.count()) === 1,
      "settings-route-and-owner-visible",
    );
    const logout = await settingsLogout(
      auth.page,
      auth.logoutResponses,
      auth.events,
    );
    if (mode === "candidate") {
      await auth.page
        .locator('a[href="/api/auth/login/takos"]')
        .waitFor({ state: "visible", timeout: TIMEOUT });
      need(
        await auth.page.evaluate(
          () =>
            sessionStorage.getItem("yurucommu:oidc-auto-start-attempted") ===
            "1",
        ),
        "settings-logout-breaker-present",
      );
    } else {
      await bounded(
        (async () => {
          const deadline = Date.now() + TIMEOUT;
          while (auth.events.authRedirects === 0 && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
          need(
            auth.events.authRedirects === 1,
            "baseline-one-real-auth-redirect",
          );
        })(),
        "baseline-real-auth-redirect",
      );
    }
    const oldCookie = await auth.page.request.get(`${origin}/api/auth/me`, {
      headers: { cookie: `session=${seeded.cookie}` },
    });
    need(oldCookie.status() === 401, "old-cookie-rejected");
    const session = await db
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .bind(seeded.expectedId)
      .first();
    need(!session, "hashed-session-row-removed");
    const ownerRows = await db
      .prepare(
        "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
      )
      .all();
    need(
      JSON.stringify(ownerRows.results) === JSON.stringify(seeded.ownerRows),
      "owner-row-unchanged",
    );
    const revokedCounts = await dbCounts(db);
    need(
      revokedCounts.actors === initialCounts.actors &&
        revokedCounts.liveSessions === 0,
      "no-replacement-session",
    );
    const jar = await context.cookies(origin);
    need(
      !jar.some((item) => item.name === "session"),
      "browser-session-cookie-cleared",
    );
    const link = auth.page.locator('a[href="/api/auth/login/takos"]');
    if (mode === "candidate") {
      await link.waitFor({ state: "visible", timeout: TIMEOUT });
      need((await link.count()) === 1, "manual-provider-link-visible");
    }
    need(auth.events.logoutPosts === 1, "exactly-one-real-logout-post");
    need(
      mode === "baseline"
        ? auth.events.autoStarts > 0 && auth.events.authRedirects > 0
        : auth.events.autoStarts === 0 &&
            auth.events.authRedirects === 0 &&
            auth.events.authorize === 0 &&
            auth.events.callbacks === 0,
      mode === "baseline"
        ? "baseline-settings-bypass-reproduced"
        : "candidate-auto-start-suppressed",
    );
    need(
      auth.events.blockedOutbound === 0 &&
        auth.events.pageErrors === 0 &&
        auth.events.fiveHundreds === 0,
      "no-browser-error-or-outbound",
    );
    const finalCounts = await dbCounts(db);
    need(
      finalCounts.actors === initialCounts.actors &&
        finalCounts.liveSessions === 0,
      "no-session-after-observation",
    );
    if (mode === "candidate") {
      await auth.page.reload({
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT,
      });
      await auth.page
        .locator('a[href="/api/auth/login/takos"]')
        .waitFor({ state: "visible", timeout: TIMEOUT });
      await auth.page.waitForTimeout(200);
      need(
        auth.events.blockedOutbound === 0 &&
          auth.events.pageErrors === 0 &&
          auth.events.fiveHundreds === 0,
        "settings-reload-no-browser-errors",
      );
      need(
        (await auth.page.request.get(`${origin}/api/auth/me`)).status() === 401,
        "settings-reload-unauthenticated",
      );
      need(
        auth.events.autoStarts === 0,
        "settings-logout-reload-remains-suppressed",
      );
      need(
        (await dbCounts(db)).liveSessions === 0,
        "settings-logout-reload-mints-no-session",
      );
    }
    checks.push("settings-signout-oidc-cookie-session-revoked");
    checks.push(
      mode === "baseline"
        ? "settings-signout-baseline-auto-start-reproduced"
        : "settings-signout-candidate-auto-start-suppressed",
    );
    checks.push(
      mode === "candidate"
        ? "settings-signout-manual-provider-link-preserved"
        : "settings-signout-baseline-redirect-aborted-locally",
    );
    const issuerCounts = issuer.snapshot();
    need(
      issuerCounts.logins === 1 &&
        issuerCounts.jwks === 1 &&
        issuerCounts.token === 1 &&
        issuerCounts.userinfo === 1 &&
        issuerCounts.blocked === 0,
      "first-signed-callback-no-extra-issuer-request",
    );
    let appMenuControl = null;
    if (mode === "candidate") {
      const secondSeed = await seedSession({
        worker,
        db,
        origin,
        issuer,
        sessionSalt,
      });
      const menuAuth = await setupContext({
        browser,
        origin,
        cookie: secondSeed.cookie,
        cookieAttributes: secondSeed.cookieAttributes,
        actorApId: secondSeed.actorApId,
        mode,
        path: "/",
      });
      try {
        const menuButton = menuAuth.page.getByRole("dialog", {
          name: "メニュー",
        });
        const trigger = menuAuth.page.locator(
          'button[aria-haspopup="dialog"][title="メニューを開く"]',
        );
        await trigger.waitFor({ state: "visible", timeout: TIMEOUT });
        await trigger.click();
        await menuButton.waitFor({ state: "visible", timeout: TIMEOUT });
        const menuLogout = await settingsLogout(
          menuAuth.page,
          menuAuth.logoutResponses,
          menuAuth.events,
        );
        await menuAuth.page
          .locator('a[href="/api/auth/login/takos"]')
          .waitFor({ state: "visible", timeout: TIMEOUT });
        need(
          await menuAuth.page.evaluate(
            () =>
              sessionStorage.getItem("yurucommu:oidc-auto-start-attempted") ===
              "1",
          ),
          "app-menu-logout-sets-breaker",
        );
        await menuAuth.page.waitForTimeout(200);
        need(
          menuAuth.events.logoutPosts === 1 &&
            menuAuth.events.autoStarts === 0 &&
            menuAuth.events.authRedirects === 0,
          "app-menu-logout-breaker-control",
        );
        const oldCookie = await menuAuth.page.request.get(
          `${origin}/api/auth/me`,
          { headers: { cookie: `session=${secondSeed.cookie}` } },
        );
        const menuSession = await db
          .prepare("SELECT id FROM sessions WHERE id = ?")
          .bind(secondSeed.expectedId)
          .first();
        need(
          oldCookie.status() === 401 && !menuSession,
          "app-menu-native-session-revoked",
        );
        need(
          (await dbCounts(db)).actors === 1 &&
            (await dbCounts(db)).liveSessions === 0,
          "app-menu-owner-and-session-counts-stable",
        );
        const menuOwnerRows = await db
          .prepare(
            "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
          )
          .all();
        need(
          JSON.stringify(menuOwnerRows.results) ===
            JSON.stringify(seeded.ownerRows),
          "app-menu-owner-unchanged",
        );
        need(
          !(await menuAuth.context.cookies(origin)).some(
            (item) => item.name === "session",
          ),
          "app-menu-cookie-cleared",
        );
        need(
          menuAuth.events.authorize === 0 &&
            menuAuth.events.callbacks === 0 &&
            menuAuth.events.blockedOutbound === 0 &&
            menuAuth.events.pageErrors === 0 &&
            menuAuth.events.fiveHundreds === 0,
          "app-menu-no-error-or-outbound",
        );
        checks.push("settings-signout-reload-keeps-session-revoked");
        checks.push("settings-signout-app-menu-control-revokes-session");
        appMenuControl = {
          ownerUnchanged: true,
          browserCookieCleared: true,
          observations: { ...menuAuth.events },
          logout: menuLogout,
          logoutPosts: menuAuth.events.logoutPosts,
          autoStarts: menuAuth.events.autoStarts,
          authRedirects: menuAuth.events.authRedirects,
          oldCookieRejected: true,
          sessionRowRemoved: true,
        };
      } finally {
        await menuAuth.context.close();
      }
    }
    const finalIssuerCounts = issuer.snapshot();
    const expectedSeeds = mode === "candidate" ? 2 : 1;
    need(
      finalIssuerCounts.logins === expectedSeeds &&
        finalIssuerCounts.jwks >= 1 &&
        finalIssuerCounts.jwks <= expectedSeeds &&
        finalIssuerCounts.token === expectedSeeds &&
        finalIssuerCounts.userinfo === expectedSeeds &&
        finalIssuerCounts.blocked === 0,
      "bounded-signed-callback-counts",
    );
    return {
      observations: { ...auth.events },
      mode,
      checks: checks.slice(mode === "candidate" ? -5 : -3),
      logout,
      revocation: {
        oldCookieStatus: oldCookie.status(),
        hashedSessionRowRemoved: !session,
        ownerUnchanged:
          JSON.stringify(ownerRows.results) ===
          JSON.stringify(seeded.ownerRows),
        browserCookieCleared: !jar.some((item) => item.name === "session"),
        authRedirects: auth.events.authRedirects,
        afterCounts: revokedCounts,
        finalCounts,
        autoStarts: auth.events.autoStarts,
        authorizeRequests: auth.events.authorize,
        callbackRequests: auth.events.callbacks,
      },
      appMenuControl,
      ownerCount: initialCounts.actors,
      sessionCountAfter: (await dbCounts(db)).liveSessions,
      issuer: finalIssuerCounts,
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await context?.close();
    } catch (error) {
      if (!primary) throw error;
    }
  }
}
