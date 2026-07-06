import { describe, expect, test } from "bun:test";
import { shouldAutoStartTakosumiOidc } from "../lib/auth-config.ts";

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
