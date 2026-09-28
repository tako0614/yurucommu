import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  createEntrySource,
  shouldEmbedClientAsset,
} from "./build-yurucommu-worker.ts";

test("private dispatcher candidate is separately buildable but absent from default delivery", async () => {
  const [builder, dispatcher, moduleSource] = await Promise.all([
    readFile(new URL("./build-yurucommu-worker.ts", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../actor-candidate/yurucommu-call-dispatcher.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
  ]);

  expect(builder).toContain("--dispatcher-candidate-only");
  expect(builder).toContain("buildCallDispatcherCandidate()");
  expect(builder).toContain("actor-candidate/yurucommu-call-dispatcher.ts");
  expect(builder).toContain("yurucommu-call-dispatcher.js");
  expect(createEntrySource({})).not.toContain("yurucommu-call-dispatcher");
  expect(shouldEmbedClientAsset("yurucommu-call-dispatcher.js")).toBe(false);
  expect(shouldEmbedClientAsset("assets/client.js")).toBe(true);
  expect(dispatcher).toContain("createCallDispatcherForCallsByInvocation");
  expect(dispatcher).toContain('pathname !== "/_dispatch"');
  expect(dispatcher).toContain("requires edge.sql DB binding");
  expect(dispatcher).not.toContain("requires APP_URL");
  expect(dispatcher).toContain("CALL_SIGNALING.idFromName(localActorApId)");
  expect(moduleSource).not.toContain("CALL_DISPATCHER");
  expect(moduleSource).not.toContain("call-dispatcher");
});
