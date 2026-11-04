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
    "usage: node scripts/ux-reply-action-lifetime-regression.mjs <evidence-dir>",
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
  runtime:
    "current built Yurucommu UI; isolated loopback GET and intercepted synthetic reply/logout responses, no network POST",
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
let currentActor;
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
  postA = {
    ...(await mockPost(idA, "Post A current")),
    ap_id: idA,
    reply_count: 3,
  };
  postB = {
    ...(await mockPost(idB, "Post B current")),
    ap_id: idB,
    reply_count: 6,
  };
  const authResponse = await fetch(`${mockOrigin}/api/auth/me`);
  if (!authResponse.ok) throw new Error("mock auth fixture unavailable");
  currentActor = (await authResponse.json()).actor;

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
    if (
      request.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/posts" &&
      scenario?.reply
    ) {
      const body = request.postDataJSON();
      const parallel = scenario.parallelReplies?.[body?.in_reply_to];
      if (scenario.parallelReplies && !parallel) {
        result.blockedNonGet.push({
          method: request.method(),
          path: url.pathname,
        });
        return route.abort();
      }
      const matches = parallel
        ? body?.content === parallel.content
        : body?.in_reply_to === idA &&
          body?.content === "Synthetic reply for A";
      if (!matches) {
        result.blockedNonGet.push({
          method: request.method(),
          path: url.pathname,
        });
        return route.abort();
      }
      const activeReply = parallel?.request ?? scenario.reply;
      const mode = parallel?.mode ?? scenario.replyMode;
      scenario.syntheticReplyCount++;
      if (parallel) {
        parallel.count++;
        parallel.matches = matches;
      } else {
        scenario.syntheticReplyMatches = matches;
      }
      activeReply.entered.resolve();
      await activeReply.release.promise;
      if (mode === "unconfirmed")
        return json(route, { error: "synthetic-unconfirmed" }, 503);
      if (mode === "rejected") return json(route, { error: "too long" }, 400);
      const parent = body?.in_reply_to === idB ? postB : postA;
      const responsePost = {
        ...parent,
        ap_id: `${origin}/ap/notes/synthetic-reply-${body?.in_reply_to === idB ? "B" : "A"}`,
        author: mode === "malformed" ? postA.author : currentActor,
        content: body.content,
      };
      // The actual Core create response omits the parent field, including for replies.
      delete responsePost.in_reply_to;
      return json(route, { post: responsePost });
    }
    if (
      request.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/auth/logout" &&
      scenario?.simulateLogout
    ) {
      scenario.syntheticLogoutCount++;
      return json(route, { success: true });
    }
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
    if (url.pathname === "/api/timeline" && scenario?.feed) {
      return json(route, {
        posts: [
          { ...postA, reply_count: scenario.feedCountA ?? postA.reply_count },
          postB,
        ],
        next_cursor: null,
        has_more: false,
      });
    }
    if (url.pathname === "/api/notifications/pushers/config") {
      return json(route, {});
    }
    const match = url.pathname.match(/^\/api\/posts\/(.+?)(\/replies)?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (!match[2] && (id === idA || id === idB)) {
        return json(route, { post: id === idA ? postA : postB });
      }
      if (match[2] && id === idA) {
        return json(route, {
          replies: [{ ...postB, content: "Open post B" }],
          next_cursor: null,
          has_more: false,
        });
      }
      if (match[2] && id === idB) {
        return json(route, {
          replies: [
            {
              ...postB,
              ap_id: `${origin}/ap/notes/first-B`,
              content: "First reply from B",
            },
          ],
          next_cursor: null,
          has_more: false,
        });
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
    globalThis.__syntheticPostBodies = 0;
    const originalJson = Response.prototype.json;
    Response.prototype.json = async function (...args) {
      const body = await originalJson.apply(this, args);
      if (this.url.endsWith("/api/posts")) globalThis.__syntheticPostBodies++;
      return body;
    };
    const originalText = Response.prototype.text;
    Response.prototype.text = async function (...args) {
      const body = await originalText.apply(this, args);
      if (this.url.endsWith("/api/posts")) globalThis.__syntheticPostBodies++;
      return body;
    };
  });

  const postPath = (id) => `/post/${encodeURIComponent(id)}`;
  async function startPage(current) {
    scenario = { ...current };
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
    if (current.startAtFeed) {
      await page.goto(origin + "/");
      await page.getByRole("link", { name: "Post A current" }).click();
    } else {
      await page.goto(origin + postPath(idA));
    }
    await page
      .getByText("Post A current", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    await page
      .getByText("Open post B", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    return page;
  }
  async function navigateB(page) {
    await page.getByRole("link", { name: "Open post B" }).click();
    await page
      .getByText("Post B current", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    await page
      .getByText("First reply from B", { exact: true })
      .waitFor({ timeout: TIMEOUT });
  }

  {
    const reply = hold("synthetic-A-reply");
    const page = await startPage({
      reply,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(reply.entered.promise, "intercepted synthetic reply");
    await navigateB(page);
    const nextComposer = page.locator("textarea").first();
    await nextComposer.fill("draft B must survive");
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      displayedReplyFromA: await page
        .getByText("Synthetic reply for A", { exact: true })
        .count(),
      currentDraft: await nextComposer.inputValue(),
      currentPostVisible: await page
        .getByText("Post B current", { exact: true })
        .count(),
      syntheticReplyCount: scenario.syntheticReplyCount,
      syntheticReplyMatches: scenario.syntheticReplyMatches,
    };
    check(
      "only one synthetic request for the original A was intercepted",
      observed.syntheticReplyCount === 1 && observed.syntheticReplyMatches,
      observed,
    );
    check(
      "late A reply is not rendered under B",
      observed.displayedReplyFromA === 0,
      observed,
    );
    check(
      "late A reply does not erase B draft",
      observed.currentDraft === "draft B must survive",
      observed,
    );
    await page.screenshot({ path: join(evidence, "B-AFTER-OLD-ACK.png") });
    await page.close();
  }
  {
    const reply = hold("synthetic-same-post-reply");
    const page = await startPage({
      reply,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(
      reply.entered.promise,
      "same-post intercepted synthetic reply",
    );
    await composer.fill("newer A draft");
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      currentDraft: await composer.inputValue(),
      replyVisible: await page
        .getByText("Synthetic reply for A", { exact: true })
        .count(),
      syntheticReplyCount: scenario.syntheticReplyCount,
    };
    check(
      "same-post ACK retains newer draft",
      observed.currentDraft === "newer A draft",
      observed,
    );
    check(
      "same-post ACK displays the acknowledged reply once",
      observed.replyVisible === 1 && observed.syntheticReplyCount === 1,
      observed,
    );
    await page.close();
  }
  {
    const reply = hold("synthetic-aba-reply");
    const page = await startPage({
      reply,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(reply.entered.promise, "ABA intercepted synthetic reply");
    await composer.fill("intermediate draft");
    await composer.fill("Synthetic reply for A");
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      draft: await composer.inputValue(),
      count: scenario.syntheticReplyCount,
    };
    check(
      "same-value ABA input remains a newer draft",
      observed.draft === "Synthetic reply for A" && observed.count === 1,
      observed,
    );
    await page.close();
  }
  {
    const reply = hold("synthetic-unchanged-reply");
    const page = await startPage({
      reply,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    const submit = composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ });
    await composer.fill("Synthetic reply for A");
    await submit.click();
    await bounded(
      reply.entered.promise,
      "unchanged intercepted synthetic reply",
    );
    check(
      "reply submit cannot be repeated while pending",
      (await submit.isDisabled()) && scenario.syntheticReplyCount === 1,
      { count: scenario.syntheticReplyCount },
    );
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      draft: await composer.inputValue(),
      visible: await page
        .getByText("Synthetic reply for A", { exact: true })
        .count(),
      count: scenario.syntheticReplyCount,
    };
    check(
      "unchanged submitted draft clears only after its ACK",
      observed.draft === "" && observed.visible === 1 && observed.count === 1,
      observed,
    );
    await page.close();
  }
  {
    const first = hold("synthetic-parallel-A");
    const second = hold("synthetic-parallel-B");
    const parallelReplies = {
      [idA]: {
        request: first,
        content: "Synthetic reply for A",
        count: 0,
        matches: false,
      },
      [idB]: {
        request: second,
        content: "Synthetic reply for B",
        count: 0,
        matches: false,
      },
    };
    const page = await startPage({
      reply: first,
      parallelReplies,
      syntheticReplyCount: 0,
    });
    const firstComposer = page.locator("textarea").first();
    await firstComposer.fill("Synthetic reply for A");
    await firstComposer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(first.entered.promise, "parallel A entered");
    await navigateB(page);
    const secondComposer = page.locator("textarea").first();
    await secondComposer.fill("Synthetic reply for B");
    const secondSubmit = secondComposer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ });
    const bEnabled = await secondSubmit.isEnabled();
    check(
      "a pending reply to A does not block an independent reply to B",
      bEnabled,
      { bEnabled },
    );
    if (bEnabled) {
      await secondSubmit.click();
      await bounded(second.entered.promise, "parallel B entered");
      first.release.resolve();
      await page.waitForFunction(
        () => globalThis.__syntheticPostBodies === 1,
        null,
        { timeout: TIMEOUT },
      );
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      const afterA = {
        disabled: await secondSubmit.isDisabled(),
        draft: await secondComposer.inputValue(),
        bReply: await page
          .getByText("Synthetic reply for B", { exact: true })
          .count(),
      };
      check(
        "A finishing cannot release B's pending guard or clear its draft",
        afterA.disabled &&
          afterA.draft === "Synthetic reply for B" &&
          afterA.bReply === 0,
        afterA,
      );
      second.release.resolve();
      await page.waitForFunction(
        () => globalThis.__syntheticPostBodies === 2,
        null,
        { timeout: TIMEOUT },
      );
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      const afterB = {
        draft: await secondComposer.inputValue(),
        bReply: await page
          .getByText("Synthetic reply for B", { exact: true })
          .count(),
        aCount: parallelReplies[idA].count,
        bCount: parallelReplies[idB].count,
        aMatches: parallelReplies[idA].matches,
        bMatches: parallelReplies[idB].matches,
      };
      check(
        "B's own ACK settles its own request exactly once",
        afterB.draft === "" &&
          afterB.bReply === 1 &&
          afterB.aCount === 1 &&
          afterB.bCount === 1 &&
          afterB.aMatches &&
          afterB.bMatches,
        afterB,
      );
    }
    first.release.resolve();
    second.release.resolve();
    await page.close();
  }
  {
    const first = hold("synthetic-rejected-before-retry");
    const page = await startPage({
      reply: first,
      replyMode: "rejected",
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    const submit = composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ });
    await composer.fill("Synthetic reply for A");
    await submit.click();
    await bounded(first.entered.promise, "initial rejected reply");
    first.release.resolve();
    const notice = page.getByText(/本文が長すぎます|Post is too long/);
    await notice.waitFor({ timeout: TIMEOUT });
    const second = hold("synthetic-explicit-retry");
    scenario.reply = second;
    scenario.replyMode = undefined;
    await submit.click();
    await bounded(second.entered.promise, "explicit user retry");
    const staleNoticeWhilePending = await notice.count();
    second.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 2,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      staleNoticeWhilePending,
      draft: await composer.inputValue(),
      visible: await page
        .getByText("Synthetic reply for A", { exact: true })
        .count(),
      count: scenario.syntheticReplyCount,
    };
    check(
      "an explicit retry clears the previous rejection and reports the new result",
      observed.staleNoticeWhilePending === 0 &&
        observed.draft === "" &&
        observed.visible === 1 &&
        observed.count === 2,
      observed,
    );
    await page.close();
  }
  for (const mode of ["unconfirmed", "rejected", "malformed"]) {
    const reply = hold(`synthetic-${mode}-reply`);
    const page = await startPage({
      reply,
      replyMode: mode,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(reply.entered.promise, `${mode} intercepted synthetic reply`);
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const notice =
      mode === "rejected"
        ? /本文が長すぎます|Post is too long/
        : /投稿結果を確認できません|The post result could not be confirmed/;
    const observed = {
      draft: await composer.inputValue(),
      visibleReply: await page
        .getByText("Synthetic reply for A", { exact: true })
        .count(),
      notice: await page.getByText(notice).count(),
      count: scenario.syntheticReplyCount,
    };
    check(
      `${mode} reply preserves input and reports its actual outcome`,
      observed.draft === "Synthetic reply for A" &&
        observed.visibleReply === 0 &&
        observed.notice === 1 &&
        observed.count === 1,
      observed,
    );
    await page.close();
  }
  {
    const reply = hold("synthetic-old-unknown");
    const page = await startPage({
      reply,
      replyMode: "unconfirmed",
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(
      reply.entered.promise,
      "old unknown intercepted synthetic reply",
    );
    await navigateB(page);
    const nextComposer = page.locator("textarea").first();
    await nextComposer.fill("draft B must survive");
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      draft: await nextComposer.inputValue(),
      notice: await page
        .getByText(
          /投稿結果を確認できません|The post result could not be confirmed/,
        )
        .count(),
      count: scenario.syntheticReplyCount,
    };
    check(
      "old unknown reply preserves B draft and reports unconfirmed",
      observed.draft === "draft B must survive" &&
        observed.notice === 1 &&
        observed.count === 1,
      observed,
    );
    await page.close();
  }

  {
    const reply = hold("synthetic-returned-A-reply");
    const page = await startPage({
      reply,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(
      reply.entered.promise,
      "returned A intercepted synthetic reply",
    );
    await navigateB(page);
    await page.goBack();
    await page
      .getByText("Post A current", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    const returnedComposer = page.locator("textarea").first();
    await returnedComposer.fill("returned A draft must survive");
    check(
      "returning to A keeps its own pending submit disabled",
      await returnedComposer
        .locator("..")
        .getByRole("button", { name: /^(返信|Reply)$/ })
        .isDisabled(),
      {},
    );
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      draft: await returnedComposer.inputValue(),
      oldReply: await page
        .getByText("Synthetic reply for A", { exact: true })
        .count(),
      success: await page.getByText(/^(投稿しました|Posted)$/).count(),
      count: scenario.syntheticReplyCount,
    };
    check(
      "A→B→Back does not adopt an old generation ACK into the returned page",
      observed.draft === "returned A draft must survive" &&
        observed.oldReply === 0 &&
        observed.success === 1 &&
        observed.count === 1,
      observed,
    );
    await page.close();
  }
  {
    const reply = hold("synthetic-unmounted-reply");
    const page = await startPage({
      reply,
      feed: true,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(
      reply.entered.promise,
      "unmounted intercepted synthetic reply",
    );
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout: TIMEOUT });
    const cardA = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    const cardB = page
      .getByText("Post B current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    await cardA
      .getByRole("button", { name: /^(返信|Reply) 3$/ })
      .waitFor({ timeout: TIMEOUT });
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      success: await page.getByText(/^(投稿しました|Posted)$/).count(),
      aCount: await cardA
        .getByRole("button", { name: /^(返信|Reply) 4$/ })
        .count(),
      bCount: await cardB
        .getByRole("button", { name: /^(返信|Reply) 6$/ })
        .count(),
      currentPath: new URL(page.url()).pathname,
      count: scenario.syntheticReplyCount,
    };
    check(
      "a successful ACK after leaving the detail page remains visible",
      observed.currentPath === "/" &&
        observed.success === 1 &&
        observed.count === 1,
      observed,
    );
    check(
      "a successful ACK updates only the original timeline post",
      observed.aCount === 1 && observed.bCount === 1,
      observed,
    );
    await page.close();
  }
  {
    const reply = hold("synthetic-reentered-A-reply");
    const page = await startPage({
      reply,
      feed: true,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const firstComposer = page.locator("textarea").first();
    await firstComposer.fill("Synthetic reply for A");
    await firstComposer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(
      reply.entered.promise,
      "reentered A intercepted synthetic reply",
    );
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout: TIMEOUT });
    await page.getByRole("link", { name: "Post A current" }).click();
    await page
      .getByText("Open post B", { exact: true })
      .waitFor({ timeout: TIMEOUT });
    const reopenedComposer = page.locator("textarea").first();
    await reopenedComposer.fill("new A draft after reopening");
    const reopenedSubmit = reopenedComposer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ });
    const disabledBeforeAck = await reopenedSubmit.isDisabled();
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      disabledBeforeAck,
      enabledAfterAck: await reopenedSubmit.isEnabled(),
      draft: await reopenedComposer.inputValue(),
      count: scenario.syntheticReplyCount,
    };
    check(
      "reopening A cannot resend while its previous A request is pending",
      observed.disabledBeforeAck &&
        observed.enabledAfterAck &&
        observed.draft === "new A draft after reopening" &&
        observed.count === 1,
      observed,
    );
    await page.close();
  }
  {
    const reply = hold("synthetic-older-timeline-reply");
    const page = await startPage({
      reply,
      feed: true,
      feedCountA: 2,
      startAtFeed: true,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(reply.entered.promise, "older timeline intercepted reply");
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout: TIMEOUT });
    const cardA = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    await cardA
      .getByRole("button", { name: /^(返信|Reply) 2$/ })
      .waitFor({ timeout: TIMEOUT });
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      updatedCount: await cardA
        .getByRole("button", { name: /^(返信|Reply) 4$/ })
        .count(),
      success: await page.getByText(/^(投稿しました|Posted)$/).count(),
      count: scenario.syntheticReplyCount,
    };
    check(
      "an unchanged timeline snapshot older than the detail read advances from the detail count",
      observed.updatedCount === 1 &&
        observed.success === 1 &&
        observed.count === 1,
      observed,
    );
    await page.close();
  }
  {
    const reply = hold("synthetic-newer-lower-timeline-reply");
    const page = await startPage({
      reply,
      feed: true,
      feedCountA: 2,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(
      reply.entered.promise,
      "newer lower timeline intercepted reply",
    );
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout: TIMEOUT });
    const cardA = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    await cardA
      .getByRole("button", { name: /^(返信|Reply) 2$/ })
      .waitFor({ timeout: TIMEOUT });
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      unchangedCount: await cardA
        .getByRole("button", { name: /^(返信|Reply) 2$/ })
        .count(),
      success: await page.getByText(/^(投稿しました|Posted)$/).count(),
      count: scenario.syntheticReplyCount,
    };
    check(
      "a later lower timeline count is preserved when its relation to the ACK is unknown",
      observed.unchangedCount === 1 &&
        observed.success === 1 &&
        observed.count === 1,
      observed,
    );
    await page.close();
  }
  {
    const reply = hold("synthetic-refreshed-timeline-reply");
    const page = await startPage({
      reply,
      feed: true,
      feedCountA: 4,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(
      reply.entered.promise,
      "refreshed timeline intercepted reply",
    );
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout: TIMEOUT });
    const cardA = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    await cardA
      .getByRole("button", { name: /^(返信|Reply) 4$/ })
      .waitFor({ timeout: TIMEOUT });
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      unchangedCount: await cardA
        .getByRole("button", { name: /^(返信|Reply) 4$/ })
        .count(),
      success: await page.getByText(/^(投稿しました|Posted)$/).count(),
      count: scenario.syntheticReplyCount,
    };
    check(
      "a newer timeline count is not incremented a second time by the ACK",
      observed.unchangedCount === 1 &&
        observed.success === 1 &&
        observed.count === 1,
      observed,
    );
    await page.close();
  }
  {
    const reply = hold("synthetic-old-session-reply");
    const page = await startPage({
      reply,
      feed: true,
      simulateLogout: true,
      syntheticLogoutCount: 0,
      syntheticReplyCount: 0,
      syntheticReplyMatches: false,
    });
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic reply for A");
    await composer
      .locator("..")
      .getByRole("button", { name: /^(返信|Reply)$/ })
      .click();
    await bounded(
      reply.entered.promise,
      "old-session intercepted synthetic reply",
    );
    await page.locator('aside a[href="/"]').click();
    await page.waitForURL(origin + "/", { timeout: TIMEOUT });
    const cardA = page
      .getByText("Post A current", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
    await cardA
      .getByRole("button", { name: /^(返信|Reply) 3$/ })
      .waitFor({ timeout: TIMEOUT });
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
      .waitFor({ timeout: TIMEOUT });
    reply.release.resolve();
    await page.waitForFunction(
      () => globalThis.__syntheticPostBodies === 1,
      null,
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const observed = {
      unchangedCount: await cardA
        .getByRole("button", { name: /^(返信|Reply) 3$/ })
        .count(),
      staleSuccess: await page.getByText(/^(投稿しました|Posted)$/).count(),
      syntheticLogoutCount: scenario.syntheticLogoutCount,
      syntheticReplyCount: scenario.syntheticReplyCount,
    };
    check(
      "a reply ACK from before a same-actor logout attempt cannot update the new auth epoch",
      observed.unchangedCount === 1 &&
        observed.staleSuccess === 0 &&
        observed.syntheticLogoutCount === 1 &&
        observed.syntheticReplyCount === 1,
      observed,
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
      (error.message.includes("503") || error.message.includes("400")) &&
      error.location.url === `${origin}/api/posts`;
    const expectedApplication =
      /^Failed to reply: (?:ApiError: (?:synthetic-unconfirmed|too long)|Error: Post response did not acknowledge)/.test(
        error.message,
      );
    if (!expectedResource && !expectedApplication) {
      result.unexpectedErrors.push({
        name: "UnexpectedBrowserConsoleError",
        message: error.message,
      });
    }
  }
  check(
    "no unhandled non-GET request was attempted",
    result.blockedNonGet.length === 0,
    {
      blockedNonGet: result.blockedNonGet.length,
    },
  );
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
