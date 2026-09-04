import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;
type MutationResponseValidator = (value: JsonRecord) => JsonRecord;

const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 64 * 1024;

export interface PinnedHttpTransport {
  readonly origin: string;
  request(url: URL, init?: RequestInit): Promise<Response>;
}

/** DNS seam used by tests; production delegates to the system resolver. */
export type HostAddressResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly string[]>;

export interface PinnedHttpTransportOptions {
  /** Test seam; production callers use the bounded 30-second default. */
  readonly timeoutMs?: number;
  /** Optional resolver seam for deterministic timeout/rebinding tests. */
  readonly resolveAddresses?: HostAddressResolver;
  /** Alias retained for callers that name the seam `resolver`. */
  readonly resolver?: HostAddressResolver;
}

export interface FunctionalProbeOptions {
  readonly launchUrl: string;
  /** Optional pre-qualified transport; otherwise the launch host is pinned once. */
  readonly transport?: PinnedHttpTransport;
  /** Existing session cookie obtained through the real configured provider. */
  readonly sessionCookie?: string;
  /** Exact actor identity that owns the disposable staging probe session. */
  readonly expectedActorApId?: string;
  /** Password is retained only for the direct-install smoke lane. */
  readonly password?: string;
  /** Require the managed Takosumi Accounts OIDC provider and no password. */
  readonly requireOidc?: boolean;
}

export interface FunctionalProbeResult {
  readonly checks: readonly string[];
  readonly cleanupVerified: true;
}

interface ProbeContext {
  readonly origin: string;
  readonly transport: PinnedHttpTransport;
  sessionCookie: string;
}

export class FunctionalProbeMutationUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunctionalProbeMutationUncertainError";
  }
}

export function isFunctionalProbeMutationUncertain(value: unknown): boolean {
  if (value instanceof FunctionalProbeMutationUncertainError) return true;
  if (value instanceof AggregateError) {
    return value.errors.some(isFunctionalProbeMutationUncertain);
  }
  return false;
}

/**
 * Run the product-level smoke against an already allocated endpoint.
 *
 * The managed staging E2E injects a session cookie minted by the real
 * Takosumi Accounts OIDC callback. It never calls the password login route in
 * that lane. The direct-install entry point below keeps the older password
 * smoke behavior for deployments that explicitly configure it.
 *
 * Notes CRUD is intentionally disabled here until an owner-published,
 * pinned `/api/notes/me` contract or run-scoped actor boundary exists.  A
 * generic session cannot safely establish disposable-note custody.
 */
