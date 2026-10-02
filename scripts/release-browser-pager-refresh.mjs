// Native-browser regression for an old-cursor timeline response racing a stale
// full-head refresh. Worker responses are real and fulfilled byte-for-byte.

function requirePagerRefresh(condition, message) {
  if (!condition) throw new Error(`browser-pager-refresh ${message}`);
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
      () => reject(new Error(`browser-pager-refresh ${label} timed out`)),
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

function waitResponse(page, origin, pathname, method, label, timeout = 20_000) {
  const pending = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        url.pathname === pathname &&
        response.request().method() === method
      );
    },
    { timeout },
  );
  pending.catch(() => {});
  return pending.catch((error) => {
    throw new Error(
      `browser-pager-refresh ${label} response missing: ${String(error)}`,
    );
  });
}

async function actorSessionCounts(db) {
  return db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
}

async function nativePost(db, apId, actorApId, content) {
  const row = await db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
    )
    .bind(apId)
    .first();
  requirePagerRefresh(
    row?.ap_id === apId &&
      row.type === "Note" &&
      row.attributed_to === actorApId &&
      row.content === content &&
      row.visibility === "public" &&
      row.deleted_at === null,
    `real public UI post missing from native D1 (${content})`,
  );
  return row;
}

async function crossPublishedSecond() {
  const current = Math.floor(Date.now() / 1000);
  const deadline = Date.now() + 1_600;
  while (Math.floor(Date.now() / 1000) === current && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  requirePagerRefresh(
    Math.floor(Date.now() / 1000) > current,
    "could not establish strict published-second ordering for native pages",
  );
}

async function createPublicPost(page, db, actorApId, content) {
  const responsePromise = waitResponse(
    page,
    new URL(page.url()).origin,
    "/api/posts",
    "POST",
    "real public composer post",
  );
  await page.getByRole("button", { name: "投稿", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "今なにしてる？" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("今なにしてる？").fill(content);
  await dialog.locator("#post-visibility").selectOption("public");
  await dialog.getByRole("button", { name: "投稿", exact: true }).click();
  const response = await responsePromise;
  const post = (await response.json().catch(() => null))?.post;
  requirePagerRefresh(
    response.status() === 200 &&
      typeof post?.ap_id === "string" &&
      post.type === "Note" &&
      post.author?.ap_id === actorApId &&
      post.content === content &&
      post.visibility === "public",
    `real composer did not acknowledge public own Note (${response.status()})`,
  );
  const native = await nativePost(db, post.ap_id, actorApId, content);
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return { apId: post.ap_id, content, native };
}

async function installObserverControl(context) {
  await context.addInitScript(() => {
    const prototype = IntersectionObserver.prototype;
    const observe = prototype.observe;
    window.__pagerRefreshObserverControl = {
      timelineSentinelSuppressed: true,
      timelineSentinelObserveCalls: 0,
      otherTargetsDelegated: 0,
    };
    prototype.observe = function (target) {
      if (
        target instanceof Element &&
        target.matches('.h-px[aria-hidden="true"]')
      ) {
        window.__pagerRefreshObserverControl.timelineSentinelObserveCalls += 1;
        return;
      }
      window.__pagerRefreshObserverControl.otherTargetsDelegated += 1;
      return observe.call(this, target);
    };
  });
}

function installTimelineRoutes(page, origin, pathname) {
  const headReady = gate("initial full head fetched from Worker");
  const refreshedHeadReady = gate("stale-return full head fetched from Worker");
  const oldReady = gate("cursorA response fetched from Worker");
  const newReady = gate("cursorB response fetched from Worker");
  const oldRelease = gate("cursorA delivery release");
  const newRelease = gate("cursorB delivery release");
  const oldDelivered = gate("cursorA response delivered");
  const newDelivered = gate("cursorB response delivered");
  const records = [];
  let active = 0;
  let headCount = 0;
  let pageCount = 0;
  let error = null;
  let idleWaiters = [];
  const finish = () => {
    active -= 1;
    if (active === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters = [];
    }
  };
  const handler = async (route) => {
    const request = route.request();
    const sourceUrl = new URL(request.url());
    if (
      request.method() !== "GET" ||
      sourceUrl.origin !== origin ||
      sourceUrl.pathname !== pathname
    ) {
      await route.fallback();
      return;
    }
    active += 1;
    const isHead = !sourceUrl.searchParams.has("before");
    const headIndex = isHead ? ++headCount : 0;
    const pageIndex = isHead ? 0 : ++pageCount;
    const workerUrl = new URL(sourceUrl);
    workerUrl.searchParams.set("limit", isHead ? "2" : "1");
    try {
      if (headIndex > 2 || pageIndex > 2) {
        throw new Error(
          "unexpected extra timeline request during controlled pager race",
        );
      }
      const response = await route.fetch({
        url: workerUrl.href,
        maxRedirects: 0,
        timeout: 15_000,
      });
      const rawBody = await response.body();
      let body;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch (caught) {
        throw new Error(
          `Worker timeline response was not JSON: ${String(caught)}`,
        );
      }
      const record = {
        sourceUrl: sourceUrl.href,
        workerUrl: workerUrl.href,
        method: request.method(),
        status: response.status(),
        body,
        held: false,
      };
      requirePagerRefresh(
        sourceUrl.searchParams.get("limit") === "20",
        "source timeline request did not preserve limit=20",
      );
      records.push(record);
      let ready;
      let release;
      let delivered;
      if (isHead && headIndex === 1) ready = headReady;
      if (isHead && headIndex === 2) ready = refreshedHeadReady;
      if (!isHead && pageIndex === 1) {
        record.held = true;
        ready = oldReady;
        release = oldRelease;
        delivered = oldDelivered;
      }
      if (!isHead && pageIndex === 2) {
        record.held = true;
        ready = newReady;
        release = newRelease;
        delivered = newDelivered;
      }
      ready?.resolve(record);
      if (release)
        await bounded(release.promise, "held real Worker page release", 60_000);
      await route.fulfill({ response, body: rawBody });
      delivered?.resolve(record);
    } catch (caught) {
      error = caught;
      if (isHead && headIndex === 1) headReady.reject(caught);
      if (isHead && headIndex === 2) refreshedHeadReady.reject(caught);
      if (!isHead && pageIndex === 1) {
        oldReady.reject(caught);
        oldDelivered.reject(caught);
      }
      if (!isHead && pageIndex === 2) {
        newReady.reject(caught);
        newDelivered.reject(caught);
      }
      try {
        await route.abort("failed");
      } catch {
        // Keep the first fetch/fulfill failure.
      }
    } finally {
      finish();
    }
  };
  return {
    handler,
    records,
    get initialHead() {
      return bounded(headReady.promise, "initial native head", 20_000);
    },
    get refreshedHead() {
      return bounded(
        refreshedHeadReady.promise,
        "refreshed native head",
        20_000,
      );
    },
    get oldPage() {
      return bounded(oldReady.promise, "cursorA native page", 20_000);
    },
    get newPage() {
      return bounded(newReady.promise, "cursorB native page", 12_000);
    },
    get oldDelivered() {
      return bounded(oldDelivered.promise, "cursorA delivery", 20_000);
    },
    get newDelivered() {
      return bounded(newDelivered.promise, "cursorB delivery", 20_000);
    },
    releaseOld() {
      oldRelease.resolve();
    },
    releaseNew() {
      newRelease.resolve();
    },
    waitIdle() {
      if (active === 0) return Promise.resolve();
      return bounded(
        new Promise((resolve) => idleWaiters.push(resolve)),
        "route handlers idle",
        20_000,
      );
    },
    get counts() {
      return { heads: headCount, pages: pageCount, records: records.length };
    },
    get error() {
      return error;
    },
  };
}

function rowCount(page, content) {
  return page.locator("article").filter({ hasText: content }).count();
}

async function waitTwoFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function advanceClientClock(page) {
  return page.evaluate(() => {
    const original =
      window.__pagerRefreshDateNowOriginal ?? Date.now.bind(Date);
    window.__pagerRefreshDateNowOriginal = original;
    const offsetMs = (window.__pagerRefreshDateNowOffset ?? 0) + 61_000;
    window.__pagerRefreshDateNowOffset = offsetMs;
    Date.now = () => original() + window.__pagerRefreshDateNowOffset;
    return { offsetMs, observedNow: Date.now(), originalNow: original() };
  });
}

async function returnThroughDetail(page, post) {
  const detail = `/post/${encodeURIComponent(post.apId)}`;
  await page.getByText(post.content, { exact: true }).click();
  await page.waitForURL((url) => url.pathname === detail, { timeout: 10_000 });
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 });
  await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
}

async function settleHead(page, record, expectedContents, lane) {
  requirePagerRefresh(
    record.status === 200 &&
      record.body?.posts?.length === 2 &&
      record.body.posts.map((post) => post.content).join("|") ===
        expectedContents.join("|"),
    `${lane} native full head differed: ${JSON.stringify(record.body)}`,
  );
  for (const content of expectedContents) {
    await page
      .getByText(content, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
  }
}

async function runLane({
  page,
  db,
  origin,
  actorApId,
  lane,
  mode,
  checks,
  actorCounts,
  suffix,
}) {
  const pathname =
    lane === "following" ? "/api/timeline/following" : "/api/timeline";
  const tabName = lane === "following" ? "フォロー中" : "すべて";
  const posts = [];
  await crossPublishedSecond();
  posts.push(
    await createPublicPost(
      page,
      db,
      actorApId,
      `Pager ${lane} oldest ${suffix}`,
    ),
  );
  await crossPublishedSecond();
  posts.push(
    await createPublicPost(
      page,
      db,
      actorApId,
      `Pager ${lane} older ${suffix}`,
    ),
  );
  await crossPublishedSecond();
  posts.push(
    await createPublicPost(page, db, actorApId, `Pager ${lane} head ${suffix}`),
  );
  const interleaved = {
    content: `Pager ${lane} new head ${suffix}`,
    apId: null,
  };
  const content = {
    oldest: posts[0].content,
    older: posts[1].content,
    head: posts[2].content,
    interleaved: interleaved.content,
  };
  const clockControl = await advanceClientClock(page);
  let routes;
  let installed = false;
  let primaryError;
  try {
    const oppositeTab = page.getByRole("tab", {
      name: lane === "unified" ? "フォロー中" : "すべて",
      exact: true,
    });
    await oppositeTab.waitFor({ state: "visible", timeout: 10_000 });
    if ((await oppositeTab.getAttribute("aria-selected")) !== "true")
      await oppositeTab.click();
    routes = installTimelineRoutes(page, origin, pathname);
    await page.route(`**${pathname}**`, routes.handler);
    installed = true;

    const tab = page.getByRole("tab", { name: tabName, exact: true });
    await tab.waitFor({ state: "visible", timeout: 10_000 });
    const headPromise = routes.initialHead;
    await tab.click();
    const initialHead = await headPromise;
    await settleHead(page, initialHead, [content.head, content.older], lane);
    const cursorA = initialHead.body.next_cursor;
    requirePagerRefresh(
      typeof cursorA === "string" &&
        cursorA.length > 0 &&
        initialHead.body.has_more === true &&
        new URL(initialHead.sourceUrl).searchParams.get("limit") === "20" &&
        !new URL(initialHead.sourceUrl).searchParams.has("before") &&
        new URL(initialHead.workerUrl).searchParams.get("limit") === "2",
      `${lane} initial head did not preserve limit=20 request and real limit=2 page`,
    );

    const oldPromise = routes.oldPage;
    await page
      .getByRole("button", { name: "もっと見る", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("button", { name: "もっと見る", exact: true }).click();
    const oldPage = await oldPromise;
    requirePagerRefresh(
      oldPage.status === 200 &&
        oldPage.body?.posts?.length === 1 &&
        oldPage.body.posts[0]?.content === content.oldest &&
        typeof oldPage.body.has_more === "boolean" &&
        new URL(oldPage.sourceUrl).searchParams.get("before") === cursorA &&
        new URL(oldPage.sourceUrl).searchParams.get("limit") === "20" &&
        new URL(oldPage.workerUrl).searchParams.get("limit") === "1",
      `${lane} cursorA response was not one real unchanged native old row`,
    );
    await page
      .getByRole("status", { name: "読み込み中...", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });

    await crossPublishedSecond();
    const newPost = await createPublicPost(
      page,
      db,
      actorApId,
      content.interleaved,
    );
    interleaved.apId = newPost.apId;
    const afterPost = await actorSessionCounts(db);
    requirePagerRefresh(
      JSON.stringify(afterPost) === JSON.stringify(actorCounts),
      `${lane} public post changed actor/session counts`,
    );

    const refreshedPromise = routes.refreshedHead;
    const refreshClockControl = await advanceClientClock(page);
    await returnThroughDetail(page, {
      apId: content.head ? posts[2].apId : "",
      content: content.head,
    });
    const refreshed = await refreshedPromise;
    await page
      .getByText(content.older, { exact: true })
      .waitFor({ state: "hidden", timeout: 10_000 });
    await settleHead(
      page,
      refreshed,
      [content.interleaved, content.head],
      lane,
    );
    const cursorB = refreshed.body.next_cursor;
    requirePagerRefresh(
      refreshed.body.has_more === true &&
        typeof cursorB === "string" &&
        cursorB !== cursorA &&
        new URL(refreshed.sourceUrl).searchParams.get("limit") === "20" &&
        !new URL(refreshed.sourceUrl).searchParams.has("before") &&
        new URL(refreshed.workerUrl).searchParams.get("limit") === "2" &&
        (await rowCount(page, content.oldest)) === 0,
      `${lane} stale return did not commit cursorB and only the refreshed head`,
    );
    const busy = page.getByRole("status", {
      name: "読み込み中...",
      exact: true,
    });
    const more = page.getByRole("button", { name: "もっと見る", exact: true });

    if (mode === "baseline-red") {
      requirePagerRefresh(
        !(await more.isVisible().catch(() => false)) &&
          (await busy.isVisible().catch(() => false)) &&
          routes.counts.heads === 2 &&
          routes.counts.pages === 1 &&
          routes.error === null,
        `${lane} baseline failed to expose the old pager blocking the new cursor`,
      );
      routes.releaseOld();
      const oldDone = await routes.oldDelivered;
      await routes.waitIdle();
      checks.push(
        `browser-pager-refresh-${lane}-baseline-red-current-pager-blocked`,
      );
      return {
        lane,
        result: "EXPECTED_BASELINE_RED",
        cursorA,
        cursorB,
        oldResponseStatus: oldDone.status,
        oldPageHasMore: oldPage.body.has_more,
        pagerBlockedWhileOldPagePending: true,
        routeCounts: routes.counts,
        refreshedRows: [content.interleaved, content.head],
        clockControl,
        refreshClockControl,
      };
    }

    const newPromise = routes.newPage;
    await more.waitFor({ state: "visible", timeout: 10_000 });
    await more.click();
    const newPage = await newPromise;
    requirePagerRefresh(
      newPage.status === 200 &&
        newPage.body?.posts?.length === 1 &&
        newPage.body.posts[0]?.content === content.older &&
        newPage.body.has_more === true &&
        new URL(newPage.sourceUrl).searchParams.get("before") === cursorB &&
        new URL(newPage.sourceUrl).searchParams.get("limit") === "20" &&
        new URL(newPage.workerUrl).searchParams.get("limit") === "1",
      `${lane} refreshed cursorB did not request the expected real native page`,
    );
    await busy.waitFor({ state: "visible", timeout: 10_000 });
    requirePagerRefresh(
      (await rowCount(page, content.older)) === 0,
      `${lane} held cursorB row rendered before its real response was delivered`,
    );

    const oldRequestFinished = page.waitForEvent("requestfinished", {
      predicate: (request) => {
        const url = new URL(request.url());
        return (
          request.method() === "GET" &&
          url.origin === origin &&
          url.pathname === pathname &&
          url.searchParams.get("before") === cursorA &&
          url.searchParams.get("limit") === "20"
        );
      },
      timeout: 20_000,
    });
    oldRequestFinished.catch(() => {});
    routes.releaseOld();
    const oldDone = await routes.oldDelivered;
    await oldRequestFinished;
    await waitTwoFrames(page);
    requirePagerRefresh(
      oldDone.status === 200 &&
        (await busy.isVisible().catch(() => false)) &&
        !(await more.isVisible().catch(() => false)) &&
        (await rowCount(page, content.oldest)) === 0 &&
        (await rowCount(page, content.older)) === 0,
      `${lane} old success cleared the current cursorB pending UI or changed its rows`,
    );

    routes.releaseNew();
    const newDone = await routes.newDelivered;
    await routes.waitIdle();
    await page
      .getByText(content.older, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await busy.waitFor({ state: "hidden", timeout: 10_000 });
    await waitTwoFrames(page);
    requirePagerRefresh(
      newDone.status === 200 &&
        (await rowCount(page, content.older)) === 1 &&
        (await rowCount(page, content.oldest)) === 0 &&
        (await rowCount(page, content.interleaved)) === 1 &&
        (await rowCount(page, content.head)) === 1 &&
        routes.counts.heads === 2 &&
        routes.counts.pages === 2 &&
        routes.error === null,
      `${lane} final UI did not retain head and append only cursorB once`,
    );
    checks.push(`browser-pager-refresh-${lane}-refresh-resets-current-pager`);
    checks.push(
      `browser-pager-refresh-${lane}-old-success-preserves-new-pager`,
    );
    return {
      lane,
      result: "green",
      cursorA,
      cursorB,
      oldResponseStatus: oldDone.status,
      oldPageHasMore: oldPage.body.has_more,
      newResponseStatus: newDone.status,
      cursorBRequestedBeforeOldRelease: true,
      busyAfterOldSuccess: true,
      routeCounts: routes.counts,
      refreshedRows: [content.interleaved, content.head],
      rowsAfterOldSuccess: [content.interleaved, content.head],
      finalRows: [content.interleaved, content.head, content.older],
      clockControl,
      refreshClockControl,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (routes) {
      routes.releaseOld();
      routes.releaseNew();
      if (installed) await page.unroute(`**${pathname}**`, routes.handler);
      try {
        await routes.waitIdle();
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
      }
    }
  }
}

export async function qualifyBrowserPagerRefresh({
  page,
  context,
  db,
  origin,
  actorApId,
  checks,
  mode = "green",
}) {
  requirePagerRefresh(
    page && context && db && Array.isArray(checks),
    "page, context, native D1, and checks are required",
  );
  requirePagerRefresh(
    mode === "green" || mode === "baseline-red",
    "mode must be green or baseline-red",
  );
  const localOrigin = new URL(origin).origin;
  requirePagerRefresh(
    ["127.0.0.1", "localhost"].includes(new URL(localOrigin).hostname) &&
      new URL(actorApId).origin === localOrigin,
    "fixture requires an authenticated loopback Worker owner",
  );
  const owner = await db
    .prepare("SELECT ap_id, role, deleted_at FROM actors WHERE ap_id = ?")
    .bind(actorApId)
    .first();
  const sessionBefore = (await context.cookies(localOrigin)).find(
    (cookie) => cookie.name === "session",
  );
  requirePagerRefresh(
    owner?.ap_id === actorApId &&
      owner.role === "owner" &&
      owner.deleted_at === null &&
      Boolean(sessionBefore?.value),
    "existing authenticated owner session is required",
  );
  const before = await actorSessionCounts(db);
  const suffix = crypto.randomUUID();
  await installObserverControl(context);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await page
    .getByRole("tab", { name: "すべて", exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  const initialClockControl = await advanceClientClock(page);
  const checksStart = checks.length;
  const lanes = [];
  for (const lane of ["unified", "following"]) {
    lanes.push(
      await runLane({
        page,
        db,
        origin: localOrigin,
        actorApId,
        lane,
        mode,
        checks,
        actorCounts: before,
        suffix,
      }),
    );
  }
  const after = await actorSessionCounts(db);
  const sessionAfter = (await context.cookies(localOrigin)).find(
    (cookie) => cookie.name === "session",
  );
  const observer = await page.evaluate(
    () => window.__pagerRefreshObserverControl ?? null,
  );
  requirePagerRefresh(
    JSON.stringify(before) === JSON.stringify(after) &&
      sessionBefore?.value === sessionAfter?.value &&
      observer?.timelineSentinelSuppressed === true &&
      observer.timelineSentinelObserveCalls >= 0,
    "fixture changed owner/session scope or observer suppression control failed",
  );
  checks.push(
    "browser-pager-refresh-same-owner-session-no-actor-session-drift",
  );
  return {
    result: mode === "baseline-red" ? "EXPECTED_BASELINE_RED" : "green",
    mode,
    actorSessionCounts: { before, after },
    sameSession: sessionBefore.value === sessionAfter?.value,
    lanes,
    control: {
      staleTrigger:
        "real SPA post-detail/back remount after page Date.now advances by 61 seconds",
      initialClockControl,
      observer:
        "only timeline sentinel observe suppressed; all other targets delegated",
      response:
        "actual local Worker response bodies; limit query overridden to record head=2 and older=1; fulfilled unchanged",
      externalRequests: "denied by native focused driver",
    },
    checks: checks.slice(checksStart),
  };
}
