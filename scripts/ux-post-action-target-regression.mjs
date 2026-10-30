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
  postB = { ...postB, author: postA.author };
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
        if (current?.holdRevalidation && current.acknowledged && id === idA) {
          current.revalidationEntered.resolve();
          await current.releaseRevalidation.promise;
        }
        if (
          current?.acknowledged &&
          id === (current.target ?? idA) &&
          (!current.laterUndo || !current.undoAccepted)
        ) {
          const desired = (current.method ?? "POST") === "POST";
          value =
            current.action === "like"
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
      if (typeof args[0] === "string" && /\/(like|repost)$/.test(args[0]))
        globalThis.__completedSyntheticActions++;
      return response;
    };
  });
  for (const { action, status, stay } of [
    { action: "like", status: 200 },
    { action: "repost", status: 200 },
    { action: "like", status: 503 },
    { action: "like", status: 200, stay: true },
    { action: "repost", status: 200, stay: true },
  ]) {
    current = {
      action,
      status,
      count: 0,
      entered: pending(),
      release: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const actionBar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    const actionSelector =
      action === "repost"
        ? 'button[aria-label="リポスト"], button[aria-label="リポストを取り消す"], button[aria-label="Repost"], button[aria-label="Undo repost"]'
        : 'button[aria-label="いいね"], button[aria-label="いいねを取り消す"], button[aria-label="Like"], button[aria-label="Unlike"]';
    await actionBar.locator(actionSelector).click();
    await bounded(current.entered.promise, `${action} fixture request`);
    if (!stay) {
      await page.getByRole("link", { name: "Open post B" }).click();
      await page.waitForURL(`${origin}/post/${encodeURIComponent(idB)}`, {
        timeout,
      });
      await page
        .getByText("Post B current", { exact: true })
        .waitFor({ timeout });
    }
    const button = actionBar.locator(actionSelector);
    const before = await button.getAttribute("aria-pressed");
    const beforeAlerts = await page.getByRole("alert").count();
    const beforeInlineAlerts = await page
      .locator('main [role="alert"]')
      .count();
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
    const after = await button.getAttribute("aria-pressed");
    const alerts = await page.getByRole("alert").count();
    const inlineAlerts = await page.locator('main [role="alert"]').count();
    const originalAuthor =
      postA.author.username || postA.author.preferred_username;
    const namedError =
      status === 503
        ? await page
            .getByRole("alert")
            .filter({ hasText: `@${originalAuthor}` })
            .count()
        : 0;
    const targetError =
      status === 503
        ? await page.getByRole("alert").filter({ hasText: idA }).count()
        : 0;
    const unconfirmedError =
      status === 503
        ? await page
            .getByRole("alert")
            .filter({
              hasText: /結果を確認できません|result could not be confirmed/i,
            })
            .count()
        : 0;
    result.checks.push({
      action,
      response: status,
      stay: Boolean(stay),
      pass:
        current.count === 1 &&
        before === "false" &&
        (status === 200
          ? after === (stay ? "true" : "false")
          : inlineAlerts === beforeInlineAlerts &&
            namedError === 1 &&
            targetError === 1 &&
            unconfirmedError === 1),
      before,
      after,
      beforeAlerts,
      alerts,
      beforeInlineAlerts,
      inlineAlerts,
      namedError,
      targetError,
      unconfirmedError,
      intercepted: current.count,
    });
    await page.close();
  }
  {
    current = {
      action: "like",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
      holdRevalidation: true,
      revalidationEntered: pending(),
      releaseRevalidation: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar.getByRole("button", { name: /^(いいね|Like)$/ }).click();
    await bounded(current.entered.promise, "held first action");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    await page.getByRole("link", { name: "Post A current" }).click();
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    current.release.resolve();
    await bounded(current.revalidationEntered.promise, "post-ACK target GET");
    const button = bar.getByRole("button", { name: /^(いいね|Like)$/ });
    const busy = await button.getAttribute("aria-disabled");
    await button.dispatchEvent("click");
    await new Promise((done) => setTimeout(done, 200));
    const requests = current.count;
    current.releaseRevalidation.resolve();
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    result.checks.push({
      name: "same target cannot duplicate while post-ACK GET is pending",
      pass: busy === "true" && requests === 1,
      busy,
      requests,
    });
    await page.close();
  }
  {
    current = {
      action: "like",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
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
    const button = bar.getByRole("button", { name: /^(いいね|Like)$/ });
    await button.click();
    await bounded(current.entered.promise, "held action before failed logout");
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
    const busy = await button.getAttribute("aria-disabled");
    await button.dispatchEvent("click");
    await new Promise((done) => setTimeout(done, 200));
    const requests = current.count;
    current.release.resolve();
    await page.waitForFunction(
      (n) => globalThis.__completedSyntheticActions >= n,
      requests,
      { timeout },
    );
    result.checks.push({
      name: "failed logout does not allow duplicate action for same actor",
      pass: busy === "true" && requests === 1 && current.logoutCount === 1,
      busy,
      requests,
      logoutCount: current.logoutCount,
    });
    await page.close();
  }

  {
    // The newer optimistic Unlike is still in flight when the older Like
    // response arrives and the server still reports the older state.
    current = {
      action: "like",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
      feedLiked: true,
      feedCount: 4,
      laterUndo: true,
      holdUndo: true,
      undoCount: 0,
      undoEntered: pending(),
      releaseUndo: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar.getByRole("button", { name: /^(いいね|Like)$/ }).click();
    await bounded(current.entered.promise, "older like awaiting ACK");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    const card = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    await card
      .getByRole("button", { name: /^(いいねを取り消す|Unlike)(?: |$)/ })
      .click();
    await bounded(current.undoEntered.promise, "newer unlike still pending");
    current.release.resolve();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 1,
      null,
      { timeout },
    );
    await new Promise((done) => setTimeout(done, 200));
    const during = await card
      .locator(
        'button[aria-label^="いいね"],button[aria-label^="Like"],button[aria-label^="Unlike"]',
      )
      .getAttribute("aria-pressed");
    current.releaseUndo.resolve();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 2,
      null,
      { timeout },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const after = await card
      .locator(
        'button[aria-label^="いいね"],button[aria-label^="Like"],button[aria-label^="Unlike"]',
      )
      .getAttribute("aria-pressed");
    const notice = await page
      .getByRole("status")
      .filter({ hasText: idA })
      .count();
    result.checks.push({
      name: "old ACK and read cannot reverse an in-flight newer timeline unlike",
      pass:
        during === "false" &&
        after === "false" &&
        notice === 1 &&
        current.undoCount === 1 &&
        current.count === 1,
      during,
      after,
      notice,
      undoCount: current.undoCount,
      earlierCount: current.count,
    });
    await page.close();
  }
  {
    current = {
      action: "repost",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
      feedReposted: true,
      feedAnnounceCount: postA.announce_count + 1,
      laterUndo: true,
      holdUndo: true,
      undoCount: 0,
      undoEntered: pending(),
      releaseUndo: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar.getByRole("button", { name: /^(リポスト|Repost)$/ }).click();
    await bounded(current.entered.promise, "older repost awaiting ACK");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    const card = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    await card
      .getByRole("button", { name: /^(リポストを取り消す|Undo repost)(?: |$)/ })
      .click();
    await bounded(current.undoEntered.promise, "newer unrepost still pending");
    current.release.resolve();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 1,
      null,
      { timeout },
    );
    await new Promise((done) => setTimeout(done, 200));
    const during = await card
      .locator(
        'button[aria-label^="リポスト"],button[aria-label^="Repost"],button[aria-label^="Undo repost"]',
      )
      .getAttribute("aria-pressed");
    const notice = await page
      .getByRole("status")
      .filter({ hasText: idA })
      .count();
    current.releaseUndo.resolve();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 2,
      null,
      { timeout },
    );
    const after = await card
      .locator(
        'button[aria-label^="リポスト"],button[aria-label^="Repost"],button[aria-label^="Undo repost"]',
      )
      .getAttribute("aria-pressed");
    result.checks.push({
      name: "old repost ACK cannot reverse an in-flight newer timeline unrepost",
      pass:
        during === "false" &&
        after === "false" &&
        notice === 1 &&
        current.undoCount === 1 &&
        current.count === 1,
      during,
      after,
      notice,
      undoCount: current.undoCount,
      earlierCount: current.count,
    });
    await page.close();
  }
  for (const action of ["like", "repost"]) {
    current = {
      action,
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    const selector =
      action === "like"
        ? 'button[aria-label="いいね"],button[aria-label="Like"]'
        : 'button[aria-label="リポスト"],button[aria-label="Repost"]';
    await bar.locator(selector).click();
    await bounded(current.entered.promise, `original ${action}`);
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    await page.getByRole("link", { name: "Post A current" }).click();
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const reopened = bar.locator(selector);
    const busy = await reopened.getAttribute("aria-disabled");
    await reopened.dispatchEvent("click");
    await new Promise((done) => setTimeout(done, 200));
    const beforeRelease = current.count;
    current.release.resolve();
    await page.waitForFunction(
      (count) => globalThis.__completedSyntheticActions >= count,
      beforeRelease,
      { timeout },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const displayed = await bar.locator('button[aria-pressed="true"]').count();
    result.checks.push({
      name: `reopened ${action} retains pending ownership and updates after ACK`,
      pass: busy === "true" && beforeRelease === 1 && displayed === 1,
      busy,
      intercepted: beforeRelease,
      displayed,
    });
    await page.close();
  }
  {
    // The first Like has committed, but its response is delayed. A newer
    // Unlike completes through the ordinary timeline before that response.
    current = {
      action: "like",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
      feedLiked: true,
      feedCount: 4,
      laterUndo: true,
      undoCount: 0,
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar.getByRole("button", { name: /^(いいね|Like)$/ }).click();
    await bounded(current.entered.promise, "held earlier like ACK");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    const card = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    const unlike = card.getByRole("button", {
      name: /^(いいねを取り消す|Unlike)(?: |$)/,
    });
    await unlike.click();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 1,
      null,
      { timeout },
    );
    const laterLike = card.getByRole("button", {
      name: /^(いいね|Like)(?: |$)/,
    });
    const before = await laterLike.getAttribute("aria-pressed");
    current.release.resolve();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 2,
      null,
      { timeout },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const after = await card
      .locator(
        'button[aria-label^="いいね"],button[aria-label^="Like"],button[aria-label^="Unlike"]',
      )
      .getAttribute("aria-pressed");
    result.checks.push({
      name: "old detail ACK cannot reverse newer timeline unlike",
      pass:
        before === "false" &&
        after === "false" &&
        current.undoCount === 1 &&
        current.count === 1,
      before,
      after,
      undoCount: current.undoCount,
      earlierCount: current.count,
    });
    await page.close();
  }
  for (const action of ["like", "repost"]) {
    current = {
      action,
      method: "DELETE",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      initialLiked: action === "like",
      initialReposted: action === "repost",
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    const beforeSelector =
      action === "like"
        ? 'button[aria-label="いいねを取り消す"],button[aria-label="Unlike"]'
        : 'button[aria-label="リポストを取り消す"],button[aria-label="Undo repost"]';
    await bar.locator(beforeSelector).click();
    await bounded(current.entered.promise, `synthetic undo ${action}`);
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
    const afterSelector =
      action === "like"
        ? 'button[aria-label="いいね"],button[aria-label="Like"]'
        : 'button[aria-label="リポスト"],button[aria-label="Repost"]';
    const pressed = await bar
      .locator(afterSelector)
      .getAttribute("aria-pressed");
    result.checks.push({
      name: `acknowledged undo ${action}`,
      pass: pressed === "false" && current.count === 1,
      pressed,
      intercepted: current.count,
    });
    await page.close();
  }
  {
    current = {
      action: "like",
      target: idB,
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    const reply = page
      .getByText("Open post B", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    await reply.getByRole("button", { name: /^(いいね|Like)$/ }).click();
    await bounded(current.entered.promise, "reply B like");
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
    const mainButton = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first()
      .getByRole("button", { name: /^(いいねを取り消す|Unlike)$/ });
    await mainButton.waitFor({ timeout });
    const pressed = await mainButton.getAttribute("aria-pressed");
    result.checks.push({
      name: "reply target opened as its own detail refreshes after ACK",
      pass: pressed === "true" && current.count === 1,
      pressed,
      intercepted: current.count,
    });
    await page.close();
  }
  {
    current = {
      action: "like",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
      holdReentryGet: true,
      targetGets: 0,
      reentryGetEntered: pending(),
      releaseReentryGet: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar.getByRole("button", { name: /^(いいね|Like)$/ }).click();
    await bounded(
      current.entered.promise,
      "held action before stale reentry read",
    );
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    await page.getByRole("link", { name: "Post A current" }).click();
    await bounded(current.reentryGetEntered.promise, "stale reentry GET");
    current.release.resolve();
    await page.waitForFunction(
      () => globalThis.__completedSyntheticActions === 1,
      null,
      { timeout },
    );
    await page.waitForFunction(
      () => document.querySelector("textarea") !== null,
      null,
      { timeout },
    );
    const composer = page.locator("textarea").first();
    await composer.fill("new draft survives older GET");
    current.releaseReentryGet.resolve();
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const pressed = await bar
      .getByRole("button", { name: /^(いいねを取り消す|Unlike)$/ })
      .getAttribute("aria-pressed");
    const draft = await composer.inputValue();
    result.checks.push({
      name: "ACK while a stale reentry GET is pending preserves fresh state and draft",
      pass:
        pressed === "true" &&
        draft === "new draft survives older GET" &&
        current.count === 1 &&
        current.targetGets >= 3,
      pressed,
      draft,
      reads: current.targetGets,
      intercepted: current.count,
    });
    await page.close();
  }
  {
    current = {
      action: "like",
      status: 503,
      count: 0,
      entered: pending(),
      release: pending(),
      replyFailure: true,
      replyCount: 0,
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const composer = page.locator("textarea").first();
    await composer.fill("synthetic uncertain reply");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    const replyWarning = page.getByRole("alert").filter({
      hasText: /投稿結果を確認できません|post result could not be confirmed/i,
    });
    await replyWarning.waitFor({ timeout });
    const bar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await bar.getByRole("button", { name: /^(いいね|Like)$/ }).click();
    await bounded(current.entered.promise, "held action after unknown reply");
    const during = await replyWarning.count();
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
    const after = await replyWarning.count();
    const actionUnconfirmed = await page
      .getByRole("alert")
      .filter({
        hasText: /結果を確認できません|result could not be confirmed/i,
      })
      .count();
    result.checks.push({
      name: "action start and failure preserve uncertain reply warning",
      pass:
        during === 1 &&
        after === 1 &&
        actionUnconfirmed >= 2 &&
        current.replyCount === 1 &&
        current.count === 1,
      during,
      after,
      actionUnconfirmed,
      replyCount: current.replyCount,
      actionCount: current.count,
    });
    await page.close();
  }
  for (const { name, feedLiked, feedCount, simulateLogout, startAtFeed } of [
    {
      name: "same-session original timeline update",
      feedLiked: false,
      feedCount: 3,
      startAtFeed: true,
    },
    {
      name: "already observed like is not counted twice",
      feedLiked: true,
      feedCount: 4,
    },
    {
      name: "old auth epoch cannot update timeline or toast",
      feedLiked: false,
      feedCount: 3,
      simulateLogout: true,
    },
  ]) {
    current = {
      action: "like",
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
      feed: true,
      feedLiked,
      feedCount,
      simulateLogout,
      logoutCount: 0,
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(
      startAtFeed ? origin + "/" : `${origin}/post/${encodeURIComponent(idA)}`,
    );
    if (startAtFeed)
      await page.getByRole("link", { name: "Post A current" }).click();
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const actionBar = page
      .locator("div.flex.items-center.justify-around.mt-3.pt-3")
      .first();
    await actionBar.getByRole("button", { name: /^(いいね|Like)$/ }).click();
    await bounded(current.entered.promise, `${name} fixture request`);
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    const cardA = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    const cardB = page
      .getByText("Post B current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    const aLike = cardA.locator(
      'button[aria-label^="いいね"], button[aria-label^="Like"], button[aria-label^="Unlike"]',
    );
    const bLike = cardB.locator(
      'button[aria-label^="いいね"], button[aria-label^="Like"], button[aria-label^="Unlike"]',
    );
    await aLike.waitFor({ timeout });
    if (simulateLogout) {
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
    }
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
    const aPressed = await aLike.getAttribute("aria-pressed");
    const bPressed = await bLike.getAttribute("aria-pressed");
    const aLabel = await aLike.getAttribute("aria-label");
    const namedErrors = await page
      .getByRole("alert")
      .filter({
        hasText: `@${postA.author.username || postA.author.preferred_username}`,
      })
      .count();
    const observed = {
      name,
      aPressed,
      bPressed,
      aLabel,
      namedErrors,
      intercepted: current.count,
      syntheticLogoutCount: current.logoutCount,
    };
    const expectedPressed = simulateLogout ? "false" : "true";
    const expectedCount = simulateLogout ? 3 : 4;
    result.checks.push({
      ...observed,
      pass:
        aPressed === expectedPressed &&
        bPressed === "false" &&
        aLabel.endsWith(` ${expectedCount}`) &&
        namedErrors === 0 &&
        current.count === 1 &&
        (!simulateLogout || current.logoutCount === 1),
    });
    await page.close();
  }
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  current?.release.resolve();
  current?.releaseReentryGet?.resolve();
  current?.releaseUndo?.resolve();
  current?.releaseRevalidation?.resolve();
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
