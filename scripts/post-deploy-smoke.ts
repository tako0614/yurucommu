import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

const outputsPath = requiredEnv("TAKOSUMI_CAPSULE_OUTPUTS_FILE");
const password = requiredEnv("YURUCOMMU_E2E_PASSWORD");
const outputs = parseRecord(
  JSON.parse(await readFile(outputsPath, "utf8")),
  "Capsule outputs",
);
const baseUrl = firstString(outputs, ["launch_url"]);
if (!baseUrl) throw new Error("Capsule outputs do not contain a public URL");

const origin = new URL(baseUrl).origin;
const checks: string[] = [];
let sessionCookie = "";
let noteCreated = false;
let postId: string | undefined;
let primaryError: unknown;

try {
  await expectStatus("/", 200);
  checks.push("shell");

  const health = await requestJson("/healthz", { expectedStatus: 200 });
  if (
    health.status !== "ok" ||
    !Array.isArray(health.missingBindings) ||
    health.missingBindings.length > 0
  ) {
    throw new Error("healthz did not report a fully configured runtime");
  }
  checks.push("health");

  const capabilities = await requestJson("/.well-known/social-server", {
    expectedStatus: 200,
  });
  if (!isRecord(capabilities)) {
    throw new Error("social-server discovery response is invalid");
  }
  checks.push("social-server.discovery");

  const providers = await requestJson("/api/auth/providers", {
    expectedStatus: 200,
  });
  if (providers.password_enabled !== true) {
    throw new Error("password authentication is not enabled for the probe");
  }
  checks.push("auth.providers");

  const loginResponse = await fetch(new URL("/api/auth/login", origin), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ password }),
  });
  const loginBody = await loginResponse.text();
  if (loginResponse.status !== 200) {
    throw new Error(
      `POST /api/auth/login returned ${loginResponse.status}: ${loginBody.slice(0, 1000)}`,
    );
  }
  const setCookie = loginResponse.headers.get("set-cookie");
  sessionCookie = setCookie?.split(";", 1)[0]?.trim() ?? "";
  if (!sessionCookie.startsWith("session=")) {
    throw new Error("login did not return a session cookie");
  }
  checks.push("auth.login");

  const me = await requestJson("/api/auth/me", { expectedStatus: 200 });
  if (!isRecord(me.actor) || typeof me.actor.ap_id !== "string") {
    throw new Error("authenticated actor response is invalid");
  }
  checks.push("auth.me");

  const recommendations = await requestJson("/api/recommendations/users", {
    expectedStatus: 200,
  });
  if (!Array.isArray(recommendations.users)) {
    throw new Error("recommendations response does not contain users[]");
  }
  checks.push("recommendations.users");

  const noteContent = `e2e-note-${crypto.randomUUID()}`;
  const createdNote = await requestJson("/api/notes", {
    method: "POST",
    body: { content: noteContent, expires_in_hours: 1 },
    expectedStatus: 201,
  });
  if (!isRecord(createdNote.note) || createdNote.note.content !== noteContent) {
    throw new Error("created note response is invalid");
  }
  noteCreated = true;
  const notes = await requestJson("/api/notes", { expectedStatus: 200 });
  if (
    !Array.isArray(notes.notes) ||
    !notes.notes.some(
      (value) => isRecord(value) && value.content === noteContent,
    )
  ) {
    throw new Error("created note was not returned by the notes feed");
  }
  checks.push("notes.crud");

  const postContent = `e2e-post-${crypto.randomUUID()}`;
  const createdPost = await requestJson("/api/posts", {
    method: "POST",
    body: { content: postContent, visibility: "public" },
    expectedStatus: 200,
  });
  const post = isRecord(createdPost.post) ? createdPost.post : createdPost;
  if (typeof post.ap_id !== "string" || post.content !== postContent) {
    throw new Error("created post response is invalid");
  }
  postId = post.ap_id.split("/").filter(Boolean).at(-1);
  if (!postId) throw new Error("created post id is invalid");
  const loadedPost = await requestJson(
    `/api/posts/${encodeURIComponent(postId)}`,
    {
      expectedStatus: 200,
    },
  );
  const loaded = isRecord(loadedPost.post) ? loadedPost.post : loadedPost;
  if (loaded.content !== postContent) {
    throw new Error("created post was not returned by the post API");
  }
  checks.push("posts.crud");
} catch (error) {
  primaryError = error;
}

const cleanupErrors: unknown[] = [];
if (postId) {
  try {
    await requestJson(`/api/posts/${encodeURIComponent(postId)}`, {
      method: "DELETE",
      expectedStatus: 200,
    });
    checks.push("posts.cleanup");
  } catch (error) {
    cleanupErrors.push(error);
  }
}
if (noteCreated) {
  try {
    await requestJson("/api/notes/me", {
      method: "DELETE",
      expectedStatus: 200,
    });
    checks.push("notes.cleanup");
  } catch (error) {
    cleanupErrors.push(error);
  }
}

if (primaryError) throw primaryError;
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "Yurucommu probe cleanup failed");
}

console.log(
  JSON.stringify({
    kind: "takosumi.capsule-functional-probe@v1",
    status: "passed",
    product: "yurucommu",
    checks: checks.map((name) => ({ name, status: "passed" })),
    cleanupVerified: true,
  }),
);

async function expectStatus(
  path: string,
  expectedStatus: number,
): Promise<void> {
  const response = await fetch(new URL(path, origin), {
    headers: { origin },
  });
  if (response.status !== expectedStatus) {
    const body = await response.text();
    throw new Error(
      `GET ${path} returned ${response.status}, expected ${expectedStatus}: ${body.slice(0, 1000)}`,
    );
  }
}

async function requestJson(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly expectedStatus: number;
  },
): Promise<JsonRecord> {
  const method = options.method ?? "GET";
  const response = await fetch(new URL(path, origin), {
    method,
    headers: options.body === undefined ? requestHeaders() : jsonHeaders(),
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (response.status !== options.expectedStatus) {
    throw new Error(
      `${method} ${path} returned ${response.status}, expected ${options.expectedStatus}: ${text.slice(0, 1000)}`,
    );
  }
  return parseRecord(JSON.parse(text), `${method} ${path}`);
}

function requestHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    origin,
    ...(sessionCookie ? { cookie: sessionCookie } : {}),
  };
}

function jsonHeaders(): Record<string, string> {
  return {
    ...requestHeaders(),
    "content-type": "application/json",
  };
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
