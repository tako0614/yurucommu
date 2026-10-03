import { createServer } from "node:http";

const DEFAULT_ISSUER_ORIGIN = "https://browser-issuer.yurucommu.invalid";

export const OIDC_RECOVERY_BINDINGS = Object.freeze({
  OIDC_ISSUER_URL: DEFAULT_ISSUER_ORIGIN,
  OIDC_CLIENT_ID: "browser-recovery-public-client",
  OIDC_OWNER_SUB: "browser_recovery_owner",
});

const ROUTE_TIMEOUT_MS = 12_000;

export async function createBrowserOidcErrorIssuer({ origin }) {
  const appOrigin = new URL(origin).origin;
  requireEffect(
    appOrigin === origin.replace(/\/$/, ""),
    "issuer-app-origin-must-be-canonical",
  );
  const counts = {
    requests: 0,
    validRequests: 0,
    invalidRequests: 0,
    refusedRequests: 0,
  };
  let lastAuthorization = null;
  const server = createServer((request, response) => {
    counts.requests += 1;
    let callback;
    try {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "invalid"}`,
      );
      const params = requestUrl.searchParams;
      const state = params.get("state") ?? "";
      const nonce = params.get("nonce") ?? "";
      const challenge = params.get("code_challenge") ?? "";
      const redirectUri = `${appOrigin}/api/auth/callback/takos`;
      const valid =
        request.method === "GET" &&
        requestUrl.pathname === "/oauth/authorize" &&
        params.get("response_type") === "code" &&
        params.get("client_id") === OIDC_RECOVERY_BINDINGS.OIDC_CLIENT_ID &&
        params.get("redirect_uri") === redirectUri &&
        params.get("scope") === "openid profile email" &&
        params.get("code_challenge_method") === "S256" &&
        /^[A-Za-z0-9_-]{43}$/.test(challenge) &&
        state.length >= 8 &&
        nonce.length >= 8;
      if (!valid) {
        counts.invalidRequests += 1;
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("invalid authorization request");
        return;
      }
      if (counts.validRequests >= 2) {
        counts.refusedRequests += 1;
        response.writeHead(429, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("authorization error fixture request limit reached");
        return;
      }
      counts.validRequests += 1;
      lastAuthorization = { state, nonce };
      callback = new URL(redirectUri);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.toString() });
      response.end();
    } catch {
      counts.invalidRequests += 1;
      if (!response.headersSent) {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
        });
      }
      response.end("invalid authorization request");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new RecoveryAssertionError("issuer-listen-failed");
  }
  const issuerOrigin = `http://localhost:${address.port}`;
  return {
    origin: issuerOrigin,
    bindings: Object.freeze({
      ...OIDC_RECOVERY_BINDINGS,
      OIDC_ISSUER_URL: issuerOrigin,
    }),
    snapshot: () => ({ ...counts }),
    matchesCallback: ({ state, cookie }) => {
      let decodedCookie;
      try {
        decodedCookie = decodeURIComponent(cookie ?? "");
      } catch {
        return false;
      }
      return Boolean(
        lastAuthorization &&
        lastAuthorization.state === state &&
        lastAuthorization.nonce === decodedCookie,
      );
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

class RecoveryAssertionError extends Error {
  constructor(code, trace = {}) {
    const counts = {
      loginStarts: trace.loginStarts ?? 0,
      issuerRequests: trace.issuerRequests ?? 0,
      callbackRequests: trace.callbackRequests ?? 0,
      additionalIssuerRequests: trace.additionalIssuerRequests ?? 0,
      issuerServerRequests: trace.issuerServerRequests ?? 0,
      issuerServerValid: trace.issuerServerValid ?? 0,
      issuerServerInvalid: trace.issuerServerInvalid ?? 0,
      issuerServerRefused: trace.issuerServerRefused ?? 0,
    };
    super(
      `browser-oidc-recovery:${code}:starts-${counts.loginStarts}:issuer-${counts.issuerRequests}:callback-${counts.callbackRequests}:extra-${counts.additionalIssuerRequests}:server-${counts.issuerServerRequests}-${counts.issuerServerValid}-${counts.issuerServerInvalid}-${counts.issuerServerRefused}`,
    );
    this.name = "RecoveryAssertionError";
    this.code = code;
  }
}

function requireEffect(condition, checkName) {
  if (!condition) throw new RecoveryAssertionError(checkName);
}

function mark(checks, condition, checkName) {
  requireEffect(condition, checkName);
  checks.push(checkName);
}

function updateIssuerTrace(trace, issuer) {
  const counts = issuer.snapshot();
  trace.issuerServerRequests = counts.requests;
  trace.issuerServerValid = counts.validRequests;
  trace.issuerServerInvalid = counts.invalidRequests;
  trace.issuerServerRefused = counts.refusedRequests;
  return counts;
}

async function readCounts(db) {
  const [actors, sessions] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM actors").first(),
    db.prepare("SELECT COUNT(*) AS count FROM sessions").first(),
  ]);
  return {
    actors: Number(actors?.count ?? -1),
    sessions: Number(sessions?.count ?? -1),
  };
}

function isEmpty(counts) {
  return counts.actors === 0 && counts.sessions === 0;
}

function callbackRequestPromise(page, appOrigin) {
  return page
    .waitForRequest(
      (request) => {
        try {
          const url = new URL(request.url());
          return (
            url.origin === appOrigin &&
            url.pathname === "/api/auth/callback/takos"
          );
        } catch {
          return false;
        }
      },
      { timeout: ROUTE_TIMEOUT_MS },
    )
    .then((request) => request.allHeaders())
    .catch(() => null);
}

function cookiePair(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}

async function visibleProviderLink(page) {
  const link = page.locator('a[href="/api/auth/login/takos"]');
  await link.waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  requireEffect(
    (await link.innerText()).includes("Takosumi Accounts"),
    "takosumi-provider-link-label-missing",
  );
  return link;
}

async function waitForCallbackUi(page, appOrigin) {
  await visibleProviderLink(page);
  const alert = page.getByRole("alert");
  await alert.waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  const alertCount = await alert.count();
  const alertText = (await alert.first().innerText()).trim();
  const alertTextLength = alertText.length;
  const current = new URL(page.url());
  const providers = await page.evaluate(async () => {
    const response = await fetch("/api/auth/providers", {
      credentials: "include",
    });
    return { status: response.status, body: await response.json() };
  });
  requireEffect(
    current.origin === appOrigin && !current.searchParams.has("error"),
    "callback-error-query-was-not-consumed",
  );
  requireEffect(
    alertCount === 1 &&
      (alertText.includes("外部アカウントでのログインに失敗") ||
        alertText.includes("External account sign-in failed")),
    "oauth-error-alert-not-visible",
  );
  requireEffect(
    providers.status === 200 &&
      providers.body.password_enabled === false &&
      providers.body.providers?.length === 1 &&
      providers.body.providers[0]?.id === "takos",
    "worker-was-not-configured-for-oidc-only",
  );
  return { alertCount, alertTextLength };
}

async function runScenario({
  browser,
  db,
  origin,
  issuer,
  storageDenied,
  checks,
  scenario,
}) {
  let context;
  let primaryError;
  let cleanupFailed = false;
  let phase = "new-context";
  const trace = {
    loginStarts: 0,
    callbackRequests: 0,
    issuerRequests: 0,
    additionalIssuerRequests: 0,
    issuerServerRequests: 0,
    issuerServerValid: 0,
    issuerServerInvalid: 0,
    issuerServerRefused: 0,
  };
  const issuerBefore = issuer.snapshot();
  try {
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    if (storageDenied) {
      phase = "deny-session-storage";
      await context.addInitScript(() => {
        Object.defineProperty(window, "sessionStorage", {
          configurable: true,
          get() {
            throw new DOMException(
              "blocked by browser policy",
              "SecurityError",
            );
          },
        });
      });
    }

    phase = "new-page";
    const page = await context.newPage();
    let externalBrowserRequestsBlocked = 0;
    let invalidIssuerRequests = 0;
    let expectedState = null;
    let expectedNonce = null;
    let callbackState = null;
    let issuerCookieMetadataPromise = Promise.resolve(false);
    let callbackStateMatches = false;
    let callbackErrorMatches = false;
    let callbackNonceWasSent = false;
    let issuerNonceCookieWasValid = false;
    let pageErrors = 0;

    page.on("pageerror", () => {
      pageErrors += 1;
    });
    page.on("request", (request) => {
      try {
        const url = new URL(request.url());
        if (
          url.origin === issuer.origin &&
          url.pathname === "/oauth/authorize"
        ) {
          trace.issuerRequests += 1;
          if (trace.issuerRequests > 1) trace.additionalIssuerRequests += 1;
          expectedState = url.searchParams.get("state");
          expectedNonce = url.searchParams.get("nonce");
          const requestNonce = expectedNonce;
          issuerCookieMetadataPromise = context
            .cookies(origin)
            .then((cookies) => {
              const nonceCookie = cookies.find(
                (cookie) => cookie.name === "oauth_nonce",
              );
              return Boolean(
                nonceCookie &&
                nonceCookie.value === requestNonce &&
                nonceCookie.httpOnly &&
                nonceCookie.sameSite === "Lax",
              );
            })
            .catch(() => false);
          return;
        }
        if (url.origin !== origin) return;
        if (
          url.pathname === "/api/auth/login/takos" &&
          request.method() === "GET"
        ) {
          trace.loginStarts += 1;
        }
        if (url.pathname === "/api/auth/callback/takos") {
          trace.callbackRequests += 1;
          callbackState = url.searchParams.get("state");
          callbackStateMatches = callbackState === expectedState;
          callbackErrorMatches =
            url.searchParams.get("error") === "access_denied" &&
            !url.searchParams.has("code");
        }
      } catch {
        // Browser internals and opaque URLs are outside the measured request set.
      }
    });

    await context.route("**/*", async (route) => {
      try {
        const request = route.request();
        const url = new URL(request.url());
        if (url.protocol === "data:" || url.protocol === "blob:") {
          await route.continue();
          return;
        }
        if (url.origin === origin) {
          await route.continue();
          return;
        }
        if (
          url.origin !== issuer.origin ||
          url.pathname !== "/oauth/authorize" ||
          request.method() !== "GET"
        ) {
          externalBrowserRequestsBlocked += 1;
          await route.abort();
          return;
        }

        if (trace.issuerRequests > 1) {
          await route.abort();
          return;
        }

        const params = url.searchParams;
        const redirectUri = `${origin}/api/auth/callback/takos`;
        const state = params.get("state") ?? "";
        const nonce = params.get("nonce") ?? "";
        const challenge = params.get("code_challenge") ?? "";
        const validAuthorizeRequest =
          params.get("response_type") === "code" &&
          params.get("client_id") === OIDC_RECOVERY_BINDINGS.OIDC_CLIENT_ID &&
          params.get("redirect_uri") === redirectUri &&
          params.get("scope") === "openid profile email" &&
          params.get("code_challenge_method") === "S256" &&
          /^[A-Za-z0-9_-]{43}$/.test(challenge) &&
          state.length >= 8 &&
          nonce.length >= 8;
        if (!validAuthorizeRequest) {
          invalidIssuerRequests += 1;
          await route.abort();
          return;
        }

        expectedState = state;
        expectedNonce = nonce;
        const cookies = await context.cookies(origin);
        const nonceCookie = cookies.find(
          (cookie) => cookie.name === "oauth_nonce",
        );
        issuerNonceCookieWasValid = Boolean(
          nonceCookie &&
          nonceCookie.value === nonce &&
          nonceCookie.httpOnly &&
          nonceCookie.sameSite === "Lax",
        );
        await route.continue();
      } catch {
        invalidIssuerRequests += 1;
        try {
          await route.abort();
        } catch {
          // Route may already be resolved by Playwright after navigation teardown.
        }
      }
    });

    let pageCallbackHeaders;
    if (!storageDenied)
      pageCallbackHeaders = callbackRequestPromise(page, origin);
    let initialNavigationFailed = false;
    try {
      phase = "initial-navigation";
      await page.goto(`${origin}/`, {
        waitUntil: "domcontentloaded",
        timeout: ROUTE_TIMEOUT_MS,
      });
    } catch {
      initialNavigationFailed = true;
    }

    if (storageDenied) {
      phase = "storage-denied-provider-link";
      const initialLink = await visibleProviderLink(page);
      mark(
        checks,
        trace.loginStarts === 0 && trace.issuerRequests === 0,
        "oidc-recovery-storage-denied-does-not-autostart",
      );
      mark(
        checks,
        !initialNavigationFailed,
        "oidc-recovery-storage-denied-login-page-loads",
      );
      mark(
        checks,
        (await initialLink.count()) === 1,
        "oidc-recovery-storage-denied-manual-provider-link",
      );
      phase = "storage-denied-empty-store";
      const initialCounts = await readCounts(db);
      mark(
        checks,
        isEmpty(initialCounts),
        "oidc-recovery-storage-denied-no-identity-effects-before-retry",
      );

      pageCallbackHeaders = callbackRequestPromise(page, origin);
      phase = "storage-denied-manual-click";
      await initialLink.click({ timeout: ROUTE_TIMEOUT_MS });
      phase = "storage-denied-callback-ui";
      await waitForCallbackUi(page, origin);
      phase = "storage-denied-callback-headers";
      const callbackHeaders = await pageCallbackHeaders;
      const noncePair = cookiePair(callbackHeaders?.cookie, "oauth_nonce");
      issuerNonceCookieWasValid = await issuerCookieMetadataPromise;
      let callbackNonceMatches = false;
      try {
        callbackNonceMatches =
          decodeURIComponent(noncePair ?? "") === expectedNonce;
      } catch {
        callbackNonceMatches = false;
      }
      callbackNonceWasSent = Boolean(
        callbackNonceMatches &&
        issuerNonceCookieWasValid &&
        callbackStateMatches &&
        issuer.matchesCallback({ state: callbackState, cookie: noncePair }),
      );
      phase = "storage-denied-final-counts";
      const finalCounts = await readCounts(db);
      await page.waitForTimeout(150);
      const issuerAfter = updateIssuerTrace(trace, issuer);
      const issuerDelta = {
        requests: issuerAfter.requests - issuerBefore.requests,
        validRequests: issuerAfter.validRequests - issuerBefore.validRequests,
        invalidRequests:
          issuerAfter.invalidRequests - issuerBefore.invalidRequests,
        refusedRequests:
          issuerAfter.refusedRequests - issuerBefore.refusedRequests,
      };

      mark(
        checks,
        trace.loginStarts === 1 && trace.issuerRequests === 1,
        "oidc-recovery-storage-denied-retry-navigates-once",
      );
      mark(
        checks,
        trace.callbackRequests === 1 && callbackStateMatches,
        "oidc-recovery-storage-denied-callback-preserves-state",
      );
      mark(
        checks,
        callbackErrorMatches,
        "oidc-recovery-storage-denied-callback-is-error-only",
      );
      mark(
        checks,
        issuerNonceCookieWasValid && callbackNonceWasSent,
        "oidc-recovery-browser-sends-lax-nonce-cookie-on-return",
      );
      mark(
        checks,
        trace.additionalIssuerRequests === 0,
        "oidc-recovery-storage-denied-does-not-loop-after-error",
      );
      mark(
        checks,
        issuerDelta.requests === 1 &&
          issuerDelta.validRequests === 1 &&
          issuerDelta.invalidRequests === 0 &&
          issuerDelta.refusedRequests === 0,
        "oidc-recovery-storage-denied-issuer-serves-one-valid-error",
      );
      mark(
        checks,
        invalidIssuerRequests === 0 && externalBrowserRequestsBlocked === 0,
        "oidc-recovery-browser-origin-boundary",
      );
      mark(
        checks,
        isEmpty(finalCounts),
        "oidc-recovery-storage-denied-error-creates-no-actor-or-session",
      );
      mark(
        checks,
        pageErrors === 0,
        "oidc-recovery-storage-denied-no-page-errors",
      );
      return {
        scenario,
        storageAccess: "denied-by-page-init-script",
        loginStarts: trace.loginStarts,
        issuerAuthorizeRequests: trace.issuerRequests,
        callbackRequests: trace.callbackRequests,
        additionalIssuerRequests: trace.additionalIssuerRequests,
        externalBrowserRequestsBlocked,
        invalidIssuerRequests,
        issuerServer: issuerDelta,
        nonceCookieSent: callbackNonceWasSent,
        finalCounts,
      };
    }

    phase = "working-storage-callback-ui";
    await waitForCallbackUi(page, origin);
    mark(
      checks,
      !initialNavigationFailed,
      "oidc-recovery-working-storage-navigation-completes",
    );
    mark(
      checks,
      trace.loginStarts === 1 && trace.issuerRequests === 1,
      "oidc-recovery-working-storage-autostarts-once",
    );
    phase = "working-storage-initial-counts";
    const initialCounts = await readCounts(db);
    mark(
      checks,
      isEmpty(initialCounts),
      "oidc-recovery-working-storage-initially-empty",
    );
    phase = "working-storage-callback-headers";
    const callbackHeaders = await pageCallbackHeaders;
    const noncePair = cookiePair(callbackHeaders?.cookie, "oauth_nonce");
    issuerNonceCookieWasValid = await issuerCookieMetadataPromise;
    let callbackNonceMatches = false;
    try {
      callbackNonceMatches =
        decodeURIComponent(noncePair ?? "") === expectedNonce;
    } catch {
      callbackNonceMatches = false;
    }
    callbackNonceWasSent = Boolean(
      callbackNonceMatches &&
      issuerNonceCookieWasValid &&
      callbackStateMatches &&
      issuer.matchesCallback({ state: callbackState, cookie: noncePair }),
    );
    const beforeReloadCounts = await readCounts(db);
    mark(
      checks,
      trace.callbackRequests === 1 && callbackStateMatches,
      "oidc-recovery-working-storage-callback-preserves-state",
    );
    mark(
      checks,
      callbackErrorMatches,
      "oidc-recovery-working-storage-callback-is-error-only",
    );
    mark(
      checks,
      issuerNonceCookieWasValid && callbackNonceWasSent,
      "oidc-recovery-working-storage-browser-sends-lax-nonce-cookie",
    );
    mark(
      checks,
      trace.additionalIssuerRequests === 0,
      "oidc-recovery-working-storage-error-does-not-loop",
    );
    mark(
      checks,
      isEmpty(beforeReloadCounts),
      "oidc-recovery-working-storage-error-creates-no-actor-or-session",
    );

    phase = "working-storage-reload";
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: ROUTE_TIMEOUT_MS,
    });
    await visibleProviderLink(page);
    await page.waitForTimeout(150);
    const issuerAfter = updateIssuerTrace(trace, issuer);
    const issuerDelta = {
      requests: issuerAfter.requests - issuerBefore.requests,
      validRequests: issuerAfter.validRequests - issuerBefore.validRequests,
      invalidRequests:
        issuerAfter.invalidRequests - issuerBefore.invalidRequests,
      refusedRequests:
        issuerAfter.refusedRequests - issuerBefore.refusedRequests,
    };
    phase = "working-storage-reload-counts";
    const afterReloadCounts = await readCounts(db);
    mark(
      checks,
      trace.loginStarts === 1 && trace.issuerRequests === 1,
      "oidc-recovery-same-tab-reload-does-not-autostart-again",
    );
    mark(
      checks,
      issuerDelta.requests === 1 &&
        issuerDelta.validRequests === 1 &&
        issuerDelta.invalidRequests === 0 &&
        issuerDelta.refusedRequests === 0,
      "oidc-recovery-working-storage-issuer-serves-one-valid-error",
    );
    mark(
      checks,
      isEmpty(afterReloadCounts),
      "oidc-recovery-same-tab-reload-keeps-no-identity-effects",
    );
    mark(
      checks,
      externalBrowserRequestsBlocked === 0 && invalidIssuerRequests === 0,
      "oidc-recovery-working-storage-browser-origin-boundary",
    );
    mark(
      checks,
      pageErrors === 0,
      "oidc-recovery-working-storage-no-page-errors",
    );
    return {
      scenario,
      storageAccess: "available",
      loginStarts: trace.loginStarts,
      issuerAuthorizeRequests: trace.issuerRequests,
      callbackRequests: trace.callbackRequests,
      additionalIssuerRequests: trace.additionalIssuerRequests,
      externalBrowserRequestsBlocked,
      invalidIssuerRequests,
      issuerServer: issuerDelta,
      nonceCookieSent: callbackNonceWasSent,
      countsAfterError: beforeReloadCounts,
      countsAfterReload: afterReloadCounts,
    };
  } catch (error) {
    primaryError = error;
    updateIssuerTrace(trace, issuer);
    if (error instanceof RecoveryAssertionError) {
      throw new RecoveryAssertionError(error.code, trace);
    }
    throw new RecoveryAssertionError(`${scenario}-${phase}`, trace);
  } finally {
    try {
      await context?.close();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      if (primaryError) {
        process.stderr.write(
          "browser-oidc-recovery:secondary-context-cleanup-failed\n",
        );
      } else {
        throw new RecoveryAssertionError(
          `${scenario}-context-cleanup-failed`,
          trace,
        );
      }
    }
  }
}

export async function qualifyBrowserOidcRecovery({
  browser,
  worker,
  db,
  origin,
  issuer,
  checks,
}) {
  try {
    const appOrigin = new URL(origin).origin;
    requireEffect(Array.isArray(checks), "checks-array-required");
    requireEffect(
      appOrigin === origin.replace(/\/$/, ""),
      "origin-must-be-canonical",
    );
    requireEffect(
      issuer &&
        issuer.origin === new URL(issuer.origin).origin &&
        issuer.origin.startsWith("http://localhost:"),
      "loopback-issuer-required",
    );
    try {
      await worker.ready;
    } catch {
      throw new RecoveryAssertionError("worker-not-ready");
    }

    const storageDenied = await runScenario({
      browser,
      db,
      origin: appOrigin,
      issuer,
      storageDenied: true,
      checks,
      scenario: "session-storage-denied",
    });
    const workingStorage = await runScenario({
      browser,
      db,
      origin: appOrigin,
      issuer,
      storageDenied: false,
      checks,
      scenario: "session-storage-available",
    });
    let finalCounts;
    try {
      finalCounts = await readCounts(db);
    } catch {
      throw new RecoveryAssertionError("final-native-count-read-failed");
    }
    requireEffect(
      isEmpty(finalCounts),
      "oidc-error-scenarios-created-identity-state",
    );
    const issuerCounts = issuer.snapshot();
    requireEffect(
      issuerCounts.requests === 2 &&
        issuerCounts.validRequests === 2 &&
        issuerCounts.invalidRequests === 0 &&
        issuerCounts.refusedRequests === 0,
      "issuer-final-request-counts-unexpected",
    );
    checks.push("oidc-recovery-final-actors-and-sessions-empty");

    return {
      kind: "yurucommu.release-browser-oidc-recovery@v1",
      scope:
        "actual Chrome navigation through the product Worker and a synthetic OIDC authorization error; no token success or live issuer claim",
      issuerOrigin: issuer.origin,
      ownerSubAlias: "pinned-synthetic-owner",
      storageDenied,
      workingStorage,
      finalCounts,
      issuerServer: issuerCounts,
      checks: [...checks],
      limitations: [
        "This proves browser error recovery and redirect-cookie behavior only; it does not prove signed ID-token success or real Takosumi integration.",
        "The synthetic issuer supplies only an authorization-error redirect. Worker token/JWKS/userinfo calls are not part of this proof.",
        "The loopback fixture does not qualify public TLS, deployed cookie policy, or remote federation.",
      ],
    };
  } catch (error) {
    if (error instanceof RecoveryAssertionError) throw error;
    throw new RecoveryAssertionError("qualification-unexpected-failure");
  }
}
