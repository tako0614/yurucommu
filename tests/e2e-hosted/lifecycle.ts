import { randomBytes } from "node:crypto";
import {
  ORDER,
  appOrigin,
  canonical,
  check,
  form,
  graphSpec,
  originReservation,
  record,
  resourceName,
  type Fixture,
  type Operation,
  type Resource,
  type Role,
  type SharedOriginSelection,
  type Target,
} from "./contracts.ts";
import { sha256 } from "./inputs.ts";
import type { Journal } from "./journal.ts";
import type { Port } from "./v2-port.ts";

export interface Report {
  kind: "yurucommu.hosted-e2e@v2";
  status: "passed" | "failed" | "halted";
  code?: "HEALTH_FAILED" | "UNKNOWN_ACK_OR_EFFECT";
  resourceCount: number;
  authoritativeAbsence: boolean;
  routeAbsent: boolean;
}
export async function probeHealth(port: Port, origin: string): Promise<void> {
  for (const path of ["/healthz", "/readyz"]) {
    const value = record(await port.appJson(origin, path));
    check(
      value.service === "yurucommu" &&
        value.status === "ok" &&
        Array.isArray(value.missingBindings) &&
        value.missingBindings.length === 0,
      "HEALTH_FAILED",
    );
  }
  const social = record(
    await port.appJson(origin, "/.well-known/social-server"),
  );
  check(
    social.product === "yurucommu" &&
      record(social.server).canonicalOrigin === origin,
    "HEALTH_FAILED",
  );
  const info = record(await port.appJson(origin, "/nodeinfo/2.0"));
  const usage = record(info.usage);
  check(
    record(info.software).name === "yurucommu" &&
      Number.isSafeInteger(record(usage.users).total) &&
      (record(usage.users).total as number) >= 0 &&
      Number.isSafeInteger(usage.localPosts) &&
      (usage.localPosts as number) >= 0,
    "HEALTH_FAILED",
  );
}
export async function runLifecycle(input: {
  target: Target;
  fixture: Fixture;
  runId: string;
  privateInputs: Readonly<Record<string, string>>;
  port: Port;
  journal: Journal;
  sharedOrigin?: SharedOriginSelection;
  operationTimeoutMs?: number;
  pause?: () => Promise<void>;
}): Promise<Report> {
  const { target, fixture, runId, privateInputs, port } = input;
  // Metadata returned by a misconfigured Host must not echo application inputs.
  const journal: Journal = {
    async append(entry) {
      const encoded = JSON.stringify(entry);
      const values = Object.values(entry);
      check(
        !Object.values(privateInputs).some(
          (value) =>
            values.includes(value) ||
            (value.length >= 8 &&
              encoded.includes(JSON.stringify(value).slice(1, -1))),
        ),
        "PRIVATE_INPUT_IN_METADATA",
      );
      await input.journal.append(entry);
    },
    close: () => input.journal.close(),
  };
  check(/^staging-yuru-[0-9a-f]{12}$/.test(runId), "RUN_ID_REFUSED");
  check(
    !input.sharedOrigin || input.sharedOrigin.kind === "form-v2@1",
    "SHARED_ORIGIN_SELECTION_REFUSED",
  );
  const reservation = input.sharedOrigin ? originReservation(runId) : undefined;
  const timeout = input.operationTimeoutMs ?? 60_000;
  check(
    Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 60_000,
    "TIMEOUT_REFUSED",
  );
  const pause =
    input.pause ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
  await port.preflight(
    ORDER.map((role) => ({ role, name: resourceName(runId, role) })),
    fixture.files,
  );
  await journal.append({
    kind: "prepared",
    runId,
    hostOrigin: target.hostOrigin,
    space: target.space,
    sourceCommit: fixture.sourceCommit,
    fixtureSha256: fixture.receiptSha256,
    hostCommit: target.qualifiedHostCommit,
    qualificationSha256: target.qualificationReceiptSha256,
  });
  const resources: Partial<Record<Role, Resource>> = {};
  const ownedUids = new Set<string>();
  let count = 0;
  const halt = async (): Promise<Report> => {
    try {
      await journal.append({ kind: "halted", code: "UNKNOWN_ACK_OR_EFFECT" });
    } catch {
      /* The last synced intent is retained even if the journal device fails. */
    }
    return {
      kind: "yurucommu.hosted-e2e@v2",
      status: "halted",
      code: "UNKNOWN_ACK_OR_EFFECT",
      resourceCount: count,
      authoritativeAbsence: false,
      routeAbsent: false,
    };
  };
  const settle = async (accepted: Operation): Promise<Operation> => {
    let current = accepted;
    const deadline = Date.now() + timeout;
    for (;;) {
      check(
        current.id === accepted.id &&
          current.resourceUid === accepted.resourceUid &&
          current.action === accepted.action &&
          current.generation === accepted.generation,
        "OPERATION_IDENTITY_CHANGED",
      );
      if (current.status === "succeeded" && current.effect === "complete")
        return current;
      // GET the accepted Operation only. There is no replay, replenish, or reconciliation mutation.
      check(
        ["queued", "running"].includes(current.status) &&
          ["none", "unknown"].includes(current.effect) &&
          Date.now() < deadline,
        "EFFECT_UNCONFIRMED",
      );
      await pause();
      current = await port.operation(accepted.id);
    }
  };
  const mutate = async (
    role: Role,
    action: "create" | "delete",
  ): Promise<void> => {
    const previous = resources[role];
    const spec =
      action === "create" ? graphSpec(role, runId, fixture, resources) : {};
    const key = `${runId}:${action}:${role}:${randomBytes(8).toString("hex")}`;
    await journal.append({
      kind: "intent",
      role,
      action,
      key,
      publicSpecSha256: sha256(canonical(spec)),
      ...(previous
        ? { uid: previous.uid, generation: previous.generation }
        : {}),
    });
    const op =
      action === "create"
        ? await port.create(
            role,
            resourceName(runId, role),
            spec,
            key,
            role === "version" ? privateInputs : undefined,
          )
        : await port.delete(previous!, key);
    check(
      op.action === action &&
        op.generation ===
          (action === "create" ? 1 : previous!.generation + 1) &&
        (action === "create"
          ? !ownedUids.has(op.resourceUid)
          : op.resourceUid === previous!.uid),
      "ACK_IDENTITY_REFUSED",
    );
    await journal.append({
      kind: "ack",
      role,
      action,
      operationId: op.id,
      uid: op.resourceUid,
      generation: op.generation,
    });
    await settle(op);
    if (action === "create") {
      const resource = await port.resource(op.resourceUid);
      check(
        resource.uid === op.resourceUid &&
          resource.form === form(role) &&
          resource.space === target.space &&
          resource.name === resourceName(runId, role) &&
          resource.generation === op.generation &&
          resource.observedGeneration === op.generation &&
          resource.phase === "idle" &&
          resource.lastOperation === op.id &&
          canonical(resource.spec) === canonical(spec),
        "RESOURCE_IDENTITY_REFUSED",
      );
      await journal.append({
        kind: "settled",
        role,
        operationId: op.id,
        uid: resource.uid,
        generation: resource.generation,
      });
      resources[role] = resource;
      ownedUids.add(resource.uid);
      count++;
      if (role === "endpoint" && reservation)
        check(
          appOrigin(resource.output.url) === reservation.canonicalPublicOrigin,
          "ORIGIN_RESERVATION_UNCONFIRMED",
        );
    } else {
      check(await port.absent(previous!.uid), "ABSENCE_UNCONFIRMED");
      await journal.append({ kind: "absent", role, uid: previous!.uid });
    }
  };
  let origin: string;
  try {
    if (reservation) {
      // Keep the original locator even if the PUT commits without its ACK.
      // No Resource is created until both the strict ACK and its journal sync.
      await journal.append({
        kind: "origin-reservation-intent",
        ...reservation,
      });
      await port.prepareOrigin(reservation);
      await journal.append({ kind: "origin-reservation-ack", ...reservation });
    }
    for (const role of ORDER) await mutate(role, "create");
    origin = appOrigin(resources.endpoint!.output.url);
    check(
      /^(?:staging|integration)-/.test(new URL(origin).hostname),
      "APP_ORIGIN_REFUSED",
    );
    check(
      !reservation || origin === reservation.canonicalPublicOrigin,
      "ORIGIN_RESERVATION_UNCONFIRMED",
    );
  } catch {
    // A send may have taken effect even when HTTP failed or an ACK was malformed.
    // Every intent is durable before the send. Leave known and unknown effects intact.
    return halt();
  }
  let healthy = true;
  try {
    await probeHealth(port, origin);
  } catch {
    healthy = false;
  }
  try {
    await journal.append({ kind: "health", passed: healthy });
  } catch {
    return halt();
  }
  try {
    // No finally-destroy. Teardown starts only once every create effect is settled and owned.
    // Reverse dependency order detaches cron/consumers/route/deployment before deleting their inputs.
    for (const role of [...ORDER].reverse()) await mutate(role, "delete");
    check(await port.routeAbsent(origin), "ROUTE_ABSENCE_UNCONFIRMED");
    await journal.append({ kind: "route-absent" });
  } catch {
    return halt();
  }
  try {
    await journal.append({ kind: "complete", passed: healthy });
  } catch {
    return halt();
  }
  return {
    kind: "yurucommu.hosted-e2e@v2",
    status: healthy ? "passed" : "failed",
    ...(!healthy ? { code: "HEALTH_FAILED" as const } : {}),
    resourceCount: count,
    authoritativeAbsence: true,
    routeAbsent: true,
  };
}