export async function runFunctionalProbe(
  options: FunctionalProbeOptions,
): Promise<FunctionalProbeResult> {
  const launchUrl = requireHttpUrl(options.launchUrl, "launch_url");
  const transport =
    options.transport ?? (await createPinnedHttpTransport(launchUrl));
  if (transport.origin !== launchUrl.origin) {
    throw new Error(
      "functional probe transport origin does not match launch_url",
    );
  }
  const context: ProbeContext = {
    origin: launchUrl.origin,
    transport,
    sessionCookie: validateSessionCookie(options.sessionCookie ?? ""),
  };
  const checks: string[] = [];
  let postId: string | undefined;
  let actorApId = "";
  let primaryError: unknown;
  let mutationUncertain = false;

  if (options.requireOidc && !context.sessionCookie) {
    throw new Error(
      "managed OIDC functional probe requires a session cookie from the configured Takosumi Accounts callback",
    );
  }

  try {
    await expectStatus(context, "/", 200);
    checks.push("shell");

    const health = await requestJson(context, "/healthz", {
      expectedStatus: 200,
    });
    if (
      health.status !== "ok" ||
      !Array.isArray(health.missingBindings) ||
      health.missingBindings.length > 0
    ) {
      throw new Error("healthz did not report a fully configured runtime");
    }
    checks.push("health");

    const capabilities = await requestJson(
      context,
      "/.well-known/social-server",
      {
        expectedStatus: 200,
      },
    );
    if (!isRecord(capabilities)) {
      throw new Error("social-server discovery response is invalid");
    }
    checks.push("social-server.discovery");

    const providers = await requestJson(context, "/api/auth/providers", {
      expectedStatus: 200,
    });
    if (options.requireOidc) {
      assertManagedOidcProviders(providers);
      checks.push("auth.providers.oidc");
    } else {
      if (providers.password_enabled !== true) {
        throw new Error("password authentication is not enabled for the probe");
      }
      checks.push("auth.providers");
    }

    if (!context.sessionCookie) {
      if (!options.password) {
        throw new Error(
          "password is required when no session cookie is supplied",
        );
      }
      context.sessionCookie = await performPasswordLogin(
        context,
        options.password,
      );
      checks.push("auth.login");
    }

    const me = await requestJson(context, "/api/auth/me", {
      expectedStatus: 200,
    });
    if (!isRecord(me.actor) || typeof me.actor.ap_id !== "string") {
      throw new Error("authenticated actor response is invalid");
    }
    actorApId = me.actor.ap_id;
    if (
      options.expectedActorApId !== undefined &&
      actorApId !== options.expectedActorApId
    ) {
      throw new Error(
        "authenticated actor did not match the exact disposable staging probe actor",
      );
    }
    checks.push(options.requireOidc ? "auth.oidc-session" : "auth.me");

    const recommendations = await requestJson(
      context,
      "/api/recommendations/users",
      { expectedStatus: 200 },
    );
    if (!Array.isArray(recommendations.users)) {
      throw new Error("recommendations response does not contain users[]");
    }
    checks.push("recommendations.users");

    const postContent = `e2e-post-${crypto.randomUUID()}`;
    const createdPost = await requestJson(context, "/api/posts", {
      method: "POST",
      body: { content: postContent, visibility: "public" },
      expectedStatus: 200,
      headers: {
        "Idempotency-Key": `yurucommu-smoke-post-${postContent.slice("e2e-post-".length)}`,
      },
      validator: (value) =>
        parseCreatedPostResponse(value, postContent, actorApId),
    });
    const post = createdPost.post as JsonRecord;
    const postApId = post.ap_id;
    if (typeof postApId !== "string")
      throw new Error("created post id is invalid");
    postId = postApId.split("/").filter(Boolean).at(-1);
    if (!postId) throw new Error("created post id is invalid");
    const loadedPost = await requestJson(
      context,
      `/api/posts/${encodeURIComponent(postId)}`,
      { expectedStatus: 200 },
    );
    const loaded = isRecord(loadedPost.post) ? loadedPost.post : loadedPost;
    if (loaded.content !== postContent) {
      throw new Error("created post was not returned by the post API");
    }
    checks.push("posts.crud");
  } catch (error) {
    primaryError = error;
    mutationUncertain = isFunctionalProbeMutationUncertain(error);
  }

  const cleanupErrors: unknown[] = [];
  if (mutationUncertain) {
    cleanupErrors.push(
      new Error(
        "probe cleanup refused: a non-safe request acknowledgement was lost after dispatch; reconcile by its idempotency key before deleting",
      ),
    );
  } else if (postId) {
    try {
      await requestJson(context, `/api/posts/${encodeURIComponent(postId)}`, {
        method: "DELETE",
        expectedStatus: 200,
        validator: (value) =>
          parseMutationSuccessResponse(value, "DELETE /api/posts/:id"),
      });
      await verifyPostAbsent(postId, (path) => requestResponse(context, path));
      checks.push("posts.cleanup");
      checks.push("posts.cleanup.readback");
    } catch (error) {
      if (isFunctionalProbeMutationUncertain(error)) mutationUncertain = true;
      cleanupErrors.push(error);
    }
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "Yurucommu probe and cleanup both failed",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Yurucommu probe cleanup failed");
  }

  return { checks, cleanupVerified: true };
}

export async function main(): Promise<void> {
  const outputsPath = requiredEnv("TAKOSUMI_CAPSULE_OUTPUTS_FILE");
  const password = requiredEnv("YURUCOMMU_E2E_PASSWORD");
  const outputs = parseRecord(
    JSON.parse(await readFile(outputsPath, "utf8")),
    "Capsule outputs",
  );
  const baseUrl = firstString(outputs, ["launch_url"]);
  if (!baseUrl) throw new Error("Capsule outputs do not contain a public URL");

  const result = await runFunctionalProbe({ launchUrl: baseUrl, password });
  console.log(
    JSON.stringify({
      kind: "takosumi.capsule-functional-probe@v1",
      status: "passed",
      product: "yurucommu",
      checks: result.checks.map((name) => ({ name, status: "passed" })),
      cleanupVerified: result.cleanupVerified,
    }),
  );
}

