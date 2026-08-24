import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  adaptSealedS3ObjectStore,
  wrapYurucommuWorkerBindings,
  type SealedS3ObjectStoreBinding,
  type YurucommuWorkerBindings,
} from "./yurucommu-worker-bindings.ts";

function sealedObjectStore(): SealedS3ObjectStoreBinding {
  return {
    async put() {
      return { opaque: true };
    },
    async get(key) {
      const bytes = new TextEncoder().encode("payload");
      return {
        key,
        body: new Blob([bytes]).stream(),
        bodyUsed: false,
        httpEtag: '"etag"',
        arrayBuffer: async () => bytes.buffer,
        text: async () => "payload",
        json: async <T>() => JSON.parse("{}") as T,
        httpMetadata: { contentType: "text/plain" },
        customMetadata: { owner: "test" },
      };
    },
    async delete() {},
    async list() {
      return {
        objects: [
          {
            key: "media/test",
            size: 7,
            uploaded: new Date("2026-08-23T00:00:00.000Z"),
            etag: "etag",
            httpMetadata: { contentType: "text/plain" },
          },
        ],
        truncated: false,
        delimitedPrefixes: [],
      };
    },
    async head() {
      return {
        size: 7,
        etag: "etag",
        httpMetadata: { contentType: "text/plain" },
        customMetadata: { owner: "test" },
      };
    },
  };
}

describe("sealed S3-compatible object-store adapter", () => {
  test("consumes only an opaque runtime-native object binding", async () => {
    const storage = adaptSealedS3ObjectStore(sealedObjectStore());

    await expect(storage.put("media/test", "payload")).resolves.toBeUndefined();
    await expect(storage.get("media/test")).resolves.toMatchObject({
      key: "media/test",
      httpEtag: '"etag"',
    });
    await expect(storage.list()).resolves.toMatchObject({
      objects: [{ key: "media/test", size: 7 }],
      truncated: false,
    });
    await expect(storage.head("media/test")).resolves.toEqual({
      contentType: "text/plain",
      contentLength: 7,
      etag: "etag",
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { owner: "test" },
    });
  });

  test("fails closed on capability references and partial bindings", () => {
    for (const invalid of [
      "capability:media",
      {},
      { put() {}, get() {}, delete() {}, list() {} },
    ]) {
      expect(() => adaptSealedS3ObjectStore(invalid)).toThrow(
        "MEDIA must be a sealed S3-compatible object-store binding",
      );
    }
  });

  test("rejects object metadata outside the product contract", async () => {
    const invalidHead = {
      ...sealedObjectStore(),
      async head() {
        return { size: 7, httpMetadata: { contentType: 42 } };
      },
    } as unknown as SealedS3ObjectStoreBinding;
    const invalidGet = {
      ...sealedObjectStore(),
      async get() {
        return {
          key: "media/test",
          body: null,
          bodyUsed: false,
          httpEtag: 42,
          arrayBuffer: async () => new ArrayBuffer(0),
          text: async () => "",
          json: async <T>() => ({}) as T,
        };
      },
    } as unknown as SealedS3ObjectStoreBinding;

    await expect(
      adaptSealedS3ObjectStore(invalidHead).head("media/test"),
    ).rejects.toThrow("MEDIA object HTTP metadata is invalid");
    await expect(
      adaptSealedS3ObjectStore(invalidGet).get("media/test"),
    ).rejects.toThrow("MEDIA object etag is invalid");
  });

  test("keeps the hosted seam free of Cloudflare R2 types", async () => {
    const hosted = await readFile(
      new URL("yurucommu-worker-bindings.ts", import.meta.url),
      "utf8",
    );
    const direct = await readFile(
      new URL("yurucommu-cloudflare-bindings.ts", import.meta.url),
      "utf8",
    );
    expect(hosted).not.toContain("R2Bucket");
    expect(hosted).not.toContain("TAKOSUMI_MANAGED_RUNTIME");
    expect(direct).toContain("R2Bucket");
    expect(direct).toContain("wrapCloudflareBindings");
  });

  test("materializes MEDIA as the product object-store contract", () => {
    const bindings = {
      DB: { prepare() {} },
      KV: { get() {} },
      MEDIA: sealedObjectStore(),
      APP_URL: "https://yurucommu.example.test",
    } as unknown as YurucommuWorkerBindings;

    const runtime = wrapYurucommuWorkerBindings(bindings);
    expect(runtime.MEDIA).toBeDefined();
    expect(runtime.MEDIA).not.toBe(bindings.MEDIA);
    expect(runtime).not.toHaveProperty("TAKOSUMI_MANAGED_RUNTIME");
    expect(runtime).not.toHaveProperty(
      "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION",
    );
  });
});
