// Empty Following-page qualification: a delayed first page contains a post
// deleted before delivery; manual paging must still request and append older
// live rows when the delayed page is filtered to empty.

function requireDeletePage(condition, message) {
  if (!condition) throw new Error(`browser-delete-page ${message}`);
}

function gate(label) {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  promise.catch(() => {});
  return { promise, resolve, reject, label };
}

async function bounded(promise, label, timeout = 15_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`browser-delete-page ${label} timed out`)),
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
      `browser-delete-page ${label} response missing: ${String(error)}`,
    );
  });
}

async function counts(db) {
  return db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
}

async function object(db, apId) {
  return db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
    )
    .bind(apId)
    .first();
}

async function crossPublishedSecond() {
  const currentSecond = Math.floor(Date.now() / 1000);
  const deadline = Date.now() + 1_500;
  while (
    Math.floor(Date.now() / 1000) === currentSecond &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  requireDeletePage(
    Math.floor(Date.now() / 1000) > currentSecond,
    "could not establish distinct server publication seconds for page ordering",
  );
}

async function createPublicPost(page, db, actorApId, content) {
  const responsePromise = expectResponse(
    page,
    new URL("/api/posts", page.url()).href,
    "POST",
    "public composer post",
  );
  await page.getByRole("button", { name: "投稿", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "今なにしてる？" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("今なにしてる？").fill(content);
  await dialog.locator("#post-visibility").selectOption("public");
  await dialog.getByRole("button", { name: "投稿", exact: true }).click();
  const response = await responsePromise;
  const post = (await response.json().catch(() => null))?.post;
  requireDeletePage(
    response.status() === 200 &&
      typeof post?.ap_id === "string" &&
      post.type === "Note" &&
      post.author?.ap_id === actorApId &&
      post.content === content &&
      post.visibility === "public",
    `composer did not create expected public own Note (${response.status()})`,
  );
  const native = await object(db, post.ap_id);
  requireDeletePage(
    native?.ap_id === post.ap_id &&
      native.type === "Note" &&
      native.attributed_to === actorApId &&
      native.content === content &&
      native.visibility === "public" &&
      native.deleted_at === null,
    "composer-created post is not present in native D1",
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return { apId: post.ap_id, content, native };
}

async function clickTab(page, label) {
  const tab = page.getByRole("tab", { name: label, exact: true });
  await tab.waitFor({ state: "visible", timeout: 10_000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  requireDeletePage(
    (await tab.getAttribute("aria-selected")) === "true",
    `${label} tab was not selected`,
  );
}

async function openDetail(page, post) {
  await page.getByText(post.content, { exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === `/post/${encodeURIComponent(post.apId)}`,
    { timeout: 10_000 },
  );
  await page.getByText(post.content, { exact: true }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
}

async function deleteFromDetail(page, post) {
  await page.getByRole("button", { name: "削除", exact: true }).first().click();
  const dialog = page.getByRole("alertdialog", {
    name: "投稿を削除しますか？",
  });
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  const responsePromise = expectResponse(
    page,
    new URL(`/api/posts/${encodeURIComponent(post.apId)}`, page.url()).href,
    "DELETE",
    "real detail delete",
  );
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  const response = await responsePromise;
  requireDeletePage(response.ok(), `DELETE failed (${response.status()})`);
  return { status: response.status(), path: new URL(response.url()).pathname };
}

function holdFirstFollowingPage(page, origin) {
  const ready = gate("real page-size-one Following snapshot ready");
  const release = gate("Following snapshot delivery released");
  const delivered = gate("Following snapshot consumed by browser");
  const finished = gate("Following route handler finished");
  let requestCount = 0;
  let responseCount = 0;
  let active = 0;
  let firstFinished = false;
  let sourceUrl = null;
  let nativeUrl = null;
  let responseStatus = null;
  let body = null;
  let rawBody = null;
  let error = null;
  let isReleased = false;
  const path = "/api/timeline/following";
  const finish = (first) => {
    active -= 1;
    if (first) firstFinished = true;
    if (firstFinished && active === 0) finished.resolve();
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
    active += 1;
    if (requestCount !== 1) {
      error = new Error("unexpected additional Following GET during held page");
      try {
        await route.abort("failed");
      } finally {
        ready.reject(error);
        delivered.reject(error);
        finish(false);
      }
      return;
    }
    sourceUrl = request.url();
    const nativeRequestUrl = new URL(sourceUrl);
    nativeRequestUrl.searchParams.set("limit", "1");
    nativeUrl = nativeRequestUrl.href;
    try {
      const response = await route.fetch({
        url: nativeUrl,
        maxRedirects: 0,
        timeout: 15_000,
      });
      responseStatus = response.status();
      rawBody = await response.body();
      body = JSON.parse(rawBody.toString("utf8"));
      responseCount += 1;
      ready.resolve({ responseStatus, body, sourceUrl, nativeUrl });
      await bounded(release.promise, "held first-page release", 60_000);
      isReleased = true;
      await route.fulfill({ response, body: rawBody });
      delivered.resolve({ status: responseStatus, body });
    } catch (caught) {
      error = caught;
      ready.reject(caught);
      delivered.reject(caught);
      try {
        await route.abort("failed");
      } catch {
        // Preserve the route fetch/fulfill error.
      }
    } finally {
      finish(true);
    }
  };
  return {
    handler,
    ready: bounded(ready.promise, "held real Following page", 20_000),
    get delivered() {
      return bounded(
        delivered.promise,
        "Following page client delivery",
        20_000,
      );
    },
    get finished() {
      return bounded(finished.promise, "Following page cleanup", 20_000);
    },
    release() {
      isReleased = true;
      release.resolve();
    },
    get requestCount() {
      return requestCount;
    },
    get responseCount() {
      return responseCount;
    },
    get sourceUrl() {
      return sourceUrl;
    },
    get nativeUrl() {
      return nativeUrl;
    },
    get responseStatus() {
      return responseStatus;
    },
    get body() {
      return body;
    },
    get rawBody() {
      return rawBody;
    },
    get error() {
      return error;
    },
    get isReleased() {
      return isReleased;
    },
  };
}

export async function qualifyBrowserDeletedPage({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  requireDeletePage(
    page && db && Array.isArray(checks),
    "page, D1, checks are required",
  );
  const localOrigin = new URL(origin).origin;
  requireDeletePage(
    ["127.0.0.1", "localhost"].includes(new URL(localOrigin).hostname) &&
      new URL(actorApId).origin === localOrigin,
    "fixture is restricted to the authenticated loopback Worker owner",
  );
  const before = await counts(db);
  const sessionBefore = (await page.context().cookies(origin)).find(
    (cookie) => cookie.name === "session",
  );
  const owner = await db
    .prepare("SELECT ap_id, role FROM actors WHERE ap_id = ?")
    .bind(actorApId)
    .first();
  requireDeletePage(
    sessionBefore?.value &&
      owner?.ap_id === actorApId &&
      owner.role === "owner",
    "existing root owner and session are required",
  );
  const suffix = crypto.randomUUID();
  const survivor = await createPublicPost(
    page,
    db,
    actorApId,
    `Deleted page survivor ${suffix}`,
  );
  // Core stores publication timestamps at second precision. Cross the next
  // boundary so the target is provably newer and limit=1 returns it first.
  await crossPublishedSecond();
  const target = await createPublicPost(
    page,
    db,
    actorApId,
    `Deleted page target ${suffix}`,
  );
  const afterPosts = await counts(db);
  requireDeletePage(
    JSON.stringify(before) === JSON.stringify(afterPosts),
    "creating public posts changed actor/session counts",
  );

  let hold;
  let holdInstalled = false;
  let primaryError;
  let pageErrors = [];
  let serverErrors = [];
  const requestCounts = {
    followingRequests: 0,
    followingResponses: 0,
    cursorRequests: 0,
    cursorResponses: 0,
  };
  const countRequests = (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.origin === localOrigin &&
      url.pathname === "/api/timeline/following"
    ) {
      requestCounts.followingRequests += 1;
      if (url.searchParams.has("before")) requestCounts.cursorRequests += 1;
    }
  };
  const countPageResponse = (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "GET" &&
      url.origin === localOrigin &&
      url.pathname === "/api/timeline/following" &&
      url.searchParams.has("before")
    ) {
      requestCounts.followingResponses += 1;
      requestCounts.cursorResponses += 1;
    } else if (
      response.request().method() === "GET" &&
      url.origin === localOrigin &&
      url.pathname === "/api/timeline/following"
    ) {
      requestCounts.followingResponses += 1;
    }
  };
  const capturePageError = (error) => pageErrors.push(error.message);
  const captureServerError = (response) => {
    if (response.status() >= 500) {
      serverErrors.push({
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
    }
  };
  page.on("request", countRequests);
  page.on("response", countPageResponse);
  page.on("pageerror", capturePageError);
  page.on("response", captureServerError);
  try {
    const unifiedPromise = expectResponse(
      page,
      new URL("/api/timeline", localOrigin).href,
      "GET",
      "fresh unified timeline",
    );
    await page.goto(new URL("/", localOrigin).href, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const unified = await unifiedPromise;
    requireDeletePage(
      unified.status() === 200,
      `unified GET failed (${unified.status()})`,
    );
    const unifiedBody = await unified.json().catch(() => null);
    for (const post of [survivor, target]) {
      requireDeletePage(
        unifiedBody?.posts?.some(
          (row) =>
            row.ap_id === post.apId &&
            row.content === post.content &&
            row.author?.ap_id === actorApId,
        ),
        `unified GET lacks ${post.content}`,
      );
      await page.getByText(post.content, { exact: true }).waitFor({
        state: "visible",
        timeout: 10_000,
      });
    }

    hold = holdFirstFollowingPage(page, localOrigin);
    await page.route("**/api/timeline/following**", hold.handler);
    holdInstalled = true;
    await clickTab(page, "フォロー中");
    const held = await hold.ready;
    requireDeletePage(
      hold.responseStatus === 200 &&
        held.body?.posts?.length === 1 &&
        held.body.posts[0]?.ap_id === target.apId &&
        held.body.posts[0]?.content === target.content &&
        held.body.posts[0]?.author?.ap_id === actorApId &&
        held.body.posts[0]?.visibility === "public" &&
        held.body.has_more === true &&
        typeof held.body.next_cursor === "string" &&
        held.body.next_cursor.length > 0,
      `limit=1 native Following response was not exactly target + has_more + cursor: ${JSON.stringify(held.body)}`,
    );
    const originalUrl = new URL(hold.sourceUrl);
    const workerUrl = new URL(hold.nativeUrl);
    requireDeletePage(
      originalUrl.pathname === "/api/timeline/following" &&
        originalUrl.searchParams.get("limit") === "20" &&
        workerUrl.searchParams.get("limit") === "1" &&
        hold.requestCount === 1 &&
        hold.responseCount === 1,
      "query override did not preserve the original limit=20 request and make one real limit=1 Worker response",
    );

    await clickTab(page, "すべて");
    await openDetail(page, target);
    const deletion = await deleteFromDetail(page, target);
    const deletedNative = await object(db, target.apId);
    const survivorNative = await object(db, survivor.apId);
    requireDeletePage(
      deletedNative === null &&
        survivorNative?.ap_id === survivor.apId &&
        survivorNative.deleted_at === null,
      "real detail DELETE did not remove target while preserving survivor in native D1",
    );
    await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
    await clickTab(page, "すべて");
    await page
      .getByText(survivor.content, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });

    const heldResponsePromise = expectResponse(
      page,
      new URL("/api/timeline/following", localOrigin).href,
      "GET",
      "delayed first Following response",
    );
    hold.release();
    const heldResponse = await heldResponsePromise;
    const consumed = await hold.delivered;
    requireDeletePage(
      heldResponse.status() === 200 &&
        consumed.status === 200 &&
        hold.error === null &&
        hold.requestCount === 1 &&
        hold.responseCount === 1,
      "delayed Following response was not delivered once from its original request",
    );
    await bounded(hold.finished, "held Following handler completion");
    const deliveredBody = await heldResponse.json().catch(() => null);
    requireDeletePage(
      deliveredBody?.posts?.length === 1 &&
        deliveredBody.posts[0]?.ap_id === target.apId &&
        deliveredBody.posts[0]?.content === target.content &&
        deliveredBody.has_more === true &&
        deliveredBody.next_cursor === held.body.next_cursor,
      "delivered bytes differ from the captured pre-delete Worker snapshot",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.unroute("**/api/timeline/following**", hold.handler);
    holdInstalled = false;

    await clickTab(page, "フォロー中");
    const zeroRows =
      !(await page
        .getByText(target.content, { exact: true })
        .isVisible()
        .catch(() => false)) &&
      !(await page
        .getByText(survivor.content, { exact: true })
        .isVisible()
        .catch(() => false));
    requireDeletePage(
      zeroRows &&
        (await page
          .getByRole("button", { name: "もっと見る", exact: true })
          .isVisible()),
      "deleted-only page did not leave empty Following list with manual paging available",
    );
    const nextUrl = new URL("/api/timeline/following", localOrigin);
    nextUrl.searchParams.set("limit", "20");
    nextUrl.searchParams.set("before", held.body.next_cursor);
    const pageResponsePromise = expectResponse(
      page,
      nextUrl.href,
      "GET",
      "manual Following next page",
      20_000,
    );
    await page.getByRole("button", { name: "もっと見る", exact: true }).click();
    const pageResponse = await pageResponsePromise;
    const manualPageUrl = new URL(pageResponse.url());
    requireDeletePage(
      pageResponse.status() === 200 &&
        manualPageUrl.searchParams.get("limit") === "20" &&
        manualPageUrl.searchParams.get("before") === held.body.next_cursor,
      `manual Following page GET did not use limit=20 and the held next_cursor (${pageResponse.status()}, ${manualPageUrl.href})`,
    );
    const pageBody = await pageResponse.json().catch(() => null);
    requireDeletePage(
      pageBody?.posts?.some(
        (row) =>
          row.ap_id === survivor.apId &&
          row.content === survivor.content &&
          row.author?.ap_id === actorApId &&
          row.visibility === "public",
      ) && !pageBody.posts.some((row) => row.ap_id === target.apId),
      `manual native next page did not contain survivor or still contained deleted target: ${JSON.stringify(pageBody?.posts?.map((row) => row.ap_id))}`,
    );
    await page
      .getByText(survivor.content, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    requireDeletePage(
      !(await page
        .getByText(target.content, { exact: true })
        .isVisible()
        .catch(() => false)),
      "deleted target reappeared after manual Following pagination",
    );
    const nativeTargetAfterPage = await object(db, target.apId);
    const nativeSurvivorAfterPage = await object(db, survivor.apId);
    const after = await counts(db);
    const sessionAfter = (await page.context().cookies(origin)).find(
      (cookie) => cookie.name === "session",
    );
    requireDeletePage(
      nativeTargetAfterPage === null &&
        nativeSurvivorAfterPage?.ap_id === survivor.apId &&
        JSON.stringify(before) === JSON.stringify(after) &&
        sessionAfter?.value === sessionBefore.value,
      "pagination changed native delete/survivor, actor/session counts, or session cookie",
    );
    requireDeletePage(
      requestCounts.followingRequests === 2 &&
        requestCounts.followingResponses === 2 &&
        requestCounts.cursorRequests === 1 &&
        requestCounts.cursorResponses === 1,
      `expected one initial Following request plus one cursor page request/response: ${JSON.stringify(requestCounts)}`,
    );
    requireDeletePage(
      pageErrors.length === 0 && serverErrors.length === 0,
      `browser or Worker errors were observed: ${JSON.stringify({ pageErrors, serverErrors })}`,
    );

    const checksPassed = [
      "browser-delete-page-held-limit-one-real-following-snapshot-has-cursor",
      "browser-delete-page-delete-target-before-delayed-first-page-delivery",
      "browser-delete-page-empty-filtered-page-retains-manual-pagination",
      "browser-delete-page-manual-native-cursor-fetch-restores-survivor",
      "browser-delete-page-same-owner-session-native-d1-boundary",
    ];
    checks.push(...checksPassed);
    return {
      result: "green",
      actorApId,
      actorSessionCounts: { before, afterPosts, after },
      sameSession: sessionBefore.value === sessionAfter.value,
      posts: { survivor, target },
      native: {
        targetAfterDelete: deletedNative,
        survivorAfterDelete: survivorNative,
        targetAfterManualPage: nativeTargetAfterPage,
        survivorAfterManualPage: nativeSurvivorAfterPage,
      },
      successfulDelete: deletion,
      unified: {
        status: unified.status(),
        includedTargetAndSurvivor: true,
      },
      heldFollowing: {
        status: hold.responseStatus,
        sourceUrl: hold.sourceUrl,
        nativeWorkerUrl: hold.nativeUrl,
        originalUrl: hold.sourceUrl,
        overrideUrl: hold.nativeUrl,
        requestCount: hold.requestCount,
        responseCount: hold.responseCount,
        targetOnly: true,
        hasMore: true,
        nextCursor: held.body.next_cursor,
        deliveredAfterDelete: true,
      },
      emptyFilteredPage: {
        zeroRows,
        hasMore: true,
        manualControlVisible: true,
      },
      manualPage: {
        status: pageResponse.status(),
        requestUrl: pageResponse.url(),
        before: held.body.next_cursor,
        survivorPresent: true,
        targetAbsent: true,
      },
      pageErrors,
      serverErrors,
      checks: checksPassed,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    page.off("request", countRequests);
    page.off("response", countPageResponse);
    page.off("pageerror", capturePageError);
    page.off("response", captureServerError);
    if (hold) {
      if (!hold.isReleased) hold.release();
      if (hold.requestCount > 0) {
        try {
          await hold.finished;
        } catch (cleanupError) {
          if (!primaryError) throw cleanupError;
        }
      }
      if (holdInstalled)
        await page.unroute("**/api/timeline/following**", hold.handler);
    }
  }
}