export async function verifyPostAbsent(
  postId: string,
  read: (path: string) => Promise<Response>,
): Promise<void> {
  const response = await read(`/api/posts/${encodeURIComponent(postId)}`);
  await response.body?.cancel();
  if (response.status === 404) return;
  if (response.status >= 200 && response.status < 300) {
    throw new Error("post cleanup readback still found the probe post");
  }
  throw new Error(`post cleanup readback returned HTTP ${response.status}`);
}

async function expectStatus(
  context: ProbeContext,
  path: string,
  expectedStatus: number,
): Promise<void> {
  const response = await context.transport.request(
    new URL(path, context.origin),
    {
      headers: { origin: context.origin },
    },
  );
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    throw new Error(
      `GET ${path} returned ${response.status}, expected ${expectedStatus}`,
    );
  }
  await response.body?.cancel();
}

async function requestResponse(
  context: ProbeContext,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const bodyPresent = options.body !== undefined;
  return context.transport.request(new URL(path, context.origin), {
    method: options.method ?? "GET",
    headers: options.headers
      ? {
          ...(bodyPresent ? jsonHeaders(context) : requestHeaders(context)),
          ...options.headers,
        }
      : bodyPresent
        ? jsonHeaders(context)
        : requestHeaders(context),
    ...(bodyPresent ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function requestJson(
  context: ProbeContext,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly expectedStatus: number;
    readonly headers?: Record<string, string>;
    readonly validator?: MutationResponseValidator;
  },
): Promise<JsonRecord> {
  const method = options.method ?? "GET";
  let response: Response;
  try {
    response = await requestResponse(context, path, {
      method,
      body: options.body,
      headers: options.headers,
    });
  } catch (error) {
    if (method !== "GET") {
      throw new FunctionalProbeMutationUncertainError(
        `${method} ${path} acknowledgement is indeterminate after dispatch`,
      );
    }
    throw error;
  }
  let text: string;
  try {
    text = await readBoundedResponseText(response, path);
  } catch (error) {
    if (method !== "GET") {
      throw new FunctionalProbeMutationUncertainError(
        `${method} ${path} response body was not safely consumed after dispatch`,
      );
    }
    throw error;
  }
  if (response.status !== options.expectedStatus) {
    const message = `${method} ${path} returned ${response.status}, expected ${options.expectedStatus}`;
    if (method !== "GET")
      throw new FunctionalProbeMutationUncertainError(message);
    throw new Error(message);
  }
  let parsed: JsonRecord;
  try {
    parsed = parseRecord(JSON.parse(text), `${method} ${path}`);
  } catch (error) {
    if (method !== "GET") {
      throw new FunctionalProbeMutationUncertainError(
        `${method} ${path} returned an unparseable mutation response after dispatch`,
      );
    }
    throw error;
  }
  if (!options.validator) return parsed;
  try {
    return options.validator(parsed);
  } catch (error) {
    if (method !== "GET") {
      throw new FunctionalProbeMutationUncertainError(
        `${method} ${path} returned a semantically invalid mutation response after dispatch`,
      );
    }
    throw error;
  }
}

/** The pinned core post-create route returns a closed duplicated projection. */
export function parseCreatedPostResponse(
  value: JsonRecord,
  expectedContent: string,
  expectedActorApId?: string,
): JsonRecord {
  const label = "POST /api/posts response";
  assertClosedKeys(
    value,
    [
      "announce_count",
      "ap_id",
      "attachments",
      "author",
      "bookmarked",
      "content",
      "like_count",
      "liked",
      "post",
      "published",
      "reply_count",
      "summary",
      "type",
      "visibility",
    ],
    ["mention_processing"],
    label,
  );
  const topLevel = { ...value };
  delete topLevel.post;
  const topProjection = parseCreatedPostProjection(
    topLevel,
    `${label} (top-level)`,
    expectedContent,
  );
  const nestedProjection = parseCreatedPostProjection(
    value.post,
    `${label}.post`,
    expectedContent,
  );
  if (expectedActorApId !== undefined) {
    for (const projection of [topProjection, nestedProjection]) {
      const author = projection.author as JsonRecord;
      if (author.ap_id !== expectedActorApId) {
        throw new Error(
          "POST /api/posts response author did not match the disposable probe actor",
        );
      }
    }
  }
  for (const key of [
    "announce_count",
    "ap_id",
    "attachments",
    "author",
    "bookmarked",
    "content",
    "like_count",
    "liked",
    "published",
    "reply_count",
    "summary",
    "type",
    "visibility",
    "mention_processing",
  ]) {
    if (!jsonValuesEqual(topProjection[key], nestedProjection[key])) {
      throw new Error(
        `POST /api/posts response duplicated ${key} projection did not match`,
      );
    }
  }
  return value;
}

const CREATED_POST_PROJECTION_KEYS = [
  "announce_count",
  "ap_id",
  "attachments",
  "author",
  "bookmarked",
  "content",
  "like_count",
  "liked",
  "published",
  "reply_count",
  "summary",
  "type",
  "visibility",
] as const;

function parseCreatedPostProjection(
  value: unknown,
  label: string,
  expectedContent: string,
): JsonRecord {
  const projection = parseRecord(value, label);
  assertClosedKeys(
    projection,
    CREATED_POST_PROJECTION_KEYS,
    ["mention_processing"],
    label,
  );
  if (typeof projection.ap_id !== "string" || !projection.ap_id.trim()) {
    throw new Error(`${label}.ap_id was missing`);
  }
  if (projection.type !== "Note") {
    throw new Error(`${label}.type was not Note`);
  }
  if (projection.content !== expectedContent) {
    throw new Error(`${label}.content did not match`);
  }
  const author = parseRecord(projection.author, `${label}.author`);
  assertClosedKeys(
    author,
    ["ap_id", "icon_url", "name", "preferred_username", "username"],
    [],
    `${label}.author`,
  );
  if (
    typeof author.ap_id !== "string" ||
    !author.ap_id.trim() ||
    typeof author.username !== "string" ||
    !author.username.trim() ||
    typeof author.preferred_username !== "string" ||
    !author.preferred_username.trim() ||
    (author.name !== null && typeof author.name !== "string") ||
    (author.icon_url !== null && typeof author.icon_url !== "string")
  ) {
    throw new Error(`${label}.author was invalid`);
  }
  if (!Array.isArray(projection.attachments)) {
    throw new Error(`${label}.attachments was invalid`);
  }
  if (projection.summary !== null && typeof projection.summary !== "string") {
    throw new Error(`${label}.summary was invalid`);
  }
  if (typeof projection.visibility !== "string") {
    throw new Error(`${label}.visibility was invalid`);
  }
  if (
    typeof projection.published !== "string" ||
    !projection.published.trim()
  ) {
    throw new Error(`${label}.published was invalid`);
  }
  for (const key of ["like_count", "reply_count", "announce_count"]) {
    if (!Number.isSafeInteger(projection[key]) || Number(projection[key]) < 0) {
      throw new Error(`${label}.${key} was invalid`);
    }
  }
  if (typeof projection.liked !== "boolean") {
    throw new Error(`${label}.liked was invalid`);
  }
  if (typeof projection.bookmarked !== "boolean") {
    throw new Error(`${label}.bookmarked was invalid`);
  }
  if (projection.mention_processing !== undefined) {
    const processing = parseRecord(
      projection.mention_processing,
      `${label}.mention_processing`,
    );
    assertClosedKeys(
      processing,
      ["failed_count", "failures"],
      [],
      `${label}.mention_processing`,
    );
    if (
      !Number.isSafeInteger(processing.failed_count) ||
      Number(processing.failed_count) < 1 ||
      !Array.isArray(processing.failures) ||
      processing.failures.length !== processing.failed_count
    ) {
      throw new Error(`${label}.mention_processing was invalid`);
    }
    processing.failures.forEach((failure, index) => {
      const detail = parseRecord(
        failure,
        `${label}.mention_processing.failures[${index}]`,
      );
      assertClosedKeys(
        detail,
        ["mention", "reason", "stage"],
        [],
        `${label}.mention_processing.failures[${index}]`,
      );
      if (
        typeof detail.mention !== "string" ||
        typeof detail.reason !== "string" ||
        !["resolve", "persist_activity", "persist_inbox"].includes(
          String(detail.stage),
        )
      ) {
        throw new Error(
          `${label}.mention_processing.failures[${index}] was invalid`,
        );
      }
    });
  }
  return projection;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      JSON.stringify(leftKeys) === JSON.stringify(rightKeys) &&
      leftKeys.every((key) => jsonValuesEqual(left[key], right[key]))
    );
  }
  return false;
}

/** All unsafe cleanup operations must prove the closed success envelope. */
export function parseMutationSuccessResponse(
  value: JsonRecord,
  label: string,
): JsonRecord {
  assertClosedKeys(value, ["success"], `${label} response`);
  if (value.success !== true) {
    throw new Error(`${label} response.success was not true`);
  }
  return value;
}

/** The direct-install login mutation also owns a closed success envelope. */
export function parseLoginResponse(value: JsonRecord): JsonRecord {
  assertClosedKeys(value, ["success"], "POST /api/auth/login response");
  if (value.success !== true) {
    throw new Error("POST /api/auth/login response.success was not true");
  }
  return value;
}

function assertClosedKeys(
  value: JsonRecord,
  required: readonly string[],
  optionalOrLabel: readonly string[] | string,
  maybeLabel?: string,
): void {
  const optional = typeof optionalOrLabel === "string" ? [] : optionalOrLabel;
  const label =
    typeof optionalOrLabel === "string" ? optionalOrLabel : maybeLabel;
  if (label === undefined) {
    throw new Error("closed response schema label was missing");
  }
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  const missing = required.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  const unexpected = actual.filter((key) => !allowed.has(key));
  if (missing.length !== 0 || unexpected.length !== 0) {
    const detail = [
      ...(missing.length !== 0 ? [`missing ${missing.join(",")}`] : []),
      ...(unexpected.length !== 0
        ? [`unexpected ${unexpected.join(",")}`]
        : []),
    ].join("; ");
    throw new Error(
      `${label} did not match its closed response schema (${detail})`,
    );
  }
}

async function performPasswordLogin(
  context: ProbeContext,
  password: string,
): Promise<string> {
  let response: Response;
  try {
    response = await context.transport.request(
      new URL("/api/auth/login", context.origin),
      {
        method: "POST",
        headers: jsonHeaders(context),
        body: JSON.stringify({ password }),
      },
    );
  } catch {
    throw new FunctionalProbeMutationUncertainError(
      "POST /api/auth/login acknowledgement is indeterminate after dispatch",
    );
  }
  let text: string;
  try {
    text = await readBoundedResponseText(response, "/api/auth/login");
  } catch {
    throw new FunctionalProbeMutationUncertainError(
      "POST /api/auth/login response body was not safely consumed after dispatch",
    );
  }
  if (response.status !== 200) {
    throw new FunctionalProbeMutationUncertainError(
      `POST /api/auth/login returned ${response.status}, expected 200`,
    );
  }
  let body: JsonRecord;
  try {
    body = parseRecord(JSON.parse(text), "POST /api/auth/login response");
    parseLoginResponse(body);
  } catch {
    throw new FunctionalProbeMutationUncertainError(
      "POST /api/auth/login response was semantically invalid after dispatch",
    );
  }
  let cookie: string;
  try {
    cookie = validateSessionCookie(
      response.headers.get("set-cookie")?.split(";", 1)[0]?.trim() ?? "",
    );
  } catch {
    throw new FunctionalProbeMutationUncertainError(
      "POST /api/auth/login returned an invalid session cookie after dispatch",
    );
  }
  if (!cookie) {
    throw new FunctionalProbeMutationUncertainError(
      "POST /api/auth/login did not return a session cookie after dispatch",
    );
  }
  return cookie;
}

const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Resolve an app origin once and use the pinned address for every request.
 * Before each request, the DNS answer set is revalidated; a rebinding or
 * mixed private/public answer fails closed. TLS SNI and HTTP Host still carry
 * the original hostname while the socket connects to the pinned address.
 */
export async function createPinnedHttpTransport(
  originValue: string | URL,
  options: PinnedHttpTransportOptions = {},
): Promise<PinnedHttpTransport> {
  const parsed =
    originValue instanceof URL
      ? requireHttpUrl(originValue.origin, "transport origin")
      : requireHttpUrl(originValue, "transport origin");
  const origin = parsed.origin;
  const timeoutMs = options.timeoutMs ?? HTTP_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > HTTP_REQUEST_TIMEOUT_MS
  ) {
    throw new Error("pinned transport timeout must be between 1 and 30000 ms");
  }
  const allowLoopback = isLoopbackHost(parsed.hostname);
  const resolveAddresses =
    options.resolveAddresses ?? options.resolver ?? defaultResolveAddresses;
  const creationDeadline = Date.now() + timeoutMs;
  const pinnedAddresses = await resolveHostAddresses(
    parsed.hostname,
    allowLoopback,
    resolveAddresses,
    creationDeadline,
  );
  return {
    origin,
    async request(url, init = {}) {
      if (url.origin !== origin) {
        throw new Error("pinned transport request escaped its origin");
      }
      const deadline = Date.now() + timeoutMs;
      const currentAddresses = await resolveHostAddresses(
        parsed.hostname,
        allowLoopback,
        resolveAddresses,
        deadline,
      );
      if (!sameAddressSet(pinnedAddresses, currentAddresses)) {
        throw new Error("pinned transport DNS answer changed");
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("pinned transport request timed out");
      }
      return requestPinnedAddress(url, init, currentAddresses[0]!, remainingMs);
    },
  };
}

