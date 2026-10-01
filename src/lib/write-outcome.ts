import { ApiError } from "./api/fetch.ts";

export type WriteFailure = "rejected" | "unconfirmed";

/** Only a received non-timeout client HTTP error establishes rejection. */
export function classifyWriteFailure(error: unknown): WriteFailure {
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
