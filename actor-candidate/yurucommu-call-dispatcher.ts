/**
 * Source-only Worker D candidate. The product's future Host composition must
 * bind this Worker by service only; this module must not get a public endpoint.
 * It does not change the default product Worker or install topology.
 */
import {
  createCallDispatcherForCallsByInvocation,
  createEdgeSqlDatabase,
  isEdgeSqlBinding,
  resolveRuntimeLane,
  type EdgeSqlBinding,
  type EnvVars,
} from "@takosjp/yurucommu-core/server";

type CallDispatcherEnv = Pick<
  EnvVars,
  | "YURUCOMMU_RTC_ICE_SERVERS"
  | "YURUCOMMU_RTC_TURN_URIS"
  | "YURUCOMMU_RTC_TURN_SECRET"
  | "YURUCOMMU_RTC_TURN_TTL"
  | "YURUCOMMU_RTC_SFU_ADAPTER"
  | "YURUCOMMU_RTC_SFU_URL"
  | "YURUCOMMU_RTC_SFU_TOKEN"
  | "YURUCOMMU_RTC_SFU_APP_ID"
  | "YURUCOMMU_RTC_SFU_APP_SECRET"
>;

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
  if (!isActorNamespace(value.CALL_SIGNALING)) {
    throw new Error(
      "call dispatcher requires private CALL_SIGNALING Actor binding",
    );
  }
  return value as PrivateCallDispatcherBindings;
}

export function createPrivateCallDispatcherService() {
  const dispatcher = createCallDispatcherForCallsByInvocation();
  return {
    fetch(
      request: Request,
      rawBindings: Readonly<Record<string, unknown>>,
      context: WorkerContext,
    ): Promise<Response> {
      // Actor admission is the only caller. Core's synchronous /_send path is
      // deliberately not an additional service ingress on this Worker.
      if (new URL(request.url).pathname !== "/_dispatch") {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      const bindings = requireBindings(rawBindings);
      return dispatcher.fetch(request, context, {
        db: createEdgeSqlDatabase(bindings.DB),
        env: bindings as CallDispatcherEnv,
        actorFor: (localActorApId) =>
          bindings.CALL_SIGNALING.get(
            bindings.CALL_SIGNALING.idFromName(localActorApId),
          ),
      });
    },
  };
}

// One dispatcher admission budget per Worker isolate, but each accepted job
// captures only its own invocation's SQL and Actor binding handles.
const service = createPrivateCallDispatcherService();

export default {
  fetch(
    request: Request,
    env: Readonly<Record<string, unknown>>,
    context: WorkerContext,
  ): Promise<Response> {
    return service.fetch(request, env, context);
  },
};
