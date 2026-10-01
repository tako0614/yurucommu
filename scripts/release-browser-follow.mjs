// Real-browser qualification for accepted and approval-pending search follows.
// All fixture actors are created by the authenticated product API as
// same-owner personas; this does not qualify external federation delivery.

function requireEffect(condition, message) {
  if (!condition) throw new Error(`browser-search-follow ${message}`);
}

function waitForResponse(page, pathname, method, label) {
  const response = page
    .waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === pathname &&
        candidate.request().method() === method,
      { timeout: 20_000 },
    )
    .catch((error) => {
      throw new Error(
        `${label} produced no ${method} ${pathname}: ${String(error)}`,
      );
    });
  // Observe the returned promise immediately if the UI action fails first;
  // callers still receive its rejection when awaited.
  response.catch(() => {});
  return response;
}

function accountRow(page, apId) {
  const href = `/profile/${encodeURIComponent(apId)}`;
  const profileLink = page.locator(`a[href=${JSON.stringify(href)}]`).last();
  return profileLink.locator("xpath=../..");
}

async function responseJson(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`browser-search-follow ${label} response was not JSON`);
  }
  return { status: response.status(), body };
}

async function followEdge(db, followerApId, followingApId) {
  return db
    .prepare(
      "SELECT status, activity_ap_id FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
    )
    .bind(followerApId, followingApId)
    .all();
}

async function followActivityCount(db, actorApId, objectApId) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Follow' AND actor_ap_id = ? AND object_ap_id = ?",
    )
    .bind(actorApId, objectApId)
    .first();
  return row?.count;
}

async function assertOwnerAndPersonaStore(
  db,
  rootApId,
  privateApId,
  publicApId,
  expectedPrivate,
) {
  const actors = (
    await db
      .prepare(
        "SELECT ap_id, role, owner_actor_ap_id, is_private, follower_count, following_count, deleted_at FROM actors ORDER BY ap_id",
      )
      .all()
  ).results;
  const sessions = (await db.prepare("SELECT member_id FROM sessions").all())
    .results;
  const byId = new Map(actors.map((actor) => [actor.ap_id, actor]));
  const root = byId.get(rootApId);
  const privateActor = byId.get(privateApId);
  const publicActor = byId.get(publicApId);
  requireEffect(
    actors.length === 3 &&
      actors.filter(
        (actor) => actor.role === "owner" && actor.deleted_at === null,
      ).length === 1 &&
      root?.role === "owner" &&
      root.owner_actor_ap_id === null &&
      privateActor?.role === "member" &&
      privateActor.owner_actor_ap_id === rootApId &&
      privateActor.is_private === Number(expectedPrivate) &&
      publicActor?.role === "member" &&
      publicActor.owner_actor_ap_id === rootApId &&
      publicActor.is_private === 0 &&
      sessions.length === 1 &&
      sessions[0]?.member_id === rootApId,
    "owner/persona/session scope changed unexpectedly",
  );
  return { actors, root, privateActor, publicActor };
}

