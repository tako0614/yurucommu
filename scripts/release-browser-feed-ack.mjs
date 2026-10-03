// Native-browser race qualification for creation ACKs crossing a real full-feed
// response. Every request below reaches the local Worker and is fulfilled with
// its original response bytes; only browser delivery timing is controlled.

import { createHash } from "node:crypto";

function requireFeedAck(condition, message) {
  if (!condition) throw new Error(`browser-feed-ack ${message}`);
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
      () => reject(new Error(`browser-feed-ack ${label} timed out`)),
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

async function actorSessionCounts(db) {
  return db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
}

async function verifyCreatedPost(db, post, actorApId) {
  const object = await db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
    )
    .bind(post.apId)
    .first();
  const create = await db
    .prepare(
      "SELECT a.ap_id, a.type, a.actor_ap_id, a.object_ap_id, a.direction FROM activities a WHERE a.type = 'Create' AND a.actor_ap_id = ? AND a.object_ap_id = ? AND a.direction = 'outbound'",
    )
    .bind(actorApId, post.apId)
    .first();
  const noteCounts = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM objects WHERE ap_id = ? AND type = 'Note' AND attributed_to = ? AND content = ? AND visibility = 'public' AND deleted_at IS NULL",
    )
    .bind(post.apId, actorApId, post.content)
    .first();
  const createCounts = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id = ? AND direction = 'outbound'",
    )
    .bind(actorApId, post.apId)
    .first();
  requireFeedAck(
    object?.ap_id === post.apId &&
      object.type === "Note" &&
      object.attributed_to === actorApId &&
      object.content === post.content &&
      object.visibility === "public" &&
      object.deleted_at === null &&
      create?.type === "Create" &&
      create.actor_ap_id === actorApId &&
      create.object_ap_id === post.apId &&
      create.direction === "outbound" &&
      noteCounts?.count === 1 &&
      createCounts?.count === 1,
    `native Note/Create persistence did not match exactly one acknowledged post: ${JSON.stringify({ object, create, noteCount: noteCounts?.count, createCount: createCounts?.count })}`,
  );
  return {
    object,
    create,
    counts: { notes: noteCounts.count, outboundCreates: createCounts.count },
  };
}

function canonicalPostLink(page, apId, content) {
  const path = `/post/${encodeURIComponent(apId)}`;
  const feed = page.locator("div.relative.flex-1.overflow-y-auto:visible");
  return feed.locator(`a[href="${path}"]`).filter({
    has: page.getByText(content, { exact: true }),
  });
}

async function canonicalPostCount(page, post) {
  return canonicalPostLink(page, post.apId, post.content).count();
}

async function waitCanonicalPostCount(page, post, expected, lane, phase) {
  const deadline = Date.now() + 10_000;
  let actual = -1;
  do {
    actual = await canonicalPostCount(page, post);
    if (actual === expected) return actual;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  requireFeedAck(
    false,
    `${lane} ${phase} expected canonical post link count ${expected}, observed ${actual}: ${JSON.stringify(post)}`,
  );
}

async function settleDeliveredHead(page, routes, origin, pathname) {
  const responsePromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        url.pathname === pathname &&
        response.request().method() === "GET" &&
        url.searchParams.get("limit") === "20" &&
        !url.searchParams.has("before")
      );
    },
    { timeout: 20_000 },
  );
  responsePromise.catch(() => {});
  routes.releaseHead();
  const response = await bounded(
    responsePromise,
    "page full-head response",
    20_000,
  );
  await routes.headDelivery;
  await routes.waitIdle();
  const renderOpportunity = await bounded(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve({ animationFrames: 2 }));
          });
        }),
    ),
    "full-head client render opportunity",
    10_000,
  );
  return {
    response: {
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
    },
    ...renderOpportunity,
    routeHandlersIdle: true,
    limitation:
      "page response, idle route handler, and two animation frames provide a bounded render checkpoint, not proof of durable client quiescence",
  };
}

