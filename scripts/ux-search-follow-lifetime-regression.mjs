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
    "built UI, synthetic loopback only; selected follow POSTs intercepted and never forwarded",
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
const entered = [defer(), defer()];
const release = defer();
const queryEntered = defer();
const releaseQuery = defer();
const followingEntered = defer();
const releaseFollowing = defer();
let phase = "route";
let routeCount = 0;
let otherCount = 0;
let queryCount = 0;
let newQueryCount = 0;
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
    if (req.method() !== "GET") {
      if (
        url.origin === origin &&
        url.pathname === "/api/follow" &&
        req.method() === "POST"
      ) {
        let body;
        try {
          body = JSON.parse(req.postData() || "null");
        } catch {
          body = null;
        }
        if (
          phase === "route" &&
          body?.target_ap_id === otherTarget.ap_id &&
          Object.keys(body).length === 1
        ) {
          result.intercepted++;
          otherCount++;
          return json(route, { status: "accepted" });
        }
        if (body?.target_ap_id === targetId && Object.keys(body).length === 1) {
          result.intercepted++;
          if (phase === "route" && routeCount < 2) {
            const index = routeCount++;
            entered[index].resolve();
            await release.promise;
            result.failures++;
            return json(route, { error: "synthetic follow unavailable" }, 503);
          }
          if (phase === "ordering") return json(route, { status: "accepted" });
          if (phase === "pending") return json(route, { status: "pending" });
          if (phase === "malformed")
            return json(route, { status: "unrecognized" });
          if (phase === "query" || phase === "query-new") {
            if (++queryCount !== 1) {
              result.errors.push(
                "unexpected duplicate follow during query change",
              );
              return route.abort();
            }
            queryEntered.resolve();
            await releaseQuery.promise;
            return json(route, { status: "accepted" });
          }
          if (phase === "rejected") {
            result.failures++;
            return json(route, { error: "synthetic follow rejected" }, 400);
          }
        }
      }
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
    if (url.pathname === "/api/search/actors") {
      if (phase === "query-new") {
        if (url.searchParams.get("q") !== "newer target") {
          result.errors.push("unexpected query during query change");
          return json(route, { error: "unexpected query" }, 400);
        }
        newQueryCount++;
      }
      return json(route, {
        actors: [
          phase === "query-new"
            ? { ...target, name: "Newer synthetic target" }
            : target,
          otherTarget,
        ],
        has_more: false,
      });
    }
    if (url.pathname === "/api/search/posts")
      return json(route, { posts: [], has_more: false });
    if (url.pathname === "/api/notifications/pushers/config")
      return json(route, {});
    if (
      phase === "ordering" &&
      url.pathname ===
        `/api/actors/${encodeURIComponent(actor.ap_id)}/following`
    ) {
      followingEntered.resolve();
      await releaseFollowing.promise;
      return json(route, { following: [], has_more: false, total: 0 });
    }
    if (url.pathname === `/api/actors/${encodeURIComponent(targetId)}`)
      return json(route, { actor: target });
    if (url.pathname === `/api/actors/${encodeURIComponent(targetId)}/posts`)
      return json(route, { posts: [], has_more: false, next_cursor: null });
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
  await page.goto(`${origin}/search?search=target&tab=users`);
  await page.getByText("Synthetic target", { exact: true }).waitFor();
  const row = () =>
    page
      .getByText("Synthetic target", { exact: true })
      .locator("xpath=ancestor::div[contains(@class, 'border-b')][1]");
  const follow = () =>
    row()
      .getByRole("button", { name: /フォロー|Follow/ })
      .first();
  await follow().click();
  await bounded(entered[0].promise, "first follow held");
  check("same page disables the pending follow", await follow().isDisabled());
  const otherRow = page
    .getByText("Other synthetic target", { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'border-b')][1]");
  const otherFollow = otherRow
    .getByRole("button", { name: /フォロー|Follow/ })
    .first();
  check(
    "another target remains actionable while the original is pending",
    !(await otherFollow.isDisabled()),
  );
  const otherAck = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/follow` && response.status() === 200,
    { timeout: 15_000 },
  );
  await otherFollow.click();
  await otherAck;
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  check(
    "another target can complete independently",
    otherCount === 1 &&
      (await otherRow
        .getByText(/フォロー中|Following/, { exact: true })
        .count()) === 1,
  );
  await page.getByText("Synthetic target", { exact: true }).click();
  await page.waitForURL(/\/profile\//);
  await page.goBack();
  await page.getByText("Synthetic target", { exact: true }).waitFor();
  const disabledAfterBack = await follow().isDisabled();
  check(
    "returning to search retains the original pending follow",
    disabledAfterBack,
  );
  if (!disabledAfterBack) {
    await follow().click();
    await bounded(entered[1].promise, "second follow held");
  }
  check("same target is not sent a second time", routeCount === 1, {
    intercepted: routeCount,
  });
  const failed = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/follow` && response.status() === 503,
    { timeout: 15_000 },
  );
  release.resolve();
  await failed;
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  check(
    "unknown follow offers a target-specific check instead of another send",
    (await row()
      .getByRole("link", { name: /状態を確認|Check status/ })
      .count()) === 1 && (await follow().count()) === 0,
  );
  check(
    "unknown follow notice names the original target",
    (await page
      .getByText(
        /フォローの結果を確認できません.*target|follow outcome is unconfirmed.*target/i,
      )
      .count()) === 1,
  );

  phase = "ordering";
  await page.goto(`${origin}/search?search=target&tab=users`);
  await page.getByText("Synthetic target", { exact: true }).waitFor();
  await bounded(followingEntered.promise, "original following GET held");
  const ack = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/follow` && response.status() === 200,
    { timeout: 15_000 },
  );
  await follow().click();
  await ack;
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  check(
    "follow ACK is initially visible",
    (await row()
      .getByText(/フォロー中|Following/, { exact: true })
      .count()) === 1 && (await follow().count()) === 0,
  );
  const followingResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      `/api/actors/${encodeURIComponent(actor.ap_id)}/following`,
    { timeout: 15_000 },
  );
  releaseFollowing.resolve();
  await followingResponse;
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  check(
    "older following GET cannot remove an acknowledged follow",
    !(await follow().isVisible()),
  );

  phase = "pending";
  await page.goto(`${origin}/search?search=target&tab=users`);
  await page.getByText("Synthetic target", { exact: true }).waitFor();
  const pendingAck = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/follow` && response.status() === 200,
    { timeout: 15_000 },
  );
  await follow().click();
  await pendingAck;
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  const pendingButton = row().getByRole("button", { name: /申請中|Requested/ });
  check(
    "pending ACK remains a request rather than Following",
    (await pendingButton.count()) === 1 &&
      (await pendingButton.isDisabled()) &&
      !(await row()
        .getByText(/フォロー中|Following/, { exact: true })
        .count()),
  );

  phase = "malformed";
  await page.goto(`${origin}/search?search=target&tab=users`);
  await page.getByText("Synthetic target", { exact: true }).waitFor();
  const malformedAck = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/follow` && response.status() === 200,
    { timeout: 15_000 },
  );
  await follow().click();
  await malformedAck;
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  check(
    "unrecognized 2xx does not claim Following or invite an automatic resend",
    (await follow().count()) === 0 &&
      (await row()
        .getByRole("link", { name: /状態を確認|Check status/ })
        .count()) === 1 &&
      (await page
        .getByText(
          /フォローの結果を確認できません.*target|follow outcome is unconfirmed.*target/i,
        )
        .count()) === 1,
  );

  phase = "rejected";
  await page.goto(`${origin}/search?search=target&tab=users`);
  await page.getByText("Synthetic target", { exact: true }).waitFor();
  const rejectedAck = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/follow` && response.status() === 400,
    { timeout: 15_000 },
  );
  await follow().click();
  await rejectedAck;
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  check(
    "received 400 is shown as rejection rather than an unknown result",
    (await page
      .getByText(
        /フォローは拒否されました.*target|follow was rejected.*target/i,
      )
      .count()) === 1 &&
      (await follow().count()) === 1 &&
      !(await follow().isDisabled()),
  );

  phase = "query";
  await page.goto(`${origin}/search?search=target&tab=users`);
  await page.getByText("Synthetic target", { exact: true }).waitFor();
  await follow().click();
  await bounded(queryEntered.promise, "query-change follow held");
  phase = "query-new";
  const search = page.getByRole("textbox", { name: /検索|Search/ });
  await search.fill("newer target");
  await search.press("Enter");
  await page.getByText("Newer synthetic target", { exact: true }).waitFor();
  check("new search uses the requested query", newQueryCount > 0);
  const newerRow = page
    .getByText("Newer synthetic target", { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'border-b')][1]");
  check(
    "same target remains locked when a new query returns a new row",
    await newerRow
      .getByRole("button", { name: /フォロー|Follow/ })
      .first()
      .isDisabled(),
  );
  const queryAck = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/follow` && response.status() === 200,
    { timeout: 15_000 },
  );
  releaseQuery.resolve();
  await queryAck;
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  check(
    "old ACK does not turn the newer row into an asserted follow",
    (await newerRow
      .getByText(/フォロー中|Following/, { exact: true })
      .count()) === 0 &&
      (await newerRow
        .getByRole("link", { name: /状態を確認|Check status/ })
        .count()) === 1,
  );
  check(
    "old ACK names the original target for an explicit check",
    (await page
      .getByText(
        /フォロー操作は受け付けられました.*target|follow request was accepted.*target/i,
      )
      .count()) === 1,
  );
  check("query change did not resend the original target", queryCount === 1);
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  release.resolve();
  releaseQuery.resolve();
  releaseFollowing.resolve();
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
  const expected = result.consoleErrors.filter(
    (entry) =>
      (/^Failed to load resource:.*(?:503|400)/.test(entry.text) &&
        entry.url === `${origin}/api/follow`) ||
      (/^Failed to follow: ApiError: synthetic follow (?:unavailable|rejected)(?:\n|$)/.test(
        entry.text,
      ) &&
        entry.url.startsWith(`${origin}/assets/`)),
  );
  if (
    expected.length !== result.failures * 2 ||
    expected.length !== result.consoleErrors.length
  )
    result.errors.push("unexpected console error or missing synthetic failure");
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
