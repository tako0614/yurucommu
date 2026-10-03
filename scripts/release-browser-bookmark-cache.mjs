import { createHash, randomUUID } from "node:crypto";

const TIMEOUT = 15_000;

function need(value, label) {
  if (!value) throw new Error(`bookmark-cache:${label}`);
}

function sessionId(salt, rawCookie) {
  return `sha256:${createHash("sha256").update(`${salt}:${rawCookie}`).digest("hex")}`;
}

async function loginWithPassword(worker, db, origin, password, salt) {
  const beforeActors = await db
    .prepare("SELECT ap_id, role FROM actors ORDER BY ap_id")
    .all();
  const beforeSessions = await db
    .prepare("SELECT id, member_id, expires_at FROM sessions ORDER BY id")
    .all();
  need(
    (beforeActors.results ?? []).length <= 1,
    "fixture-refuses-multiple-owners",
  );
  const response = await worker.dispatchFetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password }),
  });
  need(response.status === 200, `owner-password-login-${response.status}`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const rawCookie = /(?:^|,\s*)session=([^;,]+)/i.exec(setCookie)?.[1];
  need(rawCookie, "password-login-issued-session-cookie");
  const me = await worker.dispatchFetch(`${origin}/api/auth/me`, {
    headers: { cookie: `session=${rawCookie}` },
  });
  need(me.status === 200, "issued-cookie-authenticates");
  const body = await me.json();
  const actor = body.actor;
  need(
    actor?.role === "owner" && new URL(actor.ap_id).origin === origin,
    "single-local-owner-authenticated",
  );
  const afterActors = await db
    .prepare(
      "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
    )
    .all();
  need(
    (afterActors.results ?? []).length === 1 &&
      afterActors.results[0].ap_id === actor.ap_id &&
      afterActors.results[0].role === "owner" &&
      afterActors.results[0].owner_actor_ap_id == null &&
      afterActors.results[0].deleted_at == null,
    "one-human-owner-preserved",
  );
  const exactSessionId = sessionId(salt, rawCookie);
  const issued = await db
    .prepare("SELECT id, member_id, expires_at FROM sessions WHERE id = ?")
    .bind(exactSessionId)
    .first();
  need(
    issued?.id === exactSessionId &&
      issued.member_id === actor.ap_id &&
      Date.parse(issued.expires_at) > Date.now(),
    "exact-salted-issued-session-readback",
  );
  const afterSessions = await db
    .prepare("SELECT id, member_id, expires_at FROM sessions ORDER BY id")
    .all();
  const beforeIds = new Set(
    (beforeSessions.results ?? []).map((row) => row.id),
  );
  const afterPriorSessions = (afterSessions.results ?? []).filter((row) =>
    beforeIds.has(row.id),
  );
  need(
    JSON.stringify(afterPriorSessions) ===
      JSON.stringify(beforeSessions.results ?? []),
    "preexisting-session-rows-unchanged",
  );
  return {
    actor,
    rawCookie,
    exactSessionId,
    issued,
    priorSessionRows: beforeSessions.results ?? [],
  };
}

async function createNote(page, content) {
  await page.getByRole("button", { name: "投稿", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "今なにしてる？" });
  await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
  await dialog.getByPlaceholder("今なにしてる？").fill(content);
  const responseWait = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/posts" && response.request().method() === "POST"
      );
    },
    { timeout: TIMEOUT },
  );
  await dialog.getByRole("button", { name: "投稿", exact: true }).click();
  const response = await responseWait;
  need(response.status() === 200, `real-note-post-${response.status()}`);
  const post = (await response.json()).post;
  need(
    post?.type === "Note" &&
      post.content === content &&
      post.visibility === "public",
    "composer-produced-public-note",
  );
  await dialog.waitFor({ state: "hidden", timeout: TIMEOUT });
  return post;
}

function article(page, post) {
  return page
    .locator("article, div.border-b.border-neutral-900")
    .filter({ has: page.getByText(post.content, { exact: true }) });
}

async function clickBookmark(page, post) {
  const card = article(page, post);
  const button = card.getByRole("button", {
    name: "ブックマーク",
    exact: true,
  });
  await button.waitFor({ state: "visible", timeout: TIMEOUT });
  const request = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname ===
          `/api/posts/${encodeURIComponent(post.ap_id)}/bookmark` &&
        response.request().method() === "POST"
      );
    },
    { timeout: TIMEOUT },
  );
  await button.click();
  need((await request).status() === 200, "bookmark-post-acknowledged");
}