async function installObserverControl(context) {
  await context.addInitScript(() => {
    const proto = IntersectionObserver.prototype;
    if (proto.__feedAckWrapped) return;
    const observe = proto.observe;
    Object.defineProperty(proto, "__feedAckWrapped", { value: true });
    window.__feedAckObserverControl = {
      timelineSentinelSuppressed: true,
      timelineSentinelObserveCalls: 0,
      otherTargetsDelegated: 0,
    };
    proto.observe = function (target) {
      if (
        target instanceof Element &&
        target.matches('.h-px[aria-hidden="true"]')
      ) {
        window.__feedAckObserverControl.timelineSentinelObserveCalls += 1;
        return;
      }
      window.__feedAckObserverControl.otherTargetsDelegated += 1;
      return observe.call(this, target);
    };
  });
}

async function advanceClientClock(page) {
  return page.evaluate(() => {
    const original = window.__feedAckDateNowOriginal ?? Date.now.bind(Date);
    window.__feedAckDateNowOriginal = original;
    const offsetMs = (window.__feedAckDateNowOffset ?? 0) + 61_000;
    window.__feedAckDateNowOffset = offsetMs;
    Date.now = () => original() + window.__feedAckDateNowOffset;
    return { offsetMs, observedNow: Date.now(), originalNow: original() };
  });
}

async function waitForHomeFeed(page) {
  await page.getByRole("tab", { name: "すべて", exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
}

async function selectLane(page, lane, origin, support) {
  const label = lane === "unified" ? "すべて" : "フォロー中";
  const pathname =
    lane === "unified" ? "/api/timeline" : "/api/timeline/following";
  const tab = page.getByRole("tab", { name: label, exact: true });
  await tab.waitFor({ state: "visible", timeout: 10_000 });
  const selectedBefore = (await tab.getAttribute("aria-selected")) === "true";
  let preflightHead = null;
  if (!selectedBefore) {
    const responsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === origin &&
          url.pathname === pathname &&
          response.request().method() === "GET" &&
          url.searchParams.get("limit") === "20" &&
          !url.searchParams.has("before")
        );
      },
      { timeout: 20_000 },
    );
    responsePromise.catch(() => {});
    await tab.click();
    const response = await responsePromise;
    requireFeedAck(
      response.status() === 200,
      `${lane} preflight full head failed (${response.status()})`,
    );
    preflightHead = {
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
    };
  }
  const supportVisibleCopies = await waitCanonicalPostCount(
    page,
    support,
    1,
    lane,
    "pre-race lane head",
  );
  return {
    lane,
    tab: label,
    selectedBefore,
    preflightHead,
    supportVisibleCopies,
  };
}

async function openComposer(page, content) {
  const trigger = page
    .getByRole("button", { name: "投稿", exact: true })
    .filter({ visible: true })
    .first();
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "今なにしてる？" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("今なにしてる？").fill(content);
  await dialog.locator("#post-visibility").selectOption("public");
  return dialog;
}

async function submitComposer(page, dialog) {
  await dialog.getByRole("button", { name: "投稿", exact: true }).click();
}

async function createAcknowledgedPost(page, db, actorApId, content) {
  const requestPromise = page.waitForRequest(
    (request) => {
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/posts"
      )
        return false;
      try {
        return request.postDataJSON()?.content === content;
      } catch {
        return false;
      }
    },
    { timeout: 20_000 },
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/posts" &&
      (() => {
        try {
          return response.request().postDataJSON()?.content === content;
        } catch {
          return false;
        }
      })(),
    { timeout: 20_000 },
  );
  requestPromise.catch(() => {});
  responsePromise.catch(() => {});
  const dialog = await openComposer(page, content);
  await submitComposer(page, dialog);
  const request = await requestPromise;
  const response = await responsePromise;
  const body = await response.json().catch(() => null);
  const value = body?.post;
  requireFeedAck(
    response.status() === 200 &&
      typeof value?.ap_id === "string" &&
      value.type === "Note" &&
      value.author?.ap_id === actorApId &&
      value.content === content &&
      value.visibility === "public",
    `real composer POST did not return the expected public Note (${response.status()}): ${JSON.stringify(body)}`,
  );
  const post = { apId: value.ap_id, content };
  const native = await verifyCreatedPost(db, post, actorApId);
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  await waitCanonicalPostCount(page, post, 1, "ui", "creation ACK display");
  return {
    post,
    native,
    request: {
      method: request.method(),
      url: request.url(),
      content: request.postDataJSON()?.content,
    },
    response: { status: response.status(), body },
  };
}

