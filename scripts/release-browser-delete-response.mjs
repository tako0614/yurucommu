// Disposable local-native-browser qualification for a Following response
// fetched before DELETE but delivered after DELETE and route return.

function requireDeleteResponse(condition, message) {
  if (!condition) throw new Error(`browser-delete-response ${message}`);
}

function gate(label) {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  promise.catch(() => {});
  return { label, promise, resolve, reject };
}

async function bounded(promise, label, timeout = 15_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`browser-delete-response ${label} timed out`)),
      timeout,
    );
  });
  deadline.catch(() => {});
  promise.catch(() => {});
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function expectResponse(page, url, method, label, timeout = 15_000) {
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).origin === new URL(url).origin &&
      new URL(response.url()).pathname === new URL(url).pathname &&
      response.request().method() === method,
    { timeout },
  );
  pending.catch(() => {});
  return pending.catch((error) => {
    throw new Error(
      `browser-delete-response ${label} response missing: ${String(error)}`,
    );
  });
}

async function countRows(db) {
  return db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
}

async function readObject(db, apId) {
  return db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
    )
    .bind(apId)
    .first();
}

async function createPublicPost(page, db, actorApId, content) {
  const responsePromise = expectResponse(
    page,
    new URL("/api/posts", page.url()).href,
    "POST",
    "real composer post",
  );
  await page.getByRole("button", { name: "投稿", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "今なにしてる？" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("今なにしてる？").fill(content);
  await dialog.locator("#post-visibility").selectOption("public");
  await dialog.getByRole("button", { name: "投稿", exact: true }).click();
  const response = await responsePromise;
  const body = await response.json().catch(() => null);
  const post = body?.post;
  requireDeleteResponse(
    response.status() === 200 &&
      typeof post?.ap_id === "string" &&
      post.type === "Note" &&
      post.author?.ap_id === actorApId &&
      post.content === content &&
      post.visibility === "public",
    `composer did not create the expected public own post (${response.status()})`,
  );
  const native = await readObject(db, post.ap_id);
  requireDeleteResponse(
    native?.ap_id === post.ap_id &&
      native.type === "Note" &&
      native.attributed_to === actorApId &&
      native.content === content &&
      native.visibility === "public" &&
      native.deleted_at === null,
    "real composer post was not present in native D1",
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return { apId: post.ap_id, content, native };
}

function detailPath(apId) {
  return `/post/${encodeURIComponent(apId)}`;
}

function deletePath(apId) {
  return `/api/posts/${encodeURIComponent(apId)}`;
}

async function clickTab(page, label) {
  const tab = page.getByRole("tab", { name: label, exact: true });
  await tab.waitFor({ state: "visible", timeout: 10_000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  requireDeleteResponse(
    (await tab.getAttribute("aria-selected")) === "true",
    `${label} tab did not remain selected`,
  );
}

async function visiblePost(page, content) {
  return page
    .getByText(content, { exact: true })
    .isVisible()
    .catch(() => false);
}

async function openDetail(page, post) {
  await page.getByText(post.content, { exact: true }).click();
  await page.waitForURL((url) => url.pathname === detailPath(post.apId), {
    timeout: 10_000,
  });
  await page.getByText(post.content, { exact: true }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
}

async function confirmDelete(page, apId) {
  await page.getByRole("button", { name: "削除", exact: true }).first().click();
  const dialog = page.getByRole("alertdialog", {
    name: "投稿を削除しますか？",
  });
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  const responsePromise = expectResponse(
    page,
    new URL(deletePath(apId), page.url()).href,
    "DELETE",
    "ConfirmSheet delete",
  );
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  const response = await responsePromise;
  requireDeleteResponse(
    response.ok(),
    `ConfirmSheet DELETE failed (${response.status()})`,
  );
  return { status: response.status(), path: new URL(response.url()).pathname };
}

async function failDeleteBeforeWorker(page, db, post) {
  const targetPath = deletePath(post.apId);
  let intercepted = 0;
  const handler = async (route) => {
    if (
      route.request().method() === "DELETE" &&
      new URL(route.request().url()).pathname === targetPath
    ) {
      intercepted += 1;
      await route.abort("failed");
      return;
    }
    await route.fallback();
  };
  await page.route("**/api/posts/**", handler);
  try {
    await openDetail(page, post);
    await page
      .getByRole("button", { name: "削除", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("alertdialog", {
      name: "投稿を削除しますか？",
    });
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    await dialog.getByRole("button", { name: "削除", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "削除に失敗しました" })
      .waitFor({ state: "visible", timeout: 5_000 });
    const native = await readObject(db, post.apId);
    const visible = await visiblePost(page, post.content);
    requireDeleteResponse(
      intercepted === 1 &&
        native?.ap_id === post.apId &&
        native.deleted_at === null &&
        visible,
      "pre-Worker failed DELETE did not preserve native D1 and detail UI",
    );
    return { intercepted, native, detailVisibleAfterFailure: visible };
  } finally {
    await page.unroute("**/api/posts/**", handler);
  }
}

function holdOneRealFollowingResponse(page, origin) {
  const ready = gate("native Following GET fetched and held");
  const release = gate("held native Following response released");
  const delivered = gate("held native Following response delivered");
  const finished = gate("Following route handler finished");
  let requestCount = 0;
  let activeHandlers = 0;
  let firstHandlerFinished = false;
  let responseStatus = null;
  let body = null;
  let routeError = null;
  let released = false;
  const path = "/api/timeline/following";
  const finishHandler = (first) => {
    activeHandlers -= 1;
    if (first) firstHandlerFinished = true;
    if (firstHandlerFinished && activeHandlers === 0) finished.resolve();
  };
  const handler = async (route) => {
    const request = route.request();
    if (
      request.method() !== "GET" ||
      new URL(request.url()).origin !== origin ||
      new URL(request.url()).pathname !== path
    ) {
      await route.fallback();
      return;
    }
    requestCount += 1;
    activeHandlers += 1;
    if (requestCount !== 1) {
      routeError = new Error(
        "unexpected second Following GET while late response fixture was active",
      );
      try {
        await route.abort("failed");
      } finally {
        ready.reject(routeError);
        delivered.reject(routeError);
        finishHandler(false);
      }
      return;
    }
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      responseStatus = response.status();
      body = await response.json();
      ready.resolve({ responseStatus, body, requestUrl: request.url() });
      await bounded(release.promise, "release held Following response", 60_000);
      released = true;
      await route.fulfill({ response });
      delivered.resolve({ status: responseStatus, body });
    } catch (error) {
      routeError = error;
      ready.reject(error);
      delivered.reject(error);
      try {
        await route.abort("failed");
      } catch {
        // Preserve the route fetch/fulfill failure as the primary error.
      }
    } finally {
      finishHandler(true);
    }
  };
  return {
    handler,
    ready: bounded(ready.promise, "native Following response", 20_000),
    get delivered() {
      return bounded(delivered.promise, "Following response delivery", 20_000);
    },
    get finished() {
      return bounded(finished.promise, "Following route cleanup", 20_000);
    },
    release() {
      released = true;
      release.resolve();
    },
    get requestCount() {
      return requestCount;
    },
    get responseStatus() {
      return responseStatus;
    },
    get body() {
      return body;
    },
    get error() {
      return routeError;
    },
    get isReleased() {
      return released;
    },
  };
}

export async function qualifyBrowserDeleteResponse({
  page,
  db,
  origin,
  actorApId,
  checks,
  mode = "green",
}) {
  requireDeleteResponse(
    page && db && Array.isArray(checks),
    "page, native D1, and checks accumulator are required",
  );
  requireDeleteResponse(
    mode === "green" || mode === "baseline-red",
    "mode must be green or baseline-red",
  );
  const localOrigin = new URL(origin).origin;
  requireDeleteResponse(
    ["127.0.0.1", "localhost"].includes(new URL(localOrigin).hostname) &&
      new URL(actorApId).origin === localOrigin,
    "fixture requires one authenticated local Worker owner",
  );
  const before = await countRows(db);
  const cookieBefore = (await page.context().cookies(origin)).find(
    (cookie) => cookie.name === "session",
  );
  const owner = await db
    .prepare("SELECT ap_id, role FROM actors WHERE ap_id = ?")
    .bind(actorApId)
    .first();
  requireDeleteResponse(
    cookieBefore?.value && owner?.ap_id === actorApId && owner.role === "owner",
    "owner session or root-owner row is missing",
  );

  const suffix = crypto.randomUUID();
  const m1 = await createPublicPost(
    page,
    db,
    actorApId,
    `Late Following M1 ${suffix}`,
  );
  const m2 = await createPublicPost(
    page,
    db,
    actorApId,
    `Late Following M2 ${suffix}`,
  );
  const afterPosts = await countRows(db);
  requireDeleteResponse(
    JSON.stringify(before) === JSON.stringify(afterPosts),
    "post creation changed actor/session counts",
  );

  let primaryError;
  let hold;
  let holdRouteInstalled = false;
  let countFollowingRequest;
  let countFollowingResponse;
  let pageErrors = [];
  let serverErrors = [];
  const capturePageError = (error) => pageErrors.push(error.message);
  const captureServerError = (response) => {
    if (response.status() >= 500) {
      serverErrors.push({
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
    }
  };
  page.on("pageerror", capturePageError);
  page.on("response", captureServerError);
  try {
    // A document navigation clears only in-memory app state. It preserves the
    // authenticated cookie and makes the unified GET below authoritative.
    const unifiedResponsePromise = expectResponse(
      page,
      new URL("/api/timeline", localOrigin).href,
      "GET",
      "fresh unified timeline",
    );
    await page.goto(new URL("/", localOrigin).href, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const unifiedResponse = await unifiedResponsePromise;
    requireDeleteResponse(
      unifiedResponse.status() === 200,
      `unified timeline GET failed (${unifiedResponse.status()})`,
    );
    const unifiedBody = await unifiedResponse.json().catch(() => null);
    for (const post of [m1, m2]) {
      requireDeleteResponse(
        unifiedBody?.posts?.some(
          (entry) =>
            entry.ap_id === post.apId &&
            entry.content === post.content &&
            entry.author?.ap_id === actorApId,
        ),
        `real unified GET lacked own post ${post.content}`,
      );
      await page
        .getByText(post.content, { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
    }
    hold = holdOneRealFollowingResponse(page, localOrigin);
    const followingRequestCount = { requests: 0, responses: 0 };
    countFollowingRequest = (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).origin === localOrigin &&
        new URL(request.url()).pathname === "/api/timeline/following"
      )
        followingRequestCount.requests += 1;
    };
    countFollowingResponse = (response) => {
      if (
        response.request().method() === "GET" &&
        new URL(response.url()).origin === localOrigin &&
        new URL(response.url()).pathname === "/api/timeline/following"
      )
        followingRequestCount.responses += 1;
    };
    page.on("request", countFollowingRequest);
    page.on("response", countFollowingResponse);
    await page.route("**/api/timeline/following**", hold.handler);
    holdRouteInstalled = true;
    // Following has not been loaded since the navigation above, so this is its
    // first real GET; route.fetch reaches Worker/D1 before delivery is held.
    await clickTab(page, "フォロー中");
    const held = await hold.ready;
    requireDeleteResponse(
      hold.responseStatus === 200 &&
        [m1, m2].every((post) =>
          held.body?.posts?.some(
            (entry) =>
              entry.ap_id === post.apId &&
              entry.content === post.content &&
              entry.author?.ap_id === actorApId,
          ),
        ),
      "route.fetch did not hold the exact real Worker Following response containing M1/M2",
    );
    requireDeleteResponse(
      followingRequestCount.requests === 1 &&
        followingRequestCount.responses === 0,
      "held Following GET was not the sole outstanding native request",
    );
    await clickTab(page, "すべて");
    requireDeleteResponse(
      (await visiblePost(page, m1.content)) &&
        (await visiblePost(page, m2.content)),
      "return to existing unified cache did not retain M1/M2 while Following response was held",
    );

    const failedDelete = await failDeleteBeforeWorker(page, db, m2);
    await page.getByRole("button", { name: "戻る", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
    await clickTab(page, "すべて");
    requireDeleteResponse(
      (await visiblePost(page, m1.content)) &&
        (await visiblePost(page, m2.content)),
      "failed M2 delete did not preserve the existing unified list",
    );

    await openDetail(page, m1);
    const deleteResult = await confirmDelete(page, m1.apId);
    const deletedM1 = await readObject(db, m1.apId);
    const retainedM2 = await readObject(db, m2.apId);
    requireDeleteResponse(
      deletedM1 === null &&
        retainedM2?.ap_id === m2.apId &&
        retainedM2.deleted_at === null,
      "real M1 DELETE did not remove M1 from D1 while retaining M2",
    );
    await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
    await clickTab(page, "すべて");
    await page
      .getByText(m2.content, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    requireDeleteResponse(
      !(await visiblePost(page, m1.content)),
      "unified feed did not remove M1 after successful DELETE and back",
    );
    requireDeleteResponse(
      followingRequestCount.requests === 1 &&
        followingRequestCount.responses === 0,
      "Following response was unexpectedly delivered/refetched before its explicit release",
    );

    const deliveredResponsePromise = expectResponse(
      page,
      new URL("/api/timeline/following", localOrigin).href,
      "GET",
      "late held Following delivery",
    );
    hold.release();
    const response = await deliveredResponsePromise;
    const delivered = await hold.delivered;
    requireDeleteResponse(
      response.status() === 200 &&
        delivered.status === 200 &&
        hold.error === null &&
        hold.requestCount === 1 &&
        followingRequestCount.requests === 1 &&
        followingRequestCount.responses === 1,
      "late response was not delivered as the one original Following request",
    );
    const deliveredBody = await response.json().catch(() => null);
    requireDeleteResponse(
      [m1, m2].every((post) =>
        deliveredBody?.posts?.some(
          (entry) =>
            entry.ap_id === post.apId &&
            entry.content === post.content &&
            entry.author?.ap_id === actorApId,
        ),
      ),
      "delivered Following response bytes were not the held pre-DELETE Worker snapshot",
    );
    await bounded(hold.finished, "following route completion");
    // The response event is emitted before the client query and Jotai atom
    // updates commit. Let those already-scheduled UI tasks drain before tab
    // selection; otherwise a too-early selection could initiate a second GET.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.unroute("**/api/timeline/following**", hold.handler);
    holdRouteInstalled = false;

    await clickTab(page, "フォロー中");
    await page
      .getByText(m2.content, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    const visibleAfterLateResponse = {
      m1: await visiblePost(page, m1.content),
      m2: await visiblePost(page, m2.content),
    };
    const after = await countRows(db);
    const cookieAfter = (await page.context().cookies(origin)).find(
      (cookie) => cookie.name === "session",
    );
    requireDeleteResponse(
      JSON.stringify(before) === JSON.stringify(after) &&
        cookieAfter?.value === cookieBefore.value,
      "late response fixture changed owner/session counts or cookie",
    );
    requireDeleteResponse(
      followingRequestCount.requests === 1 &&
        followingRequestCount.responses === 1,
      "late response qualification used an additional Following request/response",
    );
    requireDeleteResponse(
      pageErrors.length === 0 && serverErrors.length === 0,
      `browser or Worker raised errors: ${JSON.stringify({ pageErrors, serverErrors })}`,
    );
    const expectedM1Visible = mode === "baseline-red";
    requireDeleteResponse(
      visibleAfterLateResponse.m1 === expectedM1Visible &&
        visibleAfterLateResponse.m2,
      `late Following snapshot state mismatch for ${mode}: ${JSON.stringify(visibleAfterLateResponse)}`,
    );

    const checksForMode = [
      "browser-delete-response-real-public-posts-and-unified-get",
      "browser-delete-response-holds-real-native-following-get-with-m1-m2",
      "browser-delete-response-pre-worker-failed-m2-delete-preserves-native-ui",
      "browser-delete-response-real-delete-removes-native-m1-keeps-m2",
      mode === "baseline-red"
        ? "browser-delete-response-baseline-red-late-snapshot-resurrects-m1"
        : "browser-delete-response-green-late-snapshot-suppresses-deleted-m1",
      "browser-delete-response-same-session-one-following-request-response",
    ];
    checks.push(...checksForMode);
    return {
      result: mode === "baseline-red" ? "EXPECTED_BASELINE_RED" : "green",
      mode,
      actorApId,
      actorSessionCounts: { before, afterPosts, after },
      sameSession: cookieBefore.value === cookieAfter.value,
      posts: { m1, m2 },
      native: { m1: deletedM1, m2: retainedM2 },
      failedDelete,
      successfulDelete: deleteResult,
      unified: {
        status: unifiedResponse.status(),
        includedM1M2: true,
        m1VisibleBeforeDelete: true,
        m1VisibleAfterDelete: false,
      },
      heldFollowing: {
        status: held.responseStatus,
        includedM1M2: true,
        requestCount: followingRequestCount.requests,
        responseCount: followingRequestCount.responses,
        deliveredAfterNativeDelete: true,
        bodyPostIds: deliveredBody.posts.map((post) => post.ap_id),
      },
      visibleAfterLateResponse,
      pageErrors,
      serverErrors,
      checks: checksForMode,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    page.off("pageerror", capturePageError);
    page.off("response", captureServerError);
    if (countFollowingRequest) page.off("request", countFollowingRequest);
    if (countFollowingResponse) page.off("response", countFollowingResponse);
    if (hold) {
      if (!hold.isReleased) hold.release();
      if (hold.requestCount > 0) {
        try {
          await hold.finished;
        } catch (cleanupError) {
          if (!primaryError) throw cleanupError;
        }
      }
      if (holdRouteInstalled) {
        await page.unroute("**/api/timeline/following**", hold.handler);
      }
    }
  }
}
