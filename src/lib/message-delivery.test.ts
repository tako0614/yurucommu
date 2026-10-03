import { expect, test } from "bun:test";
import { ApiError } from "./api/fetch.ts";
import { classifyMessageDeliveryFailure } from "./message-delivery.ts";

test("transport, abort, response parsing and server failures remain unconfirmed", () => {
  for (const error of [
    new TypeError("network failed"),
    new DOMException("aborted", "AbortError"),
    new SyntaxError("invalid JSON response"),
    new ApiError(500, "server error"),
  ]) {
    expect(classifyMessageDeliveryFailure(error)).toBe("unconfirmed");
  }
});

test("timeouts and status-shaped foreign exceptions cannot establish rejection", () => {
  for (const error of [
    new ApiError(408, "request timeout"),
    { name: "ApiError", status: 422, message: "foreign lookalike" },
    Object.assign(new Error("foreign lookalike"), { status: 422 }),
  ]) {
    expect(classifyMessageDeliveryFailure(error)).toBe("unconfirmed");
  }
});

test("received non-timeout 4xx SDK responses are rejected", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    expect(
      classifyMessageDeliveryFailure(new ApiError(status, "request rejected")),
    ).toBe("rejected");
  }
});
