import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { build, stop } from "esbuild";

import { createEntrySource } from "./build-yurucommu-worker.ts";
import { createManagedNativeRuntime } from "./native-runtime-stdio.mjs";

const repo = new URL("../", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

async function buildGeneratedFixture(transform = (source: string) => source) {
  const directory = await mkdtemp(join(tmpdir(), "yurucommu-event-smoke-"));
  temporaryDirectories.push(directory);
  const artifactPath = join(directory, "worker.js");
  const source = createEntrySource({
    "index.html": {
      contentType: "text/html; charset=utf-8",
      body: btoa('<title>Yurucommu</title><div id="root"></div>'),
    },
  });
  try {
    await build({
      stdin: {
        contents: transform(source),
        resolveDir: join(repo, "scripts"),
        loader: "ts",
      },
      outfile: artifactPath,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
    });
  } finally {
    stop();
  }
  return artifactPath;
}

function requireSmokeProcessExit(
  result: Bun.ReadableSyncSubprocess,
  elapsedMs: number,
) {
  if (result.exitCode === null || result.signalCode != null) {
    throw new Error(
      `Native smoke child did not complete after ${elapsedMs}ms: exit=${result.exitCode}, signal=${result.signalCode ?? "none"}; ${result.stderr.toString()}`,
    );
  }
  return result;
}

function runSmoke(artifactPath: string) {
  const started = performance.now();
  const result = Bun.spawnSync(
    ["bun", "scripts/smoke-release-worker.mjs", artifactPath],
    {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    },
  );
  return requireSmokeProcessExit(
    result,
    Math.round(performance.now() - started),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const pipeEvents = ["unpipe", "error", "close", "finish"] as const;

function pipeListenerCounts(destination: PassThrough) {
  return pipeEvents.map((event) => destination.listenerCount(event));
}

function runtimeChannel() {
  const upstream = new PassThrough();
  const buffered = new Transform({
    transform(chunk, _encoding, done) {
      done(null, chunk);
    },
  });
  upstream.pipe(buffered);
  return { upstream, buffered };
}

describe("native runtime stdio cleanup", () => {
  test("returns shared stderr listeners to baseline across six runtimes and rebuild callbacks", async () => {
    const destination = new PassThrough();
    let diagnostics = "";
    destination.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const baseline = pipeListenerCounts(destination);
    let expected = "";

    for (let index = 0; index < 6; index += 1) {
      const first = [runtimeChannel(), runtimeChannel()];
      const rebuilt = index === 2 ? [runtimeChannel(), runtimeChannel()] : [];
      const managed = createManagedNativeRuntime(
        (handleRuntimeStdio) => {
          handleRuntimeStdio(first[0]!.buffered, first[1]!.buffered);
          if (rebuilt.length) {
            handleRuntimeStdio(rebuilt[0]!.buffered, rebuilt[1]!.buffered);
          }
          return {
            async dispose() {
              for (const channel of [...first, ...rebuilt]) {
                channel.upstream.destroy();
              }
            },
          };
        },
        { destination },
      );

      for (const [channelIndex, channel] of [...first, ...rebuilt].entries()) {
        const message = `runtime-${index}-channel-${channelIndex}\n`;
        channel.upstream.write(message);
        expected += message;
      }
      expect(diagnostics).toBe(expected);
      expect(pipeListenerCounts(destination)).toEqual(
        baseline.map((count) => count + first.length + rebuilt.length),
      );

      await managed.dispose();
      for (const channel of [...first, ...rebuilt]) {
        expect(channel.buffered.destroyed).toBe(true);
      }
      expect(pipeListenerCounts(destination)).toEqual(baseline);
      expect(destination.destroyed).toBe(false);
      expect(destination.writableEnded).toBe(false);
    }

    destination.write("destination-still-usable\n");
    expect(diagnostics).toBe(`${expected}destination-still-usable\n`);
    destination.destroy();
  });

  test("preserves the exact disposal error, cleans every stream, and never disposes twice", async () => {
    const destination = new PassThrough();
    destination.resume();
    const baseline = pipeListenerCounts(destination);
    const channels = [runtimeChannel(), runtimeChannel()];
    const disposalError = new Error("original disposal failure");
    const cleanupError = new Error("first stream unpipe failure");
    const originalUnpipe = channels[0]!.buffered.unpipe.bind(
      channels[0]!.buffered,
    );
    Object.defineProperty(channels[0]!.buffered, "unpipe", {
      value: (target: PassThrough) => {
        originalUnpipe(target);
        throw cleanupError;
      },
    });
    let disposeCalls = 0;
    const managed = createManagedNativeRuntime(
      (handleRuntimeStdio) => {
        handleRuntimeStdio(channels[0]!.buffered, channels[1]!.buffered);
        return {
          async dispose() {
            disposeCalls += 1;
            for (const channel of channels) channel.upstream.destroy();
            throw disposalError;
          },
        };
      },
      { destination },
    );

    await expect(managed.dispose()).rejects.toBe(disposalError);
    await expect(managed.dispose()).rejects.toBe(disposalError);
    expect(disposeCalls).toBe(1);
    expect(channels.every((channel) => channel.buffered.destroyed)).toBe(true);
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    expect(destination.destroyed).toBe(false);
    destination.destroy();
  });

  test("reports cleanup failure after an otherwise successful disposal", async () => {
    const destination = new PassThrough();
    destination.resume();
    const baseline = pipeListenerCounts(destination);
    const channels = [runtimeChannel(), runtimeChannel()];
    const cleanupError = new Error("stdio cleanup failed");
    const originalUnpipe = channels[0]!.buffered.unpipe.bind(
      channels[0]!.buffered,
    );
    Object.defineProperty(channels[0]!.buffered, "unpipe", {
      value: (target: PassThrough) => {
        originalUnpipe(target);
        throw cleanupError;
      },
    });
    const managed = createManagedNativeRuntime(
      (handleRuntimeStdio) => {
        handleRuntimeStdio(channels[0]!.buffered, channels[1]!.buffered);
        return {
          dispose: () =>
            channels.forEach((channel) => channel.upstream.destroy()),
        };
      },
      { destination },
    );

    await expect(managed.dispose()).rejects.toBe(cleanupError);
    expect(channels.every((channel) => channel.buffered.destroyed)).toBe(true);
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    expect(destination.writableEnded).toBe(false);
    destination.destroy();
  });

  test("cleans constructor failure and rejects late callbacks without reattaching", async () => {
    const destination = new PassThrough();
    destination.resume();
    const baseline = pipeListenerCounts(destination);
    const constructed = [runtimeChannel(), runtimeChannel()];
    const constructorError = new Error("original constructor failure");
    const originalUnpipe = constructed[0]!.buffered.unpipe.bind(
      constructed[0]!.buffered,
    );
    Object.defineProperty(constructed[0]!.buffered, "unpipe", {
      value: (target: PassThrough) => {
        originalUnpipe(target);
        throw new Error("constructor stream cleanup failed");
      },
    });
    let caught;
    try {
      createManagedNativeRuntime(
        (handleRuntimeStdio) => {
          handleRuntimeStdio(
            constructed[0]!.buffered,
            constructed[1]!.buffered,
          );
          throw constructorError;
        },
        { destination },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(constructorError);
    expect(constructed.every((channel) => channel.buffered.destroyed)).toBe(
      true,
    );
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    for (const channel of constructed) channel.upstream.destroy();

    let callback: (stdout: Readable, stderr: Readable) => void = () => {
      throw new Error("stdio callback not registered");
    };
    let finishDispose!: () => void;
    const pendingDisposal = new Promise<void>((resolve) => {
      finishDispose = resolve;
    });
    const managed = createManagedNativeRuntime(
      (handleRuntimeStdio) => {
        callback = handleRuntimeStdio;
        return {
          async dispose() {
            await pendingDisposal;
          },
        };
      },
      { destination },
    );
    const closing = managed.dispose();
    const late = [runtimeChannel(), runtimeChannel()];
    callback(late[0]!.buffered, late[1]!.buffered);
    expect(late.every((channel) => channel.buffered.destroyed)).toBe(true);
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    finishDispose();
    await closing;
    const afterClose = [runtimeChannel(), runtimeChannel()];
    callback(afterClose[0]!.buffered, afterClose[1]!.buffered);
    expect(afterClose.every((channel) => channel.buffered.destroyed)).toBe(
      true,
    );
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    expect(destination.destroyed).toBe(false);
    for (const channel of [...late, ...afterClose]) channel.upstream.destroy();
    destination.destroy();
  });

  test("releases both late channels when the first release throws during disposal and after close", async () => {
    const destination = new PassThrough();
    let diagnostics = "";
    destination.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const baseline = pipeListenerCounts(destination);
    const closingChannels = [runtimeChannel(), runtimeChannel()];
    const closingError = new Error("first closing release failed");

    function failUnpipe(buffered: Transform, error: Error) {
      const originalUnpipe = buffered.unpipe.bind(buffered);
      Object.defineProperty(buffered, "unpipe", {
        value: (target: PassThrough) => {
          originalUnpipe(target);
          throw error;
        },
      });
    }

    failUnpipe(closingChannels[0]!.buffered, closingError);
    failUnpipe(
      closingChannels[1]!.buffered,
      new Error("second closing release failed"),
    );
    const managed = createManagedNativeRuntime(
      (handleRuntimeStdio) => ({
        dispose() {
          handleRuntimeStdio(
            closingChannels[0]!.buffered,
            closingChannels[1]!.buffered,
          );
        },
      }),
      { destination },
    );

    await expect(managed.dispose()).rejects.toBe(closingError);
    await expect(managed.dispose()).rejects.toBe(closingError);
    expect(closingChannels.every((channel) => channel.buffered.destroyed)).toBe(
      true,
    );
    expect(pipeListenerCounts(destination)).toEqual(baseline);

    let lateCallback: (stdout: Readable, stderr: Readable) => void = () => {
      throw new Error("stdio callback not registered");
    };
    const closed = createManagedNativeRuntime(
      (handleRuntimeStdio) => {
        lateCallback = handleRuntimeStdio;
        return { dispose() {} };
      },
      { destination },
    );
    await closed.dispose();
    const closedChannels = [runtimeChannel(), runtimeChannel()];
    const closedError = new Error("first closed release failed");
    failUnpipe(closedChannels[0]!.buffered, closedError);
    let caught;
    try {
      lateCallback(closedChannels[0]!.buffered, closedChannels[1]!.buffered);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(closedError);
    expect(closedChannels.every((channel) => channel.buffered.destroyed)).toBe(
      true,
    );
    expect(pipeListenerCounts(destination)).toEqual(baseline);
    destination.write("destination-still-usable\n");
    expect(diagnostics).toBe("destination-still-usable\n");
    expect(destination.destroyed).toBe(false);
    expect(destination.writableEnded).toBe(false);
    for (const channel of [...closingChannels, ...closedChannels]) {
      channel.upstream.destroy();
    }
    destination.destroy();
  });
});

describe("release Worker smoke", () => {
  test("refuses a signaled child even if it printed the expected refusal marker", () => {
    const result = Bun.spawnSync(
      [
        "bun",
        "-e",
        'process.stderr.write("first-owner-persona-switch\\n"); process.kill(process.pid, "SIGTERM");',
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 20_000 },
    );
    expect(result.signalCode).toBe("SIGTERM");
    expect(result.stderr.toString()).toContain("first-owner-persona-switch");
    expect(() => requireSmokeProcessExit(result, 0)).toThrow(
      "Native smoke child did not complete",
    );
  });

  test("verifies the generated artifact's native queue/DLQ and story/media retention", async () => {
    const artifactPath = await buildGeneratedFixture();
    const result = runSmoke(artifactPath);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      kind: "yurucommu.release-worker-smoke@v1",
      runtime: "workerd",
      substrate: "runtime-native-bindings",
      checks: [
        "readyz",
        "discovery",
        "embedded-ui",
        "queue-fanout",
        "queue-dlq",
        "scheduled-retention",
        "scheduled-retention-idempotence",
        "password-login",
        "session-rotation",
        "invalid-password-refusal",
        "authenticated-dm",
        "dm-isolation",
        "media-upload",
        "media-readback",
        "private-media-read-refusal",
        "invalid-media-refusal",
        "unauthenticated-api-refusal",
        "post-write-refusal",
        "public-post-persistence",
        "public-post-readback",
        "public-post-media-visibility",
        "followers-post-persistence",
        "followers-post-readback",
        "followers-post-media-visibility",
        "public-post-activitypub",
        "followers-post-activitypub-refusal",
        "logout-revocation",
      ],
      authentication: { passwordMethods: ["pbkdf2-sha256", "bootstrap"] },
      onboarding: {
        substrate: "fresh-native-bindings",
        cases: ["pbkdf2-sha256", "bootstrap"].flatMap((passwordMethod) =>
          ["browser", "mobile"].map((firstTransport) => ({
            passwordMethod,
            firstTransport,
            owners: 1,
            personas: 1,
            checks: [
              "first-owner-invalid-password-refusal",
              "first-owner-password-creation",
              "first-owner-session-persistence",
              "first-owner-cookie-and-bearer",
              "first-owner-relogin",
              "first-owner-anonymous-create-refusal",
              "first-owner-persona-linkage",
              "first-owner-persona-switch",
            ],
          })),
        ),
      },
      status: "PASSED",
    });
  }, 30_000);

  const fetchAnchor = "    // No origin handling here.";
  for (const [name, injected, error] of [
    [
      "personal profile switch stripping cookie protection",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/switch") {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      const headers = new Headers(response.headers);
      const active = response.headers.get("set-cookie").match(/session=[^;,]+/g).at(-1);
      headers.delete("set-cookie");
      headers.set("set-cookie", active + "; Max-Age=2592000");
      return new Response(response.body, { status: response.status, headers });
    }
`,
      "first-owner-persona-switch",
    ],
    [
      "personal profile list duplicating root instead of returning persona",
      `    if (request.method === "GET" && new URL(request.url).pathname === "/api/auth/accounts") {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      const body = await response.json();
      if (body.accounts?.length === 2) {
        const root = body.accounts.find((account) => account.ap_id.endsWith("/tako"));
        body.accounts = [root, root];
      }
      return Response.json(body, { status: response.status, headers: response.headers });
    }
`,
      "first-owner-persona-linkage",
    ],
    [
      "fresh browser login success without owner or session persistence",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only" && (await env.DB.prepare("SELECT COUNT(*) AS count FROM actors").first()).count === 0) {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=fake-fresh-login; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }
`,
      "first-owner-",
    ],
    [
      "fresh mobile login success without owner or session persistence",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/mobile/login" && (await request.clone().json()).password === "release-smoke-only" && (await env.DB.prepare("SELECT COUNT(*) AS count FROM actors").first()).count === 0) {
      return Response.json({ access_token: "fake-fresh-login", token_type: "Bearer", expires_in: 2592000 });
    }
`,
      "first-owner-",
    ],
    [
      "fresh password login creating a member instead of an owner",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only" && (await env.DB.prepare("SELECT COUNT(*) AS count FROM actors").first()).count === 0) {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      await env.DB.prepare("UPDATE actors SET role = 'member'").run();
      return response;
    }
`,
      "first-owner-",
    ],
    [
      "personal profile promoted to an independent owner",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/accounts") {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      await env.DB.prepare("UPDATE actors SET role = 'owner', owner_actor_ap_id = NULL WHERE preferred_username = 'onboarding_persona'").run();
      return response;
    }
`,
      "first-owner-persona-linkage",
    ],
    [
      "personal profile switch without session rotation",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/switch") {
      return Response.json({ success: true }, { headers: { "set-cookie": request.headers.get("cookie") + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }
`,
      "first-owner-persona-switch",
    ],
    [
      "post attachment followers ActivityPub leaked",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/ap/objects/")) {
      const row = await env.DB.prepare("SELECT * FROM objects WHERE ap_id = ?").bind(env.APP_URL + new URL(request.url).pathname).first();
      if (row?.visibility === "followers") {
        const attachment = JSON.parse(row.attachments_json)[0];
        return Response.json({ id: row.ap_id, type: "Note", attributedTo: row.attributed_to, content: row.content, attachment: [{ type: "Document", mediaType: attachment.content_type, url: env.APP_URL + attachment.url, name: attachment.name }] }, { headers: { "content-type": "application/activity+json" } });
      }
    }
`,
      "followers-post-activitypub-refusal exposed",
    ],
    [
      "post attachment success without persistence",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && request.headers.get("cookie")) {
      const body = await request.clone().json();
      const origin = env.APP_URL;
      return Response.json({ post: { ap_id: origin + "/ap/objects/no-write", type: "Note", author: { ap_id: origin + "/ap/users/release-smoke-sender" }, content: body.content, visibility: body.visibility || "public", attachments: body.attachments } });
    }
`,
      "post-persistence did not persist",
    ],
    [
      "post attachment missing durable fanout",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && request.headers.get("cookie")) {
      const response = await backendApp.fetch(request, wrapYurucommuWorkerBindings(env) as Env, ctx);
      if (response.status === 200) {
        const body = await response.clone().json();
        await env.DB.prepare("DELETE FROM delivery_fanouts WHERE activity_ap_id IN (SELECT ap_id FROM activities WHERE object_ap_id = ?)").bind(body.post.ap_id).run();
      }
      return response;
    }
`,
      "post-fanout did not persist",
    ],
    [
      "post attachment readback losing attachments",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/api/posts/")) {
      const id = decodeURIComponent(new URL(request.url).pathname.slice("/api/posts/".length));
      const row = await env.DB.prepare("SELECT * FROM objects WHERE ap_id = ?").bind(id).first();
      return Response.json({ post: { ap_id: row.ap_id, type: row.type, author: { ap_id: row.attributed_to }, content: row.content, visibility: row.visibility, attachments: [] } });
    }
`,
      "post-readback disagrees",
    ],
    [
      "post attachment public media bytes changed",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND visibility = 'public' AND instr(attachments_json, ?) > 0").bind(new URL(request.url).pathname).first()).count > 0) {
      return new Response(new Uint8Array([0]), { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000" } });
    }
`,
      "public-post-media-readback disagrees",
    ],
    [
      "post attachment followers media leaked",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && !request.headers.get("cookie") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND visibility = 'followers' AND instr(attachments_json, ?) > 0").bind(new URL(request.url).pathname).first()).count > 0) {
      return new Response(Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000" } });
    }
`,
      "followers-post-media-refusal exposed",
    ],
    [
      "post attachment ActivityPub internal storage key leaked",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/ap/objects/")) {
      const row = await env.DB.prepare("SELECT * FROM objects WHERE ap_id = ?").bind(env.APP_URL + new URL(request.url).pathname).first();
      const attachment = JSON.parse(row.attachments_json)[0];
      return Response.json({ id: row.ap_id, type: "Note", attributedTo: row.attributed_to, content: row.content, attachment: [{ type: "Document", mediaType: attachment.content_type, url: env.APP_URL + attachment.url, name: attachment.name, r2_key: attachment.r2_key }] }, { headers: { "content-type": "application/activity+json" } });
    }
`,
      "post-activitypub disagrees",
    ],
    [
      "post attachment accepted anonymous write",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && !request.headers.get("cookie")) {
      return Response.json({ success: true });
    }
`,
      "post-write-refusal accepted",
    ],
    [
      "post attachment accepted revoked write",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && request.headers.get("cookie") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).count === 2) {
      return Response.json({ success: true });
    }
`,
      "logout-revocation accepted a post write",
    ],
    [
      "private media denial with image bytes",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && !request.headers.get("cookie")) {
      return Response.json({ error: "Authentication required", bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==" }, { status: 403, headers: { "cache-control": "no-store" } });
    }\n`,
      "private-media-refusal included non-error content",
    ],
    [
      "revoked private media denial with image bytes",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && request.headers.get("cookie") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).count === 2) {
      return Response.json({ error: "Authentication required", bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==" }, { status: 403, headers: { "cache-control": "no-store" } });
    }\n`,
      "logout-revocation included non-error content",
    ],
    [
      "bootstrap login success without a session row",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && !env.AUTH_PASSWORD_HASH.includes(":") && (await request.clone().json()).password === "release-smoke-only") {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=fake-native-login-session; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }\n`,
      "password-login did not persist",
    ],
    [
      "an accepted invalid password",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only-incorrect") {
      return Response.json({ success: true });
    }\n`,
      "invalid-password-refusal",
    ],
    [
      "login success without a session row",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only") {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=fake-native-login-session; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }\n`,
      "password-login did not persist",
    ],
    [
      "logout success without session revocation",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/logout") {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=; Path=/; Max-Age=0" } });
    }\n`,
      "logout-revocation left",
    ],
    [
      "DM success without durable recipient records",
      `    if (request.method === "POST" && new URL(request.url).pathname.startsWith("/api/dm/user/")) {
      const origin = new URL(request.url).origin;
      return Response.json({ message: { id: origin + "/ap/objects/no-write", content: "release-smoke-dm" }, conversation_id: origin + "/ap/conversations/no-write" }, { status: 201 });
    }\n`,
      "authenticated-dm did not persist",
    ],
    [
      "media success without a stored upload",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/media/upload") {
      return Response.json({ id: "abcdef", url: "/media/abcdef.png", r2_key: "uploads/abcdef.png", content_type: "image/png" });
    }\n`,
      "media-upload did not persist",
    ],
    [
      "DM read by an unrelated session",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/api/dm/user/") && request.headers.get("cookie") === "session=release-smoke-session-unrelated-ecf49f83") {
      const headers = new Headers(request.headers);
      headers.set("cookie", "session=release-smoke-session-recipient-a108328f");
      request = new Request(request, { headers });
    }\n`,
      "DM isolation exposed a message to an unrelated actor",
    ],
  ] as const) {
    test(`rejects ${name}`, async () => {
      const result = runSmoke(
        await buildGeneratedFixture((source) => {
          expect(source).toContain(fetchAnchor);
          return source.replace(fetchAnchor, injected + fetchAnchor);
        }),
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(error);
    }, 30_000);
  }

  for (const [name, transform, error] of [
    [
      "acknowledged queue without an outbox effect",
      (source: string) =>
        source.replace(
          "return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env);",
          "for (const message of queueBatch.messages) message.ack(); return;",
        ),
      "queue-fanout did not persist",
    ],
    [
      "DLQ acknowledgment without its terminal outbox effect",
      (source: string) =>
        source.replace(
          "return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env);",
          'if (queueBatch.queue.endsWith("-dlq")) { for (const message of queueBatch.messages) message.ack(); return; } return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env);',
        ),
      "queue-dlq did not persist",
    ],
    [
      "queue retry",
      (source: string) =>
        source.replace(
          "return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env);",
          "for (const message of queueBatch.messages) message.retry(); return;",
        ),
      "queue-fanout was not explicitly acknowledged",
    ],
    [
      "missing scheduled handler",
      (source: string) =>
        source.replace("async scheduled(", "async disabledScheduled("),
      "scheduled",
    ],
    [
      "scheduled handler without retention effects",
      (source: string) =>
        source.replace("await runRetention(runtimeEnv);", "void runtimeEnv;"),
      "scheduled retention did not preserve",
    ],
  ] as const) {
    test(`rejects ${name}`, async () => {
      const result = runSmoke(await buildGeneratedFixture(transform));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(error);
    }, 30_000);
  }

  test("rejects an HTTP-healthy artifact without background handlers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurucommu-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "yurucommu-worker.js");
    const artifact = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const native =
      typeof env.DB?.prepare === "function" &&
      typeof env.KV?.get === "function" &&
      typeof env.MEDIA?.put === "function";
    if (url.pathname === "/readyz") {
      return Response.json({
        status: native ? "ok" : "misconfigured",
        service: "yurucommu",
        missingBindings: native ? [] : ["DB", "KV", "MEDIA"],
      }, { status: native ? 200 : 503 });
    }
    if (url.pathname === "/.well-known/yurucommu") {
      return Response.json({
        product: "yurucommu",
        server: { canonicalOrigin: env.APP_URL },
      });
    }
    return new Response("<title>Yurucommu</title><div id=\\\"root\\\"></div>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
`;
    await writeFile(artifactPath, artifact);
    const sha256 = createHash("sha256").update(artifact).digest("hex");

    const result = Bun.spawnSync(
      [
        "bun",
        "scripts/smoke-release-worker.mjs",
        artifactPath,
        `sha256:${sha256}`,
      ],
      {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("queue");
  }, 30_000);

  test("rejects bytes that do not match the release digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurucommu-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "yurucommu-worker.js");
    await writeFile(
      artifactPath,
      'export default { fetch() { return new Response("changed"); } };\n',
    );

    const result = Bun.spawnSync(
      [
        "bun",
        "scripts/smoke-release-worker.mjs",
        artifactPath,
        `sha256:${"0".repeat(64)}`,
      ],
      {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("does not equal sha256:");
  });
});