async function apiBookmarks(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/bookmarks?limit=20", {
      credentials: "include",
    });
    const body = await response.json();
    return { status: response.status, posts: body.posts ?? [] };
  });
}

async function nativeBookmark(db, actorApId, postApId) {
  return db
    .prepare(
      "SELECT actor_ap_id, object_ap_id FROM bookmarks WHERE actor_ap_id = ? AND object_ap_id = ?",
    )
    .bind(actorApId, postApId)
    .first();
}

async function nativeNote(db, apId) {
  return db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
    )
    .bind(apId)
    .first();
}

function homeBookmarkButton(page, post) {
  return article(page, post).getByRole("button", { name: /ブックマーク/ });
}

async function navigateToBookmarks(page) {
  await page
    .locator('button[aria-haspopup="dialog"][title="メニューを開く"]')
    .click();
  await page.locator('a[href="/bookmarks"]').click();
  await page.waitForURL((url) => url.pathname === "/bookmarks", {
    timeout: TIMEOUT,
  });
  await page
    .getByRole("heading", { name: "ブックマーク", exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT });
}

async function navigateHomeInApp(page, selectAll = true) {
  await page.locator('a[href="/"]').first().click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: TIMEOUT });
  const allTab = page.getByRole("tab", { name: "すべて", exact: true });
  await allTab.waitFor({ state: "visible", timeout: TIMEOUT });
  if (selectAll && (await allTab.getAttribute("aria-selected")) !== "true")
    await allTab.click();
}

