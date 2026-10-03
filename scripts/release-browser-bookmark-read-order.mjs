// Native-browser qualification for bookmark writes racing older pages and
// visibility-triggered head polls. Every held response comes byte-for-byte
// from the disposable native Worker through route.fetch().

import { createHash, randomUUID } from "node:crypto";

const TIMEOUT = 15_000;

function need(condition, label, detail = "") {
  if (!condition)
    throw new Error(
      `bookmark-read-order:${label}${detail ? ` ${detail}` : ""}`,
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

async function bounded(promise, label, timeout = TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`bookmark-read-order:${label}-timeout`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function saltedSessionId(salt, cookie) {
  return `sha256:${createHash("sha256").update(`${salt}:${cookie}`).digest("hex")}`;
}

async function login(worker, db, origin, password, salt) {
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
  need(response.status === 200, "password-login", `${response.status}`);
  const cookieHeader = response.headers.get("set-cookie") ?? "";
  const cookie = /(?:^|,\s*)session=([^;,]+)/i.exec(cookieHeader)?.[1];
  need(cookie, "session-cookie-issued");
  const me = await worker.dispatchFetch(`${origin}/api/auth/me`, {
    headers: { cookie: `session=${cookie}` },
  });
  need(me.status === 200, "session-cookie-authenticates");
  const actor = (await me.json()).actor;
  need(
    actor?.role === "owner" && new URL(actor.ap_id).origin === origin,
    "local-owner-session",
  );
  const rows = await db
    .prepare(
      "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
    )
    .all();
  need(
    (rows.results ?? []).length === 1 &&
      rows.results[0].ap_id === actor.ap_id &&
      rows.results[0].role === "owner" &&
      rows.results[0].owner_actor_ap_id == null &&
      rows.results[0].deleted_at == null,
    "single-owner-native-readback",
  );
  const exactSessionId = saltedSessionId(salt, cookie);
  const issued = await db
    .prepare("SELECT id, member_id, expires_at FROM sessions WHERE id = ?")
    .bind(exactSessionId)
    .first();
  need(
    issued?.id === exactSessionId &&
      issued.member_id === actor.ap_id &&
      Date.parse(issued.expires_at) > Date.now(),
    "exact-salted-session-row",
  );
  const afterSessions = await db
    .prepare("SELECT id, member_id, expires_at FROM sessions ORDER BY id")
    .all();
  const beforeIds = new Set(
    (beforeSessions.results ?? []).map((row) => row.id),
  );
  const priorAfter = (afterSessions.results ?? []).filter((row) =>
    beforeIds.has(row.id),
  );
  need(
    JSON.stringify(priorAfter) === JSON.stringify(beforeSessions.results ?? []),
    "prior-session-rows-preserved",
  );
  return {
    actor,
    cookie,
    exactSessionId,
    priorSessionRows: beforeSessions.results ?? [],
  };
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

async function createNote(worker, db, origin, auth, content) {
  const response = await api(
    worker,
    origin,
    auth.cookie,
    "/api/posts",
    "POST",
    {
      content,
      visibility: "public",
    },
  );
  need(response.status === 200, "real-worker-note-post", `${response.status}`);
  const post = (await response.json()).post;
  need(
    post?.type === "Note" &&
      post.content === content &&
      post.visibility === "public" &&
      typeof post.ap_id === "string" &&
      post.author?.ap_id === auth.actor.ap_id,
    "public-note-response",
  );
  const row = await db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
    )
    .bind(post.ap_id)
    .first();
  need(
    row?.ap_id === post.ap_id &&
      row.type === "Note" &&
      row.attributed_to === auth.actor.ap_id &&
      row.content === content &&
      row.visibility === "public" &&
      row.deleted_at == null,
    "public-note-native-readback",
  );
  return post;
}

async function bookmark(worker, db, origin, auth, post, shouldExist = true) {
  const response = await api(
    worker,
    origin,
    auth.cookie,
    `/api/posts/${encodeURIComponent(post.ap_id)}/bookmark`,
    "POST",
  );
  need(
    response.status === 200,
    "real-worker-bookmark-post",
    `${response.status}`,
  );
  const body = await response.json();
  need(body.bookmarked === true, "bookmark-post-acknowledged");
  const row = await db
    .prepare(
      "SELECT actor_ap_id, object_ap_id FROM bookmarks WHERE actor_ap_id = ? AND object_ap_id = ?",
    )
    .bind(auth.actor.ap_id, post.ap_id)
    .first();
  need(!!row === shouldExist, "bookmark-native-readback");
  return row;
}

async function bookmarkRow(db, actorApId, postApId) {
  return db
    .prepare(
      "SELECT actor_ap_id, object_ap_id FROM bookmarks WHERE actor_ap_id = ? AND object_ap_id = ?",
    )
    .bind(actorApId, postApId)
    .first();
}

async function noteRow(db, post) {
  return db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
    )
    .bind(post.ap_id)
    .first();
}

function article(page, post) {
  return page.locator("article, div.border-b.border-neutral-900").filter({
    has: page.getByText(post.content, { exact: true }),
  });
}

function bookmarkButton(page, post) {
  return article(page, post).getByRole("button", { name: /ブックマーク/ });
}

async function readTimelinePages(worker, origin, cookie, pathname) {
  const pages = [];
  let before = null;
  do {
    const query = new URLSearchParams({ limit: "20" });
    if (before) query.set("before", before);
    const response = await api(worker, origin, cookie, `${pathname}?${query}`);
    need(
      response.status === 200,
      "native-timeline-snapshot",
      `${pathname}:${response.status}`,
    );
    const page = await response.json();
    pages.push(...(page.posts ?? []));
    before = page.next_cursor ?? null;
    if (!page.has_more) break;
  } while (pages.length < 60);
  return pages;
}

async function navigateBookmarks(page) {
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

async function returnHome(page, lane) {
  await page.locator('a[href="/"]').first().click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: TIMEOUT });
  const name = lane === "unified" ? "すべて" : "フォロー中";
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.waitFor({ state: "visible", timeout: TIMEOUT });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

async function deleteThroughConfirm(page, post) {
  const row = page.locator("div.flex.gap-3").filter({
    has: page.getByText(post.content, { exact: true }),
  });
  await row
    .getByRole("button", { name: "ブックマークを解除", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "ブックマークを解除しますか？",
  });
  await confirm.waitFor({ state: "visible", timeout: TIMEOUT });
  const response = page.waitForResponse(
    (res) => {
      const url = new URL(res.url());
      return (
        url.pathname ===
          `/api/posts/${encodeURIComponent(post.ap_id)}/bookmark` &&
        res.request().method() === "DELETE"
      );
    },
    { timeout: TIMEOUT },
  );
  await confirm
    .getByRole("button", { name: "ブックマークを解除", exact: true })
    .click();
  const result = await response;
  need(
    result.status() === 200,
    "confirm-sheet-delete-200",
    `${result.status()}`,
  );
  await row.waitFor({ state: "detached", timeout: TIMEOUT });
  return result.status();
}

async function qualifyOlderLane({
  page,
  worker,
  db,
  origin,
  auth,
  target,
  unrelated,
  lane,
  mode,
  checks,
  releases,
}) {
  const ownerBefore = (
    await db.prepare("SELECT * FROM actors ORDER BY ap_id").all()
  ).results;
  const sessionsBefore = (
    await db.prepare("SELECT * FROM sessions ORDER BY id").all()
  ).results;
  const pathname =
    lane === "unified" ? "/api/timeline" : "/api/timeline/following";
  const laneName = lane === "unified" ? "すべて" : "フォロー中";
  const headBefore = { count: 0 };
  const countHead = (request) => {
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      url.pathname === pathname &&
      request.method() === "GET" &&
      !url.searchParams.has("before")
    )
      headBefore.count++;
  };
  page.on("request", countHead);
  const warm = page.waitForResponse(
    (res) => {
      const url = new URL(res.url());
      return (
        url.origin === origin &&
        url.pathname === "/api/timeline" &&
        res.request().method() === "GET" &&
        !url.searchParams.has("before")
      );
    },
    { timeout: TIMEOUT },
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
  const headResponse = await warm;
  need(headResponse.status() === 200, `older-${lane}-head-200`);
  let head = await headResponse.json();
  await page
    .getByRole("tab", { name: laneName, exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  if (
    (await page
      .getByRole("tab", { name: laneName, exact: true })
      .getAttribute("aria-selected")) !== "true"
  ) {
    const wait = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === pathname &&
        res.request().method() === "GET" &&
        !new URL(res.url()).searchParams.has("before"),
      { timeout: TIMEOUT },
    );
    await page.getByRole("tab", { name: laneName, exact: true }).click();
    const selectedHead = await wait;
    need(selectedHead.status() === 200, `older-${lane}-selected-head-200`);
    head = await selectedHead.json();
  }
  const headsBeforeRace = headBefore.count;
  need(
    (head.posts ?? []).length === 20 &&
      head.has_more === true &&
      typeof head.next_cursor === "string",
    `older-${lane}-head-cursor-and-limit`,
  );
  need(
    !(head.posts ?? []).some((post) => post.ap_id === target.ap_id),
    `older-${lane}-target-not-in-head`,
  );
  const sentinel = page.locator('.h-px[aria-hidden="true"]');
  await sentinel.waitFor({ state: "visible", timeout: TIMEOUT });
  const entered = gate(`${lane} native older response captured`);
  const release = gate(`${lane} native older response release`);
  const delivered = gate(`${lane} native older response delivered`);
  releases.push(release);
  const records = [];
  let requestCount = 0;
  let deleteCount = 0;
  const countDelete = (request) => {
    if (
      new URL(request.url()).pathname ===
        `/api/posts/${encodeURIComponent(target.ap_id)}/bookmark` &&
      request.method() === "DELETE"
    )
      deleteCount++;
  };
  page.on("request", countDelete);
  const routeHandler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin !== origin ||
      url.pathname !== pathname ||
      request.method() !== "GET" ||
      !url.searchParams.has("before")
    )
      return route.fallback();
    requestCount++;
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: TIMEOUT });
      const bytes = await response.body();
      const body = JSON.parse(bytes.toString("utf8"));
      need(
        response.status() === 200,
        `older-${lane}-native-get-200`,
        `${response.status()}`,
      );
      need(
        url.searchParams.get("before") === head.next_cursor &&
          url.searchParams.get("limit") === "20",
        `older-${lane}-cursor-and-limit-unchanged`,
      );
      need(
        (body.posts ?? []).some(
          (post) => post.ap_id === target.ap_id && post.bookmarked === true,
        ),
        `older-${lane}-native-snapshot-target-saved`,
      );
      records.push({
        method: request.method(),
        url: request.url(),
        status: response.status(),
        before: url.searchParams.get("before"),
        limit: url.searchParams.get("limit"),
        bodySha256: createHash("sha256").update(bytes).digest("hex"),
        postIds: (body.posts ?? []).map((post) => post.ap_id),
        targetSaved: body.posts.find((post) => post.ap_id === target.ap_id)
          ?.bookmarked,
        hasMore: body.has_more,
        nextCursor: body.next_cursor ?? null,
      });
      entered.resolve();
      await bounded(release.promise, `older-${lane}-response-release`);
      await route.fulfill({ response, body: bytes });
      delivered.resolve();
    } catch (error) {
      entered.reject(error);
      delivered.reject(error);
      await route.abort().catch(() => {});
    }
  };
  await page.route(`**${pathname}**`, routeHandler);
  const olderResponse = page.waitForResponse(
    (res) => {
      const url = new URL(res.url());
      return (
        url.pathname === pathname &&
        res.request().method() === "GET" &&
        url.searchParams.has("before")
      );
    },
    { timeout: TIMEOUT },
  );
  olderResponse.catch(() => {});
  await sentinel.scrollIntoViewIfNeeded();
  await bounded(entered.promise, `older-${lane}-native-response-captured`);
  const captured = records[0];
  need(
    captured.postIds.includes(target.ap_id),
    `older-${lane}-contains-oldest-target`,
    JSON.stringify(captured.postIds),
  );
  await navigateBookmarks(page);
  const bookmarkApiBefore = await page.evaluate(async () => {
    const response = await fetch("/api/bookmarks?limit=20", {
      credentials: "include",
    });
    return { status: response.status, body: await response.json() };
  });
  need(
    bookmarkApiBefore.status === 200 &&
      (bookmarkApiBefore.body.posts ?? []).some(
        (post) => post.ap_id === target.ap_id,
      ),
    `older-${lane}-bookmark-visible-before-delete`,
  );
  const deleteStatus = await deleteThroughConfirm(page, target);
  need(deleteCount === 1, `older-${lane}-single-confirmed-delete`);
  need(
    !(await bookmarkRow(db, auth.actor.ap_id, target.ap_id)),
    `older-${lane}-target-native-bookmark-absent`,
  );
  const bookmarkApiAfter = await page.evaluate(async () => {
    const response = await fetch("/api/bookmarks?limit=20", {
      credentials: "include",
    });
    const body = await response.json();
    return { status: response.status, posts: body.posts ?? [] };
  });
  need(
    bookmarkApiAfter.status === 200 &&
      !bookmarkApiAfter.posts.some((post) => post.ap_id === target.ap_id),
    `older-${lane}-bookmark-api-absence`,
  );
  need(
    bookmarkApiAfter.posts.some((post) => post.ap_id === unrelated.ap_id),
    `older-${lane}-unrelated-bookmark-preserved`,
  );
  release.resolve();
  const pageResponse = await bounded(
    olderResponse,
    `older-${lane}-browser-response`,
  );
  await bounded(delivered.promise, `older-${lane}-response-delivered`);
  need(
    pageResponse.status() === 200 && requestCount === 1,
    `older-${lane}-delivered-response-200-once`,
  );
  need(
    createHash("sha256")
      .update(await pageResponse.body())
      .digest("hex") === captured.bodySha256,
    `older-${lane}-browser-received-original-native-bytes`,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await returnHome(page, lane);
  await article(page, target).waitFor({ state: "visible", timeout: TIMEOUT });
  const targetPressed = await bookmarkButton(page, target).getAttribute(
    "aria-pressed",
  );
  const orderedContent = await page
    .locator("article, div.border-b.border-neutral-900")
    .allTextContents();
  const targetPosition = orderedContent.findIndex((text) =>
    text.includes(target.content),
  );
  const lastHeadContent = head.posts.at(-1)?.content;
  const lastHeadPosition = orderedContent.findIndex((text) =>
    text.includes(lastHeadContent),
  );
  need(
    targetPosition > lastHeadPosition && lastHeadPosition >= 0,
    `older-${lane}-cached-head-order-preserved`,
    JSON.stringify({
      targetPosition,
      lastHeadPosition,
      rows: orderedContent.length,
    }),
  );
  const headRefetches = headBefore.count - headsBeforeRace;
  need(
    headRefetches === 0,
    `older-${lane}-return-has-no-head-refetch`,
    `${headRefetches}`,
  );
  const expectedBaselineRed =
    targetPressed === "true" &&
    !(await bookmarkRow(db, auth.actor.ap_id, target.ap_id));
  if (mode === "baseline") {
    need(expectedBaselineRed, `EXPECTED_BASELINE_RED-${lane}-stale-saved-flag`);
    checks.push(`EXPECTED_BASELINE_RED-bookmark-${lane}-older-page-unsave`);
  } else {
    need(
      targetPressed === "false",
      `candidate-${lane}-older-page-pressed-false`,
      `${targetPressed}`,
    );
    checks.push(`bookmark-${lane}-older-page-read-reconciled`);
  }
  const targetNote = await noteRow(db, target);
  const unrelatedNote = await noteRow(db, unrelated);
  need(
    targetNote?.deleted_at == null &&
      targetNote.type === "Note" &&
      targetNote.attributed_to === auth.actor.ap_id,
    `older-${lane}-target-note-untouched`,
  );
  need(
    unrelatedNote?.deleted_at == null &&
      unrelatedNote.type === "Note" &&
      unrelatedNote.attributed_to === auth.actor.ap_id,
    `older-${lane}-unrelated-note-untouched`,
  );
  need(
    (await bookmarkRow(db, auth.actor.ap_id, unrelated.ap_id))?.object_ap_id ===
      unrelated.ap_id,
    `older-${lane}-unrelated-bookmark-native-preserved`,
  );
  need(
    JSON.stringify(
      (await db.prepare("SELECT * FROM actors ORDER BY ap_id").all()).results,
    ) === JSON.stringify(ownerBefore),
    `older-${lane}-exact-owner-rows-unchanged-after-setup`,
  );
  need(
    JSON.stringify(
      (await db.prepare("SELECT * FROM sessions ORDER BY id").all()).results,
    ) === JSON.stringify(sessionsBefore),
    `older-${lane}-exact-session-rows-unchanged`,
  );
  await page.unroute(`**${pathname}**`, routeHandler);
  page.off("request", countDelete);
  page.off("request", countHead);
  return {
    lane,
    requestCount,
    deleteStatus,
    deleteCount,
    snapshot: captured,
    returnHeadRefetches: headRefetches,
    targetPressed,
    orderedHeadIds: (head.posts ?? []).map((post) => post.ap_id),
    olderPageIds: captured.postIds,
    cursor: head.next_cursor,
    targetNotePreserved: true,
    unrelatedNotePreserved: true,
    unrelatedBookmarkPreserved: true,
    ownerSessionRowsUnchangedAfterSetup: true,
  };
}

