import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, mkdtemp, rm, stat } from "node:fs/promises";
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
const schemaOverrides = {
  "0003_activity_remote_object_edges.sql": {
    sourceSha256:
      "sha256:fca8d640cc0b16a61e9513abc251a52b351b42620db71edb2a3880dc0e743c14",
    relativePath:
      "deploy/takoform/migrations/takoform-overrides/0003_activity_remote_object_edges.sql",
  },
};
const args = process.argv.slice(2);
const artifactArguments = args.filter((arg) => !arg.startsWith("--"));
const artifact = resolve(
  root,
  artifactArguments[0] ?? "dist/yurucommu-worker.js",
);
const denyPositiveActorFetch = args.includes("--deny-positive-actor-fetch");
const argumentError =
  args.some(
    (arg) => arg.startsWith("--") && arg !== "--deny-positive-actor-fetch",
  ) ||
  artifactArguments.length > 1 ||
  args.filter((arg) => arg === "--deny-positive-actor-fetch").length > 1;
const label = randomBytes(6).toString("hex");
const names = ["A", "B"];
const origins = {
  A: "https://a.native-ssrf.invalid",
  B: "https://b.native-ssrf.invalid",
};
const targets = {
  mapped: "mapped-v4v6.native-ssrf.invalid",
  redirect: "redirect.native-ssrf.invalid",
};
const dnsRecords = {
  [targets.mapped]: { A: "93.184.216.34", AAAA: "::ffff:7f00:1" },
  [targets.redirect]: { A: "93.184.216.35" },
  [new URL(origins.A).hostname]: { A: "93.184.216.37" },
  [new URL(origins.B).hostname]: { A: "93.184.216.36" },
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const phases = [];
const routes = [];
const secrets = [];
const negativeResults = {
  directPrivateTargets: [],
  mappedPrivateDns: null,
  privateRedirect: null,
};
const instances = {};
let phase = "preflight";
let runtime;
let tempRoot;
let finalRecord;
let primaryError;
let runtimeLogBytes = 0;
let routeOverflow = false;

function redact(value) {
  let text = String(value);
  for (const [path, replacement] of [
    [artifact, "[artifact]"],
    [schemaPath, "[schema]"],
    [tempRoot, "[temporary state]"],
    [root, "[repo]"],
  ])
    if (path) text = text.split(path).join(replacement);
  for (const secret of secrets)
    if (secret) text = text.split(secret).join("[redacted]");
  return text
    .replace(
      /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g,
      "[redacted private key]",
    )
    .replace(
      /(authorization\s*[:=]\s*(?:Bearer\s+)?)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(
      /(password|access_token|private_key_pem)\s*[=:]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(-1200);
}

function parseJsonc(source, label) {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      withoutComments += char;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      if (source[index] === "\n") withoutComments += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        if (source[index] === "\n") withoutComments += "\n";
        index += 1;
      }
      if (index >= source.length)
        throw new Error(`${label} has an open comment`);
      index += 1;
    } else {
      withoutComments += char;
    }
  }

  let json = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index];
    if (inString) {
      json += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      json += char;
    } else if (char === ",") {
      let next = index + 1;
      while (/\s/.test(withoutComments[next] ?? "")) next += 1;
      if (withoutComments[next] !== "}" && withoutComments[next] !== "]")
        json += char;
    } else {
      json += char;
    }
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`${label} is not valid JSON/JSONC`);
  }
}

function deadline(task, milliseconds, label) {
  let timer;
  return Promise.race([
    Promise.resolve(task),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label}: ${milliseconds}ms deadline`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function poll(label, predicate, milliseconds = 30_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() <= end) {
    const value = await deadline(predicate(), 8_000, label);
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${label}: ${milliseconds}ms deadline`);
}

function captureChunk(chunk) {
  runtimeLogBytes += chunk.length;
  for (const line of chunk.toString("utf8").split("\n")) {
    const marker = "native-ssrf-route ";
    const offset = line.indexOf(marker);
    if (offset < 0) continue;
    try {
      recordRoute(JSON.parse(line.slice(offset + marker.length)));
    } catch {
      // Diagnostics are evidence only; malformed lines never affect routing.
    }
  }
}

function recordRoute(event) {
  if (routes.some((prior) => JSON.stringify(prior) === JSON.stringify(event)))
    return;
  if (routes.length >= 200) {
    routeOverflow = true;
    return;
  }
  routes.push(event);
}

