import {
  wrapCloudflareBindings,
  wrapCloudflareMessageBatch,
} from "@takosjp/yurucommu-core/server";
import type {
  DeliveryDlqMessageV1,
  DeliveryQueueMessageV1,
  Env,
  EnvVars,
  IKeyValueStore,
  IQueueBatch,
  IQueueProducer,
  QueueBatchItem,
  QueueSendOptions,
} from "@takosjp/yurucommu-core/server";
import {
  drizzle as drizzleProxy,
  type AsyncBatchRemoteCallback,
  type AsyncRemoteCallback,
} from "drizzle-orm/sqlite-proxy";
import type {
  D1Database,
  DurableObjectNamespace,
  Fetcher,
  KVNamespace,
  MessageBatch,
  Queue,
  R2Bucket,
} from "@cloudflare/workers-types";

/**
 * Byte values in worker.runtime projections use an explicit base64 envelope.
 * The envelope keeps JSON transport lossless and does not reinterpret text as
 * a platform-specific string encoding.
 */
export type PortableEncodedBytes = {
  readonly encoding: "base64";
  readonly data: string;
};

export type PortableSqlValue = null | number | string | PortableEncodedBytes;

export type PortableSqlResult = {
  readonly rows: readonly Record<string, PortableSqlValue>[];
  readonly rowsWritten: number;
};

export type PortableSqlStatement = {
  readonly sql: string;
  readonly params?: readonly PortableSqlValue[];
};

/** The exact worker.runtime SQLite projection (edge.sql@1.0.0). */
export interface PortableSQLiteBinding {
  execute(
    sql: string,
    params?: readonly PortableSqlValue[],
  ): Promise<PortableSqlResult>;
  query(
    sql: string,
    params?: readonly PortableSqlValue[],
  ): Promise<PortableSqlResult>;
  transaction(statements: readonly PortableSqlStatement[]): Promise<{
    readonly results: readonly PortableSqlResult[];
  }>;
}

/** JavaScript byte values accepted by module-worker bindings. */
export type PortableByteValue = string | ArrayBuffer | ArrayBufferView;

/** Object bodies additionally support streaming. */
export type PortableObjectBody = PortableByteValue | ReadableStream<Uint8Array>;

/** The exact worker projection for an edge.kv binding. */
export interface PortableKeyValueBinding {
  get(key: string): Promise<ArrayBuffer | null>;
  getWithMetadata(key: string): Promise<{
    readonly value: ArrayBuffer | null;
    readonly metadata?: Record<string, string>;
  }>;
  put(
    key: string,
    value: PortableByteValue,
    options?: {
      readonly expirationTtlSeconds?: number;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly keys: readonly { readonly name: string }[];
    readonly listComplete: boolean;
    readonly cursor?: string;
  }>;
}

/** The exact worker projection for an edge.objects binding. */
export interface PortableObjectBucket {
  head(key: string): Promise<PortableObjectHead | null>;
  get(
    key: string,
    options?: PortableObjectGetOptions,
  ): Promise<PortableObjectResult | null>;
  put(
    key: string,
    body: PortableObjectBody,
    options: PortableObjectPutOptions,
  ): Promise<{ readonly etag: string; readonly size: number }>;
  delete(key: string): Promise<void>;
  list(options?: PortableObjectListOptions): Promise<PortableObjectListResult>;
  createMultipartUpload(
    key: string,
    options?: { readonly contentType?: string },
  ): Promise<{ readonly uploadId: string }>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: PortableObjectBody,
  ): Promise<{ readonly etag: string }>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly {
      readonly partNumber: number;
      readonly etag: string;
    }[],
  ): Promise<{ readonly etag: string; readonly size: number }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export interface PortableObjectHead {
  readonly etag: string;
  readonly size: number;
  readonly contentType?: string;
  readonly uploadedAtMillis?: number;
}

export interface PortableObjectResult {
  readonly etag: string;
  readonly size: number;
  readonly contentType?: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly bodyStream: true;
  readonly partial: boolean;
  readonly range?: { readonly offset: number; readonly length?: number };
}

export interface PortableObjectGetOptions {
  readonly range?: { readonly offset: number; readonly length?: number };
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
}

export interface PortableObjectPutOptions {
  readonly bodyStream: true;
  readonly contentLength: number;
  readonly contentType?: string;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: "*";
}

export interface PortableObjectListOptions {
  readonly prefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly delimiter?: string;
}

