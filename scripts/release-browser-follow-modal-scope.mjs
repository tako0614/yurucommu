// Native-browser qualification for profile follow-list modal request epochs.
// Successful GET bodies always come from the disposable Native Worker via route.fetch().

import { createHash, randomUUID } from "node:crypto";

const TIMEOUT = 15_000;

function need(condition, label, detail = "") {
  if (!condition)
    throw new Error(`follow-modal-scope:${label}${detail ? ` ${detail}` : ""}`);
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
          () => reject(new Error(`follow-modal-scope:${label}-timeout`)),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sessionId(salt, cookie) {
  return `sha256:${createHash("sha256").update(`${salt}:${cookie}`).digest("hex")}`;
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

async function login(worker, db, origin, password, salt) {
  const before = await db
    .prepare("SELECT ap_id, role FROM actors ORDER BY ap_id")
    .all();
  need(
    (before.results ?? []).length <= 1,
    "fixture-refuses-multiple-seeded-owners",
  );
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
  need(cookie, "root-session-cookie");
  const actor = (
    await (await api(worker, origin, cookie, "/api/auth/me")).json()
  ).actor;
  need(
    actor?.role === "owner" && new URL(actor.ap_id).origin === origin,
    "root-owner-session",
  );
  const exact = sessionId(salt, cookie);
  const row = await db
    .prepare("SELECT id, member_id FROM sessions WHERE id = ?")
    .bind(exact)
    .first();
  need(
    row?.id === exact && row.member_id === actor.ap_id,
    "native-exact-salted-session",
  );
  return { actor, cookie, exactSessionId: exact };
}

async function createPersona(worker, db, origin, auth, name) {
  const username = `follow_modal_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const response = await api(
    worker,
    origin,
    auth.cookie,
    "/api/auth/accounts",
    "POST",
    { username, name },
  );
  need(
    response.status === 201 || response.status === 200,
    "owner-api-creates-linked-profile",
    `${response.status}`,
  );
  const actor = (await response.json()).account;
  need(actor?.ap_id === `${origin}/ap/users/${username}`, "persona-ap-id");
  const row = await db
    .prepare("SELECT role, owner_actor_ap_id FROM actors WHERE ap_id = ?")
    .bind(actor.ap_id)
    .first();
  need(
    row?.role === "member" && row.owner_actor_ap_id === auth.actor.ap_id,
    "persona-native-owner-link",
  );
  return actor;
}

function listPath(actor, type, offset = 0) {
  return `/api/actors/${encodeURIComponent(actor.ap_id)}/${type}?limit=50${offset ? `&offset=${offset}` : ""}`;
}

async function seedRelations(
  db,
  target,
  direction,
  count,
  prefix,
  extras = [],
  allowSharedEdges = false,
) {
  const now = new Date().toISOString();
  const peers = Array.from({ length: count }, (_, index) => {
    const username = `${prefix}_${String(index).padStart(2, "0")}`;
    const apId = `https://${username}.example.test/ap/users/${username}`;
    const actor = {
      id: apId,
      type: "Person",
      preferredUsername: username,
      name: `${prefix} person ${index}`,
      inbox: `${apId}/inbox`,
      outbox: `${apId}/outbox`,
      followers: `${apId}/followers`,
      following: `${apId}/following`,
    };
    return { apId, actor };
  });
  const all = [
    ...peers,
    ...extras.map((actor) => ({
      apId: actor.ap_id,
      actor: {
        id: actor.ap_id,
        type: "Person",
        preferredUsername: actor.username,
        name: actor.name,
        inbox: `${actor.ap_id}/inbox`,
        outbox: `${actor.ap_id}/outbox`,
        followers: `${actor.ap_id}/followers`,
        following: `${actor.ap_id}/following`,
      },
    })),
  ];
  for (const peer of all) {
    const username = peer.actor.preferredUsername;
    if (peer.apId.startsWith("https://")) {
      await db
        .prepare(
          "INSERT INTO actor_cache (ap_id, preferred_username, name, inbox, outbox, followers_url, following_url, raw_json, last_fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          peer.apId,
          username,
          peer.actor.name,
          peer.actor.inbox,
          peer.actor.outbox,
          peer.actor.followers,
          peer.actor.following,
          JSON.stringify(peer.actor),
          now,
        )
        .run();
    }
    const follower = direction === "followers" ? peer.apId : target.ap_id;
    const following = direction === "followers" ? target.ap_id : peer.apId;
    const createdAt = peers.includes(peer)
      ? new Date(
          Date.now() + (peers.length - peers.indexOf(peer)) * 1000,
        ).toISOString()
      : new Date(Date.now() + 60_000).toISOString();
    const sharedExtra = extras.some((actor) => actor.ap_id === peer.apId);
    const insert = db.prepare(
      `${allowSharedEdges && sharedExtra ? "INSERT OR IGNORE" : "INSERT"} INTO follows (follower_ap_id, following_ap_id, status, created_at, accepted_at) VALUES (?, ?, 'accepted', ?, ?)`,
    );
    await insert.bind(follower, following, createdAt, createdAt).run();
  }
  return [
    ...extras.map((actor) => actor.ap_id),
    ...peers.map((peer) => peer.apId),
  ];
}

