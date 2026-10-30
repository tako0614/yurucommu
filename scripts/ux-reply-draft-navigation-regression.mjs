import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { once } from "node:events";

const evidence = process.argv[2];
if (!evidence) throw new Error("Pass a private evidence directory");
const timeout = 15_000;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
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
const json = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
const result = {
  scope:
    "built UI and loopback fixture; synthetic POSTs intercepted, never forwarded",
  checks: [],
  blockedExternal: 0,
  blockedNonGet: [],
  consoleErrors: [],
  postReads: 0,
  expectedFaults: { replies503: 0, post503: 0, invalidAck: 0 },
  errors: [],
};
const check = (name, pass, details = {}) =>
  result.checks.push({ name, pass, ...details });
let web, mock, context, profile, current, origin, replyPath;
const pendingReleases = [];
try {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const dist = resolve(process.env.YURU_SYNTHETIC_DIST ?? "dist");
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
  const portProbe = createServer();
  const mockPort = await listen(portProbe);
  await new Promise((done) => portProbe.close(done));
  const mockOrigin = `http://127.0.0.1:${mockPort}`;
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
  const ready = deferred();
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
  const idA = `${origin}/ap/notes/post-1`;
  const idB = `${origin}/ap/notes/post-2`;
  const shortId = "short-1";
  const shortCanonicalId = `${origin}/ap/objects/${shortId}`;
  replyPath = `/api/posts/${encodeURIComponent(idA)}/replies`;
  const getPost = async (id, content) => {
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
      bookmarked: false,
      visibility: "public",
      community_ap_id: null,
    };
  };
  const postA = await getPost(idA, "Post A current");
  const postB = await getPost(idB, "Post B current");
  const actorResponse = await fetch(`${mockOrigin}/api/auth/me`);
  if (!actorResponse.ok) throw new Error("mock actor unavailable");
  const actor = (await actorResponse.json()).actor;
  postA.author = { ...postA.author, ap_id: actor.ap_id };
  postB.author = postA.author;
  const shortPost = {
    ...postA,
    ap_id: shortCanonicalId,
    content: "Short ID current",
  };
  profile = await mkdtemp("/root/dev/tmp/yuru-reply-draft-profile-");
  context = await chromium.launchPersistentContext(profile, {
    executablePath: "/opt/google/chrome/chrome",
    headless: true,
    env: { PATH: process.env.PATH ?? "", TMPDIR: "/root/dev/tmp" },
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
    const req = route.request();
    const url = new URL(req.url());
    if (
      req.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/posts" &&
      current?.reply
    ) {
      const attempt = current.reply;
      attempt.count++;
      attempt.payload = req.postDataJSON();
      attempt.entered.resolve();
      await attempt.release.promise;
      if (attempt.status !== 200) {
        result.expectedFaults.post503++;
        return json(route, { error: "synthetic failure" }, attempt.status);
      }
      if (attempt.invalidAck) result.expectedFaults.invalidAck++;
      return json(route, {
        post: {
          ...postA,
          ap_id: `${origin}/ap/notes/ack-${attempt.count}`,
          type: "Note",
          content: attempt.payload.content,
          in_reply_to: attempt.payload.in_reply_to,
          author: attempt.invalidAck
            ? { ...postA.author, ap_id: `${origin}/ap/actors/other` }
            : postA.author,
        },
      });
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
    if (url.pathname === "/api/timeline")
      return json(route, {
        posts: [postA, postB],
        next_cursor: null,
        has_more: false,
      });
    const match = url.pathname.match(/^\/api\/posts\/(.+?)(\/replies)?$/);
    if (match) {
      result.postReads++;
      const id = decodeURIComponent(match[1]);
      if (!match[2] && (id === shortId || id === shortCanonicalId)) {
        if (current?.holdShort) {
          const held = current.holdShort;
          current.holdShort = null;
          held.entered.resolve();
          await held.release.promise;
        }
        return json(route, { post: shortPost });
      }
      if (match[2] && (id === shortId || id === shortCanonicalId))
        return json(route, {
          replies: [
            { ...postB, content: "Open post B" },
            { ...postA, content: "Open post A" },
          ],
          next_cursor: null,
          has_more: false,
        });
      if (!match[2] && (id === idA || id === idB))
        return json(route, { post: id === idA ? postA : postB });
      if (match[2] && id === idA && current?.replyErrorOnce) {
        current.replyErrorOnce = false;
        result.expectedFaults.replies503++;
        return json(route, { error: "synthetic replies unavailable" }, 503);
      }
      if (match[2] && (id === idA || id === idB))
        return json(route, {
          replies:
            id === idA
              ? [
                  { ...postB, content: "Open post B" },
                  { ...shortPost, content: "Open short post" },
                ]
              : [],
          next_cursor: null,
          has_more: false,
        });
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
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.on("pageerror", (error) => result.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      result.consoleErrors.push({
        text: message.text(),
        url: message.location().url,
      });
  });
  if (process.env.YURU_SYNTHETIC_UNEXPECTED_CONSOLE === "1")
    await page.evaluate(() =>
      console.error("synthetic unexpected console error"),
    );
  const input = () => page.getByPlaceholder(/返信を投稿|Post a reply/).first();
  const showA = () =>
    page.getByText("Post A current", { exact: true }).waitFor({ timeout });
  const showB = () =>
    page.getByText("Post B current", { exact: true }).waitFor({ timeout });
  const openB = async () => {
    await page.getByRole("link", { name: "Open post B" }).click();
    await showB();
  };
  const original = "Draft for original synthetic post A";
  const other = "Different draft for synthetic post B";
  current = {};
  if (process.env.YURU_SYNTHETIC_TRANSPORT_TEST === "1") {
    result.scope =
      "instrumented local build; only synthetic transport switch and intercepted POST";
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await showA();
    await input().fill(original);
    const beforeSwitch = {
      count: 0,
      entered: deferred(),
      release: deferred(),
      status: 503,
    };
    beforeSwitch.release.resolve();
    current.reply = beforeSwitch;
    await page.evaluate(() => globalThis.__syntheticSwitchReplyTransport());
    await page
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .last()
      .click();
    const forwarded = await Promise.race([
      beforeSwitch.entered.promise.then(() => true),
      page
        .getByText(/接続が変わったため|The connection changed/)
        .waitFor({ timeout })
        .then(() => false),
    ]);
    check(
      "connection change refuses old draft without a POST",
      !forwarded &&
        beforeSwitch.count === 0 &&
        (await input().inputValue()) === original,
    );
    await input().fill("");
    const connectionError = page.getByText(
      /接続が変わったため|The connection changed/,
    );
    const retentionWarning = page.getByText(
      /この下書きは画面を離れると保持されません|This draft will not be kept/,
    );
    await input().fill("Fresh synthetic draft");
    check(
      "clearing the old draft removes its connection and retention warnings",
      !(await connectionError.isVisible()) &&
        !(await retentionWarning.isVisible()),
    );
    const afterClear = {
      count: 0,
      entered: deferred(),
      release: deferred(),
      status: 200,
    };
    afterClear.release.resolve();
    current.reply = afterClear;
    await page
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .last()
      .click();
    await bounded(afterClear.entered.promise, "fresh reply intercepted");
    check(
      "explicit clear permits a fresh draft on the new transport",
      afterClear.count === 1 &&
        afterClear.payload?.content === "Fresh synthetic draft" &&
        afterClear.payload?.in_reply_to === idA,
    );
  } else {
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await showA();
    const readsBeforeTyping = result.postReads;
    await input().fill(original);
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    check(
      "typing does not refetch the post or replies",
      result.postReads === readsBeforeTyping,
    );
    await openB();
    const bInitially = await input().inputValue();
    await input().fill(other);
    await page.goBack();
    await showA();
    check(
      "Back restores A without mixing B",
      (await input().inputValue()) === original && bInitially === "",
    );
    await page.goForward();
    await showB();
    check("Forward restores B", (await input().inputValue()) === other);
    await page.goBack();
    await showA();
    await page.locator('nav a[href="/"]:visible').first().click();
    await page.waitForURL(origin + "/", { timeout });
    await page.goBack();
    await showA();
    check(
      "A survives leaving and remounting the detail route",
      (await input().inputValue()) === original,
    );
    const noStorageLeak = await page.evaluate(
      (text) =>
        !location.href.includes(text) &&
        !JSON.stringify(history.state).includes(text) &&
        !JSON.stringify(localStorage).includes(text) &&
        !JSON.stringify(sessionStorage).includes(text),
      original,
    );
    check(
      "draft text is not put in URL, history or browser storage",
      noStorageLeak,
    );
    current.replyErrorOnce = true;
    await openB();
    await page.goBack();
    await showA();
    await page.getByRole("button", { name: /再試行|Retry/ }).click();
    await showA();
    check("same-post retry keeps A", (await input().inputValue()) === original);
    const attempt = {
      count: 0,
      entered: deferred(),
      release: deferred(),
      status: 200,
    };
    current.reply = attempt;
    await input().fill(original);
    await page
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .last()
      .click();
    await bounded(attempt.entered.promise, "reply intercepted");
    await openB();
    await page.goBack();
    await showA();
    const newer = "New text after returning to A";
    await input().fill(newer);
    const firstResponse = page.waitForResponse(
      (item) =>
        item.request().method() === "POST" &&
        new URL(item.url()).pathname === "/api/posts",
      { timeout },
    );
    attempt.release.resolve();
    await firstResponse;
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    check(
      "old ACK keeps a newer draft after returning",
      (await input().inputValue()) === newer &&
        attempt.count === 1 &&
        attempt.payload?.in_reply_to === idA &&
        attempt.payload?.content === original,
      { intercepted: attempt.count },
    );
    current.reply = {
      count: 0,
      entered: deferred(),
      release: deferred(),
      status: 503,
    };
    await page
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .last()
      .click();
    await bounded(current.reply.entered.promise, "failure intercepted");
    current.reply.release.resolve();
    await page
      .getByText(/投稿結果を確認できません|could not confirm.*post/i)
      .waitFor({ timeout });
    check(
      "failed reply keeps draft and is not retried",
      (await input().inputValue()) === newer && current.reply.count === 1,
      { intercepted: current.reply.count },
    );
    const unchanged = "An unchanged pending reply";
    await input().fill(unchanged);
    const confirmed = {
      count: 0,
      entered: deferred(),
      release: deferred(),
      status: 200,
    };
    current.reply = confirmed;
    await page
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .last()
      .click();
    await bounded(confirmed.entered.promise, "unchanged reply intercepted");
    await openB();
    await page.goBack();
    await showA();
    const whilePending = await input().inputValue();
    const response = page.waitForResponse(
      (item) =>
        item.request().method() === "POST" &&
        new URL(item.url()).pathname === "/api/posts",
      { timeout },
    );
    confirmed.release.resolve();
    await response;
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const afterConfirmed = await input().inputValue();
    check(
      "matching ACK clears the original draft after remount",
      whilePending === unchanged &&
        afterConfirmed === "" &&
        confirmed.count === 1,
      { whilePending, afterConfirmed, intercepted: confirmed.count },
    );
    await input().fill("Synthetic invalid ACK draft");
    const invalid = {
      count: 0,
      entered: deferred(),
      release: deferred(),
      status: 200,
      invalidAck: true,
    };
    current.reply = invalid;
    await page
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .last()
      .click();
    await bounded(
      invalid.entered.promise,
      "invalid acknowledgement intercepted",
    );
    const invalidResponse = page.waitForResponse(
      (item) =>
        item.request().method() === "POST" &&
        new URL(item.url()).pathname === "/api/posts",
      { timeout },
    );
    invalid.release.resolve();
    await invalidResponse;
    await page
      .getByText(/投稿結果を確認できません|could not confirm.*post/i)
      .waitFor({ timeout });
    check(
      "invalid ACK keeps the draft and is not retried",
      (await input().inputValue()) === "Synthetic invalid ACK draft" &&
        invalid.count === 1,
      { intercepted: invalid.count },
    );
    await input().fill("x".repeat(250_001));
    const warning = page.getByText(
      /この下書きは画面を離れると保持されません|This draft will not be kept/,
    );
    await warning.waitFor({ timeout });
    check(
      "oversize draft stays visible with a retention warning",
      (await input().inputValue()).length === 250_001 &&
        (await warning.isVisible()),
    );
    await input().fill("");
    check(
      "emptying oversize draft clears its warning",
      !(await warning.isVisible()),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await input().fill("Desktop synthetic draft");
    await openB();
    await page.goBack();
    await showA();
    check(
      "desktop Back also restores the original draft",
      (await input().inputValue()) === "Desktop synthetic draft",
    );
    const held = { entered: deferred(), release: deferred() };
    pendingReleases.push(held.release);
    current.holdShort = held;
    await page.getByRole("link", { name: "Open short post" }).click();
    await bounded(held.entered.promise, "short-post read intercepted");
    await page.goBack();
    await showA();
    const heldResponse = page.waitForResponse(
      (item) =>
        item.request().method() === "GET" &&
        decodeURIComponent(new URL(item.url()).pathname) ===
          `/api/posts/${shortCanonicalId}`,
      { timeout },
    );
    held.release.resolve();
    await heldResponse;
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    check(
      "an older post GET cannot replace the current draft",
      (await input().inputValue()) === "Desktop synthetic draft" &&
        (await page.getByText("Post A current", { exact: true }).isVisible()),
    );
    await page.reload();
    await showA();
    check(
      "full reload starts a new in-memory draft scope",
      (await input().inputValue()) === "",
    );
    await page.goto(`${origin}/post/${shortId}`);
    await page
      .getByText("Short ID current", { exact: true })
      .waitFor({ timeout });
    await input().fill("Synthetic short-ID reply");
    await openB();
    await page.goBack();
    await page
      .getByText("Short ID current", { exact: true })
      .waitFor({ timeout });
    const restoredShort = await input().inputValue();
    await page.getByRole("link", { name: "Open post A" }).click();
    await showA();
    await page.getByRole("link", { name: "Open short post" }).click();
    await page
      .getByText("Short ID current", { exact: true })
      .waitFor({ timeout });
    check(
      "canonical link restores the short-ID draft",
      (await input().inputValue()) === "Synthetic short-ID reply",
    );
    await page.goBack();
    await showA();
    await page.goBack();
    await page
      .getByText("Short ID current", { exact: true })
      .waitFor({ timeout });
    check(
      "Back to short ID keeps the same canonical draft",
      (await input().inputValue()) === "Synthetic short-ID reply",
    );
    const shortButton = page
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .last();
    const shortEnabled = await shortButton.isEnabled();
    const shortAttempt = {
      count: 0,
      entered: deferred(),
      release: deferred(),
      status: 200,
    };
    current.reply = shortAttempt;
    if (shortEnabled) {
      await shortButton.click();
      await bounded(shortAttempt.entered.promise, "short-ID reply intercepted");
    }
    check(
      "short-ID route can reply to the canonical post",
      shortEnabled &&
        restoredShort === "Synthetic short-ID reply" &&
        shortAttempt.count === 1 &&
        shortAttempt.payload?.in_reply_to === shortCanonicalId &&
        shortAttempt.payload?.content === "Synthetic short-ID reply",
      {
        enabled: shortEnabled,
        restored: restoredShort,
        intercepted: shortAttempt.count,
      },
    );
    if (shortEnabled) {
      await page.getByRole("link", { name: "Open post A" }).click();
      await showA();
      await page.getByRole("link", { name: "Open short post" }).click();
      await page
        .getByText("Short ID current", { exact: true })
        .waitFor({ timeout });
      await input().fill("New draft after changing alias");
      const aliasResponse = page.waitForResponse(
        (item) =>
          item.request().method() === "POST" &&
          new URL(item.url()).pathname === "/api/posts",
        { timeout },
      );
      shortAttempt.release.resolve();
      await aliasResponse;
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      check(
        "an alias change and later ACK keep the newer canonical draft",
        (await input().inputValue()) === "New draft after changing alias" &&
          shortAttempt.count === 1,
      );
    } else {
      check(
        "an alias change and later ACK keep the newer canonical draft",
        false,
      );
    }
    current.replyErrorOnce = true;
    await page.goto(`${origin}/post/${encodeURIComponent(idA)}`);
    await showA();
    await input().fill("x".repeat(250_001));
    await page.getByRole("button", { name: /再試行|Retry/ }).click();
    await showA();
    const localOnlyWarning = page.getByText(
      /この下書きは画面を離れると保持されません|This draft will not be kept/,
    );
    check(
      "same-target retry preserves local-only text and its warning",
      (await input().inputValue()).length === 250_001 &&
        (await localOnlyWarning.isVisible()),
    );
    await input().fill("");
    await input().fill("Synthetic text before sign-out");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout });
    current.simulateLogout = true;
    current.logoutCount = 0;
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
    await page.goBack();
    await showA();
    check(
      "a sign-out epoch cannot restore a previous draft",
      (await input().inputValue()) === "" && current.logoutCount === 1,
      { intercepted: current.logoutCount },
    );
  }
  await page.close();
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  for (const release of pendingReleases) release.resolve();
  current?.reply?.release.resolve();
  if (context)
    try {
      await bounded(context.close(), "browser cleanup");
    } catch (error) {
      result.errors.push(`browser cleanup: ${String(error)}`);
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
  if (web)
    try {
      await bounded(new Promise((done) => web.close(done)), "web cleanup");
    } catch (error) {
      result.errors.push(`web cleanup: ${String(error)}`);
    }
  if (profile)
    try {
      await rm(profile, { recursive: true, force: true });
    } catch (error) {
      result.errors.push(`profile cleanup: ${String(error)}`);
    }
  const observed = {
    repliesResource: 0,
    repliesApplication: 0,
    postResource: 0,
    postApplication: 0,
    invalidAck: 0,
  };
  for (const entry of result.consoleErrors) {
    const url = URL.canParse(entry.url) ? new URL(entry.url) : null;
    if (
      entry.text.startsWith(
        "Failed to load resource: the server responded with a status of 503",
      ) &&
      url?.origin === origin &&
      url.pathname === replyPath
    )
      observed.repliesResource++;
    else if (
      entry.text.startsWith(
        "Failed to load resource: the server responded with a status of 503",
      ) &&
      url?.origin === origin &&
      url.pathname === "/api/posts"
    )
      observed.postResource++;
    else if (
      entry.text.startsWith(
        "Failed to load replies: ApiError: synthetic replies unavailable",
      )
    )
      observed.repliesApplication++;
    else if (
      entry.text.startsWith("Failed to reply: ApiError: synthetic failure")
    )
      observed.postApplication++;
    else if (
      entry.text.startsWith(
        "Failed to reply: Error: Post response did not acknowledge the submitted reply",
      )
    )
      observed.invalidAck++;
    else result.errors.push(`unexpected console error: ${entry.text}`);
  }
  const expected = result.expectedFaults;
  if (
    observed.repliesResource !== expected.replies503 ||
    observed.repliesApplication !== expected.replies503 ||
    observed.postResource !== expected.post503 ||
    observed.postApplication !== expected.post503 ||
    observed.invalidAck !== expected.invalidAck
  )
    result.errors.push(
      "synthetic fault console counts did not match intercepted responses",
    );
  result.observedFaults = observed;
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
