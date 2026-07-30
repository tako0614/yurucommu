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

function managedMaterialization(): string {
  const kinds = {
    DB: "RelationalDatabase",
    MEDIA: "ObjectBucket",
    KV: "KeyValueStore",
    DELIVERY_QUEUE: "Queue",
    DELIVERY_DLQ: "Queue",
  } as const;
  return JSON.stringify({
    contract: "takosumi.managed-runtime-connection/v1",
    gateway: {
      binding: "TAKOSUMI_MANAGED_RUNTIME",
      transport: "fetch",
    },
    connections: Object.entries(kinds).map(([alias, resourceKind], index) => ({
      alias,
      authority: {
        workspaceId,
        subject: "capsule:cap_yurucommu",
        resourceId: `tkrn:${workspaceId}:${resourceKind}:${alias.toLowerCase()}`,
        resourceKind,
        resourceGeneration: 1,
        permissions: ["takosumi.managed-runtime.invoke"],
        interfaceId: `if_${index}`,
        interfaceBindingId: `ifb_${index}`,
        interfaceResolvedRevision: 1,
        audience: "https://runtime.example.test/v1/resources",
        capabilityRef: `secret:runtime/${alias.toLowerCase()}`,
      },
    })),
  });
}

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

describe("Yurucommu managed runtime selection", () => {
  test("rejects the former capability-ref-as-native-binding overlay", () => {
    expect(() =>
      wrapYurucommuWorkerBindings({
        APP_URL: "https://yurucommu.example.test",
        DB: "capability:yurucommu/database",
        MEDIA: "capability:yurucommu/media",
        KV: "capability:yurucommu/key-value",
        DELIVERY_QUEUE: "capability:yurucommu/delivery-queue",
        DELIVERY_DLQ: "capability:yurucommu/delivery-dlq",
      }),
    ).toThrow(
      "managed runtime must not expose DB as a native or capability-ref binding",
    );
  });

  test("rejects an incomplete managed selection instead of falling back to native", () => {
    expect(() =>
      wrapYurucommuWorkerBindings({
        APP_URL: "https://yurucommu.example.test",
        TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION: "{}",
      }),
    ).toThrow(
      "managed runtime requires its exact materialization and Fetch gateway",
    );
  });

  test("materializes the declared KV and queue through the Fetch gateway", async () => {
    const requests: Array<{
      readonly url: string;
      readonly headers: Headers;
    }> = [];
    const runtime = wrapYurucommuWorkerBindings({
      APP_URL: "https://yurucommu.example.test",
      DELIVERY_QUEUE_NAME: "yurucommu-delivery",
      DELIVERY_DLQ_NAME: "yurucommu-delivery-dlq",
      TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION: managedMaterialization(),
      TAKOSUMI_MANAGED_RUNTIME: {
        async fetch(request: Request) {
          requests.push({
            url: request.url,
            headers: new Headers(request.headers),
          });
          return request.method === "POST"
            ? Response.json({ accepted: true, messageId: "message_1" })
            : Response.json({ ok: true });
        },
      } as unknown as YurucommuWorkerBindings["TAKOSUMI_MANAGED_RUNTIME"],
    });

    await runtime.KV.put("session:test", "value");
    await runtime.DELIVERY_QUEUE!.send({
      version: 1,
      type: "deliver_endpoint",
      jobId: "job_1",
      scheduledAt: "2026-07-29T12:00:00.000Z",
    });

    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]!.url).pathname).toBe(
      `/v1/resources/${encodeURIComponent(`tkrn:${workspaceId}:KeyValueStore:kv`)}/kv/keys/session%3Atest`,
    );
    expect(
      requests[0]!.headers.get("x-takosumi-managed-runtime-capability-ref"),
    ).toBe("secret:runtime/kv");
    expect(new URL(requests[1]!.url).pathname).toBe(
      `/v1/resources/${encodeURIComponent(`tkrn:${workspaceId}:Queue:delivery_queue`)}/queue/messages`,
    );
    expect(
      requests[1]!.headers.get("x-takosumi-managed-runtime-capability-ref"),
    ).toBe("secret:runtime/delivery_queue");
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
