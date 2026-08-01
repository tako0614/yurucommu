import { describe, expect, test } from "bun:test";

import {
  TAKOSUMI_BACKGROUND_EVENT_ABI,
  TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_PROP,
  TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_VERSION,
  TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH,
  TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION,
  takosumiBackgroundEventEnvelopeDigest,
  type TakosumiBackgroundEventEnvelope,
} from "@takosjp/takosumi-contract/background-events";

import {
  handleTakosumiBackgroundEventInvocation,
  wrapYurucommuWorkerBindings,
  type TakosumiBackgroundExecutionContext,
  type TakosumiBackgroundHandlers,
  type YurucommuWorkerBindings,
} from "./takosumi-managed-worker.ts";

const workspaceId = "ws_managed_test";
const target = {
  kind: "EdgeWorker" as const,
  workspaceId,
  resourceId: `tkrn:${workspaceId}:EdgeWorker:yurucommu`,
  resourceGeneration: 1,
  resourceRevisionId: "rev_http_1",
  entrypoint: "yurucommu.delivery",
};
const source = {
  kind: "Queue" as const,
  workspaceId,
  resourceId: `tkrn:${workspaceId}:Queue:delivery`,
  resourceGeneration: 1,
  resourceRevisionId: "rev_queue_1",
  deadLetterQueue: {
    workspaceId,
    resourceId: `tkrn:${workspaceId}:Queue:delivery-dlq`,
    resourceGeneration: 1,
    resourceRevisionId: "rev_queue_dlq_1",
  },
};
const principal = {
  kind: "CapsuleHostBackground" as const,
  workspaceId,
  capsuleId: "cap_yurucommu",
  installingPrincipalId: "acct_owner",
};

function queueEnvelope(): TakosumiBackgroundEventEnvelope {
  return {
    abi: TAKOSUMI_BACKGROUND_EVENT_ABI,
    activationId: "activation_delivery",
    activationRevisionId: "activation_delivery_rev_1",
    principal,
    source,
    target,
    retry: {
      maxAttempts: 3,
      retryDelaySeconds: 30,
      onExhausted: "dead_letter",
    },
    event: {
      kind: "queue",
      deliveryId: "delivery_1",
      occurredAt: "2026-07-29T12:00:00.000Z",
      attempt: 1,
      source,
      messages: [
        {
          id: "message_1",
          timestamp: "2026-07-29T12:00:00.000Z",
          attempts: 1,
          body: { type: "deliver_endpoint", jobId: "job_1" },
        },
      ],
    },
  };
}

function nativeBindings(): YurucommuWorkerBindings {
  return {
    APP_URL: "https://yurucommu.example.test",
    DELIVERY_QUEUE_NAME: "yurucommu-delivery",
    DELIVERY_DLQ_NAME: "yurucommu-delivery-dlq",
    DB: {
      prepare() {
        throw new Error("DB must not be called by this routing test");
      },
    },
    KV: {
      get() {
        throw new Error("KV must not be called by this routing test");
      },
    },
  } as unknown as YurucommuWorkerBindings;
}

