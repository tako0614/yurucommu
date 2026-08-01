import {
  handleYurucommuQueueBatch,
  wrapCloudflareBindings,
} from "@takosjp/yurucommu-core/server";
import type {
  DeliveryDlqMessageV1,
  DeliveryQueueMessageV1,
  Env,
  EnvVars,
  IQueueBatch,
  IQueueMessage,
  QueueSendOptions,
} from "@takosjp/yurucommu-core/server";
import {
  TAKOSUMI_BACKGROUND_EVENT_ABI,
  TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_PROP,
  TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH,
  TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION,
  parseTakosumiBackgroundEventAuthority,
  parseTakosumiBackgroundEventEnvelope,
  takosumiBackgroundEventEnvelopeDigest,
  type TakosumiBackgroundEvent,
  type TakosumiBackgroundEventEnvelope,
} from "@takosjp/takosumi-contract/background-events";
import type {
  D1Database,
  ExecutionContext,
  Fetcher,
  KVNamespace,
  Queue,
  R2Bucket,
  ScheduledController,
} from "@cloudflare/workers-types";

const MAX_BACKGROUND_EVENT_BYTES = 2 * 1024 * 1024;

type NativeWorkerBindings = EnvVars & {
  DB: D1Database;
  MEDIA?: R2Bucket;
  KV: KVNamespace;
  ASSETS?: Fetcher;
  DELIVERY_QUEUE?: Queue<DeliveryQueueMessageV1>;
  DELIVERY_DLQ?: Queue<DeliveryDlqMessageV1>;
};

export type YurucommuWorkerBindings = Omit<
  NativeWorkerBindings,
  "DB" | "MEDIA" | "KV" | "DELIVERY_QUEUE" | "DELIVERY_DLQ" | "APP_URL"
> & {
  APP_URL?: string;
  DB?: D1Database;
  MEDIA?: R2Bucket;
  KV?: KVNamespace;
  DELIVERY_QUEUE?: Queue<DeliveryQueueMessageV1>;
  DELIVERY_DLQ?: Queue<DeliveryDlqMessageV1>;
};

/**
 * Wraps the native Cloudflare bindings used by both direct and hosted
 * deployments. The host supplies actual D1/KV/R2/Queue objects under the
 * normal binding names, so both paths share one runtime adapter.
 */
export function wrapYurucommuWorkerBindings(
  bindings: YurucommuWorkerBindings,
): Env {
  if (
    !isObjectBinding(bindings.DB, "prepare") ||
    !isObjectBinding(bindings.KV, "get")
  ) {
    throw new Error("native DB and KV bindings are required");
  }
  if (bindings.MEDIA !== undefined && !isObjectBinding(bindings.MEDIA, "put")) {
    throw new Error("native MEDIA binding must implement put");
  }
  if (
    bindings.ASSETS !== undefined &&
    !isObjectBinding(bindings.ASSETS, "fetch")
  ) {
    throw new Error("native ASSETS binding must implement fetch");
  }
  if (
    bindings.DELIVERY_QUEUE !== undefined &&
    !isObjectBinding(bindings.DELIVERY_QUEUE, "send")
  ) {
    throw new Error("native DELIVERY_QUEUE binding must implement send");
  }
  if (
    bindings.DELIVERY_DLQ !== undefined &&
    !isObjectBinding(bindings.DELIVERY_DLQ, "send")
  ) {
    throw new Error("native DELIVERY_DLQ binding must implement send");
  }

  const appUrl =
    bindings.APP_URL === undefined || bindings.APP_URL.trim().length === 0
      ? bindings.APP_URL
      : canonicalAppOrigin(bindings.APP_URL);
  const normalizedBindings =
    appUrl === bindings.APP_URL ? bindings : { ...bindings, APP_URL: appUrl };
  return wrapCloudflareBindings(
    normalizedBindings as NativeWorkerBindings,
  ) as Env;
}

export type TakosumiBackgroundExecutionContext = ExecutionContext & {
  readonly props?: Readonly<Record<string, unknown>>;
};

export interface TakosumiBackgroundHandlers {
  readonly queue: (
    batch: IQueueBatch<DeliveryQueueMessageV1 | DeliveryDlqMessageV1>,
    env: Env,
  ) => Promise<void>;
  readonly scheduled: (
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) => Promise<void>;
}

/**
 * Handles the host-authenticated background HTTP ABI used by managed hosts.
 * Internet callers cannot manufacture `ctx.props`, so the route rejects
 * before reading a body unless the dispatch namespace supplied exact authority.
 */
