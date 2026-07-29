import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const rootUrl = new URL("../", import.meta.url);
const manifestUrl = new URL(".well-known/takosumi.json", rootUrl);
const manifestText = await readFile(manifestUrl, "utf8");
const manifest = JSON.parse(manifestText) as {
  schemaVersion: string;
  modules: Record<
    string,
    {
      inputs: Array<{
        name: string;
        source: { kind: string };
        type?: string;
        format?: string;
        required?: boolean;
        label: { ja: string; en: string };
        helper?: { ja: string; en: string };
        placeholder?: string;
        advanced?: boolean;
        secret?: boolean;
      }>;
      installExperience?: {
        projections?: Array<Record<string, unknown>>;
      };
      features?: Array<{
        id: string;
        optional: boolean;
        label: { ja: string; en: string };
        inputs: string[];
      }>;
    }
  >;
};
const rootModule = manifest.modules["."];
const rootModuleSource = await readFile(new URL("main.tf", rootUrl), "utf8");
const coreAuthRoutes = await readFile(
  new URL(
    "node_modules/@takosjp/yurucommu-core/src/backend/routes/auth.ts",
    rootUrl,
  ),
  "utf8",
);
const coreOauthProviders = await readFile(
  new URL(
    "node_modules/@takosjp/yurucommu-core/src/backend/lib/oauth-providers.ts",
    rootUrl,
  ),
  "utf8",
);

const sourceKinds = new Set([
  "user",
  "capsule_name",
  "workspace_scoped_capsule_name",
  "module_default",
]);
const projectionKinds = new Set([
  "service_name",
  "public_endpoint",
  "initial_secret",
  "oidc_client",
  "artifact",
]);

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  expect(Object.keys(value).sort()).toEqual([...allowedKeys].sort());
}

function collectProjectionVariables(
  projection: Record<string, unknown>,
): string[] {
  const variables: string[] = [];
  if (typeof projection.variable === "string") {
    variables.push(projection.variable);
  }
  if (
    projection.variables &&
    typeof projection.variables === "object" &&
    !Array.isArray(projection.variables)
  ) {
    for (const value of Object.values(projection.variables)) {
      if (typeof value === "string") variables.push(value);
    }
  }
  return variables;
}

function collectForbiddenKeys(
  value: unknown,
  path = "$",
): Array<{ key: string; path: string }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectForbiddenKeys(item, `${path}[${index}]`),
    );
  }
  const forbidden = new Set([
    "credential",
    "credentialId",
    "lifecycle",
    "lifecycleActions",
    "outputAllowlist",
    "policy",
    "provider",
    "providerId",
    "providerConnectionId",
    "runner",
    "runnerId",
    "secretValue",
    "target",
    "targetId",
    "value",
  ]);
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => [
      ...(forbidden.has(key) ? [{ key, path: `${path}.${key}` }] : []),
      ...collectForbiddenKeys(child, `${path}.${key}`),
    ],
  );
}

