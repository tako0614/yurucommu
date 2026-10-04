// Native-browser qualification for ProfilePage follow/unfollow request epochs.
// Mutations are forwarded to the disposable Native Worker; only their exact
// native response bytes are held while the SPA changes profile ownership.

import { createHash, randomUUID } from "node:crypto";

const TIMEOUT = 15_000;

function need(condition, label, detail = "") {
  if (!condition)
    throw new Error(
      `profile-follow-scope:${label}${detail ? ` ${detail}` : ""}`,
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
          () => reject(new Error(`profile-follow-scope:${label}-timeout`)),
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
  return { actor, cookie, exactSessionId: exact, sessionSalt: salt };
}

async function createPersona(worker, origin, auth, name) {
  const username = `profile_follow_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
  const db = await worker.getD1Database("DB");
  const row = await db
    .prepare("SELECT role, owner_actor_ap_id FROM actors WHERE ap_id = ?")
    .bind(actor.ap_id)
    .first();
  need(
    row?.role === "member" && row.owner_actor_ap_id === auth.actor.ap_id,
    "persona-is-owner-linked-native-member",
  );
  return actor;
}

async function edgeState(db, ownerApId, targetApId) {
  const edge = await db
    .prepare(
      "SELECT status, accepted_at FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
    )
    .bind(ownerApId, targetApId)
    .first();
  const counts = await db
    .prepare(
      "SELECT (SELECT following_count FROM actors WHERE ap_id = ?) AS owner_following, (SELECT follower_count FROM actors WHERE ap_id = ?) AS target_followers",
    )
    .bind(ownerApId, targetApId)
    .first();
  return {
    edge: edge ? { status: edge.status, acceptedAt: edge.accepted_at } : null,
    ownerFollowing: counts?.owner_following,
    targetFollowers: counts?.target_followers,
  };
}

async function setPersonaPrivate(worker, origin, auth, targetApId, isPrivate) {
  const switched = await api(
    worker,
    origin,
    auth.cookie,
    "/api/auth/switch",
    "POST",
    { ap_id: targetApId },
  );
  need(
    switched.status === 200,
    "native-api-switches-to-owned-persona",
    `${switched.status}`,
  );
  const personaCookie = cookieFrom(switched);
  need(personaCookie, "persona-switch-rotates-session-cookie");
  auth.cookie = personaCookie;
  const updated = await api(
    worker,
    origin,
    auth.cookie,
    "/api/actors/me",
    "PUT",
    {
      is_private: isPrivate,
    },
  );
  need(
    updated.status === 200,
    "native-api-updates-persona-privacy",
    `${updated.status}`,
  );
  const switchedBack = await api(
    worker,
    origin,
    auth.cookie,
    "/api/auth/switch",
    "POST",
    { ap_id: auth.actor.ap_id },
  );
  need(
    switchedBack.status === 200,
    "native-api-restores-root-owner-session",
    `${switchedBack.status}`,
  );
  const rootCookie = cookieFrom(switchedBack);
  need(rootCookie, "owner-switch-back-rotates-session-cookie");
  auth.cookie = rootCookie;
  auth.exactSessionId = sessionId(auth.sessionSalt, rootCookie);
  auth.rotatedSessionCount = (auth.rotatedSessionCount ?? 0) + 2;
  const db = await worker.getD1Database("DB");
  const row = await db
    .prepare("SELECT is_private FROM actors WHERE ap_id = ?")
    .bind(targetApId)
    .first();
  need(
    row?.is_private === (isPrivate ? 1 : 0),
    "native-persona-privacy-persisted",
  );
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
      window.__profileFollowDocumentMarker = marker;
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
    (await page.evaluate(() => window.__profileFollowDocumentMarker)) ===
      marker,
    "profile-change-kept-same-spa-document",
  );
  await page.getByText(actor.name, { exact: true }).waitFor({
    state: "visible",
    timeout: TIMEOUT,
  });
}

async function twoFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

export async function qualifyProfileFollowScope({
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
    "native-browser-db-required",
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
    origin,
    auth,
    "Profile Follow Scope A",
  );
  const profileB = await createPersona(
    worker,
    origin,
    auth,
    "Profile Follow Scope B",
  );
  await setPersonaPrivate(worker, origin, auth, profileA.ap_id, true);
  const seedCounts = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM actors WHERE role = 'owner') AS owners",
    )
    .first();
  need(
    seedCounts.actors === 3 &&
      seedCounts.sessions === 1 &&
      seedCounts.owners === 1,
    "only-root-and-two-owner-linked-personas-seeded",
    JSON.stringify(seedCounts),
  );

  const context = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 1100, height: 900 },
    serviceWorkers: "block",
  });
  const releases = [];
  const mutations = [];
  const calls = [];
  let primaryError;
  let outboundBlocked = 0;
  const pageErrors = [];
  const unexpectedFiveHundreds = [];
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
    page.on("pageerror", (error) => pageErrors.push(error.name));
    page.on("response", (response) => {
      if (response.status() >= 500)
        unexpectedFiveHundreds.push({
          status: response.status(),
          url: response.url(),
        });
    });
    await page.addInitScript(() => {
      window.__profileFollowCalls = [];
      window.__profileFollowReceived = [];
      window.__profileFollowConsumed = [];
      let nextId = 1;
      const responseIds = new WeakMap();
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const request = args[0] instanceof Request ? args[0] : null;
        const url = new URL(request?.url ?? String(args[0]), location.href);
        const method = String(
          args[1]?.method ?? request?.method ?? "GET",
        ).toUpperCase();
        const isMutation = method !== "GET" && url.pathname === "/api/follow";
        const id = isMutation ? nextId++ : null;
        if (id !== null) {
          let target = null;
          try {
            const body = args[1]?.body;
            if (typeof body === "string")
              target = JSON.parse(body).target_ap_id;
            else if (request)
              target = JSON.parse(await request.clone().text()).target_ap_id;
          } catch {}
          window.__profileFollowCalls.push({ id, method, target });
        }
        const response = await originalFetch(...args);
        if (id !== null) {
          responseIds.set(response, id);
          const responseCopy = response.clone();
          void responseCopy.arrayBuffer().then(async (bytes) => {
            const digest = Array.from(
              new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
              (b) => b.toString(16).padStart(2, "0"),
            ).join("");
            window.__profileFollowReceived.push({
              id,
              status: response.status,
              bodySha256: digest,
            });
          });
        }
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
            window.__profileFollowConsumed.push({
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
    page.on("request", (request) => {
      if (
        request.method() !== "GET" &&
        new URL(request.url()).pathname === "/api/follow"
      ) {
        try {
          calls.push({ method: request.method(), ...request.postDataJSON() });
        } catch {}
      }
    });
    await page.goto(`${origin}/profile/${encodeURIComponent(profileA.ap_id)}`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const identity = await page.evaluate(async () => {
      const response = await fetch("/api/auth/me", { credentials: "include" });
      const body = await response.json();
      return { status: response.status, actor: body.actor };
    });
    need(
      identity.status === 200 &&
        identity.actor?.ap_id === auth.actor.ap_id &&
        identity.actor.role === "owner",
      "browser-uses-same-root-owner-session",
    );
    await page.getByText(profileA.name, { exact: true }).waitFor({
      state: "visible",
      timeout: TIMEOUT,
    });

    const installHeld = async (
      method,
      target,
      key,
      expectedFollowStatus = "accepted",
    ) => {
      const entered = gate(`${key}-native-committed-held`);
      const release = gate(`${key}-native-response-release`);
      const delivered = gate(`${key}-response-delivered`);
      releases.push(release);
      const handler = async (route) => {
        const request = route.request();
        if (
          request.method() !== method ||
          new URL(request.url()).pathname !== "/api/follow"
        )
          return route.fallback();
        let body;
        try {
          body = request.postDataJSON();
        } catch {
          return route.fallback();
        }
        if (body?.target_ap_id !== target || handler.claimed)
          return route.fallback();
        handler.claimed = true;
        try {
          const response = await route.fetch({
            maxRedirects: 0,
            timeout: TIMEOUT,
          });
          const bytes = await response.body();
          const bodyJson =
            method === "POST" ? JSON.parse(bytes.toString("utf8")) : null;
          need(
            response.status() === 200,
            `${key}-native-worker-accepted-response`,
            `${response.status()}`,
          );
          if (method === "POST")
            need(
              bodyJson.status === expectedFollowStatus,
              `${key}-native-worker-follow-status`,
              JSON.stringify(bodyJson),
            );
          const database = await edgeState(db, auth.actor.ap_id, target);
          if (method === "POST") {
            need(
              database.edge?.status === expectedFollowStatus &&
                (expectedFollowStatus === "pending"
                  ? !database.edge.acceptedAt
                  : database.edge.acceptedAt),
              `${key}-native-follow-edge-committed`,
              JSON.stringify(database),
            );
          } else {
            need(
              database.edge === null,
              `${key}-native-unfollow-committed`,
              JSON.stringify(database),
            );
          }
          const record = {
            key,
            method,
            targetApId: target,
            status: response.status(),
            bodySha256: createHash("sha256").update(bytes).digest("hex"),
            length: bytes.length,
            source: "native-worker-route-fetch",
            databaseAtHold: database,
          };
          mutations.push(record);
          entered.resolve(record);
          await bounded(release.promise, `${key}-release`);
          await route.fulfill({ response, body: bytes });
          delivered.resolve();
        } catch (error) {
          entered.reject(error);
          delivered.reject(error);
          await route.abort().catch(() => {});
        }
      };
      handler.claimed = false;
      await page.route("**/api/follow", handler);
      const callStart = await page.evaluate(
        () => window.__profileFollowCalls.length,
      );
      return {
        key,
        method,
        target,
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
        ({ start, method, target }) =>
          window.__profileFollowCalls
            .slice(start)
            .find((call) => call.method === method && call.target === target)
            ?.id ?? null,
        { start: lane.callStart, method: lane.method, target: lane.target },
      );
      need(
        Number.isInteger(lane.callId),
        "specific-profile-follow-call-correlated",
        lane.key,
      );
      const native = mutations.find((item) => item.key === lane.key);
      need(
        native && /^[a-f0-9]{64}$/.test(native.bodySha256),
        "exact-native-response-digest-pinned",
        lane.key,
      );
      lane.expectedDigest = native.bodySha256;
    };
    const consumeExact = async (lane) => {
      await page.waitForFunction(
        ({ id, status, digest }) =>
          window.__profileFollowReceived.some(
            (event) =>
              event.id === id &&
              event.status === status &&
              event.bodySha256 === digest,
          ),
        { id: lane.callId, status: 200, digest: lane.expectedDigest },
        { timeout: TIMEOUT },
      );
      if (lane.method === "POST") {
        await page.waitForFunction(
          ({ id, status, digest }) =>
            window.__profileFollowConsumed.some(
              (event) =>
                event.id === id &&
                event.status === status &&
                event.bodySha256 === digest &&
                event.method === "json",
            ),
          { id: lane.callId, status: 200, digest: lane.expectedDigest },
          { timeout: TIMEOUT },
        );
      }
      await twoFrames(page);
    };
    const releaseAndObserve = async (lane) => {
      lane.release.resolve();
      await bounded(lane.delivered.promise, `${lane.key}-delivered`);
      await consumeExact(lane);
      await page.unroute("**/api/follow", lane.handler);
    };
    const followButton = (actor) =>
      page.getByRole("button", { name: "フォロー", exact: true });
    const unfollowButton = () =>
      page.getByRole("button", { name: "フォロー解除", exact: true });
    const toastCount = (text) => page.getByText(text, { exact: true }).count();

    // A's private POST commits as a pending request while held. B starts its own POST; settling A
    // must not show A's toast or release B's still-active duplicate guard.
    const oldA = await installHeld(
      "POST",
      profileA.ap_id,
      "a-follow-to-b-follow",
      "pending",
    );
    await followButton(profileA).click();
    await bounded(oldA.entered.promise, "old-a-follow-is-native-committed");
    await pinCall(oldA);
    need(
      oldA.target === profileA.ap_id,
      "a-private-follow-status-is-pending-lane",
    );
    await navigateProfileSpa(page, profileB);
    const freshB = await installHeld(
      "POST",
      profileB.ap_id,
      "b-current-follow",
    );
    const bButton = followButton(profileB);
    need(await bButton.isEnabled(), "current-b-follow-button-starts-enabled");
    await bButton.evaluate((button) => button.click());
    await twoFrames(page);
    need(
      calls.some(
        (call) =>
          call.method === "POST" && call.target_ap_id === profileB.ap_id,
      ),
      "new-route-b-follow-not-blocked-by-retired-a-busy",
      JSON.stringify({ nativeA: mutations[0], browserCalls: calls }),
    );
    await bounded(freshB.entered.promise, "b-follow-is-native-committed");
    need(
      await bButton.isDisabled(),
      "current-b-follow-button-disabled-during-request",
    );
    await pinCall(freshB);
    oldA.release.resolve();
    await bounded(oldA.delivered.promise, "old-a-follow-delivered");
    await consumeExact(oldA);
    await page.unroute("**/api/follow", oldA.handler);
    need(
      (await toastCount("申請中")) === 0,
      "stale-a-pending-success-has-no-request-toast-on-b",
    );
    need(
      await bButton.isDisabled(),
      "stale-a-finally-keeps-current-b-button-disabled",
    );
    await bButton.evaluate((button) => button.click());
    await twoFrames(page);
    need(
      calls.filter(
        (call) =>
          call.method === "POST" && call.target_ap_id === profileB.ap_id,
      ).length === 1,
      "stale-a-finally-preserves-b-action-busy-guard",
      JSON.stringify(calls),
    );
    const pendingA = await edgeState(db, auth.actor.ap_id, profileA.ap_id);
    need(
      pendingA.edge?.status === "pending" &&
        pendingA.ownerFollowing === 1 &&
        pendingA.targetFollowers === 0,
      "pending-follow-remains-unaccepted-and-count-neutral",
      JSON.stringify(pendingA),
    );
    await releaseAndObserve(freshB);
    await unfollowButton().waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await toastCount("フォローしました")) === 1,
      "only-current-b-success-shows-follow-toast",
    );

    // The pending A edge is real D1 state. A second browser POST must receive
    // the native duplicate refusal; hold it over a profile navigation so its
    // exact status/body can be tied to the stale request epoch.
    const duplicateEntered = gate("native pending duplicate refusal captured");
    const duplicateRelease = gate("native pending duplicate refusal release");
    const duplicateDelivered = gate(
      "native pending duplicate refusal delivered",
    );
    releases.push(duplicateRelease);
    let duplicateRefusal;
    const duplicateHandler = async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/follow"
      )
        return route.fallback();
      const body = request.postDataJSON();
      if (body?.target_ap_id !== profileA.ap_id) return route.fallback();
      const response = await route.fetch({ maxRedirects: 0, timeout: TIMEOUT });
      const bytes = await response.body();
      const bodyJson = JSON.parse(bytes.toString("utf8"));
      need(
        response.status() === 400,
        "native-pending-duplicate-is-refused",
        `${response.status()}`,
      );
      need(
        /already following or pending/i.test(bodyJson.error ?? ""),
        "native-pending-refusal-body-identifies-duplicate",
        JSON.stringify(bodyJson),
      );
      const database = await edgeState(db, auth.actor.ap_id, profileA.ap_id);
      need(
        database.edge?.status === "pending" &&
          database.ownerFollowing === 1 &&
          database.targetFollowers === 0,
        "duplicate-refusal-keeps-pending-edge-and-accepted-counts",
        JSON.stringify(database),
      );
      duplicateRefusal = {
        method: "POST",
        targetApId: profileA.ap_id,
        status: response.status(),
        bodySha256: createHash("sha256").update(bytes).digest("hex"),
        length: bytes.length,
        source: "native-worker-route-fetch",
        databaseAtHold: database,
      };
      duplicateEntered.resolve();
      await bounded(
        duplicateRelease.promise,
        "native-pending-duplicate-release",
      );
      await route.fulfill({ response, body: bytes });
      duplicateDelivered.resolve();
    };
    await page.route("**/api/follow", duplicateHandler);
    const duplicateCallStart = await page.evaluate(
      () => window.__profileFollowCalls.length,
    );
    await navigateProfileSpa(page, profileA);
    const aRetryButton = followButton(profileA);
    need(
      await aRetryButton.isEnabled(),
      "cold-profile-pending-edge-is-not-optimistically-hydrated",
    );
    await aRetryButton.click();
    await bounded(duplicateEntered.promise, "native-duplicate-refusal-held");
    const duplicateCallId = await page.evaluate(
      ({ start, target }) =>
        window.__profileFollowCalls
          .slice(start)
          .find((call) => call.method === "POST" && call.target === target)
          ?.id ?? null,
      { start: duplicateCallStart, target: profileA.ap_id },
    );
    need(
      Number.isInteger(duplicateCallId),
      "native-duplicate-browser-fetch-correlated",
    );
    await navigateProfileSpa(page, profileB);
    duplicateRelease.resolve();
    await bounded(
      duplicateDelivered.promise,
      "native-duplicate-refusal-delivered",
    );
    await page.waitForFunction(
      ({ id, digest }) =>
        window.__profileFollowConsumed.some(
          (event) =>
            event.id === id &&
            event.status === 400 &&
            event.bodySha256 === digest &&
            event.method === "json",
        ),
      { id: duplicateCallId, digest: duplicateRefusal.bodySha256 },
      { timeout: TIMEOUT },
    );
    await twoFrames(page);
    await page.unroute("**/api/follow", duplicateHandler);
    need(
      (await page
        .getByRole("alert")
        .getByText("操作に失敗しました", { exact: true })
        .count()) === 0,
      "native-duplicate-refusal-does-not-toast-from-retired-profile",
    );
    const stalePendingDelete = await api(
      worker,
      origin,
      auth.cookie,
      "/api/follow",
      "DELETE",
      {
        target_ap_id: profileA.ap_id,
      },
    );
    need(
      stalePendingDelete.status === 200,
      "native-cleanup-removes-retired-pending-edge",
      `${stalePendingDelete.status}`,
    );
    await navigateProfileSpa(page, profileB);
    await navigateProfileSpa(page, profileA);
    // A current, non-retired native pending response must set the local
    // Requested state. The earlier stale pending response is intentionally
    // ignored, and profile reads do not hydrate followPending.
    const currentPending = await installHeld(
      "POST",
      profileA.ap_id,
      "a-current-private-pending",
      "pending",
    );
    await followButton(profileA).click();
    await bounded(
      currentPending.entered.promise,
      "current-pending-native-committed",
    );
    await pinCall(currentPending);
    await releaseAndObserve(currentPending);
    const pendingButton = page.getByRole("button", {
      name: "申請中",
      exact: true,
    });
    need(
      await pendingButton.isDisabled(),
      "native-pending-edge-renders-disabled-requested-state",
    );
    const pendingFollowerStat = page
      .getByRole("button")
      .filter({ hasText: "フォロワー" });
    need(
      /^0\s*フォロワー$/.test((await pendingFollowerStat.innerText()).trim()),
      "native-pending-edge-keeps-profile-follower-count-zero",
    );
    const currentPendingDb = await edgeState(
      db,
      auth.actor.ap_id,
      profileA.ap_id,
    );
    need(
      currentPendingDb.edge?.status === "pending" &&
        currentPendingDb.ownerFollowing === 1 &&
        currentPendingDb.targetFollowers === 0,
      "current-pending-ui-matches-native-edge-and-accepted-counts",
      JSON.stringify(currentPendingDb),
    );
    const currentPendingDelete = await api(
      worker,
      origin,
      auth.cookie,
      "/api/follow",
      "DELETE",
      {
        target_ap_id: profileA.ap_id,
      },
    );
    need(
      currentPendingDelete.status === 200,
      "native-cleanup-removes-current-pending-edge",
      `${currentPendingDelete.status}`,
    );
    await setPersonaPrivate(worker, origin, auth, profileA.ap_id, false);
    await installRootCookie(context, parsed, auth.cookie);
    const seedAcceptedA = await api(
      worker,
      origin,
      auth.cookie,
      "/api/follow",
      "POST",
      {
        target_ap_id: profileA.ap_id,
      },
    );
    need(
      seedAcceptedA.status === 200,
      "native-api-seeds-accepted-a-edge-for-unfollow-lane",
      `${seedAcceptedA.status}`,
    );
    need(
      (await seedAcceptedA.json()).status === "accepted",
      "accepted-a-seed-status",
    );
    await navigateProfileSpa(page, profileB);
    await navigateProfileSpa(page, profileA);
    await unfollowButton().waitFor({ state: "visible", timeout: TIMEOUT });

    // A -> B -> A with a held native DELETE followed by a fresh native POST.
    // The old unfollow completion must not undo the new A state or clear busy.
    const oldUnfollowA = await installHeld(
      "DELETE",
      profileA.ap_id,
      "a-unfollow-aba-old",
    );
    await navigateProfileSpa(page, profileA);
    await unfollowButton().waitFor({ state: "visible", timeout: TIMEOUT });
    await unfollowButton().click();
    await bounded(oldUnfollowA.entered.promise, "a-unfollow-native-committed");
    await pinCall(oldUnfollowA);
    await navigateProfileSpa(page, profileB);
    await navigateProfileSpa(page, profileA);
    const freshA = await installHeld(
      "POST",
      profileA.ap_id,
      "a-follow-aba-fresh",
      "accepted",
    );
    const freshAButton = followButton(profileA);
    need(
      await freshAButton.isEnabled(),
      "fresh-a-follow-button-starts-enabled",
    );
    await freshAButton.evaluate((button) => button.click());
    await bounded(freshA.entered.promise, "fresh-a-follow-native-committed");
    need(
      await freshAButton.isDisabled(),
      "fresh-a-follow-button-disabled-during-request",
    );
    await pinCall(freshA);
    oldUnfollowA.release.resolve();
    await bounded(oldUnfollowA.delivered.promise, "old-a-unfollow-delivered");
    await consumeExact(oldUnfollowA);
    await page.unroute("**/api/follow", oldUnfollowA.handler);
    await followButton(profileA).waitFor({
      state: "visible",
      timeout: TIMEOUT,
    });
    need(
      (await toastCount("フォローを解除しました")) === 0,
      "stale-a-unfollow-has-no-unfollow-toast-after-aba",
    );
    const abaFreshButton = followButton(profileA);
    need(
      await abaFreshButton.isDisabled(),
      "aba-fresh-a-follow-button-remains-disabled",
    );
    await abaFreshButton.evaluate((button) => button.click());
    await twoFrames(page);
    need(
      calls.filter(
        (call) =>
          call.method === "POST" && call.target_ap_id === profileA.ap_id,
      ).length === 4,
      "aba-stale-unfollow-finally-preserves-fresh-a-busy-guard",
      JSON.stringify(calls),
    );
    const whilePending = await edgeState(db, auth.actor.ap_id, profileA.ap_id);
    need(
      whilePending.edge?.status === "accepted" &&
        whilePending.ownerFollowing === 2 &&
        whilePending.targetFollowers === 1,
      "accepted-counts-reflect-committed-fresh-a-follow-before-response-release",
      JSON.stringify(whilePending),
    );
    await releaseAndObserve(freshA);
    await unfollowButton().waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await toastCount("フォローしました")) >= 1,
      "fresh-a-follow-has-current-success-toast",
    );

    const finalA = await edgeState(db, auth.actor.ap_id, profileA.ap_id);
    const finalB = await edgeState(db, auth.actor.ap_id, profileB.ap_id);
    need(
      finalA.edge?.status === "accepted" &&
        finalB.edge?.status === "accepted" &&
        finalA.ownerFollowing === 2 &&
        finalB.ownerFollowing === 2 &&
        finalA.targetFollowers === 1 &&
        finalB.targetFollowers === 1,
      "final-native-edges-and-accepted-counts-match-ui",
      JSON.stringify({ a: finalA, b: finalB }),
    );
    need(
      outboundBlocked === 0 &&
        pageErrors.length === 0 &&
        unexpectedFiveHundreds.length === 0,
      "profile-follow-no-external-page-error-or-http-5xx",
      JSON.stringify({ outboundBlocked, pageErrors, unexpectedFiveHundreds }),
    );
    need(
      outboundBlocked === 0,
      "profile-follow-fixture-blocked-no-external-requests",
      JSON.stringify({ outboundBlocked }),
    );

    checks.push(
      "profile-follow-stale-a-success-cannot-toast-or-clear-b-busy",
      "profile-follow-a-to-b-to-a-stale-unfollow-cannot-override-fresh-follow",
      "profile-follow-native-pending-duplicate-refused-400-without-count-change",
      "profile-follow-pending-ui-stays-count-neutral-and-accepted-d1-counts-match",
      "profile-follow-held-response-digests-match-native-worker-bytes",
      "profile-follow-fixture-seeds-one-owner-two-linked-personas-and-no-external-requests",
    );
    return {
      status: "PASSED",
      ownerApId: auth.actor.ap_id,
      profiles: { a: profileA.ap_id, b: profileB.ap_id },
      seededAuthority: {
        owners: seedCounts.owners,
        localActors: seedCounts.actors,
        sessions: seedCounts.sessions,
        personasOwnerApId: auth.actor.ap_id,
      },
      nativeMutations: mutations,
      nativeDuplicateRefusal: duplicateRefusal,
      finalDatabase: { a: finalA, b: finalB },
      interceptedBrowserCalls: calls,
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