function installRaceRoutes(
  page,
  origin,
  pathname,
  postContent = null,
  holdPostResponse = false,
) {
  const headReady = gate("real full-head GET response available");
  const headDelivered = gate("full-head response delivered");
  const postReady = gate("real creation POST response available");
  const postDelivered = gate("creation POST response delivered");
  const releaseHead = gate("full-head release");
  const releasePost = gate("creation POST release");
  const records = [];
  const unexpected = [];
  let getRequests = 0;
  let postRequests = 0;
  let active = 0;
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
    const url = new URL(request.url());
    if (
      url.origin !== origin ||
      (url.pathname !== pathname && url.pathname !== "/api/posts")
    ) {
      await route.fallback();
      return;
    }
    const isHead = request.method() === "GET";
    const isPost = request.method() === "POST" && url.pathname === "/api/posts";
    let holdPost = false;
    if (isHead) {
      if (url.pathname !== pathname) {
        await route.fallback();
        return;
      }
      getRequests += 1;
      if (url.searchParams.has("before") || getRequests > 1) {
        unexpected.push({ method: request.method(), url: url.href });
        await route.fallback();
        return;
      }
      requireFeedAck(
        url.searchParams.get("limit") === "20",
        `full GET changed the published limit: ${url.href}`,
      );
    } else if (isPost && postContent !== null) {
      const requestBody = request.postDataJSON();
      if (requestBody?.content !== postContent) {
        await route.fallback();
        return;
      }
      postRequests += 1;
      holdPost = holdPostResponse;
      if (postRequests > 1) {
        unexpected.push({
          method: request.method(),
          url: url.href,
          content: requestBody?.content,
        });
        await route.abort("failed");
        return;
      }
    } else {
      await route.fallback();
      return;
    }
    active += 1;
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      const rawBody = await response.body();
      let body;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch (cause) {
        throw new Error(`real Worker response was not JSON: ${String(cause)}`);
      }
      const record = {
        method: request.method(),
        sourceUrl: url.href,
        status: response.status(),
        body,
        rawBody,
        rawBodySha256: createHash("sha256").update(rawBody).digest("hex"),
        fulfilledBodySha256: null,
        held: isHead || holdPost,
      };
      records.push(record);
      if (isHead) {
        headReady.resolve(record);
        await bounded(releaseHead.promise, "full-head route release", 60_000);
        await route.fulfill({ response, body: rawBody });
        record.fulfilledBodySha256 = createHash("sha256")
          .update(rawBody)
          .digest("hex");
        headDelivered.resolve(record);
      } else if (holdPost) {
        postReady.resolve(record);
        await bounded(
          releasePost.promise,
          "creation POST route release",
          60_000,
        );
        await route.fulfill({ response, body: rawBody });
        record.fulfilledBodySha256 = createHash("sha256")
          .update(rawBody)
          .digest("hex");
        postDelivered.resolve(record);
      } else {
        await route.fulfill({ response, body: rawBody });
        record.fulfilledBodySha256 = createHash("sha256")
          .update(rawBody)
          .digest("hex");
        postDelivered.resolve(record);
      }
    } catch (cause) {
      error = cause;
      if (isHead) {
        headReady.reject(cause);
        headDelivered.reject(cause);
      }
      if (holdPost) {
        postReady.reject(cause);
        postDelivered.reject(cause);
      }
      try {
        await route.abort("failed");
      } catch {
        // Keep the original Worker fetch or delivery failure.
      }
    } finally {
      finish();
    }
  };
  return {
    handler,
    records,
    get head() {
      return bounded(headReady.promise, "full-head Worker response", 20_000);
    },
    get headDelivery() {
      return bounded(headDelivered.promise, "full-head delivery", 20_000);
    },
    get post() {
      return bounded(
        postReady.promise,
        "creation POST Worker response",
        20_000,
      );
    },
    get postDelivery() {
      return bounded(postDelivered.promise, "creation POST delivery", 20_000);
    },
    releaseHead() {
      releaseHead.resolve();
    },
    releasePost() {
      releasePost.resolve();
    },
    get counts() {
      return { getRequests, postRequests, responseRecords: records.length };
    },
    get unexpected() {
      return [...unexpected];
    },
    get error() {
      return error;
    },
    waitIdle() {
      if (active === 0) return Promise.resolve();
      return bounded(
        new Promise((resolve) => idleWaiters.push(resolve)),
        "route handlers idle",
        20_000,
      );
    },
  };
}