export interface PortableObjectListResult {
  readonly objects: readonly {
    readonly key: string;
    readonly size: number;
    readonly etag: string;
    readonly uploadedAtMillis?: number;
  }[];
  readonly truncated: boolean;
  readonly cursor?: string;
  readonly prefixes?: readonly string[];
}

/** The exact worker projection for an edge.queue producer binding. */
export interface PortableQueueProducer {
  send(
    body: PortableByteValue,
    options?: { readonly delaySeconds?: number },
  ): Promise<{ readonly messageId: string }>;
  sendBatch(
    messages: readonly {
      readonly body: PortableByteValue;
      readonly delaySeconds?: number;
    }[],
  ): Promise<{ readonly messageIds: readonly string[] }>;
}

/** Portable worker.runtime queue event. It intentionally has no ack methods. */
export interface PortableQueueBatch {
  readonly batchId: string;
  readonly queue: string;
  readonly messages: readonly PortableQueueMessage[];
}

export interface PortableQueueMessage {
  readonly id: string;
  readonly timestampMillis: number;
  readonly body: PortableEncodedBytes;
  readonly attempts: number;
}

export interface PortableScheduledEvent {
  readonly cron: string;
  readonly scheduledTime: number;
}

export type YurucommuPortableBindings = Omit<EnvVars, "APP_URL"> & {
  APP_URL?: string;
  DB: PortableSQLiteBinding;
  MEDIA?: PortableObjectBucket;
  KV: PortableKeyValueBinding;
  ASSETS?: Fetcher;
  DELIVERY_QUEUE?: PortableQueueProducer;
  DELIVERY_DLQ?: PortableQueueProducer;
  CALL_SIGNALING?: DurableObjectNamespace;
  REALTIME_STREAM?: DurableObjectNamespace;
};

export type YurucommuCloudflareBindings = Omit<EnvVars, "APP_URL"> & {
  APP_URL?: string;
  DB: D1Database;
  MEDIA?: R2Bucket;
  KV: KVNamespace;
  ASSETS?: Fetcher;
  DELIVERY_QUEUE?: Queue<DeliveryQueueMessageV1>;
  DELIVERY_DLQ?: Queue<DeliveryDlqMessageV1>;
  CALL_SIGNALING?: DurableObjectNamespace;
  REALTIME_STREAM?: DurableObjectNamespace;
};

export type YurucommuWorkerBindings =
  YurucommuCloudflareBindings | YurucommuPortableBindings;

export type YurucommuQueueBatch =
  | MessageBatch<DeliveryQueueMessageV1 | DeliveryDlqMessageV1>
  | PortableQueueBatch;

export type YurucommuRuntimeEnv = Env;

/** Materialize ordinary Worker bindings into the product runtime contracts. */
export function wrapYurucommuWorkerBindings(
  bindings: YurucommuWorkerBindings,
): YurucommuRuntimeEnv {
  const appUrl = normalizeOptionalAppUrl(bindings.APP_URL);
  const normalizedBindings =
    appUrl === bindings.APP_URL ? bindings : { ...bindings, APP_URL: appUrl };

  if (isPortableSQLiteBinding(bindings.DB)) {
    return wrapPortableBindings(
      normalizedBindings as YurucommuPortableBindings,
    );
  }
  return wrapCloudflareBindings(
    normalizedBindings as YurucommuCloudflareBindings,
  ) as YurucommuRuntimeEnv;
}

/**
 * Portable queue events intentionally expose no settlement methods. The
 * worker.runtime contract currently has no host-backed acknowledgement or
 * retry operation, so accepting one here would invent a private ABI and could
 * silently lose messages. Native Cloudflare batches continue through the
 * actual MessageBatch ack/retry methods below; portable batches fail closed.
 */
export function isPortableQueueBatch(
  value: unknown,
): value is PortableQueueBatch {
  const candidate = value as Record<string, unknown>;
  return (
    hasPortableQueueEnvelope(candidate) &&
    typeof candidate.batchId === "string" &&
    candidate.batchId.length > 0 &&
    typeof candidate.queue === "string" &&
    candidate.queue.length > 0 &&
    Array.isArray(candidate.messages) &&
    candidate.messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.id === "string" &&
        message.id.length > 0 &&
        Number.isSafeInteger(message.timestampMillis) &&
        message.timestampMillis >= 0 &&
        Number.isSafeInteger(message.attempts) &&
        message.attempts >= 1 &&
        isPortableEncodedBytes(message.body),
    )
  );
}

