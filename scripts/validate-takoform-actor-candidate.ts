#!/usr/bin/env bun

import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareProviderDevOverride,
  readLocalProviderAuthority,
} from "./takoform-v1-e2e.ts";

const candidateSource = new URL(
  "../deploy/takoform/actor-candidate/",
  import.meta.url,
);
const migrationSource = new URL(
  "../deploy/takoform/migrations/",
  import.meta.url,
);
const discoveryPath = "/.well-known/takoform/v1";
const apiPath = "/apis/forms.takoform.com/v1";

const inheritedTofuAuthorityVariables = new Set([
  "TERRAFORM_CONFIG",
  "TF_CLI_CONFIG_FILE",
  "TF_DATA_DIR",
  "TF_DISABLE_PLUGIN_TLS",
  "TF_PLUGIN_CACHE_DIR",
  "TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE",
  "TF_PLUGIN_MAGIC_COOKIE",
  "TF_REATTACH_PROVIDERS",
  "TAKOFORM_ENDPOINT",
  "TAKOFORM_SPACE",
  "TAKOFORM_TOKEN",
  "TAKOFORM_TOKEN_FILE",
  "TAKOFORM_RUNTIME_INPUTS_FILE",
]);

function isInheritedAuthority(name: string): boolean {
  return (
    inheritedTofuAuthorityVariables.has(name) ||
    name === "TF_CLI_ARGS" ||
    name.startsWith("TF_CLI_ARGS_")
  );
}

export async function validateTakoformActorCandidate(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  // No released-provider fallback: the exact executable and bytes are required.
  const provider = readLocalProviderAuthority(environment);
  const workdir = await mkdtemp(join(tmpdir(), "yurucommu-actor-candidate-"));
  const moduleDir = join(workdir, "deploy", "takoform", "actor-candidate");
  const unexpectedHostRequests: string[] = [];
  const supportProfileRequests: string[] = [];
  let mockHost: ReturnType<typeof Bun.serve>;
  mockHost = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === discoveryPath) {
        return Response.json({
          api_versions: ["forms.takoform.com/v1"],
          features: {
            service_forms: true,
            exact_form_ref: true,
            optimistic_concurrency: true,
            idempotent_lifecycle: true,
            operations: true,
            artifact_upload: true,
            support_profiles: true,
          },
          endpoints: {
            api: `http://127.0.0.1:${mockHost.port}${apiPath}`,
          },
        });
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith(`${apiPath}/support/`)
      ) {
        supportProfileRequests.push(url.pathname);
        return new Response("support profiles omitted by local plan fixture", {
          status: 501,
        });
      }
      unexpectedHostRequests.push(`${request.method} ${url.pathname}`);
      return new Response("unexpected request in plan-only fixture", {
        status: 501,
      });
    },
  });
  try {
    await mkdir(moduleDir, { recursive: true });
    await Promise.all([
      cp(
        new URL("main.tf.template", candidateSource),
        join(moduleDir, "main.tf"),
      ),
      cp(
        new URL("outputs.tf.template", candidateSource),
        join(moduleDir, "outputs.tf"),
      ),
      cp(
        new URL(".generated/", candidateSource),
        join(moduleDir, ".generated"),
        {
          recursive: true,
        },
      ),
      cp(migrationSource, join(workdir, "deploy", "takoform", "migrations"), {
        recursive: true,
      }),
    ]);

    // Plan-only local fixture. It answers discovery and leaves capability
    // unknown; every mutation/read route fails closed. No endpoint is in the
    // candidate module and no apply runs.
    await writeFile(
      join(moduleDir, "qualification-provider.tf"),
      `provider "takoform" {\n  endpoint = "http://127.0.0.1:${mockHost.port}"\n  space = "candidate-check"\n  runtime_input_nonce = "actor-candidate-local-plan-20260928"\n}\n`,
      { mode: 0o600 },
    );

    const tofuEnvironment: Record<string, string | undefined> = {
      ...Object.fromEntries(
        Object.entries(environment).filter(
          ([name]) => !isInheritedAuthority(name),
        ),
      ),
      TF_IN_AUTOMATION: "1",
      CHECKPOINT_DISABLE: "1",
      TF_DATA_DIR: join(workdir, ".tofu-data"),
    };
    const override = await prepareProviderDevOverride(provider, workdir);
    tofuEnvironment.TF_CLI_CONFIG_FILE = override.cliConfigPath;

    for (const args of [
      ["validate", "-no-color"],
      [
        "plan",
        "-refresh=false",
        "-input=false",
        "-no-color",
        "-var=project_name=actor-candidate-check",
      ],
    ]) {
      const child = Bun.spawn(["tofu", ...args], {
        cwd: moduleDir,
        env: tofuEnvironment,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        throw new Error(
          `Actor candidate OpenTofu ${args[0] ?? "check"} failed with exit ${exitCode}`,
        );
      }
    }
    if (unexpectedHostRequests.length > 0) {
      throw new Error(
        `plan contacted non-discovery Host routes: ${unexpectedHostRequests.join(", ")}`,
      );
    }
    process.stdout.write(
      `local plan fixture: discovery plus ${supportProfileRequests.length} undecided support-profile read(s); no resource operation sent\n`,
    );
  } finally {
    mockHost.stop(true);
    await rm(workdir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await validateTakoformActorCandidate();
}
