import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, test } from "bun:test";

const candidateMain = new URL(
  "../deploy/takoform/actor-candidate/main.tf",
  import.meta.url,
);
const defaultMain = new URL("../deploy/takoform/main.tf", import.meta.url);
const candidateBuild = new URL(
  "../scripts/build-yurucommu-worker.ts",
  import.meta.url,
);
const sensitiveConsumerCandidates = [
  "ENCRYPTION_KEY",
  "TAKOSUMI_ACCOUNTS_ISSUER_URL",
  "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  "TAKOSUMI_ACCOUNTS_OWNER_SUB",
  "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
] as const;

async function collectCoreEnvironmentConsumers(
  directory: string,
): Promise<Set<string>> {
  const consumers = new Set<string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const consumer of await collectCoreEnvironmentConsumers(path)) {
        consumers.add(consumer);
      }
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(
        /\b(?:env|c\.env)\.([A-Z][A-Z0-9_]*)\b/gu,
      )) {
        consumers.add(match[1]);
      }
      for (const match of source.matchAll(
        /envValue\([^,]+,\s*["']([A-Z][A-Z0-9_]*)["']/gu,
      )) {
        consumers.add(match[1]);
      }
    }
  }
  return consumers;
}

function requiredSensitiveNames(source: string): string[] {
  const block = source.match(
    /required_sensitive_vars\s*=\s*\[([\s\S]*?)\]/u,
  )?.[1];
  if (block === undefined)
    throw new Error("product Worker required_sensitive_vars is missing");
  return [...block.matchAll(/"([A-Z][A-Z0-9_]*)"/gu)].map((match) => match[1]);
}

test("Actor topology remains an explicit private candidate", async () => {
  const source = await readFile(candidateMain, "utf8");
  expect(source).toContain('version = "= 0.0.0-dev"');
  expect(source).toContain(
    'resource "takoform_actor_namespace" "call_signaling"',
  );
  expect(source).toContain(
    'resource "takoform_actor_namespace" "realtime_stream"',
  );
  expect(source).toContain('class_name = "CallSignalingActor"');
  expect(source).toContain('class_name = "RealtimeStreamActor"');
  expect(source).toContain('name        = "CALL_DISPATCHER"');
  expect(source).toContain(
    "target_name = takoform_module_worker.dispatcher.name",
  );
  expect(source).toContain('name        = "CALL_SIGNALING"');
  expect(source).toContain(
    "target_name = takoform_actor_namespace.call_signaling.name",
  );
  expect(source).toContain('name        = "REALTIME_STREAM"');
  expect(source).toContain(
    "target_name = takoform_actor_namespace.realtime_stream.name",
  );
  expect(source).toContain("path.module}/.generated/yurucommu-worker.js");
  expect(source).toContain(
    "path.module}/.generated/yurucommu-call-dispatcher.js",
  );
  expect(source).toContain("path.module}/../migrations/sql");
  expect(source).not.toContain("APP_URL");

  const productVersionBlock = source
    .split('resource "takoform_worker_version" "product"')[1]
    ?.split('resource "takoform_worker_deployment" "product"')[0];
  expect(productVersionBlock).toContain(
    "takoform_worker_deployment.dispatcher",
  );

  const dispatcherBlock = source
    .split('resource "takoform_worker_version" "dispatcher"')[1]
    ?.split('resource "takoform_worker_deployment" "dispatcher"')[0];
  expect(dispatcherBlock).toBeDefined();
  expect(dispatcherBlock).not.toContain("service_bindings");
});

test("candidate build output is isolated from the released module", async () => {
  const [candidate, released, builder] = await Promise.all([
    readFile(candidateMain, "utf8"),
    readFile(defaultMain, "utf8"),
    readFile(candidateBuild, "utf8"),
  ]);
  expect(candidate).toContain("source-only Actor candidate");
  expect(released).toMatch(/version\s+=\s+"= 4\.0\.0"/u);
  expect(released).not.toContain("takoform_actor_namespace");
  expect(builder).toContain("buildTakoformActorCandidate");
  expect(builder).toContain("actorCandidateProductOutputFile");
  expect(builder).toContain("actorCandidateDispatcherOutputFile");
});

test("candidate required secrets match the locked Core's actual env consumers", async () => {
  const [candidate] = await Promise.all([readFile(candidateMain, "utf8")]);
  const coreEntry = Bun.resolveSync(
    "@takosjp/yurucommu-core/server",
    import.meta.dir,
  );
  const coreRoot = dirname(dirname(dirname(coreEntry)));
  const coreConsumers = await collectCoreEnvironmentConsumers(
    join(coreRoot, "src/backend"),
  );
  const actualCandidates = sensitiveConsumerCandidates.filter((name) =>
    coreConsumers.has(name),
  );

  expect(requiredSensitiveNames(candidate)).toEqual(actualCandidates);
  expect(coreConsumers.has("TAKOSUMI_ACCOUNTS_REDIRECT_URI")).toBe(false);
});
