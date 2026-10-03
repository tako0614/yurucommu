import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";

const ISSUER = "https://update-issuer.yurucommu.invalid";
const CLIENT = "native-update-synthetic-public-client";
const SUBJECT = "update_owner";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function cookieValue(response, name) {
  const values = setCookieValues(response);
  const prefix = name + "=";
  for (const value of values) {
    const pair = value.split(";", 1)[0]?.trim();
    if (pair?.startsWith(prefix))
      return decodeURIComponent(pair.slice(prefix.length));
  }
  return null;
}

function setCookieValues(response) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  return values
    .flatMap((value) => value.split(/, (?=[^;,=\s]+=[^;,]*)/))
    .map((value) => value.trim());
}

function safeNeed(need, condition, label) {
  // All labels passed to the caller are fixed constants; never put request or
  // credential material into a diagnostic.
  need(condition, label);
}

export async function createSyntheticUpdateIssuer({ origin, need, hash }) {
  safeNeed(need, typeof hash === "function", "update-oidc-hash-helper");
  const appOrigin = new URL(origin).origin;
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwks = {
    keys: [
      { ...publicJwk, kid: "update-fixture-key", alg: "ES256", use: "sig" },
    ],
  };
  const codes = new Map();
  const accessTokens = new Map();
  const counts = { jwks: 0, token: 0, userinfo: 0, blocked: 0, logins: 0 };

  async function idToken(nonce) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(
      JSON.stringify({ alg: "ES256", kid: "update-fixture-key", typ: "JWT" }),
    );
    const payload = b64url(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT,
        exp: now + 300,
        iat: now,
        sub: SUBJECT,
        preferred_username: SUBJECT,
        name: "Synthetic Update Owner",
        nonce,
      }),
    );
    const input = header + "." + payload;
    const signature = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      encoder.encode(input),
    );
    return input + "." + b64url(signature);
  }

  async function fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== ISSUER) {
      counts.blocked++;
      return new Response(null, { status: 502 });
    }
    if (request.method === "GET" && url.pathname === "/oauth/jwks") {
      counts.jwks++;
      return json(jwks);
    }
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      const params = new URLSearchParams(await request.text());
      const code = codes.get(params.get("code"));
      const verifier = params.get("code_verifier") ?? "";
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      const valid =
        Boolean(code) &&
        !code.consumed &&
        params.get("grant_type") === "authorization_code" &&
        params.get("client_id") === CLIENT &&
        params.get("redirect_uri") === appOrigin + "/api/auth/callback/takos" &&
        !params.has("client_secret") &&
        /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) &&
        challenge === code.challenge;
      if (!valid) return new Response(null, { status: 400 });
      code.consumed = true;
      counts.token++;
      const access = randomUUID();
      const refresh = randomUUID();
      accessTokens.set(access, SUBJECT);
      code.tokens = { access, refresh };
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 300,
        id_token: await idToken(code.nonce),
      });
    }
    if (request.method === "GET" && url.pathname === "/oauth/userinfo") {
      const authorization = request.headers.get("authorization") ?? "";
      const subject = authorization.startsWith("Bearer ")
        ? accessTokens.get(authorization.slice(7))
        : undefined;
      if (!subject) return new Response(null, { status: 401 });
      counts.userinfo++;
      return json({ sub: subject });
    }
    counts.blocked++;
    return new Response(null, { status: 502 });
  }

  async function login(mf, fetchPath, activeCookie, existingCookie) {
    const started = await fetchPath(mf, "/api/auth/login/takos", {
      method: "GET",
      redirect: "manual",
      headers: { origin: appOrigin },
    });
    safeNeed(need, started.status === 302, "update-oidc-login-redirect");
    const nonceCookie = cookieValue(started, "oauth_nonce");
    safeNeed(
      need,
      typeof nonceCookie === "string" && nonceCookie.length > 8,
      "update-oidc-nonce-cookie",
    );
    const nonceSetCookie =
      setCookieValues(started).find((value) =>
        value.trimStart().startsWith("oauth_nonce="),
      ) ?? "";
    safeNeed(
      need,
      /;\s*httponly/i.test(nonceSetCookie) &&
        /;\s*secure/i.test(nonceSetCookie) &&
        /;\s*samesite=lax/i.test(nonceSetCookie),
      "update-oidc-nonce-cookie-protected",
    );

    const authorizationUrl = new URL(
      started.headers.get("location") ?? "",
      appOrigin,
    );
    const params = authorizationUrl.searchParams;
    const redirectUri = appOrigin + "/api/auth/callback/takos";
    safeNeed(
      need,
      authorizationUrl.origin === ISSUER &&
        authorizationUrl.pathname === "/oauth/authorize",
      "update-oidc-authorize-endpoint",
    );
    safeNeed(
      need,
      params.get("response_type") === "code" &&
        params.get("client_id") === CLIENT &&
        params.get("redirect_uri") === redirectUri &&
        params.get("scope") === "openid profile email",
      "update-oidc-authorize-client",
    );
    safeNeed(
      need,
      params.get("code_challenge_method") === "S256" &&
        /^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? ""),
      "update-oidc-authorize-pkce",
    );
    safeNeed(
      need,
      (params.get("state")?.length ?? 0) > 8 &&
        (params.get("nonce")?.length ?? 0) > 8 &&
        params.get("nonce") === nonceCookie,
      "update-oidc-authorize-state-nonce",
    );

    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      challenge: params.get("code_challenge"),
      nonce: params.get("nonce"),
      consumed: false,
    });
    const callbackCookie = [
      "oauth_nonce=" + encodeURIComponent(nonceCookie),
      ...(existingCookie
        ? ["session=" + encodeURIComponent(existingCookie)]
        : []),
    ].join("; ");
    const callback = await fetchPath(
      mf,
      "/api/auth/callback/takos?code=" +
        encodeURIComponent(code) +
        "&state=" +
        encodeURIComponent(params.get("state") ?? ""),
      {
        method: "GET",
        redirect: "manual",
        headers: { origin: appOrigin, cookie: callbackCookie },
      },
    );
    safeNeed(
      need,
      callback.status === 302 && callback.headers.get("location") === "/",
      "update-oidc-callback-success",
    );
    const cookie = activeCookie(callback, "update-oidc-session-cookie");
    const cookieSetHeader =
      setCookieValues(callback).find(
        (value) => value.split(";", 1)[0].trim() === "session=" + cookie,
      ) ?? "";
    safeNeed(
      need,
      /;\s*httponly/i.test(cookieSetHeader) &&
        /;\s*secure/i.test(cookieSetHeader) &&
        /;\s*samesite=strict/i.test(cookieSetHeader),
      "update-oidc-session-cookie-protected",
    );
    const issued = codes.get(code)?.tokens;
    safeNeed(
      need,
      Boolean(issued?.access && issued?.refresh),
      "update-oidc-issued-token-pair",
    );
    counts.logins++;
    return { cookie, access: issued.access, refresh: issued.refresh };
  }

  async function assertEncrypted(row, tokens, keyHex, label) {
    // Keep diagnostics label-based and prevent accidentally reflecting arbitrary
    // row/token content through a caller-supplied label.
    const safeLabel =
      typeof label === "string" && /^[a-z0-9-]{1,48}$/i.test(label)
        ? label
        : "update-oidc-encrypted-row";
    const check = (condition, suffix) =>
      safeNeed(need, condition, safeLabel + "-" + suffix);
    check(row?.provider === "takos", "provider");
    check(
      typeof tokens?.access === "string" && typeof tokens?.refresh === "string",
      "issued-pair",
    );
    const keyBytes = Buffer.from(keyHex ?? "", "hex");
    check(
      /^[0-9a-f]{64}$/i.test(keyHex ?? "") && keyBytes.length === 32,
      "key-shape",
    );
    const key = await webcrypto.subtle.importKey(
      "raw",
      keyBytes,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const values = [
      [row.provider_access_token, tokens.access, "access"],
      [row.provider_refresh_token, tokens.refresh, "refresh"],
    ];
    const decrypted = [];
    for (const [stored, issued, kind] of values) {
      check(
        typeof stored === "string" &&
          /^[0-9a-f]{24}:[0-9a-f]{32,}$/i.test(stored) &&
          stored.split(":")[1].length % 2 === 0,
        kind + "-format",
      );
      check(!stored.includes(issued), kind + "-not-plaintext");
      const [ivHex, cipherHex] = stored.split(":");
      const iv = Buffer.from(ivHex, "hex");
      const ciphertext = Buffer.from(cipherHex, "hex");
      let plaintext;
      try {
        plaintext = await webcrypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          key,
          ciphertext,
        );
      } catch {
        check(false, kind + "-decrypt");
      }
      const decoded = decoder.decode(plaintext);
      check(decoded === issued, kind + "-matches-issued");
      decrypted.push({ iv, ciphertext, issued, kind });
    }
    const wrongBytes = Buffer.from(keyBytes);
    wrongBytes[0] ^= 0xff;
    const wrongKey = await webcrypto.subtle.importKey(
      "raw",
      wrongBytes,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    for (const item of decrypted) {
      let rejected = false;
      try {
        await webcrypto.subtle.decrypt(
          { name: "AES-GCM", iv: item.iv },
          wrongKey,
          item.ciphertext,
        );
      } catch {
        rejected = true;
      }
      check(rejected, item.kind + "-wrong-key-rejected");
      const tampered = Buffer.from(item.ciphertext);
      tampered[tampered.length - 1] ^= 1;
      rejected = false;
      try {
        await webcrypto.subtle.decrypt(
          { name: "AES-GCM", iv: item.iv },
          key,
          tampered,
        );
      } catch {
        rejected = true;
      }
      check(rejected, item.kind + "-tamper-rejected");
    }
    return true;
  }

  return {
    bindings: {
      OIDC_ISSUER_URL: ISSUER,
      OIDC_CLIENT_ID: CLIENT,
      OIDC_OWNER_SUB: SUBJECT,
    },
    fetch,
    login,
    evidence() {
      return { ...counts };
    },
    assertEncrypted,
  };
}
