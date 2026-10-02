#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { Miniflare } from "miniflare";
import { unstable_readConfig, unstable_splitSqlQuery } from "wrangler";
import { qualifyBrowserFeed } from "./release-browser-feed.mjs";
import { qualifySearchFollowing } from "./release-browser-follow.mjs";
import { qualifyBrowserDM } from "./release-browser-dm.mjs";
import { qualifyBrowserNotifications } from "./release-browser-notifications.mjs";
import { qualifyBrowserPostOutcome } from "./release-browser-post-outcome.mjs";
import { qualifyBrowserDraftStorage } from "./release-browser-draft-storage.mjs";
import { qualifyBrowserPostSnapshot } from "./release-browser-post-snapshot.mjs";
import { qualifyBrowserStorySubmit } from "./release-browser-story-submit.mjs";
import { qualifyBrowserStoryOutcome } from "./release-browser-story-outcome.mjs";
import { createManagedNativeRuntime } from "./native-runtime-stdio.mjs";
import {
  createBrowserOidcErrorIssuer,
  qualifyBrowserOidcRecovery,
} from "./release-browser-oidc.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = " release-browser-owner ";
const SESSION_SALT = "release-browser-session-salt-fixture";
const ENCRYPTION_KEY = "00".repeat(32);
const HOME_TITLE = "ここがあなたの居場所のはじまり";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireEffect(condition, message) {
  if (!condition) throw new Error(`release-browser ${message}`);
}

function chromeExecutable() {
  if (process.env.BROWSER_SMOKE_CHROME !== undefined) {
    const configured = process.env.BROWSER_SMOKE_CHROME;
    try {
      requireEffect(
        Boolean(configured) && statSync(configured).isFile(),
        "BROWSER_SMOKE_CHROME is not an executable file",
      );
      accessSync(configured, constants.X_OK);
      return configured;
    } catch {
      throw new Error(
        "release-browser BROWSER_SMOKE_CHROME override is invalid",
      );
    }
  }

  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ]) {
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue through already installed system Chrome paths.
    }
  }
  throw new Error(
    "release-browser requires installed Chrome; set BROWSER_SMOKE_CHROME",
  );
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  requireEffect(
    address && typeof address === "object",
    "could not allocate a loopback port",
  );
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function applyProductSchema(worker) {
  const schemaBytes = readFileSync(
    resolve(repo, "deploy/takoform/migrations/schema-bundle.json"),
  );
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  requireEffect(
    schema.apiVersion === "takosumi.resource-migrations/v1" &&
      schema.engine === "sqlite" &&
      Array.isArray(schema.entries) &&
      schema.entries.length > 0,
    "requires a non-empty SQLite product migration bundle",
  );

  const db = await worker.getD1Database("DB");
  for (const entry of schema.entries) {
    requireEffect(
      typeof entry.sql === "string" &&
        entry.sha256 === `sha256:${sha256(Buffer.from(entry.sql, "utf8"))}`,
      `migration digest mismatch: ${entry.name}`,
    );
    const statements = unstable_splitSqlQuery(entry.sql);
    requireEffect(statements.length > 0, `migration has no SQL: ${entry.name}`);
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }

  const actors = await db
    .prepare("SELECT COUNT(*) AS count FROM actors")
    .first();
  const sessions = await db
    .prepare("SELECT COUNT(*) AS count FROM sessions")
    .first();
  requireEffect(
    actors?.count === 0 && sessions?.count === 0,
    "migrations did not leave actors and sessions empty",
  );
  return {
    db,
    schemaSha256: `sha256:${sha256(schemaBytes)}`,
    migrationCount: schema.entries.length,
  };
}

async function dbCounts(db) {
  const actors = await db
    .prepare("SELECT COUNT(*) AS count FROM actors")
    .first();
  const sessions = await db
    .prepare("SELECT COUNT(*) AS count FROM sessions")
    .first();
  return { actors: actors?.count, sessions: sessions?.count };
}

async function ownerIdentity(page, origin) {
  return page.evaluate(async (baseOrigin) => {
    const response = await fetch(`${baseOrigin}/api/auth/me`, {
      credentials: "include",
    });
    let actor;
    try {
      actor = (await response.json()).actor;
    } catch {
      return { status: response.status, apId: null, role: null };
    }
    return {
      status: response.status,
      apId: actor?.ap_id ?? null,
      role: actor?.role ?? null,
    };
  }, origin);
}

