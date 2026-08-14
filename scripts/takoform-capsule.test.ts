import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

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
const edgeWorkerConnectionsText = main.match(
  /resource "takoform_edge_worker" "worker" \{[\s\S]*?\n  connections = \[\n([\s\S]*?)\n  \]\n\n  lifecycle \{/,
)?.[1];
const edgeWorkerConnectionNames = edgeWorkerConnectionsText
  ? Array.from(
      edgeWorkerConnectionsText.matchAll(/^\s+name\s+=\s+"([^"]+)"/gm),
      (match) => match[1],
    )
  : [];
const databaseResourceText = main.match(
  /resource "takoform_relational_database" "database" \{([\s\S]*?)\n\}\n\nresource "takoform_object_bucket"/,
)?.[1];
const edgeWorkerResourceText = main.match(
  /resource "takoform_edge_worker" "worker" \{([\s\S]*?)\n\}\n\nresource "takoform_schedule"/,
)?.[1];

describe("portable Takoform Capsule", () => {
  test("owns the complete Yurucommu portable resource graph", () => {
    expect(resourceTypes.sort()).toEqual(
      [
        "takoform_edge_worker",
        "takoform_key_value_store",
        "takoform_object_bucket",
        "takoform_queue",
        "takoform_queue",
        "takoform_relational_database",
        "takoform_schedule",
      ].sort(),
    );
    for (const binding of [
      "DB",
      "MEDIA",
      "KV",
      "DELIVERY_QUEUE",
      "DELIVERY_DLQ",
    ]) {
      expect(main).toContain(`name        = "${binding}"`);
    }
    expect(main).toContain('permissions = ["consume", "publish"]');
    expect(main).toContain('projection  = "schedule.trigger.v1"');
    expect(dataSourceTypes).toEqual(["takoform_interface"]);
    expect(main).toContain('name          = "http.request"');
    expect(main).toContain('resource_kind = "EdgeWorker"');
    expect(outputs).toContain("resource_uri");
    expect(main).toContain('DELIVERY_QUEUE_NAME = "${local.prefix}-delivery"');
    expect(main).toContain(
      'DELIVERY_DLQ_NAME   = "${local.prefix}-delivery-dlq"',
    );
  });

  test("keeps EdgeWorker connections in canonical order without duplicates", () => {
    expect(edgeWorkerConnectionNames).toEqual([
      "DB",
      "DELIVERY_DLQ",
      "DELIVERY_QUEUE",
      "KV",
      "MEDIA",
    ]);
    expect(new Set(edgeWorkerConnectionNames).size).toBe(
      edgeWorkerConnectionNames.length,
    );
  });

  test("does not route first-party desired state through Cloudflare compatibility", () => {
    expect(main).toContain(
      'source  = "registry.opentofu.org/tako0614/takoform"',
    );
    for (const forbidden of [
      "cloudflare/cloudflare",
      'resource "cloudflare_',
      "/compat/cloudflare/",
      "cloudflare_account_id",
      "target_pool",
      "hashicorp/http",
    ]) {
      expect(main).not.toContain(forbidden);
    }
  });

  test("declares the immutable schema bundle on the database resource", () => {
    expect(main).toContain('version = "= 1.0.4"');
    expect(main).toContain(
      'schema_url      = "https://raw.githubusercontent.com/tako0614/yurucommu/bf7a3bdb55d9bd562ac895ada10ac42ce09a11b9/deploy/takoform/migrations/schema-bundle.json"',
    );
    expect(main).toContain(
      'schema_sha256   = "f14135367b4b00a520f0ef8abc41f67d53c6abb9ef8577d946fb199987f5abaa"',
    );
    expect(main).toContain('schema_format   = "takosumi.resource-migrations"');
    expect(main).toContain('form_transition = "relational-database-v2-to-v3"');
    expect(main.match(/form_transition\s*=\s*"[^"]+"/g) ?? []).toHaveLength(1);
    expect(databaseResourceText).toContain(
      'form_transition = "relational-database-v2-to-v3"',
    );
    expect(edgeWorkerResourceText).toBeDefined();
    expect(edgeWorkerResourceText).not.toContain("form_transition");
    expect(edgeWorkerResourceText).not.toContain("assets_path");
    expect(edgeWorkerResourceText).not.toContain("assets_not_found_handling");
    expect(main).not.toContain("resource_migration");
    expect(main).not.toContain("manifest.json");
  });

  test("publishes ordinary runtime outputs without lifecycle authority", () => {
    expect(outputs).toContain('output "launch_url"');
    expect(outputs).toContain('output "api_url"');
    for (const retired of [
      "takosumi_release",
      "app_deployment",
      "service_exports",
      "service_bindings",
    ]) {
      expect(outputs).not.toContain(`output "${retired}"`);
    }
    expect(outputs).not.toMatch(/cloudflare|database_id|account_id|sql/i);
  });
});
