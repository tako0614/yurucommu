// Synthetic loopback only: selected POSTs are fulfilled in the browser and
// never forwarded. Exercise the actual built SearchPage and router.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
const require = createRequire(resolve("package.json"));
const { chromium } = require("playwright-core");
const output = process.argv[2];
if (!output) throw new Error("evidence directory required");
const tempRoot = process.env.TMPDIR || tmpdir();
const browser = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
]
  .filter(Boolean)
  .find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
if (!browser) throw new Error("Installed Chrome required; set CHROME_BIN");
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const bounded = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout: ${label}`)),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};
const json = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
const result = {
  scope:
    "built UI, synthetic loopback only; selected join POSTs intercepted and never forwarded",
  checks: [],
  errors: [],
  consoleErrors: [],
  blockedExternal: 0,
  blockedNonGet: [],
  intercepted: 0,
  failures: 0,
};
const check = (name, pass, details = {}) =>
  result.checks.push({ name, pass: Boolean(pass), ...details });
const joinEntered = [defer(), defer()];
const joinRelease = defer();
const joinDrained = defer();
const staleReadEntered = defer();
const releaseStaleRead = defer();
const freshReadEntered = defer();
const replacedJoinEntered = defer();
const releaseReplacedJoin = defer();
const replacedRefreshEntered = defer();
const releaseReplacedRefresh = defer();
const firstScopeRead = defer();
const releaseFirstScopeRead = defer();
const firstScopeReadDone = defer();
const secondScopeRead = defer();
const homeRead = defer();
const releaseHomeRead = defer();
const statusReadEntered = defer();
const releaseStatusRead = defer();
const navJoinEntered = defer();
const releaseNavJoin = defer();
const navJoinedRefresh = defer();
let joinCount = 0,
  joinAnswered = 0,
  betaCount = 0;
let phase = "route";
let holdNextCommunityRead = false;
let serverJoined = false;
let serverBetaJoined = false;
let firstScopeHeld = false;
let holdHomeRead = false;
let web, mock, context, profile, origin;
try {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const dist = resolve("dist");
  web = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") return res.writeHead(405).end();
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      const file =
        path.startsWith("/assets/") ||
        path.startsWith("/icons/") ||
        path === "/manifest.webmanifest"
          ? resolve(dist, "." + decodeURIComponent(path))
          : join(dist, "index.html");
      if (!file.startsWith(dist + sep)) throw new Error("outside dist");
      const types = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".webmanifest": "application/manifest+json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      res
        .writeHead(200, {
          "content-type": types[extname(file)] ?? "application/octet-stream",
        })
        .end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  origin = `http://127.0.0.1:${await listen(web)}`;
  const probe = createServer(),
    port = await listen(probe);
  await new Promise((done) => probe.close(done));
  const mockOrigin = `http://127.0.0.1:${port}`;
  mock = spawn("bun", ["scripts/dev-mock-server.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: tempRoot,
      YURUCOMMU_MOCK_HOST: "127.0.0.1",
      YURUCOMMU_MOCK_PORT: String(port),
      YURUCOMMU_MOCK_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = defer();
  let logs = "";
  mock.stdout.on("data", (part) => {
    logs += part;
    if (logs.includes("mock API listening")) ready.resolve();
  });
  mock.stderr.on("data", (part) => {
    logs += part;
  });
  mock.on("exit", () => ready.resolve());
  await bounded(ready.promise, "mock startup");
  if (mock.exitCode !== null) throw new Error("mock exited");
  const actor = (await (await fetch(`${mockOrigin}/api/auth/me`)).json()).actor;
  const targetId = `${origin}/ap/users/target`;
  const target = {
    ...actor,
    ap_id: targetId,
    username: "target",
    preferred_username: "target",
    name: "Synthetic target",
    icon_url: null,
  };
  const otherTarget = {
    ...target,
    ap_id: `${origin}/ap/users/other`,
    username: "other",
    preferred_username: "other",
    name: "Other synthetic target",
  };
  const communities = ["alpha", "beta"].map((name) => ({
    ap_id: `${origin}/ap/groups/${name}`,
    name,
    display_name: `Synthetic ${name === "alpha" ? "Alpha" : "Beta"}`,
    preferred_username: name,
    summary: "Synthetic community",
    icon_url: null,
    visibility: "public",
    join_policy: "open",
    post_policy: "members",
    member_count: 5,
    post_count: 0,
    created_by: actor.ap_id,
    created_at: "2026-01-01T00:00:00.000Z",
    is_member: false,
    member_role: null,
    join_status: null,
  }));
  profile = await mkdtemp(join(tempRoot, "yuru-follow-profile-"));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: browser,
    headless: true,
    env: { PATH: process.env.PATH ?? "", TMPDIR: tempRoot },
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
    ],
    viewport: { width: 390, height: 844 },
    locale: "ja-JP",
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (
      req.method() === "POST" &&
      url.origin === origin &&
      /^\/api\/communities\/(alpha|beta)\/join$/.test(url.pathname)
    ) {
      result.intercepted++;
      const name = url.pathname.includes("/beta/") ? "beta" : "alpha";
      if (name === "beta") {
        betaCount++;
        if (phase === "two-joins") {
          serverBetaJoined = true;
          return json(route, { success: true, status: "joined" });
        }
        return json(route, { success: true, status: "pending" });
      }
      const n = joinCount++;
      if (phase === "route") {
        if (n >= 2) {
          result.errors.push("unexpected third synthetic join");
          return route.abort();
        }
        joinEntered[n].resolve();
        await joinRelease.promise;
        result.failures++;
        await json(route, { error: "synthetic join unavailable" }, 503);
        joinAnswered++;
        if (joinAnswered === joinCount) joinDrained.resolve();
        return;
      }
      if (phase === "malformed")
        return json(route, { success: true, status: "unrecognized" });
      if (phase === "contradictory")
        return json(route, { success: false, status: "joined" });
      if (phase === "network") {
        result.failures++;
        return route.abort("failed");
      }
      if (phase === "status-only") return json(route, { status: "joined" });
      if (phase === "pending")
        return json(route, { success: true, status: "pending" });
      if (phase === "invite") {
        result.failures++;
        return json(
          route,
          { error: "Invite required", status: "invite_required" },
          403,
        );
      }
      if (phase === "rejected") {
        result.failures++;
        return json(route, { error: "synthetic join rejected" }, 400);
      }
      if (phase === "stale" || phase === "refresh-failure") {
        serverJoined = true;
        return json(route, { success: true, status: "joined" });
      }
      if (phase === "two-joins") {
        serverJoined = true;
        return json(route, { success: true, status: "joined" });
      }
      if (phase === "after-navigation") {
        navJoinEntered.resolve();
        await releaseNavJoin.promise;
        serverJoined = true;
        return json(route, { success: true, status: "joined" });
      }
      if (phase === "replaced") {
        replacedJoinEntered.resolve();
        await releaseReplacedJoin.promise;
        serverJoined = true;
        return json(route, { success: true, status: "joined" });
      }
      result.failures++;
      return json(
        route,
        { error: "synthetic join unavailable" },
        phase === "timeout" ? 408 : 503,
      );
    }
    if (req.method() !== "GET") {
      result.blockedNonGet.push({ method: req.method(), path: url.pathname });
      return route.abort();
    }
    if (url.origin !== origin) {
      result.blockedExternal++;
      if (req.resourceType() === "image")
        return route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        });
      return route.abort();
    }
    if (url.pathname === "/api/communities") {
      if (phase === "refresh-failure" && serverJoined)
        return json(route, { error: "synthetic list unavailable" }, 503);
      const snapshot = communities.map((community) =>
        (community.name === "alpha" && serverJoined) ||
        (community.name === "beta" && serverBetaJoined)
          ? { ...community, is_member: true, member_role: "member" }
          : community,
      );
      if (phase === "two-joins" && holdHomeRead) {
        homeRead.resolve();
        await releaseHomeRead.promise;
      }
      if (
        phase === "two-joins" &&
        serverJoined &&
        !serverBetaJoined &&
        !firstScopeHeld
      ) {
        firstScopeHeld = true;
        firstScopeRead.resolve();
        await releaseFirstScopeRead.promise;
        await json(route, { communities: snapshot });
        firstScopeReadDone.resolve();
        return;
      }
      if (phase === "two-joins" && serverBetaJoined) secondScopeRead.resolve();
      if (phase === "after-navigation" && serverJoined)
        navJoinedRefresh.resolve();
      if (phase === "stale" && holdNextCommunityRead) {
        holdNextCommunityRead = false;
        staleReadEntered.resolve();
        await releaseStaleRead.promise;
      }
      if (phase === "stale" && serverJoined) freshReadEntered.resolve();
      if (phase === "replaced" && serverJoined) {
        replacedRefreshEntered.resolve();
        await releaseReplacedRefresh.promise;
      }
      return json(route, { communities: snapshot });
    }
    if (url.pathname === "/api/communities/alpha") {
      if (phase === "status-fail")
        return json(route, { error: "synthetic status unavailable" }, 503);
      if (phase === "status-wrong-target")
        return json(route, {
          community: { ...communities[0], ap_id: `${origin}/ap/groups/other` },
        });
      if (phase === "status-pending")
        return json(route, {
          community: { ...communities[0], join_status: "pending" },
        });
      if (phase === "status-hold") {
        statusReadEntered.resolve();
        await releaseStatusRead.promise;
      }
      return json(route, { community: communities[0] });
    }
    if (url.pathname === "/api/communities/alpha/members")
      return json(route, { members: [], total: 0 });
    if (url.pathname === "/api/search/actors")
      return json(route, { actors: [target, otherTarget], has_more: false });
    if (url.pathname === "/api/search/posts")
      return json(route, { posts: [], has_more: false });
    if (url.pathname === "/api/notifications/pushers/config")
      return json(route, {});
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const response = await fetch(mockOrigin + url.pathname + url.search);
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  if (!context.routeWebSocket)
    throw new Error(
      "WebSocket interception required for the synthetic fixture",
    );
  await context.routeWebSocket("**/*", (socket) => socket.close());
  const freshPage = async (nextPhase) => {
    phase = nextPhase;
    serverJoined = false;
    serverBetaJoined = false;
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => result.errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        result.consoleErrors.push({
          text: message.text(),
          url: message.location().url,
        });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/search`);
    return page;
  };
  const row = (page, name = "Alpha") =>
    page
      .getByText(`Synthetic ${name}`, { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
  const joinButton = (page, name = "Alpha") =>
    row(page, name).getByRole("button", {
      name: /^(参加|Join|参加中\.\.\.|Joining\.\.\.)$/,
    });
  const checkStatus = (page) =>
    row(page).getByRole("button", {
      name: /状態を確認|確認中|確認済み|Check status|Checking|Checked/,
    });
  const notice = (page) => page.locator('[role="alert"], [role="status"]');
  const nextFrame = (page) =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );

  const page = await freshPage("route");
  await joinButton(page).waitFor();
  await joinButton(page).click();
  await bounded(joinEntered[0].promise, "first synthetic join held");
  check(
    "same target is disabled while the original request is pending",
    await joinButton(page).isDisabled(),
  );
  await page.locator('a[href="/"]:visible').first().click();
  await page.waitForURL(origin + "/");
  await page.goBack();
  await joinButton(page).waitFor();
  const disabledAfterBack = await joinButton(page).isDisabled();
  check(
    "same target stays pending after leaving and returning",
    disabledAfterBack,
  );
  if (!disabledAfterBack) {
    await joinButton(page).click();
    await bounded(joinEntered[1].promise, "second synthetic join held");
  }
  check("navigation does not send the same join twice", joinCount === 1, {
    sent: joinCount,
  });
  const beta = joinButton(page, "Beta");
  check(
    "another community remains independently actionable",
    await beta.isEnabled(),
  );
  if (await beta.isEnabled()) {
    await beta.click();
    await nextFrame(page);
  }
  check("the other community sent exactly once", betaCount === 1, {
    sent: betaCount,
  });
  joinRelease.resolve();
  await bounded(joinDrained.promise, "held joins returned");
  await page.getByRole("alert").first().waitFor();
  const routeNotice = await page.getByRole("alert").first().innerText();
  check(
    "503 is described as an unconfirmed original outcome",
    /確認できません|unconfirmed/i.test(routeNotice) &&
      /Synthetic Alpha/.test(routeNotice),
    { text: routeNotice },
  );
  const routeCheck = checkStatus(page);
  check(
    "unconfirmed target offers its original status instead of blind retry",
    (await routeCheck.count()) === 1 && (await routeCheck.isEnabled()),
  );
  await page.locator('a[href="/"]:visible').first().click();
  await page.goBack();
  await row(page).waitFor();
  check(
    "unconfirmed reminder survives same-session navigation",
    (await checkStatus(page).count()) === 1 &&
      (await row(page)
        .getByRole("button", { name: /^(参加|Join)$/ })
        .count()) === 0,
  );
  phase = "status-fail";
  const failedRead = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities/alpha`,
  );
  await checkStatus(page).click();
  await failedRead;
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="alert"]')].some((node) =>
      /状態を取得できません|status could not be read/i.test(
        node.textContent || "",
      ),
    ),
  );
  check(
    "failed status GET never enables a retry",
    (await row(page)
      .getByRole("button", { name: /確認後に再試行|Enable retry/ })
      .count()) === 0,
  );
  phase = "status-wrong-target";
  const alertsBeforeWrongRead = await page
    .locator('[role="alert"] > div')
    .count();
  const wrongRead = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities/alpha`,
  );
  await checkStatus(page).click();
  await wrongRead;
  await page.waitForFunction(
    (count) => document.querySelectorAll('[role="alert"] > div').length > count,
    alertsBeforeWrongRead,
  );
  check(
    "a different original target never enables a retry",
    (await row(page)
      .getByRole("button", { name: /確認後に再試行|Enable retry/ })
      .count()) === 0,
  );
  phase = "status-pending";
  const pendingRead = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities/alpha`,
  );
  await checkStatus(page).click();
  await pendingRead;
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="status"]')].some((node) =>
      /参加申請中と表示|current status is a pending/i.test(
        node.textContent || "",
      ),
    ),
  );
  check(
    "a pending original never enables a retry",
    (await row(page)
      .getByRole("button", { name: /確認後に再試行|Enable retry/ })
      .count()) === 0,
  );
  phase = "status-hold";
  const originalRead = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities/alpha`,
  );
  await checkStatus(page).click();
  await bounded(statusReadEntered.promise, "original status GET held");
  check(
    "a still-pending status GET cannot enable retry",
    (await row(page)
      .getByRole("button", { name: /確認後に再試行|Enable retry/ })
      .count()) === 0,
  );
  releaseStatusRead.resolve();
  await originalRead;
  const enableRetry = row(page).getByRole("button", {
    name: /確認後に再試行を有効化|Enable retry after checking/,
  });
  await enableRetry.waitFor();
  check(
    "recovery controls fit the 390px viewport",
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  );
  const sendsBeforeEnable = result.intercepted;
  await enableRetry.click();
  check(
    "original status GET and explicit enable allow a later retry without sending one",
    (await joinButton(page).isEnabled()) &&
      result.intercepted === sendsBeforeEnable,
  );
  await page.close();

  for (const kind of ["malformed", "contradictory", "timeout", "network"]) {
    const current = await freshPage(kind);
    const button = joinButton(current);
    await button.waitFor();
    const response =
      kind === "network"
        ? current.waitForEvent("requestfailed", {
            predicate: (request) =>
              request.url() === `${origin}/api/communities/alpha/join`,
          })
        : current.waitForResponse(
            (r) => r.url() === `${origin}/api/communities/alpha/join`,
          );
    await button.click();
    await response;
    await current.waitForFunction(() =>
      [...document.querySelectorAll('[role="alert"], [role="status"]')].some(
        (node) =>
          /参加しました|確認できません|unconfirmed/i.test(
            node.textContent || "",
          ),
      ),
    );
    const text = (await notice(current).allTextContents()).join(" ");
    check(
      `${kind} is unconfirmed and never claims a join`,
      /確認できません|unconfirmed/i.test(text) &&
        !/に参加しました|Joined Synthetic Alpha/i.test(text),
      { text },
    );
    check(
      `${kind} does not offer a blind retry`,
      (await checkStatus(current).count()) === 1 &&
        (await row(current)
          .getByRole("button", { name: /^(参加|Join)$/ })
          .count()) === 0,
    );
    await current.close();
  }

  for (const kind of ["status-only", "pending", "invite", "rejected"]) {
    const current = await freshPage(kind);
    await joinButton(current).waitFor();
    const response = current.waitForResponse(
      (r) => r.url() === `${origin}/api/communities/alpha/join`,
    );
    await joinButton(current).click();
    await response;
    await current.waitForFunction(() =>
      document.querySelector('[role="alert"], [role="status"]'),
    );
    const text = (await notice(current).allTextContents()).join(" ");
    if (kind === "status-only")
      check(
        "legacy status-only joined acknowledgement remains supported",
        /に参加しました|Joined/i.test(text),
        { text },
      );
    if (kind === "pending") {
      check(
        "pending acknowledgement is not presented as joined",
        !/に参加しました|Joined/i.test(text),
        { text },
      );
      check(
        "pending target cannot immediately resend",
        (await row(current)
          .getByRole("button", { name: /^(参加|Join)$/ })
          .count()) === 0,
      );
      const read = current.waitForResponse(
        (r) => r.url() === `${origin}/api/communities/alpha`,
      );
      await checkStatus(current).click();
      await read;
      const unlock = row(current).getByRole("button", {
        name: /確認後に再試行を有効化|Enable retry after checking/,
      });
      await unlock.waitFor();
      const before = result.intercepted;
      await unlock.click();
      check(
        "after a later non-pending read, an explicitly checked pending request can be retried",
        (await joinButton(current).isEnabled()) &&
          result.intercepted === before,
      );
    }
    if (kind === "invite")
      check(
        "invite-only rejection is identified without claiming membership",
        /招待|invite/i.test(text) && !/に参加しました|Joined/i.test(text),
        { text },
      );
    if (kind === "rejected")
      check(
        "received 400 is described as rejection and permits deliberate retry",
        /拒否|rejected/i.test(text) && (await joinButton(current).isEnabled()),
        { text },
      );
    await current.close();
  }

  const stale = await freshPage("stale");
  await joinButton(stale).waitFor();
  holdNextCommunityRead = true;
  await stale.evaluate(() => window.dispatchEvent(new Event("focus")));
  await bounded(
    staleReadEntered.promise,
    "pre-acknowledgement community read held",
  );
  const staleAck = stale.waitForResponse(
    (r) => r.url() === `${origin}/api/communities/alpha/join`,
  );
  await joinButton(stale).click();
  await staleAck;
  await stale.waitForFunction(() =>
    [...document.querySelectorAll('[role="status"]')].some((node) =>
      /参加しました|Joined/i.test(node.textContent || ""),
    ),
  );
  await bounded(
    freshReadEntered.promise,
    "post-acknowledgement community read",
  );
  await nextFrame(stale);
  releaseStaleRead.resolve();
  await nextFrame(stale);
  await nextFrame(stale);
  check(
    "pre-ACK read cannot restore the joined community row",
    (await stale.getByText("Synthetic Alpha", { exact: true }).count()) === 0,
  );
  await stale.close();

  const replaced = await freshPage("replaced");
  await joinButton(replaced).waitFor();
  await joinButton(replaced).click();
  await bounded(
    replacedJoinEntered.promise,
    "join held during a new discovery read",
  );
  const replacement = replaced.waitForResponse(
    (r) => r.url() === `${origin}/api/communities`,
  );
  await replaced.evaluate(() => window.dispatchEvent(new Event("focus")));
  await replacement;
  await nextFrame(replaced);
  await nextFrame(replaced);
  releaseReplacedJoin.resolve();
  const refreshStarted = await Promise.race([
    replacedRefreshEntered.promise.then(() => true),
    new Promise((done) => setTimeout(() => done(false), 3000)),
  ]);
  check(
    "joined ACK refreshes the picker even if its row was replaced",
    refreshStarted,
  );
  check(
    "the old ACK does not patch the newer row",
    (await row(replaced).count()) === 1 &&
      (await checkStatus(replaced).count()) === 1,
  );
  releaseReplacedRefresh.resolve();
  await replaced.close();

  const navigated = await freshPage("after-navigation");
  await joinButton(navigated).waitFor();
  await joinButton(navigated).click();
  await bounded(navJoinEntered.promise, "join held while leaving search");
  const homeInitialRead = navigated.waitForResponse(
    (r) => r.url() === `${origin}/api/communities`,
  );
  await navigated.locator('a[href="/"]:visible').first().click();
  await homeInitialRead;
  await nextFrame(navigated);
  releaseNavJoin.resolve();
  await bounded(navJoinedRefresh.promise, "joined scope read after navigation");
  const navSwitcher = navigated.getByRole("button", {
    name: /^(ホーム|Home)$/,
  });
  await navSwitcher.waitFor();
  await navSwitcher.click();
  const navDialog = navigated.getByRole("dialog");
  await navDialog.waitFor();
  check(
    "joined ACK after navigation refreshes the same-session picker",
    (await navDialog
      .getByRole("radio", { name: /Synthetic Alpha/ })
      .count()) === 1,
  );
  await navigated.close();

  const two = await freshPage("two-joins");
  await joinButton(two).waitFor();
  await joinButton(two).click();
  await bounded(firstScopeRead.promise, "first joined-scope read held");
  await joinButton(two, "Beta").click();
  await bounded(secondScopeRead.promise, "newer joined-scope read");
  await nextFrame(two);
  await nextFrame(two);
  releaseFirstScopeRead.resolve();
  await bounded(firstScopeReadDone.promise, "older joined-scope read returned");
  await nextFrame(two);
  await nextFrame(two);
  holdHomeRead = true;
  await two.locator('a[href="/"]:visible').first().click();
  await bounded(homeRead.promise, "home scope read held for observation");
  const switcher = two.getByRole("button", { name: /^(ホーム|Home)$/ });
  await switcher.waitFor();
  await switcher.click();
  const dialog = two.getByRole("dialog");
  await dialog.waitFor();
  check(
    "older scope read cannot replace both newer joined communities",
    (await dialog.getByRole("radio", { name: /Synthetic Alpha/ }).count()) ===
      1 &&
      (await dialog.getByRole("radio", { name: /Synthetic Beta/ }).count()) ===
        1,
  );
  releaseHomeRead.resolve();
  await two.close();

  const refresh = await freshPage("refresh-failure");
  await joinButton(refresh).waitFor();
  await joinButton(refresh).click();
  await refresh.waitForFunction(() =>
    [...document.querySelectorAll('[role="alert"]')].some((node) =>
      /一覧を更新できません|could not be refreshed/i.test(
        node.textContent || "",
      ),
    ),
  );
  const refreshText = (await notice(refresh).allTextContents()).join(" ");
  check(
    "post-ACK list failure is reported separately from accepted join",
    /参加しました|Joined/i.test(refreshText) &&
      /一覧を更新できません|could not be refreshed/i.test(refreshText),
    { text: refreshText },
  );
  await refresh.close();
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  joinRelease.resolve();
  releaseStaleRead.resolve();
  releaseReplacedJoin.resolve();
  releaseReplacedRefresh.resolve();
  releaseFirstScopeRead.resolve();
  releaseHomeRead.resolve();
  releaseStatusRead.resolve();
  releaseNavJoin.resolve();
  if (context)
    try {
      await bounded(context.close(), "browser cleanup");
    } catch (error) {
      result.errors.push(`browser cleanup: ${error}`);
    }
  if (mock && mock.exitCode === null && mock.signalCode === null)
    try {
      const exited = once(mock, "exit");
      if (!mock.kill("SIGTERM")) throw new Error("could not signal mock");
      await bounded(exited, "mock cleanup");
    } catch (error) {
      result.errors.push(`mock cleanup: ${error}`);
    }
  if (web)
    try {
      await bounded(
        new Promise((done, reject) =>
          web.close((error) => (error ? reject(error) : done())),
        ),
        "web cleanup",
      );
    } catch (error) {
      result.errors.push(`web cleanup: ${error}`);
      web.closeAllConnections?.();
    }
  if (profile)
    try {
      await bounded(
        rm(profile, { recursive: true, force: true }),
        "profile cleanup",
      );
    } catch (error) {
      result.errors.push(`profile cleanup: ${error}`);
    }
  const expectedJoinErrors = result.consoleErrors.filter(
    (entry) =>
      /^Failed to load resource:.*(?:503|408|403|400|ERR_FAILED)/.test(
        entry.text,
      ) && entry.url === `${origin}/api/communities/alpha/join`,
  );
  const expectedListResourceErrors = result.consoleErrors.filter(
    (entry) =>
      /^Failed to load resource:.*503/.test(entry.text) &&
      entry.url === `${origin}/api/communities`,
  );
  const expectedStatusResourceErrors = result.consoleErrors.filter(
    (entry) =>
      /^Failed to load resource:.*503/.test(entry.text) &&
      entry.url === `${origin}/api/communities/alpha`,
  );
  const expectedListLogs = result.consoleErrors.filter(
    (entry) =>
      /^Failed to refresh scope communities: ApiError: synthetic list unavailable(?:\n|$)/.test(
        entry.text,
      ) && entry.url.startsWith(`${origin}/assets/`),
  );
  if (
    expectedJoinErrors.length !== result.failures ||
    expectedListResourceErrors.length !== 1 ||
    expectedStatusResourceErrors.length !== 1 ||
    expectedListLogs.length !== 1 ||
    expectedJoinErrors.length +
      expectedStatusResourceErrors.length +
      expectedListResourceErrors.length +
      expectedListLogs.length !==
      result.consoleErrors.length
  )
    result.errors.push(
      "unexpected console error or missing expected synthetic failure",
    );
  result.status =
    result.errors.length || result.blockedNonGet.length
      ? "HARNESS_ERROR"
      : result.checks.every((item) => item.pass)
        ? "PASS"
        : "RED";
  await writeFile(
    `${output}/RESULT.json`,
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
}
process.exitCode = result.status === "PASS" ? 0 : 1;
