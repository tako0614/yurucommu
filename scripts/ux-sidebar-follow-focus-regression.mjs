// Exercises the actual built UI; all mutations are synthetic intercepted ACKs.
// Run after bun run build:client, from the product root:
// node scripts/ux-sidebar-follow-focus-regression.mjs <private-evidence-directory>
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
const { chromium } = createRequire(resolve("package.json"))("playwright-core");
const evidence = process.argv[2];
if (!evidence) throw Error("evidence directory required");
const temporaryRoot = process.env.TMPDIR ?? tmpdir();
function chromeExecutable() {
  const configured = process.env.BROWSER_SMOKE_CHROME;
  for (const candidate of configured !== undefined
    ? [configured]
    : [
        "/opt/google/chrome/chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw Error(
    "Installed Chrome is required; set BROWSER_SMOKE_CHROME to an executable",
  );
}
const result = {
  scope:
    "actual built UI; isolated loopback mock GETs; synthetic follow ACK intercepted without forwarding",
  checks: [],
  errors: [],
  blockedNonGet: [],
  blockedExternal: 0,
  deliveredAssets: {},
};
const timeout = 15000;
async function bounded(p, label) {
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("timeout: " + label)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function listen(s) {
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return s.address().port;
}
let web, mock, context, profile, origin, mockOrigin, current;
try {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const dist = resolve("dist");
  web = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") return res.writeHead(405).end();
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      const file =
        path.startsWith("/assets/") || path === "/manifest.webmanifest"
          ? resolve(dist, "." + decodeURIComponent(path))
          : join(dist, "index.html");
      if (!file.startsWith(dist + sep)) throw Error("outside dist");
      const body = await readFile(file);
      res.once("finish", () => {
        result.deliveredAssets[file.slice(dist.length + 1)] = {
          sha256: createHash("sha256").update(body).digest("hex"),
          bytes: body.length,
        };
      });
      res
        .writeHead(200, {
          "content-type":
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".webmanifest": "application/manifest+json",
            }[extname(file)] ?? "application/octet-stream",
        })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  origin = "http://127.0.0.1:" + (await listen(web));
  const probe = createServer();
  const mockPort = await listen(probe);
  await new Promise((done) => probe.close(done));
  mockOrigin = "http://127.0.0.1:" + mockPort;
  mock = spawn("bun", ["scripts/dev-mock-server.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: temporaryRoot,
      YURUCOMMU_MOCK_HOST: "127.0.0.1",
      YURUCOMMU_MOCK_PORT: String(mockPort),
      YURUCOMMU_MOCK_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  await bounded(
    new Promise((done, reject) => {
      mock.stdout.on("data", (chunk) => {
        logs += chunk;
        if (logs.includes("mock API listening")) done();
      });
      mock.stderr.on("data", (chunk) => {
        logs += chunk;
      });
      mock.once("exit", () => reject(Error("mock exited before ready")));
    }),
    "mock startup",
  );
  const r = await fetch(mockOrigin + "/api/recommendations/users");
  if (!r.ok) throw Error("mock recommendations missing");
  const recommendation = (await r.json()).users[0];
  profile = await mkdtemp(join(temporaryRoot, "sidebar-focus-profile-"));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromeExecutable(),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
    ],
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    serviceWorkers: "block",
    env: { PATH: process.env.PATH ?? "", TMPDIR: temporaryRoot },
  });
  if (!context.routeWebSocket)
    throw Error("WebSocket interception unavailable");
  await context.routeWebSocket("**/*", (socket) => socket.close());
  result.webSocketGuard = true;
  await context.route("**/*", async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (
      u.origin === origin &&
      req.method() === "POST" &&
      u.pathname === "/api/follow"
    ) {
      if (
        JSON.parse(req.postData() ?? "{}").target_ap_id !== recommendation.ap_id
      ) {
        result.errors.push("unexpected follow target");
        return route.abort();
      }
      current.followAcks++;
      return json({ status: "accepted" });
    }
    if (req.method() !== "GET") {
      result.blockedNonGet.push({ method: req.method(), path: u.pathname });
      return route.abort();
    }
    if (u.origin !== origin) {
      result.blockedExternal++;
      if (req.resourceType() === "image")
        return route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        });
      return route.abort();
    }
    if (!u.pathname.startsWith("/api/")) return route.continue();
    if (u.pathname === "/api/recommendations/users")
      return json({ users: [recommendation] });
    if (u.pathname === "/api/timeline")
      return json({ posts: [], next_cursor: null, has_more: false });
    if (u.pathname === "/api/notifications/pushers/config")
      return json({ enabled: false });
    const response = await fetch(mockOrigin + u.pathname + u.search);
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  for (const [name, path] of [
    ["search", "/search"],
    ["empty-home", "/"],
  ]) {
    current = { name, followAcks: 0 };
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.on("pageerror", (e) => result.errors.push(String(e)));
    await page.goto(origin + path);
    const button = page.locator("[data-rec-follow]");
    await button.waitFor({ timeout });
    if (name === "empty-home")
      await page.locator("#first-connection-address").waitFor({ timeout });
    await button.focus();
    await button.press("Enter");
    await button.waitFor({ state: "detached", timeout });
    await page.evaluate(() => new Promise((done) => queueMicrotask(done)));
    const state = await page.evaluate(() => ({
      mainFocused:
        document.activeElement?.matches('main,[role="main"]') ?? false,
      activeTag: document.activeElement?.tagName,
      connectPanels: document.querySelectorAll("[data-sidebar-connect]").length,
    }));
    result.checks.push({
      name,
      pass:
        state.mainFocused &&
        state.connectPanels === 0 &&
        current.followAcks === 1,
      ...state,
      interceptedFollowAcks: current.followAcks,
    });
    await page.screenshot({ path: join(evidence, name + ".png") });
    await page.close();
  }
} catch (e) {
  result.errors.push(String(e?.stack ?? e));
} finally {
  if (context) {
    try {
      await bounded(context.close(), "browser close");
    } catch (e) {
      result.errors.push(String(e));
    }
  }
  if (mock && mock.exitCode === null && mock.signalCode === null) {
    try {
      const end = once(mock, "exit");
      mock.kill("SIGTERM");
      const [code, signal] = await bounded(end, "mock close");
      result.mockShutdown = { code, signal };
    } catch (e) {
      result.errors.push(String(e));
    }
  }
  if (web) {
    try {
      await bounded(new Promise((done) => web.close(done)), "web close");
    } catch (e) {
      result.errors.push(String(e));
    }
  }
  if (profile) {
    try {
      await rm(profile, { recursive: true, force: true });
    } catch (e) {
      result.errors.push(String(e));
    }
  }
  result.status =
    result.errors.length || result.blockedNonGet.length
      ? "HARNESS_ERROR"
      : result.checks.length === 2 && result.checks.every((c) => c.pass)
        ? "PASS"
        : "RED";
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeFile(
    join(evidence, "RESULT.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: result.status,
      checks: result.checks,
      errors: result.errors,
      blockedNonGet: result.blockedNonGet,
    }),
  );
  if (result.status !== "PASS") process.exitCode = 1;
}
