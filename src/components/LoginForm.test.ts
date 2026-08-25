import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  claimTakosumiOidcAutoStart,
  shouldAutoStartTakosumiOidc,
  suppressTakosumiOidcAutoStart,
} from "../lib/auth-config.ts";

describe("LoginForm Takosumi OIDC auto-start", () => {
  test("auto-starts only when Takosumi Accounts is the sole passwordless auth method", () => {
    expect(
      shouldAutoStartTakosumiOidc({
        password_enabled: false,
        providers: [{ id: "takos", name: "Takosumi Accounts", icon: "" }],
      }),
    ).toBe(true);

    expect(
      shouldAutoStartTakosumiOidc({
        password_enabled: true,
        providers: [{ id: "takos", name: "Takosumi Accounts", icon: "" }],
      }),
    ).toBe(false);

    expect(
      shouldAutoStartTakosumiOidc({
        password_enabled: false,
        providers: [
          { id: "takos", name: "Takosumi Accounts", icon: "" },
          { id: "google", name: "Google", icon: "" },
        ],
      }),
    ).toBe(false);
  });
});

describe("LoginForm authentication errors", () => {
  test("shows OAuth-only callback errors in the shared auth-methods view", () => {
    const source = readFileSync(
      new URL("./LoginForm.tsx", import.meta.url),
      "utf8",
    );
    const authMethodsIndex = source.indexOf(
      "when={hasOAuth() || hasPassword()}",
    );
    const alertIndex = source.indexOf('role="alert"');
    const passwordSectionIndex = source.indexOf("{/* Password Form */}");

    expect(authMethodsIndex).toBeGreaterThanOrEqual(0);
    expect(alertIndex).toBeGreaterThanOrEqual(0);
    expect(alertIndex).toBeGreaterThan(authMethodsIndex);
    expect(passwordSectionIndex).toBeGreaterThan(alertIndex);
    expect(source.slice(alertIndex, passwordSectionIndex)).toContain(
      "{props.error}",
    );
    expect(source.match(/role="alert"/g)).toHaveLength(1);
  });
});

describe("Takosumi OIDC auto-start breaker", () => {
  const fakeStorage = (): Storage => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  };

  test("allows exactly one automatic redirect per browser tab", () => {
    // Without this, a failed OIDC round-trip re-renders the login screen and
    // redirects again — an inescapable loop with no visible provider button.
    const storage = fakeStorage();
    expect(claimTakosumiOidcAutoStart(storage)).toBe(true);
    expect(claimTakosumiOidcAutoStart(storage)).toBe(false);
  });

  test("an explicit sign-out blocks the next auto-start", () => {
    // The Takosumi session outlives ours: an unsuppressed auto-start redirects
    // and signs the user straight back in, so logging out does nothing.
    const storage = fakeStorage();
    suppressTakosumiOidcAutoStart(storage);
    expect(claimTakosumiOidcAutoStart(storage)).toBe(false);
  });

  test("a browser that refuses sessionStorage still reaches sign-in", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(claimTakosumiOidcAutoStart(refusing)).toBe(true);
    expect(() => suppressTakosumiOidcAutoStart(refusing)).not.toThrow();
    expect(claimTakosumiOidcAutoStart(undefined)).toBe(true);
  });
});
