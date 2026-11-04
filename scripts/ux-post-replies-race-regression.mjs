import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { once } from "node:events";
import { tmpdir } from "node:os";

const TIMEOUT = 15_000;
const chrome = process.env.CHROME_BIN ?? "/opt/google/chrome/chrome";
const evidence = process.argv[2];
if (!evidence || process.argv.length !== 3) {
  throw new Error(
    "usage: node scripts/ux-post-replies-race-regression.mjs <evidence-dir>",
  );
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout: ${label}`)),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

const result = {
  runtime: "current built Yurucommu UI with isolated loopback GET-only mock",
  checks: [],
  blockedExternal: [],
  blockedNonGet: [],
  apiRequests: [],
  consoleErrors: [],
  unexpectedErrors: [],
};
const held = [];
let web;
let mock;
let context;
let profile;
let scenario;
let origin;
let mockOrigin;
let postA;
let postB;
let idA;
let idB;

function check(name, pass, detail) {
  result.checks.push({ name, pass, detail });
}

function hold(name) {
  const request = { name, entered: deferred(), release: deferred() };
  held.push(request);
  return request;
}

async function json(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

try {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const dist = resolve("dist");
  web = createServer(async (request, response) => {
    try {
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      const file =
        path.startsWith("/assets/") || path === "/manifest.webmanifest"
          ? resolve(dist, `.${decodeURIComponent(path)}`)
          : join(dist, "index.html");
      if (!file.startsWith(dist + sep)) throw new Error("outside built assets");
      const types = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".webmanifest": "application/manifest+json",
      };
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": types[extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  origin = `http://127.0.0.1:${await listen(web)}`;
  const probe = createServer();
  const mockPort = await listen(probe);
  await new Promise((done) => probe.close(done));
  mockOrigin = `http://127.0.0.1:${mockPort}`;
  mock = spawn("bun", ["scripts/dev-mock-server.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      YURUCOMMU_MOCK_HOST: "127.0.0.1",
      YURUCOMMU_MOCK_PORT: String(mockPort),
      YURUCOMMU_MOCK_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let mockLog = "";
  const ready = deferred();
  mock.stdout.on("data", (chunk) => {
    mockLog += chunk;
    if (mockLog.includes("mock API listening")) ready.resolve();
  });
  mock.stderr.on("data", (chunk) => {
    mockLog += chunk;
  });
  mock.on("exit", (code) => {
    if (code !== 0) ready.resolve();
  });
  await bounded(ready.promise, "mock server startup");
  if (mock.exitCode !== null)
    throw new Error(`mock exited: ${mock.exitCode} ${mockLog}`);

  idA = `${origin}/ap/notes/post-1`;
  idB = `${origin}/ap/notes/post-2`;
  async function mockPost(id, content) {
    const response = await fetch(
      `${mockOrigin}/api/posts/${encodeURIComponent(id)}`,
    );
    if (!response.ok) throw new Error(`mock post returned ${response.status}`);
    return { ...(await response.json()).post, content, attachments: [] };
  }
  postA = await mockPost(idA, "Post A current");
  postB = await mockPost(idB, "Post B current");

  profile = await mkdtemp(
    join(process.env.TMPDIR ?? tmpdir(), "yuru-replies-profile-"),
  );
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chrome,
    headless: true,
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
    ],
    viewport: { width: 1280, height: 800 },
    locale: "ja-JP",
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      result.blockedNonGet.push({
        method: request.method(),
        path: url.pathname,
      });
      return route.abort();
    }
    if (url.origin !== origin) {
      result.blockedExternal.push({
        origin: url.origin,
        type: request.resourceType(),
      });
      if (request.resourceType() === "image") {
        return route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        });
      }
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    result.apiRequests.push({
      path: url.pathname,
      before: url.searchParams.get("before"),
    });
    if (url.pathname === "/api/notifications/pushers/config") {
      return json(route, {});
    }
    const match = url.pathname.match(/^\/api\/posts\/(.+?)(\/replies)?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const before = url.searchParams.get("before");
      if (!match[2] && (id === idA || id === idB)) {
        return json(route, { post: id === idA ? postA : postB });
      }
      if (match[2] && id === idA && !before) {
        return json(route, {
          replies: [{ ...postB, content: "Open post B" }],
          next_cursor: "cursor-A",
          has_more: true,
        });
      }
      if (match[2] && id === idA && before === "cursor-A" && scenario?.old) {
        scenario.old.entered.resolve();
        await scenario.old.release.promise;
        if (scenario.oldStatus === 503)
          return json(route, { error: "old-page-unavailable" }, 503);
        return json(route, {
          replies: [
            {
              ...postA,
              ap_id: `${origin}/ap/notes/stale-A`,
              content: "Stale reply from A",
            },
          ],
          next_cursor: null,
          has_more: false,
        });
      }
      if (match[2] && id === idB && !before) {
        scenario.bInitial++;
        if (scenario.failFirstB && scenario.bInitial === 1)
          return json(route, { error: "replies-unavailable" }, 503);
        return json(route, {
          replies: [
            {
              ...postB,
              ap_id: `${origin}/ap/notes/first-B`,
              content: "First reply from B",
            },
          ],
          next_cursor: "cursor-B",
          has_more: true,
        });
      }
      if (match[2] && id === idB && before === "cursor-B") {
        scenario.bPageCount++;
        if (scenario.current && scenario.bPageCount === 1) {
          scenario.current.entered.resolve();
          await scenario.current.release.promise;
        }
        if (scenario.failFirstBPage && scenario.bPageCount === 1)
          return json(route, { error: "page-unavailable" }, 503);
        return json(route, {
          replies: [
            {
              ...postB,
              ap_id: `${origin}/ap/notes/new-B`,
              content: "New reply from B",
            },
          ],
          next_cursor: null,
          has_more: false,
        });
      }
      if (match[2] && id === idB && before === "cursor-A") {
        scenario.wrongCursor++;
        return json(route, { replies: [], next_cursor: null, has_more: false });
      }
    }
    const response = await fetch(`${mockOrigin}${url.pathname}${url.search}`);
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  if (context.routeWebSocket) {
    await context.routeWebSocket("**/*", (socket) => socket.close());
  }
  await context.addInitScript(() => {
    globalThis.__replyBodies = [];
    const originalText = Response.prototype.text;
    Response.prototype.text = async function (...args) {
      const body = await originalText.apply(this, args);
      if (this.url.includes("/replies"))
        globalThis.__replyBodies.push(this.url);
      return body;
    };
  });

  const postPath = (id) => `/post/${encodeURIComponent(id)}`;
  const more = (page) =>
    page.getByRole("button", {
      name: /^(もっと見る|Load more|読み込み中\.\.\.|Loading\.\.\.)$/,
    });
  async function startPage(current) {
    scenario = { bInitial: 0, bPageCount: 0, wrongCursor: 0, ...current };
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      result.unexpectedErrors.push({
        name: "BrowserPageError",
        message: error.message,
      });
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        result.consoleErrors.push({
          message: message.text(),
          location: message.location(),
        });
      }
    });
    await page.goto(origin + postPath(idA));
    await page
      .getByText("Post A current", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    await page
      .getByText("Open post B", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    await more(page).waitFor({ timeout: TIMEOUT });
    return page;
  }
  async function navigateB(page) {
    await page.getByRole("link", { name: "Open post B" }).click();
    await page
      .getByText("Post B current", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    await page.waitForFunction(
      () =>
        globalThis.__replyBodies.some(
          (url) => url.includes("post-2") && !url.includes("before="),
        ),
      null,
      { timeout: TIMEOUT },
    );
  }
  async function consumed(page, needle) {
    await page.waitForFunction(
      (value) => globalThis.__replyBodies.some((url) => url.includes(value)),
      needle,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  }

  for (const oldStatus of [200, 503]) {
    const old = hold(`old-${oldStatus}`);
    const current = hold(`current-${oldStatus}`);
    const page = await startPage({ old, current, oldStatus });
    await more(page).click();
    await bounded(old.entered.promise, "old page request");
    await navigateB(page);
    const buttons = more(page);
    await buttons.waitFor({ timeout: TIMEOUT });
    const beforeRelease = {
      text: await buttons.textContent(),
      disabled: await buttons.isDisabled(),
    };
    check(
      `post B can paginate while prior post is pending (${oldStatus})`,
      !beforeRelease.disabled,
      beforeRelease,
    );
    if (!beforeRelease.disabled) {
      await buttons.click();
      await bounded(current.entered.promise, "current page request");
      old.release.resolve();
      await consumed(page, "cursor-A");
      const duringCurrent = {
        disabled: await more(page).isDisabled(),
        staleVisible: await page
          .getByText("Stale reply from A", { exact: true })
          .count(),
        errorVisible: await page
          .getByText("エラーが発生しました", { exact: true })
          .count(),
      };
      check(
        `old ${oldStatus} cannot settle B pending state or results`,
        duringCurrent.disabled &&
          !duringCurrent.staleVisible &&
          !duringCurrent.errorVisible,
        duringCurrent,
      );
      current.release.resolve();
      await page
        .getByText("New reply from B", { exact: true })
        .waitFor({ timeout: TIMEOUT });
      check(
        `B page settles correctly after old ${oldStatus}`,
        (await page.getByText("New reply from B", { exact: true }).count()) ===
          1,
        { pageRequests: scenario.bPageCount },
      );
    } else {
      old.release.resolve();
      await consumed(page, "cursor-A");
      check(
        `post B recovers after prior ${oldStatus} settles`,
        !(await more(page).isDisabled()),
        { text: await more(page).textContent() },
      );
    }
    await page.close();
  }

  {
    const page = await startPage({ failFirstB: true });
    await navigateB(page);
    await page
      .getByText(/読み込みに失敗しました|Failed to load/)
      .first()
      .waitFor({ timeout: TIMEOUT });
    const emptyState = await page
      .getByText(/まだ返信はありません|No replies yet/)
      .count();
    check(
      "initial reply failure is not presented as an empty list",
      emptyState === 0,
      { emptyState },
    );
    const staleButton = await more(page).count();
    if (staleButton) await more(page).click();
    check(
      "initial reply failure does not retain A pagination or send A cursor to B",
      staleButton === 0 && scenario.wrongCursor === 0,
      { staleButton, wrongCursor: scenario.wrongCursor },
    );
    await page.getByRole("button", { name: /^(再試行|Retry)$/ }).click();
    await page.waitForFunction(
      () =>
        globalThis.__replyBodies.filter(
          (url) => url.includes("post-2") && !url.includes("before="),
        ).length >= 2,
      null,
      { timeout: TIMEOUT },
    );
    await more(page).waitFor({ timeout: TIMEOUT });
    check("retry restores B pagination", !(await more(page).isDisabled()), {
      bInitial: scenario.bInitial,
    });
    await page.goBack();
    await page
      .getByText("Post A current", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    check(
      "browser Back returns to usable A pagination",
      !(await more(page).isDisabled()),
      { path: new URL(page.url()).pathname },
    );
    await page.close();
  }

  {
    const page = await startPage({ failFirstBPage: true });
    await navigateB(page);
    await more(page).click();
    await consumed(page, "cursor-B");
    await more(page).waitFor({ timeout: TIMEOUT });
    const pageError = await page
      .getByRole("alert")
      .getByText(/エラーが発生しました|An error occurred/)
      .count();
    const firstReply = await page
      .getByText("First reply from B", { exact: true })
      .count();
    check(
      "pagination failure remains visible without discarding replies",
      pageError === 1 && firstReply === 1,
      { pageError, firstReply },
    );
    check(
      "current-page failure allows explicit retry",
      !(await more(page).isDisabled()),
      { pageRequests: scenario.bPageCount },
    );
    await more(page).click();
    await page
      .getByText("New reply from B", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    check(
      "explicit retry displays the current post's replies",
      scenario.bPageCount === 2,
      { pageRequests: scenario.bPageCount },
    );
    await page.close();
  }
} catch (error) {
  result.unexpectedErrors.push({
    name: error?.name,
    message: String(error?.message ?? error),
  });
} finally {
  for (const request of held) request.release.resolve();
  if (context) await context.close();
  if (mock && mock.exitCode === null && mock.signalCode === null) {
    const exited = once(mock, "exit");
    mock.kill("SIGTERM");
    try {
      const [code, signal] = await bounded(exited, "mock server termination");
      result.mockShutdown = { code, signal };
    } catch (error) {
      result.unexpectedErrors.push({
        name: "CleanupError",
        message: String(error?.message ?? error),
      });
    }
  }
  if (web) await new Promise((done) => web.close(done));
  if (profile) await rm(profile, { recursive: true, force: true });
  for (const error of result.consoleErrors) {
    const expectedResource =
      error.message.startsWith("Failed to load resource:") &&
      error.message.includes("503") &&
      error.location.url.startsWith(`${origin}/api/posts/`) &&
      error.location.url.includes("/replies");
    const expectedApplication =
      /^Failed to load (?:more )?replies: ApiError: (?:old-page-unavailable|replies-unavailable|page-unavailable)/.test(
        error.message,
      );
    if (!expectedResource && !expectedApplication) {
      result.unexpectedErrors.push({
        name: "UnexpectedBrowserConsoleError",
        message: error.message,
      });
    }
  }
  check("no non-GET request was attempted", result.blockedNonGet.length === 0, {
    blockedNonGet: result.blockedNonGet.length,
  });
  result.status = result.unexpectedErrors.length
    ? "HARNESS_ERROR"
    : result.checks.every((item) => item.pass)
      ? "PASS"
      : "RED";
  await writeFile(
    join(evidence, "RESULT.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
}