async function setPersonaPrivacy(
  page,
  rootApId,
  personaApId,
  isPrivate,
  allowAuthRecovery,
) {
  const result = await page.evaluate(
    async ({ rootApId, personaApId, isPrivate }) => {
      const request = async (path, method, body) => {
        const response = await fetch(path, {
          method,
          credentials: "same-origin",
          headers:
            body === undefined
              ? undefined
              : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json;
        try {
          json = await response.json();
        } catch {
          throw new Error(
            `non-JSON response from ${path} (${response.status})`,
          );
        }
        return {
          status: response.status,
          body: json,
          retryAfter: response.headers.get("retry-after"),
        };
      };
      const expectSuccess = (result, path) => {
        if (
          result.status < 200 ||
          result.status >= 300 ||
          result.body.success !== true
        ) {
          throw new Error(
            `${path} returned HTTP ${result.status} without success`,
          );
        }
      };
      const switched = await request("/api/auth/switch", "POST", {
        ap_id: personaApId,
      });
      expectSuccess(switched, "/api/auth/switch to persona");
      const updated = await request("/api/actors/me", "PUT", {
        is_private: isPrivate,
      });
      expectSuccess(updated, "/api/actors/me privacy update");
      const returned = await request("/api/auth/switch", "POST", {
        ap_id: rootApId,
      });
      expectSuccess(returned, "/api/auth/switch back to owner");
      return request("/api/auth/me", "GET");
    },
    { rootApId, personaApId, isPrivate },
  );
  let me = result;
  const authVerification = { initialStatus: me.status, retried: false };
  if (me.status === 429) {
    requireEffect(
      allowAuthRecovery,
      "auth quota blocked a second owner verification after recovery",
    );
    requireEffect(
      /^\d+$/.test(me.retryAfter ?? "") &&
        Number(me.retryAfter) >= 1 &&
        Number(me.retryAfter) <= 60,
      "owner verification returned an invalid or excessive Retry-After",
    );
    // This fixture performs many real auth requests in one minute. Preserve the
    // original refusal and respect its window before one read-only verification.
    authVerification.retryAfterSeconds = Number(me.retryAfter);
    process.stderr.write(
      `browser-search-follow owner verification HTTP 429; waiting ${me.retryAfter}s before one declared GET retry\n`,
    );
    await page.waitForTimeout(Number(me.retryAfter) * 1000);
    await page.waitForTimeout(150);
    me = await page.evaluate(async () => {
      const response = await fetch("/api/auth/me", {
        credentials: "same-origin",
      });
      return { status: response.status, body: await response.json() };
    });
    authVerification.retried = true;
    authVerification.retryStatus = me.status;
  }
  requireEffect(
    me.status === 200 &&
      me.body.actor?.ap_id === rootApId &&
      me.body.actor?.role === "owner",
    `browser session did not return to root owner: ${JSON.stringify({ status: me.status, actorApId: me.body.actor?.ap_id ?? null, expectedRootApId: rootApId })}`,
  );
  return authVerification;
}

export async function qualifySearchFollowing({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  requireEffect(
    page && db && Array.isArray(checks),
    "qualification needs the live page, D1, and checks",
  );
  requireEffect(
    actorApId === `${origin}/ap/users/tako`,
    "expected the current root owner actor",
  );

  const passed = [];
  const mark = (name) => {
    passed.push(name);
    checks.push(name);
  };
  const followRequests = new Map();
  const privacyAuthVerifications = [];
  const onRequest = (request) => {
    if (request.method() !== "POST") return;
    let path;
    let body;
    try {
      path = new URL(request.url()).pathname;
      body = request.postDataJSON();
    } catch {
      return;
    }
    if (path !== "/api/follow" || typeof body?.target_ap_id !== "string")
      return;
    followRequests.set(
      body.target_ap_id,
      (followRequests.get(body.target_ap_id) ?? 0) + 1,
    );
  };
  page.on("request", onRequest);

  try {
    const created = await page.evaluate(async (rootApId) => {
      const request = async (path, method, body) => {
        const response = await fetch(path, {
          method,
          credentials: "same-origin",
          headers:
            body === undefined
              ? undefined
              : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json;
        try {
          json = await response.json();
        } catch {
          throw new Error(
            `non-JSON response from ${path} (${response.status})`,
          );
        }
        return { status: response.status, body: json };
      };
      const expectOk = (result, path) => {
        if (!result.status || result.status < 200 || result.status >= 300) {
          throw new Error(`${path} returned HTTP ${result.status}`);
        }
      };

      const privateCreate = await request("/api/auth/accounts", "POST", {
        username: "ga_search_private",
        name: "GA Search Private",
      });
      expectOk(privateCreate, "/api/auth/accounts private persona create");
      const privateApId = privateCreate.body.account?.ap_id;
      if (typeof privateApId !== "string")
        throw new Error("private persona returned no AP ID");

      const publicCreate = await request("/api/auth/accounts", "POST", {
        username: "ga_search_public",
        name: "GA Search Public",
      });
      expectOk(publicCreate, "/api/auth/accounts public persona create");
      const publicApId = publicCreate.body.account?.ap_id;
      if (typeof publicApId !== "string")
        throw new Error("public persona returned no AP ID");

      const accountList = await request("/api/auth/accounts", "GET");
      expectOk(accountList, "/api/auth/accounts owner listing");
      return {
        privateApId,
        publicApId,
        accountIds:
          accountList.body.accounts?.map((account) => account.ap_id) ?? [],
        currentApId: accountList.body.current_ap_id,
      };
    }, actorApId);

    const expectedAccounts = new Set([
      actorApId,
      created.privateApId,
      created.publicApId,
    ]);
    requireEffect(
      created.privateApId === `${origin}/ap/users/ga_search_private` &&
        created.publicApId === `${origin}/ap/users/ga_search_public` &&
        created.currentApId === actorApId &&
        created.accountIds.length === 3 &&
        new Set(created.accountIds).size === 3 &&
        created.accountIds.every((id) => expectedAccounts.has(id)),
      "real account API did not create and return both owner-linked personas",
    );
    const initialActors = await assertOwnerAndPersonaStore(
      db,
      actorApId,
      created.privateApId,
      created.publicApId,
      false,
    );
    requireEffect(
      initialActors.root.following_count === 0 &&
        initialActors.privateActor.follower_count === 0 &&
        initialActors.publicActor.follower_count === 0,
      "new profile follow counts did not start empty",
    );
    mark("browser-search-follow-public-profiles-created-under-single-owner");

    const query = "ga_search";
    const searchResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/search/actors" &&
        response.request().method() === "GET",
      { timeout: 20_000 },
    );
    searchResponse.catch(() => {});
    await page.goto(`${origin}/search?search=${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const firstSearch = await searchResponse.catch((error) => {
      throw new Error(
        `browser-search-follow actor search was not observed: ${String(error)}`,
      );
    });
    requireEffect(
      firstSearch.status() === 200,
      "real actor search did not return HTTP 200",
    );

    const privateRow = accountRow(page, created.privateApId);
    const publicRow = accountRow(page, created.publicApId);
    await privateRow.getByText("GA Search Private", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await publicRow.getByText("GA Search Public", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    const searchInput = page.locator('input[type="text"][aria-label="検索"]');
    const searchSubmit = page
      .locator("form")
      .filter({ has: searchInput })
      .getByRole("button", { name: "検索", exact: true });
    requireEffect(
      (await searchInput.inputValue()) === query,
      "URL query did not populate the search field",
    );
    mark("browser-search-follow-url-query-loads-owner-personas");

    privacyAuthVerifications.push(
      await setPersonaPrivacy(page, actorApId, created.privateApId, true, true),
    );
    await assertOwnerAndPersonaStore(
      db,
      actorApId,
      created.privateApId,
      created.publicApId,
      true,
    );
    mark("browser-search-follow-private-persona-api-transition");

    const pendingButton = privateRow.getByRole("button", {
      name: "フォロー",
      exact: true,
    });
    requireEffect(
      await pendingButton.isEnabled(),
      "private persona follow button was not initially available",
    );
    const pendingResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/follow" &&
        response.request().method() === "POST" &&
        response.request().postDataJSON()?.target_ap_id === created.privateApId,
      { timeout: 20_000 },
    );
    pendingResponsePromise.catch(() => {});
    await pendingButton.click();
    const pendingResponse = await pendingResponsePromise.catch((error) => {
      throw new Error(
        `browser-search-follow private click had no API response: ${String(error)}`,
      );
    });
    const pendingBody = await responseJson(pendingResponse, "private follow");
    requireEffect(
      pendingBody.status === 200 && pendingBody.body.status === "pending",
      "real private follow did not return status=pending",
    );
    let privateEdges = await followEdge(db, actorApId, created.privateApId);
    let privateActivityCount = await followActivityCount(
      db,
      actorApId,
      created.privateApId,
    );
    let afterPending = await assertOwnerAndPersonaStore(
      db,
      actorApId,
      created.privateApId,
      created.publicApId,
      true,
    );
    requireEffect(
      privateEdges.results.length === 1 &&
        privateEdges.results[0]?.status === "pending" &&
        privateActivityCount === 1 &&
        afterPending.root.following_count === 0 &&
        afterPending.privateActor.follower_count === 0 &&
        followRequests.get(created.privateApId) === 1,
      "pending follow did not persist exactly once without accepted counts or extra actors/sessions",
    );

    const requestedButton = privateRow.getByRole("button", {
      name: "申請中",
      exact: true,
    });
    try {
      await requestedButton.waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      throw new Error(
        `browser-search-follow actual API pending/native edge pending/Follow activity1/request1/accepted counters0, but Requested button is missing: ${String(error)}`,
      );
    }
    requireEffect(
      await requestedButton.isDisabled(),
      "pending follow button remained actionable",
    );

    privacyAuthVerifications.push(
      await setPersonaPrivacy(
        page,
        actorApId,
        created.privateApId,
        false,
        !privacyAuthVerifications.some((verification) => verification.retried),
      ),
    );
    await assertOwnerAndPersonaStore(
      db,
      actorApId,
      created.privateApId,
      created.publicApId,
      false,
    );
    await searchInput.fill(query);
    const repeatedSearchResponse = waitForResponse(
      page,
      "/api/search/actors",
      "GET",
      "same-page actor search",
    );
    await searchSubmit.click();
    const repeatedSearch = await repeatedSearchResponse;
    requireEffect(
      repeatedSearch.status() === 200,
      "same-page actor re-search failed",
    );
    await privateRow.getByText("GA Search Private", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    const retainedPending = privateRow.getByRole("button", {
      name: "申請中",
      exact: true,
    });
    await retainedPending.waitFor({ state: "visible", timeout: 10_000 });
    requireEffect(
      await retainedPending.isDisabled(),
      "re-search made the pending follow actionable",
    );
    privateEdges = await followEdge(db, actorApId, created.privateApId);
    privateActivityCount = await followActivityCount(
      db,
      actorApId,
      created.privateApId,
    );
    afterPending = await assertOwnerAndPersonaStore(
      db,
      actorApId,
      created.privateApId,
      created.publicApId,
      false,
    );
    requireEffect(
      followRequests.get(created.privateApId) === 1 &&
        privateEdges.results.length === 1 &&
        privateEdges.results[0]?.status === "pending" &&
        privateActivityCount === 1 &&
        afterPending.root.following_count === 0 &&
        afterPending.privateActor.follower_count === 0,
      "same-page re-search duplicated a pending Follow or lost its state",
    );
    mark("browser-search-follow-pending-disabled-and-retained-after-research");

    const acceptedButton = publicRow.getByRole("button", {
      name: "フォロー",
      exact: true,
    });
    requireEffect(
      await acceptedButton.isEnabled(),
      "public persona follow button was not initially available",
    );
    const acceptedResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/follow" &&
        response.request().method() === "POST" &&
        response.request().postDataJSON()?.target_ap_id === created.publicApId,
      { timeout: 20_000 },
    );
    acceptedResponsePromise.catch(() => {});
    await acceptedButton.click();
    const acceptedResponse = await acceptedResponsePromise.catch((error) => {
      throw new Error(
        `browser-search-follow public click had no API response: ${String(error)}`,
      );
    });
    const acceptedBody = await responseJson(acceptedResponse, "public follow");
    requireEffect(
      acceptedBody.status === 200 && acceptedBody.body.status === "accepted",
      "real public follow did not return status=accepted",
    );
    await publicRow.getByText("フォロー中", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const publicEdges = await followEdge(db, actorApId, created.publicApId);
    const publicActivityCount = await followActivityCount(
      db,
      actorApId,
      created.publicApId,
    );
    const finalActors = await assertOwnerAndPersonaStore(
      db,
      actorApId,
      created.privateApId,
      created.publicApId,
      false,
    );
    requireEffect(
      publicEdges.results.length === 1 &&
        publicEdges.results[0]?.status === "accepted" &&
        publicActivityCount === 1 &&
        followRequests.get(created.publicApId) === 1 &&
        finalActors.root.following_count === 1 &&
        finalActors.publicActor.follower_count === 1 &&
        finalActors.privateActor.follower_count === 0 &&
        followRequests.get(created.privateApId) === 1,
      "accepted follow did not persist one edge/activity/count and one owner request",
    );
    mark("browser-search-follow-public-accepted-pill-and-native-readback");

    return {
      scope:
        "same-owner local personas only; no remote federation delivery qualification",
      privateActorApId: created.privateApId,
      publicActorApId: created.publicApId,
      privatePersonaVisibility: [
        "public-searchable",
        "private-for-pending-follow",
        "public-for-research",
      ],
      owners: 1,
      personas: 2,
      actors: 3,
      sessions: 1,
      followRequests: {
        pending: followRequests.get(created.privateApId),
        accepted: followRequests.get(created.publicApId),
      },
      privacyAuthVerifications,
      pendingReloadHydration:
        "unqualified; published Core/API exposes no pending-follow hydration field",
      checkCount: passed.length,
      checks: passed,
    };
  } finally {
    page.off("request", onRequest);
  }
}