async function resolveHostAddresses(
  hostname: string,
  allowLoopback: boolean,
  resolveAddresses: HostAddressResolver,
  deadline: number,
): Promise<readonly string[]> {
  const normalizedHostname = hostname.replace(/^\[|\]$/gu, "");
  const addresses = isIP(normalizedHostname)
    ? [normalizedHostname]
    : await resolveAddressesByDeadline(
        normalizedHostname,
        resolveAddresses,
        deadline,
      );
  const unique = [...new Set(addresses)].sort();
  if (unique.length === 0)
    throw new Error("origin hostname had no DNS answers");
  if (allowLoopback && unique.some((address) => !isLoopbackAddress(address))) {
    throw new Error("loopback origin resolved to a non-loopback address");
  }
  if (unique.some((address) => isUnsafeAddress(address, allowLoopback))) {
    throw new Error(
      "origin hostname resolved to a private or link-local address",
    );
  }
  return unique;
}

const defaultResolveAddresses: HostAddressResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
};

async function resolveAddressesByDeadline(
  hostname: string,
  resolveAddresses: HostAddressResolver,
  deadline: number,
): Promise<readonly string[]> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("pinned transport DNS resolution timed out");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<readonly string[]>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("pinned transport DNS resolution timed out"));
    }, remainingMs);
  });
  const resolution = Promise.resolve().then(() =>
    resolveAddresses(hostname, controller.signal),
  );
  try {
    return await Promise.race([resolution, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function sameAddressSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

/**
 * Classify a resolved address from canonical bytes, never from textual
 * prefixes. This catches compressed, expanded, uppercase, and hexadecimal
 * IPv4-mapped IPv6 spellings consistently.
 */
export function isUnsafeAddress(
  address: string,
  allowLoopback: boolean,
): boolean {
  const bytes = parseAddressBytes(address);
  if (!bytes) return true;
  if (bytes.length === 4) return isUnsafeIpv4(bytes, allowLoopback);

  if (matchesPrefix(bytes, "::", 128)) return true;
  if (matchesPrefix(bytes, "::1", 128)) return !allowLoopback;

  // IPv4-mapped and deprecated IPv4-compatible IPv6 addresses inherit the
  // special-use classification of their embedded IPv4 bytes. Mapped public
  // addresses remain valid; mapped private/link-local/loopback do not.
  if (isIpv4Mapped(bytes)) {
    return isUnsafeIpv4(bytes.slice(12), allowLoopback);
  }
  if (isIpv4Compatible(bytes)) {
    return isUnsafeIpv4(bytes.slice(12), allowLoopback);
  }
  // 6to4 embeds its IPv4 endpoint in bytes 2..5.  Apply the same
  // special-use/loopback policy to that endpoint instead of treating a
  // private 6to4 address as an ordinary public IPv6 host.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isUnsafeIpv4(bytes.slice(2, 6), allowLoopback);
  }

  return SPECIAL_IPV6_PREFIXES.some(([prefix, bits]) =>
    matchesPrefix(bytes, prefix, bits),
  );
}

const SPECIAL_IPV6_PREFIXES: readonly [string, number][] = [
  ["100::", 64], // discard-only (RFC 6666)
  ["64:ff9b::", 96], // well-known NAT64 prefix
  ["64:ff9b:1::", 48], // local-use NAT64 prefix
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // benchmarking
  ["2001:3::", 32], // AMT anycast
  ["2001:4:112::", 48], // AS112 anycast
  ["2001:10::", 28], // ORCHID (deprecated)
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation (RFC 9637)
  ["fc00::", 7], // unique local
  ["fec0::", 10], // deprecated site-local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];

function parseAddressBytes(address: string): Uint8Array | undefined {
  const normalized = address.replace(/^\[|\]$/gu, "").toLowerCase();
  const kind = isIP(normalized);
  if (kind === 4) return parseIpv4Bytes(normalized);
  if (kind !== 6) return undefined;
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const head = parseIpv6Groups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseIpv6Groups(halves[1] ?? "") : [];
  if (!head || !tail) return undefined;
  const groups =
    halves.length === 2
      ? (() => {
          const compressed = 8 - head.length - tail.length;
          if (compressed <= 0) return undefined;
          return [...head, ...new Array(compressed).fill(0), ...tail];
        })()
      : [...head];
  if (!groups) return undefined;
  if (
    groups.length !== 8 ||
    (halves.length === 2 && head.length + tail.length >= 8)
  ) {
    return undefined;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function parseIpv4Bytes(value: string): Uint8Array | undefined {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return undefined;
  }
  const numbers = parts.map(Number);
  if (numbers.some((part) => part < 0 || part > 255)) return undefined;
  return Uint8Array.from(numbers);
}

function parseIpv6Groups(value: string): number[] | undefined {
  if (!value) return [];
  const segments = value.split(":");
  const groups: number[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment.includes(".")) {
      if (index !== segments.length - 1) return undefined;
      const bytes = parseIpv4Bytes(segment);
      if (!bytes) return undefined;
      groups.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/u.test(segment)) return undefined;
    groups.push(Number.parseInt(segment, 16));
  }
  return groups;
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  return (
    bytes.length === 16 &&
    bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  );
}

function isIpv4Compatible(bytes: Uint8Array): boolean {
  return (
    bytes.length === 16 && bytes.slice(0, 12).every((value) => value === 0)
  );
}

function isUnsafeIpv4(bytes: Uint8Array, allowLoopback: boolean): boolean {
  if (bytes.length !== 4) return true;
  const [a, b, c] = bytes;
  if (a === 127) return !allowLoopback;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 233 && b === 252) ||
    a! >= 224
  );
}

function matchesPrefix(
  bytes: Uint8Array,
  prefix: string,
  bits: number,
): boolean {
  const prefixBytes = parseAddressBytes(prefix);
  if (!prefixBytes || prefixBytes.length !== 16 || bits < 0 || bits > 128) {
    return false;
  }
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefixBytes[index]) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = 0xff << (8 - remaining);
  return (bytes[fullBytes]! & mask) === (prefixBytes[fullBytes]! & mask);
}

