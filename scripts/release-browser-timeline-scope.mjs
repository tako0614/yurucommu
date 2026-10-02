// Disposable native-browser qualification for a delayed home-head poll across
// community view filters. The caller supplies an authenticated owner page and
// native D1. This helper creates communities/posts through that owner's real
// API, then holds only delivery of one real Worker timeline response.

function requireScope(condition, message) {
  if (!condition) throw new Error(`browser-timeline-scope ${message}`);
}

function gate() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded(promise, label, timeout = 20_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`browser-timeline-scope ${label} timed out`)),
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

async function ownerPost(page, content, communityApId, actorApId) {
  const result = await page.evaluate(
    async ({ content, communityApId }) => {
      const response = await fetch("/api/posts", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          visibility: "public",
          community_ap_id: communityApId,
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { content, communityApId },
  );
  const post = result.body?.post;
  requireScope(
    result.status === 200 &&
      typeof post?.ap_id === "string" &&
      post.author?.ap_id === actorApId &&
      post.content === content,
    `owner post API did not acknowledge exact identity/content: ${JSON.stringify(result)}`,
  );
  return post;
}

async function ownerCommunity(page, name) {
  const result = await page.evaluate(async (name) => {
    const response = await fetch("/api/communities", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, display_name: name }),
    });
    return { status: response.status, body: await response.json() };
  }, name);
  const community = result.body?.community;
  requireScope(
    result.status === 201 &&
      typeof community?.ap_id === "string" &&
      community.name === name &&
      community.is_member === true,
    `owner community was not created/joined: ${JSON.stringify(result)}`,
  );
  return community;
}

async function nativeOwnerMembership(db, communityApId, actorApId) {
  const row = await db
    .prepare(
      "SELECT actor_ap_id, community_ap_id, role FROM community_members WHERE community_ap_id = ? AND actor_ap_id = ?",
    )
    .bind(communityApId, actorApId)
    .first();
  requireScope(
    row?.actor_ap_id === actorApId &&
      row.community_ap_id === communityApId &&
      row.role === "owner",
    `native D1 lacks the creator membership for ${communityApId}: ${JSON.stringify(row)}`,
  );
  return row;
}