function routerScript(from) {
  const peerOrigin = origins[from === "A" ? "B" : "A"];
  return `const from = ${JSON.stringify(from)};
const peerOrigin = ${JSON.stringify(peerOrigin)};
const dnsRecords = ${JSON.stringify(dnsRecords)};
const targets = ${JSON.stringify(targets)};
const denyPositiveActorFetch = ${JSON.stringify(denyPositiveActorFetch)};
let routeSequence = 0;
function event(fields) { console.log('native-ssrf-route', JSON.stringify({ from, sequence: ++routeSequence, ...fields })); }
function privateHost(host) {
  const value = host.toLowerCase().replace(/^\\[|\\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
    || value === '0.0.0.0' || value === '::'
    || value.startsWith('::ffff:127.') || value.startsWith('::ffff:7f');
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    if (url.origin === 'https://cloudflare-dns.com' && url.pathname === '/dns-query' && request.method === 'GET') {
      const name = (url.searchParams.get('name') || '').toLowerCase().replace(/\\.$/, '');
      const type = (url.searchParams.get('type') || '').toUpperCase();
      const recordSet = dnsRecords[name];
      if (!recordSet || !['A', 'AAAA', 'CNAME'].includes(type)) {
        event({ kind: 'unknown-doh', method: 'GET', hostname: name, dnsType: type, status: 502 });
        return new Response(null, { status: 502 });
      }
      const data = type === 'CNAME' ? null : recordSet[type];
      const recordType = type === 'A' ? 1 : type === 'AAAA' ? 28 : 5;
      const answer = data ? [{ name, type: recordType, TTL: 60, data }] : [];
      event({ kind: 'doh', method: 'GET', hostname: name, dnsType: type, answer: data || null, status: 200 });
      return Response.json({ Status: 0, Answer: answer });
    }

    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      event({ kind: privateHost(host) ? 'private-trap' : 'refused-route', method: request.method, hostname: host, path: url.pathname, status: 502 });
      return new Response(null, { status: 502 });
    }
    if (privateHost(host)) {
      event({ kind: 'private-trap', method: request.method, hostname: host, path: url.pathname, status: 502 });
      return new Response(null, { status: 502 });
    }

    if (url.hostname.toLowerCase() === new URL(peerOrigin).hostname.toLowerCase() && url.origin === peerOrigin) {
      if (request.method === 'GET' && /^\\/ap\\/users\\/[^/]+$/.test(url.pathname)) {
        if (denyPositiveActorFetch && from === 'A') {
          event({ kind: 'denied-positive-actor-get', method: 'GET', hostname: host, path: url.pathname, status: 502 });
          return new Response(null, { status: 502 });
        }
        const response = await env.PEER.fetch(request);
        event({ kind: 'peer-actor-get', method: 'GET', hostname: host, path: url.pathname, status: response.status });
        return response;
      }
      if (from === 'A' && request.method === 'POST' && url.pathname === '/ap/inbox') {
        const activity = await request.clone().json().catch(() => null);
        const response = await env.PEER.fetch(request);
        event({ kind: 'peer-inbox-post', method: 'POST', hostname: host, path: url.pathname, status: response.status,
          activityId: typeof activity?.id === 'string' ? activity.id : null,
          activityType: typeof activity?.type === 'string' ? activity.type : null,
          actorId: typeof activity?.actor === 'string' ? activity.actor : null,
          objectId: typeof activity?.object === 'string' ? activity.object : null });
        return response;
      }
      event({ kind: 'refused-route', method: request.method, hostname: host, path: url.pathname, status: 502 });
      return new Response(null, { status: 502 });
    }

    if (request.method === 'GET' && host === targets.redirect && /^\\/ap\\/users\\/[^/]+$/.test(url.pathname)) {
      const location = 'https://127.0.0.1/ap/users/private-trap';
      event({ kind: 'redirect-actor-get', method: 'GET', hostname: host, path: url.pathname, status: 302, redirectHost: '127.0.0.1' });
      return new Response(null, { status: 302, headers: { location } });
    }
    if (host === targets.mapped || host === targets.redirect) {
      event({ kind: 'unexpected-actor-get', method: request.method, hostname: host, path: url.pathname, status: 502 });
      return new Response(null, { status: 502 });
    }
    event({ kind: 'refused-route', method: request.method, hostname: host, path: url.pathname, status: 502 });
    return new Response(null, { status: 502 });
  }
};`;
}

