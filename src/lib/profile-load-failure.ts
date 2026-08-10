import { ApiError } from "./api/fetch.ts";

export type ProfileLoadFailureKind =
  "not_found" | "gone" | "unavailable" | "invalid" | "generic";

export interface ProfileLoadFailure {
  readonly kind: ProfileLoadFailureKind;
  readonly retryable: boolean;
}

export function classifyProfileLoadFailure(error: unknown): ProfileLoadFailure {
  if (error instanceof ApiError) {
    if (error.status === 404) return { kind: "not_found", retryable: false };
    if (error.status === 410) return { kind: "gone", retryable: false };
    if (error.status === 503) return { kind: "unavailable", retryable: true };
    if (error.status === 502) return { kind: "invalid", retryable: true };
  }
  return { kind: "generic", retryable: true };
}
