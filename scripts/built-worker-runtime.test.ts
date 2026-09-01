import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import type {
  PortableKeyValueBinding,
  PortableObjectBucket,
  PortableQueueProducer,
  PortableSQLiteBinding,
  YurucommuPortableBindings,
} from "./runtime-ports.ts";

const artifactUrl = new URL("../dist/yurucommu-worker.js", import.meta.url);

type RuntimeTrace = {
  db: { execute: number; query: number; transaction: number };
  kv: { get: number; put: number; delete: number; list: number };
  media: {
    head: number;
    get: number;
    put: number;
    delete: number;
    list: number;
  };
  queue: { send: number; sendBatch: number };
};

function createRuntimeTrace(): RuntimeTrace {
  return {
    db: { execute: 0, query: 0, transaction: 0 },
    kv: { get: 0, put: 0, delete: 0, list: 0 },
    media: { head: 0, get: 0, put: 0, delete: 0, list: 0 },
    queue: { send: 0, sendBatch: 0 },
  };
}

function portableBindings(
  trace = createRuntimeTrace(),
  options: { readonly exerciseMediaAndProducer?: boolean } = {},
): {
  bindings: YurucommuPortableBindings;
  trace: RuntimeTrace;
} {
  const db: PortableSQLiteBinding = {
    async execute() {
      trace.db.execute += 1;
      return { rows: [], rowsWritten: 0 };
    },
    async query(sql) {
      trace.db.query += 1;
      if (options.exerciseMediaAndProducer) {
        const normalized = sql.toLowerCase();
        if (
          normalized.includes("notification_push_jobs") &&
          normalized.includes("next_attempt_at")
        ) {
          return { rows: [{ id: "artifact-smoke-job" }], rowsWritten: 0 };
        }
        if (normalized.includes("media_uploads")) {
          return {
            rows: [{ uploaderApId: "https://portable.yurucommu.test/actor" }],
            rowsWritten: 0,
          };
        }
        if (normalized.includes("from actors")) {
          return {
            rows: [{ apId: "https://portable.yurucommu.test/actor" }],
            rowsWritten: 0,
          };
        }
      }
      return { rows: [], rowsWritten: 0 };
    },
    async transaction(statements) {
      trace.db.transaction += statements.length;
      return {
        results: statements.map(() => ({ rows: [], rowsWritten: 0 })),
      };
    },
  };
  const kv: PortableKeyValueBinding = {
    async get() {
      trace.kv.get += 1;
      return null;
    },
    async getWithMetadata() {
      trace.kv.get += 1;
      return { value: null };
    },
    async put() {
      trace.kv.put += 1;
    },
    async delete() {
      trace.kv.delete += 1;
    },
    async list() {
      trace.kv.list += 1;
      return { keys: [], listComplete: true };
    },
  };
  const media: PortableObjectBucket = {
    async head() {
      trace.media.head += 1;
      return { etag: "portable-etag", size: 3, contentType: "image/png" };
    },
    async get() {
      trace.media.get += 1;
      return {
        etag: "portable-etag",
        size: 3,
        contentType: "image/png",
        bodyStream: true,
        partial: false,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
      };
    },
    async put() {
      trace.media.put += 1;
      return { etag: "portable-etag", size: 3 };
    },
    async delete() {
      trace.media.delete += 1;
    },
    async list() {
      trace.media.list += 1;
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      return { uploadId: "portable-upload" };
    },
    async uploadPart() {
      return { etag: "portable-part" };
    },
    async completeMultipartUpload() {
      return { etag: "portable-etag", size: 3 };
    },
    async abortMultipartUpload() {},
  };
  const queue: PortableQueueProducer = {
    async send() {
      trace.queue.send += 1;
      return { messageId: `portable-message-${trace.queue.send}` };
    },
    async sendBatch(messages) {
      trace.queue.sendBatch += 1;
      return {
        messageIds: messages.map(
          (_, index) => `portable-batch-${trace.queue.sendBatch}-${index}`,
        ),
      };
    },
  };
  return {
    trace,
    bindings: {
      APP_URL: "https://portable.yurucommu.test",
      ENCRYPTION_KEY: "a".repeat(64),
      AUTH_PASSWORD_HASH: "portable-test-password-hash",
      DB: db,
      KV: kv,
      MEDIA: media,
      DELIVERY_QUEUE: queue,
      DELIVERY_DLQ: queue,
      DELIVERY_QUEUE_NAME: "portable-delivery",
      DELIVERY_DLQ_NAME: "portable-delivery-dlq",
    },
  };
}

