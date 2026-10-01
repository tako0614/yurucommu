import { createHash } from "node:crypto";

function assert(condition, message) {
  if (!condition)
    throw new Error(`first-owner-${message.replaceAll(" ", "-")}`);
}

function sessionKey(salt, raw) {
  return `sha256:${createHash("sha256").update(`${salt}:${raw}`).digest("hex")}`;
}

async function actorRows(db) {
  return (
    await db
      .prepare(
        "SELECT ap_id, preferred_username, takos_user_id, role, owner_actor_ap_id, deleted_at FROM actors ORDER BY ap_id",
      )
      .all()
  ).results;
}

async function sessionRows(db) {
  return (
    await db
      .prepare(
        "SELECT id, member_id, access_token, expires_at, provider, provider_access_token, provider_refresh_token, provider_token_expires_at FROM sessions ORDER BY id",
      )
      .all()
  ).results;
}

function cookies(response) {
  return response.headers.getSetCookie().flatMap((header) => {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    if (!pair.startsWith("session=")) return [];
    const value = pair.slice("session=".length);
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

function activeCookie(response, scope = "password-login") {
  const active = cookies(response).filter(
    (cookie) => cookie.value && Number(cookie.settings.get("max-age")) > 0,
  );
  assert(
    active.length === 1,
    `${scope}: cookie response did not set one active session`,
  );
  const cookie = active[0];
  assert(
    cookie.settings.get("httponly") === true &&
      cookie.settings.get("secure") === true &&
      cookie.settings.get("path") === "/" &&
      cookie.settings.get("samesite")?.toLowerCase() === "strict",
    `${scope}: cookie lacks the required security attributes`,
  );
  return cookie;
}

function cookieCredential(cookie) {
  return decodeURIComponent(cookie.value);
}

function cookieHeaders(origin, cookie, json = false) {
  return {
    origin,
    ...(json ? { "content-type": "application/json" } : {}),
    cookie: `session=${cookie}`,
  };
}

function bearerHeaders(token, json = false) {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function postLogin(worker, { origin, password, transport, readJson }) {
  const path =
    transport === "browser" ? "/api/auth/login" : "/api/auth/mobile/login";
  const headers = { "content-type": "application/json" };
  if (transport === "browser") headers.origin = origin;
  const response = await worker.dispatchFetch(origin + path, {
    method: "POST",
    headers,
    body: JSON.stringify({ password }),
  });
  const body = await readJson(response, "first-owner-password-login");
  if (transport === "browser") {
    const cookie = activeCookie(response);
    return { response, body, cookie: cookieCredential(cookie), token: null };
  }
  assert(cookies(response).length === 0, "native login issued a cookie");
  assert(
    typeof body.access_token === "string" &&
      body.access_token.length > 0 &&
      body.token_type === "Bearer" &&
      body.expires_in === 30 * 24 * 60 * 60,
    "native login returned an invalid bearer credential response",
  );
  return { response, body, cookie: null, token: body.access_token };
}

function loginSucceeded(result, transport) {
  return (
    result.response.status === 200 &&
    (transport === "browser"
      ? result.body.success === true
      : typeof result.body.access_token === "string")
  );
}

async function getMe(worker, { origin, readJson }, credential) {
  const headers =
    credential.kind === "cookie"
      ? cookieHeaders(origin, credential.value)
      : bearerHeaders(credential.value);
  const response = await worker.dispatchFetch(origin + "/api/auth/me", {
    headers,
  });
  return { response, body: await readJson(response, "first-owner-identity") };
}

async function listAccounts(worker, { origin, readJson }, credential) {
  const headers =
    credential.kind === "cookie"
      ? cookieHeaders(origin, credential.value)
      : bearerHeaders(credential.value);
  const response = await worker.dispatchFetch(origin + "/api/auth/accounts", {
    headers,
  });
  return { response, body: await readJson(response, "first-owner-accounts") };
}

function ownerSessionIsValid(row, ownerApId, salt, raw) {
  return (
    !!row &&
    row.id === sessionKey(salt, raw) &&
    row.access_token === row.id &&
    row.member_id === ownerApId &&
    row.provider === null &&
    row.provider_access_token === null &&
    row.provider_refresh_token === null &&
    row.provider_token_expires_at === null &&
    Number.isFinite(Date.parse(row.expires_at)) &&
    Date.parse(row.expires_at) > Date.now()
  );
}

/**
 * Verify first-owner password onboarding against an actual product artifact.
 * All identities and HTTP traffic stay inside the disposable artifact fixture.
 */
export async function qualifyOwnerOnboarding(
  worker,
  { origin, password, sessionSalt, readJson, firstTransport },
) {
  assert(
    firstTransport === "browser" || firstTransport === "mobile",
    "requires a supported first transport",
  );
  assert(
    typeof origin === "string" && new URL(origin).origin === origin,
    "requires a normalized fixture origin",
  );
  const db = await worker.getD1Database("DB");
  const checks = [];
  const rootApId = `${origin}/ap/users/tako`;
  const personaApId = `${origin}/ap/users/onboarding_persona`;
  const initialActors = await actorRows(db);
  const initialSessions = await sessionRows(db);
  assert(
    initialActors.length === 0 && initialSessions.length === 0,
    "fixture did not start without actors and sessions",
  );

  const invalidPath =
    firstTransport === "browser" ? "/api/auth/login" : "/api/auth/mobile/login";
  const invalidHeaders = { "content-type": "application/json" };
  if (firstTransport === "browser") invalidHeaders.origin = origin;
  const invalid = await worker.dispatchFetch(origin + invalidPath, {
    method: "POST",
    headers: invalidHeaders,
    body: JSON.stringify({ password: `${password}-incorrect` }),
  });
  const invalidBody = await readJson(invalid, "first-owner-invalid-password");
  const invalidActors = await actorRows(db);
  const invalidSessions = await sessionRows(db);
  assert(
    invalid.status === 401 &&
      cookies(invalid).length === 0 &&
      invalidBody.access_token === undefined &&
      invalidActors.length === 0 &&
      invalidSessions.length === 0,
    "invalid password created an identity or credential",
  );
  checks.push("first-owner-invalid-password-refusal");

  const first = await postLogin(worker, {
    origin,
    password,
    transport: firstTransport,
    readJson,
  });
  assert(
    loginSucceeded(first, firstTransport),
    "initial password login did not succeed",
  );
  const afterFirstActors = await actorRows(db);
  const firstSessions = await sessionRows(db);
  const root = afterFirstActors.find((actor) => actor.ap_id === rootApId);
  const firstRaw = firstTransport === "browser" ? first.cookie : first.token;
  const firstKey = sessionKey(sessionSalt, firstRaw);
  assert(
    afterFirstActors.length === 1 &&
      root?.role === "owner" &&
      root.owner_actor_ap_id === null &&
      root.takos_user_id === "password:owner" &&
      root.deleted_at === null,
    "initial password login did not persist exactly one root owner",
  );
  assert(
    firstSessions.length === 1 &&
      ownerSessionIsValid(
        firstSessions.find((session) => session.id === firstKey),
        rootApId,
        sessionSalt,
        firstRaw,
      ),
    "initial password login did not persist one valid salted owner session",
  );
  checks.push("first-owner-password-creation");
  checks.push("first-owner-session-persistence");
  checks.push("first-owner-cookie-and-bearer");

  const firstCredential =
    firstTransport === "browser"
      ? { kind: "cookie", value: first.cookie }
      : { kind: "bearer", value: first.token };
  const firstIdentity = await getMe(
    worker,
    { origin, readJson },
    firstCredential,
  );
  assert(
    firstIdentity.response.status === 200 &&
      firstIdentity.body.actor?.ap_id === rootApId &&
      firstIdentity.body.actor.role === "owner" &&
      firstIdentity.body.provider === null &&
      firstIdentity.body.has_takos_access === false,
    "first login credential did not resolve the persisted local owner",
  );

  const secondTransport = firstTransport === "browser" ? "mobile" : "browser";
  const second = await postLogin(worker, {
    origin,
    password,
    transport: secondTransport,
    readJson,
  });
  assert(
    loginSucceeded(second, secondTransport),
    "cross-transport owner relogin did not succeed",
  );
  const secondRaw =
    secondTransport === "browser" ? second.cookie : second.token;
  const secondKey = sessionKey(sessionSalt, secondRaw);
  const afterSecondActors = await actorRows(db);
  const secondSessions = await sessionRows(db);
  assert(
    afterSecondActors.length === 1 &&
      afterSecondActors[0]?.ap_id === rootApId &&
      afterSecondActors[0]?.role === "owner" &&
      secondRaw !== firstRaw &&
      secondKey !== firstKey &&
      ownerSessionIsValid(
        secondSessions.find((session) => session.id === secondKey),
        rootApId,
        sessionSalt,
        secondRaw,
      ) &&
      secondSessions.length === 2,
    "cross-transport relogin duplicated owner or failed to mint a distinct session",
  );
  checks.push("first-owner-relogin");

  const browserCookie =
    firstTransport === "browser" ? first.cookie : second.cookie;
  const mobileToken = firstTransport === "mobile" ? first.token : second.token;
  const browserMe = await getMe(
    worker,
    { origin, readJson },
    {
      kind: "cookie",
      value: browserCookie,
    },
  );
  const bearerMe = await getMe(
    worker,
    { origin, readJson },
    {
      kind: "bearer",
      value: mobileToken,
    },
  );
  assert(
    browserMe.response.status === 200 &&
      browserMe.body.actor?.ap_id === rootApId &&
      browserMe.body.actor.role === "owner" &&
      browserMe.body.provider === null &&
      browserMe.body.has_takos_access === false &&
      bearerMe.response.status === 200 &&
      bearerMe.body.actor?.ap_id === rootApId &&
      bearerMe.body.actor.role === "owner" &&
      bearerMe.body.provider === null &&
      bearerMe.body.has_takos_access === false,
    "browser cookie and native bearer did not independently resolve the local owner",
  );

  const beforeAnonymousActors = await actorRows(db);
  const beforeAnonymousSessions = await sessionRows(db);
  const anonymous = await worker.dispatchFetch(origin + "/api/auth/accounts", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "onboarding_persona" }),
  });
  await readJson(anonymous, "first-owner-anonymous-account-create");
  assert(
    anonymous.status === 401 &&
      JSON.stringify(await actorRows(db)) ===
        JSON.stringify(beforeAnonymousActors) &&
      JSON.stringify(await sessionRows(db)) ===
        JSON.stringify(beforeAnonymousSessions),
    "anonymous account creation changed owner or session state",
  );
  checks.push("first-owner-anonymous-create-refusal");

  const created = await worker.dispatchFetch(origin + "/api/auth/accounts", {
    method: "POST",
    headers: bearerHeaders(mobileToken, true),
    body: JSON.stringify({
      username: "onboarding_persona",
      name: "Personal profile",
      role: "owner",
      owner_actor_ap_id: "https://unrelated.invalid/owner",
    }),
  });
  const createdBody = await readJson(created, "first-owner-persona-create");
  const afterPersonaActors = await actorRows(db);
  const persistedRoot = afterPersonaActors.find(
    (actor) => actor.ap_id === rootApId,
  );
  const persona = afterPersonaActors.find(
    (actor) => actor.ap_id === personaApId,
  );
  assert(
    created.status === 200 &&
      createdBody.success === true &&
      createdBody.account?.ap_id === personaApId &&
      afterPersonaActors.length === 2 &&
      afterPersonaActors.filter((actor) => actor.role === "owner").length ===
        1 &&
      persistedRoot?.role === "owner" &&
      persistedRoot.owner_actor_ap_id === null &&
      persona?.role === "member" &&
      persona.owner_actor_ap_id === rootApId &&
      persona.takos_user_id === "local:onboarding_persona" &&
      persona.deleted_at === null,
    "persona-linkage: persona creation escalated role, ownership, or created an extra identity",
  );
  const ownerAccountsBrowser = await listAccounts(
    worker,
    { origin, readJson },
    { kind: "cookie", value: browserCookie },
  );
  const ownerAccountsBearer = await listAccounts(
    worker,
    { origin, readJson },
    { kind: "bearer", value: mobileToken },
  );
  const expectedAccounts = new Set([rootApId, personaApId]);
  assert(
    ownerAccountsBrowser.response.status === 200 &&
      ownerAccountsBearer.response.status === 200 &&
      [ownerAccountsBrowser.body, ownerAccountsBearer.body].every(
        (body) =>
          Array.isArray(body.accounts) &&
          body.accounts.length === 2 &&
          new Set(body.accounts.map((account) => account.ap_id)).size === 2 &&
          body.accounts.every((account) =>
            expectedAccounts.has(account.ap_id),
          ) &&
          body.current_ap_id === rootApId,
      ),
    "persona-linkage: browser and bearer owner credentials did not list both owned accounts",
  );
  checks.push("first-owner-persona-linkage");

  const switchToPersona = await worker.dispatchFetch(
    origin + "/api/auth/switch",
    {
      method: "POST",
      headers: cookieHeaders(origin, browserCookie, true),
      body: JSON.stringify({ ap_id: personaApId }),
    },
  );
  const switchToPersonaBody = await readJson(
    switchToPersona,
    "first-owner-switch-to-persona",
  );
  const personaCookie = activeCookie(switchToPersona, "persona-switch");
  const personaRaw = cookieCredential(personaCookie);
  const afterSwitchToPersona = await sessionRows(db);
  const personaSession = afterSwitchToPersona.find(
    (session) => session.id === sessionKey(sessionSalt, personaRaw),
  );
  const switchedMe = await getMe(
    worker,
    { origin, readJson },
    {
      kind: "cookie",
      value: personaRaw,
    },
  );
  assert(
    switchToPersona.status === 200 &&
      switchToPersonaBody.success === true &&
      personaRaw !== browserCookie &&
      afterSwitchToPersona.some(
        (session) => session.id === sessionKey(sessionSalt, browserCookie),
      ) === false &&
      personaSession?.member_id === personaApId &&
      personaSession.provider === null &&
      personaSession.provider_access_token === null &&
      personaSession.provider_refresh_token === null &&
      personaSession.provider_token_expires_at === null &&
      switchedMe.response.status === 200 &&
      switchedMe.body.actor?.ap_id === personaApId &&
      switchedMe.body.actor.role === "member" &&
      switchedMe.body.provider === null &&
      switchedMe.body.has_takos_access === false,
    "persona-switch: cookie account switch did not rotate into the linked member persona",
  );

  const switchBack = await worker.dispatchFetch(origin + "/api/auth/switch", {
    method: "POST",
    headers: cookieHeaders(origin, personaRaw, true),
    body: JSON.stringify({ ap_id: rootApId }),
  });
  const switchBackBody = await readJson(
    switchBack,
    "first-owner-switch-back-to-root",
  );
  const rootCookie = activeCookie(switchBack, "persona-switch");
  const rootRaw = cookieCredential(rootCookie);
  const rootMe = await getMe(
    worker,
    { origin, readJson },
    {
      kind: "cookie",
      value: rootRaw,
    },
  );
  const afterSwitchBackSessions = await sessionRows(db);
  assert(
    switchBack.status === 200 &&
      switchBackBody.success === true &&
      rootRaw !== personaRaw &&
      !afterSwitchBackSessions.some(
        (session) => session.id === sessionKey(sessionSalt, personaRaw),
      ) &&
      rootMe.response.status === 200 &&
      rootMe.body.actor?.ap_id === rootApId &&
      rootMe.body.actor.role === "owner" &&
      rootMe.body.provider === null &&
      rootMe.body.has_takos_access === false,
    "persona-switch: cookie account switch did not rotate back to the root owner",
  );
  checks.push("first-owner-persona-switch");

  const finalRelogin = await postLogin(worker, {
    origin,
    password,
    transport: "mobile",
    readJson,
  });
  const finalRaw = finalRelogin.token;
  const afterFinalActors = await actorRows(db);
  const afterFinalSessions = await sessionRows(db);
  assert(
    loginSucceeded(finalRelogin, "mobile") &&
      afterFinalActors.length === 2 &&
      afterFinalActors.filter((actor) => actor.role === "owner").length === 1 &&
      afterFinalActors.find((actor) => actor.ap_id === rootApId)
        ?.owner_actor_ap_id === null &&
      afterFinalActors.find((actor) => actor.ap_id === personaApId)
        ?.owner_actor_ap_id === rootApId &&
      afterFinalSessions.some(
        (session) =>
          session.id === sessionKey(sessionSalt, finalRaw) &&
          ownerSessionIsValid(session, rootApId, sessionSalt, finalRaw),
      ),
    "owner relogin after persona creation changed identity cardinality",
  );

  return { checks, firstTransport, owners: 1, personas: 1 };
}