describe("repository-owned Takosumi install UX", () => {
  test("is a bounded declaration for the exact transitional root module", () => {
    expect(
      new TextEncoder().encode(manifestText).byteLength,
    ).toBeLessThanOrEqual(128 * 1024);
    assertExactKeys(manifest as unknown as Record<string, unknown>, [
      "schemaVersion",
      "modules",
    ]);
    expect(manifest.schemaVersion).toBe("takosumi.install-ux/v1");
    expect(Object.keys(manifest.modules)).toEqual(["."]);
    expect(rootModule).toBeDefined();
    assertExactKeys(rootModule as unknown as Record<string, unknown>, [
      "inputs",
      "installExperience",
      "features",
    ]);
    expect(rootModule.inputs.length).toBeLessThanOrEqual(128);
    expect(
      rootModule.installExperience?.projections?.length ?? 0,
    ).toBeLessThanOrEqual(16);
    expect(rootModule.features?.length ?? 0).toBeLessThanOrEqual(32);
  });

  test("uses only the bounded v1 presentation vocabulary", () => {
    for (const input of rootModule.inputs) {
      expect(sourceKinds.has(input.source.kind)).toBe(true);
      assertExactKeys(input.source as unknown as Record<string, unknown>, [
        "kind",
      ]);
      expect(input.name.length).toBeLessThanOrEqual(128);
      expect(input.label.ja.length).toBeGreaterThan(0);
      expect(input.label.en.length).toBeGreaterThan(0);
      expect(input.label.ja.length).toBeLessThanOrEqual(512);
      expect(input.label.en.length).toBeLessThanOrEqual(512);
    }
    for (const projection of rootModule.installExperience?.projections ?? []) {
      expect(projectionKinds.has(String(projection.kind))).toBe(true);
    }
    for (const feature of rootModule.features ?? []) {
      expect(feature.id.length).toBeLessThanOrEqual(64);
      expect(feature.inputs.length).toBeLessThanOrEqual(32);
      expect(feature.label.ja.length).toBeGreaterThan(0);
      expect(feature.label.en.length).toBeGreaterThan(0);
      expect(
        feature.inputs.filter(
          (name) => !rootModule.inputs.some((input) => input.name === name),
        ),
      ).toEqual([]);
      expect(
        feature.inputs.filter(
          (name) =>
            rootModule.inputs.find((input) => input.name === name)?.source
              .kind !== "user",
        ),
      ).toEqual([]);
    }
  });

  test("references only variables and the OIDC callback implemented by Yurucommu", () => {
    const moduleVariables = new Set(
      Array.from(
        rootModuleSource.matchAll(/variable\s+"([^"]+)"\s*\{/g),
        (match) => match[1],
      ),
    );
    const declaredVariables = new Set([
      ...rootModule.inputs.map((input) => input.name),
      ...(rootModule.installExperience?.projections ?? []).flatMap(
        collectProjectionVariables,
      ),
      ...(rootModule.features ?? []).flatMap((feature) => feature.inputs),
    ]);
    expect(
      [...declaredVariables].filter((name) => !moduleVariables.has(name)),
    ).toEqual([]);
    for (const input of rootModule.inputs.filter(
      (candidate) => candidate.source.kind === "module_default",
    )) {
      const blockStart = rootModuleSource.indexOf(`variable "${input.name}" {`);
      const nextBlock = rootModuleSource.indexOf("\nvariable ", blockStart + 1);
      const block = rootModuleSource.slice(
        blockStart,
        nextBlock < 0 ? undefined : nextBlock,
      );
      expect(blockStart).toBeGreaterThanOrEqual(0);
      expect(block).toMatch(/\n\s+default\s+=/);
    }

    const oidcProjection = rootModule.installExperience?.projections?.find(
      (projection) => projection.kind === "oidc_client",
    );
    expect(oidcProjection?.callbackPath).toBe("/api/auth/callback/takos");
    expect(coreAuthRoutes).toContain('auth.get("/callback/:provider"');
    expect(coreOauthProviders).toContain('id: "takos"');
  });

  test("keeps host authority, secret values, and raw owner bootstrap out of repository metadata", () => {
    expect(collectForbiddenKeys(manifest)).toEqual([]);
    expect(manifestText).not.toContain("cloudflare_account_id");
    expect(manifestText).not.toContain("enable_cloudflare_resources");
    expect(manifestText).not.toContain("enable_cloudflare_worker_script");
    expect(manifestText).not.toContain("oidc_owner_sub");
    expect(manifestText).not.toContain("oidc_allowed_subs");
    expect(manifestText).not.toContain("allow_unpinned_owner_claim");
    expect(manifestText).not.toContain("encryption_key");
    // `deploy/takoform` stays a non-selectable managed candidate until the host
    // can materialize its URL, queue/schedule, migration, and rollback duties.
    expect(manifestText).not.toContain("deploy/takoform");
  });
});
