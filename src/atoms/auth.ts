import { atom } from "jotai/vanilla";
import type { Actor } from "../types/index.ts";
import { tAtom } from "./i18n.ts";
import {
  getAuthStrategy,
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

// --- Action atoms ---
// These fences are atoms rather than module globals because Jotai state belongs
// to a store. A refresh in an embedded/secondary store must not invalidate the
// primary store's request or strand its loading state.
const authCheckGenerationAtom = atom(0);
const activeLogoutCountAtom = atom(0);

export const checkAuthAtom = atom(null, async (get, set) => {
  // A check started while sign-out is in progress could capture the old
  // session and restore it after logout completes. The logout fence owns this
  // store until every concurrent sign-out call settles.
  if (get(activeLogoutCountAtom) > 0) return;
  const generation = get(authCheckGenerationAtom) + 1;
  set(authCheckGenerationAtom, generation);
  const authStrategy = getAuthStrategy();
  // Surface an OAuth/OIDC login failure that the callback relayed as
  // `/?error=<code>` (e.g. id_token_invalid / token_exchange_failed /
  // csrf_check_failed). The server logs the technical detail; the user just
  // needs to know the external sign-in didn't go through. Read it once and strip
  // the param so it doesn't linger across navigations or get bookmarked.
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.has("error")) {
      if (
        generation === get(authCheckGenerationAtom) &&
        get(activeLogoutCountAtom) === 0
      ) {
        set(loginErrorAtom, get(tAtom)("auth.oauthLoginFailed"));
      }
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
    if (
      generation !== get(authCheckGenerationAtom) ||
      get(activeLogoutCountAtom) > 0
    ) {
      return;
    }
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
    if (
      generation !== get(authCheckGenerationAtom) ||
      get(activeLogoutCountAtom) > 0
    ) {
      return;
    }
    console.error("Auth check failed:", e);
    set(actorAtom, null);
    set(authErrorAtom, get(tAtom)("auth.checkFailed"));
  } finally {
    if (
      generation === get(authCheckGenerationAtom) &&
      get(activeLogoutCountAtom) === 0
    ) {
      set(authLoadingAtom, false);
      set(instancesLoadingAtom, false);
    }
  }
});

export const loginAtom = atom(null, async (get, set, password?: string) => {
  const authStrategy = getAuthStrategy();
  set(loginErrorAtom, null);
  try {
    const result = await authStrategy.login(password);
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
    console.error("Login error:", e);
    set(loginErrorAtom, get(tAtom)("auth.networkError"));
    return false;
  }
});

export const logoutAtom = atom(null, async (get, set) => {
  // Any auth check already in flight belongs to the pre-logout session. Make
  // its eventual result ineligible to restore the actor after sign-out.
  set(activeLogoutCountAtom, get(activeLogoutCountAtom) + 1);
  set(authCheckGenerationAtom, get(authCheckGenerationAtom) + 1);
  const authStrategy = getAuthStrategy();
  // Before anything can re-render the login screen: the Takosumi session
  // outlives ours, so an unsuppressed auto-start would redirect and sign the
  // user straight back in — signing out would look like it did nothing.
  suppressTakosumiOidcAutoStart();
  try {
    await clearYurucommuBrowserPushBeforeSignOut();
    await authStrategy.logout();
  } catch (e) {
    console.error("Logout error:", e);
    set(authErrorAtom, get(tAtom)("auth.logoutFailed"));
  } finally {
    set(actorAtom, null);
    const remainingLogouts = Math.max(0, get(activeLogoutCountAtom) - 1);
    if (remainingLogouts === 0) {
      // Logout owns the generation that invalidated any in-flight check, so it
      // must also settle the loading flags that the stale check can no longer
      // clear in its guarded finally block.
      set(authLoadingAtom, false);
      set(instancesLoadingAtom, false);
    }
    // Reset the observation scope so a switched account never inherits the
    // previous owner's community lens.
    set(resetScopeAtom);
    // Release the fence last so subscribers cannot start a fresh check before
    // the signed-out state and loading flags are settled.
    set(activeLogoutCountAtom, remainingLogouts);
  }
});

export const completeSetupAtom = atom(
  null,
  async (_get, set, username: string) => {
    const authStrategy = getAuthStrategy();
    if (authStrategy.mode !== "hosted" || !authStrategy.completeSetup) {
      return false;
    }
    const success = await authStrategy.completeSetup(username);
    if (success) await set(checkAuthAtom);
    return success;
  },
);

export const selectInstanceAtom = atom(
  null,
  async (get, set, instanceId: string) => {
    const authStrategy = getAuthStrategy();
    if (authStrategy.mode !== "hosted" || !authStrategy.selectInstance) return;
    set(instancesLoadingAtom, true);
    try {
      await authStrategy.selectInstance(instanceId);
    } catch (e) {
      console.error("Failed to select instance:", e);
      set(authErrorAtom, get(tAtom)("auth.instanceSelectFailed"));
    } finally {
      await set(checkAuthAtom);
      set(instancesLoadingAtom, false);
    }
  },
);

export const rebuildInstanceAtom = atom(
  null,
  async (get, set, instanceId: string) => {
    const authStrategy = getAuthStrategy();
    if (authStrategy.mode !== "hosted" || !authStrategy.rebuildInstance) {
      return false;
    }
    set(instancesLoadingAtom, true);
    try {
      return await authStrategy.rebuildInstance(instanceId);
    } catch (e) {
      console.error("Failed to rebuild instance:", e);
      set(authErrorAtom, get(tAtom)("auth.instanceRebuildFailed"));
      return false;
    } finally {
      await set(checkAuthAtom);
      set(instancesLoadingAtom, false);
    }
  },
);

// Init: extract token from URL on load
export const initAuthAtom = atom(null, async (_get, set) => {
  const authStrategy = getAuthStrategy();
  authStrategy.extractTokenFromUrl();
  await set(checkAuthAtom);
});
