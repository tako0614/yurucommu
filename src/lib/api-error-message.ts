import { ApiError } from "./api/fetch.ts";

/** Keep server-authored user guidance without exposing arbitrary internal errors. */
export function humanFacingApiErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ApiError) {
    const message = error.message.trim();
    if (message) return message;
  }
  return fallback;
}
