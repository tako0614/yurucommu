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
