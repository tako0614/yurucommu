import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";

import {
  FunctionalProbeMutationUncertainError,
  isFunctionalProbeMutationUncertain,
  isUnsafeAddress,
  parseCreatedPostResponse,
  parseLoginResponse,
  parseMutationSuccessResponse,
  runFunctionalProbe,
  verifyPostAbsent,
} from "./post-deploy-smoke.ts";

describe("post-deploy cleanup readback", () => {
  test("accepts a post detail that is no longer present", async () => {
    await expect(
      verifyPostAbsent("post-123", async (path) => {
        expect(path).toBe("/api/posts/post-123");
        return new Response(JSON.stringify({ error: "Post not found" }), {
          status: 404,
        });
      }),
    ).resolves.toBeUndefined();
  });

  test("fails closed when DELETE returns 200 but the post still reads", async () => {
    const marker = "e2e-post-marker";

    const failure = verifyPostAbsent("post-123", async () => {
      return new Response(
        JSON.stringify({ post: { ap_id: "post-123", content: marker } }),
        { status: 200 },
      );
    });

    await expect(failure).rejects.toThrow(
      "post cleanup readback still found the probe post",
    );
    await expect(failure).rejects.not.toThrow(marker);
  });

  test("accepts the pinned core's duplicated post projection and rejects drift", () => {
    const createdPost = {
      ap_id: "http://127.0.0.1:8787/ap/notes/post-1",
      type: "Note",
      author: {
        ap_id: "http://127.0.0.1:8787/ap/users/probe",
        username: "probe",
        preferred_username: "probe",
        name: null,
        icon_url: null,
      },
      content: "e2e-post-marker",
      summary: null,
      attachments: [],
      visibility: "public",
      published: "2026-09-04T00:00:00.000Z",
      like_count: 0,
      reply_count: 0,
      announce_count: 0,
      liked: false,
      bookmarked: false,
    };
    expect(() =>
      parseCreatedPostResponse(
        { ...createdPost, post: createdPost },
        "e2e-post-marker",
      ),
    ).not.toThrow();
    expect(() =>
      parseCreatedPostResponse(
        {
          ...createdPost,
          post: { ...createdPost, content: "different" },
        },
        "e2e-post-marker",
      ),
    ).toThrow("did not match");
    expect(() =>
      parseCreatedPostResponse(
        { ...createdPost, post: createdPost },
        "e2e-post-marker",
        "http://127.0.0.1:8787/ap/users/other",
      ),
    ).toThrow("author");
    expect(() =>
      parseCreatedPostResponse(
        { ...createdPost, post: createdPost, unexpected: true },
        "e2e-post-marker",
      ),
    ).toThrow("closed");
  });

  test("rejects unwrapped/malformed post POST bodies as mutation-uncertain", () => {
    expect(() => parseCreatedPostResponse({}, "e2e-post-marker")).toThrow(
      "closed",
    );
    expect(() =>
      parseCreatedPostResponse(
        {
          ap_id: "https://example.test/ap/notes/1",
          content: "e2e-post-marker",
        },
        "e2e-post-marker",
      ),
    ).toThrow("closed");
    expect(() =>
      parseCreatedPostResponse(
        {
          post: {
            ap_id: "https://example.test/ap/notes/1",
            content: "e2e-post-marker",
          },
        },
        "e2e-post-marker",
      ),
    ).toThrow("closed");
  });

  test("requires closed success bodies for unsafe cleanup mutations", () => {
    expect(() =>
      parseMutationSuccessResponse({}, "DELETE /api/posts/1"),
    ).toThrow("closed");
    expect(() =>
      parseMutationSuccessResponse({ success: false }, "DELETE /api/posts/1"),
    ).toThrow("success");
    expect(() =>
      parseMutationSuccessResponse({ success: true }, "DELETE /api/posts/1"),
    ).not.toThrow();
  });

  test("requires the closed login success envelope before accepting a cookie", () => {
    expect(() => parseLoginResponse({})).toThrow("closed");
    expect(() => parseLoginResponse({ success: false })).toThrow("success");
    expect(() => parseLoginResponse({ success: true })).not.toThrow();
  });

  test("refuses cleanup after a semantically malformed post POST", async () => {
    const calls: string[] = [];
    const transport = probeTransport(calls, (path, method) => {
      if (method === "POST" && path === "/api/posts") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return undefined;
    });
    const error = await runFunctionalProbe({
      launchUrl: "http://127.0.0.1:8787/",
      sessionCookie: "session=probe",
      transport,
    }).catch((value) => value);
    expect(isFunctionalProbeMutationUncertain(error)).toBe(true);
    expect(calls.some((path) => path.startsWith("DELETE /api/notes/me"))).toBe(
      false,
    );
    expect(calls.some((path) => path.startsWith("DELETE /api/posts/"))).toBe(
      false,
    );
  });

  test("does not dispatch note mutations while probing posts", async () => {
    const calls: string[] = [];
    const actorApId = "http://127.0.0.1:8787/ap/users/probe";
    const result = await runFunctionalProbe({
      launchUrl: "http://127.0.0.1:8787/",
      sessionCookie: "session=probe",
      expectedActorApId: actorApId,
      transport: probeTransport(calls),
    });
    expect(result.checks).not.toContain("notes.crud");
    expect(calls.some((path) => path === "POST /api/notes")).toBe(false);
    expect(calls.some((path) => path === "DELETE /api/notes/me")).toBe(false);
    expect(calls.some((path) => path === "DELETE /api/posts/post-1")).toBe(
      true,
    );
  });

  test("does not issue another cleanup mutation after a malformed DELETE", async () => {
    const calls: string[] = [];
    const transport = probeTransport(calls, (path, method) => {
      if (method === "DELETE" && path === "/api/posts/post-1") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return undefined;
    });
    const error = await runFunctionalProbe({
      launchUrl: "http://127.0.0.1:8787/",
      sessionCookie: "session=probe",
      transport,
    }).catch((value) => value);
    expect(isFunctionalProbeMutationUncertain(error)).toBe(true);
    expect(calls.some((path) => path === "DELETE /api/notes/me")).toBe(false);
  });

  test("propagates lost non-safe acknowledgements through aggregate failures", () => {
    const uncertain = new FunctionalProbeMutationUncertainError(
      "POST acknowledgement is indeterminate",
    );
    expect(isFunctionalProbeMutationUncertain(uncertain)).toBe(true);
    expect(
      isFunctionalProbeMutationUncertain(
        new AggregateError([uncertain], "probe"),
      ),
    ).toBe(true);
    expect(
      isFunctionalProbeMutationUncertain(new Error("definitive 400")),
    ).toBe(false);
  });

  test("uses the pinned transport and stable mutation keys in the probe", async () => {
    const source = await readFile(
      new URL("./post-deploy-smoke.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("createPinnedHttpTransport");
    expect(source).toContain("DNS answer changed");
    expect(source).toContain("rejects redirects");
    expect(source).toContain("Idempotency-Key");
    expect(source).toContain("probe cleanup refused");
    expect(source).not.toContain("fetch(new URL");
  });

  test("keeps note CRUD disabled until an owner-published scoped contract exists", async () => {
    const source = await readFile(
      new URL("./post-deploy-smoke.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain('path === "/api/notes"');
    expect(source).not.toContain('path === "/api/notes/me"');
    expect(source).not.toContain("noteCreated");
    expect(source).toContain("owner-published");
  });

  test("rejects a redirect from the pinned product origin", async () => {
    const { createPinnedHttpTransport } =
      await import("./post-deploy-smoke.ts");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.example.test/" },
        });
      },
    });
    try {
      const transport = await createPinnedHttpTransport(
        `http://127.0.0.1:${server.port}`,
      );
      await expect(
        transport.request(new URL(`http://127.0.0.1:${server.port}/`)),
      ).rejects.toThrow("rejects redirects");
    } finally {
      server.stop(true);
    }
  });

  test("bounds a stalled DNS resolver by the transport deadline and aborts it", async () => {
    const { createPinnedHttpTransport } =
      await import("./post-deploy-smoke.ts");
    let calls = 0;
    let aborted = false;
    const startedAt = Date.now();
    await expect(
      createPinnedHttpTransport("https://resolver.example.test", {
        timeoutMs: 25,
        resolveAddresses: async (_hostname, signal) => {
          calls += 1;
          await new Promise<readonly string[]>((_resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
          });
          return [];
        },
      }),
    ).rejects.toThrow("DNS resolution timed out");
    expect(calls).toBe(1);
    expect(aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("classifies canonical IPv4-mapped IPv6 bytes and special-use ranges", () => {
    expect(isUnsafeAddress("::ffff:7f00:1", false)).toBe(true);
    expect(isUnsafeAddress("0:0:0:0:0:ffff:7f00:0001", false)).toBe(true);
    expect(isUnsafeAddress("::FFFF:7F00:0001", false)).toBe(true);
    expect(isUnsafeAddress("::ffff:0808:0808", false)).toBe(false);
    expect(isUnsafeAddress("::ffff:6440:0001", false)).toBe(true);
    expect(isUnsafeAddress("::ffff:a9fe:0101", false)).toBe(true);
    expect(isUnsafeAddress("::ffff:c000:0201", false)).toBe(true);
    expect(isUnsafeAddress("2002:0a00::1", false)).toBe(true);
    expect(isUnsafeAddress("2002:7f00::1", false)).toBe(true);
    expect(isUnsafeAddress("2002:0808:0808::1", false)).toBe(false);
    expect(isUnsafeAddress("192.0.0.1", false)).toBe(true);
    expect(isUnsafeAddress("192.0.1.1", false)).toBe(false);
    expect(isUnsafeAddress("192.0.2.1", false)).toBe(true);
    expect(isUnsafeAddress("192.0.3.1", false)).toBe(false);
    expect(isUnsafeAddress("198.51.100.1", false)).toBe(true);
    expect(isUnsafeAddress("198.51.101.1", false)).toBe(false);
    expect(
      isUnsafeAddress("fe80:0000:0000:0000:0000:0000:0000:0001", false),
    ).toBe(true);
    expect(isUnsafeAddress("2001:4860:4860:0:0:0:0:8888", false)).toBe(false);
  });

  test("terminates a pinned body when the peer closes before its declared length", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 128\r\n\r\npartial",
        );
        setTimeout(() => socket.destroy(), 5);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server did not bind");
    try {
      const { createPinnedHttpTransport } =
        await import("./post-deploy-smoke.ts");
      const transport = await createPinnedHttpTransport(
        `http://127.0.0.1:${address.port}`,
        { timeoutMs: 250 },
      );
      const response = await transport.request(
        new URL(`http://127.0.0.1:${address.port}/`),
      );
      await expect(response.text()).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("keeps one deadline through a body that never finishes", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 128\r\n\r\npartial",
        );
        setTimeout(() => socket.destroy(), 100);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server did not bind");
    try {
      const { createPinnedHttpTransport } =
        await import("./post-deploy-smoke.ts");
      const transport = await createPinnedHttpTransport(
        `http://127.0.0.1:${address.port}`,
        { timeoutMs: 25 },
      );
      const response = await transport.request(
        new URL(`http://127.0.0.1:${address.port}/`),
      );
      await expect(response.text()).rejects.toThrow("timed out");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function probeTransport(
  calls: string[],
  override: (
    path: string,
    method: string,
    init: RequestInit,
  ) => Response | undefined = () => undefined,
) {
  let postContent = "";
  const origin = "http://127.0.0.1:8787";
  return {
    origin,
    async request(url: URL, init: RequestInit = {}) {
      const path = url.pathname;
      const method = init.method ?? "GET";
      calls.push(`${method} ${path}`);
      const customized = override(path, method, init);
      if (customized) return customized;
      if (method === "GET" && path === "/") {
        return new Response("shell", { status: 200 });
      }
      if (method === "GET" && path === "/healthz") {
        return jsonResponse({ status: "ok", missingBindings: [] });
      }
      if (method === "GET" && path === "/.well-known/social-server") {
        return jsonResponse({ version: "1" });
      }
      if (method === "GET" && path === "/api/auth/providers") {
        return jsonResponse({ password_enabled: true });
      }
      if (method === "GET" && path === "/api/auth/me") {
        return jsonResponse({ actor: { ap_id: `${origin}/ap/users/probe` } });
      }
      if (method === "GET" && path === "/api/recommendations/users") {
        return jsonResponse({ users: [] });
      }
      if (method === "POST" && path === "/api/posts") {
        const body = JSON.parse(String(init.body)) as { content: string };
        postContent = body.content;
        const created = {
          ap_id: `${origin}/ap/notes/post-1`,
          type: "Note",
          author: {
            ap_id: `${origin}/ap/users/probe`,
            username: "probe",
            preferred_username: "probe",
            name: null,
            icon_url: null,
          },
          content: postContent,
          summary: null,
          attachments: [],
          visibility: "public",
          published: "2026-09-04T00:00:00.000Z",
          like_count: 0,
          reply_count: 0,
          announce_count: 0,
          liked: false,
          bookmarked: false,
        };
        return jsonResponse({
          ...created,
          post: created,
        });
      }
      if (method === "GET" && path === "/api/posts/post-1") {
        if (!postContent) return jsonResponse({ error: "Post not found" }, 404);
        return jsonResponse({ post: { content: postContent } });
      }
      if (method === "DELETE" && path === "/api/posts/post-1") {
        postContent = "";
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected probe request ${method} ${path}`);
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
