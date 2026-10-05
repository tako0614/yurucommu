import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { unstable_readConfig, unstable_splitSqlQuery } from "wrangler";
import { createManagedNativeRuntime } from "./native-runtime-stdio.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(
  sourceRoot,
  "deploy/takoform/migrations/schema-bundle.json",
);
const configPath = resolve(sourceRoot, "wrangler.jsonc");
const args = process.argv.slice(2);
let artifactArgument = "dist/yurucommu-worker.js";
let denyUnsignedPeerKeyGet = false;
let denyEndpointRetry = false;
let artifactProvided = false;
let argumentError;
for (const arg of args) {
  if (arg === "--deny-peer-key-fetch" && !denyUnsignedPeerKeyGet) {
    denyUnsignedPeerKeyGet = true;
  } else if (arg === "--deny-endpoint-retry" && !denyEndpointRetry) {
    denyEndpointRetry = true;
  } else if (!arg.startsWith("-") && !artifactProvided) {
    artifactArgument = arg;
    artifactProvided = true;
  } else {
    argumentError =
      "usage: smoke-release-federation.mjs [worker.js] [--deny-peer-key-fetch | --deny-endpoint-retry]";
    break;
  }
}
if (denyUnsignedPeerKeyGet && denyEndpointRetry) {
  argumentError =
    "--deny-peer-key-fetch and --deny-endpoint-retry cannot be combined";
}
const artifactPath = resolve(sourceRoot, artifactArgument);
const label = randomBytes(6).toString("hex");
const origins = [
  "https://a.yuru-native.invalid",
  "https://b.yuru-native.invalid",
];
const dnsRecords = new Map([
  ["a.yuru-native.invalid", "93.184.216.34"],
  ["b.yuru-native.invalid", "93.184.216.35"],
]);
const workerNames = ["peer-a", "peer-b"];
const routerNames = ["route-a", "route-b"];
const phases = [];
const apiStatuses = [];
const diagnostics = { bytes: 0 };
const routeEvents = [];
const secrets = [];
const instances = [];
let deniedEndpointRetryObserved = false;
let digestTamperProof = null;
let phase = "preflight";
let runtime;
let tempRoot;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function redact(value) {
  let output = String(value);
  for (const [path, replacement] of [
    [artifactPath, "[artifact]"],
    [schemaPath, "[schema]"],
    [tempRoot, "[temporary state]"],
    [sourceRoot, "[repo]"],
  ]) {
    if (path) output = output.split(path).join(replacement);
  }
  for (const secret of secrets)
    if (secret) output = output.split(secret).join("[redacted]");
  output = output.replace(
    /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g,
    "[redacted private key]",
  );
  output = output.replace(
    /(authorization\s*[:=]\s*(?:Bearer\s+)?)[^\s,;]+/gi,
    "$1[redacted]",
  );
  output = output.replace(
    /(password|access_token|private_key_pem)\s*[=:]\s*[^\s,;]+/gi,
    "$1=[redacted]",
  );
  return output.slice(-1200);
}
function safeDiagnostics() {
  return {
    runtimeLogBytes: diagnostics.bytes,
    routeEvents: routeEvents.slice(-32),
  };
}
function captureDiagnosticChunk(chunk) {
  diagnostics.bytes += chunk.length;
  for (const line of chunk.toString("utf8").split("\n")) {
    const index = line.indexOf("native-peer-route ");
    if (index < 0) continue;
    try {
      const event = JSON.parse(line.slice(index + "native-peer-route ".length));
      if (
        routeEvents.length < 80 &&
        ["route-a", "route-b"].includes(event.router) &&
        ["GET", "POST"].includes(event.method)
      ) {
        const summary = {
          router: event.router,
          method: event.method,
          path: event.path,
          targetHost: event.targetHost,
          headerHost: event.headerHost,
          signaturePresent: Boolean(event.signaturePresent),
          status: event.status,
          activityId:
            typeof event.activityId === "string" ? event.activityId : null,
          activityType:
            typeof event.activityType === "string" ? event.activityType : null,
          actorId: typeof event.actorId === "string" ? event.actorId : null,
          objectId: typeof event.objectId === "string" ? event.objectId : null,
          followTarget:
            typeof event.followTarget === "string" ? event.followTarget : null,
          followersOnlyAddressing: Boolean(event.followersOnlyAddressing),
          reason:
            event.reason === "digest-tamper-refused"
              ? event.reason
              : event.reason === "fixture-deny-endpoint-retry"
                ? event.reason
                : event.reason === "first-followers-create-503"
                  ? event.reason
                  : event.reason === "fixture-deny-unsigned-peer-key-get"
                    ? event.reason
                    : undefined,
          atMs: Number.isSafeInteger(event.atMs) ? event.atMs : null,
          originalId:
            typeof event.originalId === "string" ? event.originalId : null,
          mutatedId:
            typeof event.mutatedId === "string" ? event.mutatedId : null,
          originalSha256: /^[a-f0-9]{64}$/.test(event.originalSha256)
            ? event.originalSha256
            : null,
          mutatedSha256: /^[a-f0-9]{64}$/.test(event.mutatedSha256)
            ? event.mutatedSha256
            : null,
          headersPreserved: event.headersPreserved === true,
          responseError:
            event.responseError === "Signature verification failed"
              ? event.responseError
              : null,
          noInboundEffects: event.noInboundEffects === true,
          inboundCounts:
            event.inboundCounts && typeof event.inboundCounts === "object"
              ? Object.fromEntries(
                  ["activities", "claims", "inbox", "follows", "objects"].map(
                    (name) => [
                      name,
                      Number.isSafeInteger(event.inboundCounts[name])
                        ? event.inboundCounts[name]
                        : null,
                    ],
                  ),
                )
              : null,
        };
        if (
          !routeEvents.some(
            (prior) => JSON.stringify(prior) === JSON.stringify(summary),
          )
        )
          routeEvents.push(summary);
      }
    } catch {
      /* diagnostic lines are optional evidence */
    }
  }
}
function deadline(promise, milliseconds, description) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${description}: ${milliseconds}ms deadline`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
async function poll(description, predicate, milliseconds = 30_000) {
  const until = Date.now() + milliseconds;
  while (Date.now() <= until) {
    const value = await deadline(predicate(), 8_000, description + " read");
    if (value) return value;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`${description}: ${milliseconds}ms deadline`);
}
function expectStatus(response, expected, label, payload) {
  const record = { phase, label, status: response.status };
  if (response.status !== expected && payload && typeof payload === "object") {
    if (typeof payload.code === "string") record.code = redact(payload.code);
    if (typeof payload.error === "string") record.error = redact(payload.error);
  }
  apiStatuses.push(record);
  assert.equal(response.status, expected, `${label}: HTTP ${response.status}`);
}
async function requestJson(
  instance,
  method,
  path,
  token,
  body,
  label,
  expected = 200,
) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await deadline(
    instance.native.fetch(instance.origin + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    15_000,
    label,
  );
  // A failed native response must be consumed before another dispatch; do not
  // persist arbitrary response bodies, which may echo credentials.
  const responseText = await deadline(response.text(), 8_000, label + " body");
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    expectStatus(response, expected, label);
    throw new Error(`${label}: invalid JSON response`);
  }
  expectStatus(response, expected, label, payload);
  return payload;
}
async function readSchema(runtime, path, splitSqlQuery, workerName) {
  const bytes = await readFile(path);
  const schema = JSON.parse(bytes.toString("utf8"));
  assert.equal(schema.apiVersion, "takosumi.resource-migrations/v1");
  assert.equal(schema.engine, "sqlite");
  assert(
    Array.isArray(schema.entries) && schema.entries.length > 0,
    "migration bundle must be nonempty",
  );
  const db = await deadline(
    runtime.worker.getD1Database("DB", workerName),
    10_000,
    "get D1",
  );
  for (const entry of schema.entries) {
    assert.equal(
      entry.sha256,
      `sha256:${sha256(Buffer.from(entry.sql, "utf8"))}`,
      `migration digest: ${entry.name}`,
    );
    const sql = splitSqlQuery(entry.sql);
    assert(sql.length > 0, `empty migration: ${entry.name}`);
    await deadline(
      db.batch(sql.map((statement) => db.prepare(statement))),
      20_000,
      `migration ${entry.name}`,
    );
  }
  const before = await db
    .prepare("SELECT COUNT(*) AS count FROM actors")
    .first();
  const sessions = await db
    .prepare("SELECT COUNT(*) AS count FROM sessions")
    .first();
  assert.equal(before?.count, 0, "schema was not a fresh actor database");
  assert.equal(sessions?.count, 0, "schema was not a fresh session database");
  return { db, sha256: sha256(bytes), entries: schema.entries.length };
}
async function rows(db, sql, args = []) {
  const result = await deadline(
    db
      .prepare(sql)
      .bind(...args)
      .all(),
    8_000,
    "read-only D1 query",
  );
  return result.results ?? [];
}
function virtualRouterScript(index) {
  const peerIndex = 1 - index;
  // This module executes inside the SAME workerd as the two unchanged product
  // artifacts. Its service binding is an in-process target, not Node fetch.
  return `const selfOrigin = ${JSON.stringify(origins[index])};
