import {
  wrapCloudflareBindings,
  type Env,
  type EnvVars,
  type IObjectStorage,
  type ListObjectsResult,
  type ObjectMetadata,
  type StorageObject,
} from "@takosjp/yurucommu-core/server";
import type {
  D1Database,
  Fetcher,
  KVNamespace,
  Queue,
} from "@cloudflare/workers-types";
import type {
  DeliveryDlqMessageV1,
  DeliveryQueueMessageV1,
} from "@takosjp/yurucommu-core/server";

type PutValue = Blob | ReadableStream | ArrayBuffer | string;
type PutOptions = {
  readonly httpMetadata?: ObjectMetadata["httpMetadata"];
  readonly customMetadata?: Record<string, string>;
};

export interface SealedS3Object {
  readonly key: string;
  readonly body: ReadableStream | null;
  readonly bodyUsed: boolean;
  readonly httpEtag?: string;
  readonly httpMetadata?: ObjectMetadata["httpMetadata"];
  readonly customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface SealedS3ObjectMetadata {
  readonly size: number;
  readonly etag?: string;
  readonly httpMetadata?: ObjectMetadata["httpMetadata"];
  readonly customMetadata?: Record<string, string>;
}

export interface SealedS3ObjectStoreBinding {
  put(key: string, value: PutValue, options?: PutOptions): Promise<unknown>;
  get(key: string): Promise<SealedS3Object | null>;
  delete(key: string | string[]): Promise<unknown>;
  list(options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly delimiter?: string;
  }): Promise<{
    readonly objects: readonly (SealedS3ObjectMetadata & {
      readonly key: string;
      readonly uploaded: Date;
    })[];
    readonly truncated: boolean;
    readonly cursor?: string;
    readonly delimitedPrefixes?: readonly string[];
  }>;
  head(key: string): Promise<SealedS3ObjectMetadata | null>;
}

export type YurucommuWorkerBindings = Omit<EnvVars, "APP_URL"> & {
  readonly APP_URL?: string;
  readonly DB: D1Database;
  readonly MEDIA: SealedS3ObjectStoreBinding;
  readonly KV: KVNamespace;
  readonly ASSETS?: Fetcher;
  readonly DELIVERY_QUEUE?: Queue<DeliveryQueueMessageV1>;
  readonly DELIVERY_DLQ?: Queue<DeliveryDlqMessageV1>;
};

export type YurucommuRuntimeEnv = Omit<Env, "APP_URL"> & {
  readonly APP_URL?: string;
};

/**
 * Adapts the Host's one sealed `com.amazonaws.s3` runtime slot to the product
 * object-store contract. The binding itself is opaque: no endpoint, region,
 * bucket name, credential, or portable provisioning identity is accepted.
 */