function settings(name, config) {
  const password = randomBytes(32).toString("base64url");
  const encryptionKey = randomBytes(32).toString("hex");
  const sessionSalt = randomBytes(24).toString("base64url");
  secrets.push(password, encryptionKey, sessionSalt);
  const queue = `native-ssrf-${label}-${name.toLowerCase()}-delivery`;
  const dlq = `native-ssrf-${label}-${name.toLowerCase()}-dlq`;
  const instance = {
    name,
    origin: origins[name],
    password,
    queue,
    dlq,
    workerName: `peer-${name.toLowerCase()}`,
  };
  instances[name] = instance;
  return {
    name: instance.workerName,
    modules: [{ type: "ESModule", path: artifact }],
    modulesRoot: dirname(artifact),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: {
      APP_URL: instance.origin,
      AUTH_PASSWORD_HASH: password,
      YURUCOMMU_SESSION_HASH_SALT: sessionSalt,
      ENCRYPTION_KEY: encryptionKey,
      DELIVERY_QUEUE_NAME: queue,
      DELIVERY_DLQ_NAME: dlq,
    },
    d1Databases: { DB: `native-ssrf-${label}-${name.toLowerCase()}-db` },
    kvNamespaces: { KV: `native-ssrf-${label}-${name.toLowerCase()}-kv` },
    r2Buckets: { MEDIA: `native-ssrf-${label}-${name.toLowerCase()}-media` },
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

async function schemaPreflight(bytes, rawConfig) {
  const schema = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(schema).sort(), [
    "apiVersion",
    "engine",
    "entries",
  ]);
  assert.equal(schema.apiVersion, "takosumi.resource-migrations/v1");
  assert.equal(schema.engine, "sqlite");
  assert(Array.isArray(schema.entries) && schema.entries.length > 0);
  const migrationRoot = resolve(root, rawConfig.d1_databases[0].migrations_dir);
  const sourceNames = (await readdir(migrationRoot))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(
    schema.entries.map((entry) => entry.name),
    sourceNames,
    "migration bundle entries differ from installed Core 4.1.11",
  );
  for (const entry of schema.entries) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["name", "sha256", "sql"],
      `unexpected migration schema fields: ${entry.name}`,
    );
    const sourceBytes = await readFile(join(migrationRoot, entry.name));
    const override = schemaOverrides[entry.name];
    let expectedBytes = sourceBytes;
    if (override) {
      assert.equal(
        `sha256:${sha256(sourceBytes)}`,
        override.sourceSha256,
        `override source changed: ${entry.name}`,
      );
      expectedBytes = await readFile(resolve(root, override.relativePath));
    }
    assert.deepEqual(
      Buffer.from(entry.sql, "utf8"),
      expectedBytes,
      `migration bundle SQL differs from its checked source: ${entry.name}`,
    );
    assert.equal(
      entry.sha256,
      `sha256:${sha256(Buffer.from(entry.sql, "utf8"))}`,
      `migration digest mismatch: ${entry.name}`,
    );
  }
  return schema;
}

