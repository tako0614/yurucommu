import { atom, type Setter } from "jotai/vanilla";
import type { Actor } from "../types/index.ts";
import { tAtom } from "./i18n.ts";
import {
  getAuthStrategy,
  isDefaultSelfHostedAuthStrategy,
  type HostedInstance,
  type HostedUserInfo,
  type InstanceHealth,
} from "../lib/plugin.ts";
import { resetScopeAtom } from "./scope.ts";
import { clearYurucommuBrowserPushBeforeSignOut } from "../lib/browser-push.ts";
import { suppressTakosumiOidcAutoStart } from "../lib/auth-config.ts";

export type { HostedInstance };

/**
 * Resolve the strategy only when the UI actually performs auth work.
 *
 * This module is imported by the default App component before
 * bootstrapYurucommuFrontend() installs embedder plugins. Resolving at module
 * evaluation time therefore permanently cached the self-hosted strategy and
 * made a correctly supplied hosted plugin ineffective.
 */
export function isHostedDeployment(): boolean {
  return getAuthStrategy().mode === "hosted";
}

// --- State atoms ---
export const actorAtom = atom<Actor | null>(null);
export const authLoadingAtom = atom(true);
export const authErrorAtom = atom<string | null>(null);
export const loginErrorAtom = atom<string | null>(null);
export const needsSetupAtom = atom(false);
export const instancePendingAtom = atom(false);
export const instanceMissingAtom = atom(false);
export const instanceBlockedAtom = atom(false);
export const instanceHealthAtom = atom<InstanceHealth | null>(null);
export const hostedUserAtom = atom<HostedUserInfo | null>(null);
export const instancesAtom = atom<HostedInstance[]>([]);
export const selectedInstanceIdAtom = atom<string | null>(null);
export const instancesLoadingAtom = atom(false);
export const logoutBusyAtom = atom(false);
export const logoutErrorAtom = atom<string | null>(null);

// Store-scoped fences: a delayed pre-sign-out check cannot restore identity.
const authGenerationAtom = atom(0);
// Read-only fence for product async work across login/sign-out of the same actor.
export const authSessionEpochAtom = atom((get) => get(authGenerationAtom));
const authCheckTicketAtom = atom(0);

function clearAuthIdentity(set: Setter) {
  set(actorAtom, null);
  set(hostedUserAtom, null);
  set(needsSetupAtom, false);
  set(instancePendingAtom, false);
  set(instanceMissingAtom, false);
  set(instanceBlockedAtom, false);
  set(instanceHealthAtom, null);
  set(instancesAtom, []);
  set(selectedInstanceIdAtom, null);
  set(authLoadingAtom, false);
  set(instancesLoadingAtom, false);
  set(resetScopeAtom);
}

// --- Action atoms ---
export const checkAuthAtom = atom(null, async (get, set) => {
  if (get(logoutBusyAtom)) return;
  const authStrategy = getAuthStrategy();
  const generation = get(authGenerationAtom);
  const ticket = get(authCheckTicketAtom) + 1;
  set(authCheckTicketAtom, ticket);
  const current = () =>
    generation === get(authGenerationAtom) &&
    ticket === get(authCheckTicketAtom) &&
    authStrategy === getAuthStrategy() &&
    !get(logoutBusyAtom);
  // Surface an OAuth/OIDC login failure that the callback relayed as
  // `/?error=<code>` (e.g. id_token_invalid / token_exchange_failed /
  // csrf_check_failed). The server logs the technical detail; the user just
  // needs to know the external sign-in didn't go through. Read it once and strip
  // the param so it doesn't linger across navigations or get bookmarked.
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.has("error")) {
      set(loginErrorAtom, get(tAtom)("auth.oauthLoginFailed"));
      params.delete("error");
      const qs = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
      );
    }
  }
  try {
    // Keep the loading screen up across a retry: otherwise authError is cleared
    // while loading is already false, flashing LoginScreen for a frame before
    // the result (or a fresh authError) arrives.
    set(authLoadingAtom, true);
    set(instancesLoadingAtom, true);
    set(authErrorAtom, null);
    const result = await authStrategy.checkAuth();
    if (!current()) return;
    set(actorAtom, result.actor);
    set(hostedUserAtom, result.hostedUser);
    set(needsSetupAtom, result.needsSetup);
    set(instancePendingAtom, result.instancePending);
    set(instanceMissingAtom, result.instanceMissing);
    set(instanceBlockedAtom, result.instanceBlocked);
    set(instanceHealthAtom, result.instanceHealth);
    set(instancesAtom, result.instances);
    set(selectedInstanceIdAtom, result.selectedInstanceId);
  } catch (e) {
    if (!current()) return;
    console.error("Auth check failed:", e);
    set(actorAtom, null);
    set(authErrorAtom, get(tAtom)("auth.checkFailed"));
  } finally {
    if (current()) {
      set(authLoadingAtom, false);
      set(instancesLoadingAtom, false);
    }
  }
});

export const loginAtom = atom(null, async (get, set, password?: string) => {
  if (get(logoutBusyAtom)) return false;
  const authStrategy = getAuthStrategy();
  const generation = get(authGenerationAtom) + 1;
  set(authGenerationAtom, generation);
  const current = () =>
    generation === get(authGenerationAtom) &&
    authStrategy === getAuthStrategy();
  set(loginErrorAtom, null);
  try {
    const result = await authStrategy.login(password);
    if (!current()) return false;
    if (result.redirect) {
      window.location.href = result.redirect;
      return false;
    }
    if (result.error || result.errorKey) {
      set(loginErrorAtom, result.error ?? get(tAtom)(result.errorKey!));
      return false;
    }
    if (result.success) {
      await set(checkAuthAtom);
      return true;
    }
    return false;
  } catch (e) {
    if (!current()) return false;
    console.error("Login error:", e);
    set(loginErrorAtom, get(tAtom)("auth.networkError"));
    return false;
  }
});

