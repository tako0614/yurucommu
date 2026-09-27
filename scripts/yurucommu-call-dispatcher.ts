/**
 * Source-only Worker D candidate. The product's future Host composition must
 * bind this Worker by service only; this module must not get a public endpoint.
 * It does not change the default product Worker or install topology.
 */
import {
  createCallDispatcherForCalls,
  createEdgeSqlDatabase,
  isEdgeSqlBinding,
  resolveRuntimeLane,
  type EdgeSqlBinding,
  type EnvVars,
} from "@takosjp/yurucommu-core/server";

interface ActorStub {
  fetch(request: Request): Promise<Response>;
}

interface ActorNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): ActorStub;
}

export interface PrivateCallDispatcherBindings extends Readonly<
  Record<string, unknown>
> {
  readonly YURUCOMMU_RUNTIME_LANE: "portable";
  readonly DB: EdgeSqlBinding;
  readonly APP_URL: string;
  readonly CALL_SIGNALING: ActorNamespace;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

function isActorNamespace(value: unknown): value is ActorNamespace {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ActorNamespace).idFromName === "function" &&
    typeof (value as ActorNamespace).get === "function"
  );
}

function requireBindings(
  value: Readonly<Record<string, unknown>>,
): PrivateCallDispatcherBindings {
  if (resolveRuntimeLane(value.YURUCOMMU_RUNTIME_LANE) !== "portable") {
    throw new Error("call dispatcher requires the declared portable lane");
  }
  if (!isEdgeSqlBinding(value.DB)) {
    throw new Error("call dispatcher requires edge.sql DB binding");
  }
  if (typeof value.APP_URL !== "string" || !value.APP_URL) {
    throw new Error("call dispatcher requires APP_URL");
  }
  if (!isActorNamespace(value.CALL_SIGNALING)) {
    throw new Error(
      "call dispatcher requires private CALL_SIGNALING Actor binding",
    );
  }
  return value as PrivateCallDispatcherBindings;
}

export function createPrivateCallDispatcherService(
  rawBindings: Readonly<Record<string, unknown>>,
) {
  const bindings = requireBindings(rawBindings);
  const dispatcher = createCallDispatcherForCalls({
    db: createEdgeSqlDatabase(bindings.DB),
    env: bindings as EnvVars,
    actorFor: (localActorApId) =>
      bindings.CALL_SIGNALING.get(
        bindings.CALL_SIGNALING.idFromName(localActorApId),
      ),
  });
  return {
    fetch(request: Request, context: WorkerContext): Promise<Response> {
      // Actor admission is the only caller. Core's synchronous /_send path is
      // deliberately not an additional service ingress on this Worker.
      if (new URL(request.url).pathname !== "/_dispatch") {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return dispatcher.fetch(request, context);
    },
  };
}

// A single dispatcher per Worker isolate keeps Core's job/byte admission
// shared across requests while waitUntil producers are running. Reject an env
// replacement instead of silently constructing an independent second limit.
let activeBindings: Readonly<Record<string, unknown>> | undefined;
let activeService:
  ReturnType<typeof createPrivateCallDispatcherService> | undefined;

export default {
  fetch(
    request: Request,
    env: Readonly<Record<string, unknown>>,
    context: WorkerContext,
  ): Promise<Response> {
    if (activeBindings && activeBindings !== env) {
      throw new Error(
        "call dispatcher bindings changed within one Worker isolate",
      );
    }
    if (!activeService) {
      activeService = createPrivateCallDispatcherService(env);
      activeBindings = env;
    }
    return activeService.fetch(request, context);
  },
};
