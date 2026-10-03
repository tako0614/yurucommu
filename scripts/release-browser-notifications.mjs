// Disposable native notification fixture, not remote federation proof.
function requireNotification(condition, reason) {
  if (!condition) throw new Error(`notification-refresh ${reason}`);
}

async function identityCounts(db) {
  return db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM actors) AS actors,
    (SELECT COUNT(*) FROM actors WHERE role = 'owner' AND deleted_at IS NULL) AS owners,
    (SELECT COUNT(*) FROM sessions) AS sessions,
    (SELECT COUNT(*) FROM actor_cache) AS cachedPeers`,
    )
    .first();
}

async function nativeInbox(page, origin) {
  return page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/notifications`, {
      credentials: "include",
    });
    return { status: response.status, body: await response.json() };
  }, origin);
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`notification-refresh ${label} deadline`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function qualifyBrowserNotifications({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  const before = await identityCounts(db);
  const suffix = crypto.randomUUID();
  const peerId = `https://notification-peer.invalid/ap/users/${suffix}`;
  const peerName = `Notification peer ${suffix}`;
  const activityId = `https://notification-peer.invalid/activities/${suffix}`;
  const content = `notification target ${suffix}`;
  const created = await page.evaluate(async (text) => {
    const response = await fetch("/api/posts", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, visibility: "public" }),
    });
    return { status: response.status, body: await response.json() };
  }, content);
  const post = created.body?.post;
  requireNotification(
    created.status === 200 &&
      typeof post?.ap_id === "string" &&
      post.author?.ap_id === actorApId,
    "real owner post was not accepted",
  );
  const object = await db
    .prepare("SELECT attributed_to, content FROM objects WHERE ap_id = ?")
    .bind(post.ap_id)
    .first();
  requireNotification(
    object?.attributed_to === actorApId && object.content === content,
    "real owner post was not stored",
  );

  // Explicit synthetic inbound fixture. Remote cache entries confer no local
  // account or session authority; no extra human owner is created.
  const now = new Date().toISOString();
  const peer = {
    id: peerId,
    type: "Person",
    preferredUsername: "notification-peer",
    name: peerName,
    inbox: `${peerId}/inbox`,
  };
  const like = {
    id: activityId,
    type: "Like",
    actor: peerId,
    object: post.ap_id,
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO actor_cache (ap_id, preferred_username, name, inbox, raw_json, last_fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        peerId,
        peer.preferredUsername,
        peerName,
        peer.inbox,
        JSON.stringify(peer),
        now,
      ),
    db
      .prepare(
        "INSERT INTO activities (ap_id, type, actor_ap_id, object_ap_id, raw_json, direction, processed, created_at) VALUES (?, 'Like', ?, ?, ?, 'inbound', 1, ?)",
      )
      .bind(activityId, peerId, post.ap_id, JSON.stringify(like), now),
    db
      .prepare(
        "INSERT INTO inbox (actor_ap_id, activity_ap_id, read, created_at) VALUES (?, ?, 1, ?)",
      )
      .bind(actorApId, activityId, now),
  ]);
  const afterSeed = await identityCounts(db);
  requireNotification(
    afterSeed.actors === before.actors &&
      afterSeed.owners === before.owners &&
      afterSeed.sessions === before.sessions &&
      afterSeed.cachedPeers === before.cachedPeers + 1,
    "synthetic peer changed local owner/account/session authority",
  );

  await page.goto(`${origin}/notifications`, { waitUntil: "domcontentloaded" });
  const row = page.locator("div.border-b").filter({ hasText: peerName });
  await row.waitFor({ state: "visible", timeout: 10_000 });
  const initial = await nativeInbox(page, origin);
  requireNotification(
    initial.status === 200 &&
      initial.body.notifications?.some(
        (n) =>
          n.id === activityId && n.actor.ap_id === peerId && n.read === true,
      ),
    "native inbox did not expose the synthetic read Like",
  );

  let resolveReady;
  let resolveRelease;
  let resolveHandled;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const release = new Promise((resolve) => {
    resolveRelease = resolve;
  });
  const handled = new Promise((resolve) => {
    resolveHandled = resolve;
  });
  let snapshot;
  let routeError;
  let captured = false;
  const match = `${origin}/api/notifications**`;
  const holdNativeSnapshot = async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, "");
    if (
      path !== "/api/notifications" ||
      route.request().method() !== "GET" ||
      captured
    ) {
      await route.continue();
      return;
    }
    captured = true;
    try {
      const response = await route.fetch();
      const body = await response.json();
      snapshot = { status: response.status(), body };
      resolveReady();
      await release;
      // Deliver the unchanged real Worker response after the archive commit.
      await route.fulfill({ response });
    } catch (error) {
      routeError = error;
      resolveReady();
      try {
        await route.abort("failed");
      } catch {
        console.error("notification-refresh intercepted request abort failed");
      }
    } finally {
      resolveHandled();
    }
  };
  await page.route(match, holdNativeSnapshot);
  let primaryError;
  try {
    // Exercise the actual focus handler with an explicitly dispatched browser
    // event. This is not evidence of physical OS focus or external delivery.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await bounded(ready, "native snapshot ready");
    if (routeError) throw routeError;
    requireNotification(
      snapshot?.status === 200 &&
        snapshot.body.notifications?.some((n) => n.id === activityId),
      "held response was not a real pre-archive native snapshot",
    );

    const archiveResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/notifications/archive" &&
        response.request().method() === "POST",
      { timeout: 10_000 },
    );
    archiveResponse.catch(() => {});
    await row.getByRole("button", { name: "アーカイブ", exact: true }).click();
    const archived = await archiveResponse;
    const archivedBody = await archived.json();
    requireNotification(
      archived.status() === 200 &&
        archivedBody.success === true &&
        archivedBody.archived_count === 1,
      "real UI archive did not commit one marker",
    );
    await row.waitFor({ state: "detached", timeout: 5_000 });
    const marker = await db
      .prepare(
        "SELECT activity_ap_id FROM notification_archived WHERE actor_ap_id = ? AND activity_ap_id = ?",
      )
      .bind(actorApId, activityId)
      .first();
    const active = await nativeInbox(page, origin);
    requireNotification(
      marker?.activity_ap_id === activityId &&
        active.status === 200 &&
        !active.body.notifications?.some((n) => n.id === activityId),
      "archived row remains in authoritative active inbox",
    );
    checks.push("browser-notification-archive-persists-native-marker");

    const delivered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.replace(/\/$/, "") ===
          "/api/notifications" && response.request().method() === "GET",
      { timeout: 10_000 },
    );
    delivered.catch(() => {});
    resolveRelease();
    await bounded(handled, "delayed snapshot delivered");
    if (routeError) throw routeError;
    await (await delivered).finished();
    await page.waitForTimeout(250);
    const visible = await row.count();
    const current = await nativeInbox(page, origin);
    const nativeVisible = current.body.notifications?.some(
      (n) => n.id === activityId,
    );
    requireNotification(
      visible === 0 && current.status === 200 && nativeVisible === false,
      `archived row resurrected after stale native GET; visibleRows=${visible}; freshNativeVisible=${nativeVisible}; markerPresent=${marker?.activity_ap_id === activityId}; delayedSnapshotContainedRow=true`,
    );
    checks.push("browser-notification-stale-refresh-keeps-archived-row-absent");
    // A fix that discards EVERY focus refresh would hide new notifications.
    // Add a distinct synthetic Announce after the write and require a fresh
    // native response to update the actual list without navigating or reloading.
    const freshActivityId = `https://notification-peer.invalid/activities/fresh-${suffix}`;
    const freshAt = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO activities (ap_id, type, actor_ap_id, object_ap_id, raw_json, direction, processed, created_at) VALUES (?, 'Announce', ?, ?, ?, 'inbound', 1, ?)",
        )
        .bind(
          freshActivityId,
          peerId,
          post.ap_id,
          JSON.stringify({
            id: freshActivityId,
            type: "Announce",
            actor: peerId,
            object: post.ap_id,
          }),
          freshAt,
        ),
      db
        .prepare(
          "INSERT INTO inbox (actor_ap_id, activity_ap_id, read, created_at) VALUES (?, ?, 1, ?)",
        )
        .bind(actorApId, freshActivityId, freshAt),
    ]);
    const freshResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.replace(/\/$/, "") ===
          "/api/notifications" && response.request().method() === "GET",
      { timeout: 10_000 },
    );
    freshResponse.catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const fresh = await freshResponse;
    const freshBody = await fresh.json();
    requireNotification(
      fresh.status() === 200 &&
        freshBody.notifications?.some((n) => n.id === freshActivityId) &&
        !freshBody.notifications.some((n) => n.id === activityId),
      "fresh post-archive focus response has wrong native projection",
    );
    const freshRow = row.filter({
      hasText: "があなたの投稿をリポストしました",
    });
    await freshRow.waitFor({ state: "visible", timeout: 5_000 });
    const freshVisible = await freshRow.count();
    requireNotification(
      (await row.count()) === 1 &&
        freshVisible === 1 &&
        !(await row.innerText()).includes("いいね"),
      "fresh focus did not render exactly the new notification",
    );
    checks.push("browser-notification-fresh-focus-refresh-updates-list");
    const after = await identityCounts(db);
    requireNotification(
      after.actors === before.actors &&
        after.owners === before.owners &&
        after.sessions === before.sessions &&
        after.cachedPeers === afterSeed.cachedPeers,
      "notification archive changed local owner/account/session authority",
    );
    checks.push("browser-notification-peer-cache-keeps-local-owner-boundary");
    return {
      scope:
        "synthetic inbound Like and Announce plus one cached remote peer, real owner post/UI archive/native GET; delayed unchanged native response and fresh focus positive control; no external federation or local actor/session seed",
      before,
      after,
      activityId,
      nativeArchiveStatus: archived.status(),
      nativeMarkerPresent: true,
      delayedSnapshotContainedRow: true,
      archivedActivityNativeVisible: nativeVisible,
      visibleArchivedRowsAfterDelayedSnapshot: visible,
      freshFocusStatus: fresh.status(),
      freshFocusVisibleRows: freshVisible,
      freshFocusActivityId: freshActivityId,
      focusTrigger: "explicitly-dispatched-browser-focus-event",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    resolveRelease();
    let cleanupError;
    try {
      if (captured) await bounded(handled, "intercepted request cleanup");
    } catch (error) {
      cleanupError = error;
      console.error("notification-refresh intercepted request cleanup failed");
    }
    try {
      await page.unroute(match, holdNativeSnapshot);
    } catch (error) {
      cleanupError ??= error;
      console.error("notification-refresh route cleanup failed");
    }
    if (cleanupError && !primaryError) throw cleanupError;
  }
}
