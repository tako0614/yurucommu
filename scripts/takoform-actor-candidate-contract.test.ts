import { readFile } from "node:fs/promises";

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