async function withRoutes(page, origin, pathname, heldPostContent, run) {
  const routes = installRaceRoutes(
    page,
    origin,
    pathname,
    heldPostContent?.content ?? null,
    heldPostContent?.hold ?? false,
  );
  let installed = false;
  let primaryError;
  try {
    await page.route(`**${pathname}**`, routes.handler);
    await page.route(`${origin}/api/posts`, routes.handler);
    installed = true;
    return await run(routes);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    routes.releaseHead();
    routes.releasePost();
    if (installed) {
      await page.unroute(`${origin}/api/posts`, routes.handler);
      await page.unroute(`**${pathname}**`, routes.handler);
    }
    try {
      await routes.waitIdle();
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}

async function returnFromSupport(page, support) {
  const link = canonicalPostLink(page, support.apId, support.content);
  await waitCanonicalPostCount(page, support, 1, "navigation", "support entry");
  await link.waitFor({ state: "visible", timeout: 10_000 });
  await link.click();
  const detail = `/post/${encodeURIComponent(support.apId)}`;
  await page.waitForURL((url) => url.pathname === detail, { timeout: 10_000 });
}

async function backToHome(page) {
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 });
  await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
  await waitForHomeFeed(page);
}

async function routeSummary(record) {
  if (!record) return null;
  return {
    method: record.method,
    sourceUrl: record.sourceUrl,
    status: record.status,
    body: record.body,
    rawBodySha256: record.rawBodySha256,
    fulfilledBodySha256: record.fulfilledBodySha256,
  };
}

async function runHeadBeforePostRace({
  page,
  db,
  origin,
  actorApId,
  lane,
  mode,
  support,
  suffix,
}) {
  const laneSelection = await selectLane(page, lane, origin, support);
  const headTimeControl = await advanceClientClock(page);
  const pathname =
    lane === "following" ? "/api/timeline/following" : "/api/timeline";
  const content = `Feed ACK ${lane} head-first ${suffix}`;
  return withRoutes(
    page,
    origin,
    pathname,
    { content, hold: false },
    async (routes) => {
      const headPromise = routes.head;
      await returnFromSupport(page, support);
      await backToHome(page);
      const head = await headPromise;
      requireFeedAck(
        head.status === 200 &&
          Array.isArray(head.body?.posts) &&
          typeof head.body.has_more === "boolean" &&
          (head.body.next_cursor === null ||
            typeof head.body.next_cursor === "string") &&
          head.body.posts.every(
            (post) =>
              typeof post.ap_id === "string" &&
              typeof post.author?.ap_id === "string" &&
              typeof post.content === "string",
          ),
        `${lane} pre-POST full head lacked real rows/cursor/hasMore: ${JSON.stringify(await routeSummary(head))}`,
      );
      const post = await createAcknowledgedPost(page, db, actorApId, content);
      requireFeedAck(
        !head.body.posts.some((row) => row.ap_id === post.post.apId) &&
          routes.counts.getRequests === 1 &&
          routes.counts.postRequests === 1,
        `${lane} head-first response was not captured before its single POST: ${JSON.stringify({ head: await routeSummary(head), post: post.post, routeCounts: routes.counts })}`,
      );
      const beforeRelease = await canonicalPostCount(page, post.post);
      requireFeedAck(
        beforeRelease === 1 && routes.error === null,
        `${lane} creation ACK was not displayed once before releasing old head: ${JSON.stringify({ beforeRelease, routeCounts: routes.counts, routeError: String(routes.error) })}`,
      );
      const headSettlement = await settleDeliveredHead(
        page,
        routes,
        origin,
        pathname,
      );
      const expected = mode === "green" ? 1 : 0;
      await waitCanonicalPostCount(
        page,
        post.post,
        expected,
        lane,
        "head-first post after stale head delivery",
      );
      const outcome = {
        lane,
        laneSelection,
        headTimeControl,
        ordering: "head-response-before-post-ack",
        post: { ...post.post, native: post.native },
        head: await routeSummary(head),
        headSettlement,
        expectedVisibleCopies: expected,
        visibleCopiesAfterHead: await canonicalPostCount(page, post.post),
        routeCounts: routes.counts,
        routeError: routes.error ? String(routes.error) : null,
        unexpectedRequests: routes.unexpected,
      };
      requireFeedAck(
        routes.counts.getRequests === 1 &&
          routes.counts.postRequests === 1 &&
          routes.records.length === 2 &&
          routes.error === null &&
          routes.unexpected.length === 0,
        `${lane} head-first race request count changed: ${JSON.stringify(outcome)}`,
      );
      return outcome;
    },
  );
}

