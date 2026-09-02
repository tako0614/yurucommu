import { build, stop } from "esbuild";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";

import { PRODUCT_WIRE_IDENTITY } from "../src/product-identity.ts";

type StaticAsset = {
  contentType: string;
  body: string;
};

const rootDir = new URL("../", import.meta.url);
const distDir = new URL("../dist/", import.meta.url);
const tempEntryFile = new URL(
  "../dist/yurucommu-entry.generated.ts",
  import.meta.url,
);
const outputFile = new URL("../dist/yurucommu-worker.js", import.meta.url);

// Wire identity is never spelled out here. It is baked into the deployed
// Worker, so a literal in this file is the one copy nobody can compare against
// the clients that read it. See src/product-identity.ts.
const discovery = PRODUCT_WIRE_IDENTITY;
const browserMedia = {
  // The QR scanner is a product surface. Yurucommu currently has no
  // microphone/RTC UI, so do not grant microphone access merely because the
  // shared family server can host one.
  camera: true,
  microphone: false,
} as const;

function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

async function collectAssets(
  dir: URL,
  assets: Record<string, StaticAsset>,
  prefix = "",
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const relativePath = `${prefix}${entry.name}`;
    const url = new URL(entry.name, dir);
    if (entry.isDirectory()) {
      await collectAssets(
        new URL(`${entry.name}/`, dir),
        assets,
        `${relativePath}/`,
      );
      continue;
    }
    if (
      !entry.isFile() ||
      relativePath === "yurucommu-worker.js" ||
      relativePath === "yurucommu-entry.generated.ts"
    ) {
      continue;
    }
    const bytes = await readFile(url);
    assets[relativePath] = {
      contentType: contentTypeFor(relativePath),
      body: bytesToBase64(bytes),
    };
  }
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: rootDir.pathname,
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
}

