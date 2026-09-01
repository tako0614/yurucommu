import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";

import { createEntrySource } from "./build-yurucommu-worker.ts";
import {
  assertPortableQueueSettlementSupported,
  createPortableDatabase,
  createPortableKeyValueStore,
  createPortableObjectStorage,
  createPortableQueueProducer,
  type PortableKeyValueBinding,
  type PortableObjectBucket,
  type PortableObjectBody,
  type PortableQueueProducer,
  type PortableSQLiteBinding,
  wrapYurucommuMessageBatch,
  isPortableQueueBatch,
  wrapYurucommuWorkerBindings,
  type YurucommuWorkerBindings,
} from "./runtime-ports.ts";

function nativeBindings(): YurucommuWorkerBindings {
  return {
    APP_URL: "https://yurucommu.example.test",
    DELIVERY_QUEUE_NAME: "yurucommu-delivery",
    DELIVERY_DLQ_NAME: "yurucommu-delivery-dlq",
    DB: {
      prepare() {
        throw new Error("DB must not be called by this port test");
      },
    },
    KV: {
      get: async () => null,
      getWithMetadata: async () => ({ value: null }),
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true }),
    },
  } as unknown as YurucommuWorkerBindings;
}

describe("Yurucommu runtime ports", () => {
  test("materializes ordinary Worker bindings without a host gateway", () => {
    const runtime = wrapYurucommuWorkerBindings(nativeBindings());

    expect(runtime.DB_INSTANCE).toBeDefined();
    expect(runtime.KV).toBeDefined();
    expect(runtime).not.toHaveProperty("TAKOSUMI_MANAGED_RUNTIME");
    expect(runtime).not.toHaveProperty(
      "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION",
    );
  });

  test("keeps the public app URL constrained to an HTTPS origin", () => {
    expect(() =>
      wrapYurucommuWorkerBindings({
        ...nativeBindings(),
        APP_URL: "https://yurucommu.example.test/app",
      }),
    ).toThrow("APP_URL must be an exact HTTPS origin");
  });

  test("adapts a native queue batch while preserving ack and retry", () => {
    let acknowledged = false;
    let retried = false;
    const batch = {
      queue: "yurucommu-delivery",
      messages: [
        {
          id: "message-1",
          timestamp: new Date("2026-08-29T00:00:00.000Z"),
          body: {
            version: 1,
            type: "deliver_endpoint",
            jobId: "job-1",
            scheduledAt: "2026-08-29T00:00:00.000Z",
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        },
      ],
      ackAll() {
        acknowledged = true;
      },
      retryAll() {
        retried = true;
      },
    };

    const runtimeBatch = wrapYurucommuMessageBatch(batch as never);
    expect(runtimeBatch.queue).toBe("yurucommu-delivery");
    runtimeBatch.messages[0]?.ack();
    expect(acknowledged).toBe(true);
    runtimeBatch.retryAll();
    expect(retried).toBe(true);
  });

  test("normalizes portable SQLite, byte KV, object, and queue bindings", async () => {
    const calls: string[] = [];
    const portableDb: PortableSQLiteBinding = {
      async execute(statement, params) {
        calls.push(`execute:${statement}:${JSON.stringify(params ?? [])}`);
        return { rows: [], rowsWritten: 1 };
      },
      async query(statement, params) {
        calls.push(`query:${statement}:${JSON.stringify(params ?? [])}`);
        return {
          rows: [
            {
              n: 1.5,
              t: "portable",
              b: { encoding: "base64", data: "AAEC" },
              z: null,
            },
          ],
          rowsWritten: 0,
        };
      },
      async transaction(statements) {
        calls.push(`transaction:${statements.length}`);
        return {
          results: statements.map(() => ({ rows: [], rowsWritten: 1 })),
        };
      },
    };
    const kvCalls: Array<{ key: string; bytes: Uint8Array }> = [];
    const portableKv: PortableKeyValueBinding = {
      async get() {
        return new Uint8Array([0, 1, 2]).buffer;
      },
      async getWithMetadata() {
        return { value: new Uint8Array([0, 1, 2]).buffer };
      },
      async put(key, value) {
        kvCalls.push({
          key,
          bytes: new Uint8Array(
            value instanceof ArrayBuffer
              ? value
              : await new Response(value as BodyInit).arrayBuffer(),
          ),
        });
      },
      async delete() {},
      async list() {
        return { keys: [{ name: "key" }], listComplete: true };
      },
    };
    const objectCalls: Array<{ key: string; bytes: Uint8Array }> = [];
    const portableObject: PortableObjectBucket = {
      async head() {
        return { etag: "etag-1", size: 3, contentType: "image/png" };
      },
      async get() {
        return {
          etag: "etag-1",
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
      async put(key, body) {
        objectCalls.push({
          key,
          bytes: new Uint8Array(
            body instanceof ArrayBuffer
              ? body
              : await new Response(body as BodyInit).arrayBuffer(),
          ),
        });
        return { etag: "etag-2", size: 2 };
      },
      async delete() {},
      async list() {
        return {
          objects: [
            {
              key: "folder/object",
              size: 3,
              etag: "etag-1",
              uploadedAtMillis: 1_756_435_200_000,
            },
          ],
          prefixes: ["folder/"],
          truncated: true,
          cursor: "next",
        };
      },
      async createMultipartUpload() {
        return { uploadId: "upload-1" };
      },
      async uploadPart() {
        return { etag: "part-1" };
      },
      async completeMultipartUpload() {
        return { etag: "etag-complete", size: 0 };
      },
      async abortMultipartUpload() {},
    };
    const queueCalls: Array<Uint8Array> = [];
    const portableQueue: PortableQueueProducer = {
      async send(body) {
        queueCalls.push(
          new Uint8Array(
            body instanceof ArrayBuffer
              ? body
              : await new Response(body as BodyInit).arrayBuffer(),
          ),
        );
        return { messageId: "message-1" };
      },
      async sendBatch(messages) {
        for (const message of messages) {
          queueCalls.push(
            new Uint8Array(
              message.body instanceof ArrayBuffer
                ? message.body
                : await new Response(message.body as BodyInit).arrayBuffer(),
            ),
          );
        }
        return { messageIds: messages.map(() => "message") };
      },
    };

    const runtime = wrapYurucommuWorkerBindings({
      APP_URL: "https://portable.yurucommu.test",
      ENCRYPTION_KEY: "a".repeat(64),
      AUTH_PASSWORD_HASH: "password-hash",
      DB: portableDb,
      KV: portableKv,
      MEDIA: portableObject,
      DELIVERY_QUEUE: portableQueue,
      DELIVERY_DLQ: portableQueue,
      DELIVERY_QUEUE_NAME: "delivery",
      DELIVERY_DLQ_NAME: "delivery-dlq",
    });

    const queryResult = (await runtime.DB_INSTANCE.all(
      sql.raw("SELECT 1"),
    )) as unknown[][];
    expect(queryResult).toHaveLength(1);
    expect(queryResult[0]?.slice(0, 2)).toEqual([1.5, "portable"]);
    expect(queryResult[0]?.[2]).toBeInstanceOf(ArrayBuffer);
    expect(queryResult[0]?.[3]).toBeNull();
    await runtime.DB_INSTANCE.run(sql.raw("UPDATE items SET n = 1"));
    expect(calls.some((call) => call.startsWith("query:SELECT 1"))).toBe(true);
    expect(calls.some((call) => call.startsWith("execute:UPDATE items"))).toBe(
      true,
    );
    const items = sqliteTable("items", { n: integer("n") });
    const drizzleDb = runtime.DB_INSTANCE as unknown as {
      batch(queries: unknown[]): Promise<unknown>;
    };
    await drizzleDb.batch([
      runtime.DB_INSTANCE.select({ n: items.n }).from(items),
      runtime.DB_INSTANCE.select({ n: items.n }).from(items),
    ]);
    expect(calls).toContain("transaction:2");

    const kv = createPortableKeyValueStore(portableKv);
    expect(await kv.get("key", { type: "arrayBuffer" })).toEqual(
      new Uint8Array([0, 1, 2]).buffer,
    );
    await kv.put("key", new Uint8Array([3, 4, 5]).buffer);
    expect([...kvCalls[0]!.bytes]).toEqual([3, 4, 5]);

    const media = createPortableObjectStorage(portableObject);
    await media.put("image", new Uint8Array([6, 7]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });
    expect(objectCalls[0]).toEqual({
      key: "image",
      bytes: new Uint8Array([6, 7]),
    });
    expect([
      ...new Uint8Array(await (await media.get("image"))!.arrayBuffer()),
    ]).toEqual([1, 2, 3]);
    expect(await media.list({ delimiter: "/" })).toMatchObject({
      objects: [
        {
          key: "folder/object",
          size: 3,
          etag: "etag-1",
          uploaded: new Date(1_756_435_200_000),
        },
      ],
      truncated: true,
      cursor: "next",
      delimitedPrefixes: ["folder/"],
    });

    const queue = createPortableQueueProducer(portableQueue);
    await queue.send({ event: "created" });
    expect(JSON.parse(new TextDecoder().decode(queueCalls[0]!))).toEqual({
      event: "created",
    });
  });

  test("keeps portable object put/get bodies lazy and chunked", async () => {
    let putPulls = 0;
    let putBody: PortableObjectBody | undefined;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        putPulls += 1;
        if (putPulls === 1) controller.enqueue(new Uint8Array([1, 2]));
        else if (putPulls === 2) controller.enqueue(new Uint8Array([3, 4]));
        else controller.close();
      },
    });
    Object.defineProperty(source, "contentLength", { value: 4 });
    await Promise.resolve();

    let getPulls = 0;
    const binding: PortableObjectBucket = {
      async head() {
        return null;
      },
      async put(_key, body, options) {
        putBody = body;
        expect(options.contentLength).toBe(4);
        return { etag: "etag", size: 4 };
      },
      async get() {
        return {
          etag: "etag",
          size: 4,
          bodyStream: true as const,
          partial: false,
          body: new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                getPulls += 1;
                if (getPulls === 1) controller.enqueue(new Uint8Array([5, 6]));
                else if (getPulls === 2)
                  controller.enqueue(new Uint8Array([7, 8]));
                else controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        };
      },
      async delete() {},
      async list() {
        return { objects: [], truncated: false };
      },
      async createMultipartUpload() {
        return { uploadId: "upload" };
      },
      async uploadPart() {
        return { etag: "part" };
      },
      async completeMultipartUpload() {
        return { etag: "etag", size: 4 };
      },
      async abortMultipartUpload() {},
    };

    const media = createPortableObjectStorage(binding);
    const pullsBeforePut = putPulls;
    await media.put("stream", source);
    expect(putPulls).toBe(pullsBeforePut);
    expect(putBody).toBe(source);

    const object = await media.get("stream");
    expect(object).not.toBeNull();
    expect(getPulls).toBe(0);
    const reader = object!.body!.getReader();
    const chunks: number[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(...result.value);
    }
    expect(chunks).toEqual([5, 6, 7, 8]);
    expect(getPulls).toBe(3);
    expect(object!.bodyUsed).toBe(true);
  });

  test("rejects an object stream without an explicit known size", async () => {
    const binding = {
      put: async () => ({ etag: "etag", size: 0 }),
    } as unknown as PortableObjectBucket;
    const media = createPortableObjectStorage(binding);
    const stream = new ReadableStream<Uint8Array>();
    await expect(media.put("unknown", stream)).rejects.toThrow(
      "portable_object_content_length_required",
    );
  });

  test("recognizes portable queue events but fails closed without host settlement", () => {
    const body = btoa(
      JSON.stringify({
        version: 1,
        type: "deliver_endpoint",
        jobId: "job-1",
        scheduledAt: "2026-08-29T00:00:00.000Z",
      }),
    );
    const secondBody = btoa(
      JSON.stringify({
        version: 1,
        type: "deliver_endpoint",
        jobId: "job-2",
        scheduledAt: "2026-08-29T00:00:00.000Z",
      }),
    );
    const batch = {
      batchId: "batch-1",
      queue: "delivery",
      messages: [
        {
          id: "message-1",
          timestampMillis: 1_756_435_200_000,
          body: { encoding: "base64" as const, data: body },
          attempts: 2,
        },
        {
          id: "message-2",
          timestampMillis: 1_756_435_200_001,
          body: { encoding: "base64" as const, data: secondBody },
          attempts: 1,
        },
      ],
    };
    expect(isPortableQueueBatch(batch)).toBe(true);
    expect(() => assertPortableQueueSettlementSupported(batch)).toThrow(
      "portable_queue_settlement_unavailable",
    );
    expect(() => wrapYurucommuMessageBatch(batch)).toThrow(
      "portable_queue_settlement_unavailable",
    );
  });

  test("does not add private ack/retry methods to portable input", () => {
    const body = btoa(
      JSON.stringify({
        version: 1,
        type: "deliver_endpoint",
        jobId: "job-1",
        scheduledAt: "2026-08-29T00:00:00.000Z",
      }),
    );
    const batch = {
      batchId: "batch-2",
      queue: "delivery",
      messages: [
        {
          id: "message-1",
          timestampMillis: 1_756_435_200_000,
          body: { encoding: "base64", data: body },
          attempts: 1,
        },
      ],
    };
    expect(batch.messages[0]).not.toHaveProperty("ack");
    expect(batch.messages[0]).not.toHaveProperty("retry");
    expect(batch).not.toHaveProperty("ackAll");
    expect(batch).not.toHaveProperty("retryAll");
  });

  test("rejects malformed portable envelopes before native settlement access", () => {
    const malformed = {
      batchId: "batch-malformed",
      queue: "delivery",
      messages: [
        {
          id: "message-malformed",
          // timestampMillis/body are intentionally absent: this is still a
          // worker.runtime envelope and must not be cast to MessageBatch.
        },
      ],
    };

    expect(isPortableQueueBatch(malformed)).toBe(false);
    expect(() => assertPortableQueueSettlementSupported(malformed)).toThrow(
      "portable_queue_batch_invalid",
    );
    expect(() => wrapYurucommuMessageBatch(malformed as never)).toThrow(
      "portable_queue_batch_invalid",
    );
  });

  test("rejects native-shaped batches without complete host settlement", () => {
    const malformedNative = {
      queue: "delivery",
      messages: [{ id: "message-1", body: {} }],
      ackAll() {},
      retryAll() {},
    };

    expect(() =>
      assertPortableQueueSettlementSupported(malformedNative),
    ).toThrow("native_queue_settlement_unavailable");
  });
});