export async function handleTakosumiBackgroundEventInvocation(input: {
  readonly request: Request;
  readonly bindings: YurucommuWorkerBindings;
  readonly ctx: TakosumiBackgroundExecutionContext;
  readonly handlers: TakosumiBackgroundHandlers;
}): Promise<Response | undefined> {
  const url = new URL(input.request.url);
  if (url.pathname !== TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH) return undefined;
  if (input.request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const authorityValue =
    input.ctx.props?.[TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_PROP];
  if (authorityValue === undefined) {
    return Response.json(
      { error: "background_authority_required" },
      {
        status: 403,
      },
    );
  }

  let authority;
  try {
    authority = parseTakosumiBackgroundEventAuthority(authorityValue);
  } catch {
    return Response.json(
      { error: "background_authority_invalid" },
      {
        status: 403,
      },
    );
  }
  if (
    input.request.headers.get("x-takosumi-background-event-abi") !==
      TAKOSUMI_BACKGROUND_EVENT_ABI ||
    input.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
  ) {
    return Response.json(
      { error: "background_request_invalid" },
      {
        status: 400,
      },
    );
  }

  let envelope: TakosumiBackgroundEventEnvelope;
  try {
    envelope = parseTakosumiBackgroundEventEnvelope(
      JSON.parse(await boundedRequestText(input.request)),
    );
    if (
      authority.activationId !== envelope.activationId ||
      authority.activationRevisionId !== envelope.activationRevisionId ||
      stableJson(authority.principal) !== stableJson(envelope.principal) ||
      stableJson(authority.source) !== stableJson(envelope.source) ||
      stableJson(authority.target) !== stableJson(envelope.target) ||
      authority.invocationDigest !==
        (await takosumiBackgroundEventEnvelopeDigest(envelope)) ||
      input.request.headers.get("idempotency-key") !== envelope.event.deliveryId
    ) {
      throw new TypeError("background authority does not match the envelope");
    }
  } catch {
    return Response.json(
      { error: "background_request_invalid" },
      {
        status: 400,
      },
    );
  }

  const runtimeEnv = wrapYurucommuWorkerBindings({
    ...input.bindings,
    APP_URL: canonicalAppOrigin(input.bindings.APP_URL),
  });
  if (
    envelope.target.entrypoint === "yurucommu.delivery" &&
    envelope.source.kind === "Queue" &&
    envelope.event.kind === "queue"
  ) {
    const batch = backgroundQueueBatch(envelope.event, runtimeEnv);
    await input.handlers.queue(batch.batch, runtimeEnv);
    if (!batch.allAcknowledged()) {
      return Response.json(
        { error: "background_delivery_retry" },
        {
          status: 503,
        },
      );
    }
  } else if (
    envelope.target.entrypoint === "yurucommu.retention" &&
    envelope.source.kind === "Schedule" &&
    envelope.event.kind === "schedule"
  ) {
    await input.handlers.scheduled(
      {
        scheduledTime: Date.parse(envelope.event.scheduledAt),
        cron: envelope.event.cron,
        noRetry() {},
      } as ScheduledController,
      runtimeEnv,
      input.ctx,
    );
  } else {
    return Response.json(
      { error: "background_entrypoint_invalid" },
      {
        status: 400,
      },
    );
  }

  return Response.json({
    version: TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION,
    deliveryId: envelope.event.deliveryId,
    activationRevisionId: envelope.activationRevisionId,
    targetResourceRevisionId: envelope.target.resourceRevisionId,
    outcome: "ack",
  });
}

export const defaultTakosumiBackgroundQueueHandler = handleYurucommuQueueBatch;

function backgroundQueueBatch(
  event: Extract<TakosumiBackgroundEvent, { readonly kind: "queue" }>,
  env: Env,
): {
  readonly batch: IQueueBatch<DeliveryQueueMessageV1 | DeliveryDlqMessageV1>;
  readonly allAcknowledged: () => boolean;
} {
  const queue = env.DELIVERY_QUEUE_NAME?.trim();
  if (!queue) throw new Error("DELIVERY_QUEUE_NAME is required");
  const pending = new Set<string>(event.messages.map(({ id }) => id));
  const retrying = new Set<string>();
  const messages = event.messages.map(
    (
      message,
    ): IQueueMessage<DeliveryQueueMessageV1 | DeliveryDlqMessageV1> => ({
      id: message.id,
      timestamp: new Date(message.timestamp),
      attempts: message.attempts,
      body: message.body as DeliveryQueueMessageV1 | DeliveryDlqMessageV1,
      ack() {
        if (retrying.has(message.id)) {
          throw new Error("background message cannot be retried and acked");
        }
        pending.delete(message.id);
      },
      retry(_options?: QueueSendOptions) {
        if (!pending.has(message.id)) {
          throw new Error("background message cannot be acked and retried");
        }
        retrying.add(message.id);
      },
    }),
  );
  return {
    batch: {
      queue,
      messages,
      ackAll() {
        if (retrying.size > 0) {
          throw new Error("background batch cannot be retried and acked");
        }
        pending.clear();
      },
      retryAll(_options?: QueueSendOptions) {
        for (const id of pending) retrying.add(id);
      },
    },
    allAcknowledged: () => pending.size === 0 && retrying.size === 0,
  };
}

function canonicalAppOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("APP_URL is required for background invocations");
  }
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

function isObjectBinding(
  value: unknown,
  method: string,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[method] === "function"
  );
}

async function boundedRequestText(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_BACKGROUND_EVENT_BYTES)
  ) {
    throw new Error("background request is too large");
  }
  const response = await boundedResponse(
    new Response(request.body),
    MAX_BACKGROUND_EVENT_BYTES,
  );
  return await response.text();
}

async function boundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Response> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)
  ) {
    throw new Error("background response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("background response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError("value is not JSON");
    return json;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
