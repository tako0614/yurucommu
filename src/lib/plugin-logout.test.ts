import { afterEach, expect, test } from "bun:test";
import { clearYurucommuFrontendPlugin, getAuthStrategy } from "./plugin.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearYurucommuFrontendPlugin();
});

test("self-hosted logout refuses a non-success HTTP acknowledgement", async () => {
  const requests: Array<{
    url: string;
    method?: string;
    credentials?: string;
  }> = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    requests.push({
      url: String(input),
      method: init?.method,
      credentials: init?.credentials,
    });
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
    });
  }) as unknown as typeof fetch;

  await expect(getAuthStrategy().logout()).rejects.toThrow();
  expect(requests).toEqual([
    { url: "/api/auth/logout", method: "POST", credentials: "include" },
  ]);
});

test("self-hosted logout propagates a missing acknowledgement without retry", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new TypeError("connection lost");
  }) as unknown as typeof fetch;

  await expect(getAuthStrategy().logout()).rejects.toThrow("connection lost");
  expect(requests).toBe(1);
});

test("self-hosted logout accepts a successful protocol response", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(getAuthStrategy().logout()).resolves.toBeUndefined();
  expect(requests).toBe(1);
});
