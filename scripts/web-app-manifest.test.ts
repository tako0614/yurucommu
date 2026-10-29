import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { contentTypeFor, createEntrySource } from "./build-yurucommu-worker.ts";

// What a phone needs to add Yurucommu to its home screen as its own app: a
// same-origin manifest, PNG icons of the sizes it declares, and an opaque
// apple-touch-icon for iOS. Vite copies public/ verbatim into dist/, and the
// Worker build embeds dist/, so the files below are the ones every install
// (direct Cloudflare, the Takoform Capsule, a released artifact) serves.

const publicDir = new URL("../public/", import.meta.url);
const indexHtml = await readFile(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const manifestText = await readFile(
  new URL("manifest.webmanifest", publicDir),
  "utf8",
);
const manifest = JSON.parse(manifestText) as {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

// PNG colour types (ISO/IEC 15948 §11.2.2): 2 is RGB without alpha.
const PNG_RGB = 2;

async function readPng(path: string) {
  const bytes = new Uint8Array(await readFile(new URL(path, publicDir)));
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...bytes.subarray(0, 8)], `${path} is a PNG`).toEqual(signature);
  expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("IHDR");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    bytes,
    width: view.getUint32(16),
    height: view.getUint32(20),
    colorType: bytes[25],
  };
}

function metaContent(name: string): string {
  const content = indexHtml.match(
    new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]+)"`),
  )?.[1];
  if (content === undefined) throw new Error(`index.html has no ${name} meta`);
  return content;
}

describe("web app manifest", () => {
  test("declares a standalone app rooted at this origin", () => {
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.name).toBe("Yurucommu");
    expect(manifest.short_name).toBe("Yurucommu");
    expect(manifest.description).toBe(metaContent("description"));
    // The document defaults to Japanese before the client picks a language.
    expect(indexHtml).toContain('<html lang="ja">');
    expect(manifest.lang).toBe("ja");
    // Yurucommu is dark-only (color-scheme: dark); the splash and the status
    // bar use the same canvas the pre-hydration guard paints.
    expect(metaContent("color-scheme")).toBe("dark");
    expect(manifest.theme_color).toBe(metaContent("theme-color"));
    expect(manifest.background_color).toBe("#0a0a0a");
    expect(indexHtml).toContain("background: #0a0a0a;");
  });

  test("every icon is a same-origin PNG of exactly its declared size", async () => {
    expect(
      manifest.icons.map(({ sizes, purpose }) => `${sizes}:${purpose}`),
    ).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
    for (const icon of manifest.icons) {
      expect(icon.src).toMatch(/^\/[^/]/);
      expect(icon.type).toBe("image/png");
      const png = await readPng(icon.src.slice(1));
      expect(`${png.width}x${png.height}`, icon.src).toBe(icon.sizes);
      // A maskable icon is cropped by the launcher, so it must be full-bleed:
      // any transparent pixel would show the launcher's own backdrop.
      if (icon.purpose === "maskable") expect(png.colorType).toBe(PNG_RGB);
    }
  });

  test("index.html links the manifest and an opaque 180px apple-touch-icon", async () => {
    expect(indexHtml).toContain(
      '<link rel="manifest" href="/manifest.webmanifest" />',
    );
    expect(indexHtml).toContain(
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
    );
    expect(metaContent("apple-mobile-web-app-title")).toBe(manifest.short_name);
    // iOS paints transparent apple-touch-icon pixels black.
    const appleTouchIcon = await readPng("apple-touch-icon.png");
    expect(appleTouchIcon).toMatchObject({
      width: 180,
      height: 180,
      colorType: PNG_RGB,
    });
    // The SVG favicon (also the Takosumi launcher icon) stays in place.
    expect(indexHtml).toContain(
      '<link rel="icon" type="image/svg+xml" href="/icons/yurucommu.svg" />',
    );
    expect(
      (await stat(new URL("icons/yurucommu.svg", publicDir))).isFile(),
    ).toBe(true);
  });
});

