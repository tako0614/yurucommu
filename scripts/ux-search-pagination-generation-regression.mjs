import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { accessSync, constants } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
const out = process.argv[2];
if (!out) throw new Error("Pass a private evidence directory");
const tempRoot = process.env.TMPDIR || tmpdir();
const browserCandidates = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
].filter(Boolean);
const browserExecutable = browserCandidates.find((path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
if (!browserExecutable)
  throw new Error("Installed Chrome required; set CHROME_BIN");
const timeout = 15000;
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const bounded = async (p, label, limit = timeout) => {
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout: " + label)), limit);
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
let web,
  mock,
  context,
  profile,
  alpha,
  beta,
  origin,
  mode = "actors",
  sortCase = false;
const results = {
  scope:
    "current built UI, synthetic loopback API; external and non-GET blocked",
  checks: [],
  errors: [],
  blockedExternal: 0,
  blockedNonGet: [],
  requests: [],
  expectedFaults: { stalePosts: 0, currentUsers: 0 },
  consoleErrors: [],
};
const check = (name, pass, details = {}) =>
  results.checks.push({ name, pass, ...details });
try {
  await mkdir(out, { recursive: true, mode: 0o700 });
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
      if (!file.startsWith(dist + sep)) throw Error("outside dist");
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
  origin = "http://127.0.0.1:" + (await listen(web));
  const probe = createServer(),
    port = await listen(probe);
  await new Promise((done) => probe.close(done));
  const mockOrigin = "http://127.0.0.1:" + port;
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
  let logs = "";
  const ready = defer();
  mock.stdout.on("data", (part) => {
    logs += part;
    if (logs.includes("mock API listening")) ready.resolve();
  });
  mock.stderr.on("data", (part) => {
    logs += part;
  });
  mock.on("exit", () => ready.resolve());
  await bounded(ready.promise, "mock startup");
  if (mock.exitCode !== null) throw Error("mock exited");
  const actor = (await (await fetch(mockOrigin + "/api/auth/me")).json()).actor;
  const named = (name) => ({
    ...actor,
    ap_id: origin + "/ap/users/" + name,
    username: name,
    preferred_username: name,
    name: name,
    icon_url: null,
  });
  const postResponse = await fetch(
    `${mockOrigin}/api/posts/${encodeURIComponent(`${origin}/ap/notes/post-1`)}`,
  );
  if (!postResponse.ok) throw new Error("mock post unavailable");
  const post = (await postResponse.json()).post;
  const item = (name) =>
    mode === "actors"
      ? named(name)
      : { ...post, ap_id: `${origin}/ap/notes/${name}`, content: name };
  const pageBody = (items, hasMore) =>
    mode === "actors"
      ? { actors: items, has_more: hasMore }
      : { posts: items, has_more: hasMore };
  const pending = () => ({
    entered: defer(),
    second: defer(),
    release: defer(),
    count: 0,
  });
  alpha = pending();
  beta = pending();
  profile = await mkdtemp(join(tempRoot, "yuru-search-pagination-profile-"));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: browserExecutable,
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
      results.blockedNonGet.push({ method: req.method(), path: url.pathname });
      return route.abort();
    }
    if (url.origin !== origin) {
      results.blockedExternal++;
      if (req.resourceType() === "image")
        return route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        });
      return route.abort();
    }
    if (["/api/search/actors", "/api/search/posts"].includes(url.pathname)) {
      const kind = url.pathname.endsWith("actors") ? "actors" : "posts";
      const q = url.searchParams.get("q");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      results.requests.push({
        kind,
        q,
        offset,
        sort: url.searchParams.get("sort"),
      });
      if (kind !== mode)
        return json(
          route,
          kind === "actors"
            ? { actors: [], has_more: false }
            : { posts: [], has_more: false },
        );
      if (q === "retry" && offset === 0)
        return json(route, pageBody([item("retry-first")], true));
      if (q === "retry" && offset === 1) {
        beta.count++;
        if (beta.count === 1) {
          results.expectedFaults.currentUsers++;
          return json(route, { error: "synthetic page failure" }, 503);
        }
        return json(route, pageBody([item("retry-next")], false));
      }
      if ((q === "alpha" || q === "beta") && offset === 0)
        return json(route, pageBody([item(q + "-first")], true));
      if (q === "alpha" && offset === 1) {
        const newSort = mode === "actors" ? "followers" : "popular";
        if (sortCase && url.searchParams.get("sort") === newSort) {
          beta.count++;
          beta.entered.resolve();
          await beta.release.promise;
          return json(route, pageBody([item("alpha-sorted-next")], false));
        }
        alpha.count++;
        alpha.entered.resolve();
        await alpha.release.promise;
        if (mode === "posts") {
          results.expectedFaults.stalePosts++;
          return json(route, { error: "synthetic stale page failure" }, 503);
        }
        return json(route, pageBody([item("alpha-next")], false));
      }
      if (q === "beta" && offset === 1) {
        beta.count++;
        beta.entered.resolve();
        if (beta.count === 2) beta.second.resolve();
        await beta.release.promise;
        return json(route, pageBody([item("beta-next")], true));
      }
      if (q === "beta" && offset >= 2)
        return json(route, pageBody([item("beta-offset-" + offset)], false));
    }
    if (url.pathname === "/api/notifications/pushers/config")
      return json(route, {});
    if (
      url.pathname === "/assets/__ux-unexpected-console.js" &&
      process.env.YURU_SYNTHETIC_UNEXPECTED_CONSOLE === "1"
    )
      return route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: 'console.error("Load more users failed: ApiError: synthetic page failure with an unexpected suffix");',
      });
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const resp = await fetch(mockOrigin + url.pathname + url.search);
    return route.fulfill({
      status: resp.status,
      contentType: resp.headers.get("content-type") ?? "application/json",
      body: Buffer.from(await resp.arrayBuffer()),
    });
  });
  if (context.routeWebSocket)
    await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.addInitScript(() => {
    const originalText = Response.prototype.text;
    globalThis.__uxPaginationBodies = {};
    Response.prototype.text = async function (...args) {
      const body = await originalText.apply(this, args);
      try {
        const url = new URL(this.url);
        const query = url.searchParams.get("q");
        if (
          ["/api/search/actors", "/api/search/posts"].includes(url.pathname) &&
          ["alpha", "beta"].includes(query) &&
          url.searchParams.get("offset") === "1"
        ) {
          const key = `${url.pathname}:${query}`;
          globalThis.__uxPaginationBodies[key] =
            (globalThis.__uxPaginationBodies[key] ?? 0) + 1;
        }
      } catch {
        // Ignore non-URL synthetic responses outside this probe.
      }
      return body;
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.on("pageerror", (err) => results.errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error")
      results.consoleErrors.push({ text: msg.text(), url: msg.location().url });
  });
  const more = () =>
    page.getByRole("button", {
      name: /もっと見る|読み込み中|Load more|Loading/,
    });
  const input = () => page.getByRole("textbox", { name: /検索|Search/ });
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  const bodyRead = (kind, query, count) =>
    page.waitForFunction(
      ({ key, count }) =>
        (globalThis.__uxPaginationBodies?.[key] ?? 0) >= count,
      { key: `/api/search/${kind}:${query}`, count },
      { timeout },
    );
  const runScenario = async (kind) => {
    mode = kind;
    alpha = pending();
    beta = pending();
    const tab = kind === "actors" ? "users" : "posts";
    await page.goto(`${origin}/search?search=alpha&tab=${tab}`);
    await page.getByText("alpha-first", { exact: true }).first().waitFor();
    await more().click();
    await bounded(alpha.entered.promise, `${kind} old page intercepted`);
    await input().fill("beta");
    await input().press("Enter");
    await page.getByText("beta-first", { exact: true }).first().waitFor();
    const newQueryDisabled = await more().isDisabled();
    check(
      `${kind}: new query can paginate while old query is pending`,
      !newQueryDisabled,
      {
        buttonDisabled: newQueryDisabled,
        buttonText: await more().innerText(),
        betaPaginationRequests: beta.count,
      },
    );
    await page
      .getByRole("button", { name: /検索をクリア|Clear search/ })
      .click();
    await input().fill("beta");
    await input().press("Enter");
    await page.getByText("beta-first", { exact: true }).first().waitFor();
    await more().click();
    await bounded(beta.entered.promise, `${kind} new page intercepted`);
    const alphaDone = page.waitForResponse(
      (r) => {
        const u = new URL(r.url());
        return (
          u.pathname === `/api/search/${kind}` &&
          u.searchParams.get("q") === "alpha" &&
          u.searchParams.get("offset") === "1"
        );
      },
      { timeout },
    );
    alpha.release.resolve();
    await alphaDone;
    await bodyRead(kind, "alpha", 1);
    await settle();
    const newPageDisabled = await more().isDisabled();
    check(
      `${kind}: old completion does not unlock the new pending page`,
      newPageDisabled,
      {
        buttonDisabled: newPageDisabled,
        buttonText: await more().innerText(),
        betaPaginationRequests: beta.count,
      },
    );
    if (kind === "posts") {
      check(
        "posts: stale page failure does not show an error for the new query",
        !(await page
          .getByText(/エラーが発生しました|An error occurred/)
          .isVisible()),
      );
    }
    if (!newPageDisabled) {
      await more().click();
      await bounded(beta.second.promise, `${kind} duplicate page intercepted`);
    }
    check(
      `${kind}: a pending page cannot be requested twice`,
      beta.count === 1,
      { betaPaginationRequests: beta.count },
    );
    beta.release.resolve();
    await bodyRead(kind, "beta", beta.count);
    await page.getByText("beta-next", { exact: true }).first().waitFor();
    await settle();
    await more().click();
    await page
      .getByText(/beta-offset-/)
      .first()
      .waitFor();
    const finalOffset = results.requests
      .filter((r) => r.kind === kind && r.q === "beta")
      .at(-1)?.offset;
    check(`${kind}: next page uses the correct offset`, finalOffset === 2, {
      finalOffset,
    });
  };
  await runScenario("actors");
  await runScenario("posts");
  const runSortScenario = async (kind) => {
    mode = kind;
    sortCase = true;
    alpha = pending();
    beta = pending();
    const tab = kind === "actors" ? "users" : "posts";
    const newSort = kind === "actors" ? "followers" : "popular";
    await page.goto(`${origin}/search?search=alpha&tab=${tab}`);
    await page.getByText("alpha-first", { exact: true }).first().waitFor();
    await more().click();
    await bounded(alpha.entered.promise, `${kind} old sort page intercepted`);
    const sorted = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/search/${kind}` &&
          url.searchParams.get("q") === "alpha" &&
          url.searchParams.get("sort") === newSort &&
          !url.searchParams.has("offset")
        );
      },
      { timeout },
    );
    await page
      .locator(kind === "actors" ? "#users-sort" : "#posts-sort")
      .selectOption(newSort);
    await sorted;
    await page.getByText("alpha-first", { exact: true }).first().waitFor();
    const enabledAfterSort = await more().isEnabled();
    check(
      `${kind}: sorting releases the superseded page lock`,
      enabledAfterSort,
    );
    if (!enabledAfterSort) {
      alpha.release.resolve();
      check(
        `${kind}: old sorted page cannot unlock the new pending page`,
        false,
      );
      return;
    }
    await more().click();
    await bounded(beta.entered.promise, `${kind} new sort page intercepted`);
    alpha.release.resolve();
    await bodyRead(kind, "alpha", 1);
    await settle();
    check(
      `${kind}: old sorted page cannot unlock the new pending page`,
      await more().isDisabled(),
    );
    beta.release.resolve();
    await bodyRead(kind, "alpha", 2);
    await page
      .getByText("alpha-sorted-next", { exact: true })
      .first()
      .waitFor();
    check(
      `${kind}: sorted pagination uses the selected sort once`,
      beta.count === 1 &&
        results.requests.some(
          (r) =>
            r.kind === kind &&
            r.q === "alpha" &&
            r.offset === 1 &&
            r.sort === newSort,
        ),
    );
  };
  await runSortScenario("actors");
  await runSortScenario("posts");
  sortCase = false;
  mode = "actors";
  beta = pending();
  await page.goto(`${origin}/search?search=retry&tab=users`);
  await page.getByText("retry-first", { exact: true }).waitFor();
  await more().click();
  await page
    .getByText(/エラーが発生しました|An error occurred/)
    .waitFor({ timeout });
  check(
    "current page failure exposes an error and allows retry",
    await more().isEnabled(),
    { attempts: beta.count },
  );
  await more().click();
  await page.getByText("retry-next", { exact: true }).waitFor();
  check(
    "retry requests the same page and appends the recovered row",
    beta.count === 2 &&
      results.requests.filter(
        (r) => r.kind === "actors" && r.q === "retry" && r.offset === 1,
      ).length === 2,
  );
  if (process.env.YURU_SYNTHETIC_UNEXPECTED_CONSOLE === "1")
    await page.addScriptTag({
      url: `${origin}/assets/__ux-unexpected-console.js`,
    });
} catch (err) {
  results.errors.push(String(err?.stack ?? err));
} finally {
  alpha?.release.resolve();
  beta?.release.resolve();
  if (context)
    try {
      await bounded(context.close(), "browser cleanup");
      if (
        process.env.YURU_SYNTHETIC_CLEANUP_FAULT?.split(",").includes("browser")
      )
        await bounded(new Promise(() => {}), "synthetic browser cleanup", 25);
    } catch (e) {
      results.errors.push("browser cleanup: " + e);
    }
  if (mock && mock.exitCode === null && mock.signalCode === null) {
    try {
      const exited = once(mock, "exit");
      if (!mock.kill("SIGTERM")) throw new Error("could not signal own mock");
      await bounded(exited, "mock cleanup");
    } catch (e) {
      results.errors.push("mock cleanup: " + e);
    }
  }
  if (web)
    try {
      await bounded(
        new Promise((done, reject) =>
          web.close((error) => (error ? reject(error) : done())),
        ),
        "web cleanup",
      );
      if (process.env.YURU_SYNTHETIC_CLEANUP_FAULT?.split(",").includes("web"))
        await bounded(new Promise(() => {}), "synthetic web cleanup", 25);
    } catch (e) {
      results.errors.push("web cleanup: " + e);
      web.closeAllConnections?.();
    }
  if (profile)
    try {
      await bounded(
        rm(profile, { recursive: true, force: true }),
        "profile cleanup",
      );
    } catch (e) {
      results.errors.push("profile cleanup: " + e);
    }
  const observed = {
    staleResource: 0,
    staleApplication: 0,
    currentResource: 0,
    currentApplication: 0,
  };
  const isResource = (entry, kind, query) => {
    try {
      const url = new URL(entry.url);
      return (
        url.origin === origin &&
        url.pathname === `/api/search/${kind}` &&
        url.searchParams.get("q") === query &&
        url.searchParams.get("offset") === "1" &&
        /^Failed to load resource:.*503/.test(entry.text)
      );
    } catch {
      return false;
    }
  };
  const isApplication = (entry, message) => {
    try {
      const url = new URL(entry.url);
      return (
        url.origin === origin &&
        url.pathname.startsWith("/assets/") &&
        (entry.text === message || entry.text.startsWith(`${message}\n`))
      );
    } catch {
      return false;
    }
  };
  for (const entry of results.consoleErrors) {
    if (isResource(entry, "posts", "alpha")) observed.staleResource++;
    else if (
      isApplication(
        entry,
        "Load more posts failed: ApiError: synthetic stale page failure",
      )
    )
      observed.staleApplication++;
    else if (isResource(entry, "actors", "retry")) observed.currentResource++;
    else if (
      isApplication(
        entry,
        "Load more users failed: ApiError: synthetic page failure",
      )
    )
      observed.currentApplication++;
    else results.errors.push(entry);
  }
  results.observedFaults = observed;
  if (
    observed.staleResource !== results.expectedFaults.stalePosts ||
    observed.staleApplication !== results.expectedFaults.stalePosts ||
    observed.currentResource !== results.expectedFaults.currentUsers ||
    observed.currentApplication !== results.expectedFaults.currentUsers
  ) {
    results.errors.push(
      "synthetic error console counts did not match expected failures",
    );
  }
  results.status =
    results.errors.length || results.blockedNonGet.length
      ? "HARNESS_ERROR"
      : results.checks.every((c) => c.pass)
        ? "PASS"
        : "RED";
  await writeFile(
    out + "/RESULT.json",
    JSON.stringify(results, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(results));
}
process.exitCode = results.status === "PASS" ? 0 : 1;