async function runPostBeforeHeadRace({
  page,
  db,
  origin,
  actorApId,
  lane,
  mode,
  support,
  suffix,
}) {
  const laneSelection = await selectLane(page, lane, origin, support);
  const pathname =
    lane === "following" ? "/api/timeline/following" : "/api/timeline";
  const content = `Feed ACK ${lane} post-first ${suffix}`;
  await returnFromSupport(page, support);
  const dialog = await openComposer(page, content);
  return withRoutes(
    page,
    origin,
    pathname,
    { content, hold: true },
    async (routes) => {
      const postPromise = routes.post;
      await submitComposer(page, dialog);
      const postRecord = await postPromise;
      const value = postRecord.body?.post;
      requireFeedAck(
        postRecord.status === 200 &&
          typeof value?.ap_id === "string" &&
          value.type === "Note" &&
          value.author?.ap_id === actorApId &&
          value.content === content &&
          value.visibility === "public",
        `${lane} post-first Worker response was not one real public Note: ${JSON.stringify(await routeSummary(postRecord))}`,
      );
      const post = { apId: value.ap_id, content };
      const native = await verifyCreatedPost(db, post, actorApId);
      const postCommitCounts = await actorSessionCounts(db);
      const headTimeControl = await advanceClientClock(page);
      await backToHome(page);
      const head = await routes.head;
      requireFeedAck(
        head.status === 200 &&
          Array.isArray(head.body?.posts) &&
          head.body.posts.some(
            (row) =>
              row.ap_id === post.apId &&
              row.author?.ap_id === actorApId &&
              row.content === content,
          ) &&
          typeof head.body.has_more === "boolean" &&
          (head.body.next_cursor === null ||
            typeof head.body.next_cursor === "string") &&
          new URL(head.sourceUrl).searchParams.get("limit") === "20",
        `${lane} post-first full head did not read the committed Note from Worker: ${JSON.stringify(await routeSummary(head))}`,
      );
      routes.releaseHead();
      await routes.headDelivery;
      await waitCanonicalPostCount(
        page,
        post,
        1,
        lane,
        "committed post in full head before POST ACK",
      );
      const beforeAck = await canonicalPostCount(page, post);
      requireFeedAck(
        beforeAck === 1 &&
          routes.counts.getRequests === 1 &&
          routes.counts.postRequests === 1,
        `${lane} committed post was not represented once before releasing its POST response: ${JSON.stringify({ beforeAck, routeCounts: routes.counts })}`,
      );

      routes.releasePost();
      await routes.postDelivery;
      await dialog.waitFor({ state: "hidden", timeout: 10_000 });
      const expected = mode === "green" ? 1 : 2;
      await waitCanonicalPostCount(
        page,
        post,
        expected,
        lane,
        "post ACK after full head",
      );
      const afterAck = await canonicalPostCount(page, post);
      const afterCounts = await actorSessionCounts(db);
      const outcome = {
        lane,
        laneSelection,
        headTimeControl,
        ordering: "post-commit-before-full-head-before-post-ack",
        post: { apId: post.apId, content, native },
        delayedPost: {
          ...(await routeSummary(postRecord)),
          responseBodyUnchanged:
            typeof postRecord.rawBodySha256 === "string" &&
            postRecord.rawBodySha256 === postRecord.fulfilledBodySha256,
        },
        head: await routeSummary(head),
        postCommitActorSessionCounts: postCommitCounts,
        expectedVisibleCopies: expected,
        visibleCopiesBeforeAck: beforeAck,
        visibleCopiesAfterAck: afterAck,
        routeCounts: routes.counts,
        routeError: routes.error ? String(routes.error) : null,
        unexpectedRequests: routes.unexpected,
      };
      requireFeedAck(
        routes.counts.getRequests === 1 &&
          routes.counts.postRequests === 1 &&
          routes.records.length === 2 &&
          routes.error === null &&
          routes.unexpected.length === 0 &&
          JSON.stringify(postCommitCounts) === JSON.stringify(afterCounts),
        `${lane} post-first race request count or identity/session scope changed: ${JSON.stringify(outcome)}`,
      );
      return outcome;
    },
  );
}

