import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

const output = process.argv[2];
if (!output) throw new Error("Pass a private evidence directory");
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
const bounded = async (promise, label, limit = 15_000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), limit);
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
    "built UI with synthetic loopback API; selected fake writes intercepted, no write forwarded",
  checks: [],
  errors: [],
  consoleErrors: [],
  blockedExternal: 0,
  blockedNonGet: [],
  writes: [],
};
const check = (name, pass, details = {}) =>
  result.checks.push({ name, pass: Boolean(pass), ...details });
const controls = new Map();
let web, mock, context, profile, origin;
try {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const dist = resolve(process.env.YURU_SYNTHETIC_DIST || "dist");
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
  const probe = createServer();
  const port = await listen(probe);
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
  const ids = [1, 2].map((n) => `${origin}/ap/notes/post-${n}`);
  const post = (
    await (
      await fetch(`${mockOrigin}/api/posts/${encodeURIComponent(ids[0])}`)
    ).json()
  ).post;
  const paths = ids.map((id) => `/api/posts/${encodeURIComponent(id)}/like`);
  profile = await mkdtemp(join(tempRoot, "yuru-search-like-profile-"));
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
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      const control = controls.get(url.pathname);
      if (
        url.origin === origin &&
        control &&
        request.method() === control.method &&
        control.count === 0
      ) {
        const record = {
          method: request.method(),
          path: url.pathname,
          status: control.status,
          target: control.target,
        };
        result.writes.push(record);
        control.count++;
        control.entered.resolve();
        await control.release.promise;
        return json(
          route,
          control.status === 200
            ? { ok: true }
            : { error: `synthetic ${control.status} ${control.target}` },
          control.status,
        );
      }
      result.blockedNonGet.push({
        method: request.method(),
        path: url.pathname,
      });
      return route.abort();
    }
    if (url.origin !== origin) {
      result.blockedExternal++;
      if (request.resourceType() === "image")
        return route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        });
      return route.abort();
    }
    if (url.pathname === "/api/search/actors")
      return json(route, { actors: [], has_more: false });
    if (url.pathname === "/api/search/posts") {
      const q = url.searchParams.get("q");
      const liked = q === "beta-liked" || q === "unlike";
      const make = (index) => ({
        ...post,
        ap_id: ids[index],
        author: { ...post.author, ap_id: actor.ap_id },
        content: `Synthetic ${q} ${index + 1}`,
        liked,
        like_count: liked ? 6 : 5,
      });
      return json(route, {
        posts: q === "two" ? [make(0), make(1)] : [make(0)],
        has_more: false,
      });
    }
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
  if (context.routeWebSocket)
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
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  const open = async (q) => {
    await page.goto(`${origin}/search?search=${q}&tab=posts`);
    await page.getByText(`Synthetic ${q} 1`, { exact: true }).waitFor();
  };
  const search = async (q) => {
    const input = page.getByRole("textbox", { name: /検索|Search/ });
    await input.fill(q);
    await input.press("Enter");
    await page.getByText(`Synthetic ${q} 1`, { exact: true }).waitFor();
  };
  const button = (q, index = 1) =>
    page
      .locator('a[href^="/post/"]')
      .filter({ hasText: `Synthetic ${q} ${index}` })
      .locator("..")
      .getByRole("button", { name: /いいね|Like/ });
  const state = async (q, index = 1) => ({
    pressed: await button(q, index).getAttribute("aria-pressed"),
    count:
      (
        await button(q, index).locator("span.text-sm").allTextContents()
      )[0]?.trim() ?? "",
  });
  const notices = (expression) => page.getByText(expression).count();
  const hold = (index, status, method = "POST") => {
    const control = {
      status,
      method,
      path: paths[index],
      target: `post-${index + 1}`,
      count: 0,
      entered: defer(),
      release: defer(),
    };
    controls.set(paths[index], control);
    return control;
  };
  const release = async (control) => {
    const response = page.waitForResponse(
      (r) =>
        r.status() === control.status &&
        new URL(r.url()).pathname === control.path &&
        r.request().method() === control.method,
      { timeout: 15_000 },
    );
    control.release.resolve();
    await response;
    await settle();
  };

  await open("alpha");
  let control = hold(0, 503);
  await button("alpha").click();
  await bounded(control.entered.promise, "old like");
  const pendingState = await state("alpha");
  check(
    "pending like retains the prior value and disables the target",
    pendingState.pressed === "false" &&
      pendingState.count === "5" &&
      (await button("alpha").isDisabled()),
    pendingState,
  );
  await search("beta-liked");
  check(
    "same target remains disabled after a new query",
    await button("beta-liked").isDisabled(),
  );
  const unknownPattern =
    /結果を確認できません.*post-1|outcome.*unconfirmed.*post-1/i;
  let noticeBefore = await notices(unknownPattern);
  await release(control);
  const afterUnknown = await state("beta-liked");
  check(
    "old 503 preserves the newer liked row",
    afterUnknown.pressed === "true" && afterUnknown.count === "6",
    afterUnknown,
  );
  check(
    "old 503 identifies the original target and an unknown outcome",
    (await notices(unknownPattern)) === noticeBefore + 1,
  );
  check("old 503 does not resend", control.count === 1);

  await open("reject");
  control = hold(0, 403);
  await button("reject").click();
  await bounded(control.entered.promise, "rejected like");
  const rejectedPattern = /拒否されました.*post-1|rejected.*post-1/i;
  noticeBefore = await notices(rejectedPattern);
  await release(control);
  const rejected = await state("reject");
  check(
    "received 4xx leaves the original row unchanged",
    rejected.pressed === "false" && rejected.count === "5",
    rejected,
  );
  check(
    "received 4xx is identified as rejected for the original target",
    (await notices(rejectedPattern)) === noticeBefore + 1,
  );

  await open("current-unknown");
  control = hold(0, 503);
  await button("current-unknown").click();
  await bounded(control.entered.promise, "current unknown like");
  noticeBefore = await notices(unknownPattern);
  await release(control);
  const unknown = await state("current-unknown");
  check(
    "unconfirmed current like keeps the original row",
    unknown.pressed === "false" && unknown.count === "5",
    unknown,
  );
  check(
    "unconfirmed current like adds a check-before-retry notice",
    (await notices(unknownPattern)) === noticeBefore + 1,
  );
  await page.waitForTimeout(5_250);
  check(
    "current unknown notice survives the default error timeout",
    (await notices(unknownPattern)) === noticeBefore + 1,
  );

  await open("unlike");
  control = hold(0, 503, "DELETE");
  await button("unlike").click();
  await bounded(control.entered.promise, "stale unknown unlike");
  await search("beta-unliked");
  noticeBefore = await notices(unknownPattern);
  await release(control);
  const unlikeUnknown = await state("beta-unliked");
  check(
    "old unknown unlike does not change a newer row",
    unlikeUnknown.pressed === "false" && unlikeUnknown.count === "5",
    unlikeUnknown,
  );
  check(
    "old unknown unlike adds its own target notice",
    (await notices(unknownPattern)) === noticeBefore + 1,
  );

  await open("success");
  control = hold(0, 200);
  await button("success").click();
  await bounded(control.entered.promise, "successful like");
  await release(control);
  const liked = await state("success");
  check(
    "successful current like updates its exact row once",
    liked.pressed === "true" && liked.count === "6",
    liked,
  );
  control = hold(0, 200, "DELETE");
  await button("success").click();
  await bounded(control.entered.promise, "successful unlike");
  await release(control);
  const unliked = await state("success");
  check(
    "successful unlike updates its exact row once",
    unliked.pressed === "false" &&
      unliked.count === "5" &&
      result.writes.at(-1).method === "DELETE",
    unliked,
  );

  await open("alpha");
  control = hold(0, 200);
  await button("alpha").click();
  await bounded(control.entered.promise, "stale successful like");
  await search("beta-unliked");
  const acceptedPattern =
    /受け付けられました.*post-1|action was accepted.*post-1/i;
  noticeBefore = await notices(acceptedPattern);
  await release(control);
  const staleSuccess = await state("beta-unliked");
  check(
    "old success does not patch a newer same-ID row",
    staleSuccess.pressed === "false" && staleSuccess.count === "5",
    staleSuccess,
  );
  check(
    "old success asks to reopen the original target",
    (await notices(acceptedPattern)) === noticeBefore + 1,
  );

  // A private in-memory build hook exercises actual component settlement while
  // the existing auth loading atom changes. No hook is present in product builds.
  if (process.env.YURU_SYNTHETIC_AUTH_HOOK === "1") {
    await open("loading-unknown");
    if (
      !(await page.evaluate(
        () => typeof globalThis.__syntheticSearchLikeSetLoading === "function",
      ))
    )
      throw new Error("private auth loading hook unavailable");
    await page.evaluate(() => globalThis.__syntheticSearchLikeSetLoading(true));
    check(
      "connection checking visibly disables a new like",
      (await button("loading-unknown").isDisabled()) &&
        (await button("loading-unknown").innerText()).includes(
          "接続先を確認中",
        ),
    );
    await page.evaluate(() =>
      globalThis.__syntheticSearchLikeSetLoading(false),
    );
    control = hold(0, 503);
    await button("loading-unknown").click();
    await bounded(control.entered.promise, "loading-overlap unknown like");
    await page.evaluate(() => globalThis.__syntheticSearchLikeSetLoading(true));
    noticeBefore = await notices(unknownPattern);
    await release(control);
    check(
      "settled unknown remains pending while connection is being checked",
      (await button("loading-unknown").innerText()).includes("処理中"),
    );
    await page.evaluate(() =>
      globalThis.__syntheticSearchLikeSetLoading(false),
    );
    await settle();
    const loadingUnknown = await state("loading-unknown");
    check(
      "same scope after loading receives its own unknown notice",
      (await notices(unknownPattern)) === noticeBefore + 1 &&
        loadingUnknown.pressed === "false" &&
        loadingUnknown.count === "5",
      loadingUnknown,
    );

    await open("loading-success");
    control = hold(0, 200);
    await button("loading-success").click();
    await bounded(control.entered.promise, "loading-overlap successful like");
    await page.evaluate(() => globalThis.__syntheticSearchLikeSetLoading(true));
    await release(control);
    const heldSuccess = await state("loading-success");
    check(
      "settled success remains pending without changing the row during loading",
      heldSuccess.pressed === "false" &&
        heldSuccess.count === "5" &&
        (await button("loading-success").innerText()).includes("処理中"),
      heldSuccess,
    );
    await page.evaluate(() =>
      globalThis.__syntheticSearchLikeSetLoading(false),
    );
    await settle();
    const releasedSuccess = await state("loading-success");
    check(
      "same scope after loading receives its exact successful result",
      releasedSuccess.pressed === "true" && releasedSuccess.count === "6",
      releasedSuccess,
    );
  }

  await open("two");
  const first = hold(0, 200);
  const second = hold(1, 200);
  await button("two", 1).click();
  await bounded(first.entered.promise, "first pending");
  check(
    "pending target is disabled but another target remains usable",
    (await button("two", 1).isDisabled()) &&
      (await button("two", 2).isEnabled()),
  );
  await button("two", 2).click();
  await bounded(second.entered.promise, "second target");
  await release(second);
  check(
    "different target completes while first remains pending",
    (await state("two", 2)).pressed === "true" &&
      first.count === 1 &&
      second.count === 1,
  );
  await page.getByText("Synthetic two 1", { exact: true }).click();
  await page.waitForURL(/\/post\//);
  await page.goBack();
  await page.getByText("Synthetic two 1", { exact: true }).waitFor();
  check(
    "leaving and returning cannot resend the still pending target",
    (await button("two", 1).isDisabled()) && first.count === 1,
  );
  noticeBefore = await notices(acceptedPattern);
  await release(first);
  const returned = await state("two", 1);
  check(
    "old success after Back preserves the newly read row and adds a notice",
    returned.pressed === "false" &&
      returned.count === "5" &&
      (await notices(acceptedPattern)) === noticeBefore + 1,
    returned,
  );
  check("leaving and returning does not auto-resend", first.count === 1);
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  for (const control of controls.values()) control.release.resolve();
  if (context)
    try {
      await bounded(context.close(), "browser cleanup");
    } catch (error) {
      result.errors.push(`browser cleanup: ${error}`);
    }
  if (mock && mock.exitCode === null && mock.signalCode === null)
    try {
      const exited = once(mock, "exit");
      if (!mock.kill("SIGTERM")) throw new Error("could not signal own mock");
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
  const expected = result.writes.filter((write) => write.status !== 200);
  const resourceCounts = new Map();
  const applicationCounts = new Map();
  for (const entry of result.consoleErrors) {
    const resource = entry.text.match(
      /^Failed to load resource: the server responded with a status of (\d+)\b/,
    );
    const application = entry.text.match(
      /^Failed to toggle like: ApiError: synthetic (\d+) (post-\d+)(?:\n|$)/,
    );
    if (resource && entry.url.startsWith(`${origin}/api/posts/`)) {
      const key = `${resource[1]} ${entry.url}`;
      resourceCounts.set(key, (resourceCounts.get(key) ?? 0) + 1);
    } else if (application && entry.url.startsWith(`${origin}/assets/`)) {
      const key = `${application[1]} ${application[2]}`;
      applicationCounts.set(key, (applicationCounts.get(key) ?? 0) + 1);
    } else result.errors.push(`unexpected console error: ${entry.text}`);
  }
  for (const write of expected) {
    const resource = `${write.status} ${origin}${write.path}`;
    const application = `${write.status} ${write.target}`;
    resourceCounts.set(resource, (resourceCounts.get(resource) ?? 0) - 1);
    applicationCounts.set(
      application,
      (applicationCounts.get(application) ?? 0) - 1,
    );
  }
  if (
    [...resourceCounts.values(), ...applicationCounts.values()].some(
      (count) => count !== 0,
    )
  )
    result.errors.push(
      "synthetic error console status/target counts did not match intercepted writes",
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