async function schemaFor(db, schema, bytes) {
  for (const entry of schema.entries) {
    const statements = unstable_splitSqlQuery(entry.sql);
    assert(statements.length > 0, `empty migration: ${entry.name}`);
    await deadline(
      db.batch(statements.map((statement) => db.prepare(statement))),
      20_000,
      `migration ${entry.name}`,
    );
  }
  assert.equal(
    (await rows(db, "SELECT COUNT(*) AS count FROM actors"))[0]?.count,
    0,
    "migration target was not fresh",
  );
  assert.equal(
    (await rows(db, "SELECT COUNT(*) AS count FROM sessions"))[0]?.count,
    0,
    "migration target had existing sessions",
  );
  return { sha256: sha256(bytes), entries: schema.entries.length };
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
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${instance.name} ${method} ${path}: non-JSON response`);
  }
  const safeErrors = new Set([
    "Invalid target_ap_id",
    "Failed to fetch remote actor",
    "Could not fetch remote actor",
  ]);
  const safeError = safeErrors.has(payload?.error) ? payload.error : undefined;
  if (response.status !== expected) {
    throw new Error(
      `${instance.name} ${method} ${path}: expected HTTP ${expected}, received ${response.status}${safeError ? ` (${safeError})` : ""}`,
    );
  }
  return { payload, safeError, status: response.status };
}

async function login(instance) {
  const result = await requestJson(
    instance,
    "POST",
    "/api/auth/mobile/login",
    null,
    { password: instance.password },
  );
  assert.equal(result.payload.token_type, "Bearer");
  assert(
    typeof result.payload.access_token === "string" &&
      result.payload.access_token.length > 0,
    `${instance.name} owner session token missing`,
  );
  instance.token = result.payload.access_token;
  secrets.push(instance.token);
  const me = await requestJson(instance, "GET", "/api/auth/me", instance.token);
  assert.equal(me.payload.actor?.role, "owner");
  assert(
    typeof me.payload.actor?.ap_id === "string" &&
      me.payload.actor.ap_id.startsWith(instance.origin + "/ap/users/"),
    `${instance.name} API-created owner AP ID missing`,
  );
  instance.ownerApId = me.payload.actor.ap_id;
  const actors = await rows(
    instance.db,
    "SELECT ap_id, role FROM actors WHERE deleted_at IS NULL",
  );
  const sessions = await rows(
    instance.db,
    "SELECT COUNT(*) AS count FROM sessions",
  );
  assert.deepEqual(actors, [{ ap_id: instance.ownerApId, role: "owner" }]);
  assert.equal(sessions[0]?.count, 1);
}

async function warmInstanceActor(instance) {
  const response = await deadline(
    instance.native.fetch(instance.origin + "/ap/actor", {
      headers: { accept: "application/activity+json" },
    }),
    15_000,
    `${instance.name} warm instance actor`,
  );
  const body = await deadline(response.text(), 8_000, "instance actor body");
  assert.equal(response.status, 200, `${instance.name} instance actor status`);
  assert.doesNotThrow(() => JSON.parse(body));
}

async function discovery(instance) {
  const result = await requestJson(
    instance,
    "GET",
    "/.well-known/yurucommu",
    null,
  );
  const value = result.payload;
  assert.equal(value.product, "yurucommu");
  assert.equal(value.name, "Yurucommu");
  assert.equal(value.server?.id, "yurucommu-server");
  assert.equal(value.server?.name, "Yurucommu Server");
  assert.equal(value.server?.canonicalOrigin, instance.origin);
  assert(
    value.clients?.some((client) => client.id === "yurucommu"),
    "Yurucommu client missing from discovery",
  );
  assert(
    value.clients?.some((client) => client.id === "yurume"),
    "Yurumeet client missing from shared discovery",
  );
}

async function assertSingleOwnerAndSession(instance) {
  const actors = await rows(
    instance.db,
    "SELECT ap_id, role FROM actors WHERE deleted_at IS NULL",
  );
  const sessions = await rows(
    instance.db,
    "SELECT COUNT(*) AS count FROM sessions",
  );
  assert.deepEqual(actors, [{ ap_id: instance.ownerApId, role: "owner" }]);
  assert.equal(sessions[0]?.count, 1);
}

async function snapshot(db) {
  const state = {
    follows: await rows(
      db,
      "SELECT follower_ap_id, following_ap_id, status, activity_ap_id FROM follows ORDER BY follower_ap_id, following_ap_id",
    ),
    outboundActivities: await rows(
      db,
      "SELECT ap_id, type, actor_ap_id, object_ap_id, target_ap_id FROM activities WHERE direction = 'outbound' ORDER BY ap_id",
    ),
    deliveryQueue: await rows(
      db,
      "SELECT id, activity_ap_id, status, attempts FROM delivery_queue ORDER BY id",
    ),
    actorCache: await rows(db, "SELECT ap_id FROM actor_cache ORDER BY ap_id"),
    remoteObjects: await rows(
      db,
      "SELECT ap_id FROM objects WHERE is_local = 0 ORDER BY ap_id",
    ),
    owners: await rows(
      db,
      "SELECT ap_id, role FROM actors WHERE deleted_at IS NULL ORDER BY ap_id",
    ),
    sessions: (
      await rows(
        db,
        "SELECT id, member_id, access_token, expires_at FROM sessions ORDER BY id",
      )
    ).map((row) => ({
      idSha256: sha256(row.id),
      memberApId: row.member_id,
      accessTokenSha256: sha256(row.access_token),
      expiresAt: row.expires_at,
    })),
  };
  return {
    state,
    sha256: sha256(JSON.stringify(state)),
    counts: Object.fromEntries(
      Object.entries(state).map(([name, value]) => [name, value.length]),
    ),
  };
}

async function refusedFollow(instance, target, expectedError, label) {
  await warmInstanceActor(instance);
  const before = await snapshot(instance.db);
  const result = await requestJson(
    instance,
    "POST",
    "/api/follow",
    instance.token,
    { target_ap_id: target },
    400,
  );
  assert.equal(result.payload.error, expectedError, `${label} API error`);
  const after = await snapshot(instance.db);
  assert.deepEqual(after.state, before.state, `${label} changed A D1 state`);
  assert.equal(routeOverflow, false, "router telemetry overflowed");
  return {
    label,
    status: result.status,
    error: result.safeError,
    target,
    beforeSha256: before.sha256,
    afterSha256: after.sha256,
    stateUnchanged: true,
    beforeCounts: before.counts,
    afterCounts: after.counts,
  };
}

function matchingRoutes(predicate) {
  return routes.filter(predicate);
}

function dnsEvidence(hostname) {
  const events = matchingRoutes(
    (event) => event.kind === "doh" && event.hostname === hostname,
  );
  const byType = Object.fromEntries(
    events.map((event) => [event.dnsType, event]),
  );
  return {
    A: byType.A?.answer ?? null,
    AAAA: byType.AAAA?.answer ?? null,
    CNAMEEmpty: Boolean(byType.CNAME && byType.CNAME.answer === null),
    recordTypesWitnessed: Object.keys(byType).sort(),
  };
}

async function receiverFollowState(instance, actorId, targetId) {
  const activity = await rows(
    instance.db,
    "SELECT ap_id, actor_ap_id, type, processed, object_ap_id FROM activities WHERE direction = 'inbound' AND type = 'Follow' AND actor_ap_id = ? AND object_ap_id = ?",
    [actorId, targetId],
  );
  if (activity.length !== 1 || activity[0].processed !== 1) return null;
  const claims = await rows(
    instance.db,
    "SELECT activity_ap_id, processing_token, lease_expires_at FROM inbound_activity_claims WHERE activity_ap_id = ?",
    [activity[0].ap_id],
  );
  const inbox = await rows(
    instance.db,
    "SELECT actor_ap_id, activity_ap_id FROM inbox WHERE activity_ap_id = ?",
    [activity[0].ap_id],
  );
  const follows = await rows(
    instance.db,
    "SELECT follower_ap_id, following_ap_id, status, activity_ap_id FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
    [actorId, targetId],
  );
  if (
    claims.length !== 1 ||
    claims[0].processing_token !== null ||
    claims[0].lease_expires_at !== null ||
    inbox.length !== 1 ||
    follows.length !== 1
  )
    return null;
  assert.equal(inbox[0].actor_ap_id, targetId);
  assert.equal(follows[0].status, "pending");
  assert.equal(follows[0].activity_ap_id, activity[0].ap_id);
  return {
    activity: activity[0],
    claim: claims[0],
    inbox: inbox[0],
    follow: follows[0],
  };
}

try {
  phase = "preflight";
  if (argumentError)
    throw new Error(
      "usage: smoke-release-ssrf.mjs [artifact] [--deny-positive-actor-fetch]",
    );
  for (const path of [artifact, schemaPath, configPath])
    assert(
      (await stat(path)).isFile(),
      `missing smoke input: ${basename(path)}`,
    );

  const rawConfigBytes = await readFile(configPath);
  const rawConfig = parseJsonc(
    rawConfigBytes.toString("utf8"),
    "wrangler.jsonc",
  );
  assert.equal(rawConfig.name, "yurucommu", "wrong product Wrangler config");
  assert.equal(
    rawConfig.main,
    "./dist/yurucommu-worker.js",
    "wrong Worker artifact entry",
  );
  assert.deepEqual(
    rawConfig.d1_databases?.map((item) => item.binding),
    ["DB"],
  );
  assert.equal(
    rawConfig.d1_databases[0]?.migrations_table,
    "yurucommu_migrations",
  );
  assert.equal(
    rawConfig.d1_databases[0]?.migrations_dir,
    "node_modules/@takosjp/yurucommu-core/migrations",
  );
  assert.deepEqual(
    rawConfig.kv_namespaces?.map((item) => item.binding),
    ["KV"],
  );
  assert.deepEqual(
    rawConfig.r2_buckets?.map((item) => item.binding),
    ["MEDIA"],
  );
  assert.deepEqual(
    rawConfig.queues?.producers?.map((item) => item.binding).sort(),
    ["DELIVERY_DLQ", "DELIVERY_QUEUE"],
  );
  assert.deepEqual(
    rawConfig.queues?.producers
      ?.map((item) => `${item.binding}=${item.queue}`)
      .sort(),
    [
      "DELIVERY_DLQ=yurucommu-delivery-dlq",
      "DELIVERY_QUEUE=yurucommu-delivery",
    ],
  );
  assert.equal(rawConfig.vars?.DELIVERY_QUEUE_NAME, "yurucommu-delivery");
  assert.equal(rawConfig.vars?.DELIVERY_DLQ_NAME, "yurucommu-delivery-dlq");
  assert.deepEqual(
    rawConfig.queues?.consumers?.map((item) => item.queue).sort(),
    ["yurucommu-delivery", "yurucommu-delivery-dlq"],
  );
  assert.equal(
    rawConfig.queues?.consumers?.find(
      (item) => item.queue === "yurucommu-delivery",
    )?.dead_letter_queue,
    "yurucommu-delivery-dlq",
  );
  const config = unstable_readConfig(
    { config: configPath },
    { hideWarnings: true },
  );
  assert.equal(config.compatibility_date, rawConfig.compatibility_date);
  assert.deepEqual(config.compatibility_flags, rawConfig.compatibility_flags);
  assert(config.compatibility_date, "Wrangler compatibility date missing");

  const schemaBytes = await readFile(schemaPath);
  const schema = await schemaPreflight(schemaBytes, rawConfig);
  const packageVersion = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  ).version;
  const coreVersion = JSON.parse(
    await readFile(
      resolve(root, "node_modules/@takosjp/yurucommu-core/package.json"),
      "utf8",
    ),
  ).version;
  const apiVersion = JSON.parse(
    await readFile(
      resolve(root, "node_modules/@takosjp/yurucommu-api/package.json"),
      "utf8",
    ),
  ).version;
  assert.equal(coreVersion, "4.1.11", "unexpected installed published Core");
  const artifactHash = sha256(await readFile(artifact));
  tempRoot = await mkdtemp(join(tmpdir(), "yurucommu-native-ssrf-"));
  phases.push("strict-config-runtime-compatibility-schema-preflight");

  phase = "two-native-peers";
  const workers = names.map((name) => settings(name, config));
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      captureChunk(chunk);
      callback();
    },
  });
  const structuredLogs = (entry) => {
    const message =
      typeof entry?.message === "string"
        ? entry.message
        : JSON.stringify(entry);
    captureChunk(Buffer.from(message + "\n"));
  };
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
            serviceBindings: {
              PEER: `peer-${from === "A" ? "b" : "a"}`,
            },
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
        handleStructuredLogs: structuredLogs,
      }),
    { destination: sink },
  );
  await deadline(runtime.worker.ready, 20_000, "two native peers ready");
  for (const name of names) {
    const instance = instances[name];
    instance.native = await runtime.worker.getWorker(instance.workerName);
    instance.db = await runtime.worker.getD1Database("DB", instance.workerName);
    instance.schema = await schemaFor(instance.db, schema, schemaBytes);
  }
  assert.equal(
    new Set(names.map((name) => instances[name].schema.sha256)).size,
    1,
    "peers must use identical migration bundle bytes",
  );
  phases.push("two-api-workers-separate-d1-kv-r2-queue-dlq");

  phase = "api-owners-and-discovery";
  for (const name of names) {
    await login(instances[name]);
    await discovery(instances[name]);
  }
  const [a, b] = [instances.A, instances.B];
  phases.push("api-created-single-owners-and-product-discovery");

  phase = "literal-private-targets";
  const directInputs = [
    ["ipv4-loopback", "https://127.0.0.1/ap/users/ssrf-ipv4"],
    ["ipv6-loopback", "https://[::1]/ap/users/ssrf-ipv6"],
    ["normalized-ipv4-loopback", "https://0x7f000001/ap/users/ssrf-normalized"],
  ];
  for (const [label, target] of directInputs) {
    const result = await refusedFollow(
      a,
      target,
      "Invalid target_ap_id",
      label,
    );
    negativeResults.directPrivateTargets.push({
      ...result,
      normalizedTarget: new URL(target).href,
      dohRequests: routes.filter((event) => event.kind === "doh").length,
      privateTrapRequests: routes.filter(
        (event) => event.kind === "private-trap",
      ).length,
    });
  }
  assert.equal(
    routes.some((event) => event.kind === "doh"),
    false,
  );
  assert.equal(
    routes.some((event) => event.kind === "private-trap"),
    false,
  );
  phases.push(
    "literal-ipv4-ipv6-and-normalized-loopback-refused-without-fetch",
  );

  phase = "mapped-private-dns-answer";
  const mappedTarget = `https://${targets.mapped}/ap/users/mapped-private`;
  const mappedResult = await refusedFollow(
    a,
    mappedTarget,
    "Failed to fetch remote actor",
    "mapped-private-aaaa",
  );
  const mappedDns = dnsEvidence(targets.mapped);
  assert.equal(mappedDns.A, dnsRecords[targets.mapped].A);
  assert.equal(mappedDns.AAAA, dnsRecords[targets.mapped].AAAA);
  assert.equal(mappedDns.CNAMEEmpty, true);
  assert.deepEqual(mappedDns.recordTypesWitnessed, ["A", "AAAA", "CNAME"]);
  assert.equal(
    matchingRoutes(
      (event) =>
        event.kind === "unexpected-actor-get" &&
        event.hostname === targets.mapped,
    ).length,
    0,
    "mapped-private host actor GET escaped DNS validation",
  );
  assert.equal(
    matchingRoutes((event) => event.kind === "private-trap").length,
    0,
    "mapped-private target reached private trap",
  );
  negativeResults.mappedPrivateDns = {
    ...mappedResult,
    dns: mappedDns,
    actorGetCount: 0,
    privateTrapCount: 0,
  };
  phases.push("mapped-private-aaaa-refused-before-actor-http");

  phase = "private-redirect-refused";
  const redirectTarget = `https://${targets.redirect}/ap/users/redirect-private`;
  const redirectResult = await refusedFollow(
    a,
    redirectTarget,
    "Failed to fetch remote actor",
    "private-redirect",
  );
  const redirectDns = dnsEvidence(targets.redirect);
  assert.equal(redirectDns.A, dnsRecords[targets.redirect].A);
  assert.equal(redirectDns.AAAA, null);
  assert.equal(redirectDns.CNAMEEmpty, true);
  assert.deepEqual(redirectDns.recordTypesWitnessed, ["A", "AAAA", "CNAME"]);
  const redirectEvents = matchingRoutes(
    (event) =>
      event.kind === "redirect-actor-get" &&
      event.hostname === targets.redirect,
  );
  assert.equal(
    redirectEvents.length,
    1,
    "expected exactly one redirect response",
  );
  assert.equal(redirectEvents[0].status, 302);
  assert.equal(
    matchingRoutes((event) => event.kind === "private-trap").length,
    0,
    "private redirect destination was fetched",
  );
  negativeResults.privateRedirect = {
    ...redirectResult,
    dns: redirectDns,
    actorGetStatus: redirectEvents[0].status,
    actorGetCount: redirectEvents.length,
    privateTrapCount: 0,
  };
  phases.push("private-redirect-rejected-without-following-location");

  phase = "positive-native-follow";
  await requestJson(b, "PUT", "/api/actors/me", b.token, { is_private: true });
  assert.equal(
    (
      await rows(b.db, "SELECT is_private FROM actors WHERE ap_id = ?", [
        b.ownerApId,
      ])
    )[0]?.is_private,
    1,
    "positive receiver must keep the Follow pending",
  );
  await warmInstanceActor(b);
  const receiverBaseline = await snapshot(b.db);
  await warmInstanceActor(a);
  const positiveBaseline = await snapshot(a.db);
  const positive = await requestJson(
    a,
    "POST",
    "/api/follow",
    a.token,
    { target_ap_id: b.ownerApId },
    denyPositiveActorFetch ? 400 : 200,
  );
  if (denyPositiveActorFetch) {
    assert.equal(positive.payload.error, "Could not fetch remote actor");
    const after = await snapshot(a.db);
    assert.deepEqual(after.state, positiveBaseline.state);
    const receiverAfterDenial = await snapshot(b.db);
    assert.deepEqual(receiverAfterDenial.state, receiverBaseline.state);
    const denied = matchingRoutes(
      (event) =>
        event.kind === "denied-positive-actor-get" &&
        event.hostname === new URL(b.ownerApId).hostname,
    );
    assert.equal(
      denied.length,
      1,
      "positive actor GET denial was not observed exactly once",
    );
    assert.equal(denied[0].status, 502);
    await assertSingleOwnerAndSession(a);
    await assertSingleOwnerAndSession(b);
    phases.push("negative-lanes-passed-positive-actor-fetch-denial-observed");
    throw new Error(
      "intentional denial fixture: B actor GET was blocked after all SSRF refusal lanes passed",
    );
  }
  assert.deepEqual(positive.payload, { success: true, status: "pending" });
  const peerActorGet = await poll("positive B actor GET", async () =>
    matchingRoutes(
      (event) =>
        event.kind === "peer-actor-get" &&
        event.path === new URL(b.ownerApId).pathname,
    ).find((event) => event.status === 200),
  );
  assert.equal(peerActorGet.hostname, new URL(b.ownerApId).hostname);
  const positiveDns = dnsEvidence(new URL(b.ownerApId).hostname);
  assert.equal(positiveDns.A, dnsRecords[new URL(b.ownerApId).hostname].A);
  assert.equal(positiveDns.AAAA, null);
  assert.equal(positiveDns.CNAMEEmpty, true);
  assert.deepEqual(positiveDns.recordTypesWitnessed, ["A", "AAAA", "CNAME"]);

  const outboundFollow = await poll(
    "A native Follow delivery row",
    async () => {
      const rowsFound = await rows(
        a.db,
        "SELECT ap_id, type, actor_ap_id, object_ap_id FROM activities WHERE direction = 'outbound' AND type = 'Follow' AND actor_ap_id = ? AND object_ap_id = ?",
        [a.ownerApId, b.ownerApId],
      );
      return rowsFound.length === 1 ? rowsFound[0] : null;
    },
  );
  const cachedPeerActor = await rows(
    a.db,
    "SELECT ap_id FROM actor_cache WHERE ap_id = ?",
    [b.ownerApId],
  );
  assert.deepEqual(cachedPeerActor, [{ ap_id: b.ownerApId }]);
  const deliveredJob = await poll(
    "A native queue delivery completion",
    async () => {
      const jobs = await rows(
        a.db,
        "SELECT id, activity_ap_id, status, attempts FROM delivery_queue WHERE activity_ap_id = ?",
        [outboundFollow.ap_id],
      );
      return jobs.length === 1 && jobs[0].status === "delivered"
        ? jobs[0]
        : null;
    },
  );
  const inboxPost = await poll("B actual inbox returned 202", async () =>
    matchingRoutes(
      (event) =>
        event.kind === "peer-inbox-post" &&
        event.activityId === outboundFollow.ap_id &&
        event.activityType === "Follow",
    ).find((event) => event.status === 202),
  );
  assert.equal(inboxPost.actorId, a.ownerApId);
  assert.equal(inboxPost.objectId, b.ownerApId);
  const signerDns = await poll("B resolved the actual A signer", async () => {
    const evidence = dnsEvidence(new URL(a.ownerApId).hostname);
    return ["A", "AAAA", "CNAME"].every((type) =>
      evidence.recordTypesWitnessed.includes(type),
    )
      ? evidence
      : null;
  });
  assert.equal(signerDns.A, dnsRecords[new URL(a.ownerApId).hostname].A);
  assert.equal(signerDns.AAAA, null);
  assert.equal(signerDns.CNAMEEmpty, true);
  assert.deepEqual(signerDns.recordTypesWitnessed, ["A", "AAAA", "CNAME"]);
  const receiverState = await poll(
    "B processed Follow claim, inbox, and pending edge",
    () => receiverFollowState(b, a.ownerApId, b.ownerApId),
  );
  const positiveAfter = await snapshot(a.db);
  const receiverAfter = await snapshot(b.db);
  assert.deepEqual(positiveAfter.state.owners, positiveBaseline.state.owners);
  assert.deepEqual(
    positiveAfter.state.sessions,
    positiveBaseline.state.sessions,
  );
  assert.equal(positiveAfter.state.owners.length, 1);
  assert.equal(positiveAfter.state.sessions.length, 1);
  assert.equal(
    positiveAfter.state.follows.some(
      (row) =>
        row.follower_ap_id === a.ownerApId &&
        row.following_ap_id === b.ownerApId &&
        row.status === "pending",
    ),
    true,
  );
  await assertSingleOwnerAndSession(a);
  await assertSingleOwnerAndSession(b);
  assert.deepEqual(receiverAfter.state.owners, receiverBaseline.state.owners);
  assert.deepEqual(
    receiverAfter.state.sessions,
    receiverBaseline.state.sessions,
  );
  phases.push("positive-follow-used-native-queue-and-processed-pending-inbox");
  assert.equal(routeOverflow, false, "route telemetry overflowed");

  finalRecord = {
    status: "PASSED",
    kind: "yurucommu.release-ssrf-smoke@v1",
    artifact: { name: basename(artifact), sha256: `sha256:${artifactHash}` },
    schema: {
      name: basename(schemaPath),
      sha256: `sha256:${instances.A.schema.sha256}`,
      migrations: instances.A.schema.entries,
    },
    runtime: "workerd",
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    productVersion: packageVersion,
    coreVersion,
    apiVersion,
    rawWranglerSha256: `sha256:${sha256(rawConfigBytes)}`,
    peers: {
      count: 2,
      independentBindings: ["D1", "KV", "R2", "delivery-queue", "delivery-dlq"],
      apiCreatedOwners: 2,
    },
    fixture: { denyPositiveActorFetch: false },
    results: {
      directPrivateTargets: negativeResults.directPrivateTargets,
      mappedPrivateDns: negativeResults.mappedPrivateDns,
      privateRedirect: negativeResults.privateRedirect,
      positiveFollow: {
        apiStatus: positive.status,
        apiResult: positive.payload,
        targetActorId: b.ownerApId,
        remoteActorCached: true,
        actorGetStatus: peerActorGet.status,
        dns: positiveDns,
        signerDns,
        outboundActivityId: outboundFollow.ap_id,
        queueJobId: deliveredJob.id,
        queueStatus: deliveredJob.status,
        queueAttempts: deliveredJob.attempts,
        inboxPostStatus: inboxPost.status,
        receiverActivityId: receiverState.activity.ap_id,
        receiverActivityProcessed: receiverState.activity.processed,
        receiverClaimPresent: true,
        receiverClaimReleased: true,
        receiverInboxPresent: true,
        receiverFollowStatus: receiverState.follow.status,
        ownerSessionPreserved:
          positiveAfter.state.owners.length === 1 &&
          positiveAfter.state.sessions.length === 1,
      },
      routeEvents: routes,
      negativeStateUnchanged: true,
      runtimeLogBytes,
    },
    phases,
    boundary:
      "Two independent instances of the unchanged Yurucommu Worker artifact in one workerd with separate migrated D1/KV/R2/queues. Three direct loopback forms, one mapped-private DNS answer, and one private redirect are covered through authenticated Follow API calls. Exact DoH and peer HTTP destinations are virtualized in the workerd routers, which count and refuse unknown egress. This does not prove DNS rebinding resistance, IP pinning, public DNS/TLS, all SSRF shapes, or live federation.",
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
  } else if (tempRoot) {
    cleanupErrors.push("temporary state retained after failed disposal");
  }
  if (primaryError || cleanupErrors.length > 0) {
    finalRecord = {
      status: "FAILED",
      kind: "yurucommu.release-ssrf-smoke@v1",
      phase,
      fixture: {
        denyPositiveActorFetch,
        denialObserved: routes.some(
          (event) =>
            event.kind === "denied-positive-actor-get" && event.status === 502,
        ),
      },
      error: primaryError
        ? redact(primaryError?.message ?? primaryError)
        : "native cleanup failed",
      cleanupErrors,
      phases,
      negativeResults,
      routeEvents: routes,
    };
  }
  finalRecord.cleanup = cleanup;
  (finalRecord.status === "PASSED" ? process.stdout : process.stderr).write(
    JSON.stringify(finalRecord) + "\n",
  );
}
if (finalRecord.status !== "PASSED") process.exitCode = 1;
