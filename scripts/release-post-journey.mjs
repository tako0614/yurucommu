import { FormData } from "miniflare";

// Product-owned qualification against disposable native stores and locked Core.
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

function requireEffect(condition, message) {
  if (!condition) throw new Error(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requirePrivateRefusal(response, readJson, label) {
  if (
    response.status !== 403 ||
    response.headers.get("cache-control") !== "no-store"
  ) {
    await response.body?.cancel();
    throw new Error(`${label} exposed private attachment content`);
  }
  const body = await readJson(response, label);
  requireEffect(
    response.status === 403 &&
      response.headers.get("cache-control") === "no-store" &&
      body !== null &&
      Object.keys(body).length === 1 &&
      [
        "Authentication required",
        "Not authorized",
        "Not authorized to access this media",
      ].includes(body.error),
    `${label} exposed private attachment content`,
  );
}

async function requireMedia(response, png, scope, label) {
  const bytes = Buffer.from(await response.arrayBuffer());
  requireEffect(
    response.status === 200 &&
      response.headers.get("content-type") === "image/png" &&
      response.headers.get("cache-control")?.startsWith(`${scope},`) &&
      bytes.equals(png),
    `${label} disagrees with uploaded PNG and cache policy`,
  );
}

export async function qualifyPostAttachments(
  worker,
  { origin, ownerApId, ownerSession, unrelatedSession, png, readJson },
) {
  const db = await worker.getD1Database("DB");
  const media = await worker.getR2Bucket("MEDIA");
  const ownerHeaders = { origin, cookie: `session=${ownerSession}` };
  const outsiders = [{}, { cookie: `session=${unrelatedSession}` }];
  const snapshot = async () =>
    db
      .prepare(
        `SELECT
    (SELECT COUNT(*) FROM objects) AS notes,
    (SELECT COUNT(*) FROM activities) AS activities,
    (SELECT COUNT(*) FROM delivery_fanouts) AS fanouts,
    (SELECT COUNT(*) FROM media_uploads) AS uploads,
    (SELECT post_count FROM actors WHERE ap_id = ?) AS post_count`,
      )
      .bind(ownerApId)
      .first();
  requireEffect(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM follows WHERE following_ap_id = ?",
        )
        .bind(ownerApId)
        .first()
    ).count === 0,
    "post fixture unexpectedly has followers",
  );
  const mediaKeys = async () =>
    (await media.list()).objects.map((object) => object.key).sort();
  const beforeRefusal = await snapshot();
  const beforeMediaKeys = await mediaKeys();
  const rejected = await worker.dispatchFetch(origin + "/api/posts", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ content: "unauthenticated-post", attachments: [] }),
  });
  await readJson(rejected, "post-write-refusal");
  requireEffect(
    rejected.status === 401 &&
      same(await snapshot(), beforeRefusal) &&
      same(await mediaKeys(), beforeMediaKeys),
    "post-write-refusal accepted or persisted an anonymous write",
  );

  const uploadIds = new Set();
  const checks = ["post-write-refusal"];
  for (const visibility of ["public", "followers"]) {
    const label = `${visibility}-post`;
    const content = `release-smoke-${visibility}-post`;
    const name = `release-smoke-${visibility}-alt-text`;
    const form = new FormData();
    form.set(
      "file",
      new File([png], "post-attachment.png", { type: "image/png" }),
    );
    const uploadResponse = await worker.dispatchFetch(
      origin + "/api/media/upload",
      {
        method: "POST",
        headers: ownerHeaders,
        body: form,
      },
    );
    const upload = await readJson(uploadResponse, "post-media-upload");
    requireEffect(
      uploadResponse.status === 200 &&
        typeof upload.id === "string" &&
        upload.url === `/media/${upload.id}.png` &&
        upload.r2_key === `uploads/${upload.id}.png` &&
        upload.content_type === "image/png" &&
        !uploadIds.has(upload.id),
      "post-media-upload did not issue a distinct owned PNG",
    );
    uploadIds.add(upload.id);
    const uploadRow = await db
      .prepare(
        "SELECT uploader_ap_id, content_type, size, r2_key FROM media_uploads WHERE id = ?",
      )
      .bind(upload.id)
      .first();
    const stored = await media.get(upload.r2_key);
    requireEffect(
      uploadRow?.uploader_ap_id === ownerApId &&
        uploadRow.content_type === "image/png" &&
        uploadRow.size === png.length &&
        uploadRow.r2_key === upload.r2_key &&
        stored &&
        Buffer.from(await stored.arrayBuffer()).equals(png),
      "post-media-upload did not persist owner and exact bytes",
    );
    const unattached = await worker.dispatchFetch(origin + upload.url);
    await requirePrivateRefusal(
      unattached,
      readJson,
      "post-unattached-media-refusal",
    );

    const attachments = [
      {
        url: upload.url,
        r2_key: upload.r2_key,
        content_type: upload.content_type,
        name,
      },
    ];
    const before = await snapshot();
    const postResponse = await worker.dispatchFetch(origin + "/api/posts", {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      // Both UI composers omit the default public visibility.
      body: JSON.stringify({
        content,
        attachments,
        ...(visibility === "public" ? {} : { visibility }),
      }),
    });
    const created = await readJson(postResponse, "post-create");
    const post = created.post;
    requireEffect(
      postResponse.status === 200 &&
        typeof post?.ap_id === "string" &&
        post.ap_id.startsWith(origin + "/ap/objects/") &&
        post.type === "Note" &&
        post.author?.ap_id === ownerApId &&
        post.content === content &&
        post.visibility === visibility &&
        same(post.attachments, attachments),
      "post-create did not match the owner, visibility and attachment payload",
    );
    const to = visibility === "public" ? [PUBLIC] : [ownerApId + "/followers"];
    const cc = visibility === "public" ? [ownerApId + "/followers"] : [];
    const row = await db
      .prepare("SELECT * FROM objects WHERE ap_id = ?")
      .bind(post.ap_id)
      .first();
    requireEffect(
      row?.type === "Note" &&
        row.attributed_to === ownerApId &&
        row.content === content &&
        row.visibility === visibility &&
        row.is_local === 1 &&
        same(JSON.parse(row.attachments_json), attachments) &&
        same(JSON.parse(row.to_json), to) &&
        same(JSON.parse(row.cc_json), cc),
      "post-persistence did not persist the correlated owner, visibility and attachments",
    );
    const activityRows = (
      await db
        .prepare("SELECT * FROM activities WHERE object_ap_id = ?")
        .bind(post.ap_id)
        .all()
    ).results;
    const activity = activityRows[0];
    const documentAttachments = [
      {
        type: "Document",
        mediaType: "image/png",
        url: origin + upload.url,
        name,
      },
    ];
    const raw = activity && JSON.parse(activity.raw_json);
    requireEffect(
      activityRows.length === 1 &&
        activity.type === "Create" &&
        activity.actor_ap_id === ownerApId &&
        activity.direction === "outbound" &&
        raw.id === activity.ap_id &&
        raw.type === "Create" &&
        raw.actor === ownerApId &&
        raw.object?.id === post.ap_id &&
        raw.object.type === "Note" &&
        raw.object.attributedTo === ownerApId &&
        raw.object.content === content &&
        same(raw.to, to) &&
        same(raw.cc, cc) &&
        same(raw.object.to, to) &&
        same(raw.object.cc, cc) &&
        same(raw.object.attachment, documentAttachments),
      "post-activity did not persist the correlated outbound Create projection",
    );
    const fanouts = (
      await db
        .prepare("SELECT * FROM delivery_fanouts WHERE activity_ap_id = ?")
        .bind(activity.ap_id)
        .all()
    ).results;
    requireEffect(
      fanouts.length === 1 &&
        fanouts[0].kind === "followers" &&
        fanouts[0].target_ap_id === ownerApId &&
        fanouts[0].announce_activity_ap_id === null &&
        fanouts[0].status === "published" &&
        fanouts[0].publications >= 1,
      "post-fanout did not persist the published followers intent",
    );
    const after = await snapshot();
    requireEffect(
      after.notes === before.notes + 1 &&
        after.activities === before.activities + 1 &&
        after.fanouts === before.fanouts + 1 &&
        after.post_count === before.post_count + 1,
      "post-persistence disagrees with Note, Activity, fanout and owner counters",
    );

    const loadedResponse = await worker.dispatchFetch(
      origin + "/api/posts/" + encodeURIComponent(post.ap_id),
      {
        headers: visibility === "public" ? {} : ownerHeaders,
      },
    );
    const loaded = await readJson(loadedResponse, "post-readback");
    requireEffect(
      loadedResponse.status === 200 &&
        loaded.post?.ap_id === post.ap_id &&
        loaded.post.type === "Note" &&
        loaded.post.author?.ap_id === ownerApId &&
        loaded.post.content === content &&
        loaded.post.visibility === visibility &&
        same(loaded.post.attachments, attachments),
      "post-readback disagrees with the persisted owner, visibility and attachments",
    );

    if (visibility === "public") {
      const apResponse = await worker.dispatchFetch(post.ap_id, {
        headers: { accept: "application/activity+json" },
      });
      const ap = await readJson(apResponse, "post-activitypub");
      requireEffect(
        apResponse.status === 200 &&
          apResponse.headers
            .get("content-type")
            ?.includes("application/activity+json") &&
          ap.id === post.ap_id &&
          ap.type === "Note" &&
          ap.attributedTo === ownerApId &&
          ap.content === content &&
          same(ap.attachment, documentAttachments),
        "post-activitypub disagrees with public attachment projection",
      );
      const publicMedia = await worker.dispatchFetch(origin + upload.url);
      await requireMedia(
        publicMedia,
        png,
        "public",
        "public-post-media-readback",
      );
    } else {
      const hiddenApResponse = await worker.dispatchFetch(post.ap_id, {
        headers: { accept: "application/activity+json" },
      });
      const hiddenAp = await readJson(
        hiddenApResponse,
        "followers-post-activitypub-refusal",
      );
      requireEffect(
        hiddenApResponse.status === 404 &&
          hiddenAp?.error === "Object not found" &&
          Object.keys(hiddenAp).length === 1,
        "followers-post-activitypub-refusal exposed private Note or attachments",
      );
      const ownMedia = await worker.dispatchFetch(origin + upload.url, {
        headers: ownerHeaders,
      });
      await requireMedia(
        ownMedia,
        png,
        "private",
        "followers-post-owner-media",
      );
      for (const headers of outsiders) {
        const hiddenPost = await worker.dispatchFetch(
          origin + "/api/posts/" + encodeURIComponent(post.ap_id),
          { headers },
        );
        const hidden = await readJson(
          hiddenPost,
          "followers-post-read-refusal",
        );
        requireEffect(
          hiddenPost.status === 404 &&
            hidden?.error === "Post not found" &&
            Object.keys(hidden).length === 1,
          "followers-post-read-refusal exposed private post content",
        );
        const deniedMedia = await worker.dispatchFetch(origin + upload.url, {
          headers,
        });
        await requirePrivateRefusal(
          deniedMedia,
          readJson,
          "followers-post-media-refusal",
        );
      }
    }
    checks.push(
      `${label}-persistence`,
      `${label}-readback`,
      `${label}-media-visibility`,
    );
  }
  checks.push("public-post-activitypub", "followers-post-activitypub-refusal");
  return checks;
}