export function assertPortableQueueSettlementSupported(batch: unknown): void {
  if (hasPortableQueueEnvelope(batch)) {
    if (!isPortableQueueBatch(batch)) {
      throw new Error("portable_queue_batch_invalid");
    }
    throw new Error("portable_queue_settlement_unavailable");
  }
  if (!hasNativeQueueSettlement(batch)) {
    throw new Error("native_queue_settlement_unavailable");
  }
}

/**
 * Adapt a native Cloudflare queue event only. A portable event is rejected
 * before it reaches yurucommu-core because that core interface requires
 * ack/retry methods which worker.runtime does not provide.
 */
export function wrapYurucommuMessageBatch(
  batch: YurucommuQueueBatch,
): IQueueBatch<DeliveryQueueMessageV1 | DeliveryDlqMessageV1> {
  assertPortableQueueSettlementSupported(batch);
  return wrapCloudflareMessageBatch(
    batch as MessageBatch<DeliveryQueueMessageV1 | DeliveryDlqMessageV1>,
  );
}

/**
 * Distinguish the worker.runtime envelope before validating its messages. A
 * malformed portable event must fail closed as portable; otherwise it would be
 * cast to MessageBatch and the core could call missing ack/retry methods.
 */
function hasPortableQueueEnvelope(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (hasNativeQueueSettlementShape(value)) return false;
  return typeof value.queue === "string" && Array.isArray(value.messages);
}

function hasNativeQueueSettlementShape(
  value: Record<string, unknown>,
): boolean {
  if ("ackAll" in value || "retryAll" in value) return true;
  return (
    Array.isArray(value.messages) &&
    value.messages.some(
      (message) =>
        isRecord(message) && ("ack" in message || "retry" in message),
    )
  );
}

function hasNativeQueueSettlement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.ackAll !== "function" ||
    typeof value.retryAll !== "function" ||
    !Array.isArray(value.messages)
  ) {
    return false;
  }
  return value.messages.every(
    (message) =>
      isRecord(message) &&
      typeof message.ack === "function" &&
      typeof message.retry === "function",
  );
}

/** True when a binding is the portable SQLite projection, not D1. */
export function isPortableSQLiteBinding(
  value: unknown,
): value is PortableSQLiteBinding {
  return (
    isRecord(value) &&
    typeof value.execute === "function" &&
    typeof value.query === "function" &&
    typeof value.transaction === "function"
  );
}

function wrapPortableBindings(
  bindings: YurucommuPortableBindings,
): YurucommuRuntimeEnv {
  const { DB, MEDIA, KV, ASSETS, DELIVERY_QUEUE, DELIVERY_DLQ, ...rest } =
    bindings;
  return {
    ...rest,
    DB_INSTANCE: createPortableDatabase(DB),
    MEDIA: MEDIA ? createPortableObjectStorage(MEDIA) : undefined,
    KV: createPortableKeyValueStore(KV),
    ASSETS: ASSETS
      ? { fetch: (request) => ASSETS.fetch(request as never) as never }
      : undefined,
    DELIVERY_QUEUE: DELIVERY_QUEUE
      ? createPortableQueueProducer<DeliveryQueueMessageV1>(DELIVERY_QUEUE)
      : undefined,
    DELIVERY_DLQ: DELIVERY_DLQ
      ? createPortableQueueProducer<DeliveryDlqMessageV1>(DELIVERY_DLQ)
      : undefined,
  } as YurucommuRuntimeEnv;
}

/** Build the core Drizzle database over portable execute/query/transaction. */
export function createPortableDatabase(
  binding: PortableSQLiteBinding,
): Env["DB_INSTANCE"] {
  const execute: AsyncRemoteCallback = async (sql, params, method) => {
    const result = await (method === "run"
      ? binding.execute(sql, params.map(toPortableSqlValue))
      : binding.query(sql, params.map(toPortableSqlValue)));
    const rows = portableRowsToArrays(result.rows);
    return {
      rows: method === "get" ? (rows[0] ?? []) : rows,
      meta: { changes: result.rowsWritten },
    };
  };
  const batch: AsyncBatchRemoteCallback = async (statements) => {
    const result = await binding.transaction(
      statements.map((statement) => ({
        sql: statement.sql,
        params: statement.params.map(toPortableSqlValue),
      })),
    );
    const results = normalizePortableTransactionResults(result);
    return statements.map((statement, index) => {
      const value = results[index];
      if (!value) throw new Error("portable_sql_transaction_result_missing");
      const rows = portableRowsToArrays(value.rows);
      return {
        rows: statement.method === "get" ? (rows[0] ?? []) : rows,
        meta: { changes: value.rowsWritten },
      };
    });
  };

  return drizzleProxy(execute, batch) as unknown as Env["DB_INSTANCE"];
}

