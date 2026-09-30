import { createHash } from "node:crypto";
import {
  loginProductSession,
  logoutProductSession,
} from "./release-auth-journey.mjs";

// Disposable native artifact qualification only. These values are test session
// credentials, not a login provider or production account configuration.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==",
  "base64",
);

function requireEffect(condition, message) {
  if (!condition) throw new Error(message);
}

async function requirePrivateDenialBody(response, readJson, label) {
  const denied = await readJson(response, label);
  requireEffect(
    denied !== null &&
      Object.keys(denied).length === 1 &&
      [
        "Authentication required",
        "Not authorized",
        "Not authorized to access this media",
      ].includes(denied.error),
    `${label} included non-error content`,
  );
}

function uploadBody(bytes = PNG) {
  const body = new FormData();
  body.set(
    "file",
    new File([bytes], "release-smoke.png", { type: "image/png" }),
  );
  return body;
}

export async function qualifyProductJourneys(
  worker,
  { origin, password, sessionSalt, readJson },
) {
  const db = await worker.getD1Database("DB");
  const media = await worker.getR2Bucket("MEDIA");
  const actors = {};
  const sessions = {};
  const rawSessions = {
    sender: "release-smoke-session-sender-6fe2c1d4",
    recipient: "release-smoke-session-recipient-a108328f",
    unrelated: "release-smoke-session-unrelated-ecf49f83",
  };
  for (const role of ["sender", "recipient", "unrelated"]) {
    const actor = `${origin}/ap/users/release-smoke-${role}`;
    const raw = rawSessions[role];
    const stored = `sha256:${createHash("sha256").update(`${sessionSalt}:${raw}`).digest("hex")}`;
    actors[role] = actor;
    sessions[role] = raw;
    await db.batch([
      db
        .prepare(
          `INSERT INTO actors (ap_id, preferred_username, inbox, outbox,
          followers_url, following_url, public_key_pem, private_key_pem, role)
          VALUES (?, ?, ?, ?, ?, ?, 'fixture', 'fixture', ?)`,
        )
        .bind(
          actor,
          `release-smoke-${role}`,
          `${actor}/inbox`,
          `${actor}/outbox`,
          `${actor}/followers`,
          `${actor}/following`,
          role === "sender" ? "owner" : "member",
        ),
      db
        .prepare(
          `INSERT INTO sessions (id, member_id, access_token, expires_at)
          VALUES (?, ?, ?, '2999-01-01T00:00:00.000Z')`,
        )
        .bind(stored, actor, stored),
    ]);
  }

  const authSession = await loginProductSession(worker, {
    origin,
    password,
    sessionSalt,
    readJson,
    actorApId: actors.sender,
    oldSession: sessions.sender,
  });
  sessions.sender = authSession.sessionId;

  const headers = (role) => ({
    origin,
    cookie: `session=${sessions[role]}`,
  });
  const recipientPath = `/api/dm/user/${encodeURIComponent(actors.recipient)}/messages`;
  const senderPath = `/api/dm/user/${encodeURIComponent(actors.sender)}/messages`;
  const content = "release-smoke-dm";
  const sentResponse = await worker.dispatchFetch(origin + recipientPath, {
    method: "POST",
    headers: { ...headers("sender"), "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const sent = await readJson(sentResponse, "authenticated-dm");
  requireEffect(
    sentResponse.status === 201 &&
      typeof sent.message?.id === "string" &&
      sent.message.content === content &&
      typeof sent.conversation_id === "string" &&
      sent.conversation_id.length > 0,
    `authenticated-dm did not accept the sender: ${JSON.stringify(sent)}`,
  );
  const row = await db
    .prepare(
      `SELECT o.type, o.attributed_to, o.content, o.visibility, o.to_json,
      o.conversation,
      (SELECT COUNT(*) FROM object_recipients r WHERE r.object_ap_id = o.ap_id) AS recipient_count,
      (SELECT COUNT(*) FROM object_recipients r WHERE r.object_ap_id = o.ap_id AND r.recipient_ap_id = ? AND r.type = 'to') AS addressed_count,
      (SELECT COUNT(*) FROM activities a WHERE a.object_ap_id = o.ap_id) AS activity_count,
      (SELECT COUNT(*) FROM activities a JOIN inbox i ON i.activity_ap_id = a.ap_id
        WHERE a.object_ap_id = o.ap_id AND a.type = 'Create' AND a.actor_ap_id = ?
        AND a.direction = 'inbound' AND i.actor_ap_id = ?) AS inbox_count
      FROM objects o WHERE o.ap_id = ?`,
    )
    .bind(actors.recipient, actors.sender, actors.recipient, sent.message.id)
    .first();
  requireEffect(
    row?.type === "Note" &&
      row.attributed_to === actors.sender &&
      row.content === content &&
      row.visibility === "direct" &&
      row.to_json === JSON.stringify([actors.recipient]) &&
      row.conversation === sent.conversation_id &&
      row.recipient_count === 1 &&
      row.addressed_count === 1 &&
      row.activity_count === 1 &&
      row.inbox_count === 1,
    `authenticated-dm did not persist correlated recipient/activity/inbox records: ${JSON.stringify(row)}`,
  );

  const receivedResponse = await worker.dispatchFetch(origin + senderPath, {
    headers: headers("recipient"),
  });
  const received = await readJson(receivedResponse, "recipient-dm-readback");
  requireEffect(
    receivedResponse.status === 200 &&
      received.conversation_id === sent.conversation_id &&
      received.messages?.length === 1 &&
      received.messages[0].id === sent.message.id &&
      received.messages[0].content === content &&
      received.messages[0].sender?.ap_id === actors.sender,
    `authenticated-dm recipient readback disagrees: ${JSON.stringify(received)}`,
  );
  const unrelatedResponse = await worker.dispatchFetch(origin + senderPath, {
    headers: headers("unrelated"),
  });
  const unrelated = await readJson(unrelatedResponse, "dm-isolation");
  requireEffect(
    unrelatedResponse.status === 200 &&
      Array.isArray(unrelated.messages) &&
      unrelated.messages.length === 0,
    `DM isolation exposed a message to an unrelated actor: ${JSON.stringify(unrelated)}`,
  );

  const uploadResponse = await worker.dispatchFetch(
    `${origin}/api/media/upload`,
    {
      method: "POST",
      headers: headers("sender"),
      body: uploadBody(),
    },
  );
  const upload = await readJson(uploadResponse, "media-upload");
  requireEffect(
    uploadResponse.status === 200 &&
      typeof upload.id === "string" &&
      upload.url === `/media/${upload.id}.png` &&
      upload.r2_key === `uploads/${upload.id}.png` &&
      upload.content_type === "image/png",
    `media-upload did not accept a valid PNG: ${JSON.stringify(upload)}`,
  );
  const uploadRow = await db
    .prepare(
      "SELECT uploader_ap_id, content_type, size, r2_key FROM media_uploads WHERE id = ?",
    )
    .bind(upload.id)
    .first();
  const blob = await media.get(upload.r2_key);
  requireEffect(
    uploadRow?.uploader_ap_id === actors.sender &&
      uploadRow.content_type === "image/png" &&
      uploadRow.size === PNG.length &&
      uploadRow.r2_key === upload.r2_key &&
      blob &&
      Buffer.from(await blob.arrayBuffer()).equals(PNG),
    "media-upload did not persist uploader ownership and exact PNG bytes",
  );
  const mediaResponse = await worker.dispatchFetch(origin + upload.url, {
    headers: headers("sender"),
  });
  requireEffect(
    mediaResponse.status === 200 &&
      mediaResponse.headers.get("content-type") === "image/png" &&
      mediaResponse.headers.get("cache-control")?.startsWith("private,") &&
      Buffer.from(await mediaResponse.arrayBuffer()).equals(PNG),
    "media-readback did not preserve private uploader bytes",
  );
  for (const deniedHeaders of [{}, headers("unrelated")]) {
    const denied = await worker.dispatchFetch(origin + upload.url, {
      headers: deniedHeaders,
    });
    requireEffect(
      denied.status === 403 &&
        denied.headers.get("cache-control") === "no-store",
      "media-readback exposed unattached private media to another viewer",
    );
    await requirePrivateDenialBody(denied, readJson, "private-media-refusal");
  }

  const counts = () =>
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM objects) AS notes,
      (SELECT COUNT(*) FROM object_recipients) AS recipients,
      (SELECT COUNT(*) FROM activities) AS activities,
      (SELECT COUNT(*) FROM inbox) AS inbox,
      (SELECT COUNT(*) FROM media_uploads) AS uploads`,
      )
      .first();
  const keys = async () =>
    (await media.list()).objects.map((object) => object.key).sort();
  const before = JSON.stringify(await counts());
  const beforeKeys = JSON.stringify(await keys());
  const unauthenticatedDm = await worker.dispatchFetch(origin + recipientPath, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ content: "unauthenticated-write" }),
  });
  requireEffect(
    unauthenticatedDm.status === 401,
    "unauthenticated-api-refusal accepted a DM write",
  );
  // Consume each response before dispatching the next request. Holding several
  // unread workerd bodies fails reader cleanup under the pinned CI Bun 1.3.14.
  await readJson(unauthenticatedDm, "write-refusal");
  const unauthenticatedMedia = await worker.dispatchFetch(
    `${origin}/api/media/upload`,
    {
      method: "POST",
      headers: { origin },
      body: uploadBody(),
    },
  );
  requireEffect(
    unauthenticatedMedia.status === 401,
    "unauthenticated-api-refusal accepted a media write",
  );
  await readJson(unauthenticatedMedia, "write-refusal");
  const invalidMedia = await worker.dispatchFetch(
    `${origin}/api/media/upload`,
    {
      method: "POST",
      headers: headers("sender"),
      body: uploadBody(Buffer.from("not-a-png")),
    },
  );
  requireEffect(
    invalidMedia.status === 400,
    "invalid-media-refusal accepted non-PNG bytes",
  );
  await readJson(invalidMedia, "write-refusal");
  requireEffect(
    JSON.stringify(await counts()) === before &&
      JSON.stringify(await keys()) === beforeKeys,
    "unauthenticated-api-refusal left durable write effects",
  );

  await logoutProductSession(worker, { origin, readJson }, authSession);
  const revokedDm = await worker.dispatchFetch(origin + recipientPath, {
    method: "POST",
    headers: { ...headers("sender"), "content-type": "application/json" },
    body: JSON.stringify({ content: "revoked-session-write" }),
  });
  requireEffect(
    revokedDm.status === 401,
    "logout-revocation accepted a DM write",
  );
  await readJson(revokedDm, "logout-revocation");
  const revokedUpload = await worker.dispatchFetch(
    origin + "/api/media/upload",
    {
      method: "POST",
      headers: headers("sender"),
      body: uploadBody(),
    },
  );
  requireEffect(
    revokedUpload.status === 401,
    "logout-revocation accepted a media write",
  );
  await readJson(revokedUpload, "logout-revocation");
  const revokedRead = await worker.dispatchFetch(origin + upload.url, {
    headers: headers("sender"),
  });
  requireEffect(
    revokedRead.status === 403 &&
      revokedRead.headers.get("cache-control") === "no-store",
    "logout-revocation exposed private media",
  );
  await requirePrivateDenialBody(revokedRead, readJson, "logout-revocation");
  requireEffect(
    JSON.stringify(await counts()) === before &&
      JSON.stringify(await keys()) === beforeKeys,
    "logout-revocation left durable write effects",
  );
  return [
    "password-login",
    "session-rotation",
    "invalid-password-refusal",
    "authenticated-dm",
    "dm-isolation",
    "media-upload",
    "media-readback",
    "private-media-read-refusal",
    "invalid-media-refusal",
    "unauthenticated-api-refusal",
    "logout-revocation",
  ];
}