async function identitySnapshot(db, actorApId) {
  const counts = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM actors) AS actors,
        (SELECT COUNT(*) FROM actors WHERE role = 'owner' AND deleted_at IS NULL) AS owners,
        (SELECT COUNT(*) FROM sessions) AS sessions`,
    )
    .first();
  const actor = await db
    .prepare(
      "SELECT ap_id, role, owner_actor_ap_id, deleted_at FROM actors WHERE ap_id = ?",
    )
    .bind(actorApId)
    .first();
  const sessions = (
    await db.prepare("SELECT id, member_id FROM sessions ORDER BY id").all()
  ).results;
  requireScope(
    counts?.owners === 1 &&
      actor?.ap_id === actorApId &&
      actor.role === "owner" &&
      actor.owner_actor_ap_id === null &&
      actor.deleted_at === null &&
      sessions?.some((session) => session.member_id === actorApId),
    `fixture lacks its single live human owner/session: ${JSON.stringify({ counts, actor, sessions })}`,
  );
  return { counts, actor, sessions };
}

async function nativePost(db, post, actorApId, expectedCommunityApId) {
  const row = await db
    .prepare(
      "SELECT ap_id, attributed_to, content, community_ap_id, published FROM objects WHERE ap_id = ?",
    )
    .bind(post.ap_id)
    .first();
  requireScope(
    row?.ap_id === post.ap_id &&
      row.attributed_to === actorApId &&
      row.content === post.content &&
      row.community_ap_id === expectedCommunityApId,
    `native D1 disagrees with owner post: ${JSON.stringify(row)}`,
  );
  return row;
}

function newerThan(next, previous, label) {
  requireScope(
    `${next.published} ${next.ap_id}` >
      `${previous.published} ${previous.ap_id}`,
    `${label} is not newer than the visible scope head`,
  );
}

function scopedTimelineRequest(request, communityApId) {
  const url = new URL(request.url());
  return (
    request.method() === "GET" &&
    url.pathname === "/api/timeline" &&
    url.searchParams.get("community") === communityApId &&
    !url.searchParams.has("before")
  );
}

async function switchScope(page, name, communityApId, expectedContent) {
  await page
    .locator(
      'header button[title="表示を絞り込む"], header button[title="Filter the view"]',
    )
    .click();
  const sheet = page.getByRole("dialog", {
    name: /表示を絞り込む|Filter the view/,
  });
  await sheet.waitFor({ state: "visible", timeout: 10_000 });
  const loaded = page.waitForResponse(
    (response) => scopedTimelineRequest(response.request(), communityApId),
    { timeout: 20_000 },
  );
  loaded.catch(() => {});
  await sheet.getByRole("radio", { name: new RegExp(name) }).click();
  const response = await loaded;
  requireScope(response.status() === 200, `${name} full timeline was refused`);
  await page.getByText(expectedContent, { exact: true }).first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  return response;
}

function timelinePill(page) {
  return page.getByRole("button", {
    name: /件の新しい投稿|new posts/,
  });
}

export async function qualifyBrowserTimelineScope({
  page,
  db,
  origin,
  actorApId,
  checks,
  mode,
}) {
  requireScope(
    page && db && Array.isArray(checks),
    "page, D1, and checks are required",
  );
  requireScope(
    new URL(actorApId).origin === new URL(origin).origin,
    "owner AP ID must belong to the fixture origin",
  );
  requireScope(
    mode === undefined || mode === "baseline-red",
    "unknown fixture mode",
  );

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const names = { a: `scopea${suffix}`, b: `scopeb${suffix}` };
  const contents = {
    aBase: `scope-A-base-${suffix}`,
    aNew: `scope-A-new-${suffix}`,
    bBase: `scope-B-base-${suffix}`,
    bNew: `scope-B-new-${suffix}`,
  };
  const identityBefore = await identitySnapshot(db, actorApId);
  let primaryError;
  try {
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    const b = await ownerCommunity(page, names.b);
    const a = await ownerCommunity(page, names.a);
    await nativeOwnerMembership(db, b.ap_id, actorApId);
    await nativeOwnerMembership(db, a.ap_id, actorApId);
    const bBase = await ownerPost(page, contents.bBase, b.ap_id, actorApId);
    const aBase = await ownerPost(page, contents.aBase, a.ap_id, actorApId);
    const nativeBefore = await Promise.all([
      nativePost(db, aBase, actorApId, a.ap_id),
      nativePost(db, bBase, actorApId, b.ap_id),
    ]);

    // The scope picker hydrates joined communities on page mount. Reloading the
    // existing authenticated page updates that list without creating a session.
    await page.reload({ waitUntil: "domcontentloaded" });
    await switchScope(page, names.a, a.ap_id, contents.aBase);
    await page.waitForTimeout(30);
    const aNew = await ownerPost(page, contents.aNew, a.ap_id, actorApId);
    const nativeNew = await nativePost(db, aNew, actorApId, a.ap_id);
    newerThan(nativeNew, nativeBefore[0], "A poll candidate");
    newerThan(
      nativeNew,
      nativeBefore[1],
      "A poll candidate relative to B head",
    );

    const responseReady = gate();
    const release = gate();
    const delivered = gate();
    let nativeResponse;
    let routeError;
    let intercepted = 0;
    const handler = async (route) => {
      if (!scopedTimelineRequest(route.request(), a.ap_id)) {
        await route.continue();
        return;
      }
      intercepted += 1;
      if (intercepted !== 1) {
        await route.continue();
        return;
      }
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: 15_000,
        });
        const body = await response.json();
        nativeResponse = {
          status: response.status(),
          postIds: (body.posts ?? []).map((post) => post.ap_id),
        };
        responseReady.resolve();
        await release.promise;
        await route.fulfill({ response });
      } catch (error) {
        routeError = error;
        responseReady.reject(error);
        try {
          await route.abort("failed");
        } catch {
          // Preserve the first route failure.
        }
      } finally {
        delivered.resolve();
      }
    };
    await page.route("**/api/timeline?**", handler);
    try {
      // A synthetic visibility event calls the mounted page's native 30s
      // head-poll handler immediately; the GET and Worker response remain real.
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await bounded(responseReady.promise, "held A native poll");
      requireScope(
        nativeResponse?.status === 200 &&
          nativeResponse.postIds.includes(aNew.ap_id),
        `held native A poll omitted its actual newer post: ${JSON.stringify(nativeResponse)}`,
      );

      const bResponse = await switchScope(
        page,
        names.b,
        b.ap_id,
        contents.bBase,
      );
      const bBody = await bResponse.json();
      requireScope(
        bBody.posts?.some((post) => post.ap_id === bBase.ap_id) &&
          !bBody.posts?.some((post) => post.ap_id === aNew.ap_id),
        "native B scope already included A-only post; fixture cannot prove isolation",
      );
      requireScope(
        (await timelinePill(page).count()) === 0,
        "B scope had a new-post pill before A response release",
      );

      const aFinished = page.waitForEvent("requestfinished", {
        predicate: (request) => scopedTimelineRequest(request, a.ap_id),
        timeout: 20_000,
      });
      aFinished.catch(() => {});
      release.resolve();
      await bounded(delivered.promise, "A poll response delivery");
      await bounded(aFinished, "A poll browser completion");
      requireScope(
        !routeError,
        `held A poll route failed: ${String(routeError)}`,
      );
      // requestfinished observes network completion. Give the app one rendering
      // turn to process the Promise/atom update before reading the visible pill.
      await page.waitForTimeout(150);

      if (mode === "baseline-red") {
        await timelinePill(page).waitFor({ state: "visible", timeout: 5_000 });
        await timelinePill(page).click();
        await page.getByText(contents.aNew, { exact: true }).first().waitFor({
          state: "visible",
          timeout: 5_000,
        });
        checks.push(
          "browser-timeline-scope-baseline-cross-scope-poll-reproduced",
        );
        return {
          result: "expected-red",
          heldNativeResponse: nativeResponse,
          bNativeResponsePostIds: bBody.posts.map((post) => post.ap_id),
          nativeBefore,
          nativeNew,
          boundary:
            "A and B posts/GET responses came from native disposable Worker/D1; Playwright held only A response delivery and synthetically dispatched visibilitychange to start the mounted poll. No remote federation or production data.",
        };
      }

      requireScope(
        (await timelinePill(page).count()) === 0 &&
          (await page.getByText(contents.bBase, { exact: true }).count()) > 0 &&
          (await page.getByText(contents.aNew, { exact: true }).count()) === 0,
        "late A poll staged or rendered a post inside B scope",
      );
      checks.push("browser-timeline-scope-late-A-poll-does-not-stage-in-B");

      // A same-scope poll remains useful: a new B-scoped native post must stage
      // a pill and become visible after the owner's explicit click.
      await page.waitForTimeout(30);
      const bNew = await ownerPost(page, contents.bNew, b.ap_id, actorApId);
      const nativeBNew = await nativePost(db, bNew, actorApId, b.ap_id);
      newerThan(nativeBNew, nativeBefore[1], "B poll candidate");
      const bPoll = page.waitForResponse(
        (response) => scopedTimelineRequest(response.request(), b.ap_id),
        { timeout: 20_000 },
      );
      bPoll.catch(() => {});
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      const bPollResponse = await bPoll;
      const bPollBody = await bPollResponse.json();
      requireScope(
        bPollResponse.status() === 200 &&
          bPollBody.posts?.some((post) => post.ap_id === bNew.ap_id),
        "same-scope B poll omitted its native newer post",
      );
      await timelinePill(page).waitFor({ state: "visible", timeout: 10_000 });
      await timelinePill(page).click();
      await page.getByText(contents.bNew, { exact: true }).first().waitFor({
        state: "visible",
        timeout: 10_000,
      });
      requireScope(
        (await page.getByText(contents.aNew, { exact: true }).count()) === 0,
        "same-scope B poll reintroduced an A-only post",
      );
      checks.push("browser-timeline-scope-current-B-poll-stages-native-B-post");
      return {
        result: "green",
        heldNativeResponse: nativeResponse,
        bNativeResponsePostIds: bBody.posts.map((post) => post.ap_id),
        nativeBefore,
        nativeNew,
        nativeBNew,
        interceptedAPolls: intercepted,
        boundary:
          "A/B communities and posts were owner API writes with native D1 readback; both timeline payloads were real disposable Worker responses. Playwright delayed A delivery and synthetically dispatched visibilitychange to start mounted polls. B's subsequent native poll and pill application provide practical settling evidence beyond the short A delivery wait; no additional human owner, remote federation, or public environment was used.",
      };
    } finally {
      release.resolve();
      await page.unroute("**/api/timeline?**", handler);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Reloading remounts the non-persisted scope atom at personal/unfiltered
    // home, including when an assertion failed partway through the fixture.
    try {
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await page
        .locator(
          'header button[title="表示を絞り込む"], header button[title="Filter the view"]',
        )
        .filter({ hasText: /ホーム|Home/ })
        .waitFor({ state: "visible", timeout: 10_000 });
      const identityAfter = await identitySnapshot(db, actorApId);
      requireScope(
        JSON.stringify(identityAfter) === JSON.stringify(identityBefore),
        `actor/owner/session identity changed: ${JSON.stringify({ identityBefore, identityAfter })}`,
      );
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      primaryError.message += `; cleanup also failed: ${String(cleanupError)}`;
    }
  }
}
