import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

import { TAKOFORM_PROVIDER_PIN } from "./takoform-provider-pin.ts";

const moduleUrl = new URL("../deploy/takoform/", import.meta.url);
const [main, outputs] = await Promise.all([
  readFile(new URL("main.tf", moduleUrl), "utf8"),
  readFile(new URL("outputs.tf", moduleUrl), "utf8"),
]);
const packageManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };

const resourceTypes = Array.from(
  main.matchAll(/resource\s+"([^"]+)"\s+"[^"]+"\s*\{/g),
  (match) => match[1],
);
const dataSourceTypes = Array.from(
  main.matchAll(/data\s+"([^"]+)"\s+"[^"]+"\s*\{/g),
  (match) => match[1],
);

describe("portable Takoform v1 Capsule", () => {
  test("validates the Provider 3 module in the portable repository gate", () => {
    expect(packageManifest.scripts?.["check:opentofu"]).toContain(
      "bun scripts/validate-takoform-v1.ts",
    );
  });

  test("owns the complete worker and service graph", () => {
    expect(resourceTypes.sort()).toEqual(
      [
        "takoform_at_least_once_queue",
        "takoform_at_least_once_queue",
        "takoform_edge_kv_namespace",
        "takoform_edge_object_bucket",
        "takoform_module_worker",
        "takoform_queue_consumer",
        "takoform_queue_consumer",
        "takoform_sqlite_database",
        "takoform_sqlite_migration_application",
        "takoform_sqlite_migration_set",
        "takoform_worker_bundle",
        "takoform_worker_cron_trigger",
        "takoform_worker_deployment",
        "takoform_worker_endpoint",
        "takoform_worker_version",
      ].sort(),
    );
    expect(dataSourceTypes).toEqual([]);
  });

  // One declared pin, checked here and in the install-UX gate. Moving it is
  // that constant plus the module's own line.
  test("pins the independently published Provider contract exactly", () => {
    const providerBlock = main.match(/takoform\s*=\s*\{([\s\S]*?)\n\s*\}/)?.[1];
    expect(providerBlock).toBeDefined();
    expect(providerBlock).toContain(
      'source  = "registry.terraform.io/tako0614/takoform"',
    );
    expect(providerBlock).toContain(TAKOFORM_PROVIDER_PIN);
    // Exact, never a range: a Provider that added a resource kind must be
    // adopted deliberately, not picked up by a `tofu init` on some other day.
    expect(providerBlock).toMatch(/version\s*=\s*"= \d+\.\d+\.\d+"\s*$/m);
  });

  test("ships migration inputs in the repository instead of depending on source-build output", async () => {
    expect(main).toContain(
      'migration_root      = "${path.module}/migrations/sql"',
    );
    expect(main).not.toContain(".generated/migrations");

    const migrations = (
      await readdir(new URL("migrations/sql/", moduleUrl))
    ).filter((name) => name.endsWith(".sql"));
    expect(migrations.length).toBeGreaterThan(0);
  });

  test("fences ModuleWorker destruction behind every runtime binding", () => {
    const moduleWorker = main.match(
      /resource "takoform_module_worker" "worker" \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(moduleWorker).toBeDefined();
    const dependencies = moduleWorker
      ?.match(/depends_on\s*=\s*\[([\s\S]*?)\]/)?.[1]
      ?.split(",")
      .map((dependency) => dependency.trim())
      .filter(Boolean);
    expect(dependencies).toEqual([
      "takoform_sqlite_database.database",
      "takoform_edge_kv_namespace.kv",
      "takoform_edge_object_bucket.media",
      "takoform_at_least_once_queue.delivery",
      "takoform_at_least_once_queue.delivery_dlq",
    ]);
  });

  test("uses native Worker fetch, queue, and scheduled handlers", () => {
    for (const handler of ["fetch", "queue", "scheduled"]) {
      expect(main).toContain(`"${handler}"`);
    }
    expect(main).toContain("takoform_queue_consumer");
    expect(main).toContain("takoform_worker_cron_trigger");
    expect(main).not.toContain("background-events");
  });

  // MEDIA used to be a required `com.amazonaws.s3` external service: a standing
  // request to every Host for a standard service no Host is obliged to supply.
  // The graph now owns the bucket, so a Host that implements the module's Forms
  // implements all of it.
  test("owns MEDIA as an ObjectBucket rather than asking a Host for S3", () => {
    expect(main).toMatch(
      /resource "takoform_edge_object_bucket" "media" \{[\s\S]*?name\s*=\s*"\$\{local\.prefix\}-media"[\s\S]*?\n\}/,
    );
    expect(main).toMatch(
      /bucket_bindings\s*=\s*\[[\s\S]*?name\s*=\s*"MEDIA"[\s\S]*?target_name\s*=\s*takoform_edge_object_bucket\.media\.name[\s\S]*?\]/,
    );
    for (const forbidden of [
      "external_services",
      "com.amazonaws.s3",
      "standard_service",
      "StandardService",
      "access_key",
      "endpoint_url",
    ]) {
      expect(main).not.toContain(forbidden);
    }
    expect(outputs).toContain("takoform_edge_object_bucket.media.uid");
  });

  // The lane names the binding shape the Host projects, not the tool that
  // published the Worker, so it cannot be inferred from being a Takoform
  // module. An unknown value is refused by the Worker at startup, which is why
  // the module may only ever emit one of the two the build knows. The portable
  // adapter defaults to the facade lane; raw Cloudflare bindings remain an
  // explicit override for a Takoform Host that projects them.
  test("declares the runtime lane as a validated variable defaulting to portable", () => {
    const laneVariable = main.match(
      /variable "runtime_lane" \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(laneVariable).toBeDefined();
    expect(laneVariable).toMatch(/type\s*=\s*string/);
    expect(laneVariable).toMatch(/default\s*=\s*"portable"/);
    expect(laneVariable).toMatch(
      /condition\s*=\s*contains\(\["cloudflare", "portable"\], var\.runtime_lane\)/,
    );

    expect(main).toMatch(
      /worker_plain_values\s*=\s*\{[\s\S]*?YURUCOMMU_RUNTIME_LANE\s*=\s*var\.runtime_lane/,
    );
    // The retired literal is not a lane this build supports; a deployment that
    // still declared it would refuse to start rather than guess.
    expect(main).not.toContain("takoform-v1");
    expect(main).toContain(
      "vars_json      = jsonencode(local.worker_plain_values)",
    );
  });

  // The engine routes a queue batch by comparing `batch.queue` against these
  // two variables, and its built-in fallbacks are the queue names of an install
  // left at the default `project_name`. Leaving them unset made every renamed
  // install accept delivery messages and drain none of them, which no gate
  // downstream of here would notice.
  test("tells the Worker which queue names carry its own deliveries", () => {
    expect(main).toMatch(
      /worker_plain_values\s*=\s*\{[\s\S]*?DELIVERY_QUEUE_NAME\s*=\s*local\.delivery_queue_name[\s\S]*?DELIVERY_DLQ_NAME\s*=\s*local\.delivery_dlq_name/,
    );
    expect(main).toContain('delivery_queue_name = "${local.prefix}-delivery"');
    expect(main).toContain(
      'delivery_dlq_name   = "${local.prefix}-delivery-dlq"',
    );
    // Named once and reused, so renaming the Capsule cannot separate the queue
    // from the name the Worker is told to expect.
    expect(main).toMatch(
      /resource "takoform_at_least_once_queue" "delivery" \{\s*\n\s*name\s*=\s*local\.delivery_queue_name/,
    );
    expect(main).toMatch(
      /resource "takoform_at_least_once_queue" "delivery_dlq" \{\s*\n\s*name\s*=\s*local\.delivery_dlq_name/,
    );
  });

  // Both queues are consumed by the same Worker. The dead-letter queue is not
  // an archive: its batches are the recovery path for deliveries the main queue
  // gave up on, so a graph that registers only the main consumer drops exactly
  // the messages that already failed once.
  test("registers a consumer for the delivery queue and for its dead-letter queue", () => {
    const consumers = Array.from(
      main.matchAll(
        /resource "takoform_queue_consumer" "([^"]+)" \{([\s\S]*?)\n\}/g,
      ),
      (match) => ({ name: match[1], body: match[2] }),
    );
    expect(consumers.map((consumer) => consumer.name)).toEqual([
      "delivery",
      "delivery_dlq",
    ]);
    const [delivery, dlq] = consumers;
    expect(delivery.body).toMatch(
      /queue\s*=\s*takoform_at_least_once_queue\.delivery\.name/,
    );
    expect(delivery.body).toMatch(
      /dead_letter_queue\s*=\s*takoform_at_least_once_queue\.delivery_dlq\.name/,
    );
    expect(dlq.body).toMatch(
      /queue\s*=\s*takoform_at_least_once_queue\.delivery_dlq\.name/,
    );
    // A dead-letter queue with its own dead-letter queue is a loop, not a
    // safety net.
    expect(dlq.body).not.toContain("dead_letter_queue");
    for (const consumer of consumers) {
      expect(consumer.body).toMatch(
        /worker\s*=\s*takoform_module_worker\.worker\.name/,
      );
      expect(consumer.body).toMatch(
        /depends_on\s*=\s*\[takoform_worker_deployment\.worker\]/,
      );
    }
    expect(outputs).toContain(
      "delivery_dlq_consumer = takoform_queue_consumer.delivery_dlq.uid",
    );
  });

  test("does not route desired state through compatibility or Host materialization", () => {
    expect(main).toContain(
      'source  = "registry.terraform.io/tako0614/takoform"',
    );
    for (const forbidden of [
      "cloudflare/cloudflare",
      'resource "cloudflare_',
      "/compat/cloudflare/",
      "cloudflare_account_id",
      "target_pool",
      "hashicorp/http",
      "takoform_interface",
      "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION",
      "materialized",
      "managed_runtime",
    ]) {
      expect(main).not.toContain(forbidden);
      expect(outputs).not.toContain(forbidden);
    }
  });

  test("publishes ordinary WorkerEndpoint URLs", () => {
    expect(outputs).toContain('output "launch_url"');
    expect(outputs).toContain('output "api_url"');
    expect(outputs).toContain("takoform_worker_endpoint");
    expect(outputs).toContain(".url");
    expect(outputs).not.toContain("resource_uri");
  });

  test("admits the endpoint only after a fetch deployment without feeding its URL back into WorkerVersion", () => {
    const workerEndpoint = main.match(
      /resource "takoform_worker_endpoint" "worker" \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(workerEndpoint).toBeDefined();
    expect(workerEndpoint).toMatch(
      /depends_on\s*=\s*\[takoform_worker_deployment\.worker\]/,
    );
    const workerVersion = main.match(
      /resource "takoform_worker_version" "worker" \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(workerVersion).toBeDefined();
    expect(workerVersion).not.toContain("worker_endpoint");
    expect(workerVersion).not.toContain("APP_URL");
    expect(main).not.toMatch(/APP_URL\s*=\s*.*worker_endpoint/);
  });
});
