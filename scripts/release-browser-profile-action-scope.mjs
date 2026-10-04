// Native-browser qualification for ProfilePage block/mute request lifetimes.
// Mutation responses come from the disposable Native Worker; the route holds
// only the exact native response bytes while the SPA changes profile owner.

import { createHash, randomUUID } from "node:crypto";

const TIMEOUT = 15_000;

function need(condition, label, detail = "") {
  if (!condition)
    throw new Error(
      `profile-action-scope:${label}${detail ? ` ${detail}` : ""}`,
    );
}

function gate(label) {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject, label };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`profile-action-scope:${label}-timeout`)),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cookieFrom(response) {
  return (
    /(?:^|,\s*)session=([^;,]+)/i.exec(
      response.headers.get("set-cookie") ?? "",
    )?.[1] ?? null
  );
}

async function api(worker, origin, cookie, path, method = "GET", body) {
  return worker.dispatchFetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      cookie: `session=${cookie}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function login(worker, db, origin, password) {
  const before = await db
    .prepare("SELECT ap_id FROM actors ORDER BY ap_id")
    .all();
  need((before.results ?? []).length === 0, "fresh-owner-only-database");
  const response = await worker.dispatchFetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  need(
    response.status === 200,
    "fresh-password-owner-login",
    `${response.status}`,
  );
  const cookie = cookieFrom(response);
  need(cookie, "owner-session-cookie");
  const actor = (
    await (await api(worker, origin, cookie, "/api/auth/me")).json()
  ).actor;
  need(
    actor?.role === "owner" && new URL(actor.ap_id).origin === origin,
    "root-owner-session",
  );
  return { actor, cookie };
}

async function createPersona(worker, origin, auth, suffix) {
  const username = `profile_action_${suffix}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const response = await api(
    worker,
    origin,
    auth.cookie,
    "/api/auth/accounts",
    "POST",
    {
      username,
      name: `Profile Action ${suffix.toUpperCase()}`,
    },
  );
  need(
    response.status === 201 || response.status === 200,
    "owner-creates-linked-profile",
    `${response.status}`,
  );
  const actor = (await response.json()).account;
  need(actor?.ap_id === `${origin}/ap/users/${username}`, "persona-ap-id");
  const row = await (
    await worker.getD1Database("DB")
  )
    .prepare("SELECT role, owner_actor_ap_id FROM actors WHERE ap_id = ?")
    .bind(actor.ap_id)
    .first();
  need(
    row?.role === "member" && row.owner_actor_ap_id === auth.actor.ap_id,
    "persona-is-owner-linked-member",
  );
  return actor;
}

async function switchAndCreatePost(worker, origin, auth, actor, content) {
  const switched = await api(
    worker,
    origin,
    auth.cookie,
    "/api/auth/switch",
    "POST",
    { ap_id: actor.ap_id },
  );
  need(
    switched.status === 200,
    "native-switch-to-posting-persona",
    `${switched.status}`,
  );
  const cookie = cookieFrom(switched);
  need(cookie, "persona-session-cookie");
  const posted = await api(worker, origin, cookie, "/api/posts", "POST", {
    content,
    visibility: "public",
  });
  need(
    posted.status === 201 || posted.status === 200,
    "native-persona-post-created",
    `${posted.status}`,
  );
  const post = (await posted.json()).post;
  need(
    post?.author?.ap_id === actor.ap_id || post?.attributed_to === actor.ap_id,
    "post-attributed-to-persona",
  );
  const back = await api(worker, origin, cookie, "/api/auth/switch", "POST", {
    ap_id: auth.actor.ap_id,
  });
  need(back.status === 200, "native-switch-back-to-owner", `${back.status}`);
  auth.cookie = cookieFrom(back);
  need(auth.cookie, "owner-session-restored");
  return post;
}

