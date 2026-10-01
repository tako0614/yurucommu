import { ApiError } from "./api/fetch.ts";

export type MessageDeliveryFailure = "rejected" | "unconfirmed";

/** Only a received non-timeout client HTTP error establishes rejection. */
export function classifyMessageDeliveryFailure(
  error: unknown,
): MessageDeliveryFailure {
  if (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  ) {
    return "rejected";
  }
  return "unconfirmed";
}
