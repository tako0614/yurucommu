import { chromium } from "playwright-core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE_SOURCE_SHA = "ed81c5b52745fc355f577e9a75aa670e61a0e8d7";
const SEARCH_QUERY = "アルゴリズム";
const NEXT_QUERY = "会場の写真";
const LONG_IDENTITY =
  "reader@layout-actor-identity-0000000000000000000000000000000000000000000000000000000000000000.example.test";
const EMPTY_POST_QUERY = "Akari";
const BROWSER_EXECUTABLE =
  process.env.CHROME_BIN ?? "/opt/google/chrome/chrome";
const REQUEST_TIMEOUT_MS = 15_000;

class CheckFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new CheckFailure(message);
}

function defer() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function safeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
  };
}

function makeUrl(base, pathname, params = {}) {
  const url = new URL(pathname, base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

async function run(baseUrlArg, evidenceDirArg) {
  let localPostIds;
  const result = {
    baseSource: BASE_SOURCE_SHA,
    baseURL: baseUrlArg,
    evidenceDir: evidenceDirArg,
    browserExecutable: BROWSER_EXECUTABLE,
    runtime: "built-in dev:mock only; local seeded posts post-1/post-2",
    queries: {},
    longIdentity: LONG_IDENTITY,
    externalRequestsBlocked: [],
    websocketRequestsBlocked: [],
    nonGetRequestsBlocked: [],
    checks: [],
  };
  let base;
  let context;
  let profileDir;
  let activeDelay;
  let page;

  try {
    base = new URL(baseUrlArg);
    assert(
      base.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(base.hostname) &&
        !base.username &&
        !base.password,
      "baseURL must be an unauthenticated loopback HTTP URL",
    );
    base.pathname = "/";
    base.search = "";
    base.hash = "";
    const baseOrigin = base.origin;
    localPostIds = {
      [SEARCH_QUERY]: new URL("/ap/notes/post-1", base).href,
      [NEXT_QUERY]: new URL("/ap/notes/post-2", base).href,
    };
    result.queries = {
      [SEARCH_QUERY]: localPostIds[SEARCH_QUERY],
      [NEXT_QUERY]: localPostIds[NEXT_QUERY],
      [EMPTY_POST_QUERY]: "built-in actor match; no matching seeded post",
    };
    const localApId =
      "https://" + LONG_IDENTITY.split("@")[1] + "/ap/users/reader";
    const expectedDetailHref = `/profile/${encodeURIComponent(localApId)}`;
    const postHref = (apId) => `/post/${encodeURIComponent(apId)}`;

    await mkdir(evidenceDirArg, { recursive: true, mode: 0o700 });
    const tempRoot = process.env.TMPDIR || tmpdir();
    profileDir = await mkdtemp(join(tempRoot, "yurucommu-ux-search-profile-"));
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: BROWSER_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      viewport: { width: 1280, height: 800 },
      locale: "ja-JP",
      serviceWorkers: "block",
    });
    result.profileDir = profileDir;
    result.headless = true;

    await context.route("**/*", async (route) => {
      const request = route.request();
      let url;
      try {
        url = new URL(request.url());
      } catch {
        result.externalRequestsBlocked.push({
          url: request.url(),
          kind: request.resourceType(),
        });
        await route.abort();
        return;
      }

      if (url.origin !== baseOrigin) {
        result.externalRequestsBlocked.push({
          origin: url.origin,
          kind: request.resourceType(),
        });
        await route.abort();
        return;
      }
      if (request.method() !== "GET") {
        result.nonGetRequestsBlocked.push({
          path: url.pathname,
          method: request.method(),
        });
        await route.abort();
        return;
      }

      const pending = activeDelay;
      if (
        pending &&
        !pending.claimed &&
        url.pathname === "/api/search/posts" &&
        url.searchParams.get("q") === pending.query
      ) {
        pending.claimed = true;
        pending.entered.resolve();
        await pending.release.promise;
      }

      if (url.pathname.startsWith("/api/posts/")) {
        const response = await route.fetch();
        if (response.headers()["content-type"]?.includes("application/json")) {
          const body = await response.json();
          const post = body?.post;
          if (post?.ap_id === localPostIds[SEARCH_QUERY] && post.author) {
            post.author.name = LONG_IDENTITY;
            post.author.username = LONG_IDENTITY;
            post.author.preferred_username = "reader";
            post.author.ap_id = localApId;
          }
          return route.fulfill({ response, json: body });
        }
        return route.fulfill({ response });
      }
      await route.continue();
    });

    if (typeof context.routeWebSocket === "function") {
      await context.routeWebSocket("**/*", (webSocket) => {
        let url;
        try {
          url = new URL(webSocket.url());
        } catch {
          result.websocketRequestsBlocked.push({ url: webSocket.url() });
          webSocket.close();
          return;
        }
        const expectedWsOrigin = baseOrigin.replace(/^http:/, "ws:");
        if (url.origin !== expectedWsOrigin) {
          result.websocketRequestsBlocked.push({ origin: url.origin });
          webSocket.close();
          return;
        }
        webSocket.connectToServer();
      });
    }

    page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize({ width: 1280, height: 800 });

    async function runCheck(name, fn) {
      try {
        const evidence = await fn();
        result.checks.push({ name, pass: true, evidence });
      } catch (error) {
        if (activeDelay) {
          activeDelay.release.resolve();
          activeDelay = undefined;
        }
        result.checks.push({
          name,
          pass: false,
          kind:
            error instanceof CheckFailure ? "assertion" : "harness-or-timeout",
          error: safeError(error),
        });
      }
    }

    async function waitForSettledSearch(query, expectedPostId) {
      await page.waitForFunction(
        ({ expectedQuery, expectedPost }) => {
          if (location.pathname !== "/search") return false;
          const params = new URL(location.href).searchParams;
          if (params.get("search") !== expectedQuery) return false;
          const main = document.querySelector("main");
          const input = main?.querySelector("form input");
          if (input?.value !== expectedQuery) return false;
          const tabs = [...(main?.querySelectorAll('[role="tab"]') ?? [])];
          const postsTab = tabs.find((tab) =>
            tab.textContent?.includes("投稿 (1)"),
          );
          const expectedHref = `/post/${encodeURIComponent(expectedPost)}`;
          const hrefs = [
            ...(main?.querySelectorAll('a[href^="/post/"]') ?? []),
          ].map((link) => link.getAttribute("href"));
          return Boolean(
            postsTab &&
            !main?.querySelector(".animate-pulse") &&
            hrefs.length === 1 &&
            hrefs[0] === expectedHref,
          );
        },
        { expectedQuery: query, expectedPost: expectedPostId },
        { timeout: REQUEST_TIMEOUT_MS },
      );
    }

    async function waitForSettledEmptySearch(
      query,
      expectedTab,
      expectedTabLabel,
    ) {
      await page.waitForFunction(
        ({ expectedQuery, tab, label }) => {
          if (location.pathname !== "/search") return false;
          const params = new URL(location.href).searchParams;
          if (
            params.get("search") !== expectedQuery ||
            params.get("tab") !== tab
          )
            return false;
          const main = document.querySelector("main");
          const input = main?.querySelector("form input");
          if (input?.value !== expectedQuery) return false;
          const tabs = [...(main?.querySelectorAll('[role="tab"]') ?? [])];
          const targetTab = tabs.find((item) =>
            item.textContent?.includes(label),
          );
          return Boolean(
            targetTab?.getAttribute("aria-selected") === "true" &&
            tabs.some((item) => item.textContent?.includes("投稿 (0)")) &&
            !main?.querySelector(".animate-pulse") &&
            main?.querySelectorAll('a[href^="/post/"]').length === 0,
          );
        },
        { expectedQuery: query, tab: expectedTab, label: expectedTabLabel },
        { timeout: REQUEST_TIMEOUT_MS },
      );
    }

    async function readSearchState() {
      return page.evaluate(() => {
        const main = document.querySelector("main");
        const tabs = [...(main?.querySelectorAll('[role="tab"]') ?? [])].map(
          (tab) => ({
            text: tab.textContent?.trim() ?? "",
            selected: tab.getAttribute("aria-selected") === "true",
          }),
        );
        const url = new URL(location.href);
        return {
          pathname: url.pathname,
          search: url.search,
          query: main?.querySelector("form input")?.value ?? null,
          tabs,
          selectedTab: tabs.find((tab) => tab.selected)?.text ?? null,
          postHrefs: [
            ...(main?.querySelectorAll('a[href^="/post/"]') ?? []),
          ].map((link) => link.getAttribute("href")),
        };
      });
    }

    async function assertSearchState(
      query,
      selectedLabel,
      expectedPostId,
      visiblePosts = true,
    ) {
      await waitForSettledSearch(query, expectedPostId);
      const state = await readSearchState();
      const params = new URLSearchParams(state.search);
      assert(
        state.pathname === "/search",
        `expected /search, got ${state.pathname}`,
      );
      assert(state.query === query, `query was not restored: ${state.query}`);
      assert(
        params.get("search") === query,
        `URL search mismatch: ${state.search}`,
      );
      assert(
        state.selectedTab?.startsWith(selectedLabel),
        `expected selected ${selectedLabel}, got ${state.selectedTab}`,
      );
      assert(
        params.get("tab") === (selectedLabel === "投稿" ? "posts" : "users"),
        `URL tab mismatch: ${state.search}`,
      );
      assert(
        visiblePosts
          ? state.postHrefs.length === 1
          : state.postHrefs.length === 0,
        `unexpected visible post links: ${state.postHrefs.length}`,
      );
      if (visiblePosts) {
        assert(
          state.postHrefs[0] === postHref(expectedPostId),
          `unexpected post href: ${state.postHrefs[0]}`,
        );
      }
      return state;
    }

    async function submitQuery(query) {
      const input = page.getByRole("textbox", { name: "検索", exact: true });
      await input.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
      await input.fill(query);
      await input.press("Enter");
    }

    async function openPost(expectedPostId) {
      const link = page.locator('main a[href^="/post/"]').first();
      await link.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
      assert(
        (await link.getAttribute("href")) === postHref(expectedPostId),
        "search result link did not target the seeded post",
      );
      await link.click();
      await page.waitForURL((url) => url.pathname.startsWith("/post/"), {
        timeout: REQUEST_TIMEOUT_MS,
      });
    }

    async function inspectDetail(width) {
      await page.setViewportSize({ width, height: 800 });
      const displayNameLinks = page.getByRole("link", {
        name: LONG_IDENTITY,
        exact: true,
      });
      await displayNameLinks.first().waitFor({
        state: "visible",
        timeout: REQUEST_TIMEOUT_MS,
      });
      const displayNameLinkCount = await displayNameLinks.count();
      const identityLinks = await page.locator("main a").evaluateAll((links) =>
        links.map((link) => ({
          text: link.textContent,
          ariaLabel: link.getAttribute("aria-label"),
          title: link.getAttribute("title"),
          href: link.getAttribute("href"),
        })),
      );
      assert(
        displayNameLinkCount > 0,
        `full display name is missing from the accessible link name: ${JSON.stringify(identityLinks)}`,
      );
      const displayNameLink = displayNameLinks.last();
      await displayNameLink.waitFor({
        state: "visible",
        timeout: REQUEST_TIMEOUT_MS,
      });
      await page.getByText(`@${LONG_IDENTITY}`, { exact: true }).waitFor({
        state: "visible",
        timeout: REQUEST_TIMEOUT_MS,
      });
      const content = await page.evaluate(() => {
        const main = document.querySelector("main");
        const elements = [
          main,
          ...(main ? [...main.querySelectorAll("*")] : []),
        ]
          .filter(
            (element) =>
              element &&
              element.clientWidth > 0 &&
              !["IMG", "SVG", "VIDEO", "CANVAS", "IFRAME"].includes(
                element.tagName,
              ),
          )
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            className:
              typeof element.className === "string" ? element.className : "",
            client: element.clientWidth,
            scroll: element.scrollWidth,
          }));
        return {
          viewport: innerWidth,
          document: {
            client: document.documentElement.clientWidth,
            scroll: document.documentElement.scrollWidth,
          },
          main: {
            client: main?.clientWidth ?? 0,
            scroll: main?.scrollWidth ?? 0,
          },
          overflowing: elements.filter(
            (element) => element.scroll > element.client + 1,
          ),
        };
      });
      const href = await displayNameLink.getAttribute("href");
      const text = await displayNameLink.textContent();
      const usernameText = await page
        .getByText(`@${LONG_IDENTITY}`, { exact: true })
        .textContent();
      assert(text === LONG_IDENTITY, `full display name changed at ${width}px`);
      assert(
        usernameText === `@${LONG_IDENTITY}`,
        `full username changed at ${width}px`,
      );
      assert(
        href === expectedDetailHref,
        `profile href changed at ${width}px: ${href}`,
      );
      assert(
        content.document.scroll <= content.document.client + 1 &&
          content.main.scroll <= content.main.client + 1 &&
          content.overflowing.length === 0,
        `horizontal overflow at ${width}px: ${JSON.stringify(content.overflowing)}`,
      );
      return {
        layout: content,
        accessibleLinkCount: displayNameLinkCount,
        fullDisplayName: text,
        fullUsername: usernameText,
        profileHref: href,
        accessibleLinkName: LONG_IDENTITY,
      };
    }

    async function startBlankSearch() {
      await page.goto(makeUrl(base, "/search"), {
        waitUntil: "domcontentloaded",
        timeout: REQUEST_TIMEOUT_MS,
      });
      await page.getByRole("textbox", { name: "検索", exact: true }).waitFor({
        state: "visible",
        timeout: REQUEST_TIMEOUT_MS,
      });
    }

    await runCheck(
      "UX-001 full federated identity and no overflow at 1280px and 390px",
      async () => {
        await startBlankSearch();
        await submitQuery(SEARCH_QUERY);
        await assertSearchState(
          SEARCH_QUERY,
          "投稿",
          localPostIds[SEARCH_QUERY],
        );
        await openPost(localPostIds[SEARCH_QUERY]);
        const desktop = await inspectDetail(1280);
        const mobile = await inspectDetail(390);
        return { desktop, mobile };
      },
    );

    await runCheck(
      "UX-002 browser Back and Forward restore settled search state",
      async () => {
        await startBlankSearch();
        await submitQuery(SEARCH_QUERY);
        const before = await assertSearchState(
          SEARCH_QUERY,
          "投稿",
          localPostIds[SEARCH_QUERY],
        );
        await openPost(localPostIds[SEARCH_QUERY]);
        await page.goBack();
        await page.waitForURL((url) => url.pathname === "/search", {
          timeout: REQUEST_TIMEOUT_MS,
        });
        const afterBack = await assertSearchState(
          SEARCH_QUERY,
          "投稿",
          localPostIds[SEARCH_QUERY],
        );
        await page.goForward();
        await page.waitForURL((url) => url.pathname.startsWith("/post/"), {
          timeout: REQUEST_TIMEOUT_MS,
        });
        await page
          .getByRole("link", { name: LONG_IDENTITY, exact: true })
          .last()
          .waitFor({
            state: "visible",
            timeout: REQUEST_TIMEOUT_MS,
          });
        return { before, afterBack, forwardPath: new URL(page.url()).pathname };
      },
    );

    await runCheck(
      "UX-002 reload and direct search/tab URL restore query and results",
      async () => {
        await page.goto(
          makeUrl(base, "/search", { search: SEARCH_QUERY, tab: "posts" }),
          { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS },
        );
        const direct = await assertSearchState(
          SEARCH_QUERY,
          "投稿",
          localPostIds[SEARCH_QUERY],
        );
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: REQUEST_TIMEOUT_MS,
        });
        const reloaded = await assertSearchState(
          SEARCH_QUERY,
          "投稿",
          localPostIds[SEARCH_QUERY],
        );
        return { direct, reloaded };
      },
    );

    await runCheck("UX-002 explicit empty tab remains selected", async () => {
      await page.goto(
        makeUrl(base, "/search", { search: SEARCH_QUERY, tab: "posts" }),
        { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS },
      );
      await assertSearchState(SEARCH_QUERY, "投稿", localPostIds[SEARCH_QUERY]);
      const emptyTab = page.getByRole("tab", {
        name: "メンバー (0)",
        exact: true,
      });
      await emptyTab.click();
      await page.waitForFunction(
        () => {
          const url = new URL(location.href);
          const selected = document.querySelector(
            '[role="tab"][aria-selected="true"]',
          );
          return (
            url.searchParams.get("tab") === "users" &&
            selected?.textContent?.includes("メンバー (0)")
          );
        },
        null,
        { timeout: REQUEST_TIMEOUT_MS },
      );
      const state = await readSearchState();
      assert(state.query === SEARCH_QUERY, "empty tab selection lost query");
      assert(
        state.postHrefs.length === 0,
        "empty users tab displayed post links",
      );
      return state;
    });

    await runCheck(
      "UX-002 re-submitting the same query preserves an explicitly selected empty tab",
      async () => {
        await page.goto(
          makeUrl(base, "/search", { search: EMPTY_POST_QUERY, tab: "posts" }),
          { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS },
        );
        await page.waitForFunction(
          () => {
            const tabs = [
              ...(document
                .querySelector("main")
                ?.querySelectorAll('[role="tab"]') ?? []),
            ];
            return (
              tabs.some((tab) => tab.textContent?.includes("投稿 (0)")) &&
              tabs.some((tab) => tab.textContent?.includes("メンバー (1)")) &&
              !document.querySelector("main .animate-pulse")
            );
          },
          null,
          { timeout: REQUEST_TIMEOUT_MS },
        );
        await page
          .getByRole("tab", { name: "メンバー (1)", exact: true })
          .click();
        await page.getByRole("tab", { name: "投稿 (0)", exact: true }).click();
        await waitForSettledEmptySearch(EMPTY_POST_QUERY, "posts", "投稿 (0)");
        const beforeResubmit = await readSearchState();
        await submitQuery(EMPTY_POST_QUERY);
        await waitForSettledEmptySearch(EMPTY_POST_QUERY, "posts", "投稿 (0)");
        const afterResubmit = await readSearchState();
        assert(
          afterResubmit.selectedTab?.startsWith("投稿 (0)"),
          "same-query submit changed selected empty tab",
        );
        assert(
          new URLSearchParams(afterResubmit.search).get("tab") === "posts",
          "same-query submit changed URL tab",
        );
        return { beforeResubmit, afterResubmit };
      },
    );

    await runCheck(
      "UX-002 query change creates Back/Forward entries",
      async () => {
        await page.goto(
          makeUrl(base, "/search", { search: SEARCH_QUERY, tab: "posts" }),
          { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS },
        );
        await assertSearchState(
          SEARCH_QUERY,
          "投稿",
          localPostIds[SEARCH_QUERY],
        );
        await submitQuery(NEXT_QUERY);
        const afterChange = await assertSearchState(
          NEXT_QUERY,
          "投稿",
          localPostIds[NEXT_QUERY],
        );
        await page.goBack();
        await page.waitForURL(
          (url) =>
            url.pathname === "/search" &&
            url.searchParams.get("search") === SEARCH_QUERY,
          { timeout: REQUEST_TIMEOUT_MS },
        );
        const afterBack = await assertSearchState(
          SEARCH_QUERY,
          "投稿",
          localPostIds[SEARCH_QUERY],
        );
        await page.goForward();
        await page.waitForURL(
          (url) =>
            url.pathname === "/search" &&
            url.searchParams.get("search") === NEXT_QUERY,
          { timeout: REQUEST_TIMEOUT_MS },
        );
        const afterForward = await assertSearchState(
          NEXT_QUERY,
          "投稿",
          localPostIds[NEXT_QUERY],
        );
        return { afterChange, afterBack, afterForward };
      },
    );

    await runCheck(
      "UX-002 clearing during a slow response does not restore stale results",
      async () => {
        await startBlankSearch();
        const delay = armDelayedSearch(SEARCH_QUERY);
        activeDelay = delay;
        await submitQuery(SEARCH_QUERY);
        await waitFor(
          delay.entered.promise,
          "slow search request did not start",
        );
        await page
          .getByRole("button", { name: "検索をクリア", exact: true })
          .click();
        const response = page.waitForResponse(
          (candidate) => {
            const url = new URL(candidate.url());
            return (
              url.origin === baseOrigin &&
              url.pathname === "/api/search/posts" &&
              url.searchParams.get("q") === SEARCH_QUERY
            );
          },
          { timeout: REQUEST_TIMEOUT_MS },
        );
        delay.release.resolve();
        activeDelay = undefined;
        await response;
        await nextAnimationFrame();
        const state = await readSearchState();
        assert(state.pathname === "/search", "clear left search route");
        assert(state.query === "", `clear restored query ${state.query}`);
        assert(
          !new URLSearchParams(state.search).has("search"),
          "clear restored URL query",
        );
        assert(state.tabs.length === 0, "clear restored result tabs");
        assert(
          state.postHrefs.length === 0,
          "clear restored stale result links",
        );
        return { state, delayedPostRequest: true };
      },
    );

    await runCheck(
      "UX-002 fast new query wins over an earlier slow response",
      async () => {
        await startBlankSearch();
        const delay = armDelayedSearch(SEARCH_QUERY);
        activeDelay = delay;
        await submitQuery(SEARCH_QUERY);
        await waitFor(
          delay.entered.promise,
          "old slow search request did not start",
        );
        await submitQuery(NEXT_QUERY);
        const fastState = await assertSearchState(
          NEXT_QUERY,
          "投稿",
          localPostIds[NEXT_QUERY],
        );
        const oldResponse = page.waitForResponse(
          (candidate) => {
            const url = new URL(candidate.url());
            return (
              url.origin === baseOrigin &&
              url.pathname === "/api/search/posts" &&
              url.searchParams.get("q") === SEARCH_QUERY
            );
          },
          { timeout: REQUEST_TIMEOUT_MS },
        );
        delay.release.resolve();
        activeDelay = undefined;
        await oldResponse;
        await nextAnimationFrame();
        const afterOldResponse = await assertSearchState(
          NEXT_QUERY,
          "投稿",
          localPostIds[NEXT_QUERY],
        );
        return {
          fastState,
          afterOldResponse,
          oldResponseReleasedAfterFastResults: true,
        };
      },
    );

    result.requestPolicy = {
      nonGetRequestsBlocked: result.nonGetRequestsBlocked,
      externalRequestsBlocked: result.externalRequestsBlocked,
      websocketRequestsBlocked: result.websocketRequestsBlocked,
    };
    result.checks.push({
      name: "local-only GET request policy",
      pass: result.nonGetRequestsBlocked.length === 0,
      evidence: result.requestPolicy,
      ...(result.nonGetRequestsBlocked.length === 0
        ? {}
        : {
            kind: "assertion",
            error: { message: "A non-GET request was blocked." },
          }),
    });
  } catch (error) {
    result.status = "HARNESS_ERROR";
    result.error = safeError(error);
  } finally {
    if (activeDelay) activeDelay.release.resolve();
    if (context) await context.close().catch(() => {});
    if (profileDir)
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(evidenceDirArg, { recursive: true, mode: 0o700 });
    result.finishedAt = new Date().toISOString();
    result.status ??= result.checks.some((check) => !check.pass)
      ? result.checks.some((check) => check.kind === "harness-or-timeout")
        ? "HARNESS_ERROR"
        : "RED"
      : "PASS";
    await writeFile(
      join(evidenceDirArg, "UX-SEARCH-HISTORY-REGRESSION.json"),
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;

  function armDelayedSearch(query) {
    const entered = defer();
    const release = defer();
    return { query, entered, release, claimed: false };
  }

  async function waitFor(promise, message) {
    let timer;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(message)),
            REQUEST_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function nextAnimationFrame() {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  }
}

const [baseUrlArg, evidenceDirArg] = process.argv.slice(2);
if (!baseUrlArg || !evidenceDirArg || process.argv.length !== 4) {
  console.error(
    "usage: node scripts/ux-search-history-regression.mjs <baseURL> <evidenceDir>",
  );
  process.exitCode = 2;
} else {
  await run(baseUrlArg, evidenceDirArg);
}