function isLoopbackAddress(address: string): boolean {
  const bytes = parseAddressBytes(address);
  if (!bytes) return false;
  if (bytes.length === 4) return bytes[0] === 127;
  if (matchesPrefix(bytes, "::1", 128)) return true;
  if (isIpv4Mapped(bytes) || isIpv4Compatible(bytes)) {
    return bytes[12] === 127;
  }
  return false;
}

function requestPinnedAddress(
  url: URL,
  init: RequestInit,
  address: string,
  timeoutMs: number,
): Promise<Response> {
  const requestHeaders = new Headers(init.headers);
  requestHeaders.set("host", hostHeader(url));
  requestHeaders.delete("connection");
  const headers = Object.fromEntries(requestHeaders.entries());
  const requestBody = requestBodyBytes(init.body);
  const requestOptions = {
    hostname: address,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers,
    ...(url.protocol === "https:"
      ? { servername: url.hostname.replace(/^\[|\]$/gu, "") }
      : {}),
  };
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseReceived = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyEnded = false;
    const request = requestFn(requestOptions, (incoming) => {
      responseReceived = true;
      if (
        (incoming.statusCode ?? 0) >= 300 &&
        (incoming.statusCode ?? 0) < 400
      ) {
        incoming.destroy();
        finishError(new Error("pinned transport rejects redirects"));
        return;
      }
      const responseHeaders = new Headers();
      let headerBytes = 0;
      for (const [name, raw] of Object.entries(incoming.headers)) {
        const value = Array.isArray(raw) ? raw.join(",") : raw;
        if (value === undefined) continue;
        headerBytes += new TextEncoder().encode(
          `${name}: ${value}\r\n`,
        ).byteLength;
        if (headerBytes > MAX_HEADER_BYTES) {
          incoming.destroy();
          finishError(
            new Error(`response headers exceeded ${MAX_HEADER_BYTES} bytes`),
          );
          return;
        }
        responseHeaders.set(name, value);
      }
      let bodyBytes = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          incoming.on("data", (chunk: Buffer | Uint8Array) => {
            if (bodyEnded) return;
            const bytes =
              chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            bodyBytes += bytes.byteLength;
            if (bodyBytes > MAX_RESPONSE_BYTES) {
              bodyEnded = true;
              incoming.destroy();
              controller.error(
                new Error(`response body exceeded ${MAX_RESPONSE_BYTES} bytes`),
              );
              clearTimeout(timeout);
              return;
            }
            controller.enqueue(bytes);
          });
          incoming.on("end", () => {
            if (bodyEnded) return;
            bodyEnded = true;
            clearTimeout(timeout);
            controller.close();
          });
          incoming.on("error", (error) => {
            if (bodyEnded) return;
            bodyEnded = true;
            clearTimeout(timeout);
            controller.error(error);
          });
          incoming.on("aborted", () => {
            if (bodyEnded) return;
            bodyEnded = true;
            clearTimeout(timeout);
            controller.error(
              new Error("pinned transport response was aborted"),
            );
          });
          incoming.on("close", () => {
            if (bodyEnded || incoming.complete) return;
            bodyEnded = true;
            clearTimeout(timeout);
            controller.error(
              new Error("pinned transport response closed early"),
            );
          });
        },
        cancel() {
          bodyEnded = true;
          clearTimeout(timeout);
          incoming.destroy();
        },
      });
      settled = true;
      resolve(
        new Response(body, {
          status: incoming.statusCode ?? 0,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }),
      );
    });
    const timeout = setTimeout(() => {
      const error = new Error("bounded HTTP request timed out");
      if (bodyController && !bodyEnded) {
        bodyEnded = true;
        bodyController.error(error);
      }
      request.destroy(error);
      if (!responseReceived) finishError(error);
    }, timeoutMs);
    const finishError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error("HTTP request failed"));
    };
    request.once("error", (error) => {
      // An error after headers is surfaced through the bounded Response body;
      // before headers it rejects the request and no acknowledgement exists.
      if (!responseReceived) finishError(error);
    });
    if (init.signal) {
      if (init.signal.aborted) {
        request.destroy(new Error("HTTP request aborted"));
        finishError(new Error("HTTP request aborted"));
      } else {
        init.signal.addEventListener(
          "abort",
          () => {
            request.destroy(new Error("HTTP request aborted"));
            finishError(new Error("HTTP request aborted"));
          },
          { once: true },
        );
      }
    }
    if (requestBody) request.write(requestBody);
    request.end();
  });
}