async function requestFor(
  envelope: TakosumiBackgroundEventEnvelope,
): Promise<Request> {
  return new Request(
    `https://takosumi-background.internal${TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": envelope.event.deliveryId,
        "x-takosumi-background-event-abi": TAKOSUMI_BACKGROUND_EVENT_ABI,
      },
      body: JSON.stringify(envelope),
    },
  );
}

async function contextFor(
  envelope: TakosumiBackgroundEventEnvelope,
): Promise<TakosumiBackgroundExecutionContext> {
  return {
    props: {
      [TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_PROP]: {
        version: TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_VERSION,
        activationId: envelope.activationId,
        activationRevisionId: envelope.activationRevisionId,
        invocationDigest: await takosumiBackgroundEventEnvelopeDigest(envelope),
        principal: envelope.principal,
        source: envelope.source,
        target: envelope.target,
      },
    },
  } as unknown as TakosumiBackgroundExecutionContext;
}

function handlers(
  queue: TakosumiBackgroundHandlers["queue"],
): TakosumiBackgroundHandlers {
  return {
    queue,
    scheduled: async () => {
      throw new Error("schedule handler must not be called");
    },
  };
}

describe("Yurucommu native Cloudflare binding selection", () => {
  test("requires native DB and KV bindings", () => {
    expect(() =>
      wrapYurucommuWorkerBindings({
        APP_URL: "https://yurucommu.example.test",
        DB: "not-a-native-binding" as never,
        KV: "not-a-native-binding" as never,
      }),
    ).toThrow("native DB and KV bindings are required");
  });

  test("validates an explicit app origin", () => {
    expect(() =>
      wrapYurucommuWorkerBindings({
        APP_URL: "http://yurucommu.example.test",
        DB: nativeBindings().DB,
        KV: nativeBindings().KV,
      }),
    ).toThrow("APP_URL must be an exact HTTPS origin");
  });

  test("adapts native DB, KV, R2, and queue bindings", async () => {
    const kvCalls: string[] = [];
    const objectCalls: string[] = [];
    const queueMessages: unknown[] = [];
    const dlqMessages: unknown[] = [];
    const bindings: YurucommuWorkerBindings = {
      APP_URL: "https://yurucommu.example.test",
      DELIVERY_QUEUE_NAME: "yurucommu-delivery",
      DELIVERY_DLQ_NAME: "yurucommu-delivery-dlq",
      DB: {
        prepare() {
          throw new Error("DB must not be called by this adapter test");
        },
      } as never,
      KV: {
        get: async (key: string) => {
          kvCalls.push(`get:${key}`);
          return null;
        },
        put: async (key: string) => {
          kvCalls.push(`put:${key}`);
        },
        delete: async (key: string) => {
          kvCalls.push(`delete:${key}`);
        },
        list: async () => ({ keys: [], list_complete: true }),
      } as never,
      MEDIA: {
        put: async (key: string) => {
          objectCalls.push(`put:${key}`);
        },
        get: async () => null,
        delete: async (key: string) => {
          objectCalls.push(`delete:${key}`);
        },
        list: async () => ({
          objects: [],
          truncated: false,
          delimitedPrefixes: [],
        }),
        head: async () => null,
      } as never,
      DELIVERY_QUEUE: {
        send: async (body: unknown) => {
          queueMessages.push(body);
        },
        sendBatch: async () => undefined,
      } as never,
      DELIVERY_DLQ: {
        send: async (body: unknown) => {
          dlqMessages.push(body);
        },
        sendBatch: async () => undefined,
      } as never,
    };
    const runtime = wrapYurucommuWorkerBindings(bindings);

    expect(runtime.DB_INSTANCE).toBeDefined();
    expect(runtime.KV).not.toBe(bindings.KV);
    expect(runtime.MEDIA).not.toBe(bindings.MEDIA);
    expect(runtime.DELIVERY_QUEUE).not.toBe(bindings.DELIVERY_QUEUE);
    expect(runtime.DELIVERY_DLQ).not.toBe(bindings.DELIVERY_DLQ);

    await runtime.KV.put("session:test", "value");
    await runtime.KV.get("session:test");
    await runtime.MEDIA!.put("media:test", "value");
    await runtime.DELIVERY_QUEUE!.send({
      version: 1,
      type: "deliver_endpoint",
      jobId: "job_1",
      scheduledAt: "2026-07-29T12:00:00.000Z",
    });
    await runtime.DELIVERY_DLQ!.send({
      version: 1,
      type: "dlq",
      jobId: "job_2",
      activityId: "activity_2",
      endpoint: "https://remote.example.test/inbox",
      attempts: 1,
      lastError: null,
      deadLetteredAt: "2026-07-29T12:00:00.000Z",
    });

    expect(kvCalls).toEqual(["put:session:test", "get:session:test"]);
    expect(objectCalls).toEqual(["put:media:test"]);
    expect(queueMessages).toHaveLength(1);
    expect(dlqMessages).toHaveLength(1);
  });
});

describe("Takosumi background-event HTTP ABI", () => {
  test("rejects an internet request before dispatching application code", async () => {
    const envelope = queueEnvelope();
    let called = false;
    const response = await handleTakosumiBackgroundEventInvocation({
      request: await requestFor(envelope),
      bindings: nativeBindings(),
      ctx: {} as TakosumiBackgroundExecutionContext,
      handlers: handlers(async () => {
        called = true;
      }),
    });

    expect(response?.status).toBe(403);
    expect(called).toBe(false);
  });

  test("authenticates, dispatches, and returns the exact host ack", async () => {
    const envelope = queueEnvelope();
    let called = 0;
    const response = await handleTakosumiBackgroundEventInvocation({
      request: await requestFor(envelope),
      bindings: nativeBindings(),
      ctx: await contextFor(envelope),
      handlers: handlers(async (batch) => {
        called += 1;
        expect(batch.queue).toBe("yurucommu-delivery");
        expect(batch.messages.map(({ id }) => id)).toEqual(["message_1"]);
        batch.ackAll();
      }),
    });

    expect(called).toBe(1);
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as unknown;
    expect(body).toEqual({
      version: TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION,
      deliveryId: "delivery_1",
      activationRevisionId: "activation_delivery_rev_1",
      targetResourceRevisionId: "rev_http_1",
      outcome: "ack",
    });
  });

  test("does not acknowledge a retry requested by application code", async () => {
    const envelope = queueEnvelope();
    const response = await handleTakosumiBackgroundEventInvocation({
      request: await requestFor(envelope),
      bindings: nativeBindings(),
      ctx: await contextFor(envelope),
      handlers: handlers(async (batch) => batch.retryAll()),
    });

    expect(response?.status).toBe(503);
    const body = (await response!.json()) as unknown;
    expect(body).toEqual({
      error: "background_delivery_retry",
    });
  });

  test("rejects an envelope that does not match trusted dispatch props", async () => {
    const envelope = queueEnvelope();
    const context = await contextFor(envelope);
    const drifted = {
      ...envelope,
      activationRevisionId: "activation_delivery_rev_2",
    };
    let called = false;
    const response = await handleTakosumiBackgroundEventInvocation({
      request: await requestFor(drifted),
      bindings: nativeBindings(),
      ctx: context,
      handlers: handlers(async () => {
        called = true;
      }),
    });

    expect(response?.status).toBe(400);
    expect(called).toBe(false);
  });
});
