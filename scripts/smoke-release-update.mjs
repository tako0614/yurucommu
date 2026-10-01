#!/usr/bin/env bun
import { createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { unstable_readConfig, unstable_splitSqlQuery } from "wrangler";
import { createSyntheticUpdateIssuer } from "./release-update-oidc.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OLD_VERSION = "2.2.0";
const OLD_COMMIT = "3eb2c47552a4cc5fe9a49b4c2b215b0ee9fbb06e";
const OLD_SHA =
  "b0d1d40893a664b8030ddd9a2a003beb350f0394d1d705814b1ada88c2a391dc";
const SCHEMA_SHA =
  "b8b0f105e307cbaebace94cab8920e8c62f8f02f178e02ead55bfa3de3e705ab";
const CORE_VERSION = "4.1.11";
const SCHEMA_COUNT = 29;
const ORIGIN = "https://session-update.yurucommu.invalid";
const WORKER_NAME = "yurucommu-update-continuity";
const PASSWORD = "native-update-owner-password-fixture";
const PASSWORD_SALT = Buffer.alloc(32, 0x6c);
const PASSWORD_HASH =
  PASSWORD_SALT.toString("hex") +
  ":" +
  pbkdf2Sync(PASSWORD, PASSWORD_SALT, 100000, 32, "sha256").toString("hex");
const ENCRYPTION_KEY = "00".repeat(32);
const SALT_A = "  native-update-dedicated-session-salt \t";
const SALT_B = "\tnative-update-new-session-salt  ";
const FALLBACK_SALT = "yurucommu:dev-only-session-hash-salt";
const ROOT = ORIGIN + "/ap/users/tako";
const PERSONA = ORIGIN + "/ap/users/update_persona";
const CONTENT = "Yurucommu release update continuity fixture note";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==",
  "base64",
);
const OMIT = Symbol("omit session salt binding");
const activeWorkers = new Set();
const runtimeEvidence = new WeakMap();
const outboundEvidence = { blockedFetches: 0 };
let currentCheck = "cli-preflight";
let lastSafeEvidence;