describe("Worker serving of the manifest and icons", () => {
  const entryFile = new URL(
    "../dist/yurucommu-entry.web-manifest-test.ts",
    import.meta.url,
  );
  const origin = "https://yurucommu.example.test";
  const hashedAsset = "assets/index-0123abcd.js";
  const servedFiles = [
    "manifest.webmanifest",
    "apple-touch-icon.png",
    ...manifest.icons.map(({ src }) => src.slice(1)),
  ];
  let worker: {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };

  afterAll(async () => {
    await rm(entryFile, { force: true });
  });

  async function loadWorker() {
    if (worker) return worker;
    const assets: Record<string, { contentType: string; body: string }> = {
      "index.html": {
        contentType: contentTypeFor("index.html"),
        body: Buffer.from(indexHtml).toString("base64"),
      },
      [hashedAsset]: {
        contentType: contentTypeFor(hashedAsset),
        body: Buffer.from("export {};").toString("base64"),
      },
    };
    for (const path of servedFiles) {
      assets[path] = {
        contentType: contentTypeFor(path),
        body: Buffer.from(await readFile(new URL(path, publicDir))).toString(
          "base64",
        ),
      };
    }
    await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
    await writeFile(entryFile, createEntrySource(assets));
    worker = (
      (await import(pathToFileURL(entryFile.pathname).href)) as {
        default: typeof worker;
      }
    ).default;
    return worker;
  }

  const env = () => ({
    DB: {
      prepare: () => ({
        bind: () => ({}),
        first: async () => null,
        all: async () => ({ results: [], success: true }),
        run: async () => ({ success: true }),
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
    },
    KV: {
      get: async () => null,
      getWithMetadata: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true, listComplete: true }),
    },
    APP_URL: origin,
    YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
    DELIVERY_QUEUE_NAME: "configured-delivery",
    DELIVERY_DLQ_NAME: "configured-delivery-dlq",
  });
  const ctx = { waitUntil: () => undefined };

  test("serves the manifest as application/manifest+json, cacheable but revalidated hourly", async () => {
    const { fetch } = await loadWorker();
    // A browser fetches the manifest with a generic Accept; a navigation-style
    // Accept must not turn it into the SPA shell either.
    for (const accept of ["*/*", "text/html,*/*"]) {
      const response = await fetch(
        new Request(`${origin}/manifest.webmanifest`, { headers: { accept } }),
        env(),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/manifest+json",
      );
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=3600",
      );
      expect((await response.json()) as typeof manifest).toEqual(manifest);
    }
  });

  test("serves every icon byte-for-byte as image/png", async () => {
    const { fetch } = await loadWorker();
    for (const path of servedFiles.filter((path) => path.endsWith(".png"))) {
      const response = await fetch(
        new Request(`${origin}/${path}`, { headers: { accept: "image/*" } }),
        env(),
        ctx,
      );
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=3600",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        (await readPng(path)).bytes,
      );
    }
  });

  test("keeps fingerprinted bundles immutable and the shell revalidated", async () => {
    const { fetch } = await loadWorker();
    const bundle = await fetch(
      new Request(`${origin}/${hashedAsset}`),
      env(),
      ctx,
    );
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const shell = await fetch(
      new Request(`${origin}/`, { headers: { accept: "text/html" } }),
      env(),
      ctx,
    );
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("no-cache");
  });

  test("the document CSP lets the browser load the same-origin manifest and icons", async () => {
    const { fetch } = await loadWorker();
    const shell = await fetch(
      new Request(`${origin}/`, { headers: { accept: "text/html" } }),
      env(),
      ctx,
    );
    const directives = new Map(
      (shell.headers.get("content-security-policy") ?? "")
        .split(";")
        .map((directive) => directive.trim().split(/\s+/))
        .filter(([name]) => name)
        .map(([name, ...sources]) => [name, sources]),
    );
    // No manifest-src: the manifest fetch falls back to default-src.
    expect(directives.has("manifest-src")).toBe(false);
    expect(directives.get("default-src")).toContain("'self'");
    expect(directives.get("img-src")).toContain("'self'");
  });

  test("a missing manifest-like file is a 404, not the SPA shell", async () => {
    const { fetch } = await loadWorker();
    const response = await fetch(
      new Request(`${origin}/site.webmanifest`, {
        headers: { accept: "text/html" },
      }),
      env(),
      ctx,
    );
    expect(response.status).toBe(404);
  });
});
