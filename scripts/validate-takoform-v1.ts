import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareProviderDevOverride,
  readLocalProviderAuthority,
} from "./takoform-v1-e2e.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const inheritedTofuAuthorityVariables = new Set([
  "TERRAFORM_CONFIG",
  "TF_CLI_CONFIG_FILE",
  "TF_DATA_DIR",
  "TF_DISABLE_PLUGIN_TLS",
  "TF_PLUGIN_CACHE_DIR",
  "TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE",
  "TF_PLUGIN_MAGIC_COOKIE",
  "TF_REATTACH_PROVIDERS",
]);

function isInheritedTofuAuthorityVariable(name: string): boolean {
  return (
    inheritedTofuAuthorityVariables.has(name) ||
    name === "TF_CLI_ARGS" ||
    name.startsWith("TF_CLI_ARGS_")
  );
}

export async function validateTakoformV1(options: {
  readonly environment: Environment;
  readonly source?: URL;
}): Promise<void> {
  const providerBinary =
    options.environment.TAKOFORM_PROVIDER_BINARY?.trim() ?? "";
  const providerSha256 =
    options.environment.TAKOFORM_PROVIDER_SHA256?.trim() ?? "";
  const provider =
    providerBinary || providerSha256
      ? readLocalProviderAuthority(options.environment)
      : undefined;
  const workdir = await mkdtemp(join(tmpdir(), "yurucommu-takoform-validate-"));
  const source =
    options.source ?? new URL("../deploy/takoform/", import.meta.url);

  try {
    await Promise.all([
      cp(new URL("main.tf", source), join(workdir, "main.tf")),
      cp(new URL("outputs.tf", source), join(workdir, "outputs.tf")),
      cp(new URL(".generated/", source), join(workdir, ".generated"), {
        recursive: true,
      }),
      cp(new URL("migrations/", source), join(workdir, "migrations"), {
        recursive: true,
      }),
    ]);
    const tofuEnvironment: Record<string, string | undefined> = {
      ...Object.fromEntries(
        Object.entries(options.environment).filter(
          ([name]) => !isInheritedTofuAuthorityVariable(name),
        ),
      ),
      TF_IN_AUTOMATION: "1",
      CHECKPOINT_DISABLE: "1",
      TF_DATA_DIR: join(workdir, ".tofu-data"),
    };
    const commands: readonly (readonly string[])[] = provider
      ? [["validate", "-no-color"]]
      : [
          ["init", "-backend=false", "-input=false", "-no-color"],
          ["validate", "-no-color"],
        ];
    if (provider) {
      const override = await prepareProviderDevOverride(provider, workdir);
      tofuEnvironment.TF_CLI_CONFIG_FILE = override.cliConfigPath;
    } else {
      const registryConfigPath = join(workdir, "tofu-registry.rc");
      await writeFile(
        registryConfigPath,
        "provider_installation {\n  direct {}\n}\n",
        { mode: 0o600 },
      );
      tofuEnvironment.TF_CLI_CONFIG_FILE = registryConfigPath;
    }
    for (const args of commands) {
      const child = Bun.spawn(["tofu", ...args], {
        cwd: workdir,
        env: tofuEnvironment,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        throw new Error(
          `Takoform v1 module ${args[0] ?? "validation"} failed with exit ${exitCode}`,
        );
      }
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function main(): Promise<void> {
  await validateTakoformV1({ environment: process.env });
}

if (import.meta.main) {
  await main();
}
