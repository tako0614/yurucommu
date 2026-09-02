import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";

import {
  resolveYurucommuRuntimeLane,
  wrapYurucommuWorkerBindings,
  type YurucommuCloudflareBindings,
  type YurucommuPortableBindings,
  type YurucommuWorkerBindings,
} from "./yurucommu-worker-bindings.ts";

type Call = { readonly method: string; readonly args: readonly unknown[] };

/** A `D1Database` as far as the lane probe is concerned: prepare/batch, no execute. */
function nativeD1(): unknown {
  return {
    prepare: () => ({
      bind: () => ({}),
      first: async () => null,
      all: async () => ({ results: [], success: true }),
      run: async () => ({ success: true }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  };
}

/** `edge.sql@1.0.0`: execute/query/transaction, no prepare. */
function edgeSql(): unknown {
  return {
    execute: async () => ({ rows: [], rowsWritten: 0 }),
    query: async () => ({ rows: [], rowsWritten: 0 }),
    transaction: async () => [],
  };
}

function kvBinding(): unknown {
  // Deliberately the SAME five methods on both lanes: this binding is the one
  // the runtime cannot identify by shape, which is why the lane is declared.
  return {
    get: async () => null,
    getWithMetadata: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, listComplete: true }),
  };
}

/** An `R2Bucket`: recognisable by the multipart helpers the facade omits. */
function nativeR2(calls: Call[]): unknown {
  return {
    head: async () => null,
    get: async (key: string) => {
      calls.push({ method: "get", args: [key] });
      return {
        key,
        body: new Blob(["payload"]).stream(),
        httpEtag: '"r2-etag"',
        httpMetadata: { contentType: "text/plain" },
        size: 7,
      };
    },
    put: async (...args: unknown[]) => {
      calls.push({ method: "put", args });
      return {};
    },
    delete: async (...args: unknown[]) => {
      calls.push({ method: "delete", args });
    },
    list: async () => ({ objects: [], truncated: false }),
    createMultipartUpload: async () => ({}),
    resumeMultipartUpload: () => ({}),
  };
}

/**
 * `edge.objects@1.0.0`. The arities matter: the Host counts
 * `arguments.length`, so the probe requires `get` to declare its options slot.
 */
function edgeObjects(calls: Call[]): unknown {
  return {
    head: async (key: string) => {
      calls.push({ method: "head", args: [key] });
      return null;
    },
    get: async (key: string, options: unknown) => {
      calls.push({ method: "get", args: [key, options] });
      return {
        body: new Blob(["payload"]).stream(),
        partial: false,
        etag: "facade-etag",
        size: 7,
        contentType: "text/plain",
      };
    },
    put: async (key: string, body: unknown, options: unknown) => {
      calls.push({ method: "put", args: [key, body, options] });
      return { etag: "facade-etag", size: 7 };
    },
    delete: async (key: string) => {
      calls.push({ method: "delete", args: [key] });
    },
    list: async (options: unknown) => {
      calls.push({ method: "list", args: [options] });
      return { objects: [], prefixes: [], truncated: false };
    },
  };
}

function cloudflareQueue(calls: Call[]): unknown {
  return {
    send: async (...args: unknown[]) => {
      calls.push({ method: "send", args });
    },
    sendBatch: async (...args: unknown[]) => {
      calls.push({ method: "sendBatch", args });
    },
  };
}

function edgeQueue(calls: Call[]): unknown {
  return {
    send: async (...args: unknown[]) => {
      calls.push({ method: "send", args });
      return "accepted-id";
    },
    sendBatch: async (...args: unknown[]) => {
      calls.push({ method: "sendBatch", args });
      return ["accepted-id"];
    },
  };
}

function cloudflareBindings(
  overrides: Record<string, unknown> = {},
): YurucommuWorkerBindings {
  return {
    DB: nativeD1(),
    KV: kvBinding(),
    APP_URL: "https://yurucommu.example.test",
    ...overrides,
  } as unknown as YurucommuCloudflareBindings;
}

function portableBindings(
  overrides: Record<string, unknown> = {},
): YurucommuWorkerBindings {
  return {
    YURUCOMMU_RUNTIME_LANE: "portable",
    DB: edgeSql(),
    KV: kvBinding(),
    APP_URL: "https://yurucommu.example.test",
    ...overrides,
  } as unknown as YurucommuPortableBindings;
}

async function readAll(
  body: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!body) return "";
  return new Response(body as unknown as BodyInit).text();
}

