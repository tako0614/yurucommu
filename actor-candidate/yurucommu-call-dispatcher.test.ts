import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import dispatcherEntry, {
  createPrivateCallDispatcherService,
} from "./yurucommu-call-dispatcher.ts";
import { createEntrySource } from "../scripts/build-yurucommu-worker.ts";

const actor = "https://local.example/ap/users/alice";
const effectId = "00000000-0000-4000-8000-000000000001";

function bindings() {
  const actorNames: string[] = [];
  const actorIds: unknown[] = [];
  const callbacks: Request[] = [];
  const env = {
    YURUCOMMU_RUNTIME_LANE: "portable",
    DB: {
      async execute(): Promise<never> {
        // A failed signing-key read makes the peer send fail without network I/O.
        throw new Error("database unavailable");
      },
      async query(): Promise<never> {
        throw new Error("unexpected direct query");
      },
      async transaction(): Promise<never> {
        throw new Error("unexpected transaction");
      },
    },
    CALL_SIGNALING: {
      idFromName(name: string) {
        actorNames.push(name);
        return { opaque: name };
      },
      get(id: unknown) {
        actorIds.push(id);
        return {
          async fetch(request: Request) {
            callbacks.push(request);
            return new Response(null, { status: 204 });
          },
        };
      },
    },
  } as const;
  return { env, actorNames, actorIds, callbacks };
}

function context() {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    waitUntil(promise: Promise<unknown>) {
      tasks.push(promise);
    },
  };
}

function request(path: string, body: unknown) {
  return new Request(`https://dispatcher.internal${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test("private candidate requires portable SQL and Actor bindings without a guessed origin", () => {
  const { env } = bindings();
  const service = createPrivateCallDispatcherService();
  const call = (input: Readonly<Record<string, unknown>>) =>
    service.fetch(request("/_dispatch", {}), input, context());
  expect(() => call(env)).not.toThrow();
  expect(() =>
    call({
      ...env,
      YURUCOMMU_RUNTIME_LANE: "cloudflare",
    }),
  ).toThrow();
  expect(() => call({ ...env, DB: {} })).toThrow("edge.sql DB binding");
  expect(() => call({ ...env, CALL_SIGNALING: {} })).toThrow(
    "CALL_SIGNALING Actor binding",
  );
});

test("private entry forwards only Actor admission and maps callback by local AP ID", async () => {
  const { env, actorNames, actorIds, callbacks } = bindings();
  const ctx = context();
  const job = {
    effect: {
      effectId,
      callId: "call-1",
      generation: "00000000-0000-4000-8000-000000000002",
      deadline: Date.now() + 8_000,
      signalType: "offer",
      continuation: "none",
    },
    envelope: {
      v: 1,
      callId: "call-1",
      from: actor,
      to: "https://peer.example/ap/users/bob",
      type: "offer",
      sdp: "SECRET-SDP",
      ts: Date.now(),
      ttlMs: 30_000,
    },
  };

  expect(
    (await dispatcherEntry.fetch(request("/_send", job), env, ctx)).status,
  ).toBe(404);
  expect(ctx.tasks).toHaveLength(0);

  const accepted = await dispatcherEntry.fetch(
    request("/_dispatch", job),
    env,
    ctx,
  );
  expect(accepted.status).toBe(202);
  expect(ctx.tasks).toHaveLength(1);
  await Promise.all(ctx.tasks);
  expect(actorNames).toEqual([actor]);
  expect(actorIds).toEqual([{ opaque: actor }]);
  expect(callbacks).toHaveLength(1);
  expect(new URL(callbacks[0]!.url).pathname).toBe("/_relay-result");
  const callbackBody = await callbacks[0]!.text();
  expect(callbackBody).toContain('"outcome":"failed"');
  expect(callbackBody).not.toContain("SECRET-SDP");

  // A fresh env object must not open an independent admission budget or be
  // rejected merely because its object identity changed between invocations.
  const freshEnv = { ...env };
  const second = await dispatcherEntry.fetch(
    request("/_dispatch", {
      ...job,
      effect: {
        ...job.effect,
        effectId: "00000000-0000-4000-8000-000000000003",
      },
    }),
    freshEnv,
    ctx,
  );
  expect(second.status).toBe(202);
  await Promise.all(ctx.tasks);
  expect(actorNames).toEqual([actor, actor]);
});

test("candidate does not create a public dispatcher route or alter the default entry", async () => {
  const moduleSource = await readFile(
    new URL("../deploy/takoform/main.tf", import.meta.url),
    "utf8",
  );
  expect(moduleSource).not.toContain("CALL_DISPATCHER");
  expect(moduleSource).not.toContain("call-dispatcher");
  expect(createEntrySource({})).not.toContain("yurucommu-call-dispatcher.ts");
});