describe("built Worker portable runtime", () => {
  test("imports and serves a health probe with portable bindings", async () => {
    const worker = await import(`${artifactUrl.href}?portable-runtime-test`);
    const { bindings } = portableBindings();
    const response = await worker.default.fetch(
      new Request("https://portable.yurucommu.test/healthz"),
      bindings,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      service: "yurucommu",
    });
  });

  test("invokes fetch, queue, and scheduled paths across portable ports", async () => {
    const worker = await import(`${artifactUrl.href}?portable-runtime-paths`);
    const { bindings, trace } = portableBindings(createRuntimeTrace(), {
      exerciseMediaAndProducer: true,
    });

    // Auth provider discovery passes through the real API rate limiter, which
    // proves that the byte-valued KV projection is usable from the artifact.
    const providers = await worker.default.fetch(
      new Request("https://portable.yurucommu.test/api/auth/providers"),
      bindings,
      {} as ExecutionContext,
    );
    expect(providers.status).toBe(200);
    expect(trace.kv.get).toBeGreaterThan(0);

    const media = await worker.default.fetch(
      new Request(
        "https://portable.yurucommu.test/media/00000000000000000000000000000000.png",
      ),
      bindings,
      {} as ExecutionContext,
    );
    expect(media.status).toBe(200);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(trace.media.get).toBe(1);

    const body = btoa(JSON.stringify({ invalid: true }));
    const dbQueriesBeforeQueue = trace.db.query;
    await expect(
      worker.default.queue(
        {
          batchId: "portable-batch-1",
          queue: "portable-delivery",
          messages: [
            {
              id: "portable-message-1",
              timestampMillis: 1_756_435_200_000,
              body: { encoding: "base64", data: body },
              attempts: 1,
            },
          ],
        },
        bindings,
      ),
    ).rejects.toThrow("portable_queue_settlement_unavailable");
    expect(trace.db.query).toBe(dbQueriesBeforeQueue);

    await worker.default.scheduled(
      {
        cron: "0 3 * * *",
        scheduledTime: 1_756_435_200_000,
      },
      bindings,
      {} as ExecutionContext,
    );
    expect(trace.db.query).toBeGreaterThan(1);
    expect(trace.queue.sendBatch).toBeGreaterThan(0);
  });

  test("keeps media, producer, and event paths inside the built artifact", async () => {
    const source = await readFile(artifactUrl, "utf8");
    const testSource = await readFile(
      new URL("./built-worker-runtime.test.ts", import.meta.url),
      "utf8",
    );
    // The artifact must be self-contained: source helpers are bundled into it,
    // while no runtime import can escape to scripts/ at invocation time.
    expect(source).not.toContain('from "../scripts/runtime-ports.ts"');
    expect(source).toContain("portable_queue_settlement_unavailable");
    expect(testSource).not.toMatch(
      /^import\s+\{[^\n]*\}\s+from\s+["']\.\/runtime-ports\.ts["']/mu,
    );
    for (const forbidden of [
      "TAKOSUMI_MANAGED_RUNTIME",
      "managed-runtime-connections",
      "TakosumiBackgroundEvent",
      "@takosjp/takosumi-contract",
      "handleTakosumiBackgroundEventInvocation",
      "takosumi-managed-worker",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
