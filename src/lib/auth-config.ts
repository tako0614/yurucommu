export interface OAuthProvider {
  id: string;
  name: string;
  icon: string;
}

export interface AuthConfig {
  providers: OAuthProvider[];
  password_enabled: boolean;
}

export function shouldAutoStartTakosumiOidc(config: AuthConfig): boolean {
  return (
    !config.password_enabled &&
    config.providers.length === 1 &&
    config.providers[0]?.id === "takos"
  );
}

const AUTO_START_KEY = "yurucommu:oidc-auto-start-attempted";

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Claims the one automatic Takosumi OIDC redirect allowed for this browser tab.
 *
 * Auto-start is what makes a passwordless deployment feel like one product, but
 * unguarded it cannot be escaped: the Takosumi session outlives our cookie, so
 * signing out re-renders the login screen, which redirects, which signs the
 * user straight back in. A failed round-trip loops the same way. Returning
 * false leaves the visible provider button as the manual path.
 */
export function claimTakosumiOidcAutoStart(
  storage: Storage | undefined = sessionStorageOrUndefined(),
): boolean {
  if (!storage) return true;
  try {
    if (storage.getItem(AUTO_START_KEY) !== null) return false;
    storage.setItem(AUTO_START_KEY, "1");
    return true;
  } catch {
    return true;
  }
}

/** Arms the breaker so an explicit sign-out lands on the login screen. */
export function suppressTakosumiOidcAutoStart(
  storage: Storage | undefined = sessionStorageOrUndefined(),
): void {
  try {
    storage?.setItem(AUTO_START_KEY, "1");
  } catch {
    // sessionStorage unavailable; the one-shot claim below is the fallback.
  }
}
