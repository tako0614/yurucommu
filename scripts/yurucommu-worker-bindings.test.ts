import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  wrapDirectCloudflareWorkerBindings,
  type DirectCloudflareWorkerBindings,
} from "./yurucommu-cloudflare-bindings.ts";
import {
  adaptSealedS3ObjectStore,
  wrapYurucommuWorkerBindings,
  type SealedS3ObjectStoreBinding,
  type YurucommuWorkerBindings,
} from "./yurucommu-worker-bindings.ts";

function sealedFetcher(
  handler: (request: Request) => Response | Promise<Response>,
): SealedS3ObjectStoreBinding {
  return {
    async fetch(request) {
      return await handler(request);
    },
  };
}

async function captureRejection(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  let rejection: unknown;
  try {
    await operation();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeDefined();
  return rejection;
}

function inspectRecursively(value: unknown, seen = new Set<object>()): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const inspected: Record<string, unknown> = {};
  for (const property of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (!descriptor || !("value" in descriptor)) continue;
    inspected[String(property)] = inspectRecursively(descriptor.value, seen);
  }
  return inspected;
}

describe("sealed S3-compatible object-store adapter", () => {
  test("accepts literal and platform fetch-only bucket capabilities", () => {
    const binding = sealedFetcher(() => new Response(null, { status: 204 }));
    const platformBinding = Object.preventExtensions(
      Object.create({
        async fetch() {
          return new Response(null, { status: 204 });
        },
      }),
    );

    expect(Reflect.ownKeys(binding)).toEqual(["fetch"]);
    expect(Reflect.ownKeys(platformBinding)).toEqual([]);
    expect(() => adaptSealedS3ObjectStore(binding)).not.toThrow();
    expect(() => adaptSealedS3ObjectStore(platformBinding)).not.toThrow();
  });

  test("keeps object bodies lazy and exposes only flat provider-neutral metadata", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("payload"));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: {
        "content-length": "7",
        "content-type": "text/plain",
        etag: '"etag"',
        "x-amz-bucket": "private-bucket",
        "x-amz-credential": "private-credential",
      },
    });
    const primedPulls = pulls;
    const storage = adaptSealedS3ObjectStore(sealedFetcher(() => response));

    const object = await storage.get("media/test");

    expect(object).not.toBeNull();
    expect(object).toMatchObject({
      key: "media/test",
      contentType: "text/plain",
      etag: '"etag"',
      byteLength: 7,
    });
    expect(Object.keys(object!).sort()).toEqual([
      "body",
      "byteLength",
      "contentType",
      "etag",
      "key",
    ]);
    expect(object).not.toHaveProperty("bodyUsed");
    expect(object).not.toHaveProperty("httpEtag");
    expect(object).not.toHaveProperty("httpMetadata");
    expect(object).not.toHaveProperty("customMetadata");
    expect(pulls).toBeGreaterThanOrEqual(primedPulls);
    expect(pulls).toBeLessThanOrEqual(primedPulls + 1);

    expect(await new Response(object!.body).text()).toBe("payload");
    expect(pulls).toBe(1);
  });

  test("uses the Core S3 adapter without exposing endpoint, bucket, or credential material", async () => {
    const requests: Request[] = [];
    const storage = adaptSealedS3ObjectStore(
      sealedFetcher((request) => {
        requests.push(request);
        return new Response(null, { status: 204 });
      }),
    );

    await storage.put("media/a b", "payload", { contentType: "text/plain" });
    await storage.delete(["media/a b", "media/other"]);

    expect(requests.map((request) => request.method)).toEqual([
      "PUT",
      "DELETE",
      "DELETE",
    ]);
    expect(requests.map((request) => new URL(request.url).origin)).toEqual([
      "https://s3.invalid",
      "https://s3.invalid",
      "https://s3.invalid",
    ]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/media/a%20b",
      "/media/a%20b",
      "/media/other",
    ]);
    expect(requests[0]?.headers.get("content-type")).toBe("text/plain");
    const wire = requests
      .map((request) => `${request.url}\n${[...request.headers].join("\n")}`)
      .join("\n");
    expect(wire).not.toContain("private-bucket");
    expect(wire).not.toContain("private-credential");
    expect(wire).not.toContain("storage.example.test");
  });

  test("redacts provider material from rejected Fetcher operations", async () => {
    const providerDetail =
      "https://private-bucket.storage.example.test access-key=private-credential";
    const storage = adaptSealedS3ObjectStore(
      sealedFetcher(() => {
        throw new Error(providerDetail);
      }),
    );

    for (const [operation, invoke] of [
      ["put", () => storage.put("media/test", "payload")],
      ["get", () => storage.get("media/test")],
      ["delete", () => storage.delete("media/test")],
    ] as const) {
      let rejection: unknown;
      try {
        await invoke();
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({
        name: "S3FetchObjectStoreError",
        operation,
        code: `s3_fetcher_${operation}_rejected`,
      });
      expect(rejection).not.toHaveProperty("cause");
      const visible = `${String(rejection)}\n${
        rejection instanceof Error ? rejection.stack : ""
      }\n${JSON.stringify(rejection)}`;
      expect(visible).not.toContain(providerDetail);
      expect(visible).not.toContain("private-bucket");
      expect(visible).not.toContain("private-credential");
    }
  });

  test("recursively redacts lazy body read and cancel rejections from the Core boundary", async () => {
    const providerSecrets = [
      "https://private-bucket.storage.example.test",
      "private-access-key",
      "private-credential",
    ] as const;
    const providerRejection = () => {
      const leaf = Object.assign(
        new Error(
          `${providerSecrets[0]} access-key=${providerSecrets[1]} credential=${providerSecrets[2]}`,
        ),
        {
          endpoint: providerSecrets[0],
          cause: { authorization: `Bearer ${providerSecrets[2]}` },
        },
      );
      return Object.assign(
        new AggregateError([leaf, { nested: leaf }], "provider stream failed"),
        { cause: { retry: leaf } },
      );
    };
    const expectRedacted = (
      rejection: unknown,
      code: "s3_response_body_read_failed" | "s3_response_body_cancel_failed",
    ) => {
      expect(rejection).toMatchObject({
        name: "S3FetchObjectStoreError",
        operation: "get",
        code,
        message: code,
      });
      expect(rejection).not.toHaveProperty("cause");
      const visible = [
        String(rejection),
        JSON.stringify(rejection),
        JSON.stringify(inspectRecursively(rejection)),
      ].join("\n");
      for (const secret of providerSecrets) {
        expect(visible).not.toContain(secret);
      }
    };

    let rejectRead: (() => void) | undefined;
    const readBody = new ReadableStream<Uint8Array>({
      start(controller) {
        rejectRead = () => controller.error(providerRejection());
      },
    });
    const readStorage = adaptSealedS3ObjectStore(
      sealedFetcher(() => new Response(readBody, { status: 200 })),
    );
    const object = await readStorage.get("media/lazy-read");
    rejectRead?.();
    const readRejection = await captureRejection(async () =>
      new Response(object!.body).arrayBuffer(),
    );
    expectRedacted(readRejection, "s3_response_body_read_failed");

    const cancelStorage = adaptSealedS3ObjectStore(
      sealedFetcher(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                return Promise.reject(providerRejection());
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const cancelled = await cancelStorage.get("media/lazy-cancel");
    const cancelRejection = await captureRejection(() =>
      cancelled!.body!.cancel("caller stopped"),
    );
    expectRedacted(cancelRejection, "s3_response_body_cancel_failed");
  });

  test("fails closed on legacy, Cloudflare-shaped, accessor, and expanded bindings", () => {
    const cloudflareR2Shape = {
      async put() {},
      async get() {
        return null;
      },
      async delete() {},
      async list() {
        return { objects: [], truncated: false };
      },
      async head() {
        return null;
      },
    };
    const accessorFetch = Object.defineProperty({}, "fetch", {
      enumerable: true,
      get() {
        return async () => new Response(null, { status: 204 });
      },
    });
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private-credential");
        },
      },
    );
    for (const invalid of [
      "capability:media",
      {},
      { fetch: "not-a-function" },
      cloudflareR2Shape,
      accessorFetch,
      throwingProxy,
      {
        async fetch() {
          return new Response(null, { status: 204 });
        },
        endpoint: "https://storage.example.test",
      },
    ]) {
      expect(() => adaptSealedS3ObjectStore(invalid)).toThrow(
        "MEDIA must be an exact sealed S3 fetch binding",
      );
    }
  });

  test("keeps the hosted seam on Core's adapter and the direct Cloudflare seam native", async () => {
    const hosted = await readFile(
      new URL("yurucommu-worker-bindings.ts", import.meta.url),
      "utf8",
    );
    const direct = await readFile(
      new URL("yurucommu-cloudflare-bindings.ts", import.meta.url),
      "utf8",
    );
    expect(hosted).toContain("createS3FetchObjectStore");
    expect(hosted).not.toMatch(
      /\bIObjectStorage\b|\bListObjectsResult\b|\bObjectMetadata\b|\bStorageObject\b/u,
    );
    expect(hosted).not.toMatch(
      /\bhead\b|\blist\b|httpMetadata|httpEtag|bodyUsed/u,
    );
    expect(hosted).not.toContain("R2Bucket");
    expect(hosted).not.toContain("TAKOSUMI_MANAGED_RUNTIME");
    expect(direct).toContain("R2Bucket");
    expect(direct).toContain("wrapCloudflareBindings");
  });

  test("materializes the fetch capability as the app ObjectStore", async () => {
    const media = sealedFetcher(
      () =>
        new Response("payload", {
          status: 200,
          headers: {
            "content-length": "7",
            "content-type": "text/plain",
          },
        }),
    );
    const bindings = {
      DB: { prepare() {} },
      KV: { get() {} },
      MEDIA: media,
      APP_URL: "https://yurucommu.example.test",
    } as unknown as YurucommuWorkerBindings;

    const runtime = wrapYurucommuWorkerBindings(bindings);

    expect(runtime.MEDIA).toBeDefined();
    expect(runtime.MEDIA).not.toBe(media);
    expect(runtime.MEDIA).not.toHaveProperty("head");
    expect(runtime.MEDIA).not.toHaveProperty("list");
    await expect(runtime.MEDIA!.get("media/test")).resolves.toMatchObject({
      key: "media/test",
      contentType: "text/plain",
      byteLength: 7,
    });
    expect(runtime).not.toHaveProperty("TAKOSUMI_MANAGED_RUNTIME");
    expect(runtime).not.toHaveProperty(
      "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION",
    );
  });

  test("keeps direct Cloudflare R2 on Core's native Cloudflare adapter", async () => {
    let received:
      | {
          readonly key: string;
          readonly value: unknown;
        }
      | undefined;
    const bindings = {
      DB: { prepare() {} },
      KV: { get() {} },
      MEDIA: {
        async put(key: string, value: unknown) {
          received = { key, value };
        },
        async get() {
          return null;
        },
        async delete() {},
        async createMultipartUpload() {},
        resumeMultipartUpload() {},
      },
      APP_URL: "https://yurucommu.example.test",
    } as unknown as DirectCloudflareWorkerBindings;

    const runtime = wrapDirectCloudflareWorkerBindings(bindings);
    await runtime.MEDIA!.put("media/direct", "payload", {
      contentType: "text/plain",
    });

    expect(received).toEqual({
      key: "media/direct",
      value: "payload",
    });
  });

  test("cross-rejects a hosted Fetcher at the direct Cloudflare adapter", () => {
    const bindings = {
      DB: { prepare() {} },
      KV: { get() {} },
      MEDIA: sealedFetcher(() => new Response(null, { status: 204 })),
      APP_URL: "https://yurucommu.example.test",
    } as unknown as DirectCloudflareWorkerBindings;

    expect(() => wrapDirectCloudflareWorkerBindings(bindings)).toThrow(
      "MEDIA must be a native Cloudflare R2 binding",
    );
  });
});
