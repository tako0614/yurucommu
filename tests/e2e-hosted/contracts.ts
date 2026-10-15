// Base public Host v2 identities were inspected at takoserver 1b44eb09.
// SQLite migration 0.4 follows owning Forms source 5842d749; Host/runtime
// qualification of this integration candidate remains separate.
// This adapter is independent of the product's retained v1 Provider profile.
export const API = "forms.takoform.com/v2";
export const APP_SUFFIX = ".app-staging.takos.jp";
export const FORMS = {
  app: "ModuleWorker/0.3.0",
  bundle: "WorkerBundle/0.2.0",
  version: "WorkerVersion/0.5.0",
  deployment: "WorkerDeployment/0.4.0",
  endpoint: "WorkerEndpoint/0.3.0",
  database: "SQLiteDatabase/0.2.0",
  schema: "SQLiteMigrationSet/0.4.0",
  "schema-application": "SQLiteMigrationApplication/0.4.0",
  cache: "EdgeKVNamespace/0.2.0",
  media: "ObjectBucket/0.2.0",
  delivery: "AtLeastOnceQueue/0.2.0",
  "delivery-dlq": "AtLeastOnceQueue/0.2.0",
  "delivery-consumer": "QueueConsumer/0.3.0",
  "delivery-dlq-consumer": "QueueConsumer/0.3.0",
  retention: "WorkerCronTrigger/0.3.0",
} as const;
export type Role = keyof typeof FORMS;
export const form = (role: Role) =>
  `https://edge.forms.takoform.com/forms/${FORMS[role]}/`;
export const ORDER: readonly Role[] = [
  "database",
  "schema",
  "schema-application",
  "cache",
  "media",
  "delivery",
  "delivery-dlq",
  "app",
  "bundle",
  "version",
  "deployment",
  "endpoint",
  "delivery-consumer",
  "delivery-dlq-consumer",
  "retention",
];
export const PRIVATE_NAMES = [
  "ENCRYPTION_KEY",
  "YURUCOMMU_SESSION_HASH_SALT",
  "TAKOSUMI_ACCOUNTS_ISSUER_URL",
  "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  "TAKOSUMI_ACCOUNTS_OWNER_SUB",
  "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
] as const;
export type JsonObject = Record<string, unknown>;
export interface Resource {
  uid: string;
  form: string;
  space: string;
  name: string;
  generation: number;
  observedGeneration: number;
  phase: string;
  lastOperation: string;
  spec: JsonObject;
  observed: JsonObject;
  output: JsonObject;
}
export interface Operation {
  id: string;
  resourceUid: string;
  action: "create" | "delete";
  generation: number;
  status: string;
  effect: string;
}
export interface Artifact {
  url: string;
  sha256: string;
}
export interface Fixture {
  sourceCommit: string;
  receiptSha256: string;
  workerBundle: Artifact;
  migrationSet: Artifact;
  files: readonly Artifact[];
}
export interface Target {
  hostOrigin: string;
  space: string;
  qualifiedHostCommit: string;
  qualificationReceiptSha256: string;
}
export class HarnessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HarnessError";
  }
}
export function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new HarnessError(code);
}
export function record(value: unknown): JsonObject {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_SHAPE",
  );
  return value as JsonObject;
}
export function text(value: unknown): string {
  check(typeof value === "string" && value.length > 0, "INVALID_SHAPE");
  return value;
}
export function exact(value: JsonObject, keys: readonly string[]): void {
  check(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    "INVALID_SHAPE",
  );
}
export const digestPattern = /^[0-9a-f]{64}$/;
export const uidPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function publicUrl(value: unknown): string {
  const input = text(value);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HarnessError("INVALID_URL");
  }
  check(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === input &&
      input.length <= 2048,
    "INVALID_URL",
  );
  check(
    !/^\d+(?:\.\d+){3}$/.test(url.hostname) &&
      !url.hostname.includes(":") &&
      url.hostname.includes(".") &&
      !/(?:^|\.)(?:localhost|local|invalid|test|example)$/.test(url.hostname) &&
      !url.hostname.endsWith(".example.com") &&
      !url.hostname.endsWith(".example.org") &&
      !url.hostname.endsWith(".example.net"),
    "INVALID_URL",
  );
  return input;
}
export function appOrigin(value: unknown): string {
  const url = new URL(publicUrl(value));
  const label = url.hostname.slice(0, -APP_SUFFIX.length);
  check(
    url.hostname.endsWith(APP_SUFFIX) &&
      /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(label) &&
      !label.includes("--") &&
      url.pathname === "/",
    "APP_ORIGIN_REFUSED",
  );
  return url.origin;
}
export function resourceName(runId: string, role: Role): string {
  return role === "app" ? runId : `${runId}-${role}`;
}
export function graphSpec(
  role: Role,
  runId: string,
  fixture: Fixture,
  resources: Partial<Record<Role, Resource>>,
): JsonObject {
  const ref = (key: Role) => {
    const resource = resources[key];
    check(resource, "DEPENDENCY_MISSING");
    return { resourceUid: resource.uid };
  };
  switch (role) {
    case "schema":
      return { artifact: fixture.migrationSet };
    case "bundle":
      return { artifact: fixture.workerBundle };
    case "schema-application":
      return { database: ref("database"), migrationSet: ref("schema") };
    case "delivery":
      return { messageRetentionSeconds: 345600, deliveryDelaySeconds: 0 };
    case "delivery-dlq":
      return { messageRetentionSeconds: 1209600, deliveryDelaySeconds: 0 };
    case "version":
      return {
        worker: ref("app"),
        bundle: ref("bundle"),
        handlers: ["fetch", "queue", "scheduled"],
        vars: {
          YURUCOMMU_RUNTIME_LANE: "portable",
          DELIVERY_QUEUE_NAME: resourceName(runId, "delivery"),
          DELIVERY_DLQ_NAME: resourceName(runId, "delivery-dlq"),
        },
        requiredSensitiveVars: [...PRIVATE_NAMES].sort(),
        sqliteBindings: [{ name: "DB", resource: ref("database") }],
        kvBindings: [{ name: "KV", resource: ref("cache") }],
        bucketBindings: [{ name: "MEDIA", resource: ref("media") }],
        queueProducerBindings: [
          { name: "DELIVERY_DLQ", resource: ref("delivery-dlq") },
          { name: "DELIVERY_QUEUE", resource: ref("delivery") },
        ],
        serviceBindings: [],
        actorBindings: [],
        workflowBindings: [],
      };
    case "deployment":
      return {
        worker: ref("app"),
        versions: [{ workerVersion: ref("version"), weight: 10000 }],
      };
    case "endpoint":
      return { worker: ref("app") };
    case "retention":
      return { worker: ref("app"), cron: "0 * * * *" };
    case "delivery-consumer":
      return {
        queue: ref("delivery"),
        worker: ref("app"),
        maxBatchSize: 10,
        maxBatchTimeoutSeconds: 1,
        maxConcurrency: 4,
        maxRetries: 3,
        retryDelaySeconds: 60,
        deadLetterQueue: ref("delivery-dlq"),
      };
    case "delivery-dlq-consumer":
      return {
        queue: ref("delivery-dlq"),
        worker: ref("app"),
        maxBatchSize: 10,
        maxBatchTimeoutSeconds: 60,
        maxConcurrency: 1,
        maxRetries: 1,
        retryDelaySeconds: 300,
      };
    default:
      return {};
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
