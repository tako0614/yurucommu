import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { once } from "node:events";

const evidence = process.argv[2];
if (!evidence)
  throw new Error(
    "usage: node scripts/ux-post-action-target-regression.mjs <evidence-directory>",
  );
const timeout = 15_000;
const pending = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout: ${label}`)),
          timeout,
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
async function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const result = {
  scope:
    "built UI, loopback fixtures, intercepted synthetic actions only; no actual action forwarded",
  checks: [],
  blockedExternal: 0,
  blockedNonGet: [],
  errors: [],
};
let web,
  mock,
  context,
  profile,
  current,
  origin,
  mockOrigin,
  postA,
  postB,
  idA,
  idB;
try {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const dist = resolve("dist");
  web = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") return res.writeHead(405).end();
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      const file =
        path.startsWith("/assets/") || path === "/manifest.webmanifest"
          ? resolve(dist, `.${decodeURIComponent(path)}`)
          : join(dist, "index.html");
      if (!file.startsWith(dist + sep)) throw new Error("outside dist");
      const types = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".webmanifest": "application/manifest+json",
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
  const probe = createServer();
  const mockPort = await listen(probe);
  await new Promise((done) => probe.close(done));
  mockOrigin = `http://127.0.0.1:${mockPort}`;
  mock = spawn("bun", ["scripts/dev-mock-server.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: "/root/dev/tmp",
      YURUCOMMU_MOCK_HOST: "127.0.0.1",
      YURUCOMMU_MOCK_PORT: String(mockPort),
      YURUCOMMU_MOCK_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const ready = pending();
  mock.stdout.on("data", (part) => {
    logs += part;
    if (logs.includes("mock API listening")) ready.resolve();
  });
  mock.stderr.on("data", (part) => {
    logs += part;
  });
  mock.on("exit", () => ready.resolve());
  await bounded(ready.promise, "mock startup");
  if (mock.exitCode !== null) throw new Error(`mock exited: ${mock.exitCode}`);
  idA = `${origin}/ap/notes/post-1`;
  idB = `${origin}/ap/notes/post-2`;
  async function getPost(id, content) {
    const response = await fetch(
      `${mockOrigin}/api/posts/${encodeURIComponent(id)}`,
    );
    if (!response.ok) throw new Error("mock post unavailable");
    return {
      ...(await response.json()).post,
      ap_id: id,
      content,
      attachments: [],
      liked: false,
      reposted: false,
      visibility: "public",
      community_ap_id: null,
    };
  }
  postA = await getPost(idA, "Post A current");
  postB = await getPost(idB, "Post B current");
  const authResponse = await fetch(`${mockOrigin}/api/auth/me`);
  if (!authResponse.ok) throw new Error("mock actor unavailable");
  const actor = (await authResponse.json()).actor;
  postA = {
    ...postA,
    author: { ...postA.author, ap_id: actor.ap_id },
    like_count: 3,
  };
  // Two posts from the same author must still be distinguishable on an error.
  postA = { ...postA, bookmarked: false };
  postB = { ...postB, author: postA.author, bookmarked: false };
  profile = await mkdtemp("/root/dev/tmp/yuru-post-action-profile-");
  context = await chromium.launchPersistentContext(profile, {
    executablePath: "/opt/google/chrome/chrome",
    headless: true,
    env: { PATH: process.env.PATH ?? "", TMPDIR: "/root/dev/tmp" },
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
    const req = route.request();
    const url = new URL(req.url());
    const expected = `/api/posts/${encodeURIComponent(current?.target ?? idA)}/${current?.action}`;
    if (
      current?.laterUndo &&
      req.method() === "DELETE" &&
      url.origin === origin &&
      url.pathname === expected
    ) {
      current.undoCount++;
      current.undoEntered?.resolve();
      if (current.holdUndo) await current.releaseUndo.promise;
      current.undoAccepted = true;
      return json(route, { ok: true });
    }
    if (
      req.method() === (current?.method ?? "POST") &&
      url.origin === origin &&
      url.pathname === expected &&
      current
    ) {
      current.count++;
      current.entered.resolve();
      await current.release.promise;
      if (current.status === 200) current.acknowledged = true;
      return json(
        route,
        current.status === 200
          ? { ok: true }
          : { error: "synthetic action unavailable" },
        current.status,
      );
    }
    if (
      req.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/posts" &&
      current?.replyFailure
    ) {
      current.replyCount++;
      return json(route, { error: "synthetic reply unavailable" }, 503);
    }
    if (
      req.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/auth/logout" &&
      current?.simulateLogout
    ) {
      current.logoutCount++;
      return json(route, { success: true });
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
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/notifications/pushers/config")
      return json(route, {});
    if (url.pathname === "/api/timeline" && current?.feed) {
      return json(route, {
        posts: [
          {
            ...postA,
            liked: current.feedLiked ?? false,
            like_count: current.feedCount ?? 3,
            reposted: current.feedReposted ?? false,
            announce_count: current.feedAnnounceCount ?? postA.announce_count,
          },
          postB,
        ],
        next_cursor: null,
        has_more: false,
      });
    }
    const match = url.pathname.match(/^\/api\/posts\/(.+?)(\/replies)?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (!match[2] && (id === idA || id === idB)) {
        let value = id === idA ? postA : postB;
        if (id === (current?.target ?? idA)) {
          if (current?.initialBookmarked)
            value = { ...value, bookmarked: true };
          if (current?.initialLiked)
            value = { ...value, liked: true, like_count: value.like_count + 1 };
          if (current?.initialReposted)
            value = {
              ...value,
              reposted: true,
              announce_count: value.announce_count + 1,
            };
          if (current?.holdReentryGet && ++current.targetGets === 2) {
            const stale = { ...value };
            current.reentryGetEntered.resolve();
            await current.releaseReentryGet.promise;
            return json(route, { post: stale });
          }
        }
        if (
          current?.acknowledged &&
          id === (current.target ?? idA) &&
          (!current.laterUndo || !current.undoAccepted)
        ) {
          if (current.failAckGet)
            return json(route, { error: "synthetic read unavailable" }, 503);
          if (current.holdAckGet && !current.ackGetHeld) {
            current.ackGetHeld = true;
            current.ackGetEntered.resolve();
            await current.releaseAckGet.promise;
          }
          const desired = (current.method ?? "POST") === "POST";
          value =
            current.action === "bookmark"
              ? { ...value, bookmarked: desired }
              : current.action === "like"
                ? {
                    ...value,
                    liked: desired,
                    like_count: value.like_count + (desired ? 1 : -1),
                  }
                : {
                    ...value,
                    reposted: desired,
                    announce_count: value.announce_count + (desired ? 1 : -1),
                  };
        }
        return json(route, { post: value });
      }
      if (match[2] && id === idA)
        return json(route, {
          replies: [{ ...postB, content: "Open post B" }],
          next_cursor: null,
          has_more: false,
        });
      if (match[2] && id === idB)
        return json(route, { replies: [], next_cursor: null, has_more: false });
    }
    const response = await fetch(`${mockOrigin}${url.pathname}${url.search}`);
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  if (context.routeWebSocket)
    await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.addInitScript(() => {
    globalThis.__completedSyntheticActions = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      if (
        typeof args[0] === "string" &&
        /\/(like|repost|bookmark)$/.test(args[0])
      )
        globalThis.__completedSyntheticActions++;
      return response;
    };
  });

  for (const status of [200, 503]) {
    current = {
      action: "bookmark",
      status,
      count: 0,
      entered: pending(),
      release: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar
      .getByRole("button", { name: /^(ブックマーク|Bookmark)$/ })
      .click();
    await bounded(current.entered.promise, "synthetic bookmark request");
    await page.getByRole("link", { name: "Open post B" }).click();
    await page
      .getByText("Post B current", { exact: true })
      .waitFor({ timeout });
    current.release.resolve();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 1,
      null,
      { timeout },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const b = bar.getByRole("button", { name: /^(ブックマーク|Bookmark)$/ });
    const bPressed = await b.getAttribute("aria-pressed");
    const bInline = await page.locator('main [role="alert"]').count();
    const originalNotice = await page
      .getByRole("alert")
      .filter({ hasText: idA })
      .count();
    result.checks.push({
      name: `bookmark A ${status} after navigation to B`,
      pass:
        current.count === 1 &&
        bPressed === "false" &&
        (status === 200 || (bInline === 0 && originalNotice === 1)),
      bPressed,
      bInline,
      originalNotice,
      intercepted: current.count,
    });
    await page.close();
  }
  for (const status of [200, 503]) {
    current = {
      action: "bookmark",
      method: "DELETE",
      initialBookmarked: true,
      status,
      count: 0,
      entered: pending(),
      release: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar
      .getByRole("button", { name: /^(ブックマークを外す|Remove bookmark)$/ })
      .click();
    await bounded(current.entered.promise, "original unbookmark request");
    current.release.resolve();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 1,
      null,
      { timeout },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const button = bar.locator(
      'button[aria-label="ブックマーク"],button[aria-label="ブックマークを外す"],button[aria-label="Bookmark"],button[aria-label="Remove bookmark"]',
    );
    const pressed = await button.getAttribute("aria-pressed");
    const targetAlert = page.getByRole("alert").filter({ hasText: idA });
    if (status === 503) await targetAlert.waitFor({ timeout });
    const alerts = await targetAlert.count();
    result.checks.push({
      name: `same-target unbookmark ${status} retains the original action state`,
      pass:
        current.count === 1 &&
        pressed === (status === 200 ? "false" : "true") &&
        alerts === (status === 200 ? 0 : 1),
      pressed,
      alerts,
      intercepted: current.count,
    });
    await page.close();
  }
  {
    current = {
      action: "bookmark",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
      holdAckGet: true,
      ackGetEntered: pending(),
      releaseAckGet: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar
      .getByRole("button", { name: /^(ブックマーク|Bookmark)$/ })
      .click();
    await bounded(current.entered.promise, "first bookmark");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    await page.getByRole("link", { name: "Post A current" }).click();
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const again = bar.getByRole("button", {
      name: /^(ブックマーク|Bookmark)$/,
    });
    const busy = await again.getAttribute("aria-disabled");
    await again.dispatchEvent("click");
    await new Promise((done) => setTimeout(done, 200));
    const before = current.count;
    current.release.resolve();
    await page.waitForFunction(
      (n) => globalThis.__completedSyntheticActions >= n,
      before,
      { timeout },
    );
    await bounded(current.ackGetEntered.promise, "post-ACK original read");
    const busyDuringRead = await again.getAttribute("aria-disabled");
    await again.dispatchEvent("click");
    const duringRead = current.count;
    current.releaseAckGet.resolve();
    await bar
      .getByRole("button", { name: /^(ブックマークを外す|Remove bookmark)$/ })
      .waitFor({ timeout });
    const finalPressed = await bar
      .getByRole("button", { name: /^(ブックマークを外す|Remove bookmark)$/ })
      .getAttribute("aria-pressed");
    result.checks.push({
      name: "bookmark remount retains pending lock through post-ACK read",
      pass:
        busy === "true" &&
        before === 1 &&
        busyDuringRead === "true" &&
        duringRead === 1 &&
        finalPressed === "true",
      busy,
      intercepted: before,
      busyDuringRead,
      duringRead,
      finalPressed,
    });
    await page.close();
  }
  {
    current = {
      action: "bookmark",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
      failAckGet: true,
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar
      .getByRole("button", { name: /^(ブックマーク|Bookmark)$/ })
      .click();
    await bounded(current.entered.promise, "bookmark before failed refresh");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    await page.getByRole("link", { name: "Post A current" }).click();
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    current.release.resolve();
    await page
      .getByText(/最新の投稿を取得できません|post could not be refreshed/i)
      .waitFor({ timeout });
    const button = bar.getByRole("button", {
      name: /^(ブックマーク|Bookmark)$/,
    });
    await page.waitForFunction(
      () =>
        !document.querySelector(
          'button[aria-label="ブックマーク"][aria-disabled="true"]',
        ),
      null,
      { timeout },
    );
    result.checks.push({
      name: "acknowledged bookmark reports failed original refresh without retry",
      pass:
        current.count === 1 &&
        (await button.getAttribute("aria-disabled")) !== "true",
      intercepted: current.count,
      busy: await button.getAttribute("aria-disabled"),
    });
    await page.close();
  }
  for (const status of [200, 503]) {
    current = {
      action: "bookmark",
      status,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
      simulateLogout: true,
      logoutCount: 0,
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar
      .getByRole("button", { name: /^(ブックマーク|Bookmark)$/ })
      .click();
    await bounded(current.entered.promise, "bookmark before epoch change");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    const card = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    await card
      .getByRole("button", { name: /^(ブックマーク|Bookmark)(?: |$)/ })
      .waitFor({ timeout });
    await page.locator('aside button[aria-haspopup="dialog"]').click();
    await page.getByRole("button", { name: /^(ログアウト|Logout)$/ }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^(ログアウト|Logout)$/ })
      .click();
    await page
      .getByText(
        /ログアウトできたか確認できません|could not confirm.*log.?out/i,
      )
      .waitFor({ timeout });
    current.release.resolve();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 1,
      null,
      { timeout },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const pressed = await card
      .locator(
        'button[aria-label^="ブックマーク"],button[aria-label^="Bookmark"],button[aria-label^="Remove bookmark"]',
      )
      .getAttribute("aria-pressed");
    const oldTargetAlerts = await page
      .getByRole("alert")
      .filter({ hasText: idA })
      .count();
    result.checks.push({
      name: `old bookmark ${status} cannot update newer auth epoch`,
      pass:
        pressed === "false" &&
        current.logoutCount === 1 &&
        (await page.locator('main [role="alert"]').count()) === 0 &&
        oldTargetAlerts === 0,
      pressed,
      oldTargetAlerts,
      logoutCount: current.logoutCount,
      intercepted: current.count,
    });
    await page.close();
  }
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  current?.release.resolve();
  current?.releaseAckGet?.resolve();
  current?.releaseReentryGet?.resolve();
  current?.releaseUndo?.resolve();
  if (context) await context.close();
  if (mock && mock.exitCode === null && mock.signalCode === null) {
    const exited = once(mock, "exit");
    mock.kill("SIGTERM");
    try {
      const [code, signal] = await bounded(exited, "mock cleanup");
      result.mockShutdown = { code, signal };
    } catch (error) {
      result.errors.push(String(error));
    }
  }
  if (web) await new Promise((done) => web.close(done));
  if (profile) await rm(profile, { recursive: true, force: true });
  result.status =
    result.errors.length || result.blockedNonGet.length
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
