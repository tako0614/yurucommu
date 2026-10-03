// Disposable local-native-browser qualification for a Following feed that
// retains a deleted own post after returning from detail while the feed cache
// is still fresh. Only M2's failed DELETE is intercepted before Worker entry.

function requireFollowingDelete(condition, message) {
  if (!condition) throw new Error(`browser-following-delete ${message}`);
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
      `browser-following-delete ${label} response missing: ${String(error)}`,
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

async function createPublicPost(page, db, origin, actorApId, content) {
  const postUrl = new URL("/api/posts", origin).href;
  const responsePromise = expectResponse(
    page,
    postUrl,
    "POST",
    "composer post",
  );
  await page.getByRole("button", { name: "投稿", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "今なにしてる？" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("今なにしてる？").fill(content);
  await dialog.getByRole("button", { name: "投稿", exact: true }).click();
  const response = await responsePromise;
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(
      `browser-following-delete composer POST was not JSON: ${String(error)}`,
    );
  }
  const post = body?.post;
  requireFollowingDelete(
    response.status() === 200 &&
      typeof post?.ap_id === "string" &&
      post.type === "Note" &&
      post.author?.ap_id === actorApId &&
      post.content === content &&
      post.visibility === "public" &&
      Array.isArray(post.attachments) &&
      post.attachments.length === 0,
    `real composer POST did not return the expected public own Note (${response.status()})`,
  );
  const native = await readObject(db, post.ap_id);
  requireFollowingDelete(
    native?.ap_id === post.ap_id &&
      native.type === "Note" &&
      native.attributed_to === actorApId &&
      native.content === content &&
      native.visibility === "public" &&
      native.deleted_at === null,
    "composer POST did not persist the expected public own Note in native D1",
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

async function clickFollowing(page) {
  const tab = page.getByRole("tab", { name: "フォロー中", exact: true });
  await tab.waitFor({ state: "visible", timeout: 10_000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  requireFollowingDelete(
    (await tab.getAttribute("aria-selected")) === "true",
    "Following tab did not remain selected",
  );
}

async function visiblePost(page, content) {
  return page
    .getByText(content, { exact: true })
    .isVisible()
    .catch(() => false);
}

async function openPostDetail(page, post) {
  const route = detailPath(post.apId);
  await page.getByText(post.content, { exact: true }).click();
  await page.waitForURL((url) => url.pathname === route, { timeout: 10_000 });
  await page.getByText(post.content, { exact: true }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
}

async function confirmDetailDelete(page, apId) {
  const button = page
    .getByRole("button", { name: "削除", exact: true })
    .first();
  await button.waitFor({ state: "visible", timeout: 10_000 });
  await button.click();
  const dialog = page.getByRole("alertdialog", {
    name: "投稿を削除しますか？",
  });
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  const responsePromise = expectResponse(
    page,
    new URL(deletePath(apId), page.url()).href,
    "DELETE",
    "confirmed detail delete",
  );
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  const response = await responsePromise;
  requireFollowingDelete(
    response.ok(),
    `ConfirmSheet DELETE failed (${response.status()})`,
  );
  return { status: response.status(), path: new URL(response.url()).pathname };
}

async function failedDeleteBeforeWorker(page, db, post) {
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
    await openPostDetail(page, post);
    await page
      .getByRole("button", { name: "削除", exact: true })
      .first()
      .click();
    await confirmDetailDeleteFailed(page);
    await page
      .getByRole("alert")
      .filter({ hasText: "削除に失敗しました" })
      .waitFor({ state: "visible", timeout: 5_000 });
    const native = await readObject(db, post.apId);
    const visible = await visiblePost(page, post.content);
    requireFollowingDelete(
      intercepted === 1 &&
        native?.ap_id === post.apId &&
        native.deleted_at === null &&
        visible,
      "pre-Worker failed DELETE did not preserve both native D1 and detail UI post",
    );
    return { intercepted, native, detailVisibleAfterFailure: visible };
  } finally {
    await page.unroute("**/api/posts/**", handler);
  }
}

async function confirmDetailDeleteFailed(page) {
  const dialog = page.getByRole("alertdialog", {
    name: "投稿を削除しますか？",
  });
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
}

export async function qualifyBrowserFollowingDelete({
  page,
  db,
  origin,
  actorApId,
  checks,
  mode = "green",
}) {
  requireFollowingDelete(
    page && db && Array.isArray(checks),
    "page, native D1, and checks accumulator are required",
  );
  requireFollowingDelete(
    ["baseline-red", "green"].includes(mode),
    "mode must be baseline-red or green",
  );
  requireFollowingDelete(
    ["127.0.0.1", "localhost"].includes(new URL(origin).hostname) &&
      new URL(actorApId).origin === new URL(origin).origin,
    "fixture is limited to the authenticated local Worker owner",
  );
  const before = await countRows(db);
  const sessionBefore = (await page.context().cookies(origin)).find(
    (cookie) => cookie.name === "session",
  );
  requireFollowingDelete(sessionBefore?.value, "session cookie is missing");
  const owner = await db
    .prepare("SELECT ap_id, role FROM actors WHERE ap_id = ?")
    .bind(actorApId)
    .first();
  requireFollowingDelete(
    owner?.ap_id === actorApId && owner.role === "owner",
    "authenticated actor is not the local root owner",
  );

  const suffix = crypto.randomUUID();
  const m1 = await createPublicPost(
    page,
    db,
    origin,
    actorApId,
    `Following delete M1 ${suffix}`,
  );
  const m2 = await createPublicPost(
    page,
    db,
    origin,
    actorApId,
    `Following delete M2 ${suffix}`,
  );
  const afterPosts = await countRows(db);
  requireFollowingDelete(
    JSON.stringify(before) === JSON.stringify(afterPosts),
    "creating own posts changed actor/session counts",
  );

  // Clear the app's in-memory Jotai store so the following GET itself proves
  // both created posts are on the server and starts a new 60s freshness window.
  await page.goto(new URL("/", origin).href, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  let followingGets = 0;
  let followingRequests = 0;
  const requestListener = (request) => {
    if (
      new URL(request.url()).origin === origin &&
      new URL(request.url()).pathname === "/api/timeline/following" &&
      request.method() === "GET"
    )
      followingRequests += 1;
  };
  const responseListener = (response) => {
    if (
      new URL(response.url()).origin === origin &&
      new URL(response.url()).pathname === "/api/timeline/following" &&
      response.request().method() === "GET"
    )
      followingGets += 1;
  };
  page.on("response", responseListener);
  page.on("request", requestListener);
  try {
    const followingResponse = expectResponse(
      page,
      new URL("/api/timeline/following", origin).href,
      "GET",
      "initial Following feed",
    );
    await clickFollowing(page);
    const response = await followingResponse;
    requireFollowingDelete(
      response.status() === 200,
      `Following GET failed (${response.status()})`,
    );
    const followingLoadedAt = Date.now();
    const body = await response.json().catch(() => null);
    const returned = body?.posts ?? [];
    for (const post of [m1, m2]) {
      const match = returned.find((candidate) => candidate.ap_id === post.apId);
      requireFollowingDelete(
        match?.content === post.content &&
          match.author?.ap_id === actorApId &&
          match.visibility === "public",
        `real Following GET did not include the exact public ${post.content}`,
      );
      await page
        .getByText(post.content, { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
    }

    const afterInitialFollowing = followingGets;
    const initialFollowingRequests = followingRequests;
    const failure = await failedDeleteBeforeWorker(page, db, m2);
    await page.getByRole("button", { name: "戻る", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
    await clickFollowing(page);
    requireFollowingDelete(
      (await visiblePost(page, m1.content)) &&
        (await visiblePost(page, m2.content)),
      "failed M2 delete did not return to Following with both posts retained",
    );
    requireFollowingDelete(
      followingGets === afterInitialFollowing &&
        followingRequests === initialFollowingRequests,
      "Following feed refetched after failed DELETE/detail/back within its fresh window",
    );

    await openPostDetail(page, m1);
    const start = Date.now();
    const deleteResult = await confirmDetailDelete(page, m1.apId);
    const deletedM1 = await readObject(db, m1.apId);
    const retainedM2 = await readObject(db, m2.apId);
    requireFollowingDelete(
      deletedM1 === null &&
        retainedM2?.ap_id === m2.apId &&
        retainedM2.deleted_at === null,
      "successful native DELETE did not remove M1 while retaining M2",
    );
    await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
    await clickFollowing(page);
    await page
      .getByText(m2.content, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    const elapsedMs = Date.now() - start;
    const elapsedSinceFollowingLoadMs = Date.now() - followingLoadedAt;
    const visibleAfterBack = {
      m1: await visiblePost(page, m1.content),
      m2: await visiblePost(page, m2.content),
    };
    const endCounts = await countRows(db);
    const sessionAfter = (await page.context().cookies(origin)).find(
      (cookie) => cookie.name === "session",
    );
    requireFollowingDelete(
      JSON.stringify(afterPosts) === JSON.stringify(endCounts) &&
        sessionAfter?.value === sessionBefore.value,
      "delete/detail/back changed actor or session counts",
    );
    requireFollowingDelete(
      followingGets === afterInitialFollowing &&
        followingRequests === initialFollowingRequests,
      "Following feed refetched between detail navigation, real DELETE, and browser back",
    );
    requireFollowingDelete(
      elapsedSinceFollowingLoadMs < 60_000,
      `delete/detail/back exceeded Following's 60s freshness window (${elapsedSinceFollowingLoadMs}ms)`,
    );
    const expectedM1Visible = mode === "baseline-red";
    requireFollowingDelete(
      visibleAfterBack.m1 === expectedM1Visible && visibleAfterBack.m2,
      `Following return state mismatch for ${mode}: ${JSON.stringify(visibleAfterBack)}`,
    );
    const checksForMode = [
      "browser-following-delete-real-public-posts-and-native-projection",
      "browser-following-delete-failed-delete-is-pre-worker-and-retains-post",
      "browser-following-delete-success-removes-native-m1-keeps-native-m2",
      mode === "baseline-red"
        ? "browser-following-delete-baseline-red-stale-m1-remains-without-refetch"
        : "browser-following-delete-green-m1-absent-after-fresh-following-return",
      "browser-following-delete-60s-fresh-cache-reuse-observed-no-following-refetch",
    ];
    checks.push(...checksForMode);
    return {
      result: mode === "baseline-red" ? "EXPECTED_BASELINE_RED" : "green",
      mode,
      actorApId,
      actorSessionCounts: { before, afterPosts, after: endCounts },
      sessionCookieUnchanged: true,
      posts: { m1, m2 },
      native: { m1: deletedM1, m2: retainedM2 },
      failedDelete: failure,
      successfulDelete: deleteResult,
      following: {
        initialGetStatus: 200,
        initialGetCount: afterInitialFollowing,
        finalGetCount: followingGets,
        initialRequestCount: initialFollowingRequests,
        finalRequestCount: followingRequests,
        elapsedMs,
        elapsedSinceFollowingLoadMs,
        visibleAfterReturn: visibleAfterBack,
        selectedAfterReturn: await page
          .getByRole("tab", { name: "フォロー中", exact: true })
          .getAttribute("aria-selected"),
        reusedWithoutRefetch: true,
      },
      checks: checksForMode,
    };
  } finally {
    page.off("response", responseListener);
    page.off("request", requestListener);
  }
}