async function installRootCookie(context, parsed, cookie) {
  await context.addCookies([
    {
      name: "session",
      value: cookie,
      domain: parsed.hostname,
      path: "/",
      httpOnly: true,
      secure: parsed.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
}

async function navigateProfileSpa(page, actor) {
  const marker = randomUUID();
  const path = `/profile/${encodeURIComponent(actor.ap_id)}`;
  await page.evaluate(
    ({ path, marker }) => {
      window.__profileActionDocumentMarker = marker;
      const link = document.createElement("a");
      link.href = path;
      document.body.append(link);
      link.click();
      link.remove();
    },
    { path, marker },
  );
  await page.waitForURL((url) => url.pathname === path, { timeout: TIMEOUT });
  need(
    (await page.evaluate(() => window.__profileActionDocumentMarker)) ===
      marker,
    "spa-document-retained",
  );
  await page
    .getByText(actor.name, { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: TIMEOUT });
}

async function navigateHomeSpa(page) {
  await page.getByRole("link", { name: "ホーム" }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: TIMEOUT });
}

async function openModerationConfirmation(page, kind) {
  const action = kind === "block" ? "ブロック" : "ミュート";
  await page.getByRole("button", { name: "その他の操作" }).click();
  await page.getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
  return { dialog, action };
}

export async function qualifyProfileActionScope({
  browser,
  worker,
  db,
  origin,
  password,
  checks = [],
}) {
  need(
    browser && worker && db && Array.isArray(checks),
    "native-browser-db-required",
  );
  const parsed = new URL(origin);
  need(
    ["localhost", "127.0.0.1"].includes(parsed.hostname) &&
      parsed.origin === origin,
    "loopback-origin-only",
  );
  need(
    typeof password === "string" && password.length > 0,
    "ephemeral-password-required",
  );

  const auth = await login(worker, db, origin, password);
  const profileA = await createPersona(worker, origin, auth, "a");
  const profileB = await createPersona(worker, origin, auth, "b");
  const postA = await switchAndCreatePost(
    worker,
    origin,
    auth,
    profileA,
    `profile-action-a-${randomUUID()}`,
  );
  const postB = await switchAndCreatePost(
    worker,
    origin,
    auth,
    profileB,
    `profile-action-b-${randomUUID()}`,
  );
  const followA = await api(
    worker,
    origin,
    auth.cookie,
    "/api/follow",
    "POST",
    { target_ap_id: profileA.ap_id },
  );
  const followB = await api(
    worker,
    origin,
    auth.cookie,
    "/api/follow",
    "POST",
    { target_ap_id: profileB.ap_id },
  );
  need(
    followA.status === 200 && followB.status === 200,
    "native-owner-follows-seeded-post-authors",
    `${followA.status}/${followB.status}`,
  );
  const seed = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors WHERE role = 'owner') AS owners, (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM actor_cache) AS cached_actors",
    )
    .first();
  need(
    seed.owners === 1 &&
      seed.actors === 3 &&
      seed.sessions === 1 &&
      seed.cached_actors === 0,
    "one-owner-linked-personas-no-external-identities",
    JSON.stringify(seed),
  );
  const rootFollowB = await db
    .prepare(
      "SELECT status FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
    )
    .bind(auth.actor.ap_id, profileB.ap_id)
    .first();
  need(rootFollowB?.status === "accepted", "accepted-native-follow-b-seeded");

  const context = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 1100, height: 900 },
    serviceWorkers: "block",
  });
  const releases = [];
  const nativeMutations = [];
  const pageErrors = [];
  const unexpectedFiveHundreds = [];
  let syntheticFailureRequest;
  let outboundBlocked = 0;
  let primaryError;
  try {
    await installRootCookie(context, parsed, auth.cookie);
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["data:", "blob:"].includes(url.protocol))
        return route.continue();
      outboundBlocked++;
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.setDefaultNavigationTimeout(TIMEOUT);
    const timelineRequests = { all: 0, following: 0 };
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (path === "/api/timeline") timelineRequests.all++;
      if (path === "/api/timeline/following") timelineRequests.following++;
    });
    page.on("pageerror", (error) => pageErrors.push(error.name));
    page.on("response", (response) => {
      if (
        response.status() >= 500 &&
        response.request() !== syntheticFailureRequest
      )
        unexpectedFiveHundreds.push({
          status: response.status(),
          url: response.url(),
        });
    });
    await page.addInitScript(() => {
      window.__profileActionCalls = [];
      window.__profileActionResponses = [];
      const responseIds = new WeakMap();
      let nextId = 1;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const request = args[0] instanceof Request ? args[0] : null;
        const url = new URL(request?.url ?? String(args[0]), location.href);
        const method = String(
          args[1]?.method ?? request?.method ?? "GET",
        ).toUpperCase();
        const isAction =
          method === "POST" &&
          ["/api/actors/me/blocked", "/api/actors/me/muted"].includes(
            url.pathname,
          );
        let target = null;
        if (isAction) {
          try {
            const raw =
              args[1]?.body ?? (request ? await request.clone().text() : "");
            target = JSON.parse(raw).ap_id;
          } catch {}
        }
        const id = isAction ? nextId++ : null;
        if (id !== null)
          window.__profileActionCalls.push({
            id,
            method,
            path: url.pathname,
            target,
          });
        const response = await originalFetch(...args);
        if (id !== null) {
          responseIds.set(response, id);
          const bytes = await response.clone().arrayBuffer();
          const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          window.__profileActionResponses.push({
            id,
            status: response.status,
            bodySha256: digest,
          });
        }
        return response;
      };
      const originalJson = Response.prototype.json;
      Response.prototype.json = async function (...args) {
        const id = responseIds.get(this);
        const bytes = await this.clone().arrayBuffer();
        const result = await originalJson.apply(this, args);
        if (id !== undefined) {
          const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          window.__profileActionResponses.push({
            id,
            status: this.status,
            bodySha256: digest,
            consumed: true,
          });
        }
        return result;
      };
    });
    await page.goto(`${origin}/`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const allTab = page.getByRole("tab", { name: "すべて", exact: true });
    const followingTab = page.getByRole("tab", {
      name: "フォロー中",
      exact: true,
    });
    await page
      .getByText(postA.content, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await page
      .getByText(postB.content, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await followingTab.click();
    await page
      .getByText(postA.content, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await page
      .getByText(postB.content, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await allTab.click();
    const cachedFeedRequests = { ...timelineRequests };
    need(
      cachedFeedRequests.all > 0 && cachedFeedRequests.following > 0,
      "both-home-feeds-fetched-before-action",
      JSON.stringify(cachedFeedRequests),
    );
    await navigateProfileSpa(page, profileA);
    await page
      .getByText(profileA.name, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await page.getByRole("button", { name: "その他の操作" }).click();
    await page.getByRole("button", { name: "ブロック", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
    const entered = gate("native-block-committed-held");
    const release = gate("native-block-response-release");
    const delivered = gate("native-block-response-delivered");
    const blockCallStart = await page.evaluate(
      () => window.__profileActionCalls.length,
    );
    releases.push(release);
    const handler = async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/actors/me/blocked" ||
        handler.claimed
      )
        return route.fallback();
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        return route.fallback();
      }
      if (body?.ap_id !== profileA.ap_id) return route.fallback();
      handler.claimed = true;
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: TIMEOUT,
        });
        const bytes = await response.body();
        need(
          response.status() === 200,
          "native-block-succeeded",
          `${response.status()}`,
        );
        const block = await db
          .prepare(
            "SELECT blocked_ap_id FROM blocks WHERE blocker_ap_id = ? AND blocked_ap_id = ?",
          )
          .bind(auth.actor.ap_id, profileA.ap_id)
          .first();
        need(
          block?.blocked_ap_id === profileA.ap_id,
          "native-block-row-committed-before-hold",
        );
        const followAAfter = await db
          .prepare(
            "SELECT status FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
          )
          .bind(auth.actor.ap_id, profileA.ap_id)
          .first();
        const followBAfter = await db
          .prepare(
            "SELECT status FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
          )
          .bind(auth.actor.ap_id, profileB.ap_id)
          .first();
        need(
          !followAAfter && followBAfter?.status === "accepted",
          "native-block-severs-a-and-preserves-b-follow",
          JSON.stringify({ followAAfter, followBAfter }),
        );
        const bAndPostSnapshot = await db
          .prepare(
            "SELECT (SELECT following_count FROM actors WHERE ap_id = ?) AS owner_following, (SELECT follower_count FROM actors WHERE ap_id = ?) AS b_followers, (SELECT COUNT(*) FROM objects WHERE ap_id = ?) AS post_a_rows, (SELECT COUNT(*) FROM objects WHERE ap_id = ?) AS post_b_rows",
          )
          .bind(auth.actor.ap_id, profileB.ap_id, postA.ap_id, postB.ap_id)
          .first();
        need(
          bAndPostSnapshot.owner_following === 1 &&
            bAndPostSnapshot.b_followers === 1 &&
            bAndPostSnapshot.post_a_rows === 1 &&
            bAndPostSnapshot.post_b_rows === 1,
          "native-block-keeps-b-follow-count-and-a-b-post-rows",
          JSON.stringify(bAndPostSnapshot),
        );
        const record = {
          key: "block-a",
          method: request.method(),
          targetApId: profileA.ap_id,
          status: response.status(),
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
          length: bytes.length,
          source: "native-worker-route-fetch",
          databaseAtHold: {
            block,
            followA: followAAfter,
            followB: followBAfter,
            bAndPostSnapshot,
          },
        };
        nativeMutations.push(record);
        entered.resolve(record);
        await bounded(release.promise, "block-release");
        await route.fulfill({ response, body: bytes });
        delivered.resolve();
      } catch (error) {
        entered.reject(error);
        delivered.reject(error);
        await route.abort().catch(() => {});
      }
    };
    handler.claimed = false;
    await page.route("**/api/actors/me/blocked", handler);
    await dialog.getByRole("button", { name: "ブロック", exact: true }).click();
    const committed = await bounded(entered.promise, "native-block-commit");
    const call = await page.evaluate(
      ({ target, start }) =>
        window.__profileActionCalls
          .slice(start)
          .find(
            (item) =>
              item.target === target && item.path === "/api/actors/me/blocked",
          ) ?? null,
      { target: profileA.ap_id, start: blockCallStart },
    );
    need(call && Number.isInteger(call.id), "browser-native-action-correlated");
    await navigateProfileSpa(page, profileB);
    release.resolve();
    await bounded(delivered.promise, "native-block-delivery");
    await page.waitForFunction(
      ({ id, digest }) =>
        window.__profileActionResponses.some(
          (item) =>
            item.id === id && item.status === 200 && item.bodySha256 === digest,
        ),
      { id: call.id, digest: committed.bodySha256 },
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.unroute("**/api/actors/me/blocked", handler);
    need(
      await page
        .getByRole("button", { name: "フォロー解除", exact: true })
        .isVisible(),
      "profile-b-native-follow-still-visible-after-stale-block",
    );
    const staleToastCount = await page
      .getByRole("status")
      .getByText("ブロックしました", { exact: true })
      .count();
    need(
      staleToastCount === 0,
      "stale-block-success-has-no-toast-on-profile-b",
      JSON.stringify({ staleToastCount, call, committed }),
    );
    need(
      await page
        .getByRole("button", { name: "フォロー解除", exact: true })
        .isVisible(),
      "profile-b-native-follow-still-visible-after-stale-block",
    );
    need(
      (await page.getByText(postB.content, { exact: true }).count()) > 0,
      "profile-b-post-still-visible-before-home-navigation",
    );
    await navigateHomeSpa(page);
    need(
      (await page.getByText(postA.content, { exact: true }).count()) === 0,
      "stale-block-success-removes-a-from-cached-home-feed",
    );
    need(
      (await page.getByText(postB.content, { exact: true }).count()) > 0,
      "stale-block-success-keeps-b-in-cached-home-feed",
    );
    need(
      JSON.stringify(timelineRequests) === JSON.stringify(cachedFeedRequests),
      "cached-home-feed-check-does-not-refetch",
      JSON.stringify({ cachedFeedRequests, timelineRequests }),
    );
    await followingTab.click();
    need(
      (await page.getByText(postA.content, { exact: true }).count()) === 0,
      "stale-block-success-removes-a-from-cached-following-feed",
    );
    need(
      (await page.getByText(postB.content, { exact: true }).count()) > 0,
      "stale-block-success-keeps-b-in-cached-following-feed",
    );
    need(
      JSON.stringify(timelineRequests) === JSON.stringify(cachedFeedRequests),
      "cached-following-feed-check-does-not-refetch",
      JSON.stringify({ cachedFeedRequests, timelineRequests }),
    );
    await navigateProfileSpa(page, profileA);
    const muteConfirm = await openModerationConfirmation(page, "mute");
    const muteCallStart = await page.evaluate(
      () => window.__profileActionCalls.length,
    );
    const muteEntered = gate("native-mute-committed-held");
    const muteRelease = gate("native-mute-response-release");
    const muteDelivered = gate("native-mute-response-delivered");
    releases.push(muteRelease);
    const muteHandler = async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/actors/me/muted" ||
        muteHandler.claimed
      )
        return route.fallback();
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        return route.fallback();
      }
      if (body?.ap_id !== profileA.ap_id) return route.fallback();
      muteHandler.claimed = true;
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: TIMEOUT,
        });
        const bytes = await response.body();
        need(
          response.status() === 200,
          "native-mute-succeeded",
          `${response.status()}`,
        );
        const mute = await db
          .prepare(
            "SELECT muted_ap_id FROM mutes WHERE muter_ap_id = ? AND muted_ap_id = ?",
          )
          .bind(auth.actor.ap_id, profileA.ap_id)
          .first();
        need(
          mute?.muted_ap_id === profileA.ap_id,
          "native-mute-row-committed-before-hold",
        );
        const record = {
          key: "mute-a",
          method: request.method(),
          targetApId: profileA.ap_id,
          status: response.status(),
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
          length: bytes.length,
          source: "native-worker-route-fetch",
          databaseAtHold: { mute },
        };
        nativeMutations.push(record);
        muteEntered.resolve(record);
        await bounded(muteRelease.promise, "mute-release");
        await route.fulfill({ response, body: bytes });
        muteDelivered.resolve();
      } catch (error) {
        muteEntered.reject(error);
        muteDelivered.reject(error);
        await route.abort().catch(() => {});
      }
    };
    muteHandler.claimed = false;
    await page.route("**/api/actors/me/muted", muteHandler);
    await muteConfirm.dialog
      .getByRole("button", { name: "ミュート", exact: true })
      .click();
    const muteCommit = await bounded(muteEntered.promise, "native-mute-commit");
    const muteCall = await page.evaluate(
      ({ target, start }) =>
        window.__profileActionCalls
          .slice(start)
          .find(
            (item) =>
              item.path === "/api/actors/me/muted" && item.target === target,
          ) ?? null,
      { target: profileA.ap_id, start: muteCallStart },
    );
    need(
      muteCall && Number.isInteger(muteCall.id),
      "browser-native-mute-correlated",
    );
    await navigateProfileSpa(page, profileB);
    muteRelease.resolve();
    await bounded(muteDelivered.promise, "native-mute-delivery");
    await page.waitForFunction(
      ({ id, digest }) =>
        window.__profileActionResponses.some(
          (item) =>
            item.id === id && item.status === 200 && item.bodySha256 === digest,
        ),
      { id: muteCall.id, digest: muteCommit.bodySha256 },
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.unroute("**/api/actors/me/muted", muteHandler);
    const staleMuteToastCount = await page
      .getByRole("status")
      .getByText("ミュートしました", { exact: true })
      .count();
    need(
      staleMuteToastCount === 0,
      "stale-mute-success-has-no-toast-on-profile-b",
      JSON.stringify({ staleMuteToastCount, muteCall, muteCommit }),
    );

    await navigateProfileSpa(page, profileA);
    const abaOldConfirm = await openModerationConfirmation(page, "mute");
    const abaOldCallStart = await page.evaluate(
      () => window.__profileActionCalls.length,
    );
    const abaOldEntered = gate("native-mute-old-committed-held");
    const abaOldRelease = gate("native-mute-old-response-release");
    const abaOldDelivered = gate("native-mute-old-response-delivered");
    releases.push(abaOldRelease);
    const abaOldHandler = async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/actors/me/muted" ||
        abaOldHandler.claimed
      )
        return route.fallback();
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        return route.fallback();
      }
      if (body?.ap_id !== profileA.ap_id) return route.fallback();
      abaOldHandler.claimed = true;
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: TIMEOUT,
        });
        const bytes = await response.body();
        need(
          response.status() === 200,
          "native-aba-old-mute-succeeded",
          `${response.status()}`,
        );
        const mute = await db
          .prepare(
            "SELECT muted_ap_id FROM mutes WHERE muter_ap_id = ? AND muted_ap_id = ?",
          )
          .bind(auth.actor.ap_id, profileA.ap_id)
          .first();
        need(
          mute?.muted_ap_id === profileA.ap_id,
          "native-aba-old-mute-committed-before-hold",
        );
        const record = {
          key: "mute-a-aba-old",
          method: request.method(),
          targetApId: profileA.ap_id,
          status: response.status(),
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
          length: bytes.length,
          source: "native-worker-route-fetch",
          databaseAtHold: { mute },
        };
        nativeMutations.push(record);
        abaOldEntered.resolve(record);
        await bounded(abaOldRelease.promise, "aba-old-mute-release");
        await route.fulfill({ response, body: bytes });
        abaOldDelivered.resolve();
      } catch (error) {
        abaOldEntered.reject(error);
        abaOldDelivered.reject(error);
        await route.abort().catch(() => {});
      }
    };
    abaOldHandler.claimed = false;
    await page.route("**/api/actors/me/muted", abaOldHandler);
    await abaOldConfirm.dialog
      .getByRole("button", { name: "ミュート", exact: true })
      .click();
    const abaOldCommit = await bounded(
      abaOldEntered.promise,
      "aba-old-native-mute-commit",
    );
    const abaOldCall = await page.evaluate(
      ({ target, start }) =>
        window.__profileActionCalls
          .slice(start)
          .find(
            (item) =>
              item.path === "/api/actors/me/muted" && item.target === target,
          ) ?? null,
      { target: profileA.ap_id, start: abaOldCallStart },
    );
    need(
      abaOldCall && Number.isInteger(abaOldCall.id),
      "aba-old-mute-browser-call-correlated",
    );
    await navigateProfileSpa(page, profileB);
    await navigateProfileSpa(page, profileA);
    abaOldRelease.resolve();
    await bounded(abaOldDelivered.promise, "aba-old-mute-delivery");
    await page.waitForFunction(
      ({ id, digest }) =>
        window.__profileActionResponses.some(
          (item) =>
            item.id === id && item.status === 200 && item.bodySha256 === digest,
        ),
      { id: abaOldCall.id, digest: abaOldCommit.bodySha256 },
      { timeout: TIMEOUT },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.unroute("**/api/actors/me/muted", abaOldHandler);
    need(
      (await page
        .getByRole("status")
        .getByText("ミュートしました", { exact: true })
        .count()) === 0,
      "aba-old-completion-has-no-toast-on-revisited-a",
    );
    await api(worker, origin, auth.cookie, "/api/actors/me/muted", "DELETE", {
      ap_id: profileA.ap_id,
    });
    const abaFreshConfirm = await openModerationConfirmation(page, "mute");
    const abaFreshCallStart = await page.evaluate(
      () => window.__profileActionCalls.length,
    );
    const abaFreshEntered = gate("native-mute-fresh-committed-held");
    const abaFreshRelease = gate("native-mute-fresh-response-release");
    const abaFreshDelivered = gate("native-mute-fresh-response-delivered");
    releases.push(abaFreshRelease);
    const abaFreshHandler = async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/actors/me/muted" ||
        abaFreshHandler.claimed
      )
        return route.fallback();
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        return route.fallback();
      }
      if (body?.ap_id !== profileA.ap_id) return route.fallback();
      abaFreshHandler.claimed = true;
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: TIMEOUT,
        });
        const bytes = await response.body();
        need(
          response.status() === 200,
          "native-aba-fresh-mute-succeeded",
          `${response.status()}`,
        );
        const mute = await db
          .prepare(
            "SELECT muted_ap_id FROM mutes WHERE muter_ap_id = ? AND muted_ap_id = ?",
          )
          .bind(auth.actor.ap_id, profileA.ap_id)
          .first();
        need(
          mute?.muted_ap_id === profileA.ap_id,
          "native-aba-fresh-mute-committed-before-hold",
        );
        const record = {
          key: "mute-a-aba-fresh",
          method: request.method(),
          targetApId: profileA.ap_id,
          status: response.status(),
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
          length: bytes.length,
          source: "native-worker-route-fetch",
          databaseAtHold: { mute },
        };
        nativeMutations.push(record);
        abaFreshEntered.resolve(record);
        await bounded(abaFreshRelease.promise, "aba-fresh-mute-release");
        await route.fulfill({ response, body: bytes });
        abaFreshDelivered.resolve();
      } catch (error) {
        abaFreshEntered.reject(error);
        abaFreshDelivered.reject(error);
        await route.abort().catch(() => {});
      }
    };
    abaFreshHandler.claimed = false;
    await page.route("**/api/actors/me/muted", abaFreshHandler);
    await abaFreshConfirm.dialog
      .getByRole("button", { name: "ミュート", exact: true })
      .click();
    const abaFreshCommit = await bounded(
      abaFreshEntered.promise,
      "aba-fresh-native-mute-commit",
    );
    const abaFreshCall = await page.evaluate(
      ({ target, start }) =>
        window.__profileActionCalls
          .slice(start)
          .find(
            (item) =>
              item.path === "/api/actors/me/muted" && item.target === target,
          ) ?? null,
      { target: profileA.ap_id, start: abaFreshCallStart },
    );
    need(
      abaFreshCall && Number.isInteger(abaFreshCall.id),
      "aba-fresh-mute-browser-call-correlated",
    );
    abaFreshRelease.resolve();
    await bounded(abaFreshDelivered.promise, "aba-fresh-mute-delivery");
    await page.waitForFunction(
      ({ id, digest }) =>
        window.__profileActionResponses.some(
          (item) =>
            item.id === id && item.status === 200 && item.bodySha256 === digest,
        ),
      { id: abaFreshCall.id, digest: abaFreshCommit.bodySha256 },
      { timeout: TIMEOUT },
    );
    await page.unroute("**/api/actors/me/muted", abaFreshHandler);
    await page
      .getByRole("status")
      .getByText("ミュートしました", { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (
        await db
          .prepare(
            "SELECT muted_ap_id FROM mutes WHERE muter_ap_id = ? AND muted_ap_id = ?",
          )
          .bind(auth.actor.ap_id, profileA.ap_id)
          .first()
      )?.muted_ap_id === profileA.ap_id,
      "aba-fresh-native-mute-remains-committed",
    );
    need(
      await page.getByRole("button", { name: "その他の操作" }).isVisible(),
      "aba-fresh-current-profile-remains-rendered",
    );
    await navigateProfileSpa(page, profileA);
    const failedMuteConfirm = await openModerationConfirmation(page, "mute");
    const failureCallStart = await page.evaluate(
      () => window.__profileActionCalls.length,
    );
    const failureEntered = gate("synthetic-failure-native-request-captured");
    const failureRelease = gate("synthetic-failure-response-release");
    const failureDelivered = gate("synthetic-failure-response-delivered");
    releases.push(failureRelease);
    const syntheticFailure = {
      status: 503,
      body: Buffer.from(
        JSON.stringify({
          error: "profile-action-scope synthetic stale failure",
        }),
      ),
    };
    const failureHandler = async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/actors/me/muted" ||
        failureHandler.claimed
      )
        return route.fallback();
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        return route.fallback();
      }
      if (body?.ap_id !== profileA.ap_id) return route.fallback();
      failureHandler.claimed = true;
      syntheticFailureRequest = request;
      const record = {
        key: "synthetic-mute-failure-a",
        targetApId: profileA.ap_id,
        status: syntheticFailure.status,
        bodySha256: createHash("sha256")
          .update(syntheticFailure.body)
          .digest("hex"),
        length: syntheticFailure.body.length,
        source: "fixture-synthetic-labeled-not-native",
        databaseAtHold: await db
          .prepare(
            "SELECT COUNT(*) AS count FROM mutes WHERE muter_ap_id = ? AND muted_ap_id = ?",
          )
          .bind(auth.actor.ap_id, profileA.ap_id)
          .first(),
      };
      nativeMutations.push(record);
      failureEntered.resolve(record);
      await bounded(failureRelease.promise, "synthetic-failure-release");
      await route.fulfill({
        status: syntheticFailure.status,
        contentType: "application/json",
        body: syntheticFailure.body,
      });
      failureDelivered.resolve();
    };
    failureHandler.claimed = false;
    await page.route("**/api/actors/me/muted", failureHandler);
    await failedMuteConfirm.dialog
      .getByRole("button", { name: "ミュート", exact: true })
      .click();
    const failureCommit = await bounded(
      failureEntered.promise,
      "synthetic-failure-captured",
    );
    const failureCall = await page.evaluate(
      ({ target, start }) =>
        window.__profileActionCalls
          .slice(start)
          .find(
            (item) =>
              item.path === "/api/actors/me/muted" && item.target === target,
          ) ?? null,
      { target: profileA.ap_id, start: failureCallStart },
    );
    need(
      failureCall && Number.isInteger(failureCall.id),
      "synthetic-failure-browser-action-correlated",
    );
    need(
      failureCommit.source === "fixture-synthetic-labeled-not-native",
      "synthetic-failure-explicitly-labeled",
    );
    await navigateProfileSpa(page, profileB);
    failureRelease.resolve();
    await bounded(failureDelivered.promise, "synthetic-failure-delivery");
    await page.waitForFunction(
      ({ id, digest }) =>
        window.__profileActionResponses.some(
          (item) =>
            item.id === id && item.status === 503 && item.bodySha256 === digest,
        ),
      { id: failureCall.id, digest: failureCommit.bodySha256 },
      { timeout: TIMEOUT },
    );
    const syntheticProbe = await page.evaluate(
      (id) =>
        window.__profileActionResponses.find((item) => item.id === id) ?? null,
      failureCall.id,
    );
    need(
      syntheticProbe?.status === 503 &&
        syntheticProbe.bodySha256 === failureCommit.bodySha256,
      "synthetic-503-response-probe-exactly-correlated",
      JSON.stringify({ syntheticProbe, failureCommit }),
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.unroute("**/api/actors/me/muted", failureHandler);
    const staleMuteFailureCount = await page
      .getByRole("alert")
      .getByText("ミュートに失敗しました", { exact: true })
      .count();
    need(
      staleMuteFailureCount === 0,
      "synthetic-stale-mute-failure-has-no-toast-on-profile-b",
      JSON.stringify({ staleMuteFailureCount, failureCall, failureCommit }),
    );
    need(
      outboundBlocked === 0 &&
        pageErrors.length === 0 &&
        unexpectedFiveHundreds.length === 0,
      "no-outbound-page-error-or-http-5xx",
      JSON.stringify({ outboundBlocked, pageErrors, unexpectedFiveHundreds }),
    );
    checks.push(
      "profile-action-block-native-commit-held-across-spa-profile-change",
      "profile-action-stale-success-does-not-toast-on-profile-b",
      "profile-action-block-severs-a-and-preserves-b-native-follow",
      "profile-action-block-preserves-b-follow-count-and-a-b-post-rows",
      "profile-action-stale-block-filters-a-from-both-cached-home-feeds-without-refetch",
      "profile-action-stale-mute-success-does-not-toast-on-profile-b",
      "profile-action-mute-aba-old-completion-is-retired-and-current-result-applies",
      "profile-action-mute-aba-fresh-current-a-completion-shows-toast",
      "profile-action-synthetic-labeled-mute-failure-does-not-toast-on-profile-b",
      "profile-action-held-response-digest-matches-native-worker-bytes",
      "profile-action-fixture-one-owner-two-linked-personas-no-external-identities",
    );
    return {
      status: "PASSED",
      ownerApId: auth.actor.ap_id,
      profiles: { a: profileA.ap_id, b: profileB.ap_id },
      posts: { a: postA.ap_id ?? postA.id, b: postB.ap_id ?? postB.id },
      seededAuthority: {
        owners: seed.owners,
        localActors: seed.actors,
        sessions: seed.sessions,
        cachedExternalActors: seed.cached_actors,
        personasOwnerApId: auth.actor.ap_id,
      },
      nativeMutations,
      browserActionCalls: [
        call,
        muteCall,
        abaOldCall,
        abaFreshCall,
        failureCall,
      ],
      deliveredResponseProbes: await page.evaluate(
        (calls) =>
          calls.map((call) => ({
            id: call.id,
            path: call.path,
            target: call.target,
            response:
              window.__profileActionResponses.find(
                (response) => response.id === call.id,
              ) ?? null,
          })),
        [call, muteCall, abaOldCall, abaFreshCall, failureCall],
      ),
      cachedFeedRequests,
      finalFeedRequests: timelineRequests,
      outboundBlocked,
      pageErrors,
      unexpectedFiveHundreds,
      checks,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    for (const release of releases) release.resolve();
    try {
      await context.close();
    } catch (error) {
      if (!primaryError) throw error;
    }
  }
}