const peerOrigin = ${JSON.stringify(origins[peerIndex])};
const dns = ${JSON.stringify(Object.fromEntries(dnsRecords))};
let followersCreateFault = null;
let followDigestProbeUsed = false;
async function inboundCounts(db, actorId, targetId) {
  const queries = {
    activities: ["SELECT COUNT(*) AS count FROM activities WHERE direction = 'inbound'", []],
    claims: ["SELECT COUNT(*) AS count FROM inbound_activity_claims", []],
    inbox: ["SELECT COUNT(*) AS count FROM inbox", []],
    follows: ["SELECT COUNT(*) AS count FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?", [actorId, targetId]],
    objects: ["SELECT COUNT(*) AS count FROM objects WHERE is_local = 0", []],
  };
  const counts = {};
  for (const [name, [sql, args]] of Object.entries(queries)) {
    const row = await db.prepare(sql).bind(...args).first();
    counts[name] = row?.count;
  }
  return counts;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin === 'https://cloudflare-dns.com' && url.pathname === '/dns-query' && request.method === 'GET') {
      const name = (url.searchParams.get('name') || '').toLowerCase().replace(/\\.$/, '');
      const type = url.searchParams.get('type');
      if (!Object.hasOwn(dns, name) || !['A', 'AAAA', 'CNAME'].includes(type)) return new Response(null, { status: 502 });
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ name, type: 1, TTL: 60, data: dns[name] }] : [] });
    }
    if (url.origin !== peerOrigin || url.origin === selfOrigin || url.protocol !== 'https:' || url.username || url.password || url.port)
      return new Response(null, { status: 502 });
    const metadata = { router: ${JSON.stringify(routerNames[index])}, method: request.method,
      path: url.pathname, targetHost: url.host, headerHost: request.headers.get('host'),
      signaturePresent: request.headers.has('signature') || request.headers.has('authorization') };
    if (request.method === 'POST' && url.pathname.endsWith('/inbox')) {
      const activity = await request.clone().json().catch(() => null);
      metadata.activityId = typeof activity?.id === 'string' ? activity.id : null;
      metadata.activityType = typeof activity?.type === 'string' ? activity.type : null;
      metadata.actorId = typeof activity?.actor === 'string' ? activity.actor : null;
      metadata.objectId = typeof activity?.object?.id === 'string' ? activity.object.id : null;
      metadata.followTarget = activity?.type === 'Follow' && typeof activity.object === 'string'
        ? activity.object : null;
      const publicAudience = 'https://www.w3.org/ns/activitystreams#Public';
      metadata.followersOnlyAddressing = metadata.actorId?.startsWith(selfOrigin + '/ap/users/')
        && activity?.object?.attributedTo === metadata.actorId
        && Array.isArray(activity?.object?.to)
        && activity.object.to.includes(metadata.actorId + '/followers')
        && ![...(activity.to || []), ...(activity.cc || []), ...(activity.object.to || []), ...(activity.object.cc || [])].includes(publicAudience);
    }
    // Native unsigned public-key GETs need no explicit Host header. The exact
    // URL origin still gates their destination. Signed requests require Host;
    // an explicit mismatched Host remains rejected. Never synthesize it.
    if ((metadata.signaturePresent || metadata.headerHost !== null)
      && metadata.headerHost?.toLowerCase() !== url.host.toLowerCase()) {
      console.log('native-peer-route', JSON.stringify({ ...metadata, status: 502, reason: 'host-mismatch' }));
      return new Response(null, { status: 502 });
    }
    if (${denyUnsignedPeerKeyGet} && request.method === 'GET'
      && url.pathname.startsWith('/ap/users/')
      && url.pathname.indexOf('/', '/ap/users/'.length) === -1
      && !metadata.signaturePresent) {
      console.log('native-peer-route', JSON.stringify({ ...metadata, status: 502, reason: 'fixture-deny-unsigned-peer-key-get' }));
      return new Response(null, { status: 502 });
    }
    if (${!denyUnsignedPeerKeyGet} && ${index === 0} && !followDigestProbeUsed
      && request.method === 'POST' && url.pathname.endsWith('/inbox')
      && metadata.signaturePresent && metadata.activityType === 'Follow'
      && metadata.actorId?.startsWith(selfOrigin + '/ap/users/')
      && metadata.followTarget?.startsWith(peerOrigin + '/ap/users/')
      && metadata.activityId?.startsWith(selfOrigin + '/ap/activities/')) {
      followDigestProbeUsed = true;
      const originalBody = await request.clone().text();
      const parsed = JSON.parse(originalBody);
      const originalId = parsed.id;
      const idStart = originalBody.indexOf(JSON.stringify(originalId));
      if (idStart < 0 || !/^[a-f0-9]$/i.test(originalId.at(-1)))
        throw new Error('digest probe requires a hex-suffixed Follow id');
      const lastNibbleOffset = idStart + JSON.stringify(originalId).length - 2;
      const changedNibble = originalBody[lastNibbleOffset].toLowerCase() === 'a' ? 'b' : 'a';
      const mutatedBody = originalBody.slice(0, lastNibbleOffset) + changedNibble
        + originalBody.slice(lastNibbleOffset + 1);
      const mutatedId = originalId.slice(0, -1) + changedNibble;
      if (mutatedBody.length !== originalBody.length
        || JSON.parse(mutatedBody).id !== mutatedId
        || mutatedId === originalId)
        throw new Error('digest probe changed more than one id nibble');
      const beforeCounts = await inboundCounts(env.PEER_DB, metadata.actorId, metadata.followTarget);
      if (!Object.values(beforeCounts).every((count) => count === 0))
        throw new Error('digest probe receiver had preexisting inbound effects');
      const negative = new Request(request.url, {
        method: request.method, headers: new Headers(request.headers), body: mutatedBody,
      });
      const retainedHeaders = ['host', 'date', 'signature', 'digest', 'content-length'];
      const headersPreserved = retainedHeaders.every((name) =>
        negative.headers.get(name) === request.headers.get(name));
      if (!headersPreserved) throw new Error('digest probe changed signed headers');
      const hashHex = async (body) => Array.from(new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
      )).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const negativeResponse = await env.PEER.fetch(negative);
      const negativeText = await negativeResponse.text();
      let negativeError = null;
      try { negativeError = JSON.parse(negativeText).error; } catch {}
      const counts = await inboundCounts(env.PEER_DB, metadata.actorId, metadata.followTarget);
      const noInboundEffects = Object.values(counts).every((count) => count === 0)
        && Object.keys(counts).every((name) => beforeCounts[name] === counts[name]);
      console.log('native-peer-route', JSON.stringify({ ...metadata,
        status: negativeResponse.status, reason: 'digest-tamper-refused',
        originalId, mutatedId, originalSha256: await hashHex(originalBody),
        mutatedSha256: await hashHex(mutatedBody), headersPreserved,
        responseError: negativeError === 'Signature verification failed' ? negativeError : null,
        noInboundEffects, inboundCounts: counts, atMs: Date.now() }));
      if (negativeResponse.status !== 401 || negativeError !== 'Signature verification failed'
        || !noInboundEffects) throw new Error('tampered Follow was not refused without inbound effects');
    }
    const signedFollowersCreate = ${index === 1} && metadata.signaturePresent
      && request.method === 'POST' && url.pathname.endsWith('/inbox')
      && metadata.activityType === 'Create' && metadata.followersOnlyAddressing
      && metadata.activityId && metadata.objectId;
    if (signedFollowersCreate && !followersCreateFault) {
      followersCreateFault = { activityId: metadata.activityId, objectId: metadata.objectId };
      console.log('native-peer-route', JSON.stringify({ ...metadata, status: 503,
        reason: 'first-followers-create-503', atMs: Date.now() }));
      return new Response(null, { status: 503 });
    }
    if (${denyEndpointRetry} && signedFollowersCreate
      && metadata.activityId === followersCreateFault?.activityId
      && metadata.objectId === followersCreateFault?.objectId) {
      console.log('native-peer-route', JSON.stringify({ ...metadata, status: 503,
        reason: 'fixture-deny-endpoint-retry', atMs: Date.now() }));
      return new Response(null, { status: 503 });
    }
    // Do not construct another Request or alter Host, URL, body, signature or
    // digest. The peer's own ap-verify performs the authoritative check.
    const response = await env.PEER.fetch(request);
    console.log('native-peer-route', JSON.stringify({ ...metadata, status: response.status, atMs: Date.now() }));
    return response;
  }
};`;
}
function instanceSettings(index, artifactPath, config, label) {
  const name = index === 0 ? "A" : "B";
  const queueName = `native-peer-${label}-${name.toLowerCase()}-delivery`;
  const deadLetterName = `native-peer-${label}-${name.toLowerCase()}-dlq`;
  const password = randomBytes(32).toString("base64url");
  const key = randomBytes(32).toString("hex");
  const salt = randomBytes(24).toString("base64url");
  secrets.push(password, key, salt);
  const instance = {
    name,
    origin: origins[index],
    artifactPath,
    queueName,
    deadLetterName,
    password,
  };
  instances[index] = instance;
  return {
    name: workerNames[index],
    modules: [{ type: "ESModule", path: artifactPath }],
    modulesRoot: dirname(artifactPath),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: {
      APP_URL: origins[index],
      AUTH_PASSWORD_HASH: password,
      YURUCOMMU_SESSION_HASH_SALT: salt,
      ENCRYPTION_KEY: key,
      DELIVERY_QUEUE_NAME: queueName,
      DELIVERY_DLQ_NAME: deadLetterName,
    },
    d1Databases: { DB: `native-peer-${label}-${name.toLowerCase()}-db` },
    kvNamespaces: { KV: `native-peer-${label}-${name.toLowerCase()}-kv` },
    r2Buckets: { MEDIA: `native-peer-${label}-${name.toLowerCase()}-media` },
    queueProducers: { DELIVERY_QUEUE: queueName, DELIVERY_DLQ: deadLetterName },
    queueConsumers: {
      [queueName]: {
        maxBatchSize: 1,
        maxBatchTimeout: 0,
        maxRetries: 1,
        retryDelay: 0,
        deadLetterQueue: deadLetterName,
      },
    },
    outboundService: routerNames[index],
  };
}
async function ownerLogin(instance) {
  const body = await requestJson(
    instance,
    "POST",
    "/api/auth/mobile/login",
    null,
    { password: instance.password },
    `${instance.name} mobile login`,
  );
  assert.equal(body.token_type, "Bearer");
  assert(
    typeof body.access_token === "string" && body.access_token.length > 0,
    `${instance.name} missing mobile token`,
  );
  instance.token = body.access_token;
  secrets.push(instance.token);
  const me = await requestJson(
    instance,
    "GET",
    "/api/auth/me",
    instance.token,
    undefined,
    `${instance.name} me`,
  );
  assert.equal(me.actor?.role, "owner");
  assert(
    typeof me.actor?.ap_id === "string" &&
      me.actor.ap_id.startsWith(instance.origin + "/ap/"),
    `${instance.name} owner AP ID`,
  );
  instance.ownerApId = me.actor.ap_id;
  const live = await rows(
    instance.schema.db,
    "SELECT ap_id, role, owner_actor_ap_id FROM actors WHERE deleted_at IS NULL",
  );
  assert.equal(
    live.length,
    1,
    `${instance.name} must have exactly one API-created owner`,
  );
  assert.equal(live[0].ap_id, instance.ownerApId);
  assert.equal(live[0].role, "owner");
  assert.equal(live[0].owner_actor_ap_id, null);
  return { apId: instance.ownerApId, ownerCount: live.length };
}
async function activityForObject(instance, objectApId) {
  const activityRows = await rows(
    instance.schema.db,
    "SELECT ap_id, type, actor_ap_id, object_ap_id, direction FROM activities WHERE object_ap_id = ? AND type = 'Create' AND direction = 'outbound'",
    [objectApId],
  );
  assert.equal(
    activityRows.length,
    1,
    `${instance.name} outbound Create must be unique for ${objectApId}`,
  );
  assert.equal(activityRows[0].actor_ap_id, instance.ownerApId);
  return activityRows[0].ap_id;
}
async function deliveredTo(instance, activityId, recipientApId) {
  const allJobs = await rows(
    instance.schema.db,
    "SELECT id, status FROM delivery_queue WHERE activity_ap_id = ?",
    [activityId],
  );
  assert.equal(
    allJobs.length,
    1,
    `${instance.name} expected one delivery job for Activity ${activityId}`,
  );
  assert.equal(allJobs[0].status, "delivered");
  const jobs = await rows(
    instance.schema.db,
    `SELECT q.id, q.status, q.attempts, q.delivered_at, q.inbox_url,
            r.recipient_actor_ap_id
       FROM delivery_queue q
       JOIN delivery_endpoint_recipients r ON r.delivery_job_id = q.id
      WHERE q.activity_ap_id = ? AND r.recipient_actor_ap_id = ?`,
    [activityId, recipientApId],
  );
  assert.equal(
    jobs.length,
    1,
    `${instance.name} expected one attributed delivery job`,
  );
  assert.equal(jobs[0].status, "delivered");
  assert(jobs[0].delivered_at, `${instance.name} missing delivered_at`);
  const inbox = new URL(jobs[0].inbox_url);
  assert.equal(inbox.origin, origins[0]);
  assert(
    inbox.pathname.endsWith("/inbox"),
    `${instance.name} delivery endpoint is not an inbox`,
  );
  return {
    activityId,
    status: jobs[0].status,
    attempts: jobs[0].attempts,
    recipientApId: jobs[0].recipient_actor_ap_id,
    inboxUrl: jobs[0].inbox_url,
  };
}
async function assertOwnerIsolation(local, remote) {
  const localActors = await rows(
    local.schema.db,
    "SELECT ap_id, role FROM actors WHERE deleted_at IS NULL",
  );
  assert.equal(
    localActors.length,
    1,
    `${local.name} local actor count drifted`,
  );
  assert.equal(
    localActors[0].ap_id,
    local.ownerApId,
    `${local.name} owner actor drifted`,
  );
  assert.equal(
    localActors[0].role,
    "owner",
    `${local.name} owner role drifted`,
  );
  const remoteCached = await rows(
    local.schema.db,
    "SELECT ap_id FROM actor_cache WHERE ap_id = ?",
    [remote.ownerApId],
  );
  assert.equal(
    remoteCached.length,
    1,
    `${local.name} remote actor missing from actor_cache`,
  );
  const remoteLocal = await rows(
    local.schema.db,
    "SELECT ap_id FROM actors WHERE ap_id = ?",
    [remote.ownerApId],
  );
  assert.equal(
    remoteLocal.length,
    0,
    `${local.name} remote actor materialized as local actor`,
  );
  const sessions = await rows(
    local.schema.db,
    "SELECT COUNT(*) AS count FROM sessions",
  );
  assert.equal(
    sessions[0]?.count,
    1,
    `${local.name} local owner session count drifted`,
  );
  return {
    worker: local.name,
    localOwners: 1,
    remoteCached: true,
    remoteLocalRows: 0,
    localSessions: 1,
  };
}

let mainError;
let finalRecord;
try {
  phase = "preflight";
  if (argumentError) throw new Error(argumentError);
  for (const path of [artifactPath, schemaPath, configPath]) {
    assert(
      (await stat(path)).isFile(),
      `missing release smoke input: ${basename(path)}`,
    );
  }
  const config = unstable_readConfig(
    { config: configPath },
    { hideWarnings: true },
  );
  assert(
    config.compatibility_date,
    "wrangler.jsonc must declare compatibility_date",
  );
  const productVersion = JSON.parse(
    await readFile(resolve(sourceRoot, "package.json"), "utf8"),
  ).version;
  const apiBindingVersion = JSON.parse(
    await readFile(
      resolve(sourceRoot, "node_modules/@takosjp/yurucommu-api/package.json"),
      "utf8",
    ),
  ).version;
  const artifactHash = sha256(await readFile(artifactPath));
  const schemaHash = sha256(await readFile(schemaPath));
  tempRoot = await mkdtemp(join(tmpdir(), "yurucommu-federation-smoke-"));
  phases.push("preflight-artifact-hashes-and-independent-state-roots");
  phase = "native-start-and-migrate";
  const workerA = instanceSettings(0, artifactPath, config, label);
  const workerB = instanceSettings(1, artifactPath, config, label);
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      captureDiagnosticChunk(chunk);
      callback();
    },
  });
  const structuredLogs = (entry) => {
    const text =
      typeof entry?.message === "string"
        ? entry.message
        : JSON.stringify(entry);
    if (text.includes("native-peer-route "))
      captureDiagnosticChunk(Buffer.from(text + "\n"));
  };
  runtime = createManagedNativeRuntime(
    (handleRuntimeStdio) =>
      new Miniflare({
        rootPath: tempRoot,
        host: "127.0.0.1",
        port: 0,
        cf: false,
        workers: [
          workerA,
          workerB,
          {
            name: routerNames[0],
            modules: true,
            script: virtualRouterScript(0),
            serviceBindings: { PEER: workerNames[1] },
            d1Databases: { PEER_DB: workerB.d1Databases.DB },
            outboundService: "deny-outbound",
          },
          {
            name: routerNames[1],
            modules: true,
            script: virtualRouterScript(1),
            serviceBindings: { PEER: workerNames[0] },
            outboundService: "deny-outbound",
          },
          {
            name: "deny-outbound",
            modules: true,
            script:
              "export default { fetch() { return new Response(null, { status: 502 }); } };",
          },
        ],
        handleRuntimeStdio,
        handleStructuredLogs: structuredLogs,
      }),
    { destination },
  );
  await deadline(runtime.worker.ready, 20_000, "combined native ready");
  const [a, b] = instances;
  a.native = await runtime.worker.getWorker(workerNames[0]);
  b.native = await runtime.worker.getWorker(workerNames[1]);
  a.schema = await readSchema(
    runtime,
    schemaPath,
    unstable_splitSqlQuery,
    workerNames[0],
  );
  b.schema = await readSchema(
    runtime,
    schemaPath,
    unstable_splitSqlQuery,
    workerNames[1],
  );
  phases.push("two-native-workers-two-migrated-d1-kv-r2-queue-sets");
  phase = "api-owner-bootstrap";
  const ownerA = await ownerLogin(a);
  const ownerB = await ownerLogin(b);
  phases.push("one-mobile-password-owner-per-peer");
  phase = "private-peer-and-follow";
  await requestJson(
    b,
    "PUT",
    "/api/actors/me",
    b.token,
    { is_private: true },
    "B private profile update",
  );
  const privateRows = await rows(
    b.schema.db,
    "SELECT is_private FROM actors WHERE ap_id = ?",
    [b.ownerApId],
  );
  assert.equal(
    privateRows[0]?.is_private,
    1,
    "B private profile did not persist",
  );
  await requestJson(
    a,
    "POST",
    "/api/follow",
    a.token,
    { target_ap_id: b.ownerApId },
    "A follow B",
  );
  const pending = await poll("B pending Follow inbox/API", async () => {
    const body = await requestJson(
      b,
      "GET",
      "/api/follow/requests",
      b.token,
      undefined,
      "B pending follow requests",
    );
    return Array.isArray(body.requests) &&
      body.requests.some((item) => item.ap_id === a.ownerApId)
      ? body.requests
      : null;
  });
  assert.equal(pending.filter((item) => item.ap_id === a.ownerApId).length, 1);
  if (!denyUnsignedPeerKeyGet) {
    phase = "follow-digest-tamper-ledger-oracle";
    const tamper = await poll(
      "signed Follow digest tamper route event",
      async () =>
        routeEvents.find((item) => item.reason === "digest-tamper-refused"),
      5_000,
    );
    assert.equal(
      routeEvents.filter((item) => item.reason === "digest-tamper-refused")
        .length,
      1,
      "digest probe must run once",
    );
    assert.equal(tamper.router, routerNames[0]);
    assert.equal(tamper.targetHost, "b.yuru-native.invalid");
    assert.equal(tamper.headerHost, tamper.targetHost);
    assert.equal(tamper.method, "POST");
    assert.equal(tamper.activityType, "Follow");
    assert.equal(tamper.actorId, a.ownerApId);
    assert.equal(tamper.followTarget, b.ownerApId);
    assert.equal(tamper.status, 401);
    assert.equal(tamper.responseError, "Signature verification failed");
    assert.equal(tamper.headersPreserved, true);
    assert.equal(tamper.noInboundEffects, true);
    assert(
      Object.values(tamper.inboundCounts).every((count) => count === 0),
      "tampered Follow created receiver inbound state",
    );
    assert.equal(tamper.originalId, tamper.activityId);
    assert.equal(tamper.originalId.length, tamper.mutatedId.length);
    assert.notEqual(tamper.originalId, tamper.mutatedId);
    assert.notEqual(tamper.originalSha256, tamper.mutatedSha256);
    const originalForward = await poll(
      "untouched signed Follow accepted after digest refusal",
      async () => {
        const matches = routeEvents.filter(
          (item) =>
            item.router === routerNames[0] &&
            item.method === "POST" &&
            item.activityType === "Follow" &&
            item.activityId === tamper.originalId &&
            item.status === 202,
        );
        return matches.length ? matches : null;
      },
      10_000,
    );
    assert.equal(
      originalForward.length,
      1,
      "untouched signed Follow was not accepted after digest refusal",
    );
    const inboundActivityId = `${b.origin}/ap/activities/inbound-${sha256(
      Buffer.from(`${a.ownerApId}\0${tamper.originalId}`, "utf8"),
    )}`;
    const mutatedInboundActivityId = `${b.origin}/ap/activities/inbound-${sha256(
      Buffer.from(`${a.ownerApId}\0${tamper.mutatedId}`, "utf8"),
    )}`;
    const inboundFollows = await rows(
      b.schema.db,
      "SELECT ap_id, actor_ap_id, raw_json, processed FROM activities WHERE type = 'Follow' AND direction = 'inbound' AND actor_ap_id = ?",
      [a.ownerApId],
    );
    assert.equal(inboundFollows.length, 1);
    assert.equal(inboundFollows[0].ap_id, inboundActivityId);
    assert.equal(inboundFollows[0].actor_ap_id, a.ownerApId);
    assert.equal(inboundFollows[0].processed, 1);
    assert.equal(JSON.parse(inboundFollows[0].raw_json).id, tamper.originalId);
    const poisonedRows = await rows(
      b.schema.db,
      "SELECT ap_id FROM activities WHERE ap_id = ?",
      [mutatedInboundActivityId],
    );
    assert.equal(
      poisonedRows.length,
      0,
      "tampered wire ID poisoned the actor-scoped inbound ledger",
    );
    const followClaims = await rows(
      b.schema.db,
      "SELECT activity_ap_id FROM inbound_activity_claims WHERE activity_ap_id IN (?, ?)",
      [inboundActivityId, mutatedInboundActivityId],
    );
    assert.deepEqual(followClaims, [{ activity_ap_id: inboundActivityId }]);
    const pendingEdges = await rows(
      b.schema.db,
      "SELECT follower_ap_id, following_ap_id, status FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
      [a.ownerApId, b.ownerApId],
    );
    assert.deepEqual(pendingEdges, [
      {
        follower_ap_id: a.ownerApId,
        following_ap_id: b.ownerApId,
        status: "pending",
      },
    ]);
    digestTamperProof = {
      status: tamper.status,
      error: tamper.responseError,
      originalId: tamper.originalId,
      mutatedId: tamper.mutatedId,
      originalSha256: tamper.originalSha256,
      mutatedSha256: tamper.mutatedSha256,
      headersPreserved: tamper.headersPreserved,
      noInboundEffects: tamper.noInboundEffects,
      inboundCounts: tamper.inboundCounts,
      originalFollowStatus: originalForward[0].status,
      receiverActivityId: inboundActivityId,
      receiverProcessed: inboundFollows[0].processed,
      receiverRawJsonHasOriginalWireId: true,
      mutatedActivityCount: poisonedRows.length,
      pendingEdgeCount: pendingEdges.length,
    };
    phases.push("tampered-follow-digest-401-zero-effects-then-original-202");
  }
  phases.push("signed-follow-queue-to-private-peer-pending");
  phase = "accept-and-return-delivery";
  await requestJson(
    b,
    "POST",
    "/api/follow/accept",
    b.token,
    { requester_ap_id: a.ownerApId },
    "B accept A",
  );
  const accepted = await poll("both D1 follow edges accepted", async () => {
    const aRows = await rows(
      a.schema.db,
      "SELECT follower_ap_id, following_ap_id, status FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
      [a.ownerApId, b.ownerApId],
    );
    const bRows = await rows(
      b.schema.db,
      "SELECT follower_ap_id, following_ap_id, status FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
      [a.ownerApId, b.ownerApId],
    );
    return aRows.length === 1 &&
      bRows.length === 1 &&
      aRows[0].status === "accepted" &&
      bRows[0].status === "accepted"
      ? { a: aRows[0], b: bRows[0] }
      : null;
  });
  const ownerIsolation = await Promise.all([
    assertOwnerIsolation(a, b),
    assertOwnerIsolation(b, a),
  ]);
  const followers = await requestJson(
    b,
    "GET",
    `/api/actors/${encodeURIComponent(b.ownerApId)}/followers`,
    b.token,
    undefined,
    "B owner followers",
  );
  const following = await requestJson(
    a,
    "GET",
    `/api/actors/${encodeURIComponent(a.ownerApId)}/following`,
    a.token,
    undefined,
    "A owner following",
  );
  assert(
    Array.isArray(followers.followers) &&
      followers.followers.some((item) => item.ap_id === a.ownerApId),
    "B API followers missing A",
  );
  assert(
    Array.isArray(following.following) &&
      following.following.some((item) => item.ap_id === b.ownerApId),
    "A API following missing B",
  );
  const afterRequests = await requestJson(
    b,
    "GET",
    "/api/follow/requests",
    b.token,
    undefined,
    "B requests after accept",
  );
  assert(
    !afterRequests.requests?.some((item) => item.ap_id === a.ownerApId),
    "accepted request still pending",
  );
  const signedTraffic = routeEvents.filter(
    (item) =>
      item.method === "POST" &&
      /\/inbox$/.test(item.path) &&
      item.signaturePresent &&
      item.status >= 200 &&
      item.status < 300,
  );
  assert(
    signedTraffic.some(
      (item) =>
        item.router === routerNames[0] &&
        item.targetHost === "b.yuru-native.invalid" &&
        item.headerHost === item.targetHost,
    ),
    "no signed Follow reached B inbox through native router",
  );
  assert(
    signedTraffic.some(
      (item) =>
        item.router === routerNames[1] &&
        item.targetHost === "a.yuru-native.invalid" &&
        item.headerHost === item.targetHost,
    ),
    "no signed Accept reached A inbox through native router",
  );
  phases.push("accepted-on-both-native-d1-and-visible-through-owner-api");
  phase = "followers-post-and-private-read";
  const postText = `native-followers-${label}-${randomBytes(8).toString("hex")}`;
  const createdPost = await requestJson(
    b,
    "POST",
    "/api/posts",
    b.token,
    { content: postText, visibility: "followers" },
    "B followers post",
  );
  const postId = createdPost.post?.ap_id;
  assert(
    typeof postId === "string" && postId.startsWith(b.origin + "/ap/"),
    "B followers post AP ID missing",
  );
  assert.equal(createdPost.post.content, postText);
  assert.equal(createdPost.post.visibility, "followers");
  const postActivityId = await activityForObject(b, postId);
  phase = "followers-post-first-endpoint-failure";
  const firstFailure = await poll(
    "B followers Create first endpoint 503 and retry_wait",
    async () => {
      const fault = routeEvents.find(
        (item) => item.reason === "first-followers-create-503",
      );
      if (!fault) return null;
      const jobs = await rows(
        b.schema.db,
        "SELECT id, activity_ap_id, inbox_url, status, attempts, last_attempt_at, processing_started_at, next_attempt_at, delivered_at, error FROM delivery_queue WHERE activity_ap_id = ?",
        [postActivityId],
      );
      return jobs.length === 1 && jobs[0].status === "retry_wait"
        ? { fault, job: jobs[0], observedAtMs: Date.now() }
        : null;
    },
    30_000,
  );
  const faultEvents = routeEvents.filter(
    (item) => item.reason === "first-followers-create-503",
  );
  assert.equal(
    faultEvents.length,
    1,
    "router must inject exactly one followers Create 503",
  );
  assert.equal(firstFailure.fault.router, routerNames[1]);
  assert.equal(firstFailure.fault.targetHost, "a.yuru-native.invalid");
  assert.equal(firstFailure.fault.headerHost, firstFailure.fault.targetHost);
  assert.equal(firstFailure.fault.status, 503);
  assert.equal(firstFailure.fault.signaturePresent, true);
  assert.equal(firstFailure.fault.activityType, "Create");
  assert.equal(firstFailure.fault.actorId, b.ownerApId);
  assert.equal(firstFailure.fault.activityId, postActivityId);
  assert.equal(firstFailure.fault.objectId, postId);
  assert.equal(firstFailure.fault.followersOnlyAddressing, true);
  assert(
    Number.isSafeInteger(firstFailure.fault.atMs),
    "fault timestamp missing",
  );
  const firstJob = firstFailure.job;
  assert.equal(firstJob.activity_ap_id, postActivityId);
  assert.equal(firstJob.attempts, 1);
  assert.equal(firstJob.processing_started_at, null);
  assert.equal(firstJob.delivered_at, null);
  assert.equal(firstJob.error, "HTTP 503");
  assert.equal(new URL(firstJob.inbox_url).origin, a.origin);
  const lastAttemptMs = Date.parse(firstJob.last_attempt_at);
  const nextAttemptMs = Date.parse(firstJob.next_attempt_at);
  assert(
    Number.isFinite(lastAttemptMs) && Number.isFinite(nextAttemptMs),
    "retry timestamps missing",
  );
  const scheduledDelayMs = nextAttemptMs - lastAttemptMs;
  assert(
    scheduledDelayMs >= 47_000 && scheduledDelayMs <= 73_000,
    `first endpoint retry delay outside 60s +/-20%: ${scheduledDelayMs}ms`,
  );
  const remainingDelayMs = nextAttemptMs - firstFailure.observedAtMs;
  assert(
    remainingDelayMs > 0 && remainingDelayMs <= 73_000,
    `first endpoint retry was not pending in real time: ${remainingDelayMs}ms`,
  );
  assert(
    lastAttemptMs >= firstFailure.fault.atMs - 5_000,
    "retry ledger last_attempt_at predates router 503",
  );
  const firstCircuitRows = await rows(
    b.schema.db,
    "SELECT endpoint, state, consecutive_failures, recent_outcomes_json FROM delivery_circuit WHERE endpoint = ?",
    [firstJob.inbox_url],
  );
  assert.equal(firstCircuitRows.length, 1);
  assert.equal(firstCircuitRows[0].state, "closed");
  assert.equal(firstCircuitRows[0].consecutive_failures, 1);
  assert.equal(JSON.parse(firstCircuitRows[0].recent_outcomes_json).at(-1), 1);
  const firstRecipientJobs = await rows(
    b.schema.db,
    "SELECT delivery_job_id, recipient_actor_ap_id FROM delivery_endpoint_recipients WHERE delivery_job_id = ?",
    [firstJob.id],
  );
  assert.deepEqual(firstRecipientJobs, [
    { delivery_job_id: firstJob.id, recipient_actor_ap_id: a.ownerApId },
  ]);
  const absentBeforeRetry = await rows(
    a.schema.db,
    "SELECT ap_id FROM objects WHERE ap_id = ?",
    [postId],
  );
  assert.equal(
    absentBeforeRetry.length,
    0,
    "A received the followers Note before endpoint retry",
  );
  phases.push(
    "first-signed-followers-create-503-native-retry-wait-and-closed-circuit",
  );
  phase = "followers-post-native-delayed-retry";
  if (denyEndpointRetry) {
    phase = "endpoint-retry-denial-wait";
    const denied = await poll(
      "second signed followers Create denied after product retry delay",
      async () =>
        routeEvents.find(
          (item) =>
            item.reason === "fixture-deny-endpoint-retry" &&
            item.activityId === postActivityId &&
            item.objectId === postId,
        ),
      95_000,
    );
    assert.equal(denied.router, routerNames[1]);
    assert.equal(denied.targetHost, "a.yuru-native.invalid");
    assert.equal(denied.headerHost, denied.targetHost);
    assert.equal(denied.signaturePresent, true);
    assert.equal(denied.actorId, b.ownerApId);
    assert.equal(denied.followersOnlyAddressing, true);
    assert.equal(denied.status, 503);
    assert(
      denied.atMs >= nextAttemptMs - 2_000,
      "denied second POST preceded product next_attempt_at",
    );
    assert(
      denied.atMs <= nextAttemptMs + 15_000,
      "denied second POST arrived over 15 seconds after product next_attempt_at",
    );
    assert(
      denied.atMs - firstFailure.fault.atMs >= 45_000,
      "denied second POST did not wait for real delayed delivery",
    );
    const secondJob = await poll(
      "B second endpoint 503 persisted as retry_wait",
      async () => {
        const jobs = await rows(
          b.schema.db,
          "SELECT id, status, attempts, error FROM delivery_queue WHERE activity_ap_id = ?",
          [postActivityId],
        );
        return jobs.length === 1 &&
          jobs[0].status === "retry_wait" &&
          jobs[0].attempts === 2
          ? jobs[0]
          : null;
      },
      10_000,
    );
    assert.equal(secondJob.id, firstJob.id);
    assert.equal(secondJob.error, "HTTP 503");
    const deniedCircuit = await rows(
      b.schema.db,
      "SELECT state, consecutive_failures FROM delivery_circuit WHERE endpoint = ?",
      [firstJob.inbox_url],
    );
    assert.equal(deniedCircuit.length, 1);
    assert.equal(deniedCircuit[0].state, "closed");
    assert.equal(deniedCircuit[0].consecutive_failures, 2);
    const absentAfterDenial = await rows(
      a.schema.db,
      "SELECT ap_id FROM objects WHERE ap_id = ?",
      [postId],
    );
    assert.equal(absentAfterDenial.length, 0);
    deniedEndpointRetryObserved = true;
    phase = "endpoint-retry-denied";
    throw new Error("denial fixture blocked the real delayed endpoint retry");
  }
  const remotePost = await poll(
    "A received followers post",
    async () => {
      const found = await rows(
        a.schema.db,
        "SELECT ap_id, attributed_to, content, visibility, is_local FROM objects WHERE ap_id = ?",
        [postId],
      );
      return found.length === 1 ? found[0] : null;
    },
    100_000,
  );
  assert.equal(remotePost.attributed_to, b.ownerApId);
  assert.equal(remotePost.content, postText);
  assert.equal(remotePost.visibility, "followers");
  assert.equal(remotePost.is_local, 0);
  const postDelivery = await poll(
    "B followers post delivered",
    async () => {
      const found = await rows(
        b.schema.db,
        "SELECT status FROM delivery_queue WHERE activity_ap_id = ?",
        [postActivityId],
      );
      return found.some((item) => item.status === "delivered");
    },
    45_000,
  );
  assert(postDelivery);
  const postDeliveryProof = await deliveredTo(b, postActivityId, a.ownerApId);
  assert.equal(
    postDeliveryProof.attempts,
    1,
    "recovered endpoint job should retain one failed attempt",
  );
  assert.equal(postDeliveryProof.recipientApId, a.ownerApId);
  const finalPostJobs = await rows(
    b.schema.db,
    "SELECT id, activity_ap_id, inbox_url, status, attempts, last_attempt_at, processing_started_at, next_attempt_at, delivered_at, error FROM delivery_queue WHERE activity_ap_id = ?",
    [postActivityId],
  );
  assert.equal(
    finalPostJobs.length,
    1,
    "endpoint recovery created a second delivery job",
  );
  const finalPostJob = finalPostJobs[0];
  assert.equal(
    finalPostJob.id,
    firstJob.id,
    "endpoint retry changed job identity",
  );
  assert.equal(finalPostJob.inbox_url, firstJob.inbox_url);
  assert.equal(finalPostJob.status, "delivered");
  assert.equal(finalPostJob.attempts, 1);
  assert(
    finalPostJob.delivered_at,
    "recovered endpoint job missing delivered_at",
  );
  assert.equal(finalPostJob.error, null);
  assert.equal(finalPostJob.processing_started_at, null);
  const finalRecipientJobs = await rows(
    b.schema.db,
    "SELECT delivery_job_id, recipient_actor_ap_id FROM delivery_endpoint_recipients WHERE delivery_job_id = ?",
    [firstJob.id],
  );
  assert.deepEqual(finalRecipientJobs, firstRecipientJobs);
  const successfulCreates = routeEvents.filter(
    (item) =>
      item.router === routerNames[1] &&
      item.method === "POST" &&
      item.targetHost === "a.yuru-native.invalid" &&
      item.signaturePresent &&
      item.activityType === "Create" &&
      item.activityId === postActivityId &&
      item.objectId === postId &&
      item.status === 202,
  );
  assert.equal(
    successfulCreates.length,
    1,
    "native retry did not forward one unchanged signed Create for the same post",
  );
  assert.equal(successfulCreates[0].actorId, b.ownerApId);
  assert.equal(successfulCreates[0].followersOnlyAddressing, true);
  assert(
    successfulCreates[0].atMs >= nextAttemptMs - 2_000,
    "second signed POST preceded product next_attempt_at",
  );
  assert(
    successfulCreates[0].atMs <= nextAttemptMs + 15_000,
    "second signed POST arrived over 15 seconds after product next_attempt_at",
  );
  const actualRetryElapsedMs =
    successfulCreates[0].atMs - firstFailure.fault.atMs;
  assert(
    actualRetryElapsedMs >= 45_000,
    "second signed POST did not wait for real delayed delivery",
  );
  const finalCircuitRows = await rows(
    b.schema.db,
    "SELECT endpoint, state, consecutive_failures, recent_outcomes_json FROM delivery_circuit WHERE endpoint = ?",
    [firstJob.inbox_url],
  );
  assert.equal(finalCircuitRows.length, 1);
  assert.equal(finalCircuitRows[0].state, "closed");
  assert.equal(finalCircuitRows[0].consecutive_failures, 0);
  assert.equal(JSON.parse(finalCircuitRows[0].recent_outcomes_json).at(-1), 0);
  phases.push(
    "same-endpoint-job-delivered-by-native-delayed-retry-and-circuit-reset",
  );
  const postRows = await rows(
    a.schema.db,
    "SELECT ap_id FROM objects WHERE ap_id = ?",
    [postId],
  );
  assert.equal(postRows.length, 1, "A received duplicate followers Note");
  const sourcePostRows = await rows(
    b.schema.db,
    "SELECT ap_id, attributed_to, content, visibility, is_local FROM objects WHERE ap_id = ?",
    [postId],
  );
  assert.equal(
    sourcePostRows.length,
    1,
    "B source followers Note must be unique",
  );
  assert.equal(sourcePostRows[0].attributed_to, b.ownerApId);
  assert.equal(sourcePostRows[0].content, postText);
  assert.equal(sourcePostRows[0].visibility, "followers");
  assert.equal(sourcePostRows[0].is_local, 1);
  const followingFeed = await poll(
    "A following feed with B followers post",
    async () => {
      const body = await requestJson(
        a,
        "GET",
        "/api/timeline/following",
        a.token,
        undefined,
        "A following feed with B followers post",
      );
      return body.posts?.some(
        (item) => item.ap_id === postId && item.content === postText,
      )
        ? body
        : null;
    },
    30_000,
  );
  assert.equal(
    followingFeed.posts?.filter(
      (item) => item.ap_id === postId && item.content === postText,
    ).length,
    1,
    "A following feed must contain exactly one B followers post",
  );
  const postDetail = await requestJson(
    a,
    "GET",
    `/api/posts/${encodeURIComponent(postId)}`,
    a.token,
    undefined,
    "A allowed followers post detail",
  );
  assert.equal(postDetail.post?.ap_id, postId);
  assert.equal(postDetail.post?.content, postText);
  const anonymousPost = await requestJson(
    a,
    "GET",
    `/api/posts/${encodeURIComponent(postId)}`,
    null,
    undefined,
    "anonymous followers post denied",
    404,
  );
  assert.deepEqual(Object.keys(anonymousPost), ["error"]);
  assert(
    !JSON.stringify(anonymousPost).includes(postText),
    "anonymous post denial leaked content",
  );
  phases.push("followers-post-delivered-once-and-read-gated");
  phase = "direct-message-and-private-read";
  const dmText = `native-direct-${label}-${randomBytes(8).toString("hex")}`;
  const dmPathB = `/api/dm/user/${encodeURIComponent(a.ownerApId)}/messages`;
  const dmPathA = `/api/dm/user/${encodeURIComponent(b.ownerApId)}/messages`;
  const createdDm = await requestJson(
    b,
    "POST",
    dmPathB,
    b.token,
    { content: dmText },
    "B direct message to A",
    201,
  );
  const dmId = createdDm.message?.id;
  assert(
    typeof dmId === "string" && dmId.startsWith(b.origin + "/ap/"),
    "B direct message AP ID missing",
  );
  assert.equal(createdDm.message.content, dmText);
  assert.equal(createdDm.message.sender?.ap_id, b.ownerApId);
  assert(
    typeof createdDm.conversation_id === "string" &&
      createdDm.conversation_id.startsWith(b.origin + "/ap/conversations/"),
  );
  const dmActivityId = await activityForObject(b, dmId);
  const recipientDm = await poll(
    "A received direct message",
    async () => {
      const found = await rows(
        a.schema.db,
        "SELECT ap_id, attributed_to, content, visibility, conversation, is_local, to_json FROM objects WHERE ap_id = ?",
        [dmId],
      );
      return found.length === 1 ? found[0] : null;
    },
    45_000,
  );
  assert.equal(recipientDm.attributed_to, b.ownerApId);
  assert.equal(recipientDm.content, dmText);
  assert.equal(recipientDm.visibility, "direct");
  assert.equal(recipientDm.is_local, 0);
  assert.deepEqual(JSON.parse(recipientDm.to_json), [a.ownerApId]);
  const sourceDmRows = await rows(
    b.schema.db,
    "SELECT ap_id, attributed_to, content, visibility, is_local, to_json FROM objects WHERE ap_id = ?",
    [dmId],
  );
  assert.equal(sourceDmRows.length, 1, "B source direct Note must be unique");
  assert.equal(sourceDmRows[0].attributed_to, b.ownerApId);
  assert.equal(sourceDmRows[0].content, dmText);
  assert.equal(sourceDmRows[0].visibility, "direct");
  assert.equal(sourceDmRows[0].is_local, 1);
  assert.deepEqual(JSON.parse(sourceDmRows[0].to_json), [a.ownerApId]);
  const dmDelivery = await poll(
    "B direct message delivered",
    async () => {
      const found = await rows(
        b.schema.db,
        "SELECT status FROM delivery_queue WHERE activity_ap_id = ?",
        [dmActivityId],
      );
      return found.some((item) => item.status === "delivered");
    },
    45_000,
  );
  assert(dmDelivery);
  const dmDeliveryProof = await deliveredTo(b, dmActivityId, a.ownerApId);
  // Receiver-local ledger identity is actor-scoped; raw_json retains the wire
  // source ID. Never expect a remote string to be a local activity primary key.
  const recipientActivityId = `${a.origin}/ap/activities/inbound-${sha256(Buffer.from(`${b.ownerApId}\0${dmActivityId}`, "utf8"))}`;
  await poll(
    "A direct message recipient and inbox projection",
    async () => {
      const recipient = await rows(
        a.schema.db,
        "SELECT recipient_ap_id FROM object_recipients WHERE object_ap_id = ?",
        [dmId],
      );
      const activity = await rows(
        a.schema.db,
        "SELECT ap_id FROM activities WHERE ap_id = ?",
        [recipientActivityId],
      );
      const inbox = await rows(
        a.schema.db,
        "SELECT activity_ap_id FROM inbox WHERE activity_ap_id = ?",
        [recipientActivityId],
      );
      return (
        recipient.length === 1 && activity.length === 1 && inbox.length === 1
      );
    },
    30_000,
  );
  const recipientProjection = await rows(
    a.schema.db,
    "SELECT recipient_ap_id, type FROM object_recipients WHERE object_ap_id = ?",
    [dmId],
  );
  assert.deepEqual(recipientProjection, [
    { recipient_ap_id: a.ownerApId, type: "to" },
  ]);
  const inboundDmActivity = await rows(
    a.schema.db,
    "SELECT ap_id, actor_ap_id, object_ap_id, type, raw_json, direction, processed FROM activities WHERE ap_id = ? AND type = 'Create'",
    [recipientActivityId],
  );
  assert.equal(inboundDmActivity.length, 1);
  assert.equal(inboundDmActivity[0].actor_ap_id, b.ownerApId);
  assert.equal(inboundDmActivity[0].object_ap_id, dmId);
  assert.equal(inboundDmActivity[0].ap_id, recipientActivityId);
  assert.equal(inboundDmActivity[0].direction, "inbound");
  assert.equal(inboundDmActivity[0].processed, 1);
  const retainedDmEnvelope = JSON.parse(inboundDmActivity[0].raw_json);
  assert.equal(retainedDmEnvelope.id, dmActivityId);
  assert.equal(retainedDmEnvelope.actor, b.ownerApId);
  assert.equal(retainedDmEnvelope.object?.id, dmId);
  const inboxRows = await rows(
    a.schema.db,
    "SELECT actor_ap_id, activity_ap_id FROM inbox WHERE activity_ap_id = ?",
    [recipientActivityId],
  );
  assert.deepEqual(inboxRows, [
    { actor_ap_id: a.ownerApId, activity_ap_id: recipientActivityId },
  ]);
  const receivedDm = await requestJson(
    a,
    "GET",
    dmPathA,
    a.token,
    undefined,
    "A recipient direct messages",
  );
  assert.equal(
    receivedDm.messages?.filter(
      (item) =>
        item.id === dmId &&
        item.content === dmText &&
        item.sender?.ap_id === b.ownerApId,
    ).length,
    1,
    "A recipient DM API must contain exactly one B message",
  );
  assert.equal(receivedDm.conversation_id, recipientDm.conversation);
  const sentDm = await requestJson(
    b,
    "GET",
    dmPathB,
    b.token,
    undefined,
    "B sender direct messages",
  );
  assert.equal(
    sentDm.messages?.filter(
      (item) => item.id === dmId && item.content === dmText,
    ).length,
    1,
  );
  assert.equal(sentDm.conversation_id, createdDm.conversation_id);
  const anonymousDm = await requestJson(
    a,
    "GET",
    dmPathA,
    null,
    undefined,
    "anonymous DM thread denied",
    401,
  );
  assert.deepEqual(Object.keys(anonymousDm), ["error"]);
  assert(
    !JSON.stringify(anonymousDm).includes(dmText),
    "anonymous DM denial leaked content",
  );
  const anonymousDmObject = await requestJson(
    a,
    "GET",
    `/api/posts/${encodeURIComponent(dmId)}`,
    null,
    undefined,
    "anonymous DM object denied",
    404,
  );
  assert.deepEqual(Object.keys(anonymousDmObject), ["error"]);
  assert(
    !JSON.stringify(anonymousDmObject).includes(dmText),
    "anonymous DM object denial leaked content",
  );
  phases.push(
    "direct-message-delivered-once-with-recipient-and-inbox-read-gates",
  );
  const finalOwnerIsolation = await Promise.all([
    assertOwnerIsolation(a, b),
    assertOwnerIsolation(b, a),
  ]);
  const extendedSignedTraffic = routeEvents.filter(
    (item) =>
      item.method === "POST" &&
      /\/inbox$/.test(item.path) &&
      item.signaturePresent &&
      item.status >= 200 &&
      item.status < 300,
  );
  for (const activityId of [postActivityId, dmActivityId]) {
    assert(
      extendedSignedTraffic.some(
        (item) =>
          item.router === routerNames[1] &&
          item.targetHost === "a.yuru-native.invalid" &&
          item.headerHost === item.targetHost &&
          item.activityId === activityId &&
          item.activityType === "Create",
      ),
      `A lacks signed Create inbox delivery for ${activityId}`,
    );
  }
  assert(
    !denyUnsignedPeerKeyGet,
    "denial fixture unexpectedly allowed the full federation journey",
  );
  assert(
    !denyEndpointRetry,
    "endpoint retry denial fixture unexpectedly allowed the full federation journey",
  );
  finalRecord = {
    status: "PASSED",
    kind: "yurucommu.release-federation-smoke@v1",
    scope: "same-product",
    fixture: {
      denyUnsignedPeerKeyGet,
      denyEndpointRetry,
      endpointRetryFaultObserved: faultEvents.length === 1,
      digestTamperProbeEnabled: !denyUnsignedPeerKeyGet,
    },
    artifact: {
      name: basename(artifactPath),
      sha256: `sha256:${artifactHash}`,
    },
    schema: {
      name: basename(schemaPath),
      sha256: `sha256:${schemaHash}`,
      migrations: a.schema.entries,
    },
    runtime: "workerd",
    compatibilityDate: config.compatibility_date,
    versions: { product: productVersion, apiBinding: apiBindingVersion },
    instances: {
      count: 2,
      independentBindings: ["D1", "KV", "R2", "delivery-queue", "delivery-dlq"],
      apiCreatedOwners: [ownerA.ownerCount, ownerB.ownerCount],
    },
    results: {
      privateFollowPending: pending.length === 1,
      followAcceptedBothD1:
        accepted.a.status === "accepted" && accepted.b.status === "accepted",
      ownerIsolation:
        ownerIsolation.every((item) => item.remoteCached) &&
        finalOwnerIsolation.every((item) => item.remoteCached),
      followersPostDeliveredOnce:
        postDeliveryProof.status === "delivered" && postRows.length === 1,
      followersPostReadGated:
        Boolean(anonymousPost) && postDetail.post?.ap_id === postId,
      directMessageDeliveredOnce:
        dmDeliveryProof.status === "delivered" &&
        inboundDmActivity.length === 1 &&
        inboxRows.length === 1,
      directMessageReadGated:
        Boolean(anonymousDm && anonymousDmObject) &&
        receivedDm.conversation_id === recipientDm.conversation,
      signedInboxDeliveries: extendedSignedTraffic.length,
      endpointRetryRecovered:
        finalPostJob.id === firstJob.id &&
        finalPostJob.attempts === 1 &&
        finalPostJob.error === null &&
        finalCircuitRows[0].consecutive_failures === 0 &&
        successfulCreates.length === 1,
      digestTamperRefused: digestTamperProof?.status === 401,
      digestTamperNoInboundEffects:
        digestTamperProof?.noInboundEffects === true,
      originalFollowAcceptedAfterTamper:
        digestTamperProof?.originalFollowStatus === 202,
    },
    digestTamper: digestTamperProof,
    endpointRetry: {
      firstFailure: {
        status: firstFailure.fault.status,
        atMs: firstFailure.fault.atMs,
        activityId: firstFailure.fault.activityId,
        objectId: firstFailure.fault.objectId,
        actorId: firstFailure.fault.actorId,
        followersOnlyAddressing: firstFailure.fault.followersOnlyAddressing,
      },
      firstJob: {
        id: firstJob.id,
        status: firstJob.status,
        attempts: firstJob.attempts,
        lastAttemptAt: firstJob.last_attempt_at,
        nextAttemptAt: firstJob.next_attempt_at,
        scheduledDelayMs,
        remainingDelayMs,
        processingStartedAt: firstJob.processing_started_at,
        recipientObjectCount: absentBeforeRetry.length,
        circuit: {
          state: firstCircuitRows[0].state,
          consecutiveFailures: firstCircuitRows[0].consecutive_failures,
        },
      },
      recovered: {
        sameJobId: finalPostJob.id === firstJob.id,
        status: finalPostJob.status,
        attempts: finalPostJob.attempts,
        deliveredAt: finalPostJob.delivered_at,
        error: finalPostJob.error,
        secondSignedPostStatus: successfulCreates[0].status,
        secondSignedPostAtMs: successfulCreates[0].atMs,
        actualRetryElapsedMs,
        circuit: {
          state: finalCircuitRows[0].state,
          consecutiveFailures: finalCircuitRows[0].consecutive_failures,
        },
      },
    },
    phases,
    boundary:
      "Two independent instances of one unchanged Yurucommu Worker artifact in one workerd, with separate migrated D1/KV/R2/queues and API-created owners. Exact peer HTTPS origins and public DNS answers are virtualized by in-workerd routers. Core SSRF and HTTP signature checks remain active. Public DNS/TLS and live federation are outside this smoke.",
  };
} catch (error) {
  mainError = error;
} finally {
  const cleanupErrors = [];
  const cleanup = { runtimeDisposed: false, temporaryStateRemoved: false };
  if (runtime) {
    try {
      await deadline(runtime.dispose(), 12_000, "combined dispose");
      cleanup.runtimeDisposed = true;
    } catch (error) {
      cleanupErrors.push(
        `combined dispose: ${redact(error?.message ?? error)}`,
      );
    }
  }
  if (tempRoot && (!runtime || cleanup.runtimeDisposed)) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      cleanup.temporaryStateRemoved = true;
    } catch (error) {
      cleanupErrors.push(
        `temporary state cleanup: ${redact(error?.message ?? error)}`,
      );
    }
  } else if (tempRoot) {
    cleanupErrors.push(
      "temporary state retained because runtime disposal did not complete",
    );
  }
  if (mainError || cleanupErrors.length > 0) {
    finalRecord = {
      status: "FAILED",
      kind: "yurucommu.release-federation-smoke@v1",
      scope: "same-product",
      fixture: {
        denyUnsignedPeerKeyGet,
        denyEndpointRetry,
        deniedEndpointRetryObserved,
        endpointRetryFaultObserved: routeEvents.some(
          (event) => event.reason === "first-followers-create-503",
        ),
        digestTamperProbeEnabled: !denyUnsignedPeerKeyGet,
        digestTamperObserved: routeEvents.some(
          (event) => event.reason === "digest-tamper-refused",
        ),
      },
      digestTamper:
        digestTamperProof ??
        routeEvents.find((event) => event.reason === "digest-tamper-refused") ??
        null,
      phase,
      error: mainError
        ? redact(mainError?.message ?? mainError)
        : "native cleanup failed",
      cleanupErrors,
      phases,
      apiStatuses: apiStatuses.slice(-24),
      deniedUnsignedPeerKeyGetObserved: routeEvents.some(
        (event) => event.reason === "fixture-deny-unsigned-peer-key-get",
      ),
    };
  }
  finalRecord.cleanup = cleanup;
  finalRecord.diagnostics = safeDiagnostics();
  // The supervisor publishes buffered stdout only after exit 0. Preserve
  // failed journey and denial-fixture evidence on its streamed stderr channel.
  const output =
    finalRecord.status === "PASSED" ? process.stdout : process.stderr;
  output.write(JSON.stringify(finalRecord) + "\n");
}
if (finalRecord.status !== "PASSED") process.exitCode = 1;
