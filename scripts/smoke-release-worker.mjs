#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { unstable_readConfig } from "wrangler";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const APP_ORIGIN = "https://release-smoke.yurucommu.invalid";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel("release smoke response exceeded its byte limit");
        throw new Error(
          `release smoke response exceeds ${MAX_RESPONSE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requireJson(response, label) {
  const text = await boundedText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 200)}`);
  }
}

async function smokeNativeWorker(artifactPath, artifactDigest) {
  const sourceConfig = unstable_readConfig(
    { config: resolve(repo, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  if (!sourceConfig.compatibility_date) {
    throw new Error("wrangler.jsonc must declare compatibility_date");
  }
  const worker = new Miniflare({
    rootPath: dirname(artifactPath),
    modules: [{ type: "ESModule", path: artifactPath }],
    modulesRoot: dirname(artifactPath),
    compatibilityDate: sourceConfig.compatibility_date,
    compatibilityFlags: sourceConfig.compatibility_flags,
    cf: false,
    bindings: {
      APP_URL: APP_ORIGIN,
      AUTH_PASSWORD_HASH: "release-smoke-only",
      DELIVERY_QUEUE_NAME: "yurucommu-delivery",
      DELIVERY_DLQ_NAME: "yurucommu-delivery-dlq",
      ENCRYPTION_KEY: "00".repeat(32),
    },
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["MEDIA"],
    queueProducers: ["DELIVERY_QUEUE", "DELIVERY_DLQ"],
  });

  try {
    await worker.ready;

    const readyResponse = await worker.dispatchFetch(`${APP_ORIGIN}/readyz`, {
      headers: { accept: "application/json" },
    });
    const ready = await requireJson(readyResponse, "/readyz");
    if (
      readyResponse.status !== 200 ||
      ready.status !== "ok" ||
      ready.service !== "yurucommu" ||
      !Array.isArray(ready.missingBindings) ||
      ready.missingBindings.length !== 0
    ) {
      throw new Error(
        `/readyz did not accept the runtime-native bindings: ${JSON.stringify(ready)}`,
      );
    }

    const discoveryResponse = await worker.dispatchFetch(
      `${APP_ORIGIN}/.well-known/yurucommu`,
      { headers: { accept: "application/json" } },
    );
    const discovery = await requireJson(
      discoveryResponse,
      "/.well-known/yurucommu",
    );
    if (
      discoveryResponse.status !== 200 ||
      discovery.product !== "yurucommu" ||
      discovery.server?.canonicalOrigin !== APP_ORIGIN
    ) {
      throw new Error(
        `discovery did not expose the expected identity: ${JSON.stringify(discovery)}`,
      );
    }

    const uiResponse = await worker.dispatchFetch(`${APP_ORIGIN}/`, {
      headers: { accept: "text/html" },
    });
    const ui = await boundedText(uiResponse);
    if (
      uiResponse.status !== 200 ||
      !uiResponse.headers.get("content-type")?.includes("text/html") ||
      !ui.includes("<title>Yurucommu</title>") ||
      !ui.includes('id="root"')
    ) {
      throw new Error("embedded Yurucommu UI did not boot from the artifact");
    }

    return {
      kind: "yurucommu.release-worker-smoke@v1",
      artifact: basename(artifactPath),
      sha256: `sha256:${artifactDigest}`,
      runtime: "workerd",
      compatibilityDate: sourceConfig.compatibility_date,
      compatibilityFlags: sourceConfig.compatibility_flags,
      substrate: "runtime-native-bindings",
      checks: ["readyz", "discovery", "embedded-ui"],
      status: "PASSED",
    };
  } finally {
    await worker.dispose();
  }
}

async function main() {
  const [artifactArgument, expectedDigestArgument] = process.argv.slice(2);
  if (!artifactArgument || process.argv.length > 4) {
    throw new Error(
      "usage: bun scripts/smoke-release-worker.mjs <worker.js> [sha256:<digest>]",
    );
  }
  const artifactPath = resolve(process.cwd(), artifactArgument);
  if (!statSync(artifactPath).isFile()) {
    throw new Error(`${artifactArgument} is not a Worker artifact file`);
  }
  const artifactDigest = sha256(readFileSync(artifactPath));
  if (
    expectedDigestArgument !== undefined &&
    expectedDigestArgument !== `sha256:${artifactDigest}`
  ) {
    throw new Error(
      `artifact digest sha256:${artifactDigest} does not equal ${expectedDigestArgument}`,
    );
  }
  const result = await smokeNativeWorker(artifactPath, artifactDigest);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
