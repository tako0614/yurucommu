import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Browser,
  BrowserContext,
  Response as BrowserResponse,
} from "playwright-core";
import {
  createManagedBrowserSessionOperator,
  readManagedBrowserConfig,
  runWithManagedBrowser,
} from "./takosumi-managed-staging-browser.ts";

const ACCOUNTS = "https://accounts.example.test";
const APP = "https://installed.example.test";
const CALLBACK = `${APP}/api/auth/callback/takos`;
const SUBJECT = "tsub_browser_test";

/** External browser port only; runner/product authorization is tested separately. */
function browserFixture(
  options: {
    subject?: string;
    cookie?: string;
    callbackState?: string;
    externalNavigation?: boolean;
    preCallbackAppCookie?: boolean;
    callbackSessionCookie?: boolean;
    callbackSameSite?: "Strict" | "Lax";
  } = {},
) {
  const events: string[] = [];
  const cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: "Strict" | "Lax";
  }[] = [];
  type PausedRequest = {
    requestId: string;
    request: { url: string; method: string };
    resourceType: "Document";
  };
  type PausedRequestHandler = (event: PausedRequest) => void | Promise<void>;
  type PendingRequest = {
    url: string;
    resolve: (continued: boolean) => void;
  };
  const pendingRequests = new Map<string, PendingRequest>();
  let handlePaused: PausedRequestHandler | undefined;
  let nextRequestId = 0;
  const response = (
    url: string,
    status: number,
    value: unknown = {},
    headers: readonly { name: string; value: string }[] = [],
  ) =>
    ({
      url: () => url,
      status: () => status,
      body: async () => Buffer.from(JSON.stringify(value)),
      headersArray: async () => headers,
      headerValue: async (name: string) =>
        headers.find(
          (header) => header.name.toLowerCase() === name.toLowerCase(),
        )?.value ?? null,
    }) as BrowserResponse;
  async function dispatch(url: string) {
    if (!handlePaused) throw new Error("CDP request handler was not installed");
    const requestId = `request-${++nextRequestId}`;
    const continued = new Promise<boolean>((resolve) => {
      pendingRequests.set(requestId, { url, resolve });
    });
    try {
      await handlePaused({
        requestId,
        request: { url, method: "GET" },
        resourceType: "Document",
      });
    } catch {
      const pending = pendingRequests.get(requestId);
      if (pending) {
        pendingRequests.delete(requestId);
        events.push("blocked");
        pending.resolve(false);
      }
    }
    return continued;
  }
  const cdpSession = {
    on: (event: string, handler: PausedRequestHandler) => {
      expect(event).toBe("Fetch.requestPaused");
      handlePaused = handler;
    },
    send: async (method: string, params: { requestId?: string }) => {
      if (method === "Fetch.enable") {
        events.push("cdp-enabled");
        return;
      }
      if (method === "Fetch.disable") return;
      const requestId = params.requestId;
      const pending = requestId ? pendingRequests.get(requestId) : undefined;
      if (!pending) throw new Error(`unknown CDP request ${requestId ?? ""}`);
      pendingRequests.delete(requestId!);
      if (method === "Fetch.continueRequest") {
        events.push(new URL(pending.url).pathname);
        pending.resolve(true);
        return;
      }
      if (method === "Fetch.failRequest") {
        events.push("blocked");
        pending.resolve(false);
        return;
      }
      throw new Error(`unexpected CDP command ${method}`);
    },
  };
  const context = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    addCookies: async (
      input: {
        name: string;
        value: string;
        url: string;
        sameSite?: "Strict" | "Lax";
      }[],
    ) => {
      cookies.push(
        ...input.map((cookie) => ({
          ...cookie,
          domain: new URL(cookie.url).hostname,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: cookie.sameSite ?? "Lax",
        })),
      );
      events.push("accounts-cookie-added");
    },
    cookies: async (url: string) =>
      cookies.filter((cookie) => cookie.domain === new URL(url).hostname),
    newCDPSession: async () => cdpSession,
    newPage: async () => {
      const waiting: {
        predicate: (r: BrowserResponse) => boolean;
        resolve: (r: BrowserResponse | undefined) => void;
      }[] = [];
      const emit = (r: BrowserResponse) => {
        for (const wait of waiting) if (wait.predicate(r)) wait.resolve(r);
      };
      return {
        waitForResponse: (predicate: (r: BrowserResponse) => boolean) =>
          new Promise((resolve) => waiting.push({ predicate, resolve })),
        goto: async (url: string) => {
          await dispatch(url);
          if (new URL(url).origin === ACCOUNTS) {
            return response(url, 200, {
              subject: options.subject ?? SUBJECT,
              createdAt: Date.now() - 1_000,
              expiresAt: Date.now() + 60_000,
            });
          }
          if (options.preCallbackAppCookie) {
            cookies.push({
              name: "session",
              value: "pre-callback-app-cookie",
              domain: new URL(APP).hostname,
              path: "/",
              secure: true,
              httpOnly: true,
              sameSite: "Strict",
            });
          }
          await dispatch(`${APP}/api/auth/login/takos`);
          if (options.externalNavigation)
            await dispatch("https://outside.example.test/?code=secret-code");
          await dispatch(
            `${ACCOUNTS}/oauth/authorize?state=run-state&redirect_uri=${encodeURIComponent(CALLBACK)}`,
          );
          const callbackUrl = `${CALLBACK}?state=${options.callbackState ?? "run-state"}&code=secret-code`;
          if (await dispatch(callbackUrl)) {
            if (options.callbackSessionCookie !== false) {
              cookies.push({
                name: "session",
                value: "opaque-app-session",
                domain: new URL(APP).hostname,
                path: "/",
                secure: true,
                httpOnly: true,
                sameSite: options.callbackSameSite ?? "Strict",
              });
            }
            const callbackHeaders = [
              ...(options.callbackSessionCookie === false
                ? []
                : [
                    {
                      name: "set-cookie",
                      value: `session=opaque-app-session; Path=/; Secure; HttpOnly; SameSite=${options.callbackSameSite ?? "Strict"}; Max-Age=2592000`,
                    },
                  ]),
              {
                name: "set-cookie",
                value: "oauth_nonce=; Path=/; Max-Age=0",
              },
              { name: "location", value: "/" },
            ];
            emit(response(callbackUrl, 302, {}, callbackHeaders));
            emit(response(`${APP}/api/auth/me`, 200));
          } else {
            for (const wait of waiting) wait.resolve(undefined);
          }
          return response(url, 200);
        },
        close: async () => {
          events.push("page-closed");
        },
      };
    },
    close: async () => {
      events.push("context-closed");
    },
  } as unknown as BrowserContext;
  const browser = {
    newContext: async (config: unknown) => {
      events.push("context-created");
      expect(config).toMatchObject({
        ignoreHTTPSErrors: false,
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      return context;
    },
    close: async () => {
      events.push("browser-closed");
    },
  } as unknown as Browser;
  return { browser, events, cookies };
}

async function fixture(
  options: Parameters<typeof browserFixture>[0],
  run: (
    operator: ReturnType<typeof createManagedBrowserSessionOperator>,
    fixture: ReturnType<typeof browserFixture>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "yuru-browser-test-"));
  await chmod(directory, 0o700);
  const cookieFile = join(directory, "accounts-cookie");
  await writeFile(
    cookieFile,
    options?.cookie ?? "takosumi_session=sess_real-browser-test",
    { mode: 0o600 },
  );
  const browser = browserFixture(options);
  const operator = createManagedBrowserSessionOperator(
    { executablePath: "/test/chrome", accountsCookieFile: cookieFile },
    async (input) => {
      browser.events.push("browser-launched");
      expect(input?.env).not.toHaveProperty(
        "TAKOSUMI_STAGING_SESSION_TOKEN_FILE",
      );
      return browser.browser;
    },
  );
  try {
    await run(operator, browser);
  } finally {
    await operator.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const preflight = {
  accountsOrigin: ACCOUNTS,
  expectedSubject: SUBJECT,
  signal: new AbortController().signal,
};
const acquire = {
  launchUrl: APP,
  callbackUrl: CALLBACK,
  expectedSubject: SUBJECT,
  signal: new AbortController().signal,
};

describe("managed real-browser composition", () => {
  test("requires explicit browser and independent Accounts cookie configuration", () => {
    const env = {
      TAKOSUMI_STAGING_BROWSER_EXECUTABLE: "/test/chrome",
      TAKOSUMI_STAGING_ACCOUNTS_COOKIE_FILE: "/private/accounts-cookie",
    };
    expect(readManagedBrowserConfig(env).accountsCookieFile).toBe(
      env.TAKOSUMI_STAGING_ACCOUNTS_COOKIE_FILE,
    );
    expect(() =>
      readManagedBrowserConfig({
        ...env,
        TAKOSUMI_STAGING_BROWSER_EXECUTABLE: "chrome",
      }),
    ).toThrow("absolute path");
    expect(() => readManagedBrowserConfig({ ...env, DEBUG: "pw:api" })).toThrow(
      "Disable DEBUG",
    );
    expect(() => readManagedBrowserConfig({ ...env, PWDEBUG: "1" })).toThrow(
      "Disable DEBUG",
    );
  });

  test("preflights the real Accounts identity then obtains only a fresh app cookie", async () => {
    let events: string[] = [];
    await fixture({}, async (operator, browser) => {
      events = browser.events;
      await operator.preflightAccountsIdentity(preflight);
      expect(events).not.toContain("/api/auth/login/takos");
      expect(await operator.acquireAppSession(acquire)).toEqual({
        sessionCookie: "session=opaque-app-session",
      });
      expect(events.indexOf("/api/v1/account/session/me")).toBeLessThan(
        events.indexOf("/api/auth/login/takos"),
      );
      expect(events).toContain("cdp-enabled");
      expect(events).toContain("/oauth/authorize");
      expect(events).toContain("/api/auth/callback/takos");
      expect(
        browser.cookies.find((cookie) => cookie.name === "takosumi_session")
          ?.domain,
      ).toBe(new URL(ACCOUNTS).hostname);
      await expect(operator.acquireAppSession(acquire)).rejects.toThrow(
        "Installed app browser login failed",
      );
    });
    expect(events.slice(-2)).toEqual(["context-closed", "browser-closed"]);
  });

  test.each([
    { subject: "another-account" },
    { cookie: "session=preexisting-app-cookie" },
    { cookie: "takosumi_session=sess_test; injected=secret" },
  ])(
    "rejects a wrong Accounts identity or credential kind without leaking it",
    async (options) => {
      await fixture(options, async (operator, browser) => {
        await expect(
          operator.preflightAccountsIdentity(preflight),
        ).rejects.toThrow("Accounts browser preflight failed");
        expect(browser.events).not.toContain("/api/auth/login/takos");
      });
    },
  );

  test("requires preflight before an app session", async () => {
    await fixture({}, async (operator, browser) => {
      await expect(operator.acquireAppSession(acquire)).rejects.toThrow(
        "Installed app browser login failed",
      );
      expect(browser.events).toEqual([]);
    });
  });

  test("requires the exact derived callback after preflight", async () => {
    await fixture({}, async (operator, browser) => {
      await operator.preflightAccountsIdentity(preflight);
      await expect(
        operator.acquireAppSession({
          ...acquire,
          callbackUrl: "https://wrong.example.test/callback",
        }),
      ).rejects.toThrow("Installed app browser login failed");
      expect(browser.events).not.toContain("/api/auth/login/takos");
    });
  });

  test.each([
    { callbackState: "different-state" },
    { externalNavigation: true },
  ])("rejects a callback mismatch or origin escape", async (options) => {
    await fixture(options, async (operator, browser) => {
      await operator.preflightAccountsIdentity(preflight);
      await expect(operator.acquireAppSession(acquire)).rejects.toThrow(
        "Installed app browser login failed",
      );
      expect(browser.events).toContain("blocked");
    });
  });

  test.each([
    { callbackSessionCookie: false },
    { callbackSameSite: "Lax" as const },
  ])(
    "rejects an app cookie/header that is not a fresh Strict callback session",
    async (options) => {
      await fixture(options, async (operator, browser) => {
        await operator.preflightAccountsIdentity(preflight);
        await expect(operator.acquireAppSession(acquire)).rejects.toThrow(
          "Installed app browser login failed",
        );
        expect(browser.events).not.toContain("/api/auth/me");
      });
    },
  );

  test("blocks the callback if the fresh app gains a session before that callback", async () => {
    await fixture({ preCallbackAppCookie: true }, async (operator, browser) => {
      await operator.preflightAccountsIdentity(preflight);
      await expect(operator.acquireAppSession(acquire)).rejects.toThrow(
        "Installed app browser login failed",
      );
      expect(browser.events).toContain("/api/auth/login/takos");
      expect(browser.events).toContain("/oauth/authorize");
      expect(browser.events).toContain("blocked");
      expect(browser.events).not.toContain("/api/auth/callback/takos");
      expect(browser.events).not.toContain("/api/auth/me");
    });
  });

  test("closes the browser before reporting a failed adapter operation", async () => {
    await fixture({ subject: "another-account" }, async (operator, browser) => {
      await expect(
        operator.preflightAccountsIdentity(preflight),
      ).rejects.toThrow("Accounts browser preflight failed");
      const contextClosed = browser.events.indexOf("context-closed");
      const browserClosed = browser.events.indexOf("browser-closed");
      expect(contextClosed).toBeGreaterThanOrEqual(0);
      expect(browserClosed).toBeGreaterThan(contextClosed);
      await expect(
        operator.preflightAccountsIdentity(preflight),
      ).rejects.toThrow("Accounts browser preflight failed");
    });
  });

  test("closes before returning a successful managed-browser result", async () => {
    const events: string[] = [];
    const result = await runWithManagedBrowser(
      {
        close: async () => {
          events.push("close");
        },
      },
      async () => {
        events.push("run");
        return { status: "passed", receipt: "private-receipt" };
      },
    );
    events.push("result");
    expect(events).toEqual(["run", "close", "result"]);
    expect(result.status).toBe("passed");
  });

  test("does not return a receipt when browser close fails", async () => {
    const events: string[] = [];
    const error = await runWithManagedBrowser(
      {
        close: async () => {
          events.push("close");
          throw new Error("browser close private detail");
        },
      },
      async () => {
        events.push("run");
        return { status: "passed", receipt: "private-receipt" };
      },
    ).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(events).toEqual(["run", "close"]);
    expect(String(error)).not.toContain("private-receipt");
    expect(String(error)).not.toContain("browser close private detail");
  });

  test("retains the original failure when browser close also fails", async () => {
    const events: string[] = [];
    const original = new Error("functional probe failed");
    const error = await runWithManagedBrowser(
      {
        close: async () => {
          events.push("close");
          throw new Error("browser close private detail");
        },
      },
      async () => {
        events.push("run");
        throw original;
      },
    ).catch((value) => value);
    if (!(error instanceof AggregateError)) {
      throw new Error("runWithManagedBrowser did not aggregate both failures");
    }
    expect(error.errors).toContain(original);
    expect(String(error)).not.toContain("browser close private detail");
    expect(events).toEqual(["run", "close"]);
  });

  test("an already-aborted operation never starts a browser", async () => {
    await fixture({}, async (operator, browser) => {
      const abort = new AbortController();
      abort.abort("private diagnostic");
      await expect(
        operator.preflightAccountsIdentity({
          ...preflight,
          signal: abort.signal,
        }),
      ).rejects.toThrow("Accounts browser preflight failed");
      expect(browser.events).toEqual([]);
    });
  });
});
