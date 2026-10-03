import { createHash } from "node:crypto";

function requireEffect(condition, message) {
  if (!condition) throw new Error(message);
}

function sessionKey(salt, raw) {
  return `sha256:${createHash("sha256").update(`${salt}:${raw}`).digest("hex")}`;
}

async function sessionRows(db) {
  return (await db.prepare("SELECT * FROM sessions ORDER BY id").all()).results;
}

async function actorRows(db) {
  return (
    await db.prepare("SELECT ap_id, role FROM actors ORDER BY ap_id").all()
  ).results;
}

function sessionCookies(response) {
  return response.headers.getSetCookie().flatMap((header) => {
    requireEffect(
      header.length <= 4096,
      "authentication cookie exceeded its bound",
    );
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    if (!pair.startsWith("session=")) return [];
    const value = pair.slice("session=".length);
    requireEffect(
      value.length <= 256,
      "authentication session exceeded its bound",
    );
    const settings = new Map(
      attributes.map((attribute) => {
        const separator = attribute.indexOf("=");
        return separator < 0
          ? [attribute.toLowerCase(), true]
          : [
              attribute.slice(0, separator).toLowerCase(),
              attribute.slice(separator + 1),
            ];
      }),
    );
    return [{ value, settings }];
  });
}

/** Actual password route against disposable native bindings, never real credentials. */
export async function loginProductSession(
  worker,
  { origin, password, sessionSalt, actorApId, oldSession, readJson },
) {
  const db = await worker.getD1Database("DB");
  const initialSessions = await sessionRows(db);
  const initialActors = await actorRows(db);
  const oldKey = sessionKey(sessionSalt, oldSession);
  requireEffect(
    initialActors.filter((actor) => actor.role === "owner").length === 1 &&
      initialActors.some(
        (actor) => actor.ap_id === actorApId && actor.role === "owner",
      ),
    "password-login requires the existing fixture owner",
  );
  const rejected = await worker.dispatchFetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: password + "-incorrect" }),
  });
  await readJson(rejected, "invalid-password-refusal");
  requireEffect(
    rejected.status === 401 &&
      sessionCookies(rejected).length === 0 &&
      JSON.stringify(await sessionRows(db)) === JSON.stringify(initialSessions),
    "invalid-password-refusal minted, changed or accepted a session",
  );

  const response = await worker.dispatchFetch(origin + "/api/auth/login", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: `session=${oldSession}`,
    },
    body: JSON.stringify({ password }),
  });
  const body = await readJson(response, "password-login");
  const activeCookies = sessionCookies(response).filter(
    (cookie) => cookie.value && Number(cookie.settings.get("max-age")) > 0,
  );
  requireEffect(
    response.status === 200 &&
      body.success === true &&
      activeCookies.length === 1,
    "password-login did not issue one active session cookie",
  );
  const cookie = activeCookies[0];
  requireEffect(
    cookie.settings.get("httponly") === true &&
      cookie.settings.get("secure") === true &&
      cookie.settings.get("path") === "/" &&
      cookie.settings.get("samesite")?.toLowerCase() === "strict" &&
      cookie.value !== oldSession,
    "password-login did not preserve HTTPS cookie policy and rotation",
  );
  const rawSession = decodeURIComponent(cookie.value);
  const key = sessionKey(sessionSalt, rawSession);
  const currentSessions = await sessionRows(db);
  const saved = currentSessions.find((session) => session.id === key);
  requireEffect(
    saved?.member_id === actorApId &&
      saved.access_token === key &&
      Number.isFinite(Date.parse(saved.expires_at)) &&
      Date.parse(saved.expires_at) > Date.now(),
    "password-login did not persist the salted owner session",
  );
  const otherSessions = initialSessions.filter(
    (session) => session.id !== oldKey,
  );
  requireEffect(
    initialSessions.some((session) => session.id === oldKey) &&
      !currentSessions.some((session) => session.id === oldKey) &&
      JSON.stringify(
        currentSessions.filter((session) => session.id !== key),
      ) === JSON.stringify(otherSessions) &&
      JSON.stringify(await actorRows(db)) === JSON.stringify(initialActors),
    "session-rotation did not revoke only the prior session",
  );

  const oldReplay = await worker.dispatchFetch(origin + "/api/auth/me", {
    headers: { cookie: `session=${oldSession}` },
  });
  await readJson(oldReplay, "session-rotation");
  requireEffect(
    oldReplay.status === 401,
    "session-rotation accepted the old cookie",
  );
  const identity = await worker.dispatchFetch(origin + "/api/auth/me", {
    headers: { cookie: `session=${cookie.value}` },
  });
  const me = await readJson(identity, "password-login-identity");
  requireEffect(
    identity.status === 200 &&
      me.actor?.ap_id === actorApId &&
      me.actor.role === "owner",
    "password-login cookie did not resolve the existing owner",
  );
  // Credentials remain local to this helper's caller, never in the result JSON.
  return { sessionId: cookie.value, key, otherSessions, initialActors };
}

export async function logoutProductSession(
  worker,
  { origin, readJson },
  session,
) {
  const db = await worker.getD1Database("DB");
  const response = await worker.dispatchFetch(origin + "/api/auth/logout", {
    method: "POST",
    headers: { origin, cookie: `session=${session.sessionId}` },
  });
  const body = await readJson(response, "logout-revocation");
  const cookies = sessionCookies(response);
  requireEffect(
    response.status === 200 &&
      body.success === true &&
      cookies.length === 1 &&
      cookies[0].value === "" &&
      Number(cookies[0].settings.get("max-age")) === 0 &&
      cookies[0].settings.get("path") === "/",
    "logout-revocation did not clear the session cookie",
  );
  const remaining = await sessionRows(db);
  requireEffect(
    !remaining.some((row) => row.id === session.key) &&
      JSON.stringify(remaining) === JSON.stringify(session.otherSessions),
    "logout-revocation left the session active or changed another session",
  );
  const replay = await worker.dispatchFetch(origin + "/api/auth/me", {
    headers: { cookie: `session=${session.sessionId}` },
  });
  await readJson(replay, "logout-revocation");
  requireEffect(
    replay.status === 401 &&
      JSON.stringify(await actorRows(db)) ===
        JSON.stringify(session.initialActors),
    "logout-revocation accepted the revoked cookie or changed an actor",
  );
}
