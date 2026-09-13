import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import {
  awaitManagedBrowserClose,
  readLiveAccountsSubject,
  readManagedStagingConfig,
  readSecretFile,
  runManagedStagingE2E,
  type ManagedAppSessionOperator,
} from "./takosumi-managed-staging-e2e.ts";

const SESSION_ME = "/api/v1/account/session/me";
const CALLBACK = "/api/auth/callback/takos";
const AUTH_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const ACCOUNTS_COOKIE = "takosumi_session";

export interface ManagedBrowserConfig {
  readonly executablePath: string;
  /** A real Accounts browser cookie, never an app cookie or API bearer. */
  readonly accountsCookieFile: string;
}

export function readManagedBrowserConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ManagedBrowserConfig {
  const path = (name: string) => {
    const value = environment[name];
    if (!value || !isAbsolute(value) || /[\r\n\0]/u.test(value)) {
      throw new Error(`${name} must be an absolute path`);
    }
    return value;
  };
  // Playwright debugging may print cookies and authorization URLs. Do not
  // inherit a diagnostic mode into a credential-bearing browser invocation.
  if (environment.DEBUG || environment.PWDEBUG) {
    throw new Error("Disable DEBUG and PWDEBUG for managed browser E2E");
  }
  return {
    executablePath: path("TAKOSUMI_STAGING_BROWSER_EXECUTABLE"),
    accountsCookieFile: path("TAKOSUMI_STAGING_ACCOUNTS_COOKIE_FILE"),
  };
}

function origin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Managed browser requires an exact HTTPS origin");
  return url;
}

