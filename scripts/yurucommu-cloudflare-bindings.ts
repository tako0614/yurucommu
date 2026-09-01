import {
  wrapCloudflareBindings,
  type Env,
  type EnvVars,
} from "@takosjp/yurucommu-core/server";
import type {
  D1Database,
  Fetcher,
  KVNamespace,
  Queue,
  R2Bucket,
} from "@cloudflare/workers-types";
import type {
  DeliveryDlqMessageV1,
  DeliveryQueueMessageV1,
} from "@takosjp/yurucommu-core/server";

export type DirectCloudflareWorkerBindings = Omit<EnvVars, "APP_URL"> & {
  readonly APP_URL?: string;
  readonly DB: D1Database;
  readonly MEDIA: R2Bucket;
  readonly KV: KVNamespace;
  readonly ASSETS?: Fetcher;
  readonly DELIVERY_QUEUE?: Queue<DeliveryQueueMessageV1>;
  readonly DELIVERY_DLQ?: Queue<DeliveryDlqMessageV1>;
};

export type DirectCloudflareRuntimeEnv = Omit<Env, "APP_URL"> & {
  readonly APP_URL?: string;
};

/** Direct-Cloudflare adapter retained separately from the hosted S3 seam. */
export function wrapDirectCloudflareWorkerBindings(
  bindings: DirectCloudflareWorkerBindings,
): DirectCloudflareRuntimeEnv {
  if (!isNativeCloudflareR2Bucket(bindings.MEDIA)) {
    throw new Error("MEDIA must be a native Cloudflare R2 binding");
  }
  return wrapCloudflareBindings(bindings) as DirectCloudflareRuntimeEnv;
}

const REQUIRED_R2_METHODS = [
  "put",
  "get",
  "delete",
  "createMultipartUpload",
  "resumeMultipartUpload",
] as const;

function isNativeCloudflareR2Bucket(value: unknown): value is R2Bucket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return (
      typeof (value as { fetch?: unknown }).fetch !== "function" &&
      REQUIRED_R2_METHODS.every(
        (method) =>
          typeof (
            value as Record<(typeof REQUIRED_R2_METHODS)[number], unknown>
          )[method] === "function",
      )
    );
  } catch {
    return false;
  }
}