async function assertRowsVisible(page, expectedContents) {
  const api = await apiBookmarks(page);
  need(api.status === 200, `bookmarks-api-${api.status}`);
  for (const content of expectedContents) {
    need(
      api.posts.some((post) => post.content === content),
      `bookmarks-api-preserves-${content}`,
    );
    await page
      .getByText(content, { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
  }
  return api.posts.map((post) => post.content);
}

/**
 * Operator-only local native-browser fixture. It creates Notes through the
 * actual composer, bookmarks through the Home UI, and removes them through
 * BookmarksPage's ConfirmSheet. It is intentionally not a mock-server check.
 */
export async function qualifyBookmarkCache({
  browser,
  worker,
  db,
  origin,
  password,
  sessionSalt,
  checks = [],
  mode = "candidate",
}) {
  need(
    browser && worker && db && Array.isArray(checks),
    "browser-worker-native-db-and-checks-required",
  );
  need(
    ["baseline", "candidate"].includes(mode),
    "mode-must-be-baseline-or-candidate",
  );
  const parsedOrigin = new URL(origin);
  need(
    ["localhost", "127.0.0.1"].includes(parsedOrigin.hostname) &&
      parsedOrigin.origin === origin,
    "fixture-limited-to-local-origin",
  );
  need(
    typeof password === "string" &&
      password.length > 0 &&
      typeof sessionSalt === "string" &&
      sessionSalt.length > 0,
    "ephemeral-password-and-exact-session-salt-required",
  );

  const auth = await loginWithPassword(
    worker,
    db,
    origin,
    password,
    sessionSalt,
  );
  const context = await browser.newContext({
    serviceWorkers: "block",
    locale: "ja-JP",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  let primaryError;
  try {
    await context.addCookies([
      {
        name: "session",
        value: auth.rawCookie,
        domain: parsedOrigin.hostname,
        path: "/",
        httpOnly: true,
        secure: parsedOrigin.protocol === "https:",
        sameSite: "Lax",
      },
    ]);
    let outboundBlocked = 0;
    let unifiedHeadRequests = 0;
    let followingHeadRequests = 0;
    let unifiedRefetchObserved = false;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["data:", "blob:"].includes(url.protocol) || url.origin === origin)
        return route.continue();
      outboundBlocked += 1;
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    let failedDeleteRequestCount = 0;
    let failedPath = null;
    const countUnifiedHeads = (request) => {
      const url = new URL(request.url());
      if (
        url.origin === origin &&
        url.pathname === "/api/timeline" &&
        request.method() === "GET" &&
        !url.searchParams.has("before")
      )
        unifiedHeadRequests += 1;
      if (
        url.origin === origin &&
        url.pathname === "/api/timeline/following" &&
        request.method() === "GET" &&
        !url.searchParams.has("before")
      )
        followingHeadRequests += 1;
      if (
        failedPath &&
        url.origin === origin &&
        url.pathname === failedPath &&
        request.method() === "DELETE"
      )
        failedDeleteRequestCount += 1;
    };
    page.on("request", countUnifiedHeads);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const me = await page.evaluate(async () => {
      const response = await fetch("/api/auth/me", { credentials: "include" });
      const body = await response.json();
      return { status: response.status, actor: body.actor };
    });
    need(
      me.status === 200 &&
        me.actor?.ap_id === auth.actor.ap_id &&
        me.actor?.role === "owner",
      "native-browser-authenticated-as-same-owner",
    );
    await page
      .getByRole("tab", { name: "すべて", exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    const nonce = randomUUID();
    const target = await createNote(page, `bookmark-cache-target-${nonce}`);
    const unrelated = await createNote(
      page,
      `bookmark-cache-unrelated-${nonce}`,
    );
    const failedDelete = await createNote(page, `bookmark-cache-503-${nonce}`);
    const nativeTarget = await db
      .prepare(
        "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
      )
      .bind(target.ap_id)
      .first();
    const nativeUnrelated = await db
      .prepare(
        "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
      )
      .bind(unrelated.ap_id)
      .first();
    const nativeFailure = await db
      .prepare(
        "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
      )
      .bind(failedDelete.ap_id)
      .first();
    for (const [post, native] of [
      [target, nativeTarget],
      [unrelated, nativeUnrelated],
      [failedDelete, nativeFailure],
    ]) {
      need(
        native?.ap_id === post.ap_id &&
          native.type === "Note" &&
          native.attributed_to === auth.actor.ap_id &&
          native.content === post.content &&
          native.visibility === "public" &&
          native.deleted_at == null,
        "real-composer-note-native-d1-readback",
      );
    }

    await clickBookmark(page, target);
    await clickBookmark(page, unrelated);
    await clickBookmark(page, failedDelete);
    for (const post of [target, unrelated, failedDelete])
      need(
        (await nativeBookmark(db, auth.actor.ap_id, post.ap_id))
          ?.object_ap_id === post.ap_id,
        "home-bookmark-native-d1-readback",
      );
    // Reload only after creating fixture state so the feed's observed server
    // head includes every target and its saved flag. This is the cache baseline
    // whose 60-second reuse window is measured through the route round trip.
    const warmUnifiedHead = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/timeline" &&
          response.request().method() === "GET" &&
          !url.searchParams.has("before")
        );
      },
      { timeout: TIMEOUT },
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
    const unifiedHeadResponse = await warmUnifiedHead;
    need(
      unifiedHeadResponse.status() === 200,
      `warm-unified-home-head-${unifiedHeadResponse.status()}`,
    );
    const unifiedHeadBody = await unifiedHeadResponse.json();
    need(
      (unifiedHeadBody.posts ?? []).some((post) => post.ap_id === target.ap_id),
      "unified-http-head-includes-fixture-target",
    );
    await page
      .getByRole("tab", { name: "すべて", exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await article(page, target).waitFor({ state: "visible", timeout: TIMEOUT });
    const unifiedCacheWarmAt = Date.now();
    // Both observed HTTP heads and rendered lanes must include the target.
    const laneHeads = [];
    for (const [label, path] of [
      ["すべて", "/api/timeline"],
      ["フォロー中", "/api/timeline/following"],
    ]) {
      const tab = page.getByRole("tab", { name: label, exact: true });
      let response = null;
      if ((await tab.getAttribute("aria-selected")) !== "true") {
        const wait = page.waitForResponse(
          (candidate) => {
            const url = new URL(candidate.url());
            return (
              url.pathname === path &&
              candidate.request().method() === "GET" &&
              !url.searchParams.has("before")
            );
          },
          { timeout: TIMEOUT },
        );
        await tab.click();
        response = await wait;
        need(
          response.status() === 200,
          `home-${label}-head-${response.status()}`,
        );
      }
      if (response) {
        const body = await response.json();
        need(
          (body.posts ?? []).some((post) => post.ap_id === target.ap_id),
          "following-http-head-includes-fixture-target",
        );
        await article(page, target).waitFor({
          state: "visible",
          timeout: TIMEOUT,
        });
      }
      laneHeads.push({
        lane: label,
        targetVisible: (await article(page, target).count()) > 0,
      });
    }
    need(
      laneHeads.every((lane) => lane.targetVisible),
      "both-home-heads-include-fixture-target",
    );
    const allTab = page.getByRole("tab", { name: "すべて", exact: true });
    if ((await allTab.getAttribute("aria-selected")) !== "true")
      await allTab.click();
    await article(page, target).waitFor({ state: "visible", timeout: TIMEOUT });
    for (const post of [target, unrelated, failedDelete]) {
      need(
        (await homeBookmarkButton(page, post).getAttribute("aria-pressed")) ===
          "true",
        "confirmed-home-bookmark-flag-true-before-removal",
      );
    }
    const beforeRemoval = Date.now();
    await navigateToBookmarks(page);
    const listedBefore = await assertRowsVisible(page, [
      target.content,
      unrelated.content,
      failedDelete.content,
    ]);

    // Successful user-confirmed removal is the primary stale-feed case.
    const targetRow = page
      .locator("div.flex.gap-3")
      .filter({ has: page.getByText(target.content, { exact: true }) });
    await targetRow
      .getByRole("button", { name: "ブックマークを解除", exact: true })
      .click();
    const confirm = page.getByRole("alertdialog", {
      name: "ブックマークを解除しますか？",
    });
    await confirm.waitFor({ state: "visible", timeout: TIMEOUT });
    let successfulDeleteCount = 0;
    const countSuccessfulDelete = (request) => {
      const url = new URL(request.url());
      if (
        url.pathname ===
          `/api/posts/${encodeURIComponent(target.ap_id)}/bookmark` &&
        request.method() === "DELETE"
      )
        successfulDeleteCount += 1;
    };
    page.on("request", countSuccessfulDelete);
    const successfulDelete = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname ===
            `/api/posts/${encodeURIComponent(target.ap_id)}/bookmark` &&
          response.request().method() === "DELETE"
        );
      },
      { timeout: TIMEOUT },
    );
    await confirm
      .getByRole("button", { name: "ブックマークを解除", exact: true })
      .click();
    const deleteResponse = await successfulDelete;
    page.off("request", countSuccessfulDelete);
    need(
      deleteResponse.status() === 200 && successfulDeleteCount === 1,
      "confirmed-bookmark-delete-200-once",
    );
    await targetRow.waitFor({ state: "detached", timeout: TIMEOUT });
    need(
      !(await nativeBookmark(db, auth.actor.ap_id, target.ap_id)),
      "target-bookmark-row-absent-native-d1",
    );
    const afterApi = await apiBookmarks(page);
    need(
      afterApi.status === 200 &&
        !afterApi.posts.some((post) => post.ap_id === target.ap_id),
      "target-bookmark-absent-api",
    );
    need(
      afterApi.posts.some((post) => post.ap_id === unrelated.ap_id) &&
        afterApi.posts.some((post) => post.ap_id === failedDelete.ap_id),
      "unrelated-bookmarks-remain-in-api",
    );
    need(
      (await page.getByText(target.content, { exact: true }).count()) === 0,
      "target-row-removed-from-bookmarks-ui",
    );
    need(
      (await nativeBookmark(db, auth.actor.ap_id, unrelated.ap_id))
        ?.object_ap_id === unrelated.ap_id,
      "unrelated-bookmark-row-preserved-native-d1",
    );
    need(
      (await nativeBookmark(db, auth.actor.ap_id, failedDelete.ap_id))
        ?.object_ap_id === failedDelete.ap_id,
      "other-bookmark-row-preserved-native-d1",
    );
    const noteRowsAfterConfirmedDelete = await Promise.all(
      [target, unrelated, failedDelete].map((post) =>
        nativeNote(db, post.ap_id),
      ),
    );
    need(
      noteRowsAfterConfirmedDelete.every(
        (row, index) =>
          row?.ap_id === [target, unrelated, failedDelete][index].ap_id &&
          row.type === "Note" &&
          row.attributed_to === auth.actor.ap_id &&
          row.content === [target, unrelated, failedDelete][index].content &&
          row.visibility === "public" &&
          row.deleted_at == null,
      ),
      "confirmed-bookmark-delete-does-not-mutate-either-note",
    );
    const headsBeforeReturn = unifiedHeadRequests;
    await navigateHomeInApp(page);
    const targetInHome = article(page, target);
    await targetInHome.waitFor({ state: "visible", timeout: TIMEOUT });
    const returnedAt = Date.now();
    const elapsedMs = returnedAt - beforeRemoval;
    const unifiedCacheAgeMs = returnedAt - unifiedCacheWarmAt;
    need(
      elapsedMs < 60_000 && unifiedCacheAgeMs < 60_000,
      "return-remains-inside-measured-60s-home-cache-window",
    );
    const unifiedHeadRequestsAtReturn = unifiedHeadRequests;
    const returnHeadFetches = unifiedHeadRequestsAtReturn - headsBeforeReturn;
    need(
      returnHeadFetches === 0,
      "unified-return-reuses-cache-without-head-fetch",
    );
    unifiedRefetchObserved = returnHeadFetches > 0;
    const targetVisibleAfterDelete = (await targetInHome.count()) === 1;
    let stalePressed = null;
    if (targetVisibleAfterDelete)
      stalePressed = await homeBookmarkButton(page, target).getAttribute(
        "aria-pressed",
      );
    const expectedBaselineRed =
      targetVisibleAfterDelete &&
      stalePressed === "true" &&
      afterApi.status === 200 &&
      !afterApi.posts.some((post) => post.ap_id === target.ap_id) &&
      !(await nativeBookmark(db, auth.actor.ap_id, target.ap_id));
    if (mode === "baseline") {
      need(
        expectedBaselineRed,
        "EXPECTED_BASELINE_RED-requires-api-and-native-absence-plus-stale-home-pressed-true",
      );
      checks.push(
        "EXPECTED_BASELINE_RED-bookmark-delete-stale-home-saved-flag",
      );
    } else {
      need(
        targetVisibleAfterDelete && stalePressed === "false",
        "candidate-home-bookmark-pressed-false-after-confirmed-delete",
      );
      checks.push("bookmark-cache-confirmed-unsave-unified-home-updated");
    }

    const followingBeforeReturn = followingHeadRequests;
    await page.getByRole("tab", { name: "フォロー中", exact: true }).click();
    await article(page, target).waitFor({ state: "visible", timeout: TIMEOUT });
    const followingPressed = await homeBookmarkButton(
      page,
      target,
    ).getAttribute("aria-pressed");
    need(
      followingPressed === (mode === "baseline" ? "true" : "false"),
      "following-home-flag-agrees-with-confirmed-unsave",
    );
    const followingReturnHeadFetches =
      followingHeadRequests - followingBeforeReturn;
    need(
      followingReturnHeadFetches === 0,
      "following-return-reuses-cache-without-head-fetch",
    );
    need(
      Date.now() - unifiedCacheWarmAt < 60_000,
      "both-home-return-checks-inside-cache-reuse-window",
    );
    checks.push(
      mode === "baseline"
        ? "EXPECTED_BASELINE_RED-bookmark-delete-stale-following-saved-flag"
        : "bookmark-cache-confirmed-unsave-following-home-updated",
    );

    // Independently force a pre-Worker 503 and prove the durable row, UI row,
    // Home pressed state, and no-retry behavior remain intact.
    await navigateToBookmarks(page);
    const failureRow = page
      .locator("div.flex.gap-3")
      .filter({ has: page.getByText(failedDelete.content, { exact: true }) });
    await failureRow
      .getByRole("button", { name: "ブックマークを解除", exact: true })
      .click();
    const failureConfirm = page.getByRole("alertdialog", {
      name: "ブックマークを解除しますか？",
    });
    await failureConfirm.waitFor({ state: "visible", timeout: TIMEOUT });
    failedPath = `/api/posts/${encodeURIComponent(failedDelete.ap_id)}/bookmark`;
    let intercepted = 0;
    await page.route("**/api/posts/**/bookmark", async (route) => {
      const request = route.request();
      if (
        request.method() === "DELETE" &&
        new URL(request.url()).pathname === failedPath
      ) {
        intercepted += 1;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"fixture unavailable"}',
        });
      }
      return route.fallback();
    });
    const failedDeleteResponse = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname === failedPath &&
          response.request().method() === "DELETE"
        );
      },
      { timeout: TIMEOUT },
    );
    await failureConfirm
      .getByRole("button", { name: "ブックマークを解除", exact: true })
      .click();
    const fixed503 = await failedDeleteResponse;
    need(
      fixed503.status() === 503,
      "nonforwarded-bookmark-delete-503-observed",
    );
    need(intercepted === 1, "single-nonforwarded-fixed-503-delete");
    await page
      .getByRole("alert")
      .filter({ hasText: "エラーが発生しました" })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await nativeBookmark(db, auth.actor.ap_id, failedDelete.ap_id))
        ?.object_ap_id === failedDelete.ap_id,
      "503-preserves-native-bookmark-row",
    );
    const failedApi = await apiBookmarks(page);
    need(
      failedApi.status === 200 &&
        failedApi.posts.some((post) => post.ap_id === failedDelete.ap_id),
      "503-bookmarks-api-200-and-preserves-row",
    );
    need(
      (await page.getByText(failedDelete.content, { exact: true }).count()) ===
        1,
      "503-preserves-bookmarks-ui-row",
    );
    const noteRowsAfter503 = await Promise.all(
      [target, unrelated, failedDelete].map((post) =>
        nativeNote(db, post.ap_id),
      ),
    );
    need(
      noteRowsAfter503.every(
        (row, index) =>
          row?.ap_id === [target, unrelated, failedDelete][index].ap_id &&
          row.type === "Note" &&
          row.attributed_to === auth.actor.ap_id &&
          row.content === [target, unrelated, failedDelete][index].content &&
          row.visibility === "public" &&
          row.deleted_at == null,
      ),
      "503-does-not-mutate-either-note",
    );
    await page.unroute("**/api/posts/**/bookmark");
    await navigateHomeInApp(page);
    const failureCard = article(page, failedDelete);
    await failureCard.waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await failureCard.count()) === 1 &&
        (await homeBookmarkButton(page, failedDelete).getAttribute(
          "aria-pressed",
        )) === "true",
      "503-preserves-home-bookmarked-state",
    );
    need(
      intercepted === 1 && failedDeleteRequestCount === 1,
      "503-roundtrip-has-no-automatic-retry",
    );
    need(
      outboundBlocked === 0 && pageErrors.length === 0,
      "no-external-browser-requests-or-page-errors",
    );
    checks.push(
      "bookmark-delete-503-preserves-row-and-home-state-without-retry",
    );

    return {
      status: mode === "baseline" ? "EXPECTED_BASELINE_RED" : "PASSED",
      mode,
      ownerApId: auth.actor.ap_id,
      session: {
        exactSaltedRowVerified: true,
        priorSessionRowsPreserved: auth.priorSessionRows.length,
      },
      created: { notes: 3, bookmarksInitially: listedBefore.length },
      successfulDelete: {
        status: deleteResponse.status(),
        requestCount: successfulDeleteCount,
        targetApiAbsent: !afterApi.posts.some(
          (post) => post.ap_id === target.ap_id,
        ),
        targetNativeAbsent: !(await nativeBookmark(
          db,
          auth.actor.ap_id,
          target.ap_id,
        )),
        unrelatedPreserved: !!(await nativeBookmark(
          db,
          auth.actor.ap_id,
          unrelated.ap_id,
        )),
        homeElapsedMs: elapsedMs,
        unifiedCacheAgeMs,
        homeTargetVisible: targetVisibleAfterDelete,
        homePressed: stalePressed,
        homeCachePath: unifiedRefetchObserved ? "refetched" : "reused",
        returnHeadFetches,
        followingPressed,
        followingReturnHeadFetches,
        laneHeads,
      },
      fixed503: {
        status: fixed503.status(),
        forwardedToWorker: false,
        requests: intercepted,
        totalDeleteRequestsThroughRoundtrip: failedDeleteRequestCount,
        savedRowPreserved: true,
        homePressed: "true",
      },
      outboundBlocked,
      returnedAt,
      checks,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await context.close();
    } catch (error) {
      if (!primaryError) throw error;
    }
  }
}