/** Adapt edge.kv's byte-only methods to yurucommu-core's typed KV port. */
export function createPortableKeyValueStore(
  binding: PortableKeyValueBinding,
): IKeyValueStore {
  async function get(
    key: string,
    options?: { type?: "text" },
  ): Promise<string | null>;
  async function get<T = unknown>(
    key: string,
    options: { type: "json" },
  ): Promise<T | null>;
  async function get(
    key: string,
    options: { type: "arrayBuffer" },
  ): Promise<ArrayBuffer | null>;
  async function get(
    key: string,
    options?: { type?: "text" | "json" | "arrayBuffer" },
  ): Promise<unknown> {
    const raw = await binding.get(key);
    if (raw === null) return null;
    const bytes = await toArrayBuffer(raw);
    if (options?.type === "arrayBuffer") return bytes;
    const text = new TextDecoder().decode(bytes);
    if (options?.type === "json") return JSON.parse(text) as unknown;
    return text;
  }

  return {
    get,
    async put(
      key: string,
      value: string | ArrayBuffer | ReadableStream,
      options?: {
        expirationTtl?: number;
        expiration?: number;
        metadata?: Record<string, unknown>;
      },
    ): Promise<void> {
      const bytes = await toArrayBufferOrStream(value);
      await binding.put(key, bytes, {
        ...(options?.expirationTtl === undefined
          ? {}
          : { expirationTtlSeconds: options.expirationTtl }),
        ...(options?.metadata === undefined
          ? {}
          : { metadata: toStringMetadata(options.metadata) }),
      });
    },
    async delete(key: string): Promise<void> {
      await binding.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
      const result = await binding.list(options);
      return {
        keys: result.keys.map((entry) => ({ name: entry.name })),
        list_complete: result.listComplete,
        cursor: result.listComplete ? undefined : result.cursor,
      };
    },
  };
}

/** Adapt edge.objects' streaming body contract to core's R2-like port. */
export function createPortableObjectStorage(binding: PortableObjectBucket) {
  return {
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | string,
      options?: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
        /**
         * A stream has no discoverable length. Callers that hand us a stream
         * must carry its known size explicitly so edge.objects can enforce
         * limits without buffering the body.
         */
        contentLength?: number;
      },
    ): Promise<void> {
      const contentLength =
        options?.contentLength ?? knownPortableBodyLength(value);
      if (contentLength === undefined) {
        throw new Error("portable_object_content_length_required");
      }
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new Error("portable_object_content_length_invalid");
      }
      const body =
        value instanceof ReadableStream
          ? value
          : await toArrayBuffer(value as PortableByteValue);
      await binding.put(key, body, {
        bodyStream: true,
        contentLength,
        ...(options?.httpMetadata?.contentType
          ? { contentType: options.httpMetadata.contentType }
          : {}),
      });
    },

    async get(key: string, options?: PortableObjectGetOptions) {
      const object = await binding.get(key, options);
      if (!object) return null;
      return portableStorageObject(object, key);
    },

    async delete(key: string | string[]): Promise<void> {
      const keys = Array.isArray(key) ? key : [key];
      for (const value of keys) await binding.delete(value);
    },

    async list(options?: {
      prefix?: string;
      limit?: number;
      cursor?: string;
      delimiter?: string;
    }) {
      const result = await binding.list(options);
      return {
        objects: result.objects.map((object) => ({
          key: object.key,
          size: object.size,
          uploaded: new Date(object.uploadedAtMillis ?? 0),
          etag: object.etag,
        })),
        truncated: result.truncated,
        cursor: result.truncated ? result.cursor : undefined,
        delimitedPrefixes: result.prefixes,
      };
    },

    async head(key: string) {
      const object = await binding.head(key);
      if (!object) return null;
      return {
        contentType: object.contentType,
        contentLength: object.size,
        etag: object.etag,
        httpMetadata: object.contentType
          ? { contentType: object.contentType }
          : undefined,
      };
    },
  };
}

