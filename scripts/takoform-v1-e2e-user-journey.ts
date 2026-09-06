#!/usr/bin/env bun

/**
 * Public application assertions for the optional normal-OIDC lifecycle lane.
 *
 * Provider initialization, runtime-input delivery, cleanup, and the external
 * development issuer are owned by the full lifecycle runner and its disposable
 * harness.  This module only drives the public Yuru HTTP/OIDC/media/post
 * protocol after that runner has applied the sealed inputs.
 */

import { readFile } from "node:fs/promises";

const REQUEST_TIMEOUT_MS = 30_000;
const CALLBACK_PATH = "/api/auth/callback/takos";

const ONE_BY_ONE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00,
  0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

export interface NormalOidcJourneyOptions {
  readonly launchUrl: string;
  readonly issuerUrl: string;
  readonly callbackUri: string;
  readonly ownerSub: string;
}

export interface NormalOidcJourneyResult {
  readonly provider: "takos";
  readonly passwordEnabled: false;
  readonly callbackUri: string;
  readonly issuer: string;
  readonly ownerPinAccepted: true;
  readonly session: "authenticated";
  readonly originGuard: {
    readonly missingOriginRejected: true;
    readonly hostileOriginRejected: true;
  };
  readonly media: {
    readonly uploaded: true;
    readonly publicRead: true;
    readonly postDeleteReadStatus: 403;
  };
  readonly post: {
    readonly created: true;
    readonly publicRead: true;
    readonly deleted: true;
    readonly postDeleteStatus: 404;
  };
}

/** Derive the exact callback from the assigned WorkerEndpoint output. */
export function callbackUriForLaunchUrl(launchUrl: string): string {
  const value = parseUrl(launchUrl, "assigned launch URL");
  if (value.protocol !== "https:") {
    throw new Error("assigned launch URL must be HTTPS");
  }
  if (value.pathname !== "/") {
    throw new Error("assigned launch URL must be an origin root");
  }
  return new URL(CALLBACK_PATH, value).toString();
}

interface HttpResult {
  readonly response: Response;
  readonly body: string;
}

interface CookieJar {
  readonly values: Map<string, string>;
}

function setCookieLines(headers: Headers): readonly string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers);
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/** Match Set-Cookie attributes as exact semicolon-delimited tokens. */
export function hasCookieAttributes(
  line: string,
  attributes: readonly string[],
): boolean {
  const parsed = new Map<string, string | undefined>();
  for (const token of line.split(";").slice(1)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    const key = (separator < 0 ? trimmed : trimmed.slice(0, separator))
      .trim()
      .toLowerCase();
    const value =
      separator < 0
        ? undefined
        : trimmed
            .slice(separator + 1)
            .trim()
            .toLowerCase();
    parsed.set(key, value);
  }
  return attributes.every((attribute) => {
    const separator = attribute.indexOf("=");
    const key = (separator < 0 ? attribute : attribute.slice(0, separator))
      .trim()
      .toLowerCase();
    if (!parsed.has(key)) return false;
    if (separator < 0) return parsed.get(key) === undefined;
    return (
      parsed.get(key) ===
      attribute
        .slice(separator + 1)
        .trim()
        .toLowerCase()
    );
  });
}

function assertCookieAttributes(
  headers: Headers,
  name: string,
  attributes: readonly string[],
  label: string,
): void {
  const prefix = `${name}=`;
  const line = setCookieLines(headers).find((candidate) =>
    candidate.startsWith(prefix),
  );
  if (!line) throw new Error(`${label} did not set ${name}`);
  if (!hasCookieAttributes(line, attributes)) {
    throw new Error(
      `${label} ${name} cookie omitted an exact security attribute`,
    );
  }
}

function parseUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    if (label === "issuer URL" && (parsed.username || parsed.password)) {
      throw new Error("issuer URL must not contain credentials");
    }
    throw new Error(`${label} must be a credential-free absolute HTTP(S) URL`);
  }
  return parsed;
}