async function qualifyPoll({
  page,
  worker,
  db,
  origin,
  auth,
  unrelated,
  mode,
  checks,
  releases,
}) {
  // The Home cache is already mounted. Create the newer post through the real
  // Worker API so it is absent from the rendered cache until a real head poll.
  const nonce = randomUUID();
  const target = await createNote(
    worker,
    db,
    origin,
    auth,
    `bookmark-poll-target-${nonce}`,
  );
  await bookmark(worker, db, origin, auth, target);
  const ownerAfterSetup = (
    await db.prepare("SELECT * FROM actors ORDER BY ap_id").all()
  ).results;
  const sessionAfterSetup = (
    await db.prepare("SELECT * FROM sessions ORDER BY id").all()
  ).results;
  const noteAfterSetup = await noteRow(db, target);
  const pathname = "/api/timeline";
  let pollRequests = 0;
  let postPollHeadRequests = 0;
  let pollReleased = false;
  let deleteCount = 0;
  let snapshot = null;
  const captured = gate("poll native response captured");
  const release = gate("poll native response release");
  const delivered = gate("poll native response delivered");
  releases.push(release);
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin !== origin ||
      url.pathname !== pathname ||
      request.method() !== "GET" ||
      url.searchParams.has("before")
    )
      return route.fallback();
    pollRequests++;
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: TIMEOUT });
      const bytes = await response.body();
      const body = JSON.parse(bytes.toString("utf8"));
      need(
        response.status() === 200 &&
          (body.posts ?? []).some(
            (post) => post.ap_id === target.ap_id && post.bookmarked === true,
          ),
        "poll-native-response-contains-saved-new-note",
      );
      snapshot = {
        method: request.method(),
        url: request.url(),
        status: response.status(),
        limit: url.searchParams.get("limit"),
        cursor: url.searchParams.get("before"),
        bodySha256: createHash("sha256").update(bytes).digest("hex"),
        postIds: (body.posts ?? []).map((post) => post.ap_id),
        targetSaved: true,
      };
      captured.resolve();
      await bounded(release.promise, "poll-response-release");
      await route.fulfill({ response, body: bytes });
      delivered.resolve();
    } catch (error) {
      captured.reject(error);
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
      deleteCount++;
  };
  const countHead = (request) => {
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      url.pathname === pathname &&
      request.method() === "GET" &&
      !url.searchParams.has("before") &&
      pollReleased
    )
      postPollHeadRequests++;
  };
  page.on("request", countDelete);
  page.on("request", countHead);
  await page.route(`**${pathname}**`, handler);
  const responsePromise = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === pathname &&
      res.request().method() === "GET" &&
      !new URL(res.url()).searchParams.has("before"),
    { timeout: TIMEOUT },
  );
  responsePromise.catch(() => {});
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await bounded(captured.promise, "poll-native-response-captured");
  need(pollRequests === 1, "single-held-poll-request");
  await navigateBookmarks(page);
  const deleteStatus = await deleteThroughConfirm(page, target);
  need(deleteCount === 1, "poll-confirmed-delete-once");
  need(
    !(await bookmarkRow(db, auth.actor.ap_id, target.ap_id)),
    "poll-target-native-bookmark-absent",
  );
  const apiAfter = await page.evaluate(async (apId) => {
    const response = await fetch("/api/bookmarks?limit=20", {
      credentials: "include",
    });
    const body = await response.json();
    return {
      status: response.status,
      hasTarget: (body.posts ?? []).some((post) => post.ap_id === apId),
      posts: body.posts ?? [],
    };
  }, target.ap_id);
  need(
    apiAfter.status === 200 &&
      !apiAfter.hasTarget &&
      apiAfter.posts.some((post) => post.ap_id === unrelated.ap_id),
    "poll-bookmark-api-target-absent-unrelated-preserved",
  );
  pollReleased = true;
  release.resolve();
  const response = await bounded(responsePromise, "poll-browser-head-response");
  await bounded(delivered.promise, "poll-response-delivered");
  need(response.status() === 200, "poll-delivered-head-200");
  need(
    createHash("sha256")
      .update(await response.body())
      .digest("hex") === snapshot.bodySha256,
    "poll-browser-received-original-native-bytes",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await returnHome(page, "unified");
  await page
    .getByRole("button", { name: /件の新しい投稿|new posts/ })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  await page.getByRole("button", { name: /件の新しい投稿|new posts/ }).click();
  await article(page, target).waitFor({ state: "visible", timeout: TIMEOUT });
  const targetPressed = await bookmarkButton(page, target).getAttribute(
    "aria-pressed",
  );
  const returnHeadRefetches = postPollHeadRequests;
  need(
    returnHeadRefetches === 0,
    "poll-return-no-additional-head-fetch",
    `${returnHeadRefetches}`,
  );
  const expectedBaselineRed =
    targetPressed === "true" &&
    !(await bookmarkRow(db, auth.actor.ap_id, target.ap_id));
  if (mode === "baseline") {
    need(expectedBaselineRed, "EXPECTED_BASELINE_RED-poll-stale-saved-flag");
    checks.push("EXPECTED_BASELINE_RED-bookmark-poll-unsave");
  } else {
    need(
      targetPressed === "false",
      "candidate-poll-new-note-pressed-false",
      `${targetPressed}`,
    );
    checks.push("bookmark-poll-read-reconciled");
  }
  const note = await noteRow(db, target);
  need(
    note?.deleted_at == null &&
      note.type === "Note" &&
      note.attributed_to === auth.actor.ap_id,
    "poll-target-note-preserved",
  );
  need(
    (await bookmarkRow(db, auth.actor.ap_id, unrelated.ap_id))?.object_ap_id ===
      unrelated.ap_id,
    "poll-unrelated-bookmark-preserved",
  );
  page.off("request", countHead);
  page.off("request", countDelete);
  await page.unroute(`**${pathname}**`, handler);
  // An explicit server snapshot after rebookmarking proves future authoritative
  // reads can still report true; the in-memory reconciliation is not a mask.
  await bookmark(worker, db, origin, auth, target);
  const authoritative = await api(
    worker,
    origin,
    auth.cookie,
    `${pathname}?limit=20`,
  );
  const authoritativeBody = await authoritative.json();
  need(
    authoritative.status === 200 &&
      (authoritativeBody.posts ?? []).some(
        (post) => post.ap_id === target.ap_id && post.bookmarked === true,
      ),
    "fresh-native-snapshot-reflects-real-rebookmark",
  );
  need(
    JSON.stringify(
      (await db.prepare("SELECT * FROM actors ORDER BY ap_id").all()).results,
    ) === JSON.stringify(ownerAfterSetup),
    "poll-exact-owner-rows-unchanged-after-setup",
  );
  need(
    JSON.stringify(
      (await db.prepare("SELECT * FROM sessions ORDER BY id").all()).results,
    ) === JSON.stringify(sessionAfterSetup),
    "poll-exact-session-rows-unchanged",
  );
  need(
    JSON.stringify(await noteRow(db, target)) ===
      JSON.stringify(noteAfterSetup),
    "poll-exact-note-row-unchanged-after-setup",
  );
  return {
    requestCount: pollRequests,
    deleteStatus,
    deleteCount,
    snapshot,
    returnHeadRefetches,
    targetPressed,
    authoritativeRebookmarkReadback: true,
    ownerRowsAfterSetupSha256: createHash("sha256")
      .update(JSON.stringify(ownerAfterSetup))
      .digest("hex"),
    ownerSessionNoteRowsUnchangedAfterSetup: true,
  };
}