function portableStorageObject(object: PortableObjectResult, key: string) {
  let bodyUsed = false;
  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        sourceReader ??= object.body.getReader();
        bodyUsed = true;
        try {
          const result = await sourceReader.read();
          if (result.done) {
            controller.close();
            sourceReader.releaseLock();
            sourceReader = undefined;
          } else if (result.value) {
            controller.enqueue(result.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        bodyUsed = true;
        await sourceReader?.cancel(reason);
        sourceReader?.releaseLock();
        sourceReader = undefined;
      },
    },
    { highWaterMark: 0 },
  );

  const read = async (): Promise<ArrayBuffer> => {
    const reader = body.getReader();
    bodyUsed = true;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!result.value) continue;
        chunks.push(result.value);
        size += result.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  };

  return {
    key,
    body,
    get bodyUsed() {
      return bodyUsed;
    },
    httpEtag: object.etag,
    arrayBuffer: read,
    text: async () => new TextDecoder().decode(await read()),
    json: async <T>() =>
      JSON.parse(new TextDecoder().decode(await read())) as T,
    httpMetadata: object.contentType
      ? { contentType: object.contentType }
      : undefined,
  };
}

function knownPortableBodyLength(
  value: ReadableStream | ArrayBuffer | string,
): number | undefined {
  if (typeof value === "string") {
    return new TextEncoder().encode(value).byteLength;
  }
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  const candidate = value as ReadableStream & {
    readonly contentLength?: unknown;
  };
  return Number.isSafeInteger(candidate.contentLength) &&
    (candidate.contentLength as number) >= 0
    ? (candidate.contentLength as number)
    : undefined;
}

/** Adapt queue producer bodies into the portable byte projection. */
export function createPortableQueueProducer<T>(
  binding: PortableQueueProducer,
): IQueueProducer<T> {
  return {
    async send(body: T, options?: QueueSendOptions): Promise<void> {
      await binding.send(await encodeQueueBody(body), options);
    },
    async sendBatch(
      messages: readonly QueueBatchItem<T>[],
      options?: QueueSendOptions,
    ): Promise<void> {
      await binding.sendBatch(
        await Promise.all(
          messages.map(async ({ body, delaySeconds }) => ({
            body: await encodeQueueBody(body),
            delaySeconds: delaySeconds ?? options?.delaySeconds,
          })),
        ),
      );
    },
  };
}

async function encodeQueueBody(body: unknown): Promise<ArrayBuffer> {
  if (
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    return toArrayBuffer(body as PortableByteValue);
  }
  const serialized = JSON.stringify(body);
  if (serialized === undefined) {
    throw new TypeError("portable_queue_body_unsupported");
  }
  return new TextEncoder().encode(serialized).buffer;
}

async function toArrayBuffer(value: PortableByteValue): Promise<ArrayBuffer> {
  if (typeof value === "string") return new TextEncoder().encode(value).buffer;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    return bytes.slice().buffer;
  }
  throw new TypeError("portable_bytes_unsupported");
}

async function toArrayBufferOrStream(
  value: PortableObjectBody,
): Promise<ArrayBuffer> {
  if (!(value instanceof ReadableStream)) return toArrayBuffer(value);
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (!chunk) continue;
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function decodePortableBytes(
  value: ArrayBuffer | PortableEncodedBytes,
): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0);
  const binary = atob(value.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function toPortableSqlValue(value: unknown): PortableSqlValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new TypeError("portable_sql_numeric_out_of_range");
    }
    return value;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { encoding: "base64", data: encodeBase64(bytes) };
  }
  throw new TypeError("portable_sql_value_unsupported");
}

function portableRowsToArrays(
  rows: readonly Record<string, PortableSqlValue>[],
): unknown[][] {
  return rows.map((row) =>
    Object.values(row).map(decodePortableSqlResultValue),
  );
}

function decodePortableSqlResultValue(value: PortableSqlValue): unknown {
  return isPortableEncodedBytes(value) ? decodePortableBytes(value) : value;
}

function isPortableEncodedBytes(value: unknown): value is PortableEncodedBytes {
  return (
    isRecord(value) &&
    value.encoding === "base64" &&
    typeof value.data === "string"
  );
}

function normalizePortableTransactionResults(
  value:
    | { readonly results: readonly PortableSqlResult[] }
    | readonly PortableSqlResult[],
): readonly PortableSqlResult[] {
  if (Array.isArray(value)) return value;
  return (value as { readonly results: readonly PortableSqlResult[] }).results;
}

function toStringMetadata(
  metadata: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, String(value)]),
  );
}

function normalizeOptionalAppUrl(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim().length === 0) return value;
  return canonicalAppOrigin(value);
}

function canonicalAppOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    value !== url.origin
  ) {
    throw new Error("APP_URL must be an exact HTTPS origin");
  }
  return url.origin;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
