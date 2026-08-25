import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { validateTakoformV1 } from "./validate-takoform-v1.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("portable Takoform v1 validation", () => {
  test("initializes the public Provider 3 release when no local candidate is configured", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yurucommu-validate-test-"));
    temporaryDirectories.push(fixture);
    const source = join(fixture, "source");
    const bin = join(fixture, "bin");
    const home = join(fixture, "home");
    const xdgConfigHome = join(fixture, "xdg");
    const argsLog = join(fixture, "tofu-args.log");
    const cwdLog = join(fixture, "tofu-cwd.log");
    const cliPathLog = join(fixture, "tofu-cli-path.log");
    const cliContentLog = join(fixture, "tofu-cli-content.log");
    const authorityEnvironmentLog = join(fixture, "tofu-authority-env.log");
    const dataDirectoryLog = join(fixture, "tofu-data-dir.log");
    const ordinaryEnvironmentLog = join(fixture, "tofu-ordinary-env.log");
    const ambientPluginCache = join(fixture, "ambient-plugin-cache");
    const ambientDataDirectory = join(fixture, "ambient-tofu-data");
    await Promise.all([
      mkdir(join(source, ".generated"), { recursive: true }),
      mkdir(bin, { recursive: true }),
      mkdir(join(xdgConfigHome, "opentofu"), { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    const maliciousConfig =
      'provider_installation {\n  dev_overrides {\n    "registry.terraform.io/tako0614/takoform" = "/malicious/provider"\n  }\n  direct {}\n}\n';
    await Promise.all([
      writeFile(join(source, "main.tf"), "terraform {}\n"),
      writeFile(join(source, "outputs.tf"), ""),
      writeFile(
        join(source, ".generated", "worker.js"),
        "export default {};\n",
      ),
      writeFile(join(home, ".tofurc"), maliciousConfig),
      writeFile(join(xdgConfigHome, "opentofu", "tofurc"), maliciousConfig),
      writeFile(
        join(bin, "tofu"),
        '#!/bin/sh\nset -eu\nprintf "%s\\n" "$*" >> "$TAKOFORM_VALIDATION_ARGS_LOG"\nprintf "%s\\n" "$PWD" >> "$TAKOFORM_VALIDATION_CWD_LOG"\nprintf "%s\\n" "$TF_CLI_CONFIG_FILE" >> "$TAKOFORM_VALIDATION_CLI_PATH_LOG"\ncat "$TF_CLI_CONFIG_FILE" > "$TAKOFORM_VALIDATION_CLI_CONTENT_LOG"\nenv | LC_ALL=C sort | grep -E \'^(TERRAFORM_CONFIG|TF_CLI_ARGS($|_)|TF_DISABLE_PLUGIN_TLS|TF_PLUGIN_CACHE_DIR|TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE|TF_PLUGIN_MAGIC_COOKIE|TF_REATTACH_PROVIDERS)=\' > "$TAKOFORM_VALIDATION_AUTHORITY_ENV_LOG" || :\nprintf "%s\\n" "$TF_DATA_DIR" >> "$TAKOFORM_VALIDATION_DATA_DIR_LOG"\nprintf "%s\\n" "${tf_cli_args-unset}" "${TF_LOG-unset}" "${TF_REGISTRY_CLIENT_TIMEOUT-unset}" > "$TAKOFORM_VALIDATION_ORDINARY_ENV_LOG"\nif [ "${1-}" = "init" ]; then\n  mkdir -p "$TF_DATA_DIR/providers"\n  printf "owned-provider-artifact\\n" > "$TF_DATA_DIR/providers/installed"\n  if [ -n "${TF_PLUGIN_CACHE_DIR-}" ]; then\n    mkdir -p "$TF_PLUGIN_CACHE_DIR"\n    printf "ambient-cache-artifact\\n" > "$TF_PLUGIN_CACHE_DIR/provider"\n  fi\n  printf "ephemeral-lock\\n" > .terraform.lock.hcl\nfi\n',
      ),
    ]);
    await chmod(join(bin, "tofu"), 0o755);
    const environment: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_CONFIG_HOME: xdgConfigHome,
      TAKOFORM_VALIDATION_ARGS_LOG: argsLog,
      TAKOFORM_VALIDATION_CWD_LOG: cwdLog,
      TAKOFORM_VALIDATION_CLI_PATH_LOG: cliPathLog,
      TAKOFORM_VALIDATION_CLI_CONTENT_LOG: cliContentLog,
      TAKOFORM_VALIDATION_AUTHORITY_ENV_LOG: authorityEnvironmentLog,
      TAKOFORM_VALIDATION_DATA_DIR_LOG: dataDirectoryLog,
      TAKOFORM_VALIDATION_ORDINARY_ENV_LOG: ordinaryEnvironmentLog,
      TF_CLI_CONFIG_FILE: join(fixture, "inherited-malicious.rc"),
      TERRAFORM_CONFIG: join(fixture, "legacy-inherited-malicious.rc"),
      TF_CLI_ARGS: "-plugin-dir=/malicious/global-provider-dir",
      TF_CLI_ARGS_init: "-plugin-dir=/malicious/init-provider-dir",
      TF_CLI_ARGS_validate: "-plugin-dir=/malicious/validate-provider-dir",
      TF_CLI_ARGS_plan: "-plugin-dir=/malicious/unused-provider-dir",
      TF_PLUGIN_CACHE_DIR: ambientPluginCache,
      TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: "1",
      TF_DATA_DIR: ambientDataDirectory,
      TF_REATTACH_PROVIDERS: '{"malicious":"provider"}',
      TF_DISABLE_PLUGIN_TLS: "1",
      TF_PLUGIN_MAGIC_COOKIE: "malicious-cookie",
      TF_LOG: "off",
      TF_REGISTRY_CLIENT_TIMEOUT: "17",
      tf_cli_args: "keep-case-sensitive-ordinary-value",
    };
    delete environment.TAKOFORM_PROVIDER_BINARY;
    delete environment.TAKOFORM_PROVIDER_SHA256;

    await validateTakoformV1({
      environment,
      source: pathToFileURL(`${source}/`),
    });

    expect(await readFile(argsLog, "utf8")).toBe(
      "init -backend=false -input=false -no-color\nvalidate -no-color\n",
    );
    const validationCwds = (await readFile(cwdLog, "utf8")).trim().split("\n");
    expect(validationCwds).toHaveLength(2);
    const validationCwd = validationCwds[0]!;
    expect(validationCwds[1]).toBe(validationCwd);
    expect(validationCwd).not.toBe(source);
    expect(existsSync(validationCwd)).toBe(false);
    const cliPaths = (await readFile(cliPathLog, "utf8")).trim().split("\n");
    expect(cliPaths).toEqual([
      join(validationCwd, "tofu-registry.rc"),
      join(validationCwd, "tofu-registry.rc"),
    ]);
    expect(await readFile(cliContentLog, "utf8")).toBe(
      "provider_installation {\n  direct {}\n}\n",
    );
    expect(await readFile(authorityEnvironmentLog, "utf8")).toBe("");
    expect(await readFile(dataDirectoryLog, "utf8")).toBe(
      `${join(validationCwd, ".tofu-data")}\n${join(validationCwd, ".tofu-data")}\n`,
    );
    expect(await readFile(ordinaryEnvironmentLog, "utf8")).toBe(
      "keep-case-sensitive-ordinary-value\noff\n17\n",
    );
    expect(existsSync(ambientPluginCache)).toBe(false);
    expect(existsSync(ambientDataDirectory)).toBe(false);
    expect(existsSync(join(source, ".terraform.lock.hcl"))).toBe(false);
    expect(existsSync(join(source, ".terraform"))).toBe(false);
  });

  test("fails closed when local candidate authority is only partially configured", async () => {
    await expect(
      validateTakoformV1({
        environment: {
          TAKOFORM_PROVIDER_BINARY: "/tmp/terraform-provider-takoform",
        },
      }),
    ).rejects.toThrow(
      "TAKOFORM_PROVIDER_BINARY and TAKOFORM_PROVIDER_SHA256 are required",
    );
  });

  test("wires both exact candidate values without registry init or source lock state", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yurucommu-validate-test-"));
    temporaryDirectories.push(fixture);
    const source = join(fixture, "source");
    const bin = join(fixture, "bin");
    const candidate = join(fixture, "terraform-provider-takoform");
    const argsLog = join(fixture, "candidate-args.log");
    const cwdLog = join(fixture, "candidate-cwd.log");
    const cliContentLog = join(fixture, "candidate-cli-content.log");
    const authorityEnvironmentLog = join(
      fixture,
      "candidate-authority-env.log",
    );
    const dataDirectoryLog = join(fixture, "candidate-data-dir.log");
    const ordinaryEnvironmentLog = join(fixture, "candidate-ordinary-env.log");
    const ambientPluginCache = join(fixture, "candidate-ambient-cache");
    const ambientDataDirectory = join(fixture, "candidate-ambient-data");
    const candidateBytes = new TextEncoder().encode("exact-provider-3.0.0");
    await Promise.all([
      mkdir(join(source, ".generated"), { recursive: true }),
      mkdir(bin, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(source, "main.tf"), "terraform {}\n"),
      writeFile(join(source, "outputs.tf"), ""),
      writeFile(
        join(source, ".generated", "worker.js"),
        "export default {};\n",
      ),
      writeFile(candidate, candidateBytes),
      writeFile(
        join(bin, "tofu"),
        '#!/bin/sh\nset -eu\nprintf "%s\\n" "$*" >> "$TAKOFORM_VALIDATION_ARGS_LOG"\nprintf "%s\\n" "$PWD" >> "$TAKOFORM_VALIDATION_CWD_LOG"\ncat "$TF_CLI_CONFIG_FILE" > "$TAKOFORM_VALIDATION_CLI_CONTENT_LOG"\nenv | LC_ALL=C sort | grep -E \'^(TERRAFORM_CONFIG|TF_CLI_ARGS($|_)|TF_DISABLE_PLUGIN_TLS|TF_PLUGIN_CACHE_DIR|TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE|TF_PLUGIN_MAGIC_COOKIE|TF_REATTACH_PROVIDERS)=\' > "$TAKOFORM_VALIDATION_AUTHORITY_ENV_LOG" || :\nprintf "%s\\n" "$TF_DATA_DIR" > "$TAKOFORM_VALIDATION_DATA_DIR_LOG"\nprintf "%s\\n" "${TF_LOG-unset}" "${TF_REGISTRY_CLIENT_TIMEOUT-unset}" > "$TAKOFORM_VALIDATION_ORDINARY_ENV_LOG"\nprovider_directory=$(sed -n \'s/.* = "\\(.*\\)"/\\1/p\' "$TF_CLI_CONFIG_FILE")\ncmp "$TAKOFORM_PROVIDER_BINARY" "$provider_directory/terraform-provider-takoform"\nmkdir -p "$TF_DATA_DIR/providers"\nprintf "owned-provider-artifact\\n" > "$TF_DATA_DIR/providers/candidate"\nif [ -n "${TF_PLUGIN_CACHE_DIR-}" ]; then\n  mkdir -p "$TF_PLUGIN_CACHE_DIR"\n  printf "ambient-cache-artifact\\n" > "$TF_PLUGIN_CACHE_DIR/provider"\nfi\nprintf "ephemeral-lock\\n" > .terraform.lock.hcl\n',
      ),
    ]);
    await Promise.all([
      chmod(candidate, 0o755),
      chmod(join(bin, "tofu"), 0o755),
    ]);
    const providerSha256 =
      "sha256:" + createHash("sha256").update(candidateBytes).digest("hex");

    await validateTakoformV1({
      environment: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TAKOFORM_PROVIDER_BINARY: candidate,
        TAKOFORM_PROVIDER_SHA256: providerSha256,
        TAKOFORM_VALIDATION_ARGS_LOG: argsLog,
        TAKOFORM_VALIDATION_CWD_LOG: cwdLog,
        TAKOFORM_VALIDATION_CLI_CONTENT_LOG: cliContentLog,
        TAKOFORM_VALIDATION_AUTHORITY_ENV_LOG: authorityEnvironmentLog,
        TAKOFORM_VALIDATION_DATA_DIR_LOG: dataDirectoryLog,
        TAKOFORM_VALIDATION_ORDINARY_ENV_LOG: ordinaryEnvironmentLog,
        TF_CLI_CONFIG_FILE: join(fixture, "inherited-malicious.rc"),
        TERRAFORM_CONFIG: join(fixture, "legacy-inherited-malicious.rc"),
        TF_CLI_ARGS: "-plugin-dir=/malicious/global-provider-dir",
        TF_CLI_ARGS_init: "-plugin-dir=/malicious/init-provider-dir",
        TF_CLI_ARGS_validate: "-plugin-dir=/malicious/validate-provider-dir",
        TF_PLUGIN_CACHE_DIR: ambientPluginCache,
        TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: "1",
        TF_DATA_DIR: ambientDataDirectory,
        TF_REATTACH_PROVIDERS: '{"malicious":"provider"}',
        TF_DISABLE_PLUGIN_TLS: "1",
        TF_PLUGIN_MAGIC_COOKIE: "malicious-cookie",
        TF_LOG: "off",
        TF_REGISTRY_CLIENT_TIMEOUT: "17",
      },
      source: pathToFileURL(`${source}/`),
    });

    expect(await readFile(argsLog, "utf8")).toBe("validate -no-color\n");
    const validationCwd = (await readFile(cwdLog, "utf8")).trim();
    expect(validationCwd).not.toBe(source);
    expect(existsSync(validationCwd)).toBe(false);
    const cliContent = await readFile(cliContentLog, "utf8");
    expect(cliContent).toBe(
      `provider_installation {\n  dev_overrides {\n    "registry.terraform.io/tako0614/takoform" = ${JSON.stringify(join(validationCwd, "provider-dev-override"))}\n  }\n  direct {}\n}\n`,
    );
    expect(await readFile(authorityEnvironmentLog, "utf8")).toBe("");
    expect(await readFile(dataDirectoryLog, "utf8")).toBe(
      `${join(validationCwd, ".tofu-data")}\n`,
    );
    expect(await readFile(ordinaryEnvironmentLog, "utf8")).toBe("off\n17\n");
    expect(existsSync(ambientPluginCache)).toBe(false);
    expect(existsSync(ambientDataDirectory)).toBe(false);
    expect(existsSync(join(source, ".terraform.lock.hcl"))).toBe(false);
    expect(existsSync(join(source, ".terraform"))).toBe(false);
  });
});
