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
const releaseFreshRead = defer();
const omittedReadEntered = defer();
const releaseOmittedRead = defer();
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
  betaCount = 0,
  leaveCount = 0;
let phase = "route";
let holdNextCommunityRead = false;
let serverJoined = false;
let serverBetaJoined = false;
let hideAlpha = false;
let hideBeta = false;
let replaceAlpha = false;
let holdOmittedRead = false;
let firstScopeHeld = false;
let holdHomeRead = false;
let web, mock, context, profile, origin, originalDetailUrl, originalDetailPath;
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
  originalDetailPath = `/api/communities/${encodeURIComponent(communities[0].ap_id)}`;
  originalDetailUrl = `${origin}${originalDetailPath}`;
  const isOriginalDetail = (response) =>
    response.url() === originalDetailUrl ||
    response.url() === `${origin}/api/communities/alpha`;
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
      url.pathname === "/api/communities/alpha/leave" &&
      phase === "leave-rejoin"
    ) {
      result.intercepted++;
      leaveCount++;
      serverJoined = false;
      return json(route, { success: true });
    }
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
      if (
        phase === "stale" ||
        phase === "refresh-failure" ||
        phase === "leave-rejoin"
      ) {
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
      const snapshot = communities
        .filter((community) =>
          community.name === "alpha" ? !hideAlpha : !hideBeta,
        )
        .map((community) => {
          if (community.name === "alpha" && replaceAlpha)
            return {
              ...community,
              ap_id: `${origin}/ap/groups/replacement`,
              display_name: "Replacement Alpha",
              is_member: false,
            };
          return (community.name === "alpha" && serverJoined) ||
            (community.name === "beta" && serverBetaJoined)
            ? { ...community, is_member: true, member_role: "member" }
            : community;
        });
      if (holdOmittedRead) {
        holdOmittedRead = false;
        omittedReadEntered.resolve();
        await releaseOmittedRead.promise;
        return json(route, { error: "synthetic discovery unavailable" }, 503);
      }
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
      if (phase === "stale" && serverJoined) {
        freshReadEntered.resolve();
        await releaseFreshRead.promise;
      }
      if (phase === "replaced" && serverJoined) {
        replacedRefreshEntered.resolve();
        await releaseReplacedRefresh.promise;
      }
      return json(route, { communities: snapshot });
    }
    if (
      url.pathname === originalDetailPath ||
      url.pathname === "/api/communities/alpha"
    ) {
      if (phase === "leave-rejoin")
        return json(route, {
          community: {
            ...communities[0],
            is_member: serverJoined,
            member_role: serverJoined ? "member" : null,
          },
        });
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
      if (phase === "status-member")
        return json(route, {
          community: {
            ...communities[0],
            is_member: true,
            member_role: "member",
          },
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
    hideAlpha = false;
    hideBeta = false;
    replaceAlpha = false;
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
      name: /状態を確認|確認中|確認済み|元の情報を取得|取得中|Check status|Checking|Checked|Read original details|Reading/,
    });
  const notice = (page) => page.locator('[role="alert"], [role="status"]');
  const omittedOriginal = (page) =>
    page
      .getByText(
        /一覧に表示されていない元の参加操作|original join not shown in the list/i,
      )
      .locator("..");
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
  hideAlpha = true;
  const omittedInFlight = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await omittedInFlight;
  await nextFrame(page);
  await nextFrame(page);
  check(
    "an omitted in-flight target retains its original identity without a resend control",
    (await omittedOriginal(page).count()) === 1 &&
      (await omittedOriginal(page)
        .getByText(`${origin}/ap/groups/alpha`, { exact: true })
        .count()) === 1 &&
      (await omittedOriginal(page)
        .getByRole("link", { name: "Synthetic Alpha" })
        .count()) === 0 &&
      (await omittedOriginal(page)
        .getByRole("button", { name: /^(参加|Join)$/ })
        .count()) === 0,
  );
  const homeBeforeOmittedBack = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.locator('a[href="/"]:visible').first().click();
  await homeBeforeOmittedBack;
  holdOmittedRead = true;
  await page.goBack();
  await bounded(omittedReadEntered.promise, "discovery read held after return");
  await nextFrame(page);
  await nextFrame(page);
  check(
    "a held discovery read retains a neutral original reminder after navigation",
    (await omittedOriginal(page).count()) === 1 &&
      !/一覧にありません|not in the current list/i.test(
        await omittedOriginal(page).innerText(),
      ) &&
      joinCount === 1,
  );
  const failedDiscovery = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/communities` &&
      response.status() === 503,
  );
  releaseOmittedRead.resolve();
  await failedDiscovery;
  await nextFrame(page);
  await nextFrame(page);
  check(
    "a failed discovery read keeps the original reminder and an explicit failure",
    (await omittedOriginal(page).count()) === 1 &&
      (await page.getByRole("button", { name: /再試行|Retry/i }).count()) > 0,
  );
  hideBeta = true;
  const emptyList = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await emptyList;
  await nextFrame(page);
  await nextFrame(page);
  check(
    "an empty successful list does not replace the original reminder with an empty-state claim",
    (await omittedOriginal(page).count()) === 1 &&
      (await page
        .getByText(/参加できるコミュニティがありません|No communities to join/i)
        .count()) === 0,
  );
  hideBeta = false;
  hideAlpha = false;
  const restoreOmittedInFlight = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await restoreOmittedInFlight;
  await joinButton(page).waitFor();
  replaceAlpha = true;
  const replacementList = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await replacementList;
  await nextFrame(page);
  await nextFrame(page);
  const replacementRow = page
    .getByText("Replacement Alpha", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
  check(
    "a replacement AP id with the same endpoint name cannot resend the original operation",
    (await omittedOriginal(page).count()) === 1 &&
      (await omittedOriginal(page)
        .getByText(`${origin}/ap/groups/alpha`, { exact: true })
        .count()) === 1 &&
      (await replacementRow
        .getByRole("button", { name: /^(参加|Join)$/ })
        .count()) === 0 &&
      joinCount === 1,
  );
  replaceAlpha = false;
  const restoreReplacement = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await restoreReplacement;
  await joinButton(page).waitFor();
  serverJoined = true;
  const inFlightList = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await inFlightList;
  await nextFrame(page);
  await nextFrame(page);
  check(
    "an unbound member list cannot hide an in-flight original",
    (await row(page).count()) === 1 && (await joinButton(page).isDisabled()),
  );
  serverJoined = false;
  const restoredInFlightList = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await restoredInFlightList;
  await joinButton(page).waitFor();
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
      /この画面では再送できません|retry is unavailable here/i.test(
        routeNotice,
      ) &&
      /Synthetic Alpha/.test(routeNotice),
    { text: routeNotice },
  );
  check(
    "the original row keeps a visible unconfirmed and no-retry reminder",
    /結果未確認・再送不可|unconfirmed; retry unavailable/i.test(
      await row(page).innerText(),
    ),
  );
  const alphaReadName = await checkStatus(page).getAttribute("aria-label");
  const betaReadName = await row(page, "Beta")
    .getByRole("button", { name: /元の情報を取得|Read original details/i })
    .getAttribute("aria-label");
  check(
    "read buttons for separate original targets have distinct accessible names",
    !!alphaReadName &&
      !!betaReadName &&
      alphaReadName !== betaReadName &&
      alphaReadName.includes("Synthetic Alpha") &&
      betaReadName.includes("Synthetic Beta"),
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
  hideAlpha = true;
  const omittedUnknown = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await omittedUnknown;
  await nextFrame(page);
  await nextFrame(page);
  check(
    "an omitted unconfirmed original remains visible without a resend control",
    (await omittedOriginal(page).count()) === 1 &&
      /未確認|unconfirmed/i.test(await omittedOriginal(page).innerText()) &&
      (await omittedOriginal(page)
        .getByText(`${origin}/ap/groups/alpha`, { exact: true })
        .count()) === 1 &&
      (await omittedOriginal(page)
        .getByRole("link", { name: "Synthetic Alpha" })
        .count()) === 0 &&
      (await omittedOriginal(page)
        .getByRole("button", { name: /^(参加|Join)$/ })
        .count()) === 0,
  );
  const missingRead = omittedOriginal(page).getByRole("button", {
    name: /元の情報を取得|Read original details/i,
  });
  const canReadMissing = (await missingRead.count()) === 1;
  check(
    "an omitted original still offers a read of its original details",
    canReadMissing,
  );
  if (canReadMissing) {
    phase = "status-wrong-target";
    const wrongMissingRead = page.waitForResponse(isOriginalDetail);
    await missingRead.click();
    const wrongMissingResponse = await wrongMissingRead;
    await nextFrame(page);
    await nextFrame(page);
    const wrongMissingText = (await notice(page).allTextContents()).join(" ");
    check(
      "an omitted original rejects a same-name read with a different AP id",
      /状態を取得できません|status could not be read/i.test(wrongMissingText) &&
        (await omittedOriginal(page)
          .getByRole("button", { name: /^(参加|Join)$/ })
          .count()) === 0,
    );
    check(
      "the original details request uses the captured AP id",
      wrongMissingResponse.url() === originalDetailUrl,
    );
    phase = "status-default";
    const validMissingRead = page.waitForResponse(isOriginalDetail);
    await missingRead.click();
    await validMissingRead;
    await nextFrame(page);
    await nextFrame(page);
    const validMissingText = (await notice(page).allTextContents()).join(" ");
    check(
      "an omitted original read does not claim current membership or allow retry",
      /参加状態は確認できません|membership cannot be verified/i.test(
        validMissingText,
      ) &&
        (await omittedOriginal(page)
          .getByRole("button", { name: /^(参加|Join)$/ })
          .count()) === 0,
    );
  }
  hideAlpha = false;
  const restoreOmittedUnknown = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await restoreOmittedUnknown;
  await row(page).waitFor();
  // The discovery list is also public: a later membership field must not
  // hide an unresolved original merely because the viewer is unbound.
  serverJoined = true;
  const joinedList = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await joinedList;
  await nextFrame(page);
  await nextFrame(page);
  check(
    "an unbound member list cannot hide an unconfirmed original receipt",
    (await row(page).count()) === 1,
  );
  serverJoined = false;
  const restoredList = page.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await restoredList;
  await row(page).waitFor();
  phase = "status-fail";
  const failedRead = page.waitForResponse(isOriginalDetail);
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
  while ((await page.locator('[role="alert"] > div button').count()) > 0)
    await page.locator('[role="alert"] > div button').first().click();
  phase = "status-wrong-target";
  const alertsBeforeWrongRead = await page
    .locator('[role="alert"] > div')
    .count();
  const wrongRead = page.waitForResponse(isOriginalDetail);
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
  const pendingRead = page.waitForResponse(isOriginalDetail);
  await checkStatus(page).click();
  await pendingRead;
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="status"]')].some((node) =>
      /参加申請中と表示|current status is a pending|参加状態は確認できません|membership cannot be verified/i.test(
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
  const pendingText = (await notice(page).allTextContents()).join(" ");
  check(
    "an unbound pending response is not attributed to the current actor",
    /参加状態は確認できません|membership cannot be verified/i.test(
      pendingText,
    ) && !/参加申請中と表示|current status is a pending/i.test(pendingText),
  );
  phase = "status-hold";
  const originalRead = page.waitForResponse(isOriginalDetail);
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
  await nextFrame(page);
  await nextFrame(page);
  const enableRetry = row(page).getByRole("button", {
    name: /確認後に再試行を有効化|Enable retry after checking/,
  });
  check(
    "recovery controls fit the 390px viewport",
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  );
  const unboundText = (await notice(page).allTextContents()).join(" ");
  check(
    "anonymous-shaped response cannot enable retry or claim the actor is not joined",
    (await enableRetry.count()) === 0 &&
      /参加状態は確認できません|membership cannot be verified/i.test(
        unboundText,
      ) &&
      !/現在は未参加・申請なし|current status is not joined/i.test(unboundText),
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
      serverJoined = true;
      const pendingList = current.waitForResponse(
        (response) => response.url() === `${origin}/api/communities`,
      );
      await current.evaluate(() => window.dispatchEvent(new Event("focus")));
      await pendingList;
      await nextFrame(current);
      await nextFrame(current);
      check(
        "an unbound member list cannot hide an accepted pending receipt",
        (await row(current).count()) === 1,
      );
      check(
        "a pending receipt describes the accepted request without claiming current status",
        /申請を受け付けました|request accepted/i.test(
          await row(current).innerText(),
        ) &&
          /現在の状態は未確認|current status unverified/i.test(
            await row(current).innerText(),
          ),
      );
      hideAlpha = true;
      const omittedPending = current.waitForResponse(
        (response) => response.url() === `${origin}/api/communities`,
      );
      await current.evaluate(() => window.dispatchEvent(new Event("focus")));
      await omittedPending;
      await nextFrame(current);
      await nextFrame(current);
      check(
        "an omitted accepted pending original remains visible without a resend control",
        (await omittedOriginal(current).count()) === 1 &&
          /申請を受け付けました|request accepted/i.test(
            await omittedOriginal(current).innerText(),
          ) &&
          /現在の状態は未確認|current status unverified/i.test(
            await omittedOriginal(current).innerText(),
          ) &&
          (await omittedOriginal(current)
            .getByRole("button", { name: /^(参加|Join)$/ })
            .count()) === 0,
      );
      hideAlpha = false;
      serverJoined = false;
      const restoredPendingList = current.waitForResponse(
        (response) => response.url() === `${origin}/api/communities`,
      );
      await current.evaluate(() => window.dispatchEvent(new Event("focus")));
      await restoredPendingList;
      await row(current).waitFor();
      const read = current.waitForResponse(isOriginalDetail);
      await checkStatus(current).click();
      await read;
      await nextFrame(current);
      await nextFrame(current);
      const unlock = row(current).getByRole("button", {
        name: /確認後に再試行を有効化|Enable retry after checking/,
      });
      check(
        "an unbound non-pending read cannot unlock a pending request",
        (await unlock.count()) === 0 &&
          (await joinButton(current).count()) === 0,
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

  const memberRead = await freshPage("unbound-member");
  await joinButton(memberRead).waitFor();
  const unknownJoin = memberRead.waitForResponse(
    (response) => response.url() === `${origin}/api/communities/alpha/join`,
  );
  await joinButton(memberRead).click();
  await unknownJoin;
  await checkStatus(memberRead).waitFor();
  phase = "status-member";
  const unboundMemberRead = memberRead.waitForResponse(isOriginalDetail);
  await checkStatus(memberRead).click();
  await unboundMemberRead;
  await nextFrame(memberRead);
  await nextFrame(memberRead);
  const memberText = (await notice(memberRead).allTextContents()).join(" ");
  check(
    "unbound member response does not remove the original row or claim actor membership",
    (await row(memberRead).count()) === 1 &&
      /参加状態は確認できません|membership cannot be verified/i.test(
        memberText,
      ) &&
      !/現在は参加済みと表示|current status is joined/i.test(memberText),
  );
  await memberRead.close();

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
  check(
    "a joined acknowledgement removes the original row while scope refresh is held",
    (await stale.getByText("Synthetic Alpha", { exact: true }).count()) === 0,
  );
  releaseFreshRead.resolve();
  releaseStaleRead.resolve();
  await nextFrame(stale);
  await nextFrame(stale);
  check(
    "pre-ACK read cannot restore the joined community row",
    (await stale.getByText("Synthetic Alpha", { exact: true }).count()) === 0,
  );
  serverJoined = false;
  const unboundAfterJoin = stale.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await stale.evaluate(() => window.dispatchEvent(new Event("focus")));
  await unboundAfterJoin;
  await nextFrame(stale);
  await nextFrame(stale);
  check(
    "a later unbound list shows joined history without claiming current membership",
    (await row(stale).count()) === 1 &&
      /前回の参加は受け付けました|previous join was accepted/i.test(
        await row(stale).innerText(),
      ) &&
      /現在の状態は未確認|current status unverified/i.test(
        await row(stale).innerText(),
      ) &&
      (await row(stale)
        .getByRole("button", { name: /^(参加|Join)$/ })
        .count()) === 0,
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
    "the joined original does not reopen through a replaced unbound row",
    (await row(replaced).count()) === 0,
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

  const leavePage = await freshPage("leave-rejoin");
  const joinsBeforeLeave = joinCount;
  await joinButton(leavePage).waitFor();
  const joinedAck = leavePage.waitForResponse(
    (response) => response.url() === `${origin}/api/communities/alpha/join`,
  );
  await joinButton(leavePage).click();
  await joinedAck;
  await leavePage.waitForFunction(() =>
    [...document.querySelectorAll('[role="status"]')].some((node) =>
      /参加しました|Joined/i.test(node.textContent || ""),
    ),
  );
  const searchInput = leavePage.getByRole("textbox", {
    name: /^(検索|Search)$/,
  });
  await searchInput.fill("alpha");
  await searchInput.press("Enter");
  await leavePage
    .getByRole("tab", { name: /コミュニティ|Communities/ })
    .click();
  await leavePage.getByRole("link", { name: /Synthetic Alpha/ }).click();
  await leavePage.waitForURL(`${origin}/groups/alpha`);
  await leavePage.getByRole("button", { name: /^(退出|Leave)$/ }).click();
  const leaveResponse = leavePage.waitForResponse(
    (response) => response.url() === `${origin}/api/communities/alpha/leave`,
  );
  const afterLeaveScope = leavePage.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await leavePage
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(退出|Leave)$/ })
    .click();
  await leaveResponse;
  await afterLeaveScope;
  await nextFrame(leavePage);
  await leavePage.goBack();
  await leavePage
    .getByRole("button", { name: /検索をクリア|Clear search/ })
    .click();
  await nextFrame(leavePage);
  await nextFrame(leavePage);
  const joinAgain = row(leavePage).getByRole("button", {
    name: /^(もう一度参加|Join again)$/,
  });
  const canJoinAgain =
    (await row(leavePage).count()) === 1 && (await joinAgain.count()) === 1;
  check(
    "after an explicit leave the prior joined receipt does not permanently block a deliberate new join",
    canJoinAgain && leaveCount === 1 && joinCount === joinsBeforeLeave + 1,
  );
  if (canJoinAgain) {
    const againResponse = leavePage.waitForResponse(
      (response) => response.url() === `${origin}/api/communities/alpha/join`,
    );
    await joinAgain.click();
    await againResponse;
    check(
      "a deliberate new join after leave sends exactly once",
      joinCount === joinsBeforeLeave + 2,
    );
  }
  await leavePage.close();

  const english = await freshPage("malformed");
  await english.evaluate(() => localStorage.setItem("language", '"en"'));
  await english.reload();
  await joinButton(english).waitFor();
  const englishJoin = english.waitForResponse(
    (response) => response.url() === `${origin}/api/communities/alpha/join`,
  );
  await joinButton(english).click();
  await englishJoin;
  await english.waitForFunction(() =>
    [...document.querySelectorAll('[role="alert"]')].some((node) =>
      /retry is unavailable here/i.test(node.textContent || ""),
    ),
  );
  check(
    "English unconfirmed controls remain visible without 390px overflow",
    /Unconfirmed; retry unavailable/.test(await row(english).innerText()) &&
      (await english.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      )),
  );
  hideAlpha = true;
  const omittedEnglish = english.waitForResponse(
    (response) => response.url() === `${origin}/api/communities`,
  );
  await english.evaluate(() => window.dispatchEvent(new Event("focus")));
  await omittedEnglish;
  await nextFrame(english);
  await nextFrame(english);
  check(
    "English omitted original remains legible without 390px overflow",
    (await omittedOriginal(english).count()) === 1 &&
      /unconfirmed/i.test(await omittedOriginal(english).innerText()) &&
      (await english.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      )),
  );
  await english.close();
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  joinRelease.resolve();
  releaseStaleRead.resolve();
  releaseFreshRead.resolve();
  releaseOmittedRead.resolve();
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
      (entry.url === originalDetailUrl ||
        entry.url === `${origin}/api/communities/alpha`),
  );
  const expectedListLogs = result.consoleErrors.filter(
    (entry) =>
      /^Failed to refresh scope communities: ApiError: synthetic list unavailable(?:\n|$)/.test(
        entry.text,
      ) && entry.url.startsWith(`${origin}/assets/`),
  );
  const expectedDiscoveryLogs = result.consoleErrors.filter(
    (entry) =>
      /^Failed to fetch communities:? ApiError: synthetic discovery unavailable(?:\n|$)/.test(
        entry.text,
      ) && entry.url.startsWith(`${origin}/assets/`),
  );
  if (
    expectedJoinErrors.length !== result.failures ||
    expectedListResourceErrors.length !== 2 ||
    expectedStatusResourceErrors.length !== 1 ||
    expectedListLogs.length !== 1 ||
    expectedDiscoveryLogs.length !== 1 ||
    expectedJoinErrors.length +
      expectedStatusResourceErrors.length +
      expectedListResourceErrors.length +
      expectedListLogs.length +
      expectedDiscoveryLogs.length !==
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