class Failure extends Error {
  constructor(check) {
    super(check);
    this.check = check;
  }
}
function fail(check) {
  throw new Failure(check);
}
function need(ok, check) {
  if (!ok) fail(check);
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function sessionId(salt, raw) {
  return "sha256:" + hash(Buffer.from(salt + ":" + raw, "utf8"));
}
function parseCli(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  need(args.length === 2, "usage-old-worker-and-candidate-worker-required");
  return {
    oldPath: resolve(process.cwd(), args[0]),
    newPath: resolve(process.cwd(), args[1]),
  };
}
function artifact(path, label) {
  need(existsSync(path) && statSync(path).isFile(), label + "-file-exists");
  const bytes = readFileSync(path);
  need(bytes.length > 0, label + "-file-not-empty");
  return { bytes, sha: hash(bytes) };
}
function schemaBundle() {
  const bytes = readFileSync(
    resolve(REPO, "deploy/takoform/migrations/schema-bundle.json"),
  );
  need(hash(bytes) === SCHEMA_SHA, "schema-bundle-v2-2-0-sha256-pin");
  const bundle = JSON.parse(bytes.toString("utf8"));
  need(
    bundle.apiVersion === "takosumi.resource-migrations/v1" &&
      bundle.engine === "sqlite" &&
      Array.isArray(bundle.entries) &&
      bundle.entries.length === SCHEMA_COUNT,
    "schema-bundle-v1-sqlite-29-entries",
  );
  bundle.entries.forEach((entry, i) => {
    need(
      typeof entry.sql === "string" &&
        entry.sha256 === "sha256:" + hash(Buffer.from(entry.sql, "utf8")),
      "schema-entry-" + String(i + 1).padStart(2, "0") + "-sha256",
    );
  });
  const core = JSON.parse(
    readFileSync(
      resolve(REPO, "node_modules/@takosjp/yurucommu-core/package.json"),
      "utf8",
    ),
  );
  need(core.version === CORE_VERSION, "installed-core-4-1-11-pin");
  const lock = JSON.parse(
    readFileSync(resolve(REPO, "release.lock.json"), "utf8"),
  );
  const pinned = lock.releases?.["v" + OLD_VERSION];
  need(
    lock.kind === "takos.release-artifact-lock@v1" &&
      lock.app === "yurucommu" &&
      pinned?.commit === OLD_COMMIT &&
      pinned.artifact?.filename === "yurucommu-worker.js" &&
      pinned.artifact?.sha256 === "sha256:" + OLD_SHA,
    "release-lock-v2-2-0-commit-and-worker-pin",
  );
  return { bytes, bundle };
}
function compatibilityConfig() {
  const config = unstable_readConfig(
    { config: resolve(REPO, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  need(
    typeof config.compatibility_date === "string" &&
      Array.isArray(config.compatibility_flags),
    "wrangler-compatibility-config",
  );
  return config;
}
function storesAt(root, name) {
  const base = join(root, name);
  const paths = {
    d1: join(base, "d1"),
    kv: join(base, "kv"),
    r2: join(base, "r2"),
  };
  Object.values(paths).forEach((p) => mkdirSync(p, { recursive: true }));
  return paths;
}
function idsFor(lane) {
  const id = randomUUID();
  return {
    d1: "update-" + lane + "-" + id + "-d1",
    kv: "update-" + lane + "-" + id + "-kv",
    r2: "update-" + lane + "-" + id + "-r2",
  };
}
const SESSION_SALT_GUARD =
  "YURUCOMMU_SESSION_HASH_SALT must be configured with a non-development value";
function observeGuard(evidence, text, channel) {
  if (!evidence.guardObserved && text.includes(SESSION_SALT_GUARD)) {
    evidence.guardObserved = true;
    evidence.guardChannel = channel;
    evidence.sessionSaltGuardRefusals++;
    for (const resolve of evidence.guardWaiters) resolve(true);
    evidence.guardWaiters.clear();
  }
}
function waitForGuard(evidence, timeoutMs = 3000) {
  if (evidence.guardObserved) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (observed) => {
      clearTimeout(timer);
      evidence.guardWaiters.delete(onGuard);
      resolve(observed);
    };
    const onGuard = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    evidence.guardWaiters.add(onGuard);
    if (evidence.guardObserved) onGuard();
  });
}
function captureDiagnostic(stream, evidence, channel) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += Buffer.from(chunk).toString("utf8");
    observeGuard(evidence, pending, channel);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      evidence.lines++;
    }
    if (Buffer.byteLength(pending, "utf8") > 4096) {
      pending = "";
    }
  });
  stream.resume();
}
function nativeWorker(path, paths, ids, config, salt, oidc) {
  const bindings = {
    APP_URL: ORIGIN,
    AUTH_PASSWORD_HASH: PASSWORD_HASH,
    ENCRYPTION_KEY,
    DELIVERY_QUEUE_NAME: "yurucommu-update-smoke-delivery",
    DELIVERY_DLQ_NAME: "yurucommu-update-smoke-dlq",
  };
  if (oidc) {
    delete bindings.AUTH_PASSWORD_HASH;
    Object.assign(bindings, oidc.bindings);
  }
  if (salt !== OMIT) bindings.YURUCOMMU_SESSION_HASH_SALT = salt;
  const root = dirname(path);
  const evidence = {
    lines: 0,
    sessionSaltGuardRefusals: 0,
    guardObserved: false,
    guardWaiters: new Set(),
  };
  const mf = new Miniflare({
    workers: [
      {
        name: WORKER_NAME,
        routes: [ORIGIN + "/*"],
        rootPath: root,
        modules: [{ type: "ESModule", path }],
        modulesRoot: root,
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        bindings,
        d1Databases: { DB: { id: ids.d1 } },
        kvNamespaces: { KV: { id: ids.kv } },
        r2Buckets: { MEDIA: { id: ids.r2 } },
        queueProducers: {
          DELIVERY_QUEUE: { queueName: bindings.DELIVERY_QUEUE_NAME },
          DELIVERY_DLQ: { queueName: bindings.DELIVERY_DLQ_NAME },
        },
        outboundService: oidc
          ? (request) => oidc.fetch(request)
          : async () => {
              outboundEvidence.blockedFetches++;
              return new Response(null, { status: 502 });
            },
      },
    ],
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    cf: false,
    d1Persist: paths.d1,
    kvPersist: paths.kv,
    r2Persist: paths.r2,
    // Retain only a fixed, allow-listed guard classification. Raw diagnostics
    // never leave these streams, so cookies, keys, and response bodies cannot
    // enter stdout or operator logs.
    handleRuntimeStdio(stdout, stderr) {
      captureDiagnostic(stdout, evidence, "runtime-stdout");
      captureDiagnostic(stderr, evidence, "runtime-stderr");
    },
  });
  activeWorkers.add(mf);
  runtimeEvidence.set(mf, evidence);
  return mf;
}
async function dispose(mf) {
  if (!mf) return;
  await mf.dispose();
  activeWorkers.delete(mf);
}
async function disposeBestEffort(...workers) {
  for (const worker of workers) {
    try {
      await dispose(worker);
    } catch {
      /* outer cleanup retries tracked handles */
    }
  }
}
async function handles(mf) {
  return {
    worker: await mf.getWorker(WORKER_NAME),
    db: await mf.getD1Database("DB", WORKER_NAME),
    kv: await mf.getKVNamespace("KV", WORKER_NAME),
    r2: await mf.getR2Bucket("MEDIA", WORKER_NAME),
  };
}
function headers(cookie, json) {
  return {
    origin: ORIGIN,
    ...(cookie ? { cookie: "session=" + cookie } : {}),
    ...(json ? { "content-type": "application/json" } : {}),
  };
}
async function fetchPath(mf, path, init) {
  const worker = await mf.getWorker(WORKER_NAME);
  return worker.fetch(new URL(path, ORIGIN).href, {
    ...init,
    headers: new Headers(init && init.headers),
  });
}
async function responseHasGuardMarker(response, evidence) {
  if (!response.body) return false;
  const reader = response.body.getReader();
  let observed = false;
  let bytes = 0;
  let tail = "";
  try {
    while (bytes < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const text = tail + Buffer.from(value).toString("utf8");
      observed ||= text.includes(SESSION_SALT_GUARD);
      if (observed) break;
      tail = text.slice(-SESSION_SALT_GUARD.length + 1);
    }
  } finally {
    if (!observed) await reader.cancel();
    reader.releaseLock();
  }
  if (observed) observeGuard(evidence, SESSION_SALT_GUARD, "response-body");
  return observed;
}
async function jsonResponse(response, status, check) {
  if (response.status !== status) {
    await response.body?.cancel();
    fail(check + "-http-" + response.status);
  }
  try {
    return await response.json();
  } catch {
    fail(check + "-invalid-json");
  }
}
function activeCookie(response, check) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  const pairs = values
    .flatMap((value) => value.split(/, (?=[^;,=\s]+=[^;,]*)/))
    .map((value) => value.trim().split(";", 1)[0])
    .filter((value) => value.startsWith("session=") && value.length > 8);
  need(pairs.length === 1, check + "-one-active-cookie");
  const raw = decodeURIComponent(pairs[0].slice(8));
  need(raw.length > 0 && raw.length < 256, check + "-cookie-bound");
  return raw;
}
async function login(mf, cookie, check) {
  const response = await fetchPath(mf, "/api/auth/login", {
    method: "POST",
    headers: headers(cookie, true),
    body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await jsonResponse(response, 200, check);
  need(body.success === true, check + "-success");
  return activeCookie(response, check);
}
async function jsonRequest(mf, path, cookie, check) {
  const response = await fetchPath(mf, path, {
    headers: headers(cookie, false),
  });
  return { response, body: await jsonResponse(response, 200, check) };
}
async function applySchema(db, bundle, prefix) {
  for (let i = 0; i < bundle.entries.length; i++) {
    currentCheck = prefix + "-migration-" + String(i + 1).padStart(2, "0");
    const statements = unstable_splitSqlQuery(bundle.entries[i].sql);
    need(statements.length > 0, currentCheck + "-statements");
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
}
async function emptyOwnerSession(db, check) {
  const counts = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
  need(counts?.actors === 0 && counts?.sessions === 0, check);
}
async function actors(db) {
  return (
    await db
      .prepare(
        "SELECT ap_id, type, preferred_username, name, summary, icon_url, header_url, " +
          "inbox, outbox, followers_url, following_url, takos_user_id, follower_count, " +
          "following_count, post_count, is_private, role, created_at, deleted_at, owner_actor_ap_id " +
          "FROM actors ORDER BY ap_id",
      )
      .all()
  ).results;
}
async function sessions(db) {
  return (
    await db
      .prepare(
        "SELECT id, member_id, access_token, refresh_token, expires_at, created_at, " +
          "provider, provider_access_token, provider_refresh_token, provider_token_expires_at " +
          "FROM sessions ORDER BY id",
      )
      .all()
  ).results;
}
async function session(db, raw, salt) {
  return db
    .prepare(
      "SELECT id, member_id, access_token, refresh_token, expires_at, created_at, " +
        "provider, provider_access_token, provider_refresh_token, provider_token_expires_at " +
        "FROM sessions WHERE id = ?",
    )
    .bind(sessionId(salt, raw))
    .first();
}
function validSession(row, raw, salt, member) {
  return (
    row?.id === sessionId(salt, raw) &&
    row.access_token === row.id &&
    row.member_id === member &&
    row.provider == null &&
    row.provider_access_token == null &&
    row.provider_refresh_token == null &&
    row.provider_token_expires_at == null &&
    Date.parse(row.expires_at) > Date.now()
  );
}
async function membership(db, check) {
  const rows = await actors(db);
  const root = rows.find((r) => r.ap_id === ROOT);
  const persona = rows.find((r) => r.ap_id === PERSONA);
  need(
    rows.length === 2 &&
      rows.filter((r) => r.role === "owner" && r.deleted_at == null).length ===
        1 &&
      root?.role === "owner" &&
      root.owner_actor_ap_id == null &&
      root.takos_user_id === "password:owner" &&
      root.deleted_at == null &&
      persona?.role === "member" &&
      persona.owner_actor_ap_id === ROOT &&
      persona.takos_user_id === "local:update_persona" &&
      persona.deleted_at == null,
    check + "-one-human-owner-and-linked-persona",
  );
  return rows;
}
async function schemaRows(db) {
  return (
    await db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all()
  ).results;
}
async function snapshot(db) {
  const [
    actorRows,
    sessionRows,
    objectRows,
    activityRows,
    recipientRows,
    uploadRows,
    ddl,
  ] = await Promise.all([
    actors(db),
    sessions(db),
    db
      .prepare(
        "SELECT ap_id, type, attributed_to, content, summary, attachments_json, in_reply_to, conversation, visibility, to_json, cc_json, audience_json, community_ap_id, end_time, like_count, reply_count, announce_count, share_count, published, updated, is_local, raw_json, deleted_at, tags_json FROM objects ORDER BY ap_id",
      )
      .all()
      .then((r) => r.results),
    db
      .prepare(
        "SELECT ap_id, type, actor_ap_id, object_ap_id, direction, raw_json FROM activities ORDER BY ap_id",
      )
      .all()
      .then((r) => r.results),
    db
      .prepare(
        "SELECT object_ap_id, recipient_ap_id, type FROM object_recipients ORDER BY object_ap_id, recipient_ap_id, type",
      )
      .all()
      .then((r) => r.results),
    db
      .prepare(
        "SELECT id, r2_key, uploader_ap_id, content_type, size FROM media_uploads ORDER BY id",
      )
      .all()
      .then((r) => r.results),
    schemaRows(db),
  ]);
  const stable = {
    actors: actorRows,
    objects: objectRows,
    activities: activityRows,
    recipients: recipientRows,
    uploads: uploadRows,
  };
  return {
    dataSha: hash(Buffer.from(JSON.stringify(stable))),
    sessionsSha: hash(Buffer.from(JSON.stringify(sessionRows))),
    schemaSha: hash(Buffer.from(JSON.stringify(ddl))),
    counts: {
      actors: actorRows.length,
      sessions: sessionRows.length,
      objects: objectRows.length,
      activities: activityRows.length,
      recipients: recipientRows.length,
      mediaUploads: uploadRows.length,
    },
    schemaCount: ddl.length,
  };
}
async function assertStable(db, expected, check) {
  const got = await snapshot(db);
  need(
    got.dataSha === expected.dataSha &&
      got.schemaSha === expected.schemaSha &&
      got.counts.actors === expected.counts.actors &&
      got.counts.objects === expected.counts.objects &&
      got.counts.activities === expected.counts.activities &&
      got.counts.recipients === expected.counts.recipients &&
      got.counts.mediaUploads === expected.counts.mediaUploads,
    check + "-schema-and-product-data-stable",
  );
  return got;
}
async function accountList(mf, cookie, expectedCurrent, check) {
  const result = await jsonRequest(mf, "/api/auth/accounts", cookie, check);
  need(
    result.body.current_ap_id === expectedCurrent &&
      Array.isArray(result.body.accounts) &&
      result.body.accounts.length === 2 &&
      new Set(result.body.accounts.map((a) => a.ap_id)).size === 2 &&
      result.body.accounts.some((a) => a.ap_id === ROOT) &&
      result.body.accounts.some((a) => a.ap_id === PERSONA),
    check + "-root-persona-account-list",
  );
}
async function switchPersona(mf, ownerCookie, check) {
  const response = await fetchPath(mf, "/api/auth/switch", {
    method: "POST",
    headers: headers(ownerCookie, true),
    body: JSON.stringify({ ap_id: PERSONA }),
  });
  const body = await jsonResponse(response, 200, check);
  need(body.success === true, check + "-success");
  return activeCookie(response, check);
}
async function verifyPersona(mf, db, r2, cookie, expected, check) {
  const me = await jsonRequest(mf, "/api/auth/me", cookie, check + "-me");
  need(
    me.body.actor?.ap_id === PERSONA && me.body.actor.role === "member",
    check + "-persona-identity",
  );
  await membership(db, check);
  await accountList(mf, cookie, PERSONA, check);
  const postResponse = await fetchPath(
    mf,
    "/api/posts/" + encodeURIComponent(expected.post),
    { headers: headers(cookie, false) },
  );
  const post = await jsonResponse(postResponse, 200, check + "-post");
  need(
    post.post?.ap_id === expected.post &&
      post.post.type === "Note" &&
      post.post.author?.ap_id === PERSONA &&
      post.post.content === CONTENT &&
      post.post.attachments?.length === 1 &&
      post.post.attachments[0].url === expected.url,
    check + "-post-content-and-media-reference",
  );
  const row = await db
    .prepare(
      "SELECT id, r2_key, uploader_ap_id, content_type, size FROM media_uploads WHERE id = ?",
    )
    .bind(expected.mediaId)
    .first();
  const blob = await r2.get(expected.key);
  need(
    row?.uploader_ap_id === PERSONA &&
      row.r2_key === expected.key &&
      row.content_type === "image/png" &&
      row.size === PNG.length &&
      blob &&
      Buffer.from(await blob.arrayBuffer()).equals(PNG),
    check + "-media-sql-and-r2-exact-bytes",
  );
  const mediaResponse = await fetchPath(mf, expected.url, {
    headers: headers(cookie, false),
  });
  const bytes = Buffer.from(await mediaResponse.arrayBuffer());
  need(
    mediaResponse.status === 200 &&
      mediaResponse.headers.get("content-type") === "image/png" &&
      bytes.equals(PNG),
    check + "-http-media-exact-bytes",
  );
  return { bytes: bytes.length, sha: hash(bytes) };
}
async function kvPut(kv, lane) {
  const row = {
    key: "native-update-continuity-kv-sentinel/" + lane,
    value: "fixture-value:" + lane + ":direct-binding",
  };
  await kv.put(row.key, row.value);
  need(
    (await kv.get(row.key)) === row.value,
    lane + "-direct-kv-seed-readback",
  );
  return row;
}
async function kvAssert(kv, row, check) {
  need((await kv.get(row.key)) === row.value, check + "-direct-kv-sentinel");
}
async function r2Keys(r2) {
  const listed = await r2.list();
  return (listed.objects || []).map((o) => o.key).sort();
}
function fileDigest(path) {
  const list = [];
  function walk(rel) {
    for (const entry of readdirSync(join(path, rel), { withFileTypes: true })) {
      const child = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const bytes = readFileSync(join(path, child));
        list.push({ path: child, bytes: bytes.length, sha: hash(bytes) });
      }
    }
  }
  walk("");
  list.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: list.length,
    bytes: list.reduce((n, f) => n + f.bytes, 0),
    sha256: "sha256:" + hash(Buffer.from(JSON.stringify(list))),
  };
}
function storeDigests(paths) {
  return Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, fileDigest(path)]),
  );
}
function cloneClosedStores(source, dest) {
  need(!existsSync(dest), "closed-snapshot-clone-destination-fresh");
  mkdirSync(dest, { recursive: true });
  for (const name of ["d1", "kv", "r2"])
    cpSync(source[name], join(dest, name), { recursive: true });
  const cloned = {
    d1: join(dest, "d1"),
    kv: join(dest, "kv"),
    r2: join(dest, "r2"),
  };
  const a = storeDigests(source),
    b = storeDigests(cloned);
  need(
    JSON.stringify(a) === JSON.stringify(b),
    "closed-snapshot-clone-digests-match-before-open",
  );
  return { paths: cloned, evidence: b };
}
async function oldFixture(mf, bundle, lane, saltForHash) {
  await mf.ready;
  const h = await handles(mf);
  await applySchema(h.db, bundle, lane + "-fresh-schema");
  await emptyOwnerSession(h.db, lane + "-schema-starts-with-no-identities");
  need((await r2Keys(h.r2)).length === 0, lane + "-r2-starts-empty");
  const schema = await snapshot(h.db);
  currentCheck = lane + "-old-password-login";
  const rootResponse = await fetchPath(mf, "/api/auth/login", {
    method: "POST",
    headers: headers(undefined, true),
    body: JSON.stringify({ password: PASSWORD }),
  });
  const rootBody = await jsonResponse(
    rootResponse,
    200,
    lane + "-old-root-login",
  );
  need(rootBody.success === true, lane + "-old-root-login-body");
  const rootCookie = activeCookie(rootResponse, lane + "-old-root-login");
  const me = await jsonRequest(
    mf,
    "/api/auth/me",
    rootCookie,
    lane + "-old-root-me",
  );
  need(
    me.body.actor?.ap_id === ROOT && me.body.actor.role === "owner",
    lane + "-old-created-root-owner",
  );
  const rootRows = await actors(h.db);
  need(
    rootRows.length === 1 &&
      rootRows[0]?.ap_id === ROOT &&
      rootRows[0].role === "owner" &&
      rootRows[0].owner_actor_ap_id == null &&
      rootRows[0].takos_user_id === "password:owner" &&
      rootRows[0].deleted_at == null,
    lane + "-old-root-owner-row",
  );
  need(
    validSession(
      await session(h.db, rootCookie, saltForHash),
      rootCookie,
      saltForHash,
      ROOT,
    ),
    lane + "-old-root-session-salted-key",
  );
  const create = await fetchPath(mf, "/api/auth/accounts", {
    method: "POST",
    headers: headers(rootCookie, true),
    body: JSON.stringify({
      username: "update_persona",
      name: "Release update persona",
      role: "owner",
      owner_actor_ap_id: "https://ignored.invalid/owner",
    }),
  });
  const created = await jsonResponse(create, 200, lane + "-old-create-persona");
  need(
    created.success === true && created.account?.ap_id === PERSONA,
    lane + "-old-persona-create-response",
  );
  await membership(h.db, lane + "-old-persona");
  await accountList(mf, rootCookie, ROOT, lane + "-old-owner-account-list");
  const personaCookie = await switchPersona(
    mf,
    rootCookie,
    lane + "-old-switch-persona",
  );
  need(
    personaCookie !== rootCookie &&
      !(await session(h.db, rootCookie, saltForHash)) &&
      validSession(
        await session(h.db, personaCookie, saltForHash),
        personaCookie,
        saltForHash,
        PERSONA,
      ),
    lane + "-old-switch-rotates-cookie-and-persists-persona-session",
  );
  await membership(h.db, lane + "-old-after-switch");

  currentCheck = lane + "-old-persona-upload-note";
  const form = new FormData();
  form.set(
    "file",
    new File([PNG], "update-continuity.png", { type: "image/png" }),
  );
  const uploadResponse = await fetchPath(mf, "/api/media/upload", {
    method: "POST",
    headers: headers(personaCookie, false),
    body: form,
  });
  const upload = await jsonResponse(
    uploadResponse,
    200,
    lane + "-old-media-upload",
  );
  need(
    PNG.length === 70 &&
      typeof upload.id === "string" &&
      upload.url === "/media/" + upload.id + ".png" &&
      upload.r2_key === "uploads/" + upload.id + ".png" &&
      upload.content_type === "image/png",
    lane + "-old-70-byte-png-identity",
  );
  const uploadRow = await h.db
    .prepare(
      "SELECT id, r2_key, uploader_ap_id, content_type, size FROM media_uploads WHERE id = ?",
    )
    .bind(upload.id)
    .first();
  const blob = await h.r2.get(upload.r2_key);
  need(
    uploadRow?.uploader_ap_id === PERSONA &&
      uploadRow.content_type === "image/png" &&
      uploadRow.size === PNG.length &&
      blob &&
      Buffer.from(await blob.arrayBuffer()).equals(PNG),
    lane + "-old-media-d1-r2-owner-and-bytes",
  );

  const attachment = {
    url: upload.url,
    r2_key: upload.r2_key,
    content_type: upload.content_type,
    name: "release update continuity image",
  };
  const postResponse = await fetchPath(mf, "/api/posts", {
    method: "POST",
    headers: headers(personaCookie, true),
    body: JSON.stringify({ content: CONTENT, attachments: [attachment] }),
  });
  const createdPost = await jsonResponse(
    postResponse,
    200,
    lane + "-old-create-note",
  );
  const post = createdPost.post;
  need(
    typeof post?.ap_id === "string" &&
      post.ap_id.startsWith(ORIGIN + "/ap/objects/") &&
      post.type === "Note" &&
      post.author?.ap_id === PERSONA &&
      post.content === CONTENT &&
      post.visibility === "public" &&
      JSON.stringify(post.attachments) === JSON.stringify([attachment]),
    lane + "-old-note-http-response",
  );
  const saved = await h.db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, attachments_json, visibility FROM objects WHERE ap_id = ?",
    )
    .bind(post.ap_id)
    .first();
  need(
    saved?.type === "Note" &&
      saved.attributed_to === PERSONA &&
      saved.content === CONTENT &&
      saved.visibility === "public" &&
      JSON.stringify(JSON.parse(saved.attachments_json)) ===
        JSON.stringify([attachment]),
    lane + "-old-note-d1-persistence",
  );
  const activity = await h.db
    .prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id = ?",
    )
    .bind(PERSONA, post.ap_id)
    .first();
  need(activity?.count === 1, lane + "-old-note-activity-persisted");
  const readPostResponse = await fetchPath(
    mf,
    "/api/posts/" + encodeURIComponent(post.ap_id),
    { headers: headers(personaCookie, false) },
  );
  const readPost = await jsonResponse(
    readPostResponse,
    200,
    lane + "-old-post-readback",
  );
  need(
    readPost.post?.content === CONTENT &&
      readPost.post.author?.ap_id === PERSONA &&
      readPost.post.attachments?.length === 1 &&
      readPost.post.attachments[0].url === upload.url,
    lane + "-old-post-http-readback",
  );
  const mediaResponse = await fetchPath(mf, upload.url, {
    headers: headers(personaCookie, false),
  });
  const bytes = Buffer.from(await mediaResponse.arrayBuffer());
  need(
    mediaResponse.status === 200 &&
      mediaResponse.headers.get("content-type") === "image/png" &&
      bytes.equals(PNG),
    lane + "-old-media-http-exact-bytes",
  );
  need(
    JSON.stringify(await r2Keys(h.r2)) === JSON.stringify([upload.r2_key]),
    lane + "-old-r2-single-fixture-object",
  );

  const sentinel = await kvPut(h.kv, lane);
  const state = await snapshot(h.db);
  need(
    state.counts.actors === 2 &&
      state.counts.sessions >= 1 &&
      state.counts.objects === 1 &&
      state.counts.mediaUploads === 1,
    lane + "-old-state-scope",
  );
  need(
    state.schemaSha === schema.schemaSha &&
      state.schemaCount === schema.schemaCount,
    lane + "-old-schema-stable",
  );
  const legacy = await session(h.db, personaCookie, saltForHash);
  need(
    validSession(legacy, personaCookie, saltForHash, PERSONA),
    lane + "-old-persona-session-hash-proof",
  );
  return {
    ...h,
    rootCookie,
    personaCookie,
    post: post.ap_id,
    mediaId: upload.id,
    url: upload.url,
    key: upload.r2_key,
    sentinel,
    state,
    legacy,
  };
}
async function ready(mf, check) {
  const response = await fetchPath(mf, "/readyz", {
    headers: { accept: "application/json" },
  });
  const body = await jsonResponse(response, 200, check);
  need(body.status === "ok", check + "-body");
}
async function runDedicated(root, bundle, config, oldPath, newPath) {
  const lane = "dedicated-salt-preserved";
  const paths = storesAt(root, lane + "-primary");
  const ids = idsFor(lane);
  let oldMf, newMf, cloneMf;
  const checks = [];
  try {
    oldMf = nativeWorker(oldPath, paths, ids, config, SALT_A);
    const old = await oldFixture(oldMf, bundle, lane, SALT_A);
    checks.push(
      "old-http-owner-persona-content-d1-r2",
      "old-direct-kv-sentinel",
    );
    const closedData = await snapshot(old.db);
    need(
      closedData.dataSha === old.state.dataSha &&
        closedData.schemaSha === old.state.schemaSha,
      lane + "-preclose-logical-snapshot",
    );
    await dispose(oldMf);
    oldMf = undefined;
    const closedFiles = storeDigests(paths);
    need(
      closedFiles.d1.files > 0 &&
        closedFiles.d1.bytes > 0 &&
        closedFiles.kv.files > 0 &&
        closedFiles.r2.files > 0,
      lane + "-old-closed-native-stores-persisted",
    );
    const cloned = cloneClosedStores(
      paths,
      join(root, lane + "-restored-clone"),
    );
    checks.push(
      "old-workers-disposed-before-closed-store-snapshot",
      "closed-snapshot-cloned-and-hashes-match-before-open",
    );

    currentCheck = lane + "-candidate-reopen-same-d1-kv-r2";
    newMf = nativeWorker(newPath, paths, ids, config, SALT_A);
    await newMf.ready;
    const next = await handles(newMf);
    const before = await snapshot(next.db);
    need(
      before.dataSha === old.state.dataSha &&
        before.schemaSha === old.state.schemaSha,
      lane + "-candidate-reuses-same-d1-schema-data",
    );
    need(
      before.sessionsSha === old.state.sessionsSha,
      lane + "-candidate-reuses-all-old-session-rows",
    );
    need(
      JSON.stringify(await r2Keys(next.r2)) === JSON.stringify([old.key]),
      lane + "-candidate-reuses-same-r2-key",
    );
    await kvAssert(next.kv, old.sentinel, lane + "-candidate-reuses-same-kv");
    need(
      validSession(
        await session(next.db, old.personaCookie, SALT_A),
        old.personaCookie,
        SALT_A,
        PERSONA,
      ),
      lane + "-candidate-salted-persona-cookie-row",
    );
    await ready(newMf, lane + "-candidate-ready");
    await verifyPersona(
      newMf,
      next.db,
      next.r2,
      old.personaCookie,
      { post: old.post, mediaId: old.mediaId, url: old.url, key: old.key },
      lane + "-candidate-old-cookie",
    );
    const afterRead = await assertStable(
      next.db,
      old.state,
      lane + "-candidate-before-relogin",
    );
    need(
      afterRead.sessionsSha === old.state.sessionsSha,
      lane + "-readback-keeps-all-old-session-rows",
    );
    checks.push(
      "same-salt-candidate-accepts-old-persona-cookie",
      "candidate-reads-account-post-media-and-kv",
    );

    currentCheck = lane + "-candidate-password-relogin-rotation";
    const rootCookie = await login(
      newMf,
      old.personaCookie,
      lane + "-candidate-root-relogin",
    );
    need(
      rootCookie !== old.personaCookie &&
        !(await session(next.db, old.personaCookie, SALT_A)) &&
        validSession(
          await session(next.db, rootCookie, SALT_A),
          rootCookie,
          SALT_A,
          ROOT,
        ),
      lane + "-candidate-root-login-rotates-old-cookie",
    );
    const rootMe = await jsonRequest(
      newMf,
      "/api/auth/me",
      rootCookie,
      lane + "-candidate-root-me",
    );
    need(
      rootMe.body.actor?.ap_id === ROOT && rootMe.body.actor.role === "owner",
      lane + "-candidate-relogin-root",
    );
    await membership(next.db, lane + "-candidate-relogin");
    await accountList(
      newMf,
      rootCookie,
      ROOT,
      lane + "-candidate-root-accounts",
    );
    const replay = await fetchPath(newMf, "/api/auth/me", {
      headers: headers(old.personaCookie, false),
    });
    await replay.body?.cancel();
    need(replay.status === 401, lane + "-old-persona-cookie-revoked");
    await assertStable(next.db, old.state, lane + "-candidate-after-relogin");
    await kvAssert(next.kv, old.sentinel, lane + "-candidate-after-relogin");
    const switched = await switchPersona(
      newMf,
      rootCookie,
      lane + "-candidate-switch-to-existing-persona",
    );
    await verifyPersona(
      newMf,
      next.db,
      next.r2,
      switched,
      { post: old.post, mediaId: old.mediaId, url: old.url, key: old.key },
      lane + "-candidate-switched-persona",
    );
    await assertStable(
      next.db,
      old.state,
      lane + "-candidate-final-logical-data",
    );
    checks.push(
      "candidate-password-relogin-rotates-old-cookie",
      "candidate-switches-to-existing-persona",
    );

    await dispose(newMf);
    newMf = undefined;
    const candidateFiles = storeDigests(paths);
    currentCheck = lane + "-candidate-reopen-restored-snapshot";
    cloneMf = nativeWorker(newPath, cloned.paths, ids, config, SALT_A);
    await cloneMf.ready;
    const restored = await handles(cloneMf);
    const restoredState = await snapshot(restored.db);
    need(
      restoredState.dataSha === old.state.dataSha &&
        restoredState.schemaSha === old.state.schemaSha,
      lane + "-restored-candidate-snapshot-state",
    );
    await ready(cloneMf, lane + "-restored-candidate-ready");
    await verifyPersona(
      cloneMf,
      restored.db,
      restored.r2,
      old.personaCookie,
      { post: old.post, mediaId: old.mediaId, url: old.url, key: old.key },
      lane + "-restored-snapshot-cookie",
    );
    await kvAssert(restored.kv, old.sentinel, lane + "-restored-snapshot");
    await assertStable(
      restored.db,
      old.state,
      lane + "-restored-snapshot-final",
    );
    checks.push(
      "restored-closed-snapshot-candidate-accepts-cookie-and-preserves-d1-r2-kv",
    );
    await dispose(cloneMf);
    cloneMf = undefined;
    return {
      name: lane,
      saltMode: "dedicated salt preserved byte-for-byte, including whitespace",
      physicalIds: ids,
      oldClosedFiles: closedFiles,
      candidateClosedFiles: candidateFiles,
      restoredCloneInitialFiles: cloned.evidence,
      restoredCloneFinalFiles: storeDigests(cloned.paths),
      dataSha256: "sha256:" + old.state.dataSha,
      schemaSha256: "sha256:" + old.state.schemaSha,
      kv: "native binding sentinel verified; value omitted",
      media: { bytes: PNG.length, sha256: "sha256:" + hash(PNG) },
      checks,
    };
  } finally {
    await disposeBestEffort(cloneMf, newMf, oldMf);
  }
}
async function runOidc(root, bundle, config, oldPath, newPath, firstAddition) {
  const lane = firstAddition
    ? "oidc-first-salt-addition"
    : "oidc-salt-preserved";
  const paths = storesAt(root, lane + "-primary");
  const ids = idsFor(lane);
  const oldSalt = firstAddition ? OMIT : SALT_A;
  const oldHashSalt = firstAddition ? FALLBACK_SALT : SALT_A;
  const candidateSalt = firstAddition ? SALT_B : SALT_A;
  currentCheck = lane + "-issuer-initialization";
  lastSafeEvidence = undefined;
  const issuer = await createSyntheticUpdateIssuer({
    origin: ORIGIN,
    need,
    hash,
  });
  const owner = ORIGIN + "/ap/users/update_owner";
  const content = "Synthetic OIDC encrypted-token update fixture";
  const checks = [];
  let oldMf, newMf, rollbackMf, cloneMf;
  let fixture;
  async function verifyIdentity(mf, cookie, check) {
    const result = await jsonRequest(mf, "/api/auth/me", cookie, check);
    need(
      result.body.actor?.ap_id === owner &&
        result.body.actor.role === "owner" &&
        result.body.provider === "takos" &&
        result.body.has_takos_access === true,
      check + "-same-pinned-owner-and-provider-presence",
    );
  }
  async function verifySession(db, credential, salt, check) {
    const row = await session(db, credential.cookie, salt);
    need(
      row?.id === sessionId(salt, credential.cookie) &&
        row.access_token === row.id &&
        row.member_id === owner &&
        Date.parse(row.expires_at) > Date.now() &&
        Date.parse(row.provider_token_expires_at) > Date.now(),
      check + "-salted-owner-session-and-expiry",
    );
    await issuer.assertEncrypted(row, credential, ENCRYPTION_KEY, check);
    return row;
  }
  async function verifyFixture(mf, h, check) {
    const result = await jsonRequest(
      mf,
      "/api/posts/" + encodeURIComponent(fixture.post),
      fixture.cookie,
      check + "-post",
    );
    need(
      result.body.post?.ap_id === fixture.post &&
        result.body.post.author?.ap_id === owner &&
        result.body.post.content === content &&
        result.body.post.attachments?.length === 1 &&
        result.body.post.attachments[0].url === fixture.url,
      check + "-owner-note-media-reference",
    );
    const saved = await h.db
      .prepare(
        "SELECT uploader_ap_id, r2_key, size FROM media_uploads WHERE id = ?",
      )
      .bind(fixture.mediaId)
      .first();
    const object = await h.r2.get(fixture.key);
    need(
      saved?.uploader_ap_id === owner &&
        saved.r2_key === fixture.key &&
        saved.size === PNG.length &&
        object &&
        Buffer.from(await object.arrayBuffer()).equals(PNG),
      check + "-native-d1-r2-byte-readback",
    );
    const response = await fetchPath(mf, fixture.url, {
      headers: headers(fixture.cookie, false),
    });
    need(
      response.status === 200 &&
        response.headers.get("content-type") === "image/png" &&
        Buffer.from(await response.arrayBuffer()).equals(PNG),
      check + "-http-media-bytes",
    );
  }
  async function oldCookieState(mf, h, old, state, check) {
    const before = await snapshot(h.db);
    need(
      before.dataSha === state.dataSha &&
        before.schemaSha === state.schemaSha &&
        before.sessionsSha === state.sessionsSha,
      check + "-all-logical-data-schema-and-session-columns-preserved",
    );
    const preserved = await verifySession(h.db, old, oldHashSalt, check);
    need(
      JSON.stringify(preserved) === JSON.stringify(old.row),
      check + "-exact-old-encrypted-row-preserved",
    );
    if (firstAddition) {
      const refused = await fetchPath(mf, "/api/auth/me", {
        headers: headers(old.cookie, false),
      });
      await refused.body?.cancel();
      need(refused.status === 401, check + "-new-salt-refuses-old-cookie");
    } else {
      await verifyIdentity(mf, old.cookie, check);
      await verifyFixture(mf, h, check);
    }
    const after = await snapshot(h.db);
    need(
      after.dataSha === state.dataSha &&
        after.schemaSha === state.schemaSha &&
        after.sessionsSha === state.sessionsSha,
      check + "-reads-or-refusal-do-not-rewrite-data-or-session",
    );
    return preserved;
  }
  try {
    currentCheck = lane + "-old-real-oidc-setup";
    oldMf = nativeWorker(oldPath, paths, ids, config, oldSalt, issuer);
    await oldMf.ready;
    const h = await handles(oldMf);
    await applySchema(h.db, bundle, lane + "-fresh-only-schema");
    await emptyOwnerSession(h.db, lane + "-no-seeded-identities");
    currentCheck = lane + "-old-oidc-login";
    lastSafeEvidence = undefined;
    const old = await issuer.login(oldMf, fetchPath, activeCookie);
    await verifyIdentity(oldMf, old.cookie, lane + "-old-http-me");
    old.row = await verifySession(h.db, old, oldHashSalt, lane + "-old-tokens");
    const ownerRows = await actors(h.db);
    need(
      ownerRows.length === 1 &&
        ownerRows[0].ap_id === owner &&
        ownerRows[0].role === "owner" &&
        ownerRows[0].owner_actor_ap_id == null &&
        ownerRows[0].takos_user_id === "takos:update_owner",
      lane + "-one-pinned-human-owner",
    );
    const form = new FormData();
    form.set("file", new File([PNG], "oidc-update.png", { type: "image/png" }));
    const uploadResponse = await fetchPath(oldMf, "/api/media/upload", {
      method: "POST",
      headers: headers(old.cookie, false),
      body: form,
    });
    const upload = await jsonResponse(
      uploadResponse,
      200,
      lane + "-old-upload",
    );
    const postResponse = await fetchPath(oldMf, "/api/posts", {
      method: "POST",
      headers: headers(old.cookie, true),
      body: JSON.stringify({
        content,
        attachments: [
          {
            url: upload.url,
            r2_key: upload.r2_key,
            content_type: "image/png",
          },
        ],
      }),
    });
    const post = await jsonResponse(postResponse, 200, lane + "-old-note");
    need(
      typeof post.post?.ap_id === "string" &&
        typeof upload.id === "string" &&
        upload.r2_key === "uploads/" + upload.id + ".png" &&
        upload.url === "/media/" + upload.id + ".png",
      lane + "-old-http-fixture-identities",
    );
    fixture = {
      cookie: old.cookie,
      post: post.post.ap_id,
      mediaId: upload.id,
      key: upload.r2_key,
      url: upload.url,
    };
    await verifyFixture(oldMf, h, lane + "-old-fixture");
    const sentinel = await kvPut(h.kv, lane);
    const state = await snapshot(h.db);
    need(
      state.counts.actors === 1 &&
        state.counts.sessions === 1 &&
        state.counts.objects === 1 &&
        state.counts.mediaUploads === 1,
      lane + "-old-fixture-scope",
    );
    checks.push(
      "old-http-pinned-oidc-owner-and-encrypted-access-refresh-tokens",
      "old-token-decryption-and-wrong-key-tamper-controls",
      "old-owner-note-media-d1-r2-and-kv",
    );
    await dispose(oldMf);
    oldMf = undefined;
    const closed = storeDigests(paths);
    const cloned = cloneClosedStores(paths, join(root, lane + "-closed-clone"));
    checks.push("closed-old-stores-cloned-byte-for-byte-before-update");

    currentCheck = lane + "-candidate-existing-stores";
    newMf = nativeWorker(newPath, paths, ids, config, candidateSalt, issuer);
    await newMf.ready;
    const next = await handles(newMf);
    await oldCookieState(newMf, next, old, state, lane + "-candidate");
    await kvAssert(next.kv, sentinel, lane + "-candidate");
    checks.push(
      "candidate-preserves-every-old-session-and-encrypted-token-column",
      firstAddition
        ? "first-salt-addition-refuses-old-cookie-without-row-rewrite"
        : "same-salt-candidate-accepts-old-oidc-cookie-and-reads-note-media",
    );

    currentCheck = lane + "-candidate-same-subject-reauth";
    const renewed = await issuer.login(
      newMf,
      fetchPath,
      activeCookie,
      old.cookie,
    );
    need(
      renewed.cookie !== old.cookie &&
        renewed.access !== old.access &&
        renewed.refresh !== old.refresh,
      lane + "-fresh-credentials",
    );
    await verifyIdentity(newMf, renewed.cookie, lane + "-reauth-me");
    const newRow = await verifySession(
      next.db,
      renewed,
      candidateSalt,
      lane + "-renewed-tokens",
    );
    need(
      newRow.provider_access_token !== old.row.provider_access_token &&
        newRow.provider_refresh_token !== old.row.provider_refresh_token,
      lane + "-reauth-encrypts-fresh-token-values",
    );
    const retained = await session(next.db, old.cookie, oldHashSalt);
    need(
      firstAddition
        ? JSON.stringify(retained) === JSON.stringify(old.row)
        : retained == null,
      lane + "-old-row-retention-or-rotation",
    );
    need(
      (await sessions(next.db)).length === (firstAddition ? 2 : 1),
      lane + "-reauth-session-count",
    );
    const oldReplay = await fetchPath(newMf, "/api/auth/me", {
      headers: headers(old.cookie, false),
    });
    await oldReplay.body?.cancel();
    need(
      oldReplay.status === 401,
      lane + "-old-cookie-no-longer-authenticates",
    );
    fixture.cookie = renewed.cookie;
    await verifyFixture(newMf, next, lane + "-renewed-fixture");
    const renewedState = await assertStable(
      next.db,
      state,
      lane + "-reauth-data",
    );
    await kvAssert(next.kv, sentinel, lane + "-reauth");
    checks.push(
      "same-subject-reauth-keeps-one-owner-and-rotates-encrypted-credentials",
      "old-cookie-refused-after-reauth-with-data-unchanged",
    );
    await dispose(newMf);
    newMf = undefined;

    currentCheck = lane + "-old-code-rollback-with-preserved-secrets";
    rollbackMf = nativeWorker(
      oldPath,
      paths,
      ids,
      config,
      candidateSalt,
      issuer,
    );
    await rollbackMf.ready;
    const rollback = await handles(rollbackMf);
    await verifyIdentity(rollbackMf, renewed.cookie, lane + "-rollback-me");
    need(
      JSON.stringify(
        await verifySession(
          rollback.db,
          renewed,
          candidateSalt,
          lane + "-rollback-tokens",
        ),
      ) === JSON.stringify(newRow),
      lane + "-rollback-exact-renewed-session",
    );
    await verifyFixture(rollbackMf, rollback, lane + "-rollback-fixture");
    need(
      (await snapshot(rollback.db)).sessionsSha === renewedState.sessionsSha,
      lane + "-rollback-session-columns-unchanged",
    );
    await assertStable(rollback.db, state, lane + "-rollback-data");
    await kvAssert(rollback.kv, sentinel, lane + "-rollback");
    await dispose(rollbackMf);
    rollbackMf = undefined;
    const primaryAfterRollback = storeDigests(paths);
    checks.push(
      "old-code-reopen-with-preserved-current-secrets-accepts-renewed-oidc-cookie",
    );

    currentCheck = lane + "-candidate-closed-clone-restore";
    cloneMf = nativeWorker(
      newPath,
      cloned.paths,
      ids,
      config,
      candidateSalt,
      issuer,
    );
    await cloneMf.ready;
    const restored = await handles(cloneMf);
    fixture.cookie = old.cookie;
    await oldCookieState(cloneMf, restored, old, state, lane + "-restored");
    if (firstAddition) {
      const recovery = await issuer.login(
        cloneMf,
        fetchPath,
        activeCookie,
        old.cookie,
      );
      await verifyIdentity(cloneMf, recovery.cookie, lane + "-restored-reauth");
      await verifySession(
        restored.db,
        recovery,
        candidateSalt,
        lane + "-restored-new-tokens",
      );
      need(
        JSON.stringify(await session(restored.db, old.cookie, oldHashSalt)) ===
          JSON.stringify(old.row),
        lane + "-restored-legacy-ciphertext-retained",
      );
      fixture.cookie = recovery.cookie;
      const recoveredSessionIds = (await sessions(restored.db))
        .map((row) => row.id)
        .sort();
      need(
        JSON.stringify(recoveredSessionIds) ===
          JSON.stringify(
            [old.row.id, sessionId(candidateSalt, recovery.cookie)].sort(),
          ),
        lane + "-restored-exact-two-legacy-and-recovered-sessions",
      );
      await verifyFixture(cloneMf, restored, lane + "-restored-fixture");
      await assertStable(restored.db, state, lane + "-restored-reauth-data");
    }
    await kvAssert(restored.kv, sentinel, lane + "-restored");
    await dispose(cloneMf);
    cloneMf = undefined;
    need(
      JSON.stringify(storeDigests(paths)) ===
        JSON.stringify(primaryAfterRollback),
      lane + "-restore-does-not-change-primary-closed-stores",
    );
    const issuerEvidence = issuer.evidence();
    need(
      issuerEvidence.blocked === 0,
      lane + "-no-unexpected-outbound-request",
    );
    checks.push(
      "closed-clone-restore-preserves-old-ciphertext-and-identity",
      firstAddition
        ? "restored-first-addition-recovers-through-synthetic-oidc-reauth"
        : "restored-same-salt-old-cookie-still-authenticates",
      "clone-restore-leaves-primary-closed-stores-unchanged",
    );
    return {
      name: lane,
      physicalIds: ids,
      oldClosedFiles: closed,
      restoredCloneInitialFiles: cloned.evidence,
      primaryAfterRollbackFiles: primaryAfterRollback,
      restoredCloneFinalFiles: storeDigests(cloned.paths),
      oldSessionSha256: "sha256:" + hash(Buffer.from(JSON.stringify(old.row))),
      oldLogicalDataSha256: "sha256:" + state.dataSha,
      encryptionKey: "same synthetic key preserved; value omitted",
      tokenScope:
        "opaque ciphertext preservation and independent AES-GCM recovery; Core has no decrypt-and-use or refresh path",
      saltMode: firstAddition
        ? "old public fallback; candidate/rollback/restore keep a newly configured salt; OIDC reauth required"
        : "explicit dedicated old salt preserved byte-for-byte",
      issuer: issuerEvidence,
      checks,
    };
  } finally {
    await disposeBestEffort(cloneMf, rollbackMf, newMf, oldMf);
  }
}
async function runLegacy(root, bundle, config, oldPath, newPath) {
  const lane = "fallback-salt-relogin";
  const paths = storesAt(root, lane + "-primary");
  const ids = idsFor(lane);
  let oldMf, newMf;
  const checks = [];
  try {
    oldMf = nativeWorker(oldPath, paths, ids, config, OMIT);
    const old = await oldFixture(oldMf, bundle, lane, FALLBACK_SALT);
    const legacyKey = sessionId(FALLBACK_SALT, old.personaCookie);
    need(old.legacy.id === legacyKey, lane + "-old-core-fallback-session-id");
    const oldState = await snapshot(old.db);
    await dispose(oldMf);
    oldMf = undefined;
    const closedFiles = storeDigests(paths);
    need(
      closedFiles.d1.files > 0 && closedFiles.r2.files > 0,
      lane + "-old-closed-files-present",
    );

    currentCheck = lane + "-candidate-new-salt-open";
    newMf = nativeWorker(newPath, paths, ids, config, SALT_B);
    await newMf.ready;
    const next = await handles(newMf);
    const initial = await snapshot(next.db);
    need(
      initial.dataSha === oldState.dataSha &&
        initial.schemaSha === oldState.schemaSha,
      lane + "-candidate-existing-d1-state",
    );
    need(
      initial.sessionsSha === oldState.sessionsSha,
      lane + "-candidate-reopens-all-old-session-rows",
    );
    await ready(newMf, lane + "-candidate-ready");
    need(
      JSON.stringify(await r2Keys(next.r2)) === JSON.stringify([old.key]),
      lane + "-candidate-existing-r2",
    );
    await kvAssert(next.kv, old.sentinel, lane + "-candidate-existing-kv");
    const legacyBefore = await session(
      next.db,
      old.personaCookie,
      FALLBACK_SALT,
    );
    need(
      JSON.stringify(legacyBefore) === JSON.stringify(old.legacy),
      lane + "-legacy-row-reopened-unchanged",
    );

    currentCheck = lane + "-new-salt-rejects-old-cookie";
    const rejected = await fetchPath(newMf, "/api/auth/me", {
      headers: headers(old.personaCookie, false),
    });
    await rejected.body?.cancel();
    need(rejected.status === 401, lane + "-old-cookie-is-401-under-new-salt");
    const legacyAfterReject = await session(
      next.db,
      old.personaCookie,
      FALLBACK_SALT,
    );
    need(
      JSON.stringify(legacyAfterReject) === JSON.stringify(legacyBefore),
      lane + "-legacy-session-row-unchanged-on-401",
    );
    await assertStable(next.db, oldState, lane + "-data-unchanged-on-401");
    checks.push(
      "new-synthetic-salt-rejects-old-fallback-cookie",
      "old-fallback-session-row-remains-unchanged",
    );

    currentCheck = lane + "-password-relogin-recovers-root";
    const rootCookie = await login(
      newMf,
      undefined,
      lane + "-candidate-root-password-login",
    );
    need(
      validSession(
        await session(next.db, rootCookie, SALT_B),
        rootCookie,
        SALT_B,
        ROOT,
      ),
      lane + "-new-salt-root-session",
    );
    const identity = await jsonRequest(
      newMf,
      "/api/auth/me",
      rootCookie,
      lane + "-candidate-root-identity",
    );
    need(
      identity.body.actor?.ap_id === ROOT &&
        identity.body.actor.role === "owner",
      lane + "-same-root-recovered",
    );
    await membership(next.db, lane + "-same-membership-after-login");
    await accountList(
      newMf,
      rootCookie,
      ROOT,
      lane + "-same-owner-accounts-after-login",
    );
    need(
      JSON.stringify(
        await session(next.db, old.personaCookie, FALLBACK_SALT),
      ) === JSON.stringify(legacyBefore),
      lane + "-legacy-session-row-unchanged-after-relogin",
    );
    await assertStable(next.db, oldState, lane + "-data-stable-after-relogin");
    await kvAssert(next.kv, old.sentinel, lane + "-kv-stable-after-relogin");

    currentCheck = lane + "-switch-existing-persona";
    const personaCookie = await switchPersona(
      newMf,
      rootCookie,
      lane + "-switch-to-existing-persona",
    );
    need(
      validSession(
        await session(next.db, personaCookie, SALT_B),
        personaCookie,
        SALT_B,
        PERSONA,
      ),
      lane + "-persona-session-uses-new-salt",
    );
    await verifyPersona(
      newMf,
      next.db,
      next.r2,
      personaCookie,
      { post: old.post, mediaId: old.mediaId, url: old.url, key: old.key },
      lane + "-recovered-persona",
    );
    need(
      JSON.stringify(
        await session(next.db, old.personaCookie, FALLBACK_SALT),
      ) === JSON.stringify(legacyBefore),
      lane + "-fallback-row-still-preserved",
    );
    await assertStable(next.db, oldState, lane + "-final-product-data");
    await kvAssert(next.kv, old.sentinel, lane + "-final-kv");
    checks.push(
      "unchanged-password-recovers-root-and-existing-persona",
      "existing-post-media-and-kv-remain-readable",
    );
    await dispose(newMf);
    newMf = undefined;
    return {
      name: lane,
      saltMode: "old binding truly omitted; candidate has new synthetic salt",
      physicalIds: ids,
      oldClosedFiles: closedFiles,
      candidateClosedFiles: storeDigests(paths),
      oldLegacySessionRow:
        "salted fallback key and unchanged row verified; raw cookie omitted",
      dataSha256: "sha256:" + oldState.dataSha,
      schemaSha256: "sha256:" + oldState.schemaSha,
      kv: "native binding sentinel verified; value omitted",
      media: { bytes: PNG.length, sha256: "sha256:" + hash(PNG) },
      checks,
    };
  } finally {
    await disposeBestEffort(newMf, oldMf);
  }
}
async function validSaltControl(root, bundle, config, candidatePath) {
  const paths = storesAt(root, "invalid-salt-valid-control");
  const ids = idsFor("invalid-salt-valid-control");
  let mf;
  try {
    currentCheck = "invalid-salt-valid-control-start";
    mf = nativeWorker(candidatePath, paths, ids, config, SALT_B);
    await mf.ready;
    const h = await handles(mf);
    await applySchema(h.db, bundle, "invalid-salt-valid-control-schema");
    await emptyOwnerSession(h.db, "invalid-salt-valid-control-empty");
    const response = await fetchPath(mf, "/api/auth/login", {
      method: "POST",
      headers: headers(undefined, true),
      body: JSON.stringify({ password: PASSWORD }),
    });
    const body = await jsonResponse(
      response,
      200,
      "invalid-salt-valid-control-login",
    );
    need(body.success === true, "invalid-salt-valid-control-login-success");
    const cookie = activeCookie(response, "invalid-salt-valid-control-login");
    const owner = await actors(h.db);
    const savedSession = await session(h.db, cookie, SALT_B);
    need(
      owner.length === 1 &&
        owner[0]?.ap_id === ROOT &&
        validSession(savedSession, cookie, SALT_B, ROOT),
      "invalid-salt-valid-control-proves-runtime-and-password",
    );
    return { schemaSha: (await snapshot(h.db)).schemaSha };
  } finally {
    await disposeBestEffort(mf);
  }
}
async function invalidSaltChecks(root, bundle, config, newPath) {
  const control = await validSaltControl(root, bundle, config, newPath);
  const cases = [
    { name: "missing", value: OMIT },
    { name: "blank", value: " \t" },
    { name: "public-fallback", value: FALLBACK_SALT },
  ];
  const results = [];
  for (const item of cases) {
    const lane = "invalid-" + item.name;
    const paths = storesAt(root, lane);
    const ids = idsFor(lane);
    let mf;
    try {
      currentCheck = lane + "-native-worker-start";
      mf = nativeWorker(newPath, paths, ids, config, item.value);
      const db = await (async () => {
        await mf.ready;
        const h = await handles(mf);
        await applySchema(h.db, bundle, lane + "-fresh-schema");
        await emptyOwnerSession(h.db, lane + "-fresh-no-actor-session");
        const fresh = await snapshot(h.db);
        need(
          fresh.schemaSha === control.schemaSha,
          lane + "-same-schema-as-valid-control",
        );
        return h.db;
      })();
      currentCheck = lane + "-actual-native-password-login-refused";
      const diagnostic = runtimeEvidence.get(mf);
      let response;
      let guardObservedInResponse = false;
      let invocationThrew = false;
      try {
        response = await fetchPath(mf, "/api/auth/login", {
          method: "POST",
          headers: headers(undefined, true),
          body: JSON.stringify({ password: PASSWORD }),
        });
      } catch (error) {
        invocationThrew = true;
        const message = error instanceof Error ? error.message : "";
        if (message.length <= 4096) {
          observeGuard(diagnostic, message, "thrown-error-message");
        }
      }
      if (response) {
        need(
          response.status === 500,
          lane + "-expected-native-configuration-failure",
        );
        guardObservedInResponse = await responseHasGuardMarker(
          response,
          diagnostic,
        );
      }
      need(
        invocationThrew || response?.status === 500,
        lane + "-native-invocation-failed",
      );
      await emptyOwnerSession(db, lane + "-no-owner-or-session-write");
      await dispose(mf);
      mf = undefined;
      const guardObserved = await waitForGuard(diagnostic);
      lastSafeEvidence = {
        httpStatus: response?.status ?? null,
        invocationThrew,
        responseGuardMarker: guardObservedInResponse,
        guardChannel: diagnostic?.guardChannel ?? null,
        runtimeDiagnosticLines: diagnostic?.lines ?? 0,
        runtimeGuardMarkerCount: diagnostic?.sessionSaltGuardRefusals ?? 0,
      };
      need(
        guardObserved && diagnostic?.sessionSaltGuardRefusals > 0,
        lane + "-specific-salt-guard-diagnostic",
      );
      results.push({
        salt: item.name,
        result: "native-login-refused-before-owner-session-write",
        httpStatus: response?.status ?? "worker-invocation-rejected",
        guardDiagnosticClass: "required-session-salt",
        guardChannel: diagnostic.guardChannel,
        guardObservedInResponse,
        runtimeDiagnosticLines: diagnostic.lines,
      });
    } finally {
      await disposeBestEffort(mf);
    }
  }
  return {
    validSaltControl:
      "same candidate/password/schema accepted real owner login",
    refusals: results,
  };
}
async function run() {
  const args = parseCli(process.argv.slice(2));
  need(args.oldPath !== args.newPath, "old-and-candidate-paths-distinct");
  const old = artifact(args.oldPath, "old-worker");
  need(old.sha === OLD_SHA, "old-worker-v2-2-0-sha256-pin");
  const candidate = artifact(args.newPath, "candidate-worker");
  need(
    candidate.sha !== old.sha,
    "candidate-differs-from-immutable-old-worker",
  );
  const schema = schemaBundle();
  const config = compatibilityConfig();
  currentCheck = "owned-temporary-root";
  const tempRoot = mkdtempSync(join(tmpdir(), "yurucommu-session-update-"));
  let failure;
  let result;
  try {
    const dedicated = await runDedicated(
      tempRoot,
      schema.bundle,
      config,
      args.oldPath,
      args.newPath,
    );
    const fallback = await runLegacy(
      tempRoot,
      schema.bundle,
      config,
      args.oldPath,
      args.newPath,
    );
    const invalid = await invalidSaltChecks(
      tempRoot,
      schema.bundle,
      config,
      args.newPath,
    );
    const oidcDedicated = await runOidc(
      tempRoot,
      schema.bundle,
      config,
      args.oldPath,
      args.newPath,
      false,
    );
    const oidcFirstAddition = await runOidc(
      tempRoot,
      schema.bundle,
      config,
      args.oldPath,
      args.newPath,
      true,
    );
    need(
      outboundEvidence.blockedFetches === 0,
      "native-workers-made-no-external-fetches",
    );
    need(
      hash(readFileSync(args.oldPath)) === OLD_SHA &&
        hash(readFileSync(args.newPath)) === candidate.sha,
      "artifact-bytes-stable-during-qualification",
    );
    result = {
      kind: "yurucommu.native-session-update-continuity@v1",
      status: "PASSED",
      scope:
        "offline disposable workerd with native persistent D1/KV/R2; password lanes deny all outbound fetches, OIDC lanes admit only a local synthetic signed issuer, no schema migration, cloud, deployment, live identity, or real data",
      artifacts: {
        oldVersion: OLD_VERSION,
        oldCommit: OLD_COMMIT,
        oldWorkerSha256: "sha256:" + OLD_SHA,
        candidateWorker: basename(args.newPath),
        candidateWorkerSha256: "sha256:" + candidate.sha,
        coreVersion: CORE_VERSION,
        schemaBundleSha256: "sha256:" + hash(schema.bytes),
        schemaEntriesAppliedOnlyToFreshLocalStores: SCHEMA_COUNT,
      },
      lanes: [dedicated, fallback],
      oidcLanes: [oidcDedicated, oidcFirstAddition],
      invalidSaltGuards: invalid,
      externalWorkerFetches: {
        policy:
          "password lanes deny all outbound; OIDC lanes admit only local synthetic issuer endpoints and report their blocked counts separately",
        observedBlockedFetches: outboundEvidence.blockedFetches,
      },
      checks: [
        "old-published-worker-bytes-and-shared-schema-pinned-before-runtime",
        "schema-entry-digests-validated-and-applied-only-to-fresh-local-stores",
        "candidate-opens-existing-native-persistent-stores-without-migration",
        "dedicated-salt-cookie-continuity-and-restored-snapshot",
        "fallback-salt-transition-requires-password-relogin-without-row-rewrite",
        "missing-blank-and-public-fallback-salts-refused-before-owner-or-session-writes",
        "synthetic-oidc-encrypted-access-refresh-token-update-reauth-rollback-and-closed-restore",
      ],
    };
  } catch (error) {
    failure = error instanceof Failure ? error : new Failure(currentCheck);
  } finally {
    for (const worker of [...activeWorkers]) {
      try {
        await dispose(worker);
      } catch {
        if (!failure) failure = new Failure("native-worker-dispose");
      }
    }
    if (activeWorkers.size > 0) {
      if (!failure) failure = new Failure("native-worker-dispose");
    } else {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        if (!failure) failure = new Failure("owned-temp-root-cleanup");
      }
    }
  }
  if (failure) throw failure;
  return result;
}
async function main() {
  try {
    const result = await run();
    need(
      result?.kind === "yurucommu.native-session-update-continuity@v1" &&
        result.status === "PASSED",
      "completed-result-required",
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        kind: "yurucommu.native-session-update-continuity@v1",
        status: "FAILED",
        check: error instanceof Failure ? error.check : currentCheck,
        ...(lastSafeEvidence ? { evidence: lastSafeEvidence } : {}),
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
await main();
