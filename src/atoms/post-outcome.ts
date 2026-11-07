import { atom } from "jotai/vanilla";

type Caution = "pending" | "confirmed";
type Attempt = { version: 1; id: string; status: Caution; prior?: Caution };
export type PostOutcome =
  | { kind: "missing" }
  | { kind: "record"; attempt: Attempt; caution: Caution }
  | { kind: "invalid" | "unreadable" };
type OutcomeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A caution record, not server idempotency or an automatic resend queue. */
export function createPostOutcomeAtoms(
  namespace: string,
  getStorage: () => OutcomeStorage = () => globalThis.localStorage,
  events:
    | Pick<Window, "addEventListener" | "removeEventListener">
    | undefined = typeof window === "undefined" ? undefined : window,
) {
  const key = `${namespace}.outcome`;
  const revision = atom(0);
  const read = (): PostOutcome => {
    let raw: string | null;
    try {
      raw = getStorage().getItem(key);
    } catch {
      return { kind: "unreadable" };
    }
    if (raw === null) return { kind: "missing" };
    if (raw.length > 1024) return { kind: "invalid" };
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null)
        return { kind: "invalid" };
      const record = value as Partial<Attempt>;
      return record.version === 1 &&
        typeof record.id === "string" &&
        record.id.length > 0 &&
        record.id.length <= 128 &&
        (record.status === "pending" || record.status === "confirmed") &&
        (record.prior === undefined ||
          record.prior === "pending" ||
          record.prior === "confirmed")
        ? {
            kind: "record",
            attempt: record as Attempt,
            caution:
              record.status === "pending" || record.prior === "pending"
                ? "pending"
                : "confirmed",
          }
        : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  };
  revision.onMount = (refresh) => {
    // Storage events may have been missed while another account was selected.
    refresh((n) => n + 1);
    const changed = (event: Event) => {
      const change = event as StorageEvent;
      try {
        if (
          change.storageArea === getStorage() &&
          (change.key === key || change.key === null)
        )
          refresh((n) => n + 1);
      } catch {
        refresh((n) => n + 1);
      }
    };
    events?.addEventListener("storage", changed);
    return () => events?.removeEventListener("storage", changed);
  };
  const valueAtom = atom((get) => {
    get(revision);
    return read();
  });
  const beginAtom = atom(null, (_get, set) => {
    const previous = read();
    if (previous.kind === "invalid" || previous.kind === "unreadable")
      return null;
    try {
      const id = crypto.randomUUID();
      getStorage().setItem(
        key,
        JSON.stringify({
          version: 1,
          id,
          status: "pending",
          ...(previous.kind === "record" ? { prior: previous.caution } : {}),
        }),
      );
      set(revision, (n) => n + 1);
      return id;
    } catch {
      return null;
    }
  });
  const finishAtom = atom(
    null,
    (_get, set, input: { id: string; confirmed: boolean }) => {
      const current = read();
      if (current.kind === "missing") return !input.confirmed;
      if (current.kind !== "record" || current.attempt.id !== input.id)
        return false;
      try {
        const storage = getStorage();
        if (input.confirmed)
          storage.setItem(
            key,
            JSON.stringify({ ...current.attempt, status: "confirmed" }),
          );
        // Resolving this request cannot settle an earlier request. Give the
        // retained caution a fresh ID so this completion cannot erase it later.
        else if (current.attempt.prior)
          storage.setItem(
            key,
            JSON.stringify({
              version: 1,
              id: crypto.randomUUID(),
              status: current.attempt.prior,
            }),
          );
        else storage.removeItem(key);
        set(revision, (n) => n + 1);
        return true;
      } catch {
        // Keep the earlier pending record if confirmation/cleanup is denied.
        return false;
      }
    },
  );
  const discardAtom = atom(null, (get, set) => {
    const observed = get(valueAtom);
    const current = read();
    if (
      observed.kind !== current.kind ||
      current.kind === "unreadable" ||
      (observed.kind === "record" &&
        current.kind === "record" &&
        observed.attempt.id !== current.attempt.id)
    ) {
      set(revision, (n) => n + 1);
      return false;
    }
    try {
      getStorage().removeItem(key);
      set(revision, (n) => n + 1);
      return true;
    } catch {
      return false;
    }
  });
  // Synchronous storage checks protect other attempt IDs already observed at
  // completion. localStorage does not provide cross-tab atomic transactions.
  return { valueAtom, beginAtom, finishAtom, discardAtom };
}