export const logoutAtom = atom(null, async (get, set) => {
  if (get(logoutBusyAtom)) return false;
  const authStrategy = getAuthStrategy();
  const actor = get(actorAtom);
  const hostedUser = get(hostedUserAtom);
  const instance = get(selectedInstanceIdAtom);
  const generation = get(authGenerationAtom) + 1;
  set(authGenerationAtom, generation);
  set(logoutBusyAtom, true);
  set(logoutErrorAtom, null);
  set(authLoadingAtom, false);
  set(instancesLoadingAtom, false);
  const current = () =>
    generation === get(authGenerationAtom) &&
    authStrategy === getAuthStrategy() &&
    actor === get(actorAtom) &&
    hostedUser === get(hostedUserAtom) &&
    instance === get(selectedInstanceIdAtom);
  // Before anything can re-render the login screen: the Takosumi session
  // outlives ours, so an unsuppressed auto-start would redirect and sign the
  // user straight back in — signing out would look like it did nothing.
  suppressTakosumiOidcAutoStart();
  try {
    await clearYurucommuBrowserPushBeforeSignOut();
    if (!current()) return false;
    let acknowledged = false;
    try {
      await authStrategy.logout();
      acknowledged = true;
    } catch (e) {
      console.error("Logout acknowledgement unavailable:", e);
    }
    if (!current()) return false;

    if (isDefaultSelfHostedAuthStrategy(authStrategy)) {
      // Reconcile even a 200: it is not itself proof of cookie/session removal.
      // This observes browser authentication, not the HttpOnly session generation
      // or durable revocation of an old credential held elsewhere.
      try {
        const observed = await authStrategy.checkAuth();
        if (!current()) return false;
        if (!observed.actor) {
          clearAuthIdentity(set);
          set(authErrorAtom, null);
          return true;
        }
        if (observed.actor.ap_id === actor?.ap_id) {
          set(resetScopeAtom);
          set(logoutErrorAtom, get(tAtom)("auth.logoutUnknown"));
          return false;
        }
      } catch (e) {
        console.error("Sign-out authentication observation unavailable:", e);
        if (!current()) return false;
      }
    } else if (acknowledged) {
      // A fulfilled custom/hosted strategy keeps its existing void contract.
      // Its revocation remains the embedder's responsibility and evidence.
      clearAuthIdentity(set);
      set(authErrorAtom, null);
      return true;
    }
    // Unknown or changed observed principal: hide stale identity and offer a
    // read-only auth refresh. Never automatically resend the logout POST.
    clearAuthIdentity(set);
    set(authErrorAtom, get(tAtom)("auth.logoutUnknown"));
    return false;
  } finally {
    set(logoutBusyAtom, false);
  }
});

export const completeSetupAtom = atom(
  null,
  async (get, set, username: string) => {
    if (get(logoutBusyAtom)) return false;
    const authStrategy = getAuthStrategy();
    const generation = get(authGenerationAtom);
    const current = () =>
      generation === get(authGenerationAtom) &&
      authStrategy === getAuthStrategy() &&
      !get(logoutBusyAtom);
    if (authStrategy.mode !== "hosted" || !authStrategy.completeSetup) {
      return false;
    }
    const success = await authStrategy.completeSetup(username);
    if (!current()) return false;
    if (success) await set(checkAuthAtom);
    return current() ? success : false;
  },
);

export const selectInstanceAtom = atom(
  null,
  async (get, set, instanceId: string) => {
    if (get(logoutBusyAtom)) return;
    const authStrategy = getAuthStrategy();
    const generation = get(authGenerationAtom);
    const current = () =>
      generation === get(authGenerationAtom) &&
      authStrategy === getAuthStrategy() &&
      !get(logoutBusyAtom);
    if (authStrategy.mode !== "hosted" || !authStrategy.selectInstance) return;
    set(instancesLoadingAtom, true);
    try {
      await authStrategy.selectInstance(instanceId);
    } catch (e) {
      if (!current()) return;
      console.error("Failed to select instance:", e);
      set(authErrorAtom, get(tAtom)("auth.instanceSelectFailed"));
    } finally {
      if (current()) {
        await set(checkAuthAtom);
        if (current()) set(instancesLoadingAtom, false);
      }
    }
  },
);

export const rebuildInstanceAtom = atom(
  null,
  async (get, set, instanceId: string) => {
    if (get(logoutBusyAtom)) return false;
    const authStrategy = getAuthStrategy();
    const generation = get(authGenerationAtom);
    const current = () =>
      generation === get(authGenerationAtom) &&
      authStrategy === getAuthStrategy() &&
      !get(logoutBusyAtom);
    if (authStrategy.mode !== "hosted" || !authStrategy.rebuildInstance) {
      return false;
    }
    set(instancesLoadingAtom, true);
    let success = false;
    try {
      success = await authStrategy.rebuildInstance(instanceId);
    } catch (e) {
      if (!current()) return false;
      console.error("Failed to rebuild instance:", e);
      set(authErrorAtom, get(tAtom)("auth.instanceRebuildFailed"));
    } finally {
      if (current()) {
        await set(checkAuthAtom);
        if (current()) set(instancesLoadingAtom, false);
      }
    }
    return current() ? success : false;
  },
);

// Init: extract token from URL on load
export const initAuthAtom = atom(null, async (_get, set) => {
  const authStrategy = getAuthStrategy();
  authStrategy.extractTokenFromUrl();
  await set(checkAuthAtom);
});
