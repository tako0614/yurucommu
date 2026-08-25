import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const rootUrl = new URL("../", import.meta.url);
const manifestUrl = new URL(".well-known/takosumi.json", rootUrl);
const manifestText = await readFile(manifestUrl, "utf8");
const sourceOptions = JSON.parse(
  await readFile(new URL("install-options.json", rootUrl), "utf8"),
) as {
  options: Array<{
    id: string;
    source: { url: string; ref: string; path: string };
  }>;
};
const manifest = JSON.parse(manifestText) as {
  apiVersion: string;
  kind: string;
  install: {
    defaultModule: string;
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
        requires?: Array<Record<string, unknown>>;
        sourceBuild?: {
          commands: Array<{ argv: string[] }>;
          outputs: string[];
        };
        features?: Array<{
          id: string;
          optional: boolean;
          label: { ja: string; en: string };
          inputs: string[];
        }>;
        interfaces: Array<{
          key: string;
          name: string;
          spec: {
            type: string;
            version: string;
            document: {
              launcher: boolean;
              display: { title: string; icon?: string };
            };
            inputs: Record<
              string,
              {
                source: string;
                outputName?: string;
                outputType?: string;
              }
            >;
            access: { visibility: string };
          };
          bindingRequests: Array<{
            key: string;
            subject: { source: string };
            permissions: string[];
            delivery: { type: string };
          }>;
        }>;
      }
    >;
  };
};
const rootModule = manifest.install.modules["."];
const managedModule = manifest.install.modules["deploy/takoform"];
const rootModuleSource = await readFile(new URL("main.tf", rootUrl), "utf8");
const rootOutputsSource = await readFile(
  new URL("outputs.tf", rootUrl),
  "utf8",
);
const managedModuleSource = await readFile(
  new URL("deploy/takoform/main.tf", rootUrl),
  "utf8",
);
const managedModuleOutputsSource = await readFile(
  new URL("deploy/takoform/outputs.tf", rootUrl),
  "utf8",
);
const sourceKinds = new Set([
  "user",
  "capsule_name",
  "workspace_scoped_capsule_name",
  "module_default",
]);
function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  expect(Object.keys(value).sort()).toEqual([...allowedKeys].sort());
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
  ]);
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => [
      ...(forbidden.has(key) ? [{ key, path: `${path}.${key}` }] : []),
      ...collectForbiddenKeys(child, `${path}.${key}`),
    ],
  );
}

function assertLauncherInterface(
  module: (typeof manifest.install.modules)[string],
  expectedName: string,
): void {
  expect(module.interfaces).toHaveLength(1);
  const launcher = module.interfaces[0];
  assertExactKeys(launcher as unknown as Record<string, unknown>, [
    "bindingRequests",
    "key",
    "name",
    "spec",
  ]);
  expect(launcher.key).toBe("launcher");
  expect(launcher.name).toBe(expectedName);
  assertExactKeys(launcher.spec as unknown as Record<string, unknown>, [
    "access",
    "document",
    "inputs",
    "type",
    "version",
  ]);
  expect(launcher.spec.type).toBe("interface.ui.surface");
  expect(launcher.spec.version).toBe("1");
  assertExactKeys(
    launcher.spec.document as unknown as Record<string, unknown>,
    ["display", "launcher"],
  );
  expect(launcher.spec.document.launcher).toBe(true);
  assertExactKeys(
    launcher.spec.document.display as unknown as Record<string, unknown>,
    ["icon", "title"],
  );
  expect(launcher.spec.document.display.title).toBe("Yurucommu");
  expect(launcher.spec.document.display.icon).toBe("/icons/yurucommu.svg");
  assertExactKeys(launcher.spec.inputs as Record<string, unknown>, ["url"]);
  assertExactKeys(
    launcher.spec.inputs.url as unknown as Record<string, unknown>,
    ["outputName", "outputType", "source"],
  );
  expect(launcher.spec.inputs.url).toEqual({
    source: "output",
    outputName: "launch_url",
    outputType: "url",
  });
  assertExactKeys(launcher.spec.access as Record<string, unknown>, [
    "visibility",
  ]);
  expect(launcher.spec.access.visibility).toBe("workspace");
  expect(launcher.bindingRequests).toHaveLength(1);
  const [installer] = launcher.bindingRequests;
  assertExactKeys(installer as unknown as Record<string, unknown>, [
    "delivery",
    "key",
    "permissions",
    "subject",
  ]);
  expect(installer.key).toBe("installer");
  expect(installer.subject).toEqual({ source: "installing_principal" });
  expect(installer.permissions).toEqual(["ui.open"]);
  expect(installer.delivery).toEqual({ type: "none" });
}