export async function qualifyBrowserFeedAck({
  page,
  context,
  db,
  origin,
  actorApId,
  checks,
  mode = "green",
}) {
  requireFeedAck(
    page && context && db && Array.isArray(checks),
    "page, context, native D1, and checks are required",
  );
  requireFeedAck(
    mode === "green" || mode === "baseline-red",
    "mode must be green or baseline-red",
  );
  const localOrigin = new URL(origin).origin;
  requireFeedAck(
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
  requireFeedAck(
    owner?.ap_id === actorApId &&
      owner.role === "owner" &&
      owner.deleted_at === null &&
      Boolean(sessionBefore?.value),
    "existing authenticated owner session is required",
  );
  const before = await actorSessionCounts(db);
  await installObserverControl(context);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await waitForHomeFeed(page);
  const initialClockControl = await advanceClientClock(page);
  const suffix = crypto.randomUUID();
  const supportResult = await createAcknowledgedPost(
    page,
    db,
    actorApId,
    `Feed ACK support ${suffix}`,
  );
  const support = supportResult.post;
  const afterSupport = await actorSessionCounts(db);
  requireFeedAck(
    JSON.stringify(before) === JSON.stringify(afterSupport),
    "real UI support Note changed owner/session counts",
  );
  const seededPosts = [
    { ...support, purpose: "real UI navigation anchor, not a race request" },
  ];
  const checksStart = checks.length;
  const races = [];
  for (const lane of ["unified", "following"]) {
    races.push(
      await runHeadBeforePostRace({
        page,
        db,
        origin: localOrigin,
        actorApId,
        lane,
        mode,
        support,
        suffix,
      }),
    );
    races.push(
      await runPostBeforeHeadRace({
        page,
        db,
        origin: localOrigin,
        actorApId,
        lane,
        mode,
        support,
        suffix,
      }),
    );
    checks.push(`browser-feed-ack-${lane}-head-before-post`);
    checks.push(`browser-feed-ack-${lane}-post-before-head`);
  }
  const after = await actorSessionCounts(db);
  const sessionAfter = (await context.cookies(localOrigin)).find(
    (cookie) => cookie.name === "session",
  );
  const observer = await page.evaluate(
    () => window.__feedAckObserverControl ?? null,
  );
  requireFeedAck(
    JSON.stringify(before) === JSON.stringify(after) &&
      sessionBefore.value === sessionAfter?.value &&
      observer?.timelineSentinelSuppressed === true &&
      observer.timelineSentinelObserveCalls >= 0,
    "feed ACK fixture changed owner/session or sentinel-observation scope",
  );
  checks.push("browser-feed-ack-same-owner-session-no-actor-session-drift");
  return {
    result: mode === "baseline-red" ? "EXPECTED_BASELINE_RED" : "green",
    mode,
    actorSessionCounts: { before, afterSupport, after },
    sameSession: sessionBefore.value === sessionAfter?.value,
    seededPosts,
    races,
    control: {
      initialClockControl,
      route:
        "full-feed GET is triggered by a real SPA detail/back remount after frontend Date.now advances by 61 seconds",
      responsePolicy:
        "real local Worker responses; original limit=20 retained; response bytes fulfilled unchanged",
      observer,
      externalRequests: "denied by the owning browser smoke driver",
      supportPost:
        "one real public UI Note used as the detail/back navigation anchor",
    },
    checks: checks.slice(checksStart),
  };
}