/** One real browser/context spans both identity preflight and app login. */
export function createManagedBrowserSessionOperator(
  config: ManagedBrowserConfig,
  launch: typeof chromium.launch = (options) => chromium.launch(options),
): ManagedAppSessionOperator {
  if (process.env.DEBUG || process.env.PWDEBUG) {
    throw new Error("Disable DEBUG and PWDEBUG for managed browser E2E");
  }
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let home: string | undefined;
  let creating: Promise<void> | undefined;
  let accounts: URL | undefined;
  let subject: string | undefined;
  let used = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let allowedApp: URL | undefined;
  let violation = false;
  let loginSeen = false;
  let authorizeState: string | undefined;
  let callbackSeen = false;

  async function close(): Promise<void> {
    closed = true;
    closing ??= (async () => {
      // Shutdown cannot be acknowledged while browser/context creation may
      // still publish a late handle. The runner bounds this wait separately.
      await creating?.catch(() => undefined);
      try {
        await context?.close();
      } finally {
        try {
          await browser?.close();
        } finally {
          if (home) await rm(home, { recursive: true, force: true });
        }
      }
    })().catch(() => {
      throw new Error("Managed browser cleanup failed");
    });
    await closing;
  }

  async function bounded<T>(
    signal: AbortSignal,
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted || closed) {
      await close().catch(() => undefined);
      throw new Error(label);
    }
    const abort = () => {
      void close().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await operation();
      if (signal.aborted || closed) throw new Error(label);
      return result;
    } catch {
      // Browser errors include URLs (code/state) and call arguments (cookies).
      // Do not preserve their message, stack, cause or arbitrary diagnostics.
      await close().catch(() => undefined);
      throw new Error(label);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async function createGuardedPage(): Promise<Page> {
    const page = await context!.newPage();
    const cdp = await context!.newCDPSession(page);
    // Chromium's Fetch pause includes redirect hops; Playwright route does
    // not. Keep this check before continueRequest, never in a post-send event.
    cdp.on("Fetch.requestPaused", async (event) => {
      try {
        const url = new URL(event.request.url);
        if (
          url.username ||
          url.password ||
          url.protocol !== "https:" ||
          (url.origin !== accounts!.origin && url.origin !== allowedApp?.origin)
        ) {
          throw new Error("Unexpected browser origin");
        }
        const navigation =
          event.resourceType === "Document" && event.request.method === "GET";
        if (
          url.origin === accounts!.origin &&
          url.pathname === "/oauth/authorize"
        ) {
          if (
            !navigation ||
            !allowedApp ||
            !loginSeen ||
            authorizeState ||
            url.searchParams.getAll("state").length !== 1 ||
            !url.searchParams.get("state") ||
            url.searchParams.getAll("redirect_uri").length !== 1 ||
            url.searchParams.get("redirect_uri") !==
              new URL(CALLBACK, allowedApp).href
          ) {
            throw new Error("Unexpected authorization navigation");
          }
          authorizeState = url.searchParams.get("state")!;
        } else if (
          url.origin === accounts!.origin &&
          url.pathname !== SESSION_ME &&
          url.pathname !== "/favicon.ico"
        ) {
          throw new Error("Unexpected Accounts navigation");
        }
        if (url.origin === allowedApp?.origin) {
          if (url.pathname === "/api/auth/login/takos") {
            if (!navigation || loginSeen)
              throw new Error("Unexpected login navigation");
            loginSeen = true;
          }
          if (url.pathname === CALLBACK) {
            if (
              !navigation ||
              !authorizeState ||
              callbackSeen ||
              url.searchParams.getAll("state").length !== 1 ||
              url.searchParams.get("state") !== authorizeState ||
              url.searchParams.getAll("code").length !== 1 ||
              !url.searchParams.get("code") ||
              url.searchParams.has("error")
            ) {
              throw new Error("Unexpected OIDC callback");
            }
            if (
              (await context!.cookies(allowedApp.href)).some(
                (cookie) => cookie.name === "session",
              )
            ) {
              throw new Error("App session existed before the callback");
            }
            callbackSeen = true;
          }
        }
        await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
      } catch {
        violation = true;
        await cdp
          .send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          })
          .catch(() => undefined);
      }
    });
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    return page;
  }

  return {
    close,
    async preflightAccountsIdentity(input) {
      return bounded(
        input.signal,
        "Accounts browser preflight failed",
        async () => {
          if (accounts || used)
            throw new Error("Browser preflight is single-use");
          accounts = origin(input.accountsOrigin);
          creating = (async () => {
            home = await mkdtemp(join(tmpdir(), "yurucommu-managed-browser-"));
            await chmod(home, 0o700);
            if (closed) return;
            browser = await launch({
              executablePath: config.executablePath,
              headless: true,
              timeout: Math.min(AUTH_TIMEOUT_MS, 30_000),
              downloadsPath: home,
              tracesDir: home,
              env: {
                PATH: "/usr/local/bin:/usr/bin:/bin",
                HOME: home,
                TMPDIR: home,
                TMP: home,
                TEMP: home,
                XDG_CONFIG_HOME: join(home, ".config"),
                XDG_CACHE_HOME: join(home, ".cache"),
                LANG: "C.UTF-8",
                TZ: "UTC",
              },
              args: ["--disable-dev-shm-usage", "--no-proxy-server"],
            });
            if (closed) return;
            context = await browser.newContext({
              ignoreHTTPSErrors: false,
              acceptDownloads: false,
              serviceWorkers: "block",
              locale: "ja-JP",
            });
            context.setDefaultTimeout(AUTH_TIMEOUT_MS);
            context.setDefaultNavigationTimeout(AUTH_TIMEOUT_MS);
          })();
          await creating;
          if (closed || input.signal.aborted || !context)
            throw new Error("Browser startup cancelled");
          const raw = await readSecretFile(
            config.accountsCookieFile,
            "Accounts browser cookie",
          );
          const match = /^takosumi_session=(sess_[A-Za-z0-9_-]{1,256})$/u.exec(
            raw,
          );
          if (!match)
            throw new Error("Expected canonical Accounts session cookie");
          await context.addCookies([
            {
              name: ACCOUNTS_COOKIE,
              value: match[1]!,
              url: accounts.origin,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ]);
          const page = await createGuardedPage();
          const response = await page.goto(new URL(SESSION_ME, accounts).href, {
            waitUntil: "domcontentloaded",
          });
          if (
            !response ||
            response.status() !== 200 ||
            response.url() !== new URL(SESSION_ME, accounts).href ||
            violation
          ) {
            throw new Error("Accounts session is unavailable");
          }
          const body = await response.body();
          if (body.byteLength > MAX_RESPONSE_BYTES)
            throw new Error("Accounts response is too large");
          const me: unknown = JSON.parse(body.toString("utf8"));
          if (readLiveAccountsSubject(me) !== input.expectedSubject) {
            throw new Error("Accounts identity mismatch");
          }
          subject = input.expectedSubject;
          await page.close();
        },
      );
    },
    async acquireAppSession(input) {
      return bounded(
        input.signal,
        "Installed app browser login failed",
        async () => {
          if (
            !context ||
            !accounts ||
            !subject ||
            subject !== input.expectedSubject ||
            used
          ) {
            throw new Error("Accounts preflight is required once");
          }
          used = true;
          allowedApp = origin(input.launchUrl);
          if (
            allowedApp.origin === accounts.origin ||
            input.callbackUrl !== new URL(CALLBACK, allowedApp).href
          ) {
            throw new Error("Unexpected installed app callback");
          }
          if (
            (await context.cookies(allowedApp.href)).some(
              (cookie) =>
                cookie.name === ACCOUNTS_COOKIE || cookie.name === "session",
            )
          ) {
            throw new Error(
              "Fresh app must not receive preexisting session cookies",
            );
          }
          const page = await createGuardedPage();
          const callback = page
            .waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.origin === allowedApp!.origin && url.pathname === CALLBACK
              );
            })
            .catch(() => undefined);
          const authenticated = page
            .waitForResponse(
              (response) =>
                response.url() === new URL("/api/auth/me", allowedApp).href &&
                response.status() === 200,
            )
            .catch(() => undefined);
          const response = await page.goto(allowedApp.href, {
            waitUntil: "domcontentloaded",
          });
          const [callbackResponse, meResponse] = await Promise.all([
            callback,
            authenticated,
          ]);
          if (
            !response ||
            response.status() >= 400 ||
            !callbackResponse ||
            callbackResponse.status() !== 302 ||
            !meResponse ||
            !loginSeen ||
            !authorizeState ||
            !callbackSeen ||
            violation
          ) {
            throw new Error("Normal browser OIDC journey did not complete");
          }
          const callbackSession = readCallbackSession(
            await callbackResponse.headersArray(),
          );
          const callbackLocation =
            await callbackResponse.headerValue("location");
          if (
            callbackLocation !== "/" &&
            callbackLocation !== allowedApp.href
          ) {
            throw new Error("Callback did not return to the installed app");
          }
          const cookies = (await context.cookies(allowedApp.href)).filter(
            (cookie) => cookie.name === "session",
          );
          const cookie = cookies[0];
          if (
            cookies.length !== 1 ||
            !cookie ||
            cookie.domain !== allowedApp.hostname ||
            cookie.path !== "/" ||
            !cookie.httpOnly ||
            !cookie.secure ||
            cookie.sameSite !== "Strict" ||
            cookie.value !== callbackSession ||
            !/^[A-Za-z0-9._~-]{1,4096}$/u.test(cookie.value)
          ) {
            throw new Error("Callback did not mint an app-scoped session");
          }
          // The runner independently qualifies provider/owner/AP-ID via its
          // pinned product transport before any product mutation.
          await page.close();
          return { sessionCookie: `session=${cookie.value}` };
        },
      );
    },
  };
}