function nativeWorker(
  artifactPath,
  origin,
  wranglerConfig,
  {
    authBindings = { AUTH_PASSWORD_HASH: PASSWORD },
    outboundService,
    destination,
  } = {},
) {
  return createManagedNativeRuntime(
    (handleRuntimeStdio) =>
      new Miniflare({
        rootPath: dirname(artifactPath),
        modules: [{ type: "ESModule", path: artifactPath }],
        modulesRoot: dirname(artifactPath),
        compatibilityDate: wranglerConfig.compatibility_date,
        compatibilityFlags: wranglerConfig.compatibility_flags,
        host: "127.0.0.1",
        port: Number(new URL(origin).port),
        cf: false,
        bindings: {
          APP_URL: origin,
          ...authBindings,
          YURUCOMMU_SESSION_HASH_SALT: SESSION_SALT,
          DELIVERY_QUEUE_NAME: "yurucommu-browser-smoke-delivery",
          DELIVERY_DLQ_NAME: "yurucommu-browser-smoke-dlq",
          ENCRYPTION_KEY: ENCRYPTION_KEY,
        },
        d1Databases: ["DB"],
        kvNamespaces: ["KV"],
        r2Buckets: ["MEDIA"],
        queueProducers: ["DELIVERY_QUEUE", "DELIVERY_DLQ"],
        handleRuntimeStdio,
        ...(outboundService ? { outboundService } : {}),
      }),
    destination ? { destination } : undefined,
  );
}

async function runOidcRecoverySmoke(artifactPath, artifactDigest, browser) {
  const config = unstable_readConfig(
    { config: resolve(repo, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  const origin = `http://127.0.0.1:${await freeLoopbackPort()}`;
  let diagnosticBytes = 0;
  let outboundRequests = 0;
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      diagnosticBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        diagnosticBytes + chunk.length,
      );
      callback();
    },
  });
  let managed;
  let issuer;
  let primaryError;
  let result;
  const cleanupFailures = [];
  try {
    issuer = await createBrowserOidcErrorIssuer({ origin });
    managed = nativeWorker(artifactPath, origin, config, {
      authBindings: issuer.bindings,
      destination,
      outboundService: async () => {
        outboundRequests += 1;
        return new Response(null, { status: 502 });
      },
    });
    await managed.worker.ready;
    const { db, schemaSha256, migrationCount } = await applyProductSchema(
      managed.worker,
    );
    const checks = [];
    const recovery = await qualifyBrowserOidcRecovery({
      browser,
      worker: managed.worker,
      db,
      origin,
      checks,
      issuer,
    });
    requireEffect(
      outboundRequests === 0,
      "OIDC error fixture attempted a Worker external fetch",
    );
    result = {
      ...recovery,
      sha256: `sha256:${artifactDigest}`,
      schemaSha256,
      migrationCount,
      browser: browser.version(),
      substrate:
        "fresh-local-http-native-d1-kv-r2-queues-and-local-authorize-error-server",
      runtimeDiagnostics: {
        policy: "discard-raw-output",
        observedBytes: diagnosticBytes,
      },
      externalWorkerFetches: {
        policy: "denied-locally",
        attempted: outboundRequests,
      },
      status: "PASSED",
    };
  } catch (error) {
    primaryError = error;
  } finally {
    for (const [label, close] of [
      ["worker", () => managed?.dispose()],
      ["issuer", () => issuer?.close()],
    ]) {
      try {
        await close();
      } catch {
        cleanupFailures.push(label);
      }
    }
    destination.destroy();
  }
  if (primaryError) {
    if (cleanupFailures.length)
      process.stderr.write("release-browser oidc-secondary-cleanup-failure\n");
    throw primaryError;
  }
  requireEffect(
    cleanupFailures.length === 0,
    "OIDC recovery runtime cleanup failed",
  );
  return result;
}