describe("repository-owned Takosumi install UX", () => {
  test("presents Takoserver as an ordinary source option without hiding direct BYOC", () => {
    expect(
      sourceOptions.options.map(({ id, source }) => ({ id, source })),
    ).toEqual([
      {
        id: "takoserver",
        source: {
          url: "https://github.com/tako0614/yurucommu.git",
          ref: "v2.1.6",
          path: "deploy/takoform",
        },
      },
      {
        id: "cloudflare",
        source: {
          url: "https://github.com/tako0614/yurucommu.git",
          ref: "v2.1.6",
          path: ".",
        },
      },
    ]);
  });

  test("keeps the transitional root and declares the exact managed module", () => {
    expect(
      new TextEncoder().encode(manifestText).byteLength,
    ).toBeLessThanOrEqual(128 * 1024);
    assertExactKeys(manifest as unknown as Record<string, unknown>, [
      "apiVersion",
      "kind",
      "install",
    ]);
    expect(manifest.apiVersion).toBe("takosumi.com/v2.3");
    expect(manifest.kind).toBe("Repository");
    assertExactKeys(manifest.install as unknown as Record<string, unknown>, [
      "defaultModule",
      "modules",
    ]);
    expect(manifest.install.defaultModule).toBe("deploy/takoform");
    expect(Object.keys(manifest.install.modules)).toEqual([
      ".",
      "deploy/takoform",
    ]);
    expect(rootModule).toBeDefined();
    expect(managedModule).toBeDefined();
    for (const module of [rootModule, managedModule]) {
      expect(module.inputs.length).toBeLessThanOrEqual(128);
      expect(module.requires?.length ?? 0).toBeLessThanOrEqual(16);
      expect(module.features?.length ?? 0).toBeLessThanOrEqual(32);
    }
    assertExactKeys(rootModule as unknown as Record<string, unknown>, [
      "inputs",
      "features",
      "interfaces",
    ]);
    assertExactKeys(managedModule as unknown as Record<string, unknown>, [
      "inputs",
      "sourceBuild",
      "interfaces",
    ]);
    assertLauncherInterface(rootModule, "yurucommu.launcher");
    assertLauncherInterface(managedModule, "yurucommu.launcher");
  });

  test("uses only the bounded repository presentation vocabulary", () => {
    for (const module of Object.values(manifest.install.modules)) {
      for (const input of module.inputs) {
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
      expect(module.requires).toBeUndefined();
      for (const feature of module.features ?? []) {
        expect(feature.id.length).toBeLessThanOrEqual(64);
        expect(feature.inputs.length).toBeLessThanOrEqual(32);
        expect(feature.label.ja.length).toBeGreaterThan(0);
        expect(feature.label.en.length).toBeGreaterThan(0);
        expect(
          feature.inputs.filter(
            (name) => !module.inputs.some((input) => input.name === name),
          ),
        ).toEqual([]);
        expect(
          feature.inputs.filter(
            (name) =>
              module.inputs.find((input) => input.name === name)?.source
                .kind !== "user",
          ),
        ).toEqual([]);
      }
      for (const declaration of module.interfaces) {
        expect(declaration.key.length).toBeLessThanOrEqual(128);
        expect(declaration.name.length).toBeLessThanOrEqual(256);
        expect(declaration.spec.type.length).toBeLessThanOrEqual(128);
        expect(declaration.spec.version.length).toBeLessThanOrEqual(64);
        for (const [inputName, input] of Object.entries(
          declaration.spec.inputs,
        )) {
          expect(inputName.length).toBeLessThanOrEqual(128);
          expect(input.source).toBe("output");
          expect(input.outputName).toBe("launch_url");
          expect(input.outputType).toBe("url");
        }
        expect(declaration.bindingRequests.length).toBeLessThanOrEqual(16);
        for (const request of declaration.bindingRequests) {
          expect(request.subject).toEqual({ source: "installing_principal" });
          expect(request.permissions).toEqual(["ui.open"]);
          expect(request.delivery).toEqual({ type: "none" });
        }
      }
    }
  });

  test("references only declared module variables and ordinary outputs", () => {
    const moduleVariables = new Set(
      Array.from(
        rootModuleSource.matchAll(/variable\s+"([^"]+)"\s*\{/g),
        (match) => match[1],
      ),
    );
    const declaredVariables = new Set([
      ...rootModule.inputs.map((input) => input.name),
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

    expect(rootOutputsSource).toContain('output "launch_url"');
    expect(managedModuleOutputsSource).toContain('output "launch_url"');
  });

  test("does not ask Takosumi to synthesize endpoint, identity, or secrets", () => {
    expect(rootModule.requires).toBeUndefined();
    expect(managedModule.requires).toBeUndefined();
    expect(manifestText).not.toContain('"kind": "http.endpoint"');
    expect(manifestText).not.toContain('"kind": "identity.oidc"');
    expect(manifestText).not.toContain('"kind": "secret.generated"');
    for (const name of [
      "ENCRYPTION_KEY",
      "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      "TAKOSUMI_ACCOUNTS_CLIENT_ID",
      "TAKOSUMI_ACCOUNTS_OWNER_SUB",
      "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
    ]) {
      expect(managedModuleSource).toContain(JSON.stringify(name));
    }
    expect(managedModuleSource).toContain("required_sensitive_vars");
    expect(managedModuleSource).toContain('protocol = "com.amazonaws.s3"');
  });

  test("keeps host authority and secret values out of repository metadata", () => {
    expect(collectForbiddenKeys(manifest)).toEqual([]);
    expect(manifestText).not.toContain("cloudflare_account_id");
    expect(manifestText).not.toContain("enable_cloudflare_resources");
    expect(manifestText).not.toContain("enable_cloudflare_worker_script");
    expect(manifestText).not.toContain("oidc_owner_sub");
    expect(manifestText).not.toContain("oidc_allowed_subs");
    expect(manifestText).not.toContain("encryption_key");
  });

  test("Takoserver install asks no provider or runtime-internal questions", () => {
    const moduleVariables = new Set(
      Array.from(
        managedModuleSource.matchAll(/variable\s+"([^"]+)"\s*\{/g),
        (match) => match[1],
      ),
    );
    expect(managedModule.inputs.map((input) => input.name)).toEqual([
      "project_name",
    ]);
    expect(
      managedModule.inputs.filter((input) => input.source.kind === "user"),
    ).toEqual([]);
    expect(
      managedModule.inputs
        .map((input) => input.name)
        .filter((name) => !moduleVariables.has(name)),
    ).toEqual([]);
    for (const input of managedModule.inputs.filter(
      (candidate) => candidate.source.kind === "module_default",
    )) {
      const blockStart = managedModuleSource.indexOf(
        `variable "${input.name}" {`,
      );
      const nextBlock = managedModuleSource.indexOf(
        "\nvariable ",
        blockStart + 1,
      );
      expect(
        managedModuleSource.slice(
          blockStart,
          nextBlock < 0 ? undefined : nextBlock,
        ),
      ).toMatch(/\n\s+default\s+=/);
    }
    for (const forbidden of [
      "cloudflare",
      "provider",
      "credential",
      "encryption_key",
      "database_id",
      "queue_id",
    ]) {
      expect(JSON.stringify(managedModule.inputs).toLowerCase()).not.toContain(
        forbidden,
      );
    }
    expect(managedModule.sourceBuild).toEqual({
      commands: [
        { argv: ["bun", "install", "--frozen-lockfile"] },
        { argv: ["bun", "run", "build:worker"] },
        { argv: ["bun", "scripts/prepare-takoform-v1-source.ts"] },
      ],
      outputs: [
        "deploy/takoform/.generated/yurucommu-worker.js",
        "deploy/takoform/.generated/migrations",
      ],
    });
    expect(
      managedModule.sourceBuild?.outputs.every((output) =>
        output.startsWith("deploy/takoform/"),
      ),
    ).toBe(true);
    expect(managedModuleSource).toContain(
      'migration_root     = "${path.module}/.generated/migrations"',
    );
    expect(managedModuleSource).not.toContain("${path.module}/../");
    expect(managedModuleSource).toContain('version = ">= 3.0.0"');
  });
});