describe("runtime lane declaration", () => {
  test("treats an absent or empty declaration as the Cloudflare lane", () => {
    expect(resolveYurucommuRuntimeLane({})).toBe("cloudflare");
    expect(
      resolveYurucommuRuntimeLane({ YURUCOMMU_RUNTIME_LANE: undefined }),
    ).toBe("cloudflare");
    expect(resolveYurucommuRuntimeLane({ YURUCOMMU_RUNTIME_LANE: "" })).toBe(
      "cloudflare",
    );
    expect(
      resolveYurucommuRuntimeLane({ YURUCOMMU_RUNTIME_LANE: "cloudflare" }),
    ).toBe("cloudflare");
  });

  test("accepts the portable facade lane", () => {
    expect(
      resolveYurucommuRuntimeLane({ YURUCOMMU_RUNTIME_LANE: "portable" }),
    ).toBe("portable");
  });

  // The module used to declare this value. It is not an alias for either lane,
  // and defaulting it would silently pick a binding shape for a deployment that
  // asked for something this build has never heard of.
  test("refuses the retired takoform-v1 declaration instead of defaulting", () => {
    expect(() =>
      resolveYurucommuRuntimeLane({ YURUCOMMU_RUNTIME_LANE: "takoform-v1" }),
    ).toThrow("takoform-v1");
    expect(() =>
      wrapYurucommuWorkerBindings(
        cloudflareBindings({ YURUCOMMU_RUNTIME_LANE: "takoform-v1" }),
      ),
    ).toThrow("YURUCOMMU_RUNTIME_LANE");
  });

  test("refuses a declaration the arriving bindings contradict", () => {
    // A wrapper host's facade under an undeclared (= Cloudflare) lane.
    expect(() =>
      wrapYurucommuWorkerBindings(
        cloudflareBindings({ DB: edgeSql() }) as YurucommuWorkerBindings,
      ),
    ).toThrow(/edge\.sql/);
    // A raw D1 binding under a portable declaration.
    expect(() =>
      wrapYurucommuWorkerBindings(portableBindings({ DB: nativeD1() })),
    ).toThrow(/D1Database/);
    // MEDIA is decisive in the one direction that can be proven.
    expect(() =>
      wrapYurucommuWorkerBindings(portableBindings({ MEDIA: nativeR2([]) })),
    ).toThrow(/R2Bucket/);
  });
});

describe("MEDIA on the cloudflare lane", () => {
  test("materializes the native R2 bucket as the product object store", async () => {
    const calls: Call[] = [];
    const bucket = nativeR2(calls);
    const runtime = wrapYurucommuWorkerBindings(
      cloudflareBindings({ MEDIA: bucket }),
    );

    expect(runtime.MEDIA).toBeDefined();
    expect(runtime.MEDIA).not.toBe(bucket);

    const blob = new Blob(["payload"], { type: "text/plain" });
    await runtime.MEDIA!.put("media/test", blob, { contentType: "text/plain" });
    expect(calls.at(-1)).toEqual({
      method: "put",
      args: [
        "media/test",
        blob,
        { httpMetadata: { contentType: "text/plain" } },
      ],
    });

    const object = await runtime.MEDIA!.get("media/test");
    expect(object).toMatchObject({
      key: "media/test",
      contentType: "text/plain",
      etag: '"r2-etag"',
      byteLength: 7,
    });
    expect(await readAll(object!.body)).toBe("payload");

    // R2 deletes a whole key list in one call.
    await runtime.MEDIA!.delete(["media/a", "media/b"]);
    expect(calls.at(-1)).toEqual({
      method: "delete",
      args: [["media/a", "media/b"]],
    });
  });

  test("leaves MEDIA absent when the deployment binds no bucket", () => {
    expect(wrapYurucommuWorkerBindings(cloudflareBindings()).MEDIA).toBe(
      undefined,
    );
  });
});