async function runBrowserSmoke(artifactPath, artifactDigest, browser) {
  const wranglerConfig = unstable_readConfig(
    { config: resolve(repo, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  requireEffect(
    Boolean(wranglerConfig.compatibility_date),
    "wrangler.jsonc lacks compatibility_date",
  );

  const port = await freeLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const { worker, dispose } = nativeWorker(
    artifactPath,
    origin,
    wranglerConfig,
  );
  let context;
  let primaryError;
  let result;
  const cleanupFailures = [];
  const pageErrors = [];
  const serverErrors = [];
  const checks = [];
  let providerRequests = 0;

  try {
    await worker.ready;
    const { db, schemaSha256, migrationCount } =
      await applyProductSchema(worker);
    checks.push("native-migrations-applied-to-empty-actors-and-sessions");

    context = await browser.newContext({
      locale: "ja-JP",
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.on("pageerror", () => pageErrors.push("pageerror"));
    page.on("response", (response) => {
      if (
        response.status() >= 500 &&
        !(
          new URL(response.url()).pathname === "/api/auth/providers" &&
          response.status() === 503 &&
          providerRequests === 1
        )
      ) {
        try {
          serverErrors.push({
            path: new URL(response.url()).pathname,
            status: response.status(),
          });
        } catch {
          serverErrors.push({ path: "invalid-response-url", status: 500 });
        }
      }
    });
    await context.route("**/*", (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        requestUrl.protocol === "data:" ||
        requestUrl.protocol === "blob:" ||
        requestUrl.origin === origin
      ) {
        return route.continue();
      }
      return route.abort("blockedbyclient");
    });
    await context.route(`${origin}/api/auth/providers`, (route) => {
      providerRequests += 1;
      if (providerRequests === 1) {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "synthetic provider-read failure" }),
        });
      }
      return route.continue();
    });

    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20000 });
    const passwordInput = page.locator('input[type="password"]');
    const submit = page.locator('form button[type="submit"]');
    const methodsRetry = page.getByRole("button", {
      name: "再試行",
      exact: true,
    });
    // Give the failed provider read time to settle without waiting for polling
    // or reloading away the product-owned recovery UI.
    await page
      .locator('[role="alert"], input[type="password"]')
      .first()
      .waitFor({ state: "visible", timeout: 5000 });
    const providerFailureView = {
      passwordVisible: await passwordInput.isVisible(),
      retryVisible: await methodsRetry.isVisible(),
      alertCount: await page.getByRole("alert").count(),
      providerRequests,
    };
    if (
      providerFailureView.passwordVisible ||
      !providerFailureView.retryVisible
    ) {
      process.stderr.write(
        `release-browser provider-failure-view=${JSON.stringify(providerFailureView)}\n`,
      );
      requireEffect(
        false,
        "provider-read failure invented an auth method or lacks manual recovery",
      );
    }
    requireEffect(
      (await page.getByRole("alert").innerText()) ===
        "ログイン方法を読み込めませんでした。再試行してください。" &&
        (await methodsRetry.isVisible()) &&
        !(await passwordInput.isVisible()) &&
        providerRequests === 1,
      "provider-read failure invented an auth method or lacks manual recovery",
    );
    const failedProviderCounts = await dbCounts(db);
    requireEffect(
      failedProviderCounts.actors === 0 && failedProviderCounts.sessions === 0,
      "provider-read failure created an identity or session",
    );
    checks.push(
      "browser-auth-method-read-failure-visible-without-invented-password",
    );
    const [providersResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/auth/providers` &&
          response.status() === 200,
        { timeout: 10000 },
      ),
      methodsRetry.click(),
    ]);
    const providerConfig = await providersResponse.json();
    requireEffect(
      providerConfig.password_enabled === true &&
        providerConfig.providers.length === 0 &&
        providerRequests === 2,
      "auth-method retry did not read the actual native providers config exactly once",
    );
    checks.push("browser-auth-method-manual-retry-loads-native-config");
    await passwordInput.waitFor({ state: "visible", timeout: 15000 });
    const labels = await passwordInput.evaluate((input) =>
      Array.from(input.labels ?? [])
        .filter((label) => {
          const style = getComputedStyle(label);
          return (
            label.getClientRects().length > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        })
        .map((label) => label.textContent?.trim() ?? ""),
    );
    requireEffect(
      labels.length === 1 && labels[0] === "パスワード",
      "password input lacks one visible パスワード label",
    );
    checks.push("browser-password-input-visible-associated-label");
    requireEffect(
      await submit.isDisabled(),
      "empty password submit was not disabled",
    );
    checks.push("browser-empty-password-submit-disabled");

    const emptyBeforeAttempt = await dbCounts(db);
    requireEffect(
      emptyBeforeAttempt.actors === 0 && emptyBeforeAttempt.sessions === 0,
      "initial page created an actor or session",
    );
    await passwordInput.fill(`${PASSWORD}wrong`);
    const wrongResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/login" &&
        response.request().method() === "POST",
      { timeout: 15000 },
    );
    await submit.click();
    const wrongResponse = await wrongResponsePromise;
    requireEffect(
      wrongResponse.status() === 401,
      "wrong browser password was not refused with 401",
    );
    const wrongBody = await wrongResponse.json();
    requireEffect(
      typeof wrongBody.error === "string" && wrongBody.error.length > 0,
      "wrong password did not provide the expected displayable refusal",
    );
    const emptyAfterAttempt = await dbCounts(db);
    requireEffect(
      emptyAfterAttempt.actors === 0 && emptyAfterAttempt.sessions === 0,
      "wrong password persisted an actor or session",
    );
    const error = page.getByText(wrongBody.error, { exact: true });
    await error.waitFor({ state: "visible", timeout: 10000 });
    const alertCount = await page.getByRole("alert").count();
    const errorIsInLoginForm = await error.evaluate((node) => {
      const input = document.querySelector('input[type="password"]');
      const form = input?.closest("form");
      return (
        node.getAttribute("role") === "alert" &&
        // The shared alert sits directly in the login container, outside the
        // inner auth-method group that contains the actual password form.
        node.parentElement === form?.parentElement?.parentElement
      );
    });
    requireEffect(
      alertCount === 1 && errorIsInLoginForm,
      "wrong password did not display its refusal alert beside the actual login form",
    );
    checks.push("browser-invalid-password-refused-without-owner-or-session");
    checks.push("browser-invalid-password-visible-error-alert");

    await passwordInput.fill(PASSWORD);
    const loginResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/login" &&
        response.request().method() === "POST",
      { timeout: 15000 },
    );
    await submit.click();
    const loginResponse = await loginResponsePromise;
    const passwordUnchangedOnWire =
      loginResponse.request().postDataJSON()?.password === PASSWORD;
    requireEffect(
      loginResponse.status() === 200 && passwordUnchangedOnWire,
      "valid login failed or changed the opaque password on the wire",
    );
    checks.push("browser-password-login-preserves-padded-wire-value");

    const actorApId = `${origin}/ap/users/tako`;
    await page
      .getByText(HOME_TITLE, { exact: true })
      .waitFor({ state: "visible", timeout: 20000 });
    const firstIdentity = await ownerIdentity(page, origin);
    const ownerRows = (
      await db
        .prepare(
          "SELECT ap_id, preferred_username, takos_user_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
        )
        .all()
    ).results;
    const countsAfterLogin = await dbCounts(db);
    const browserCookies = await context.cookies(origin);
    const sessionCookie = browserCookies.find(
      (cookie) => cookie.name === "session",
    );
    requireEffect(
      Boolean(sessionCookie?.value),
      "browser login did not persist a session cookie",
    );
    const expectedSessionId = `sha256:${sha256(`${SESSION_SALT}:${sessionCookie.value}`)}`;
    const session = await db
      .prepare(
        "SELECT id, member_id, access_token, expires_at, provider, provider_access_token, provider_refresh_token, provider_token_expires_at FROM sessions WHERE id = ?",
      )
      .bind(expectedSessionId)
      .first();
    const root = ownerRows[0];
    requireEffect(
      firstIdentity.status === 200 &&
        firstIdentity.apId === actorApId &&
        firstIdentity.role === "owner" &&
        countsAfterLogin.actors === 1 &&
        countsAfterLogin.sessions === 1 &&
        ownerRows.length === 1 &&
        root?.ap_id === actorApId &&
        root.preferred_username === "tako" &&
        root.takos_user_id === "password:owner" &&
        root.role === "owner" &&
        root.owner_actor_ap_id === null &&
        root.deleted_at === null &&
        session?.id === expectedSessionId &&
        session.member_id === actorApId &&
        session.access_token === expectedSessionId &&
        Number.isFinite(Date.parse(session.expires_at)) &&
        Date.parse(session.expires_at) > Date.now() &&
        session.provider === null &&
        session.provider_access_token === null &&
        session.provider_refresh_token === null &&
        session.provider_token_expires_at === null,
      "browser login did not persist the single live root owner and salted session",
    );
    checks.push("browser-first-owner-and-salted-session-persisted");
    checks.push("browser-authenticated-home-feed-visible");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    await page
      .getByText(HOME_TITLE, { exact: true })
      .waitFor({ state: "visible", timeout: 20000 });
    const refreshedIdentity = await ownerIdentity(page, origin);
    requireEffect(
      refreshedIdentity.status === 200 &&
        refreshedIdentity.apId === actorApId &&
        refreshedIdentity.role === "owner" &&
        !(await passwordInput.isVisible()),
      "page refresh lost the browser's persisted root owner session",
    );
    checks.push("browser-refresh-retains-root-owner");

    const feedMetadata = await qualifyBrowserFeed({
      page,
      worker,
      db,
      origin,
      actorApId,
      checks,
    });
    requireEffect(
      feedMetadata && typeof feedMetadata === "object",
      "browser feed qualification returned no metadata",
    );

    const feedActors = (
      await db
        .prepare(
          "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
        )
        .all()
    ).results;
    const feedSessionCounts = await dbCounts(db);
    requireEffect(
      feedActors.length === 1 &&
        feedActors[0]?.ap_id === actorApId &&
        feedActors[0]?.role === "owner" &&
        feedActors[0]?.owner_actor_ap_id === null &&
        feedActors[0]?.deleted_at === null &&
        feedSessionCounts.actors === 1 &&
        feedSessionCounts.sessions === 1,
      "feed qualification changed the final scope beyond the single live owner",
    );
    checks.push("feed-scope-single-live-owner-no-member-seed");

    const postOutcomeMetadata = await qualifyBrowserPostOutcome({
      page,
      db,
      origin,
      actorApId,
      checks,
    });
    const followMetadata = await qualifySearchFollowing({
      page,
      db,
      origin,
      actorApId,
      checks,
    });
    const dmMetadata = await qualifyBrowserDM({
      page,
      db,
      origin,
      actorApId,
      recipientApId: followMetadata.publicActorApId,
      checks,
    });
    const postSnapshotMetadata = await qualifyBrowserPostSnapshot({
      page,
      worker,
      db,
      origin,
      actorApId,
      checks,
    });
    const draftStorageMetadata = await qualifyBrowserDraftStorage({
      page,
      db,
      origin,
      actorApId,
      checks,
    });
    const notificationMetadata = await qualifyBrowserNotifications({
      page,
      db,
      origin,
      actorApId,
      checks,
    });
    const finalActors = (
      await db
        .prepare(
          "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
        )
        .all()
    ).results;
    const personaIds = new Set([
      followMetadata?.privateActorApId,
      followMetadata?.publicActorApId,
    ]);
    const finalSessionCounts = await dbCounts(db);
    const finalIdentity = await ownerIdentity(page, origin);
    requireEffect(
      personaIds.size === 2 &&
        !personaIds.has(undefined) &&
        !personaIds.has(actorApId) &&
        finalActors.length === 3 &&
        finalActors.every(
          (actor) =>
            actor.deleted_at === null &&
            (actor.ap_id === actorApId
              ? actor.role === "owner" && actor.owner_actor_ap_id === null
              : personaIds.has(actor.ap_id) &&
                actor.role === "member" &&
                actor.owner_actor_ap_id === actorApId),
        ) &&
        finalSessionCounts.actors === 3 &&
        finalSessionCounts.sessions === 1 &&
        finalIdentity.status === 200 &&
        finalIdentity.apId === actorApId &&
        finalIdentity.role === "owner",
      "browser qualification changed the single owner or linked persona boundary",
    );
    checks.push("final-scope-one-owner-two-own-personas-one-session");
    requireEffect(
      pageErrors.length === 0,
      "browser raised a page runtime error",
    );
    requireEffect(
      serverErrors.length === 0,
      "artifact returned an unexpected HTTP 5xx response",
    );
    checks.push("browser-no-page-errors-or-http-5xx");

    // Keep all prior checks in their existing order; append Story assertions
    // after the independent OIDC result is joined in main().
    const storySubmitChecks = [];
    const storySubmitMetadata = await qualifyBrowserStorySubmit({
      page,
      db,
      origin,
      actorApId,
      checks: storySubmitChecks,
    });
    requireEffect(
      pageErrors.length === 0,
      "Story submission raised a page runtime error",
    );
    requireEffect(
      serverErrors.length === 0,
      "Story submission returned an unexpected HTTP 5xx",
    );

    const storyOutcomeChecks = [];
    const storyOutcomeMetadata = await qualifyBrowserStoryOutcome({
      page,
      db,
      worker,
      origin,
      actorApId,
      checks: storyOutcomeChecks,
    });
    requireEffect(
      pageErrors.length === 0,
      "Story outcome raised a page runtime error",
    );
    requireEffect(
      serverErrors.length === 0,
      "Story outcome returned an unexpected HTTP 5xx",
    );

    result = {
      kind: "yurucommu.release-browser-smoke@v1",
      artifact: basename(artifactPath),
      sha256: `sha256:${artifactDigest}`,
      browser: browser.version(),
      runtime: "workerd",
      substrate: "local-http-native-d1-kv-r2-queues",
      schemaSha256,
      migrationCount,
      scope:
        "one self-created root owner and two API-created own personas; synthetic remote Like/Announce and one cache/inbox peer fixture; no local actor/session seed or public TLS/deploy/federation qualification",
      checks,
      feed: feedMetadata,
      postOutcome: postOutcomeMetadata,
      follow: followMetadata,
      dm: dmMetadata,
      postSnapshot: postSnapshotMetadata,
      draftStorage: draftStorageMetadata,
      notifications: notificationMetadata,
      storySubmit: { ...storySubmitMetadata, checks: storySubmitChecks },
      storyOutcome: { ...storyOutcomeMetadata, checks: storyOutcomeChecks },
      status: "PASSED",
    };
  } catch (error) {
    primaryError = error;
  } finally {
    for (const [label, close] of [
      ["context", () => context?.close()],
      ["worker", () => dispose()],
    ]) {
      try {
        await close();
      } catch {
        cleanupFailures.push(label);
      }
    }
  }

  if (primaryError) {
    if (cleanupFailures.length)
      process.stderr.write(
        `release-browser cleanup also failed for ${cleanupFailures.join(",")}\n`,
      );
    throw primaryError;
  }
  requireEffect(
    cleanupFailures.length === 0,
    `cleanup failed for ${cleanupFailures.join(",")}`,
  );
  return result;
}

async function main() {
  const [artifactArgument, expectedDigest] = process.argv.slice(2);
  if (!artifactArgument || process.argv.length > 4) {
    throw new Error(
      "usage: bun scripts/smoke-release-browser.mjs <artifact.js> [sha256:<digest>]",
    );
  }
  const artifactPath = resolve(process.cwd(), artifactArgument);
  let artifactBytes;
  try {
    requireEffect(statSync(artifactPath).isFile(), "artifact is not a file");
    artifactBytes = readFileSync(artifactPath);
  } catch {
    throw new Error("release-browser artifact is missing or unreadable");
  }
  const artifactDigest = sha256(artifactBytes);
  if (expectedDigest !== undefined) {
    requireEffect(
      expectedDigest === `sha256:${artifactDigest}`,
      "artifact digest does not match expected sha256",
    );
  }

  const chromePath = chromeExecutable();
  let browser;
  let primaryError;
  let result;
  const cleanupFailures = [];
  try {
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const oidcRecovery = await runOidcRecoverySmoke(
      artifactPath,
      artifactDigest,
      browser,
    );
    result = await runBrowserSmoke(artifactPath, artifactDigest, browser);
    result.oidcRecovery = oidcRecovery;
    result.checks.push(
      ...oidcRecovery.checks,
      ...result.storySubmit.checks,
      ...result.storyOutcome.checks,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await browser?.close();
    } catch {
      cleanupFailures.push("browser");
    }
  }
  if (primaryError) {
    if (cleanupFailures.length)
      process.stderr.write(
        "release-browser secondary-browser-cleanup-failure\n",
      );
    throw primaryError;
  }
  requireEffect(cleanupFailures.length === 0, "browser cleanup failed");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