/** Real loopback Worker/D1 and browser fixture for bookmarked reads crossing unsave ACKs. */
export async function qualifyBookmarkReadOrder({
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
  need(["baseline", "candidate"].includes(mode), "mode-baseline-or-candidate");
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
    "ephemeral-login-inputs-required",
  );
  const auth = await login(worker, db, origin, password, sessionSalt);
  const initialSessions = await db
    .prepare("SELECT * FROM sessions ORDER BY id")
    .all();
  const context = await browser.newContext({
    serviceWorkers: "block",
    locale: "ja-JP",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const releases = [];
  let primaryError;
  let outboundBlocked = 0;
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
    const page = await context.newPage();
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
      "browser-same-owner-session",
    );
    await page
      .getByRole("tab", { name: "すべて", exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });

    const nonce = randomUUID();
    const created = [];
    for (let index = 0; index < 22; index++) {
      created.push(
        await createNote(
          worker,
          db,
          origin,
          auth,
          `bookmark-read-order-${index}-${nonce}`,
        ),
      );
    }
    const allUnified = await readTimelinePages(
      worker,
      origin,
      auth.cookie,
      "/api/timeline",
    );
    const fixtureIds = new Set(created.map((post) => post.ap_id));
    const orderedFixtures = allUnified.filter((post) =>
      fixtureIds.has(post.ap_id),
    );
    need(orderedFixtures.length === 22, "all-22-notes-in-native-paged-home");
    const targetId = orderedFixtures.at(-1).ap_id;
    const target = created.find((post) => post.ap_id === targetId);
    const unrelated = created.find((post) => post.ap_id !== targetId);
    need(target && unrelated, "oldest-target-and-unrelated-note-selected");
    need(
      orderedFixtures.slice(0, 20).every((post) => post.ap_id !== target.ap_id),
      "oldest-target-is-beyond-home-limit-20",
    );
    await bookmark(worker, db, origin, auth, target);
    await bookmark(worker, db, origin, auth, unrelated);
    const savedUnified = await readTimelinePages(
      worker,
      origin,
      auth.cookie,
      "/api/timeline",
    );
    need(
      savedUnified.find((post) => post.ap_id === target.ap_id)?.bookmarked ===
        true,
      "target-saved-in-authoritative-home-read",
    );
    need(
      savedUnified.filter(
        (post) => post.bookmarked === true && fixtureIds.has(post.ap_id),
      ).length === 2,
      "only-target-and-unrelated-fixture-bookmarks-saved",
    );
    const initialFixtureNotes = await Promise.all(
      created.map((post) => noteRow(db, post)),
    );

    const lanes = [];
    lanes.push(
      await qualifyOlderLane({
        page,
        worker,
        db,
        origin,
        auth,
        target,
        unrelated,
        lane: "unified",
        mode,
        checks,
        releases,
      }),
    );
    await bookmark(worker, db, origin, auth, target);
    lanes.push(
      await qualifyOlderLane({
        page,
        worker,
        db,
        origin,
        auth,
        target,
        unrelated,
        lane: "following",
        mode,
        checks,
        releases,
      }),
    );
    need(
      lanes.every((lane) => lane.olderPageIds.includes(target.ap_id)),
      "both-lanes-owned-note-older-page-visible",
    );

    // Rebookmark before the poll race so the native poll bytes again describe
    // a saved post, then return to a clean, current Home head cache.
    await bookmark(worker, db, origin, auth, target);
    const loadedHead = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/api/timeline" &&
        res.request().method() === "GET" &&
        !new URL(res.url()).searchParams.has("before"),
      { timeout: TIMEOUT },
    );
    loadedHead.catch(() => {});
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    need(
      (await loadedHead).status() === 200,
      "poll-starts-after-real-head-loaded",
    );
    await article(
      page,
      (
        await readTimelinePages(worker, origin, auth.cookie, "/api/timeline")
      )[0],
    ).waitFor({ state: "visible", timeout: TIMEOUT });
    await page
      .getByRole("tab", { name: "すべて", exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    const poll = await qualifyPoll({
      page,
      worker,
      db,
      origin,
      auth,
      unrelated,
      mode,
      checks,
      releases,
    });
    const finalActors = await db
      .prepare("SELECT * FROM actors ORDER BY ap_id")
      .all();
    const finalSessions = await db
      .prepare("SELECT * FROM sessions ORDER BY id")
      .all();
    need(
      createHash("sha256")
        .update(JSON.stringify(finalActors.results))
        .digest("hex") === poll.ownerRowsAfterSetupSha256,
      "exact-final-owner-rows-match-final-setup-snapshot",
    );
    need(
      JSON.stringify(finalSessions.results ?? []) ===
        JSON.stringify(initialSessions.results ?? []),
      "session-rows-unchanged-through-fixture",
    );
    const finalFixtureNotes = await Promise.all(
      created.map((post) => noteRow(db, post)),
    );
    need(
      JSON.stringify(finalFixtureNotes) === JSON.stringify(initialFixtureNotes),
      "ordered-fixture-note-rows-unchanged-through-bookmark-deletes",
    );
    need(
      outboundBlocked === 0 && pageErrors.length === 0,
      "browser-has-no-external-requests-or-page-errors",
      JSON.stringify({ outboundBlocked, pageErrors }),
    );
    return {
      status: mode === "baseline" ? "EXPECTED_BASELINE_RED" : "PASSED",
      mode,
      ownerApId: auth.actor.ap_id,
      session: {
        exactSaltedRowVerified: true,
        priorSessionRowsPreserved: auth.priorSessionRows.length,
      },
      created: { notes: 23, bookmarksInitially: 2 },
      ownerSetupEffect:
        "23 real POSTs update post_count/updated_at during setup; each bookmark race compares all owner/session rows exactly after its setup",
      renderCheckpoint:
        "original native body received and route fulfilled plus two animation frames; not durable client quiescence",
      olderPages: lanes,
      poll,
      outboundBlocked,
      pageErrors,
      checks,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    for (const item of releases) item.resolve();
    try {
      await context.close();
    } catch (error) {
      if (!primaryError) throw error;
    }
  }
}
