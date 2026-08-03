import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

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

const scheduleSource = {
  kind: "Schedule" as const,
  workspaceId,
  resourceId: `tkrn:${workspaceId}:Schedule:retention`,
  resourceGeneration: 1,
  resourceRevisionId: "rev_schedule_1",
};
const scheduleTarget = {
  ...target,
  resourceRevisionId: "rev_retention_1",
  entrypoint: "yurucommu.retention",
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

function managedBindings(
  fetch: (request: Request) => Promise<Response> = async (request) => {
    const pathname = new URL(request.url).pathname;
    if (request.url.includes("/relational/v1/batch")) {
      const body = (await request.clone().json()) as {
        statements: readonly unknown[];
      };
      return Response.json({
        contract: "takosumi.managed-relational-runtime/v1",
        results: body.statements.map(() => ({
          success: true,
          columns: [],
          rows: [],
          meta: {
            changed_db: false,
            changes: 0,
            duration: 0,
            last_row_id: 0,
            size_after: 0,
            rows_read: 0,
            rows_written: 0,
          },
        })),
      });
    }
    if (pathname.endsWith("/kv/keys")) {
      return Response.json({ keys: [] });
    }
    if (pathname.endsWith("/objects")) {
      return Response.json({ objects: [], truncated: false });
    }
    if (request.method === "GET") return new Response("managed-value");
    if (request.url.includes("/queue/messages")) {
      return Response.json({ accepted: true, messageId: "message_1" });
    }
    return Response.json({ ok: true });
  },
): {
  readonly bindings: YurucommuWorkerBindings;
  readonly requests: Request[];
} {
  const requests: Request[] = [];
  return {
    bindings: {
      APP_URL: "https://yurucommu.example.test",
      DELIVERY_QUEUE_NAME: "yurucommu-delivery",
      DELIVERY_DLQ_NAME: "yurucommu-delivery-dlq",
      TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION: managedMaterialization(),
      TAKOSUMI_MANAGED_RUNTIME: {
        async fetch(request: Request) {
          requests.push(request.clone() as unknown as globalThis.Request);
          return fetch(request);
        },
      } as unknown as YurucommuWorkerBindings["TAKOSUMI_MANAGED_RUNTIME"],
    },
    requests,
  };
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

function scheduleEnvelope(): TakosumiBackgroundEventEnvelope {
  return {
    abi: TAKOSUMI_BACKGROUND_EVENT_ABI,
    activationId: "activation_retention",
    activationRevisionId: "activation_retention_rev_1",
    principal,
    source: scheduleSource,
    target: scheduleTarget,
    retry: {
      maxAttempts: 1,
      retryDelaySeconds: 0,
      onExhausted: "fail",
    },
    event: {
      kind: "schedule",
      deliveryId: "retention_1",
      occurredAt: "2026-07-29T12:00:00.000Z",
      attempt: 1,
      source: scheduleSource,
      scheduledAt: "2026-07-29T12:00:00.000Z",
      cron: "0 * * * *",
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

describe("Yurucommu managed runtime binding selection", () => {
  test("rejects stale alias capability refs and mixed native/gateway bindings", () => {
    const managed = managedBindings();
    expect(() =>
      wrapYurucommuWorkerBindings({
        ...managed.bindings,
        DB: "capability:yurucommu/database",
      }),
    ).toThrow(
      "managed runtime must not expose DB as a native or capability-ref binding",
    );

    expect(() =>
      wrapYurucommuWorkerBindings({
        ...managed.bindings,
        KV: nativeBindings().KV,
      }),
    ).toThrow(
      "managed runtime must not expose KV as a native or capability-ref binding",
    );
  });

  test("rejects missing gateway/materialization instead of falling back to native", () => {
    expect(() =>
      wrapYurucommuWorkerBindings({
        APP_URL: "https://yurucommu.example.test",
        TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION: "{}",
      }),
    ).toThrow(
      "managed runtime requires its exact materialization and Fetch gateway",
    );

    expect(() =>
      wrapYurucommuWorkerBindings({
        APP_URL: "https://yurucommu.example.test",
        TAKOSUMI_MANAGED_RUNTIME: {} as never,
      }),
    ).toThrow(
      "managed runtime requires its exact materialization and Fetch gateway",
    );
  });

  test("rejects stale or partial materialization", () => {
    const staleGateway = JSON.parse(managedMaterialization()) as Record<
      string,
      unknown
    >;
    staleGateway.gateway = {
      binding: "YURUCOMMU_MANAGED_RUNTIME",
      transport: "fetch",
    };
    expect(() =>
      wrapYurucommuWorkerBindings({
        ...managedBindings().bindings,
        TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION: JSON.stringify(staleGateway),
      }),
    ).toThrow("managed runtime materialization selects another gateway");

    const partial = JSON.parse(managedMaterialization()) as {
      connections: unknown[];
    };
    partial.connections.pop();
    expect(() =>
      wrapYurucommuWorkerBindings({
        ...managedBindings().bindings,
        TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION: JSON.stringify(partial),
      }),
    ).toThrow(
      "managed runtime materialization does not cover the exact Yurucommu graph",
    );
  });

  test("materializes relational CRUD, KV/object storage, and both queues only through the gateway", async () => {
    const managed = managedBindings();
    const runtime = wrapYurucommuWorkerBindings(managed.bindings);

    expect(runtime).not.toHaveProperty("TAKOSUMI_MANAGED_RUNTIME");
    expect(runtime).not.toHaveProperty(
      "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION",
    );
    expect(Object.keys(runtime)).not.toContain(
      "x-takosumi-managed-runtime-capability-ref",
    );
    expect(
      Object.values(runtime).filter((value) => typeof value === "string"),
    ).not.toContain("secret:runtime");

    await runtime.DB_INSTANCE.run(sql.raw("INSERT INTO actors VALUES (1)"));
    await runtime.DB_INSTANCE.run(sql.raw("SELECT * FROM actors"));
    await runtime.DB_INSTANCE.run(sql.raw("UPDATE actors SET role = 'owner'"));
    await runtime.DB_INSTANCE.run(sql.raw("DELETE FROM actors WHERE id = 1"));

    const kv = runtime.KV;
    await kv.put("session:test", "value", {
      expirationTtl: 60,
      metadata: { source: "test" },
    });
    expect(await kv.get("session:test")).toBe("managed-value");
    expect(await kv.list()).toEqual({
      keys: [],
      list_complete: true,
    });
    await kv.delete("session:test");

    const media = runtime.MEDIA!;
    await media.put("media:test", "value", {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { source: "test" },
    });
    await media.get("media:test");
    await media.head("media:test");
    await media.list();
    await media.delete("media:test");

    await runtime.DELIVERY_QUEUE!.send({
      version: 1,
      type: "deliver_endpoint",
      jobId: "job_1",
      scheduledAt: "2026-07-29T12:00:00.000Z",
    });
    await runtime.DELIVERY_QUEUE!.sendBatch([
      {
        body: {
          version: 1,
          type: "deliver_endpoint",
          jobId: "job_2",
          scheduledAt: "2026-07-29T12:00:00.000Z",
        },
      },
    ]);
    await runtime.DELIVERY_DLQ!.send({
      version: 1,
      type: "dlq",
      jobId: "job_3",
      activityId: "activity_3",
      endpoint: "https://remote.example.test/inbox",
      attempts: 1,
      lastError: null,
      deadLetteredAt: "2026-07-29T12:00:00.000Z",
    });

    expect(managed.requests.length).toBeGreaterThanOrEqual(13);
    expect(
      managed.requests.every(
        (request) =>
          request.headers.get("x-takosumi-managed-runtime-capability-ref") !==
          null,
      ),
    ).toBe(true);
    expect(
      managed.requests.map((request) => new URL(request.url).pathname),
    ).toEqual(
      expect.arrayContaining([
        "/v1/resources/tkrn%3Aws_managed_test%3ARelationalDatabase%3Adb/relational/v1/batch",
        "/v1/resources/tkrn%3Aws_managed_test%3AKeyValueStore%3Akv/kv/keys/session%3Atest",
        "/v1/resources/tkrn%3Aws_managed_test%3AObjectBucket%3Amedia/objects/media%3Atest",
        "/v1/resources/tkrn%3Aws_managed_test%3AQueue%3Adelivery_queue/queue/messages",
        "/v1/resources/tkrn%3Aws_managed_test%3AQueue%3Adelivery_queue/queue/messages/batch",
        "/v1/resources/tkrn%3Aws_managed_test%3AQueue%3Adelivery_dlq/queue/messages",
      ]),
    );
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

  test("rejects a forged managed background invocation before gateway or handler", async () => {
    const managed = managedBindings();
    let called = false;
    const response = await handleTakosumiBackgroundEventInvocation({
      request: await requestFor(queueEnvelope()),
      bindings: managed.bindings,
      ctx: {} as TakosumiBackgroundExecutionContext,
      handlers: handlers(async () => {
        called = true;
      }),
    });

    expect(response?.status).toBe(403);
    expect(called).toBe(false);
    expect(managed.requests).toHaveLength(0);
  });

  test("dispatches an authenticated managed queue event through the gateway", async () => {
    const managed = managedBindings();
    const envelope = queueEnvelope();
    let called = false;
    const response = await handleTakosumiBackgroundEventInvocation({
      request: await requestFor(envelope),
      bindings: managed.bindings,
      ctx: await contextFor(envelope),
      handlers: {
        queue: async (batch, env) => {
          called = true;
          expect(env).not.toHaveProperty("TAKOSUMI_MANAGED_RUNTIME");
          expect(env).not.toHaveProperty(
            "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION",
          );
          expect(await env.KV.get("background:probe")).toBe("managed-value");
          batch.ackAll();
        },
        scheduled: async () => {
          throw new Error("schedule handler must not be called");
        },
      },
    });

    expect(called).toBe(true);
    expect(response?.status).toBe(200);
    expect(managed.requests).toHaveLength(1);
    expect((await response!.json()) as unknown).toEqual({
      version: TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION,
      deliveryId: "delivery_1",
      activationRevisionId: "activation_delivery_rev_1",
      targetResourceRevisionId: "rev_http_1",
      outcome: "ack",
    });
  });

  test("dispatches an authenticated managed schedule event and preserves the cron", async () => {
    const managed = managedBindings();
    const envelope = scheduleEnvelope();
    let called = false;
    const response = await handleTakosumiBackgroundEventInvocation({
      request: await requestFor(envelope),
      bindings: managed.bindings,
      ctx: await contextFor(envelope),
      handlers: {
        queue: async () => {
          throw new Error("queue handler must not be called");
        },
        scheduled: async (controller, env) => {
          called = true;
          expect(controller.cron).toBe("0 * * * *");
          expect(controller.scheduledTime).toBe(
            Date.parse("2026-07-29T12:00:00.000Z"),
          );
          expect(await env.KV.get("retention:probe")).toBe("managed-value");
        },
      },
    });

    expect(called).toBe(true);
    expect(response?.status).toBe(200);
    expect(managed.requests).toHaveLength(1);
    expect((await response!.json()) as unknown).toEqual({
      version: TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION,
      deliveryId: "retention_1",
      activationRevisionId: "activation_retention_rev_1",
      targetResourceRevisionId: "rev_retention_1",
      outcome: "ack",
    });
  });
});