export function adaptSealedS3ObjectStore(candidate: unknown): IObjectStorage {
  if (!isSealedObjectStore(candidate)) {
    throw new Error(
      "MEDIA must be a sealed S3-compatible object-store binding",
    );
  }
  const binding = candidate;

  return {
    async put(key, value, options) {
      await binding.put(key, value, options);
    },
    async get(key): Promise<StorageObject | null> {
      const object = await binding.get(key);
      if (object === null) return null;
      assertSealedObject(object);
      const httpMetadata = optionalHttpMetadata(
        object.httpMetadata,
        "MEDIA object HTTP metadata",
      );
      const customMetadata = optionalStringRecord(
        object.customMetadata,
        "MEDIA object custom metadata",
      );
      return {
        key: object.key,
        body: object.body,
        bodyUsed: object.bodyUsed,
        httpEtag: optionalString(object.httpEtag, "MEDIA object etag"),
        arrayBuffer: () => object.arrayBuffer(),
        text: () => object.text(),
        json: <T>() => object.json<T>(),
        httpMetadata,
        customMetadata,
      };
    },
    async delete(key) {
      await binding.delete(key);
    },
    async list(options): Promise<ListObjectsResult> {
      const result = await binding.list(options);
      if (
        !isRecord(result) ||
        !Array.isArray(result.objects) ||
        typeof result.truncated !== "boolean" ||
        (result.cursor !== undefined && typeof result.cursor !== "string") ||
        (result.delimitedPrefixes !== undefined &&
          (!Array.isArray(result.delimitedPrefixes) ||
            result.delimitedPrefixes.some(
              (value) => typeof value !== "string",
            )))
      ) {
        throw new Error("MEDIA list returned an invalid object-store result");
      }
      return {
        objects: result.objects.map((object) => {
          if (
            !isRecord(object) ||
            typeof object.key !== "string" ||
            typeof object.size !== "number" ||
            !(object.uploaded instanceof Date)
          ) {
            throw new Error("MEDIA list returned invalid object metadata");
          }
          return {
            key: object.key,
            size: object.size,
            uploaded: object.uploaded,
            etag: optionalString(object.etag, "MEDIA object etag"),
            httpMetadata: optionalHttpMetadata(
              object.httpMetadata,
              "MEDIA object HTTP metadata",
            ),
          };
        }),
        truncated: result.truncated,
        cursor: result.cursor,
        delimitedPrefixes: result.delimitedPrefixes as string[] | undefined,
      };
    },
    async head(key): Promise<ObjectMetadata | null> {
      const object = await binding.head(key);
      if (object === null) return null;
      if (!isRecord(object) || typeof object.size !== "number") {
        throw new Error("MEDIA head returned invalid object metadata");
      }
      const httpMetadata = optionalHttpMetadata(
        object.httpMetadata,
        "MEDIA object HTTP metadata",
      );
      return {
        contentType:
          typeof httpMetadata?.contentType === "string"
            ? httpMetadata.contentType
            : undefined,
        contentLength: object.size,
        etag: optionalString(object.etag, "MEDIA object etag"),
        httpMetadata,
        customMetadata: optionalStringRecord(
          object.customMetadata,
          "MEDIA object custom metadata",
        ),
      };
    },
  };
}

export function wrapYurucommuWorkerBindings(
  bindings: YurucommuWorkerBindings,
): YurucommuRuntimeEnv {
  const { MEDIA, ...nativeBindings } = bindings;
  const runtime = wrapCloudflareBindings(nativeBindings);
  return {
    ...runtime,
    MEDIA: adaptSealedS3ObjectStore(MEDIA),
  } as YurucommuRuntimeEnv;
}

function isSealedObjectStore(
  value: unknown,
): value is SealedS3ObjectStoreBinding {
  return (
    isRecord(value) &&
    ["put", "get", "delete", "list", "head"].every(
      (name) => typeof value[name] === "function",
    )
  );
}

function assertSealedObject(value: unknown): asserts value is SealedS3Object {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    typeof value.bodyUsed !== "boolean" ||
    (value.body !== null &&
      (!isRecord(value.body) || typeof value.body.getReader !== "function")) ||
    typeof value.arrayBuffer !== "function" ||
    typeof value.text !== "function" ||
    typeof value.json !== "function"
  ) {
    throw new Error("MEDIA get returned an invalid object-store result");
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function optionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function optionalHttpMetadata(
  value: unknown,
  label: string,
): ObjectMetadata["httpMetadata"] | undefined {
  const record = optionalRecord(value, label);
  if (!record) return undefined;
  return {
    contentType: optionalString(record.contentType, label),
    cacheControl: optionalString(record.cacheControl, label),
    contentDisposition: optionalString(record.contentDisposition, label),
    contentEncoding: optionalString(record.contentEncoding, label),
    contentLanguage: optionalString(record.contentLanguage, label),
  };
}

function optionalStringRecord(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  const record = optionalRecord(value, label);
  if (!record) return undefined;
  if (Object.values(record).some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} is invalid`);
  }
  return record as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