async function fetchStrict(
  url: string | URL,
  init: RequestInit = {},
): Promise<HttpResult> {
  const caPath = process.env.SSL_CERT_FILE?.trim();
  const tls = caPath
    ? {
        ca: await readFile(caPath, "utf8"),
        rejectUnauthorized: true,
      }
    : undefined;
  const response = await fetch(url, {
    ...init,
    redirect: init.redirect ?? "manual",
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(tls ? { tls } : {}),
  } as RequestInit & {
    readonly tls?: {
      readonly ca: string;
      readonly rejectUnauthorized: boolean;
    };
  });
  return { response, body: await response.text() };
}

function createCookieJar(): CookieJar {
  return { values: new Map<string, string>() };
}

function absorbCookies(jar: CookieJar, headers: Headers): void {
  const lines = setCookieLines(headers);
  for (const line of lines) {
    const pair = line.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    jar.values.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.values.entries()]
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function parseJson(body: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function expectJson(
  result: HttpResult,
  expectedStatus: number,
  label: string,
): Record<string, unknown> {
  if (result.response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${result.response.status}`);
  }
  return parseJson(result.body, label);
}

function location(response: Response, label: string): string {
  const value = response.headers.get("location");
  if (!value) throw new Error(`${label} did not return a redirect location`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was not a non-empty string`);
  }
  return value;
}

/** Execute the real browser-protocol OIDC and public media/post journey. */
export async function runNormalOidcApplicationJourney(
  options: NormalOidcJourneyOptions,
): Promise<NormalOidcJourneyResult> {
  const app = parseUrl(options.launchUrl, "assigned launch URL");
  const issuer = parseUrl(options.issuerUrl, "issuer URL");
  const callback = parseUrl(options.callbackUri, "OIDC callback URI");
  if (issuer.protocol !== "https:") throw new Error("issuer URL must be HTTPS");
  if (callback.toString() !== callbackUriForLaunchUrl(options.launchUrl)) {
    throw new Error(
      "OIDC callback did not match the exact assigned launch URL",
    );
  }
  if (!options.ownerSub || options.ownerSub.includes("\0")) {
    throw new Error("OIDC owner subject pin was malformed");
  }
  const appOrigin = app.origin;
  const jar = createCookieJar();

  const discovery = await fetchStrict(
    new URL("/.well-known/openid-configuration", issuer),
  );
  const discoveryBody = expectJson(discovery, 200, "OIDC discovery");
  if (discoveryBody.issuer !== issuer.origin) {
    throw new Error(
      "OIDC discovery issuer did not match the configured issuer",
    );
  }
  const providers = expectJson(
    await fetchStrict(new URL("/api/auth/providers", app)),
    200,
    "auth providers",
  );
  if (providers.password_enabled !== false) {
    throw new Error(
      "normal OIDC journey requires password auth to be disabled",
    );
  }
  if (
    !Array.isArray(providers.providers) ||
    providers.providers.length !== 1 ||
    !isRecord(providers.providers[0]) ||
    providers.providers[0].id !== "takos"
  ) {
    throw new Error(
      "auth providers did not expose only the takos OIDC provider",
    );
  }

  const login = await fetchStrict(new URL("/api/auth/login/takos", app), {
    headers: { Origin: appOrigin, accept: "text/html" },
  });
  if (![301, 302, 303, 307, 308].includes(login.response.status)) {
    throw new Error(
      `OIDC login did not redirect (HTTP ${login.response.status})`,
    );
  }
  absorbCookies(jar, login.response.headers);
  assertCookieAttributes(
    login.response.headers,
    "oauth_nonce",
    ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"],
    "OIDC login",
  );
  const authorizeUrl = new URL(location(login.response, "OIDC login"));
  if (authorizeUrl.origin !== issuer.origin) {
    throw new Error("OIDC login redirected to an unexpected issuer");
  }
  const query = authorizeUrl.searchParams;
  if (
    query.get("client_id") === null ||
    query.get("redirect_uri") !== callback.toString() ||
    query.get("response_type") !== "code" ||
    query.get("code_challenge_method") !== "S256" ||
    !query.get("state") ||
    !query.get("nonce") ||
    !/^[A-Za-z0-9_-]{40,60}$/u.test(query.get("code_challenge") ?? "")
  ) {
    throw new Error(
      "OIDC login redirect omitted state, PKCE, nonce, or exact callback",
    );
  }

  const authorize = await fetchStrict(authorizeUrl, {
    headers: { accept: "text/html" },
  });
  if (![301, 302, 303, 307, 308].includes(authorize.response.status)) {
    throw new Error(
      `OIDC authorize did not redirect (HTTP ${authorize.response.status})`,
    );
  }
  const callbackUrl = new URL(location(authorize.response, "OIDC authorize"));
  if (
    callbackUrl.origin !== appOrigin ||
    callbackUrl.pathname !== CALLBACK_PATH ||
    callbackUrl.searchParams.get("state") !== query.get("state") ||
    !callbackUrl.searchParams.get("code")
  ) {
    throw new Error(
      "OIDC authorize did not return the exact app callback state",
    );
  }

  const callbackResponse = await fetchStrict(callbackUrl, {
    headers: {
      Origin: appOrigin,
      Cookie: cookieHeader(jar),
      accept: "text/html",
    },
  });
  if (![301, 302, 303, 307, 308].includes(callbackResponse.response.status)) {
    throw new Error(
      `OIDC callback did not redirect (HTTP ${callbackResponse.response.status})`,
    );
  }
  absorbCookies(jar, callbackResponse.response.headers);
  assertCookieAttributes(
    callbackResponse.response.headers,
    "session",
    ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"],
    "OIDC callback",
  );
  const deletedNonceCookie = setCookieLines(
    callbackResponse.response.headers,
  ).find((line) => line.startsWith("oauth_nonce="));
  if (!deletedNonceCookie || !/max-age=0/i.test(deletedNonceCookie)) {
    throw new Error("OIDC callback did not expire oauth_nonce");
  }
  if (
    !jar.values.has("session") ||
    cookieHeader(jar).includes("oauth_nonce=")
  ) {
    throw new Error(
      "OIDC callback did not establish and rotate the session cookie",
    );
  }

  const me = expectJson(
    await fetchStrict(new URL("/api/auth/me", app), {
      headers: { Cookie: cookieHeader(jar), accept: "application/json" },
    }),
    200,
    "auth me",
  );
  if (
    me.provider !== "takos" ||
    me.has_takos_access !== true ||
    !isRecord(me.actor) ||
    typeof me.actor.ap_id !== "string" ||
    me.actor.role !== "owner"
  ) {
    throw new Error(
      "auth me did not report the authenticated takos owner session",
    );
  }
  let actorUrl: URL;
  try {
    actorUrl = new URL(me.actor.ap_id);
  } catch {
    throw new Error("auth me returned a malformed owner actor URL");
  }
  if (
    actorUrl.origin !== appOrigin ||
    !actorUrl.pathname.startsWith("/ap/users/")
  ) {
    throw new Error(
      "auth me owner actor was not rooted at the assigned app origin",
    );
  }

  const missingOriginProbe = await fetchStrict(new URL("/api/posts", app), {
    method: "POST",
    headers: {
      Cookie: cookieHeader(jar),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: "{}",
  });
  if (missingOriginProbe.response.status !== 403) {
    throw new Error(
      `cookie-authenticated mutation without Origin returned HTTP ${missingOriginProbe.response.status}`,
    );
  }
  const hostileOriginProbe = await fetchStrict(new URL("/api/posts", app), {
    method: "POST",
    headers: {
      Origin: "https://evil.invalid",
      Cookie: cookieHeader(jar),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: "{}",
  });
  if (hostileOriginProbe.response.status !== 403) {
    throw new Error(
      `cookie-authenticated mutation with a hostile Origin returned HTTP ${hostileOriginProbe.response.status}`,
    );
  }

  const uploadForm = new FormData();
  uploadForm.append(
    "file",
    new File([ONE_BY_ONE_PNG], "journey.png", { type: "image/png" }),
  );
  const upload = expectJson(
    await fetchStrict(new URL("/api/media/upload", app), {
      method: "POST",
      headers: {
        Origin: appOrigin,
        Cookie: cookieHeader(jar),
        accept: "application/json",
      },
      body: uploadForm,
    }),
    200,
    "media upload",
  );
  const mediaUrl = requireString(upload.url, "media upload URL");
  const mediaKey = requireString(upload.r2_key, "media upload R2 key");
  if (
    upload.content_type !== "image/png" ||
    !/^uploads\/[a-f0-9]+\.png$/u.test(mediaKey)
  ) {
    throw new Error("media upload returned an invalid PNG object identity");
  }

  const post = expectJson(
    await fetchStrict(new URL("/api/posts", app), {
      method: "POST",
      headers: {
        Origin: appOrigin,
        Cookie: cookieHeader(jar),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        content: "normal OIDC application journey",
        visibility: "public",
        attachments: [
          {
            url: mediaUrl,
            r2_key: mediaKey,
            content_type: "image/png",
            name: "journey.png",
          },
        ],
      }),
    }),
    200,
    "post create",
  );
  const apId = requireString(post.ap_id, "post ap_id");
  if (
    !isRecord(post.post) ||
    !Array.isArray(post.post.attachments) ||
    !isRecord(post.post.attachments[0]) ||
    post.post.attachments[0].url !== mediaUrl
  ) {
    throw new Error("post create did not persist the uploaded attachment");
  }

  const postUrl = new URL(`/api/posts/${encodeURIComponent(apId)}`, app);
  const publicPost = expectJson(
    await fetchStrict(postUrl, { headers: { accept: "application/json" } }),
    200,
    "public post read",
  );
  if (!isRecord(publicPost.post) || publicPost.post.ap_id !== apId) {
    throw new Error("public post read returned a different post identity");
  }
  const publicMedia = await fetchStrict(new URL(mediaUrl, app), {
    headers: { accept: "image/png" },
  });
  if (
    publicMedia.response.status !== 200 ||
    publicMedia.response.headers.get("content-type")?.split(";", 1)[0] !==
      "image/png"
  ) {
    throw new Error(
      `public media read returned HTTP ${publicMedia.response.status}`,
    );
  }

  expectJson(
    await fetchStrict(postUrl, {
      method: "DELETE",
      headers: {
        Origin: appOrigin,
        Cookie: cookieHeader(jar),
        accept: "application/json",
      },
    }),
    200,
    "post delete",
  );
  const deletedPost = await fetchStrict(postUrl, {
    headers: { accept: "application/json" },
  });
  if (deletedPost.response.status !== 404) {
    throw new Error(
      `deleted post read returned HTTP ${deletedPost.response.status}`,
    );
  }
  const deletedMedia = await fetchStrict(new URL(mediaUrl, app), {
    headers: { accept: "image/png" },
  });
  if (deletedMedia.response.status !== 403) {
    throw new Error(
      `post-delete media read returned HTTP ${deletedMedia.response.status}, expected 403 authorization denial`,
    );
  }

  return {
    provider: "takos",
    passwordEnabled: false,
    callbackUri: callback.toString(),
    issuer: issuer.origin,
    ownerPinAccepted: true,
    session: "authenticated",
    originGuard: { missingOriginRejected: true, hostileOriginRejected: true },
    media: { uploaded: true, publicRead: true, postDeleteReadStatus: 403 },
    post: {
      created: true,
      publicRead: true,
      deleted: true,
      postDeleteStatus: 404,
    },
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  throw new Error(
    "This module is an assertion library; run the full lifecycle runner",
  );
}
