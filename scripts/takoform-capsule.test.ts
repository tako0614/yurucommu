import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

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

  test("owns the complete Provider 3 worker and service graph", () => {
    expect(resourceTypes.sort()).toEqual(
      [
        "takoform_at_least_once_queue",
        "takoform_at_least_once_queue",
        "takoform_edge_kv_namespace",
        "takoform_module_worker",
        "takoform_queue_consumer",
        "takoform_sqlite_database",
        "takoform_sqlite_migration_application",
        "takoform_sqlite_migration_set",
        "takoform_worker_bundle",
        "takoform_worker_cron_trigger",
        "takoform_worker_custom_domain",
        "takoform_worker_deployment",
        "takoform_worker_version",
      ].sort(),
    );
    expect(dataSourceTypes).toEqual([]);
  });

  test("pins the independently published Provider 3 contract exactly", () => {
    expect(main).toContain('version = "= 3.0.0"');
    expect(main).not.toContain('version = ">= 3.0.0"');
  });

  test("uses native Worker fetch, queue, and scheduled handlers", () => {
    for (const handler of ["fetch", "queue", "scheduled"]) {
      expect(main).toContain(`"${handler}"`);
    }
    expect(main).toContain("takoform_queue_consumer");
    expect(main).toContain("takoform_worker_cron_trigger");
    expect(main).not.toContain("background-events");
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

  test("publishes the app-owned custom-domain URL", () => {
    expect(outputs).toContain('output "launch_url"');
    expect(outputs).toContain('output "api_url"');
    expect(outputs).toContain("var.app_url");
    expect(outputs).toContain("takoform_worker_custom_domain");
    expect(outputs).not.toContain("resource_uri");
  });

  test("admits the plan-known custom domain only after a fetch deployment", () => {
    const workerDomain = main.match(
      /resource "takoform_worker_custom_domain" "worker" \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(workerDomain).toBeDefined();
    expect(workerDomain).toContain("hostname = local.app_hostname");
    expect(workerDomain).toMatch(
      /depends_on\s*=\s*\[takoform_worker_deployment\.worker\]/,
    );
    const workerVersion = main.match(
      /resource "takoform_worker_version" "worker" \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(workerVersion).toBeDefined();
    expect(workerVersion).not.toContain("worker_custom_domain");
    expect(main).not.toContain("takoform_worker_endpoint");
  });
});
