import {
  wrapCloudflareBindings,
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

/** Direct-Cloudflare adapter retained separately from the hosted S3 seam. */
export function wrapDirectCloudflareWorkerBindings(
  bindings: DirectCloudflareWorkerBindings,
) {
  return wrapCloudflareBindings(bindings);
}
