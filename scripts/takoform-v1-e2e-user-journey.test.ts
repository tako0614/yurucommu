import { describe, expect, test } from "bun:test";

import {
  callbackUriForLaunchUrl,
  hasCookieAttributes,
} from "./takoform-v1-e2e-user-journey.ts";

describe("normal OIDC runtime-input journey", () => {
  test("derives the exact callback from the assigned HTTPS launch URL", () => {
    expect(callbackUriForLaunchUrl("https://worker-123.apps.yuru.test/")).toBe(
      "https://worker-123.apps.yuru.test/api/auth/callback/takos",
    );
    expect(() => callbackUriForLaunchUrl("http://127.0.0.1:8787")).toThrow(
      "assigned launch URL must be HTTPS",
    );
  });

  test("does not guess an origin or accept credentialed launch URLs", () => {
    expect(() => callbackUriForLaunchUrl("http://127.0.0.1:8787")).toThrow(
      "assigned launch URL must be HTTPS",
    );
    expect(() =>
      callbackUriForLaunchUrl("https://user:pass@worker.apps.yuru.test/"),
    ).toThrow("credential-free absolute HTTP(S) URL");
  });

  test("matches cookie security attributes as exact tokens", () => {
    const session = "session=opaque; HttpOnly; Secure; SameSite=Strict; Path=/";
    expect(
      hasCookieAttributes(session, [
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Path=/",
      ]),
    ).toBe(true);
    expect(
      hasCookieAttributes("session=x; NotSecure; Path=/", ["Secure"]),
    ).toBe(false);
    expect(
      hasCookieAttributes("session=x; Secure; SameSite=Laxevil; Path=/", [
        "SameSite=Lax",
      ]),
    ).toBe(false);
    expect(
      hasCookieAttributes("session=x; Secure; Path=/evil", ["Path=/"]),
    ).toBe(false);
  });
});
