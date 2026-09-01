import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

const moduleUrl = new URL("../deploy/takoform/", import.meta.url);
const [main, outputs] = await Promise.all([
  readFile(new URL("main.tf", moduleUrl), "utf8"),
  readFile(new URL("outputs.tf", moduleUrl), "utf8"),
]);

const resourceTypes = Array.from(
  main.matchAll(/resource\s+"([^"]+)"\s+"[^"]+"\s*\{/g),
  (match) => match[1],
);
const dataSourceTypes = Array.from(
  main.matchAll(/data\s+"([^"]+)"\s+"[^"]+"\s*\{/g),
  (match) => match[1],
);

describe("portable Takoform Capsule", () => {
  test("owns the complete current Provider 3 worker and service graph", () => {
    expect(resourceTypes.sort()).toEqual(
      [
        "takoform_at_least_once_queue",
        "takoform_at_least_once_queue",
        "takoform_edge_kv_namespace",
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
    expect(main).toContain('handlers       = ["fetch", "queue", "scheduled"]');
    expect(main).toContain('name     = "MEDIA"');
    expect(main).toContain('protocol = "com.amazonaws.s3"');
    expect(main).toContain("required = true");
    expect(main).toContain('variable "app_url"');
    expect(main).toContain("APP_URL");
  });

  test("pins the independently published Provider 3 contract exactly", () => {
    expect(main).toContain(
      'source  = "registry.terraform.io/tako0614/takoform"',
    );
    expect(main).toContain('version = "= 3.0.0"');
    expect(main).not.toContain('version = "= 1.0.3"');
  });

  test("ships migration inputs in the repository", async () => {
    expect(main).toContain(
      'migration_root            = "${path.module}/migrations/sql"',
    );
    expect(main).not.toContain(".generated/migrations");
    const migrations = (
      await readdir(new URL("migrations/sql/", moduleUrl))
    ).filter((name) => name.endsWith(".sql"));
    expect(migrations.length).toBeGreaterThan(0);
  });

  test("uses native Worker handlers and exact current resource kinds", () => {
    for (const handler of ["fetch", "queue", "scheduled"]) {
      expect(main).toContain(`"${handler}"`);
    }
    expect(main).toContain("takoform_queue_consumer");
    expect(main).toContain("takoform_worker_cron_trigger");
    expect(main).not.toContain("background-events");
    for (const retired of [
      'resource "takoform_edge_worker"',
      'resource "takoform_relational_database"',
      'resource "takoform_object_bucket"',
      'resource "takoform_key_value_store"',
      'resource "takoform_queue"',
      'resource "takoform_schedule"',
      'data "takoform_interface"',
    ]) {
      expect(main).not.toContain(retired);
    }
  });

  test("requests MEDIA as one sealed standard S3 service", () => {
    expect(main).toMatch(
      /external_services\s*=\s*\[[\s\S]*name\s*=\s*"MEDIA"[\s\S]*protocol\s*=\s*"com\.amazonaws\.s3"[\s\S]*required\s*=\s*true[\s\S]*\]/,
    );
    for (const forbidden of [
      "takoform_object_bucket",
      "bucket_bindings",
      "edge.objects",
      "ObjectBucket",
    ]) {
      expect(main).not.toContain(forbidden);
    }
  });

  test("keeps the two queue consumers, migration application, cron, and endpoint", () => {
    expect(
      (main.match(/resource\s+"takoform_queue_consumer"/g) ?? []).length,
    ).toBe(2);
    expect(main).toContain('resource "takoform_sqlite_migration_application"');
    expect(main).toContain('resource "takoform_worker_cron_trigger"');
    expect(main).toContain('resource "takoform_worker_endpoint"');
    expect(main).toContain("depends_on = [takoform_worker_deployment.worker]");
  });

  test("does not route desired state through compatibility or Host materialization", () => {
    for (const forbidden of [
      "cloudflare/cloudflare",
      'resource "cloudflare_',
      "/compat/cloudflare/",
      "cloudflare_account_id",
      "target_pool",
      "hashicorp/http",
      "takoform_interface",
      "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION",
      "managed_runtime",
    ]) {
      expect(main).not.toContain(forbidden);
      expect(outputs).not.toContain(forbidden);
    }
  });

  test("publishes ordinary WorkerEndpoint URLs without lifecycle authority", () => {
    expect(outputs).toContain('output "launch_url"');
    expect(outputs).toContain('output "api_url"');
    expect(outputs).toContain("takoform_worker_endpoint");
    expect(outputs).toContain(".url");
    expect(outputs).not.toContain("resource_uri");
    for (const retired of [
      "takosumi_release",
      "app_deployment",
      "service_exports",
      "service_bindings",
    ]) {
      expect(outputs).not.toContain(`output "${retired}"`);
    }
  });

  test("requires a plan-known exact HTTPS app origin", () => {
    const appUrlBlock = main.slice(
      main.indexOf('variable "app_url"'),
      main.indexOf("\nlocals"),
    );
    expect(appUrlBlock).toContain("type        = string");
    expect(appUrlBlock).not.toContain("default");
    expect(appUrlBlock).toContain("trimspace(var.app_url) == var.app_url");
    expect(main).toContain("APP_URL");
  });
});
