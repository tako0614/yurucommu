import assert from "node:assert/strict";
import { createHash, createSign, createVerify, randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { unstable_readConfig, unstable_splitSqlQuery } from "wrangler";
import { createManagedNativeRuntime } from "./native-runtime-stdio.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(
  root,
  "deploy/takoform/migrations/schema-bundle.json",
);
const configPath = resolve(root, "wrangler.jsonc");
const args = process.argv.slice(2);
const denyPeerKeyFetch = args.includes("--deny-peer-key-fetch");
const artifactArgs = args.filter((arg) => !arg.startsWith("-"));
const argumentError =
  args.some((arg) => arg.startsWith("-") && arg !== "--deny-peer-key-fetch") ||
  artifactArgs.length > 1 ||
  args.filter((arg) => arg === "--deny-peer-key-fetch").length > 1;
const artifact = resolve(root, artifactArgs[0] ?? "dist/yurucommu-worker.js");
const label = randomBytes(6).toString("hex");
const names = ["A", "C", "B"];
const origins = Object.fromEntries(
  names.map((name) => [
    name,
    `https://${name.toLowerCase()}.yuru-foreign-native.invalid`,
  ]),
);
const dns = Object.fromEntries(
  names.map((name, index) => [
    `${name.toLowerCase()}.yuru-foreign-native.invalid`,
    `93.184.216.${34 + index}`,
  ]),
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const phases = [];
const routes = [];
const secrets = [];
let phase = "preflight";
let runtime;
let tempRoot;
let finalRecord;
let primaryError;
let runtimeLogBytes = 0;
const instances = {};

function redact(input) {
  let text = String(input);
  for (const [value, replacement] of [
    [artifact, "[artifact]"],
    [schemaPath, "[schema]"],
    [tempRoot, "[temporary state]"],
    [root, "[repo]"],
  ])
    if (value) text = text.split(value).join(replacement);
  for (const secret of secrets)
    if (secret) text = text.split(secret).join("[redacted]");
  return text
    .replace(
      /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g,
      "[redacted private key]",
    )
    .slice(-1000);
}
function deadline(task, ms, name) {
  let timer;
  return Promise.race([
    Promise.resolve(task),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${name}: ${ms}ms deadline`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function poll(name, predicate, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() <= end) {
    const value = await deadline(predicate(), 8_000, name);
    if (value) return value;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw Error(`${name}: ${ms}ms deadline`);
}
function collect(chunk) {
  runtimeLogBytes += chunk.length;
  for (const line of chunk.toString("utf8").split("\n")) {
    const pos = line.indexOf("foreign-wire-route ");
    if (pos < 0) continue;
    try {
      const event = JSON.parse(line.slice(pos + "foreign-wire-route ".length));
      if (
        routes.length < 60 &&
        ["A", "C", "B"].includes(event.from) &&
        (["A", "C", "B"].includes(event.to) ||
          (event.kind === "refused-route" && event.to === null))
      )
        routes.push({
          from: event.from,
          to: event.to,
          method: event.method,
          kind: event.kind,
          status: event.status,
          wireId: event.wireId ?? null,
          actor: event.actor ?? null,
          hostMatches: event.hostMatches === true,
          signaturePresent: event.signaturePresent === true,
          originalRequestPreserved: event.originalRequestPreserved === true,
        });
    } catch {
      /* diagnostics are optional */
    }
  }
}
async function rows(db, sql, binds = []) {
  const result = await deadline(
    db
      .prepare(sql)
      .bind(...binds)
      .all(),
    8_000,
    "D1 read",
  );
  return result.results ?? [];
}
async function receiverCounts(db) {
  return Object.fromEntries(
    await Promise.all(
      [
        [
          "activities",
          "SELECT COUNT(*) AS count FROM activities WHERE direction='inbound' AND type='Follow'",
        ],
        ["claims", "SELECT COUNT(*) AS count FROM inbound_activity_claims"],
        ["inbox", "SELECT COUNT(*) AS count FROM inbox"],
        [
          "pendingEdges",
          "SELECT COUNT(*) AS count FROM follows WHERE status='pending'",
        ],
      ].map(async ([name, sql]) => [name, (await rows(db, sql))[0]?.count]),
    ),
  );
}
async function requestJson(
  instance,
  method,
  path,
  token,
  body,
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
    `${instance.name} ${method} ${path}`,
  );
  const text = await deadline(response.text(), 8_000, "API response body");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw Error(
      `${instance.name} ${method} ${path}: non-JSON HTTP ${response.status}`,
    );
  }
  assert.equal(
    response.status,
    expected,
    `${instance.name} ${method} ${path}: HTTP ${response.status} ${redact(result?.error ?? "")}`,
  );
  return result;
}
async function schemaFor(db) {
  const bytes = await readFile(schemaPath);
  const schema = JSON.parse(bytes.toString("utf8"));
  assert.equal(schema.apiVersion, "takosumi.resource-migrations/v1");
  assert.equal(schema.engine, "sqlite");
  assert(Array.isArray(schema.entries) && schema.entries.length > 0);
  for (const entry of schema.entries) {
    assert.equal(
      entry.sha256,
      `sha256:${sha256(Buffer.from(entry.sql, "utf8"))}`,
    );
    const statements = unstable_splitSqlQuery(entry.sql);
    assert(statements.length > 0, `empty migration ${entry.name}`);
    await deadline(
      db.batch(statements.map((statement) => db.prepare(statement))),
      20_000,
      `migration ${entry.name}`,
    );
  }
  assert.equal(
    (await rows(db, "SELECT COUNT(*) AS count FROM actors"))[0]?.count,
    0,
  );
  assert.equal(
    (await rows(db, "SELECT COUNT(*) AS count FROM sessions"))[0]?.count,
    0,
  );
  return { sha256: sha256(bytes), entries: schema.entries.length };
}
function settings(name, config) {
  const password = randomBytes(32).toString("base64url");
  const key = randomBytes(32).toString("hex");
  const salt = randomBytes(24).toString("base64url");
  secrets.push(password, key, salt);
  const queue = `foreign-${label}-${name.toLowerCase()}-delivery`;
  const dlq = `foreign-${label}-${name.toLowerCase()}-dlq`;
  const instance = { name, origin: origins[name], password };
  instances[name] = instance;
  return {
    name: `peer-${name.toLowerCase()}`,
    modules: [{ type: "ESModule", path: artifact }],
    modulesRoot: dirname(artifact),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: {
      APP_URL: origins[name],
      AUTH_PASSWORD_HASH: password,
      YURUCOMMU_SESSION_HASH_SALT: salt,
      ENCRYPTION_KEY: key,
      DELIVERY_QUEUE_NAME: queue,
      DELIVERY_DLQ_NAME: dlq,
    },
    d1Databases: { DB: `foreign-${label}-${name.toLowerCase()}-db` },
    kvNamespaces: { KV: `foreign-${label}-${name.toLowerCase()}-kv` },
    r2Buckets: { MEDIA: `foreign-${label}-${name.toLowerCase()}-media` },
    queueProducers: { DELIVERY_QUEUE: queue, DELIVERY_DLQ: dlq },
    queueConsumers: {
      [queue]: {
        maxBatchSize: 1,
        maxBatchTimeout: 0,
        maxRetries: 1,
        retryDelay: 0,
        deadLetterQueue: dlq,
      },
    },
    outboundService: `route-${name.toLowerCase()}`,
  };
}
function routerScript(from) {
  const destinations = Object.fromEntries(
    names.filter((name) => name !== from).map((name) => [origins[name], name]),
  );
  return `const from = ${JSON.stringify(from)};
const destinations = ${JSON.stringify(destinations)};
const dns = ${JSON.stringify(dns)};
let held = null;
let released = false;
async function hashBody(request) {
  const body = await request.clone().text();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
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
    if (url.origin === 'http://fixture.local' && request.method === 'GET' && url.pathname === '/__status')
      return Response.json({ held: held ? { wireId: held.wireId, actor: held.actor, target: held.target, inboxUrl: held.inboxUrl, rawSha256: held.rawSha256 } : null });
    if (url.origin === 'http://fixture.local' && request.method === 'POST' && url.pathname === '/__release' && from === 'C') {
      if (!held || released) return new Response(null, { status: 409 });
      released = true;
      return Response.json({ released: true });
    }
    let fixtureProof = null;
    if (url.origin === 'http://fixture.local' && request.method === 'POST' && url.pathname === '/__send-signed-follow' && from === 'A') {
      const input = await request.json().catch(() => null);
      const activity = typeof input?.exactBody === 'string' ? JSON.parse(input.exactBody) : null;
      const inbox = typeof input?.inboxUrl === 'string' ? new URL(input.inboxUrl) : null;
      const headerNames = ['content-length', 'content-type', 'date', 'digest', 'host', 'signature'];
      if (!activity || !inbox || !input.headers || Object.keys(input.headers).sort().join(',') !== headerNames.join(',')
        || inbox.origin !== ${JSON.stringify(origins.B)} || inbox.search || inbox.hash || inbox.username || inbox.password || inbox.port
        || inbox.href !== input.expectedInboxUrl
        || !(inbox.pathname === '/ap/inbox' || inbox.href === input.expectedTarget + '/inbox')
        || activity['@context'] !== 'https://www.w3.org/ns/activitystreams' || activity.type !== 'Follow'
        || typeof activity.actor !== 'string' || !/^https:\\/\\/a\\.yuru-foreign-native\\.invalid\\/ap\\/users\\/[^/]+$/.test(activity.actor)
        || activity.actor !== input.expectedActor
        || typeof activity.id !== 'string' || !/^https:\\/\\/c\\.yuru-foreign-native\\.invalid\\/ap\\/activities\\/[^/]+$/.test(activity.id)
        || activity.id !== input.expectedWireId
        || typeof input.expectedTarget !== 'string' || !/^https:\\/\\/b\\.yuru-foreign-native\\.invalid\\/ap\\/users\\/[^/]+$/.test(input.expectedTarget)
        || typeof activity.object !== 'string'
        || activity.object !== input.expectedTarget
        || typeof input.publicKeyPem !== 'string' || !input.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')
        || input.headers.host !== inbox.host || input.headers['content-type'] !== 'application/activity+json')
        return new Response(null, { status: 422 });
      request = new Request(inbox.href, { method: 'POST', headers: new Headers(input.headers), body: input.exactBody });
      const body = await request.clone().text();
      const bytes = new TextEncoder().encode(body);
      const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const digest = 'SHA-256=' + btoa(String.fromCharCode(...digestBytes));
      const signatureHeader = request.headers.get('signature');
      const signature = /^keyId="([^"]+)",algorithm="rsa-sha256",headers="\\(request-target\\) host date digest",signature="([A-Za-z0-9+/=]+)"$/.exec(signatureHeader || '');
      const date = request.headers.get('date');
      const signingInput = '(request-target): post ' + inbox.pathname + '\\nhost: ' + inbox.host + '\\ndate: ' + date + '\\ndigest: ' + digest;
      const pem = input.publicKeyPem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\\s/g, '');
      const publicKey = await crypto.subtle.importKey('spki', Uint8Array.from(atob(pem), (char) => char.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const verified = signature && await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Uint8Array.from(atob(signature[2]), (char) => char.charCodeAt(0)), new TextEncoder().encode(signingInput));
      if (request.url !== inbox.href || request.method !== 'POST' || body !== input.exactBody
        || request.headers.get('host') !== inbox.host || request.headers.get('date') !== input.headers.date
        || request.headers.get('digest') !== input.headers.digest || request.headers.get('digest') !== digest
        || request.headers.get('signature') !== input.headers.signature || request.headers.get('content-type') !== input.headers['content-type']
        || request.headers.get('content-length') !== String(bytes.length) || input.headers['content-length'] !== String(bytes.length)
        || signature?.[1] !== activity.actor + '#main-key' || !verified)
        return new Response(null, { status: 422 });
      fixtureProof = { exactForwardedRequestVerified: true, exactForwardedSignatureVerified: true, bodySha256: await hashBody(request) };
    }
    const outboundUrl = new URL(request.url);
    const to = destinations[outboundUrl.origin];
    if (!to || outboundUrl.protocol !== 'https:' || outboundUrl.username || outboundUrl.password || outboundUrl.port) {
      console.log('foreign-wire-route', JSON.stringify({ from, to: to ?? null, method: request.method, kind: 'refused-route', status: 502 }));
      return new Response(null, { status: 502 });
    }
    const signed = request.headers.has('signature') || request.headers.has('authorization');
    const host = request.headers.get('host');
    const hostMatches = host?.toLowerCase() === outboundUrl.host.toLowerCase();
    if ((signed || host !== null) && !hostMatches) {
      console.log('foreign-wire-route', JSON.stringify({ from, to, method: request.method, kind: 'refused-host', status: 502, hostMatches, signaturePresent: signed }));
      return new Response(null, { status: 502 });
    }
    if (${denyPeerKeyFetch} && from === 'B' && to === 'C' && request.method === 'GET'
      && /^\\/ap\\/users\\/[^/]+$/.test(outboundUrl.pathname)) {
      console.log('foreign-wire-route', JSON.stringify({ from, to, method: 'GET', kind: 'denied-peer-key', status: 502, hostMatches, signaturePresent: signed }));
      return new Response(null, { status: 502 });
    }
    const target = env['PEER_' + to];
    if (!target) {
      console.log('foreign-wire-route', JSON.stringify({ from, to, method: request.method, kind: 'refused-binding', status: 502, hostMatches, signaturePresent: signed }));
      return new Response(null, { status: 502 });
    }
    let wireId = null, actor = null, originalRequestPreserved = false;
    if (request.method === 'POST' && outboundUrl.pathname.endsWith('/inbox')) {
      const activity = await request.clone().json().catch(() => null);
      wireId = typeof activity?.id === 'string' ? activity.id : null;
      actor = typeof activity?.actor === 'string' ? activity.actor : null;
      if (from === 'C' && to === 'B' && activity?.type === 'Follow'
        && actor?.startsWith(${JSON.stringify(origins.C + "/ap/users/")})
        && activity?.object?.startsWith(${JSON.stringify(origins.B + "/ap/users/")})
        && signed) {
        const requestUrl = request.url;
        const rawSha256 = await hashBody(request);
        const retainedHeaders = Object.fromEntries(['host', 'date', 'digest', 'signature', 'content-length'].map((name) => [name, request.headers.get(name)]));
        if (held) return new Response(null, { status: 409 });
        held = { wireId, actor, target: activity.object, inboxUrl: requestUrl, rawSha256 };
        console.log('foreign-wire-route', JSON.stringify({ from, to, method: 'POST', kind: 'held-follow', status: 0, wireId, actor, hostMatches, signaturePresent: signed }));
        const holdStartedAt = Date.now();
        while (!released) {
          if (Date.now() - holdStartedAt >= 6_000) return new Response(null, { status: 504 });
          await new Promise((done) => setTimeout(done, 10));
        }
        originalRequestPreserved = request.url === requestUrl && await hashBody(request) === rawSha256
          && Object.entries(retainedHeaders).every(([name, value]) => request.headers.get(name) === value);
        if (!originalRequestPreserved) return new Response(null, { status: 502 });
      }
    }
    const response = await target.fetch(request);
    if (request.method === 'POST' && outboundUrl.pathname.endsWith('/inbox'))
      console.log('foreign-wire-route', JSON.stringify({ from, to, method: 'POST', kind: from === 'C' && to === 'B' ? 'released-follow' : 'signed-follow', status: response.status, wireId, actor, hostMatches, signaturePresent: signed, originalRequestPreserved }));
    return fixtureProof ? Response.json({ status: response.status, ...fixtureProof }) : response;
  }
};`;
}
function normalizedActor(value) {
  const url = new URL(value);
  url.hash = "";
  let result = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  if (result.endsWith("/")) result = result.slice(0, -1);
  return result;
}
function internalId(base, actor, source) {
  return `${base}/ap/activities/inbound-${sha256(`${normalizedActor(actor)}\0${source}`)}`;
}
function signedString(method, url, date, digest) {
  return `(request-target): ${method.toLowerCase()} ${url.pathname}${url.search}\nhost: ${url.host}\ndate: ${date}\ndigest: ${digest}`;
}
function pemSign(privateKey, input) {
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return signer.sign(privateKey).toString("base64");
}
function pemVerify(publicKey, input, signature) {
  const verifier = createVerify("RSA-SHA256");
  verifier.update(input);
  verifier.end();
  return verifier.verify(publicKey, signature, "base64");
}
function safeProjection(row) {
  return {
    id: row.ap_id,
    actor: row.actor_ap_id,
    type: row.type,
    processed: row.processed,
    rawId: JSON.parse(row.raw_json).id,
    rawActor: JSON.parse(row.raw_json).actor,
    rawSha256: sha256(row.raw_json),
  };
}
async function projection(db, id, actor, target) {
  const activity = await rows(
    db,
    "SELECT ap_id, actor_ap_id, type, processed, raw_json FROM activities WHERE ap_id = ?",
    [id],
  );
  const claim = await rows(
    db,
    "SELECT activity_ap_id, processing_token, lease_expires_at FROM inbound_activity_claims WHERE activity_ap_id = ?",
    [id],
  );
  const inbox = await rows(
    db,
    "SELECT actor_ap_id, activity_ap_id, read FROM inbox WHERE activity_ap_id = ?",
    [id],
  );
  const follow = await rows(
    db,
    "SELECT follower_ap_id, following_ap_id, status, activity_ap_id FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
    [actor, target],
  );
  return { activity: activity.map(safeProjection), claim, inbox, follow };
}
async function login(instance) {
  const login = await requestJson(
    instance,
    "POST",
    "/api/auth/mobile/login",
    null,
    { password: instance.password },
  );
  assert.equal(login.token_type, "Bearer");
  assert(
    typeof login.access_token === "string" && login.access_token.length > 0,
  );
  secrets.push(login.access_token);
  instance.token = login.access_token;
  const me = await requestJson(instance, "GET", "/api/auth/me", instance.token);
  assert.equal(me.actor?.role, "owner");
  assert(
    typeof me.actor.ap_id === "string" &&
      me.actor.ap_id.startsWith(instance.origin + "/ap/users/"),
  );
  instance.actor = me.actor.ap_id;
  const actors = await rows(
    instance.db,
    "SELECT ap_id, role FROM actors WHERE deleted_at IS NULL",
  );
  const sessions = await rows(
    instance.db,
    "SELECT COUNT(*) AS count FROM sessions",
  );
  assert.deepEqual(actors, [{ ap_id: instance.actor, role: "owner" }]);
  assert.equal(sessions[0]?.count, 1);
}
async function assertPeerOwnershipAndCache(peers, cachedByReceiver) {
  for (const peer of peers) {
    assert.deepEqual(
      await rows(
        peer.db,
        "SELECT ap_id, role FROM actors WHERE deleted_at IS NULL",
      ),
      [{ ap_id: peer.actor, role: "owner" }],
      `${peer.name} local actor ownership changed`,
    );
    assert.equal(
      (await rows(peer.db, "SELECT COUNT(*) AS count FROM sessions"))[0]?.count,
      1,
      `${peer.name} owner session count changed`,
    );
  }
  assert.deepEqual(
    await rows(peers[2].db, "SELECT ap_id FROM actor_cache ORDER BY ap_id"),
    cachedByReceiver
      .map((ap_id) => ({ ap_id }))
      .sort((left, right) => left.ap_id.localeCompare(right.ap_id)),
    "B remote actor cache differs from verified senders",
  );
}

try {
  if (argumentError)
    throw Error(
      "usage: smoke-release-foreign-wire-id.mjs [worker.js] [--deny-peer-key-fetch]",
    );
  for (const path of [artifact, schemaPath, configPath])
    assert(
      (await stat(path)).isFile(),
      `missing smoke input: ${basename(path)}`,
    );
  const config = unstable_readConfig(
    { config: configPath },
    { hideWarnings: true },
  );
  assert(config.compatibility_date, "Wrangler compatibility date missing");
  const artifactHash = sha256(await readFile(artifact));
  const version = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  ).version;
  tempRoot = await mkdtemp(join(tmpdir(), "yurucommu-foreign-wire-"));
  phase = "three-native-peers";
  const workers = names.map((name) => settings(name, config));
  const logDestination = new Writable({
    write(chunk, _encoding, callback) {
      collect(chunk);
      callback();
    },
  });
  runtime = createManagedNativeRuntime(
    (handleRuntimeStdio) =>
      new Miniflare({
        rootPath: tempRoot,
        host: "127.0.0.1",
        port: 0,
        cf: false,
        workers: [
          ...workers,
          ...names.map((from) => ({
            name: `route-${from.toLowerCase()}`,
            modules: true,
            script: routerScript(from),
            serviceBindings: Object.fromEntries(
              names
                .filter((name) => name !== from)
                .map((to) => [`PEER_${to}`, `peer-${to.toLowerCase()}`]),
            ),
            outboundService: "deny-outbound",
          })),
          {
            name: "deny-outbound",
            modules: true,
            script:
              "export default { fetch() { return new Response(null, { status: 502 }); } };",
          },
        ],
        handleRuntimeStdio,
        handleStructuredLogs: (entry) => {
          const value =
            typeof entry?.message === "string"
              ? entry.message
              : JSON.stringify(entry);
          if (value.includes("foreign-wire-route "))
            collect(Buffer.from(value + "\n"));
        },
      }),
    { destination: logDestination },
  );
  await deadline(runtime.worker.ready, 20_000, "three native peers ready");
  for (const name of names) {
    const peer = instances[name];
    peer.native = await runtime.worker.getWorker(`peer-${name.toLowerCase()}`);
    peer.db = await runtime.worker.getD1Database(
      "DB",
      `peer-${name.toLowerCase()}`,
    );
    peer.schema = await schemaFor(peer.db);
  }
  const routeA = await runtime.worker.getWorker("route-a");
  const routeC = await runtime.worker.getWorker("route-c");
  assert.equal(
    new Set(names.map((name) => instances[name].schema.sha256)).size,
    1,
    "same migration bytes required",
  );
  phases.push("three-independent-migrated-worker-stores");
  phase = "api-created-owners";
  for (const name of names) await login(instances[name]);
  const [a, c, b] = [instances.A, instances.C, instances.B];
  phases.push("three-api-created-owner-sessions");
  phase = "product-discovery";
  for (const peer of [a, c, b]) {
    const discovery = await requestJson(
      peer,
      "GET",
      "/.well-known/yurucommu",
      null,
    );
    assert.equal(discovery.product, "yurucommu");
    assert.equal(discovery.name, "Yurucommu");
    assert.equal(discovery.server?.id, "yurucommu-server");
    assert.equal(discovery.server?.canonicalOrigin, peer.origin);
  }
  phases.push("three-own-artifact-discovery-origins");
  phase = "private-receiver";
  await requestJson(b, "PUT", "/api/actors/me", b.token, { is_private: true });
  assert.equal(
    (
      await rows(b.db, "SELECT is_private FROM actors WHERE ap_id = ?", [
        b.actor,
      ])
    )[0]?.is_private,
    1,
  );
  phase = "hold-genuine-queue-follow";
  await requestJson(c, "POST", "/api/follow", c.token, {
    target_ap_id: b.actor,
  });
  const held = await poll(
    "C genuine signed Follow held by router",
    async () => {
      const response = await routeC.fetch("http://fixture.local/__status");
      if (response.status !== 200) return null;
      return (await response.json()).held;
    },
    30_000,
  );
  assert.equal(held.actor, c.actor);
  assert.equal(held.target, b.actor);
  assert(
    held.wireId?.startsWith(c.origin + "/ap/activities/"),
    "C wire ID missing",
  );
  assert(
    typeof held.inboxUrl === "string" &&
      new URL(held.inboxUrl).origin === b.origin,
    "held signed inbox URL missing",
  );
  const wireId = held.wireId;
  assert(
    routes.some(
      (event) =>
        event.from === "C" &&
        event.to === "B" &&
        event.kind === "held-follow" &&
        event.wireId === wireId,
    ),
    "C native queue delivery was not observed at router",
  );
  assert.equal(
    (
      await rows(
        b.db,
        "SELECT COUNT(*) AS count FROM activities WHERE direction='inbound' AND type='Follow'",
      )
    )[0]?.count,
    0,
  );
  phases.push("C-real-queue-follow-held-before-B");
  phase = "A-genuine-key-foreign-wire-id";
  const keys = await rows(
    a.db,
    "SELECT ap_id, role, private_key_pem, public_key_pem FROM actors WHERE ap_id = ? AND deleted_at IS NULL",
    [a.actor],
  );
  assert.equal(keys.length, 1);
  assert.equal(keys[0].role, "owner");
  const key = keys[0];
  const url = new URL(held.inboxUrl);
  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: wireId,
    type: "Follow",
    actor: a.actor,
    object: b.actor,
  };
  const exactBody = JSON.stringify(activity);
  const bodyBytes = Buffer.from(exactBody, "utf8");
  const date = new Date().toUTCString();
  const digest = `SHA-256=${createHash("sha256").update(bodyBytes).digest("base64")}`;
  const signingInput = signedString("POST", url, date, digest);
  const signature = pemSign(key.private_key_pem, signingInput);
  assert(
    pemVerify(key.public_key_pem, signingInput, signature),
    "A-key local signature self-check failed",
  );
  const headers = new Headers({
    host: url.host,
    date,
    digest,
    signature: `keyId="${a.actor}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`,
    "content-type": "application/activity+json",
    "content-length": String(bodyBytes.length),
  });
  const outgoingBody = exactBody;
  const outgoingUrl = url;
  const outgoingDigest = `SHA-256=${createHash("sha256").update(Buffer.from(outgoingBody, "utf8")).digest("base64")}`;
  const outgoingInput = signedString(
    "POST",
    outgoingUrl,
    headers.get("date"),
    headers.get("digest"),
  );
  const exactOutgoingVerified =
    outgoingBody === exactBody &&
    headers.get("host") === url.host &&
    headers.get("digest") === outgoingDigest &&
    headers.get("content-length") ===
      String(Buffer.byteLength(outgoingBody, "utf8")) &&
    pemVerify(key.public_key_pem, outgoingInput, signature);
  assert(exactOutgoingVerified, "exact outgoing A request verification failed");
  assert.equal(
    headers.get("signature")?.match(/keyId="([^"]+)"/)?.[1],
    a.actor + "#main-key",
  );
  const aResponse = await deadline(
    routeA.fetch("http://fixture.local/__send-signed-follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inboxUrl: url.href,
        expectedInboxUrl: held.inboxUrl,
        exactBody,
        expectedActor: a.actor,
        expectedWireId: wireId,
        expectedTarget: b.actor,
        headers: Object.fromEntries(headers),
        publicKeyPem: key.public_key_pem,
      }),
    }),
    20_000,
    "A signed foreign-wire Follow",
  );
  assert.equal(aResponse.status, 200, "A fixture forwarding control failed");
  const aProof = await aResponse.json();
  assert.equal(aProof.exactForwardedRequestVerified, true);
  assert.equal(aProof.exactForwardedSignatureVerified, true);
  assert.equal(aProof.bodySha256, sha256(bodyBytes));
  assert.equal(
    aProof.status,
    202,
    "legitimate A Follow with C-origin wire ID must be accepted",
  );
  const identitySourceA = `synthetic:${sha256(`${a.actor}\0Follow\0${b.actor}\0${exactBody}`)}`;
  const idA = internalId(b.origin, a.actor, identitySourceA);
  const idC = internalId(b.origin, c.actor, wireId);
  assert.notEqual(idA, idC);
  const aState = await poll(
    "B A Follow processed with synthetic source",
    async () => {
      const value = await projection(b.db, idA, a.actor, b.actor);
      return value.activity.length === 1 &&
        value.activity[0].processed === 1 &&
        value.claim.length === 1 &&
        value.inbox.length === 1 &&
        value.follow.length === 1
        ? value
        : null;
    },
  );
  assert.deepEqual(aState.activity, [
    {
      id: idA,
      actor: a.actor,
      type: "Follow",
      processed: 1,
      rawId: wireId,
      rawActor: a.actor,
      rawSha256: sha256(exactBody),
    },
  ]);
  assert.equal(aState.claim[0].activity_ap_id, idA);
  assert.equal(aState.claim[0].processing_token, null);
  assert.equal(aState.claim[0].lease_expires_at, null);
  assert.equal(aState.follow[0].status, "pending");
  assert.equal(aState.follow[0].activity_ap_id, idA);
  assert.equal(aState.inbox[0].actor_ap_id, b.actor);
  assert.equal(aState.inbox[0].activity_ap_id, idA);
  assert.equal(
    (
      await rows(
        b.db,
        "SELECT COUNT(*) AS count FROM activities WHERE direction='inbound' AND type='Follow'",
      )
    )[0]?.count,
    1,
  );
  assert.equal(
    (
      await rows(b.db, "SELECT COUNT(*) AS count FROM inbound_activity_claims")
    )[0]?.count,
    1,
  );
  assert.equal(
    (await rows(b.db, "SELECT COUNT(*) AS count FROM inbox"))[0]?.count,
    1,
  );
  assert.equal(
    (await rows(b.db, "SELECT COUNT(*) AS count FROM follows"))[0]?.count,
    1,
  );
  await assertPeerOwnershipAndCache([a, c, b], [a.actor]);
  phases.push("A-202-processed-synthetic-local-ID-before-C-release");
  phase = "release-unchanged-C-request";
  const releaseResponse = await routeC.fetch("http://fixture.local/__release", {
    method: "POST",
  });
  assert.equal(releaseResponse.status, 200);
  assert.equal((await releaseResponse.json()).released, true);
  const cEvent = await poll(
    "C released original signed Follow",
    async () =>
      routes.find(
        (event) =>
          event.from === "C" &&
          event.to === "B" &&
          event.kind === "released-follow" &&
          event.wireId === wireId,
      ),
    30_000,
  );
  assert.equal(cEvent.originalRequestPreserved, true);
  if (denyPeerKeyFetch) {
    assert.equal(
      cEvent.status,
      401,
      "denied C peer key fetch must reject its signed Follow",
    );
    assert(
      routes.some(
        (event) =>
          event.from === "B" &&
          event.to === "C" &&
          event.kind === "denied-peer-key" &&
          event.status === 502,
      ),
    );
    assert.deepEqual(
      await projection(b.db, idA, a.actor, b.actor),
      aState,
      "A state changed during denied C request",
    );
    assert.deepEqual(
      await projection(b.db, idC, c.actor, b.actor),
      { activity: [], claim: [], inbox: [], follow: [] },
      "denied C request created receiver state",
    );
    const deniedCounts = await receiverCounts(b.db);
    assert.deepEqual(deniedCounts, {
      activities: 1,
      claims: 1,
      inbox: 1,
      pendingEdges: 1,
    });
    await assertPeerOwnershipAndCache([a, c, b], [a.actor]);
    phase = "C-peer-key-denied";
    throw Error(
      "denial fixture blocked C public-key request after A was processed",
    );
  }
  assert.equal(cEvent.status, 202, "unchanged C Follow must be accepted");
  const cJob = await poll(
    "C actual delivery job completed",
    async () => {
      const found = await rows(
        c.db,
        "SELECT id, status, attempts FROM delivery_queue WHERE activity_ap_id = ?",
        [wireId],
      );
      return found.length === 1 && found[0].status === "delivered"
        ? found[0]
        : null;
    },
    30_000,
  );
  const cState = await poll("B C Follow processed separately", async () => {
    const value = await projection(b.db, idC, c.actor, b.actor);
    return value.activity.length === 1 &&
      value.activity[0].processed === 1 &&
      value.claim.length === 1 &&
      value.inbox.length === 1 &&
      value.follow.length === 1
      ? value
      : null;
  });
  assert.deepEqual(cState.activity, [
    {
      id: idC,
      actor: c.actor,
      type: "Follow",
      processed: 1,
      rawId: wireId,
      rawActor: c.actor,
      rawSha256: held.rawSha256,
    },
  ]);
  assert.equal(cState.claim[0].activity_ap_id, idC);
  assert.equal(cState.claim[0].processing_token, null);
  assert.equal(cState.claim[0].lease_expires_at, null);
  assert.equal(cState.follow[0].status, "pending");
  assert.equal(cState.follow[0].activity_ap_id, idC);
  assert.equal(cState.inbox[0].actor_ap_id, b.actor);
  assert.equal(cState.inbox[0].activity_ap_id, idC);
  assert.deepEqual(
    await projection(b.db, idA, a.actor, b.actor),
    aState,
    "C processing changed A projection",
  );
  const counts = await receiverCounts(b.db);
  assert.deepEqual(counts, {
    activities: 2,
    claims: 2,
    inbox: 2,
    pendingEdges: 2,
  });
  assert.equal(
    (
      await rows(
        b.db,
        "SELECT COUNT(DISTINCT actor_ap_id) AS count FROM activities WHERE direction='inbound' AND type='Follow'",
      )
    )[0]?.count,
    2,
  );
  await assertPeerOwnershipAndCache([a, c, b], [a.actor, c.actor]);
  phases.push("A-and-C-distinct-processed-ledger-claims-inbox-pending-edges");
  finalRecord = {
    status: "PASSED",
    kind: "yurucommu.release-foreign-wire-id-smoke@v1",
    scope: "same-product-three-peer",
    fixture: { denyPeerKeyFetch },
    artifact: { name: basename(artifact), sha256: `sha256:${artifactHash}` },
    schema: {
      name: basename(schemaPath),
      sha256: `sha256:${a.schema.sha256}`,
      migrations: a.schema.entries,
    },
    runtime: "workerd",
    compatibilityDate: config.compatibility_date,
    productVersion: version,
    peers: {
      count: 3,
      independentBindings: ["D1", "KV", "R2", "delivery-queue", "delivery-dlq"],
      apiCreatedOwners: 3,
    },
    results: {
      aStatus: aProof.status,
      cStatus: cEvent.status,
      cJobStatus: cJob.status,
      cJobAttempts: cJob.attempts,
      exactOutgoingVerified,
      exactOutgoingSignatureVerified: exactOutgoingVerified,
      exactForwardedRequestVerified: aProof.exactForwardedRequestVerified,
      exactForwardedSignatureVerified: aProof.exactForwardedSignatureVerified,
      aProcessedBeforeC: true,
      originalCRequestPreserved: cEvent.originalRequestPreserved,
      signingActors: [a.actor, c.actor],
      aLocalId: idA,
      cLocalId: idC,
      sharedWireId: wireId,
      aSyntheticSourceSha256: sha256(identitySourceA),
      aExactBodySha256: sha256(bodyBytes),
      aForwardedBodySha256: aProof.bodySha256,
      aRawSha256: aState.activity[0].rawSha256,
      cRawSha256: cState.activity[0].rawSha256,
      counts,
      aProjectionRetained: true,
      receiverCachedSignerActors: [a.actor, c.actor],
    },
    phases,
    boundary:
      "Three independent instances of one unchanged Yurucommu Worker artifact in one workerd, with separate migrated D1/KV/R2/queues and API-created owner sessions. Exact A/C/B HTTPS origins and DNS are virtualized inside workerd. This Follow-only witness does not establish public DNS/TLS, every Activity type, cross-product federation, live delivery, or operator data recovery.",
  };
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  const cleanup = { runtimeDisposed: false, temporaryStateRemoved: false };
  if (runtime) {
    try {
      await deadline(runtime.dispose(), 12_000, "native dispose");
      cleanup.runtimeDisposed = true;
    } catch (error) {
      cleanupErrors.push(`native dispose: ${redact(error?.message ?? error)}`);
    }
  }
  if (tempRoot && (!runtime || cleanup.runtimeDisposed)) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      cleanup.temporaryStateRemoved = true;
    } catch (error) {
      cleanupErrors.push(`temporary state: ${redact(error?.message ?? error)}`);
    }
  } else if (tempRoot)
    cleanupErrors.push("temporary state retained after failed disposal");
  if (primaryError || cleanupErrors.length > 0)
    finalRecord = {
      status: "FAILED",
      kind: "yurucommu.release-foreign-wire-id-smoke@v1",
      phase,
      fixture: {
        denyPeerKeyFetch,
        aProcessedBeforeC: phases.includes(
          "A-202-processed-synthetic-local-ID-before-C-release",
        ),
        cPeerKeyDeniedObserved: routes.some(
          (event) => event.kind === "denied-peer-key" && event.status === 502,
        ),
      },
      error: primaryError
        ? redact(primaryError?.message ?? primaryError)
        : "native cleanup failed",
      cleanupErrors,
      phases,
    };
  finalRecord.cleanup = cleanup;
  finalRecord.diagnostics = { runtimeLogBytes, routeEvents: routes.slice(-20) };
  (finalRecord.status === "PASSED" ? process.stdout : process.stderr).write(
    JSON.stringify(finalRecord) + "\n",
  );
}
if (finalRecord.status !== "PASSED") process.exitCode = 1;
