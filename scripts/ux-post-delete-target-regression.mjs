import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { once } from "node:events";

const evidence = process.argv[2];
if (!evidence)
  throw new Error(
    "usage: node scripts/ux-post-delete-target-regression.mjs <evidence-directory>",
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
  postC,
  idA,
  idB,
  idC;
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
  postA = { ...postA, bookmarked: false, reply_count: 3 };
  postB = { ...postB, author: postA.author, bookmarked: false, reply_count: 7 };
  idC = `${origin}/ap/notes/post-3`;
  postC = {
    ...postB,
    ap_id: idC,
    content: "Reply C to delete",
    reply_count: 0,
  };
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
    const expected = `/api/posts/${encodeURIComponent(current?.target ?? idA)}${current?.action === "delete" ? "" : `/${current?.action}`}`;
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
      if (!match[2] && (id === idA || id === idB || id === idC)) {
        if (
          current?.action === "delete" &&
          current.acknowledged &&
          id === current.target
        )
          return json(route, { error: "synthetic post deleted" }, 404);
        let value = id === idA ? postA : id === idB ? postB : postC;
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
          replies:
            current?.action === "delete" &&
            current.acknowledged &&
            current.target === idC
              ? [{ ...postB, content: "Open post B" }]
              : [{ ...postB, content: "Open post B" }, postC],
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
        (args[1]?.method ?? "GET") === "DELETE" &&
        /\/api\/posts\/[^/]+$/.test(args[0])
      )
        globalThis.__completedSyntheticActions++;
      return response;
    };
  });

  async function beginDelete(page, target) {
    if (target === "main") {
      await page
        .locator("div.px-4.py-4.border-b")
        .first()
        .getByRole("button", { name: /^(削除|Delete)$/ })
        .click();
    } else {
      const row = page
        .getByRole("link", { name: "Reply C to delete" })
        .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
      await row.getByRole("button", { name: /^(削除|Delete)$/ }).click();
    }
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^(削除|Delete)$/ })
      .click();
    await bounded(current.entered.promise, "synthetic delete dispatch");
  }
  for (const scenario of ["main-success", "reply-success", "main-unknown"]) {
    current = {
      action: "delete",
      method: "DELETE",
      target: scenario === "reply-success" ? idC : idA,
      status: scenario === "main-unknown" ? 503 : 200,
      count: 0,
      entered: pending(),
      release: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    await beginDelete(page, scenario === "reply-success" ? "reply" : "main");
    await page.getByRole("link", { name: "Open post B" }).click();
    await page
      .getByText("Post B current", { exact: true })
      .waitFor({ timeout });
    const before = await page
      .locator("div.px-4.py-4.border-b")
      .first()
      .getByText("7", { exact: true })
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
    const staysB = page.url().includes(encodeURIComponent(idB));
    const after = await page
      .locator("div.px-4.py-4.border-b")
      .first()
      .getByText("7", { exact: true })
      .count();
    const targetNotice = await page
      .getByRole("alert")
      .filter({ hasText: idA })
      .count();
    const pass =
      current.count === 1 &&
      staysB &&
      before === 1 &&
      after === 1 &&
      (scenario !== "main-unknown" || targetNotice === 1);
    result.checks.push({
      name: `delete ${scenario} after switching to B`,
      pass,
      staysB,
      before,
      after,
      targetNotice,
      count: current.count,
    });
    await page.close();
  }
  {
    current = {
      action: "delete",
      method: "DELETE",
      target: idC,
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page
      .getByRole("link", { name: "Reply C to delete" })
      .waitFor({ timeout });
    await beginDelete(page, "reply");
    current.release.resolve();
    await page
      .getByRole("link", { name: "Reply C to delete" })
      .waitFor({ state: "hidden", timeout });
    const remaining = await page
      .locator("div.px-4.py-4.border-b")
      .first()
      .getByText("2", { exact: true })
      .count();
    result.checks.push({
      name: "confirmed reply deletion updates only its original parent",
      pass: current.count === 1 && remaining === 1,
      count: current.count,
      remaining,
    });
    await page.close();
  }
  {
    current = {
      action: "delete",
      method: "DELETE",
      target: idA,
      status: 503,
      count: 0,
      entered: pending(),
      release: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    await beginDelete(page, "main");
    current.release.resolve();
    const alert = page.getByRole("alert").filter({ hasText: idA });
    await alert.waitFor({ timeout });
    const text = await alert.innerText();
    const button = page
      .locator("div.px-4.py-4.border-b")
      .first()
      .getByRole("button", { name: /^(削除|Delete)$/ });
    const pendingState = await button.getAttribute("aria-disabled");
    result.checks.push({
      name: "unknown same-page deletion preserves the post and identifies the target",
      pass:
        current.count === 1 &&
        page.url().includes(encodeURIComponent(idA)) &&
        pendingState === "false" &&
        /確認できません|could not be confirmed/i.test(text),
      count: current.count,
      pendingState,
      text,
    });
    await page.close();
  }
  {
    current = {
      action: "delete",
      method: "DELETE",
      target: idA,
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
    await beginDelete(page, "main");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    await page.getByRole("link", { name: "Post A current" }).click();
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    const button = page
      .locator("div.px-4.py-4.border-b")
      .first()
      .getByRole("button", { name: /^(削除|Delete)$/ });
    const pendingState = await button.getAttribute("aria-disabled");
    // Exercise the handler itself even when accessibility state marks it busy.
    await button.evaluate((node) => node.click());
    const dialogs = await page.getByRole("alertdialog").count();
    const count = current.count;
    current.release.resolve();
    await page.waitForFunction(
      (n) => globalThis.__completedSyntheticActions >= n,
      count,
      { timeout },
    );
    await page
      .getByText(/見つかりません|not found/i)
      .first()
      .waitFor({ timeout });
    result.checks.push({
      name: "remounted detail cannot dispatch duplicate delete and refreshes after ACK",
      pass: count === 1 && pendingState === "true" && dialogs === 0,
      count,
      pendingState,
      dialogs,
    });
    await page.close();
  }
  {
    current = {
      action: "delete",
      method: "DELETE",
      target: idA,
      status: 200,
      count: 0,
      entered: pending(),
      release: pending(),
    };
    const page = await context.newPage();
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await page.getByRole("link", { name: "Open post B" }).click();
    await page
      .getByText("Post B current", { exact: true })
      .waitFor({ timeout });
    await page.goBack();
    await page.getByRole("link", { name: "Open post B" }).waitFor({ timeout });
    await page
      .locator("div.px-4.py-4.border-b")
      .first()
      .getByRole("button", { name: /^(削除|Delete)$/ })
      .click();
    await page.getByRole("alertdialog").waitFor({ timeout });
    await page.goForward();
    await page
      .getByText("Post B current", { exact: true })
      .waitFor({ timeout });
    const dialogs = await page.getByRole("alertdialog").count();
    result.checks.push({
      name: "navigation dismisses the old delete confirmation",
      pass: dialogs === 0 && current.count === 0,
      dialogs,
      count: current.count,
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
  if (context) {
    try {
      await bounded(context.close(), "browser cleanup");
    } catch (error) {
      result.errors.push(`browser cleanup: ${String(error)}`);
    }
  }
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
  if (web) {
    try {
      await bounded(new Promise((done) => web.close(done)), "web cleanup");
    } catch (error) {
      result.errors.push(`web cleanup: ${String(error)}`);
    }
  }
  if (profile) {
    try {
      await rm(profile, { recursive: true, force: true });
    } catch (error) {
      result.errors.push(`profile cleanup: ${String(error)}`);
    }
  }
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