describe("generated neutral Worker entry", () => {
  const source = createEntrySource({});

  test("uses ordinary queue and schedule entrypoints", () => {
    expect(source).toContain("wrapYurucommuWorkerBindings(env)");
    expect(source).toContain("wrapYurucommuMessageBatch(batch)");
    expect(source).toContain("handleYurucommuQueueBatch(");
    expect(source).toContain("async scheduled(");
    expect(source).toContain("runYurucommuRetention");
    expect(source).not.toContain("handleTakosumiBackgroundEventInvocation");
    expect(source).toContain("PortableScheduledEvent");
    expect(source).toContain("assertPortableQueueSettlementSupported");
    expect(source).not.toContain("assertYurucommuPortableBatchSucceeded");
    expect(source).not.toContain("throwWithYurucommuPortableBatchSettlement");
    expect(source).not.toContain(".settlement");
    expect(source).not.toContain("Object.defineProperty(error");
  });

  test("contains no private host runtime or background ABI references", () => {
    for (const forbidden of [
      "TAKOSUMI_MANAGED_RUNTIME",
      "managed-runtime-connections",
      "TakosumiBackgroundEvent",
      "@takosjp/takosumi-contract",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("runtime port source ownership", () => {
  test("has no retired managed-worker production filename or import", async () => {
    const entries = await readdir(new URL("./", import.meta.url), {
      withFileTypes: true,
    });
    const productionScripts = entries.filter(
      (entry) => entry.isFile() && !entry.name.endsWith(".test.ts"),
    );

    expect(
      productionScripts.some((entry) =>
        entry.name.includes("takosumi-managed-worker"),
      ),
    ).toBe(false);
    const source = await Promise.all(
      productionScripts.map((entry) =>
        readFile(new URL(entry.name, import.meta.url), "utf8"),
      ),
    );
    expect(source.join("\n")).not.toContain("takosumi-managed-worker");
  });
});
