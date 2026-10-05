import { atom, type Getter } from "jotai/vanilla";
import {
  actorAtom,
  authSessionEpochAtom,
  hostedUserAtom,
  logoutBusyAtom,
  selectedInstanceIdAtom,
} from "./auth.ts";
import { getAuthStrategy } from "../lib/plugin.ts";
import { getYurucommuApiTransport } from "../lib/api.ts";

function captureScope(get: Getter, path: string) {
  const actor = get(actorAtom);
  if (!actor || get(logoutBusyAtom)) return null;
  const transport = getYurucommuApiTransport();
  return {
    actorId: actor.ap_id,
    epoch: get(authSessionEpochAtom),
    hostedUserId: get(hostedUserAtom)?.id ?? null,
    instanceId: get(selectedInstanceIdAtom),
    strategy: getAuthStrategy(),
    transport,
    url: transport.resolveUrl(path),
  };
}
type Scope = NonNullable<ReturnType<typeof captureScope>>;
function sameScope(a: Scope, b: Scope | null): boolean {
  return (
    b !== null &&
    a.actorId === b.actorId &&
    a.epoch === b.epoch &&
    a.hostedUserId === b.hostedUserId &&
    a.instanceId === b.instanceId &&
    a.strategy === b.strategy &&
    a.transport === b.transport &&
    a.url === b.url
  );
}

/** Each channel and Jotai store owns its read ordering and confirmed count. */
export function createUnreadCountAtoms(
  path: string,
  read: () => Promise<number>,
  errorMessage: string,
) {
  // Give observed auth changes a distinct identity, including A→B→A. Keep
  // imperative plugin resolution outside this cached, reactive projection.
  const authScope = atom((get) => ({
    actorId: get(actorAtom)?.ap_id ?? null,
    epoch: get(authSessionEpochAtom),
    hostedUserId: get(hostedUserAtom)?.id ?? null,
    instanceId: get(selectedInstanceIdAtom),
    logoutBusy: get(logoutBusyAtom),
  }));
  const confirmed = atom<{
    authScope: object;
    scope: Scope;
    count: number;
  } | null>(null);
  const ticket = atom(0);
  const count = atom((get) => {
    const value = get(confirmed);
    return value &&
      value.authScope === get(authScope) &&
      sameScope(value.scope, captureScope(get, path))
      ? value.count
      : 0;
  });
  const refresh = atom(null, async (get, set) => {
    const request = get(ticket) + 1;
    set(ticket, request);
    const capturedAuth = get(authScope);
    const scope = captureScope(get, path);
    const previous = get(confirmed);
    if (previous && (!scope || !sameScope(previous.scope, scope)))
      set(confirmed, null);
    if (!scope) return;
    const current = () =>
      request === get(ticket) &&
      capturedAuth === get(authScope) &&
      sameScope(scope, captureScope(get, path));
    try {
      const value = await read();
      if (!current()) return;
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Unread count is not a nonnegative safe integer");
      }
      set(confirmed, { authScope: capturedAuth, scope, count: value });
    } catch (error) {
      // Retain this scope's last confirmed count. A failed newer request still
      // retires older snapshots. Retired failures do not affect the new scope.
      if (current()) console.error(errorMessage, error);
    }
  });
  return { count, refresh };
}