/** Require the pinned Core callback to mint the observed host-only cookie. */
function readCallbackSession(
  headers: readonly { name: string; value: string }[],
): string {
  const cookies = headers.filter(
    (header) => header.name.toLowerCase() === "set-cookie",
  );
  const sessionHeaders = cookies.filter((header) =>
    header.value.startsWith("session="),
  );
  const nonceHeaders = cookies.filter((header) =>
    header.value.startsWith("oauth_nonce="),
  );
  if (sessionHeaders.length !== 1 || nonceHeaders.length !== 1) {
    throw new Error("Callback session and nonce deletion were not established");
  }
  const parse = (header: string) => {
    if (/[\r\n\0]/u.test(header)) throw new Error("Invalid callback cookie");
    const [pair, ...parts] = header.split(";").map((part) => part.trim());
    const attributes = new Map<string, string>();
    for (const part of parts) {
      const index = part.indexOf("=");
      const key = (index < 0 ? part : part.slice(0, index)).toLowerCase();
      const value = index < 0 ? "" : part.slice(index + 1);
      if (attributes.has(key))
        throw new Error("Duplicate callback cookie attribute");
      attributes.set(key, value);
    }
    if (attributes.has("domain") || attributes.get("path") !== "/") {
      throw new Error("Callback cookie was not host scoped");
    }
    return { pair, attributes };
  };
  const session = parse(sessionHeaders[0]!.value);
  const match = /^session=([A-Za-z0-9._~-]{1,4096})$/u.exec(session.pair!);
  if (
    !match ||
    session.attributes.get("secure") !== "" ||
    session.attributes.get("httponly") !== "" ||
    session.attributes.get("samesite")?.toLowerCase() !== "strict" ||
    !/^[1-9][0-9]*$/u.test(session.attributes.get("max-age") ?? "")
  ) {
    throw new Error("Callback did not mint a Strict app session");
  }
  const nonce = parse(nonceHeaders[0]!.value);
  if (
    nonce.pair !== "oauth_nonce=" ||
    nonce.attributes.get("max-age") !== "0"
  ) {
    throw new Error("Callback did not delete the login nonce");
  }
  return match[1]!;
}

/** Never return a receipt to the CLI until browser shutdown is acknowledged. */
export async function runWithManagedBrowser<T>(
  operator: { close(): Promise<void> },
  run: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let failed = false;
  let primaryError: unknown;
  try {
    result = await run();
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  try {
    await awaitManagedBrowserClose(() => operator.close());
  } catch {
    const cleanupError = new Error("Managed browser cleanup failed");
    if (failed)
      throw new AggregateError(
        [primaryError, cleanupError],
        "Managed E2E and browser cleanup failed",
      );
    throw cleanupError;
  }
  if (failed) throw primaryError;
  return result as T;
}

if (import.meta.main) {
  const config = readManagedStagingConfig(process.env);
  const operator = createManagedBrowserSessionOperator(
    readManagedBrowserConfig(process.env),
  );
  const result = await runWithManagedBrowser(operator, () =>
    runManagedStagingE2E(config, operator),
  );
  console.log(JSON.stringify(result));
}
