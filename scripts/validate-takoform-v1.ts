import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareProviderDevOverride,
  readLocalProviderAuthority,
} from "./takoform-v1-e2e.ts";

export async function main(): Promise<void> {
  const provider = readLocalProviderAuthority(process.env);
  const workdir = await mkdtemp(join(tmpdir(), "yurucommu-takoform-validate-"));
  const source = new URL("../deploy/takoform/", import.meta.url);

  try {
    await Promise.all([
      cp(new URL("main.tf", source), join(workdir, "main.tf")),
      cp(new URL("outputs.tf", source), join(workdir, "outputs.tf")),
      cp(new URL(".generated/", source), join(workdir, ".generated"), {
        recursive: true,
      }),
    ]);
    const override = await prepareProviderDevOverride(provider, workdir);
    const child = Bun.spawn(["tofu", "validate", "-no-color"], {
      cwd: workdir,
      env: {
        ...process.env,
        TF_CLI_CONFIG_FILE: override.cliConfigPath,
        TF_IN_AUTOMATION: "1",
        CHECKPOINT_DISABLE: "1",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(
        `Takoform v1 module validation failed with exit ${exitCode}`,
      );
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
