import { expect, test } from "bun:test";
import { ApiError } from "./api/fetch.ts";

import { classifyProfileLoadFailure } from "./profile-load-failure.ts";

test("profile failure classification separates gone, missing, and retryable remote failures", () => {
  expect(
    classifyProfileLoadFailure(new ApiError(410, "Remote actor is gone")),
  ).toEqual({ kind: "gone", retryable: false });
  expect(classifyProfileLoadFailure(new ApiError(404, "missing"))).toEqual({
    kind: "not_found",
    retryable: false,
  });
  expect(classifyProfileLoadFailure(new ApiError(503, "offline"))).toEqual({
    kind: "unavailable",
    retryable: true,
  });
  expect(classifyProfileLoadFailure(new ApiError(502, "invalid"))).toEqual({
    kind: "invalid",
    retryable: true,
  });
  expect(classifyProfileLoadFailure(new Error("network"))).toEqual({
    kind: "generic",
    retryable: true,
  });
});