describe("MEDIA on the portable lane", () => {
  test("materializes the edge.objects facade as the same product object store", async () => {
    const calls: Call[] = [];
    const bucket = edgeObjects(calls);
    const runtime = wrapYurucommuWorkerBindings(
      portableBindings({ MEDIA: bucket }),
    );

    expect(runtime.MEDIA).toBeDefined();
    expect(runtime.MEDIA).not.toBe(bucket);

    // A streaming put must declare contentLength; a Blob already knows its size,
    // so the bytes stream rather than being buffered in the Worker.
    await runtime.MEDIA!.put(
      "media/test",
      new Blob(["payload"], { type: "text/plain" }),
      { contentType: "text/plain" },
    );
    const put = calls.at(-1)!;
    expect(put.method).toBe("put");
    expect(put.args[0]).toBe("media/test");
    expect(put.args[2]).toEqual({
      contentLength: 7,
      contentType: "text/plain",
    });

    const object = await runtime.MEDIA!.get("media/test");
    expect(object).toMatchObject({
      key: "media/test",
      contentType: "text/plain",
      etag: "facade-etag",
      byteLength: 7,
    });
    expect(await readAll(object!.body)).toBe("payload");
    // The Host counts arguments, so the options slot is always passed.
    expect(calls.find((call) => call.method === "get")?.args).toEqual([
      "media/test",
      undefined,
    ]);

    // The facade deletes one key at a time; the port's array form fans out.
    await runtime.MEDIA!.delete(["media/a", "media/b", "media/a"]);
    expect(
      calls.filter((call) => call.method === "delete").map((call) => call.args),
    ).toEqual([["media/a"], ["media/b"]]);
  });
});

describe("DB, KV, and queue producers per lane", () => {
  test("builds a database client from either binding without leaking DB", () => {
    for (const bindings of [cloudflareBindings(), portableBindings()]) {
      const runtime = wrapYurucommuWorkerBindings(bindings);
      expect(runtime.DB_INSTANCE).toBeDefined();
      expect(runtime).not.toHaveProperty("DB");
      expect(typeof runtime.KV.get).toBe("function");
    }
  });

  test("keeps the plain variables, including the lane, on the runtime env", () => {
    const runtime = wrapYurucommuWorkerBindings(
      portableBindings({ DELIVERY_QUEUE_NAME: "yurucommu-delivery" }),
    );
    expect(runtime.YURUCOMMU_RUNTIME_LANE).toBe("portable");
    expect(runtime.DELIVERY_QUEUE_NAME).toBe("yurucommu-delivery");
  });

  test("sends structured bodies on Cloudflare and JSON bytes on the facade", async () => {
    const cloudflareCalls: Call[] = [];
    const cloudflare = wrapYurucommuWorkerBindings(
      cloudflareBindings({ DELIVERY_QUEUE: cloudflareQueue(cloudflareCalls) }),
    );
    await cloudflare.DELIVERY_QUEUE!.send({ kind: "delivery" } as never);
    expect(cloudflareCalls.at(-1)?.args[0]).toEqual({ kind: "delivery" });

    const facadeCalls: Call[] = [];
    const portable = wrapYurucommuWorkerBindings(
      portableBindings({ DELIVERY_QUEUE: edgeQueue(facadeCalls) }),
    );
    await portable.DELIVERY_QUEUE!.send({ kind: "delivery" } as never);
    const body = facadeCalls.at(-1)?.args[0];
    expect(body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(body as Uint8Array)).toBe(
      '{"kind":"delivery"}',
    );
  });
});

describe("one composition for every deployment", () => {
  test("keeps no external-S3 seam and no second adapter file", async () => {
    const composition = await readFile(
      new URL("yurucommu-worker-bindings.ts", import.meta.url),
      "utf8",
    );
    for (const retired of [
      "adaptSealedS3ObjectStore",
      "SealedS3",
      "com.amazonaws.s3",
      "external_services",
      "IObjectStorage",
      "TAKOSUMI_MANAGED_RUNTIME",
    ]) {
      expect(composition).not.toContain(retired);
    }
    expect(composition).toContain("wrapRuntimeBindings");

    // The direct-Cloudflare adapter was a second composition for the lane this
    // one already serves; a reappearing copy is a fork of the runtime seam.
    expect(await readdir(new URL("./", import.meta.url))).not.toContain(
      "yurucommu-cloudflare-bindings.ts",
    );
  });
});
