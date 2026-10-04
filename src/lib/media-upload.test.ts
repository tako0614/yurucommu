import { afterEach, expect, test } from "bun:test";
import {
  FileValidationError,
  maxImageFileSize,
  uploadMedia,
} from "@takosjp/yurucommu-api";
import { uploadProductMedia } from "./media-upload.ts";

const nativeFetch = globalThis.fetch;
const nativeFile = globalThis.File;
const fetchCalls: {
  url: string;
  file: File | null;
  filename: string | null;
}[] = [];

function interceptUploads() {
  fetchCalls.length = 0;
  globalThis.fetch = (async (input, init) => {
    const body = init?.body;
    const file = body instanceof FormData ? body.get("file") : null;
    fetchCalls.push({
      url: String(input),
      file: file instanceof File ? file : null,
      filename: file instanceof File ? file.name : null,
    });
    return Response.json({
      url: "https://media.invalid/object",
      r2_key: "fixture/object",
      content_type: file instanceof File ? file.type : "",
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = nativeFetch;
  globalThis.File = nativeFile;
  fetchCalls.length = 0;
});

test("Unicode product filenames upload through the SDK with original bytes and metadata", async () => {
  const originalBytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const original = new File([originalBytes], "日本語の写真.png", {
    type: "image/png",
    lastModified: 1_728_000_123_456,
  });
  const originalName = original.name;
  interceptUploads();

  await uploadProductMedia(original);

  expect(fetchCalls).toHaveLength(1);
  const uploaded = fetchCalls[0]!.file!;
  expect(fetchCalls[0]!.filename).toBe("media.png");
  expect(uploaded.type).toBe("image/png");
  expect(uploaded.size).toBe(original.size);
  expect(uploaded.lastModified).toBe(original.lastModified);
  expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(originalBytes);
  expect(original.name).toBe(originalName);
  expect(original.name).toBe("日本語の写真.png");
});

test("ASCII filenames use the same SDK multipart path without changing content", async () => {
  const originalBytes = new Uint8Array([10, 20, 30, 40]);
  const original = new File([originalBytes], "avatar.webp", {
    type: "image/webp",
    lastModified: 1_700_000_000_123,
  });
  interceptUploads();

  await uploadProductMedia(original);

  expect(fetchCalls).toHaveLength(1);
  const uploaded = fetchCalls[0]!.file!;
  expect(fetchCalls[0]!.filename).toBe("media.webp");
  expect(uploaded.type).toBe(original.type);
  expect(uploaded.size).toBe(original.size);
  expect(uploaded.lastModified).toBe(original.lastModified);
  expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(originalBytes);
  expect(original.name).toBe("avatar.webp");
});

test("SDK MIME and size refusals happen before original reads, File construction, and fetch", async () => {
  const invalidType = new File(["invalid"], "unsupported.bin", {
    type: "application/octet-stream",
  });
  const oversized = new File(
    [new Uint8Array(maxImageFileSize + 1)],
    "oversized.png",
    { type: "image/png" },
  );
  const originals = [invalidType, oversized];
  const reads = new Map(originals.map((file) => [file, 0]));
  for (const file of originals) {
    const arrayBuffer = file.arrayBuffer.bind(file);
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: async () => {
        reads.set(file, reads.get(file)! + 1);
        return arrayBuffer();
      },
    });
  }
  let fileConstructions = 0;
  globalThis.File = new Proxy(nativeFile, {
    construct(target, args, newTarget) {
      fileConstructions += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  interceptUploads();

  await expect(uploadProductMedia(invalidType)).rejects.toMatchObject({
    code: "INVALID_TYPE",
  });
  await expect(uploadProductMedia(oversized)).rejects.toMatchObject({
    code: "FILE_TOO_LARGE",
  });

  expect(reads.get(invalidType)).toBe(0);
  expect(reads.get(oversized)).toBe(0);
  expect(fileConstructions).toBe(0);
  expect(fetchCalls).toHaveLength(0);
});

test("the published SDK rejects an unadapted Unicode filename before fetch", async () => {
  const original = new File(["payload"], "プロフィール画像.png", {
    type: "image/png",
  });
  interceptUploads();

  const error = await uploadMedia(original).catch(
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(FileValidationError);
  expect(error).toMatchObject({ code: "INVALID_FILENAME" });
  expect(fetchCalls).toHaveLength(0);
});

test("only valid advertised upload expiry is forwarded without inventing a deadline", async () => {
  const cases = [
    "2026-10-11T20:00:00.000Z",
    undefined,
    null,
    1234,
    "not-a-date",
  ];
  for (const expiresAt of cases) {
    interceptUploads();
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          url: "/media/fixture.png",
          r2_key: "posts/fixture.png",
          content_type: "image/png",
          expires_at: expiresAt,
        }),
      { preconnect: nativeFetch.preconnect },
    );
    const result = await uploadProductMedia(
      new File(["bytes"], "file.png", { type: "image/png" }),
    );
    expect(result.expires_at).toBe(
      typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt))
        ? expiresAt
        : undefined,
    );
  }
});
