import { expect, test } from "bun:test";

import { ApiError } from "./api/fetch.ts";
import { humanFacingApiErrorMessage } from "./api-error-message.ts";

test("API actions preserve a human-facing server retry instruction", () => {
  expect(
    humanFacingApiErrorMessage(
      new ApiError(
        503,
        "Domain block is active; retry to finish retained-content cleanup.",
      ),
      "generic error",
    ),
  ).toBe("Domain block is active; retry to finish retained-content cleanup.");
});

test("API actions do not expose arbitrary internal errors", () => {
  expect(
    humanFacingApiErrorMessage(
      new Error("database connection details"),
      "safe",
    ),
  ).toBe("safe");
  expect(humanFacingApiErrorMessage(new ApiError(500, "   "), "safe")).toBe(
    "safe",
  );
  expect(humanFacingApiErrorMessage(null, "safe")).toBe("safe");
});