function headOrderGate() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function headOrderWait(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`bookmark-head-order:${label}-timeout`)),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Hold original native GET bytes across a real Bookmarks DELETE ACK. */
export async function qualifyBookmarkHeadOrder({
  browser,
  worker,
  db,
  origin,
  password,
  sessionSalt,
  checks = [],
  mode = "candidate",
}) {
  const parsed = new URL(origin);
  need(
    ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
      parsed.origin === origin,
    "head-order-loopback-only",
  );
  need(["baseline", "candidate"].includes(mode), "head-order-mode");
  const auth = await loginWithPassword(
    worker,
    db,
    origin,
    password,
    sessionSalt,
  );
  const context = await browser.newContext({
    serviceWorkers: "block",
    locale: "ja-JP",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const releases = [];
  let primary;
  let outboundBlocked = 0;
  try {
    await context.addCookies([
      {
        name: "session",
        value: auth.rawCookie,
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
      outboundBlocked += 1;
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    await page
      .getByRole("tab", { name: "すべて", exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    const nonce = randomUUID();
    const target = await createNote(page, `bookmark-head-target-${nonce}`);
    const unrelated = await createNote(
      page,
      `bookmark-head-unrelated-${nonce}`,
    );
    await clickBookmark(page, target);
    await clickBookmark(page, unrelated);
    const initialNotes = await Promise.all(
      [target, unrelated].map((post) => nativeNote(db, post.ap_id)),
    );
    const initialActors = await db
      .prepare("SELECT * FROM actors ORDER BY ap_id")
      .all();
    const initialSessions = await db
      .prepare("SELECT * FROM sessions ORDER BY id")
      .all();
    const lanes = [];
    for (const [name, path] of [
      ["すべて", "/api/timeline"],
      ["フォロー中", "/api/timeline/following"],
    ]) {
      if (lanes.length) {
        const res = await page.request.post(
          `${origin}/api/posts/${encodeURIComponent(target.ap_id)}/bookmark`,
          { headers: { origin } },
        );
        need(
          res.status() === 200 && (await res.json()).bookmarked === true,
          "between-lanes-real-rebookmark",
        );
      }
      const entered = headOrderGate();
      const release = headOrderGate();
      const delivered = headOrderGate();
      releases.push(release);
      let getCount = 0;
      let deleteCount = 0;
      let snapshot;
      const pattern = `${origin}/api/**`;
      const handler = async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
          url.pathname !== path ||
          request.method() !== "GET" ||
          url.searchParams.has("before")
        )
          return route.fallback();
        getCount += 1;
        if (getCount === 1)
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "fixed initial head refusal" }),
          });
        if (getCount !== 2) return route.fallback();
        try {
          const response = await route.fetch();
          const body = await response.body();
          const value = JSON.parse(body.toString("utf8"));
          need(
            response.status() === 200 &&
              value.posts?.some(
                (post) =>
                  post.ap_id === target.ap_id && post.bookmarked === true,
              ),
            "held-native-get-contains-saved-target",
          );
          snapshot = {
            status: response.status(),
            bodySha256: createHash("sha256").update(body).digest("hex"),
            targetSaved: true,
            posts: value.posts.map((post) => post.ap_id),
          };
          entered.resolve();
          await headOrderWait(release.promise, "native-head-release");
          await route.fulfill({ response, body });
          delivered.resolve();
        } catch (error) {
          entered.reject(error);
          delivered.reject(error);
          await route.abort().catch(() => {});
        }
      };
      const countDelete = (request) => {
        if (
          new URL(request.url()).pathname ===
            `/api/posts/${encodeURIComponent(target.ap_id)}/bookmark` &&
          request.method() === "DELETE"
        )
          deleteCount += 1;
      };
      page.on("request", countDelete);
      await page.route(pattern, handler);
      await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
      await page
        .getByRole("tab", { name: "すべて", exact: true })
        .waitFor({ state: "visible", timeout: TIMEOUT });
      if (name === "フォロー中")
        await page.getByRole("tab", { name, exact: true }).click();
      need(
        (await page
          .getByRole("tab", { name, exact: true })
          .getAttribute("aria-selected")) === "true",
        `head-order-initial-lane-${name}`,
      );
      const retry = page.getByRole("button", { name: "再試行", exact: true });
      await retry.waitFor({ state: "visible", timeout: TIMEOUT });
      need(getCount === 1, "exactly-one-initial-head-503");
      await retry.click();
      await headOrderWait(entered.promise, "head-snapshot-captured");
      need(getCount === 2, "exactly-one-user-read-retry-held");
      await navigateToBookmarks(page);
      await assertRowsVisible(page, [target.content, unrelated.content]);
      const row = page
        .locator("div.flex.gap-3")
        .filter({ has: page.getByText(target.content, { exact: true }) });
      await row
        .getByRole("button", { name: "ブックマークを解除", exact: true })
        .click();
      const confirm = page.getByRole("alertdialog", {
        name: "ブックマークを解除しますか？",
      });
      const deleteWait = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname ===
            `/api/posts/${encodeURIComponent(target.ap_id)}/bookmark` &&
          res.request().method() === "DELETE",
        { timeout: TIMEOUT },
      );
      await confirm
        .getByRole("button", { name: "ブックマークを解除", exact: true })
        .click();
      const deletion = await deleteWait;
      need(
        deletion.status() === 200 && deleteCount === 1,
        "one-real-delete-200-before-head-release",
      );
      await row.waitFor({ state: "detached", timeout: TIMEOUT });
      const list = await apiBookmarks(page);
      need(
        list.status === 200 &&
          !list.posts.some((post) => post.ap_id === target.ap_id) &&
          list.posts.some((post) => post.ap_id === unrelated.ap_id),
        "delete-authority-verified-before-head-release",
      );
      need(
        !(await nativeBookmark(db, auth.actor.ap_id, target.ap_id)) &&
          Boolean(await nativeBookmark(db, auth.actor.ap_id, unrelated.ap_id)),
        "exact-native-row-removal-before-head-release",
      );
      const responseWait = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === path &&
          res.status() === 200 &&
          res.request().method() === "GET",
        { timeout: TIMEOUT },
      );
      release.resolve();
      const late = await Promise.race([
        responseWait,
        delivered.promise.then(() => responseWait),
      ]);
      await headOrderWait(delivered.promise, "original-head-bytes-delivered");
      need(
        createHash("sha256")
          .update(await late.body())
          .digest("hex") === snapshot.bodySha256,
        "browser-received-original-native-response-bytes",
      );
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const beforeReturn = getCount;
      await navigateHomeInApp(page, false);
      await page
        .getByRole("tab", { name, exact: true })
        .waitFor({ state: "visible", timeout: TIMEOUT });
      need(
        (await page
          .getByRole("tab", { name, exact: true })
          .getAttribute("aria-selected")) === "true",
        "return-retains-held-lane",
      );
      await article(page, target).waitFor({
        state: "visible",
        timeout: TIMEOUT,
      });
      const pressed = await homeBookmarkButton(page, target).getAttribute(
        "aria-pressed",
      );
      need(
        pressed === (mode === "baseline" ? "true" : "false"),
        "late-full-head-respects-confirmed-unsave",
      );
      need(
        getCount === beforeReturn && getCount === 2,
        "return-reuses-delivered-head-with-zero-new-get",
      );
      need(
        (await homeBookmarkButton(page, unrelated).getAttribute(
          "aria-pressed",
        )) === "true",
        "unrelated-saved-flag-preserved",
      );
      lanes.push({
        name,
        path,
        initial503: { requests: 1, forwarded: false },
        headRequests: getCount,
        snapshot,
        delete: {
          status: deletion.status(),
          requests: deleteCount,
          targetApiAbsent: true,
          targetNativeAbsent: true,
        },
        pressed,
        returnHeadFetches: getCount - beforeReturn,
      });
      checks.push(
        `bookmark-full-head-${name === "すべて" ? "unified" : "following"}-pre-unsave-response-cannot-restore-saved-flag`,
      );
      page.off("request", countDelete);
      await page.unroute(pattern, handler);
    }
    const finalNotes = await Promise.all(
      [target, unrelated].map((post) => nativeNote(db, post.ap_id)),
    );
    const finalActors = await db
      .prepare("SELECT * FROM actors ORDER BY ap_id")
      .all();
    const finalSessions = await db
      .prepare("SELECT * FROM sessions ORDER BY id")
      .all();
    need(
      JSON.stringify(finalNotes) === JSON.stringify(initialNotes),
      "head-order-preserves-both-native-notes",
    );
    need(
      JSON.stringify(finalActors.results) ===
        JSON.stringify(initialActors.results) &&
        JSON.stringify(finalSessions.results) ===
          JSON.stringify(initialSessions.results),
      "head-order-preserves-owner-and-exact-session-rows",
    );
    need(
      outboundBlocked === 0 && pageErrors.length === 0,
      "head-order-no-outbound-or-page-errors",
    );
    return {
      status: mode === "baseline" ? "EXPECTED_BASELINE_RED" : "PASSED",
      mode,
      lanes,
      checks,
      outboundBlocked,
      nativeNotesUnchanged: true,
      ownerSessionsUnchanged: true,
      renderCheckpoint:
        "original body received, route fulfilled and two animation frames; not durable client quiescence",
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    for (const release of releases) release.resolve();
    try {
      await context.close();
    } catch (error) {
      if (!primary) throw error;
    }
  }
}