export function createEntrySource(assets: Record<string, StaticAsset>): string {
  return `import {
  createYurucommuBackendApp,
  handleYurucommuQueueBatch,
  runYurucommuRetention,
  withRequiredBackgroundPublicOrigin,
  wrapRuntimeMessageBatch,
} from "@takosjp/yurucommu-core/server";
import type {
  DeliveryDlqMessageV1,
  DeliveryQueueMessageV1,
  EdgeQueueBatch,
  Env,
  IQueueBatch,
} from "@takosjp/yurucommu-core/server";
import {
  resolveYurucommuRuntimeLane,
  wrapYurucommuWorkerBindings,
} from "../scripts/yurucommu-worker-bindings.ts";
import type {
  YurucommuRuntimeEnv,
  YurucommuWorkerBindings,
} from "../scripts/yurucommu-worker-bindings.ts";
import type {
  Fetcher,
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";

type RuntimeEnv = YurucommuRuntimeEnv;
type WorkerBindings = YurucommuWorkerBindings;
type DeliveryMessage = DeliveryQueueMessageV1 | DeliveryDlqMessageV1;
// Whichever shape the lane's host hands the queue handler: Cloudflare's
// MessageBatch (ack/ackAll) or the edge.queue facade batch (acknowledgeAll).
type DeliveryEvent = MessageBatch<DeliveryMessage> | EdgeQueueBatch;

const backendApp = createYurucommuBackendApp({
  discovery: ${JSON.stringify(discovery, null, 2)},
  browserMedia: ${JSON.stringify(browserMedia, null, 2)},
});
const EMBEDDED_ASSETS = ${JSON.stringify(assets, null, 2)};

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isNavigationRequest(request: Request): boolean {
  return (request.method === "GET" || request.method === "HEAD") &&
    (request.headers.get("accept") ?? "").includes("text/html");
}

function hasFileExtension(pathname: string): boolean {
  const segment = pathname.split("/").pop() ?? "";
  return segment.includes(".");
}

function resolveAssetPath(request: Request): string {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "" || pathname === "/") return "index.html";
  if (pathname.endsWith("/")) pathname += "index.html";
  return pathname.startsWith("/") ? pathname.slice(1) : pathname;
}

function createAssetResponse(assetPath: string, request: Request): Response {
  const asset = EMBEDDED_ASSETS[assetPath];
  if (!asset) return new Response("Not found", { status: 404 });
  const body = request.method === "HEAD" ? null : decodeBase64(asset.body);
  return new Response(body, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": assetPath === "index.html"
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    },
  });
}

const embeddedAssetsFetcher: Fetcher = {
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const assetPath = resolveAssetPath(request);
    const resolvedAsset = EMBEDDED_ASSETS[assetPath]
      ? assetPath
      : (!hasFileExtension(assetPath) && isNavigationRequest(request))
      ? "index.html"
      : undefined;
    if (!resolvedAsset) return new Response("Not found", { status: 404 });
    return createAssetResponse(resolvedAsset, request);
  },
};

async function runRetention(runtimeEnv: RuntimeEnv): Promise<void> {
  // The core retention implementation consumes DB/MEDIA/queue only. APP_URL
  // is intentionally not invented for this native scheduled invocation.
  await runYurucommuRetention(runtimeEnv as Env);
}

// Takes the ALREADY WRAPPED batch, not the raw event. Both lanes carry a queue
// name — Cloudflare's \`MessageBatch.queue\` and the facade's
// \`EdgeQueueBatch.queue\` — and \`wrapRuntimeMessageBatch\` copies it straight
// through, so reading it here is one lane-independent read of exactly the value
// \`handleYurucommuQueueBatch\` will compare its own configured names against.
function withDeliveryConsumerIdentity(
  batch: IQueueBatch<DeliveryMessage>,
  env: RuntimeEnv,
): RuntimeEnv {
  const configuredDelivery = env.DELIVERY_QUEUE_NAME?.trim() ?? "";
  const configuredDlq = env.DELIVERY_DLQ_NAME?.trim() ?? "";
  if ((configuredDelivery.length > 0) !== (configuredDlq.length > 0)) {
    throw new Error("Direct queue identities must declare delivery and DLQ together");
  }
  if (configuredDelivery && configuredDlq) {
    return env; // The direct adapter already declares both distinct queue identities.
  }

  const queueName = batch.queue.trim();
  if (!queueName) {
    throw new Error("Queue invocation has no native identity");
  }
  // The Takoform graph attaches exactly one QueueConsumer to this Worker, and
  // that relation targets the delivery queue. The Provider is free to replace
  // the logical Resource name with a collision-safe native name, so the app
  // uses the authenticated invocation identity there. The direct Cloudflare
  // adapter returns above with its separately configured delivery and DLQ
  // identities intact because it attaches consumers for both queues.
  return {
    ...env,
    DELIVERY_QUEUE_NAME: queueName,
    DELIVERY_DLQ_NAME: "__unbound_dlq__:" + queueName,
  };
}

function applyProductBrowserMediaPolicy(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=()",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(
    request: Request,
    env: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // No origin handling here. \`createYurucommuBackendApp\` registers the
    // core's public-origin middleware before every route, so the portable lane
    // establishes this instance's origin from the request and pins it, and the
    // cloudflare lane keeps requiring an explicit \`APP_URL\` — one rule, owned
    // by the package that mints the actor ids from it.
    const bindings = wrapYurucommuWorkerBindings(env);
    const runtimeEnv = bindings.ASSETS
      ? bindings
      : { ...bindings, ASSETS: embeddedAssetsFetcher };
    return applyProductBrowserMediaPolicy(
      await backendApp.fetch(request, runtimeEnv as Env, ctx),
    );
  },

  async queue(
    batch: DeliveryEvent,
    env: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    // The lane decides the batch's shape as much as the bindings', so both are
    // adapted from the one declaration. A batch whose shape contradicts it
    // (a facade batch on the cloudflare lane, or the reverse) is refused.
    const lane = resolveYurucommuRuntimeLane(env);
    const queueBatch = wrapRuntimeMessageBatch<DeliveryMessage>(batch, lane);
    // Federation delivery signs from this instance's own actor ids and there is
    // no request to read the origin off. \`APP_URL\`, then the pinned origin,
    // then a \`PublicOriginError\` — the batch is retried once traffic has
    // established one, rather than delivered under \`undefined/ap/users/...\`.
    const runtimeEnv = withDeliveryConsumerIdentity(
      queueBatch,
      await withRequiredBackgroundPublicOrigin(
        wrapYurucommuWorkerBindings(env) as Env,
      ),
    );
    void ctx;
    return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env);
  },

  // Cron-triggered retention (delivery/session/call-session purge, media-orphan
  // GC, story expiry, tombstone reap). This entry builds its own default object
  // instead of re-exporting the core one, so a cron trigger alone would fire at
  // a module that exports no \`scheduled\` and nothing would ever be purged —
  // the handler has to be forwarded here. The runtime-neutral core entrypoint
  // receives the already adapted Env from whichever lane this deployment
  // declared; an older core fails loudly rather than silently sweeping nothing.
  async scheduled(
    controller: ScheduledController,
    env: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    void controller;
    void ctx;
    const runtimeEnv = wrapYurucommuWorkerBindings(env);
    await runRetention(runtimeEnv);
  },
};
`;
}

export async function main(): Promise<void> {
  await run(["bun", "run", "build:client"]);
  const assets: Record<string, StaticAsset> = {};
  await collectAssets(distDir, assets);
  await writeFile(tempEntryFile, createEntrySource(assets));
  try {
    await build({
      entryPoints: [tempEntryFile.pathname],
      outfile: outputFile.pathname,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
    });
  } finally {
    stop();
    await rm(tempEntryFile).catch(() => undefined);
  }
}

if (import.meta.main) {
  await main();
}