async function navigateViaProfileModal(page, from, to) {
  const dialog = await openModal(page, "followers");
  const link = dialog.locator(
    `a[href="/profile/${encodeURIComponent(to.ap_id)}"]`,
  );
  await link.waitFor({ state: "visible", timeout: TIMEOUT });
  await link.click();
  await page
    .getByText(to.name, { exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  await page
    .getByText(from.name, { exact: true })
    .waitFor({ state: "detached", timeout: TIMEOUT })
    .catch(() => {});
}

async function navigateProfileSpa(page, actor) {
  // A held head has no rendered actor links. Use the router's delegated
  // anchor handler without replacing the document or releasing that read.
  const marker = randomUUID();
  const path = `/profile/${encodeURIComponent(actor.ap_id)}`;
  await page.evaluate(
    ({ path, marker }) => {
      window.__followModalDocumentMarker = marker;
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
    (await page.evaluate(() => window.__followModalDocumentMarker)) === marker,
    "held-read-navigation-remains-in-same-spa-document",
  );
  await page
    .getByText(actor.name, { exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT });
}

async function openModal(page, type, expectedName) {
  const label = type === "followers" ? "フォロワー" : "フォロー中";
  const stat = page.locator("button").filter({ hasText: label });
  await stat.first().click();
  const dialog = page.getByRole("dialog", { name: label, exact: true });
  await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
  if (expectedName)
    await dialog
      .getByText(expectedName, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
  return dialog;
}

async function twoFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

export async function qualifyFollowModalScope({
  browser,
  worker,
  db,
  origin,
  password,
  sessionSalt,
  checks = [],
}) {
  need(
    browser && worker && db && Array.isArray(checks),
    "browser-worker-native-db-and-checks-required",
  );
  const parsed = new URL(origin);
  need(
    ["localhost", "127.0.0.1"].includes(parsed.hostname) &&
      parsed.origin === origin,
    "loopback-origin-only",
  );
  need(
    typeof password === "string" &&
      password.length > 0 &&
      typeof sessionSalt === "string" &&
      sessionSalt.length > 0,
    "ephemeral-credentials-required",
  );
  const auth = await login(worker, db, origin, password, sessionSalt);
  const profileA = await createPersona(
    worker,
    db,
    origin,
    auth,
    "Follow Modal Profile A",
  );
  const profileB = await createPersona(
    worker,
    db,
    origin,
    auth,
    "Follow Modal Profile B",
  );
  const expected = new Map();
  expected.set(
    `${profileA.ap_id}:followers:0`,
    await seedRelations(
      db,
      profileA,
      "followers",
      51,
      `fm_af_${randomUUID().slice(0, 7)}`,
      [profileB],
    ),
  );
  expected.set(
    `${profileA.ap_id}:following:0`,
    await seedRelations(
      db,
      profileA,
      "following",
      51,
      `fm_ag_${randomUUID().slice(0, 7)}`,
      [profileB],
    ),
  );
  expected.set(
    `${profileB.ap_id}:followers:0`,
    await seedRelations(
      db,
      profileB,
      "followers",
      2,
      `fm_bf_${randomUUID().slice(0, 7)}`,
      [profileA],
      true,
    ),
  );
  expected.set(
    `${profileB.ap_id}:following:0`,
    await seedRelations(
      db,
      profileB,
      "following",
      2,
      `fm_bg_${randomUUID().slice(0, 7)}`,
      [profileA],
      true,
    ),
  );

  const counts = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM follows WHERE status = 'accepted') AS accepted_edges",
    )
    .first();
  need(
    counts.actors === 3 &&
      counts.sessions === 1 &&
      counts.accepted_edges === 108,
    "only-root-and-two-linked-personas-and-native-edges",
    JSON.stringify(counts),
  );
  const actorCacheCount = await db
    .prepare("SELECT COUNT(*) AS count FROM actor_cache")
    .first();
  need(
    actorCacheCount.count === 106,
    "exact-remote-actor-cache-seed-count",
    JSON.stringify(actorCacheCount),
  );
  const context = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 1100, height: 900 },
    serviceWorkers: "block",
  });
  let primaryError;
  let outboundBlocked = 0;
  const releases = [];
  try {
    await context.addCookies([
      {
        name: "session",
        value: auth.cookie,
        domain: parsed.hostname,
        path: "/",
        httpOnly: true,
        secure: parsed.protocol === "https:",
        sameSite: "Lax",
      },
    ]);
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["data:", "blob:"].includes(url.protocol))
        return route.continue();
      outboundBlocked++;
      return route.abort("blockedbyclient");
    });
    await context.route("**/api/actors/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() !== "GET" ||
        !/^\/api\/actors\/.*\/(followers|following)$/.test(url.pathname)
      )
        return route.fallback();
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: TIMEOUT,
        });
        const bytes = await response.body();
        nativeReads.push({
          path: `${url.pathname}${url.search}`,
          status: response.status(),
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
          length: bytes.length,
          source: "native-worker-route-fetch",
        });
        await route.fulfill({ response, body: bytes });
      } catch (error) {
        await route.abort().catch(() => {});
        throw error;
      }
    });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await context.addInitScript(() => {
      window.__followModalCalls = [];
      window.__followModalConsumed = [];
      let nextId = 1;
      const responseIds = new WeakMap();
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const request = args[0] instanceof Request ? args[0] : null;
        const url = new URL(request?.url ?? String(args[0]), location.href);
        const method = String(
          args[1]?.method ?? request?.method ?? "GET",
        ).toUpperCase();
        const isFollowRead =
          method === "GET" &&
          /^\/api\/actors\/.*\/(followers|following)$/.test(url.pathname);
        const id = isFollowRead ? nextId++ : null;
        if (id !== null)
          window.__followModalCalls.push({
            id,
            url: `${url.pathname}${url.search}`,
          });
        const response = await originalFetch(...args);
        if (id !== null) responseIds.set(response, id);
        return response;
      };
      for (const method of ["json", "text"]) {
        const original = Response.prototype[method];
        Response.prototype[method] = async function (...args) {
          const id = responseIds.get(this);
          const response = this.clone();
          const result = await original.apply(this, args);
          if (id !== undefined) {
            const bytes = await response.arrayBuffer();
            const digest = Array.from(
              new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
              (b) => b.toString(16).padStart(2, "0"),
            ).join("");
            window.__followModalConsumed.push({
              id,
              status: this.status,
              bodySha256: digest,
              method,
            });
          }
          return result;
        };
      }
    });
    const nativeReads = [];
    const pending = new Map();
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (
        url.origin !== origin ||
        !/^\/api\/actors\/.*\/(followers|following)$/.test(url.pathname) ||
        response.request().method() !== "GET"
      )
        return;
      try {
        const bytes = await response.body();
        nativeReads.push({
          path: `${url.pathname}${url.search}`,
          status: response.status(),
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
          length: bytes.length,
          source: "browser-delivery",
        });
      } catch {
        nativeReads.push({
          path: `${url.pathname}${url.search}`,
          status: response.status(),
          bodySha256: null,
          length: 0,
          source: "browser-delivery",
        });
      }
    });
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    await page.locator("main").waitFor({ state: "visible", timeout: TIMEOUT });
    const identity = await page.evaluate(async () => {
      const r = await fetch("/api/auth/me", { credentials: "include" });
      const b = await r.json();
      return { status: r.status, actor: b.actor };
    });
    need(
      identity.status === 200 &&
        identity.actor?.ap_id === auth.actor.ap_id &&
        identity.actor.role === "owner",
      "browser-uses-same-root-session",
    );
    await page.goto(`${origin}/profile/${encodeURIComponent(profileA.ap_id)}`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    await page
      .getByText(profileA.name, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });

    const holdNative = async (route, key, entered, release, delivered) => {
      const request = route.request();
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: TIMEOUT,
        });
        const bytes = await response.body();
        need(
          response.status() === 200,
          `${key}-native-worker-success`,
          `${response.status()}`,
        );
        const body = JSON.parse(bytes.toString("utf8"));
        const type = new URL(request.url()).pathname.endsWith("/followers")
          ? "followers"
          : "following";
        const targetApId = decodeURIComponent(
          new URL(request.url()).pathname.split("/").at(-2),
        );
        const offset = new URL(request.url()).searchParams.get("offset") ?? "0";
        need(Array.isArray(body[type]), `${key}-native-list-shape`);
        if (offset === "0") {
          const expectedIds = expected.get(`${targetApId}:${type}:0`);
          need(
            expectedIds &&
              body[type].length === Math.min(50, expectedIds.length) &&
              body.total === expectedIds.length &&
              body.has_more === expectedIds.length > 50,
            `${key}-native-D1-seed-contract`,
            JSON.stringify({
              ids: body[type]?.map((item) => item.ap_id),
              total: body.total,
              hasMore: body.has_more,
              expected: expectedIds?.length,
            }),
          );
        } else {
          const expectedIds = expected.get(`${targetApId}:${type}:0`);
          const pageOffset = Number(offset);
          need(
            expectedIds &&
              Number.isSafeInteger(pageOffset) &&
              pageOffset > 0 &&
              body[type].length ===
                Math.max(0, Math.min(50, expectedIds.length - pageOffset)) &&
              body.total === expectedIds.length &&
              body.has_more ===
                pageOffset + body[type].length < expectedIds.length &&
              body[type].every(
                (item, index) => item.ap_id === expectedIds[pageOffset + index],
              ),
            `${key}-native-pagination-contract`,
            JSON.stringify({
              ids: body[type]?.map((item) => item.ap_id),
              total: body.total,
              hasMore: body.has_more,
              offset: pageOffset,
              expected: expectedIds?.length,
            }),
          );
        }
        pending.set(key, {
          url: request.url(),
          status: response.status(),
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
          itemIds: body[type].map((item) => item.ap_id),
          hasMore: body.has_more,
          total: body.total,
        });
        nativeReads.push({
          path: `${new URL(request.url()).pathname}${new URL(request.url()).search}`,
          status: response.status(),
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
          length: bytes.length,
          source: "held-native-worker-route-fetch",
        });
        entered.resolve(pending.get(key));
        await bounded(release.promise, `${key}-release`);
        await route.fulfill({ response, body: bytes });
        delivered.resolve();
      } catch (error) {
        entered.reject(error);
        delivered.reject(error);
        await route.abort().catch(() => {});
      }
    };
    const installHeld = async (actor, type, offset, key) => {
      const path = listPath(actor, type, offset);
      const callStart = await page.evaluate(
        () => window.__followModalCalls.length,
      );
      const entered = gate(`${key}-native-captured`),
        release = gate(`${key}-release`),
        delivered = gate(`${key}-delivered`);
      releases.push(release);
      const handler = (route) => {
        const url = new URL(route.request().url());
        if (`${url.pathname}${url.search}` !== path || handler.claimed)
          return route.fallback();
        handler.claimed = true;
        return holdNative(route, key, entered, release, delivered);
      };
      handler.claimed = false;
      await page.route("**/api/actors/**", handler);
      return {
        path,
        key,
        entered,
        release,
        delivered,
        handler,
        callStart,
        callId: null,
      };
    };
    const pinCall = async (lane) => {
      lane.callId = await page.evaluate(
        ({ start, path }) =>
          window.__followModalCalls
            .slice(start)
            .find((call) => call.url === path)?.id ?? null,
        { start: lane.callStart, path: lane.path },
      );
      need(
        Number.isInteger(lane.callId),
        "specific-follow-list-fetch-call-was-issued",
        lane.path,
      );
      lane.expectedDigest = pending.get(lane.key)?.bodySha256 ?? null;
      need(
        lane.expectedDigest,
        "specific-call-native-response-digest-pinned",
        lane.path,
      );
    };
    const consumeExact = async (lane, expectedStatus, label) => {
      await page.waitForFunction(
        ({ id, status, digest }) =>
          window.__followModalConsumed.some(
            (event) =>
              event.id === id &&
              event.status === status &&
              (!digest || event.bodySha256 === digest),
          ),
        {
          id: lane.callId,
          status: expectedStatus,
          digest: lane.expectedDigest ?? null,
        },
        { timeout: TIMEOUT },
      );
      await twoFrames(page);
    };
    const verifyLoading = async (dialog, key) => {
      await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
      need(
        (await dialog.getByText("読み込み中...", { exact: true }).count()) ===
          1,
        `${key}-retired-response-cannot-settle-current-loading`,
        await dialog.innerText(),
      );
      need(
        (await dialog.getByText("もっと見る", { exact: true }).count()) === 0,
        `${key}-new-loading-control-remains-active`,
      );
      need(
        await dialog
          .getByRole("button", { name: "閉じる", exact: true })
          .isEnabled(),
        `${key}-dialog-remains-usable`,
      );
    };
    const releaseAndObserve = async (lane, dialog, label) => {
      lane.release.resolve();
      await bounded(
        lane.delivered.promise,
        `${label}-browser-response-delivered`,
      );
      await consumeExact(lane, 200, label);
      await page.unroute("**/api/actors/**", lane.handler);
      await twoFrames(page);
      need(
        (await dialog.getByText("読み込み中...", { exact: true }).count()) ===
          0,
        `${label}-loading-settled`,
      );
    };

    // Cross profile/type: an older A/followers head cannot replace B/following.
    const oldCross = await installHeld(
      profileA,
      "followers",
      0,
      "a-followers-to-b-following-old",
    );
    let dialogA = await openModal(page, "followers");
    await bounded(oldCross.entered.promise, "a-followers-native-held");
    await pinCall(oldCross);
    await navigateProfileSpa(page, profileB);
    const freshCross = await installHeld(
      profileB,
      "following",
      0,
      "b-following-fresh",
    );
    let dialogB = await openModal(page, "following");
    await bounded(freshCross.entered.promise, "b-following-native-held");
    await pinCall(freshCross);
    oldCross.release.resolve();
    await bounded(oldCross.delivered.promise, "old-cross-consumed");
    await consumeExact(oldCross, 200, "old-cross-response");
    await page.unroute("**/api/actors/**", oldCross.handler);
    await verifyLoading(dialogB, "late-old-type-profile-response");
    await releaseAndObserve(freshCross, dialogB, "fresh-b-following");
    need(
      (await dialogB.locator("a").count()) === 3,
      "fresh-b-following-native-rows-visible",
    );
    await page.getByRole("button", { name: "閉じる", exact: true }).click();

    // Closed -> reopened same type: old success cannot replace or settle new head.
    await navigateViaProfileModal(page, profileB, profileA);
    const oldReopen = await installHeld(
      profileA,
      "followers",
      0,
      "a-followers-closed-old",
    );
    dialogA = await openModal(page, "followers");
    await bounded(oldReopen.entered.promise, "old-reopen-native-held");
    await pinCall(oldReopen);
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    const freshReopen = await installHeld(
      profileA,
      "followers",
      0,
      "a-followers-reopened-fresh",
    );
    dialogA = await openModal(page, "followers");
    await bounded(freshReopen.entered.promise, "fresh-reopen-native-held");
    await pinCall(freshReopen);
    oldReopen.release.resolve();
    await bounded(oldReopen.delivered.promise, "old-reopen-consumed");
    await consumeExact(oldReopen, 200, "old-reopen-response");
    await page.unroute("**/api/actors/**", oldReopen.handler);
    await verifyLoading(dialogA, "closed-reopened-same-type-old-finally");
    await releaseAndObserve(freshReopen, dialogA, "reopened-followers");
    need(
      (await dialogA.locator("a").count()) === 50,
      "reopened-followers-first-page-visible",
    );
    await page.getByRole("button", { name: "閉じる", exact: true }).click();

    // SPA A -> B -> A: the same actor/type key still has a distinct request epoch.
    const oldABA = await installHeld(
      profileA,
      "followers",
      0,
      "a-followers-aba-old",
    );
    dialogA = await openModal(page, "followers");
    await bounded(oldABA.entered.promise, "aba-old-native-held");
    await pinCall(oldABA);
    await navigateProfileSpa(page, profileB);
    await openModal(page, "followers");
    await navigateProfileSpa(page, profileA);
    const freshABA = await installHeld(
      profileA,
      "followers",
      0,
      "a-followers-aba-fresh",
    );
    dialogA = await openModal(page, "followers");
    await bounded(freshABA.entered.promise, "aba-fresh-native-held");
    await pinCall(freshABA);
    oldABA.release.resolve();
    await bounded(oldABA.delivered.promise, "aba-old-consumed");
    await consumeExact(oldABA, 200, "old-aba-response");
    await page.unroute("**/api/actors/**", oldABA.handler);
    await verifyLoading(dialogA, "aba-old-finally-cannot-clear-fresh-loading");
    await releaseAndObserve(freshABA, dialogA, "aba-fresh-followers");
    need(
      (await dialogA.locator("a").count()) === 50,
      "aba-fresh-first-page-visible",
    );
    // Old pagination response/finally cannot replace a reopened new head window.
    const oldPage = await installHeld(
      profileA,
      "followers",
      50,
      "a-followers-offset-50-old",
    );
    await page.getByRole("button", { name: "もっと見る", exact: true }).click();
    await bounded(oldPage.entered.promise, "old-pagination-native-held");
    await pinCall(oldPage);
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    const newHead = await installHeld(
      profileA,
      "followers",
      0,
      "a-followers-new-window",
    );
    const newDialog = await openModal(page, "followers");
    await bounded(newHead.entered.promise, "new-window-native-held");
    await pinCall(newHead);
    await releaseAndObserve(newHead, newDialog, "new-followers-head");
    need(
      (await newDialog.locator("a").count()) === 50,
      "new-followers-head-has-only-head-rows",
    );
    const freshPage = await installHeld(
      profileA,
      "followers",
      50,
      "a-followers-offset-50-fresh",
    );
    await newDialog
      .getByRole("button", { name: "もっと見る", exact: true })
      .click();
    await bounded(freshPage.entered.promise, "fresh-pagination-native-held");
    await pinCall(freshPage);
    oldPage.release.resolve();
    await bounded(oldPage.delivered.promise, "old-pagination-consumed");
    await consumeExact(oldPage, 200, "old-pagination-response");
    await page.unroute("**/api/actors/**", oldPage.handler);
    need(
      (await newDialog.locator("a").count()) === 50,
      "old-pagination-cannot-append-into-reopened-list",
    );
    const currentMore = newDialog.getByRole("button", {
      name: "読み込み中...",
      exact: true,
    });
    need(
      (await currentMore.count()) === 1 && (await currentMore.isDisabled()),
      "old-pagination-finally-cannot-release-new-pagination-busy",
    );
    await releaseAndObserve(freshPage, newDialog, "fresh-followers-pagination");
    need(
      (await newDialog.locator("a").count()) === 52 &&
        (await newDialog
          .getByRole("button", { name: "もっと見る", exact: true })
          .count()) === 0,
      "fresh-pagination-adds-native-tail-once-and-settles",
    );
    await page.getByRole("button", { name: "閉じる", exact: true }).click();

    // A delayed synthetic 503/finally from a retired first-page request cannot
    // clear a new window. The retry itself is a fresh, successful native GET.
    const failPath = listPath(profileA, "following", 0);
    const failureReady = gate("old synthetic failure is pending"),
      failureRelease = gate("old synthetic failure release");
    releases.push(failureRelease);
    const failHandler = async (route) => {
      if (
        `${new URL(route.request().url()).pathname}${new URL(route.request().url()).search}` !==
        failPath
      )
        return route.fallback();
      failureReady.resolve();
      await bounded(failureRelease.promise, "old-503-release");
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture-only-old-window-failure" }),
      });
    };
    await page.route("**/api/actors/**", failHandler);
    const failedCallStart = await page.evaluate(
      () => window.__followModalCalls.length,
    );
    await openModal(page, "following");
    await bounded(failureReady.promise, "old-503-reached-real-browser-route");
    await navigateProfileSpa(page, profileB);
    const freshAfterFail = await installHeld(
      profileB,
      "followers",
      0,
      "b-followers-after-old-503",
    );
    const failureReplacementDialog = await openModal(page, "followers");
    await bounded(
      freshAfterFail.entered.promise,
      "fresh-after-503-native-held",
    );
    await pinCall(freshAfterFail);
    failureRelease.resolve();
    await page.unroute("**/api/actors/**", failHandler);
    const oldFailureCall = await page.evaluate(
      ({ start, path }) =>
        window.__followModalCalls.slice(start).find((call) => call.url === path)
          ?.id ?? null,
      { start: failedCallStart, path: failPath },
    );
    need(Number.isInteger(oldFailureCall), "retired-503-fetch-call-correlated");
    await page.waitForFunction(
      (id) =>
        window.__followModalConsumed.some(
          (event) =>
            event.id === id && event.status === 503 && event.method === "json",
        ),
      oldFailureCall,
      { timeout: TIMEOUT },
    );
    await twoFrames(page);
    await verifyLoading(
      failureReplacementDialog,
      "old-503-finally-cannot-clear-new-window",
    );
    await releaseAndObserve(
      freshAfterFail,
      failureReplacementDialog,
      "b-followers-after-503",
    );
    need(
      (await failureReplacementDialog.locator("a").count()) === 3,
      "fresh-profile-results-after-stale-503",
    );
    await page.getByRole("button", { name: "閉じる", exact: true }).click();

    // Ordinary retry proves that the actual retry action issues a fresh GET;
    // only this error response is synthetic and no server/API contract is changed.
    await navigateViaProfileModal(page, profileB, profileA);
    let retryFailures = 0;
    const retryFailHandler = async (route) => {
      if (
        `${new URL(route.request().url()).pathname}${new URL(route.request().url()).search}` !==
        failPath
      )
        return route.fallback();
      retryFailures++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture-only-retry-trigger" }),
      });
    };
    await page.route("**/api/actors/**", retryFailHandler);
    const retryCallStart = await page.evaluate(
      () => window.__followModalCalls.length,
    );
    dialogA = await openModal(page, "following");
    await dialogA
      .getByText("読み込みに失敗しました", { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(retryFailures === 1, "retry-trigger-is-one-scoped-synthetic-503");
    const retryFailureCall = await page.evaluate(
      ({ start, path }) =>
        window.__followModalCalls.slice(start).find((call) => call.url === path)
          ?.id ?? null,
      { start: retryCallStart, path: failPath },
    );
    need(
      Number.isInteger(retryFailureCall),
      "retry-trigger-correlates-to-exact-fetch-call",
    );
    await page.waitForFunction(
      (id) =>
        window.__followModalConsumed.some(
          (event) =>
            event.id === id && event.status === 503 && event.method === "json",
        ),
      retryFailureCall,
      { timeout: TIMEOUT },
    );
    await twoFrames(page);
    await dialogA
      .getByText("読み込みに失敗しました", { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      await dialogA
        .getByRole("button", { name: "再試行", exact: true })
        .isEnabled(),
      "retry-error-state-remains-usable",
    );
    await page.unroute("**/api/actors/**", retryFailHandler);
    const retry = await installHeld(
      profileA,
      "following",
      0,
      "a-following-retry-native",
    );
    await dialogA.getByRole("button", { name: "再試行", exact: true }).click();
    await bounded(retry.entered.promise, "retry-is-real-native-get");
    await pinCall(retry);
    await verifyLoading(dialogA, "retry-new-request-window-loading");
    await releaseAndObserve(retry, dialogA, "retry-following");
    need(
      (await dialogA.locator("a").count()) === 50,
      "retry-native-following-results-visible",
    );

    await Promise.all([...pending.values()].map(() => Promise.resolve()));
    await twoFrames(page);
    const successfulNativeReads = nativeReads.filter(
      (read) => read.status === 200,
    );
    need(
      successfulNativeReads.length >= 7 &&
        successfulNativeReads.every((read) =>
          /^[a-f0-9]{64}$/.test(read.bodySha256),
        ),
      "all-successful-list-gets-native-worker-bytes-captured",
      JSON.stringify(nativeReads),
    );
    need(
      outboundBlocked === 0 && pageErrors.length === 0,
      "no-unexpected-outbound-or-page-errors",
      JSON.stringify({ outboundBlocked, pageErrors, consoleErrors }),
    );
    const finalCounts = await db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM actors WHERE role = 'owner') AS owners, (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
      )
      .first();
    need(
      finalCounts.owners === 1 &&
        finalCounts.actors === 3 &&
        finalCounts.sessions === 1,
      "final-authority-boundary-unchanged",
      JSON.stringify(finalCounts),
    );
    checks.push(
      "follow-modal-old-head-cannot-cross-profile-or-type",
      "follow-modal-close-reopen-and-spa-aba-retire-old-request-epochs",
      "follow-modal-old-pagination-cannot-append-or-release-new-pagination-busy",
      "follow-modal-stale-503-finally-cannot-clear-new-profile-window",
      "follow-modal-explicit-retry-uses-fresh-native-list-read",
    );
    return {
      status: "PASSED",
      ownerApId: auth.actor.ap_id,
      profiles: { a: profileA.ap_id, b: profileB.ap_id },
      seededAuthority: {
        owners: finalCounts.owners,
        localActors: finalCounts.actors,
        sessions: finalCounts.sessions,
        acceptedNativeEdges: counts.accepted_edges,
        remoteActorCacheRows: actorCacheCount.count,
      },
      heldNativeReads: [...pending.entries()].map(([key, value]) => ({
        key,
        ...value,
      })),
      syntheticFailures: {
        delayedRetiredWindow503: 1,
        retryTrigger503: retryFailures,
      },
      nativeReads,
      outboundBlocked,
      pageErrors,
      consoleErrors,
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