function hostHeader(url: URL): string {
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  return url.port && url.port !== defaultPort
    ? `${url.hostname}:${url.port}`
    : url.hostname;
}

function requestBodyBytes(
  body: BodyInit | null | undefined,
): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  const bytes =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : undefined;
  if (bytes && bytes.byteLength <= MAX_REQUEST_BYTES) return bytes;
  if (bytes) {
    throw new Error(`request body exceeded ${MAX_REQUEST_BYTES} bytes`);
  }
  throw new Error(
    "pinned transport only accepts bounded string/byte request bodies",
  );
}

async function readBoundedResponseText(
  response: Response,
  path: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(
          `${path} response exceeded ${MAX_RESPONSE_BYTES} bytes`,
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeded"))
      throw error;
    throw new Error(`${path} response body read failed`);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function requestHeaders(context: ProbeContext): Record<string, string> {
  return {
    accept: "application/json",
    origin: context.origin,
    ...(context.sessionCookie ? { cookie: context.sessionCookie } : {}),
  };
}

function jsonHeaders(context: ProbeContext): Record<string, string> {
  return {
    ...requestHeaders(context),
    "content-type": "application/json",
  };
}

function assertManagedOidcProviders(value: JsonRecord): void {
  if (value.password_enabled === true) {
    throw new Error(
      "managed OIDC probe requires password authentication to be disabled",
    );
  }
  if (
    !Array.isArray(value.providers) ||
    value.providers.length !== 1 ||
    !isRecord(value.providers[0]) ||
    value.providers[0].id !== "takos"
  ) {
    throw new Error(
      "managed OIDC probe did not expose only the Takosumi Accounts provider",
    );
  }
}

function requireHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS unless it is loopback`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${label} must not contain credentials, query, or fragment`,
    );
  }
  return url;
}

function validateSessionCookie(value: string): string {
  const cookie = value.trim();
  if (!cookie) return "";
  if (!cookie.startsWith("session=") || /[\r\n]/u.test(cookie)) {
    throw new Error(
      "session cookie must be a session cookie from the real OIDC callback",
    );
  }
  return cookie;
}

function firstString(
  value: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function parseRecord(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${name} is not a JSON object`);
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  await main();
}
