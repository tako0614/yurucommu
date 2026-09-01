import {
  createS3FetchObjectStore,
  wrapCloudflareBindings,
  type Env,
  type EnvVars,
  type ObjectStore,
  type S3ObjectFetcher,
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

export type SealedS3ObjectStoreBinding = S3ObjectFetcher;

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
export function adaptSealedS3ObjectStore(candidate: unknown): ObjectStore {
  if (!isExactS3ObjectFetcher(candidate)) {
    throw new Error("MEDIA must be an exact sealed S3 fetch binding");
  }
  return createS3FetchObjectStore(candidate);
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

function isExactS3ObjectFetcher(
  value: unknown,
): value is SealedS3ObjectStoreBinding {
  if (!isRecord(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length === 0) {
      return typeof value.fetch === "function";
    }
    if (ownKeys.length !== 1 || ownKeys[0] !== "fetch") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "fetch");
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "function"
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
