import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const moduleUrl = new URL("../deploy/takoform/", import.meta.url);
const [main, outputs] = await Promise.all([
  readFile(new URL("main.tf", moduleUrl), "utf8"),
  readFile(new URL("outputs.tf", moduleUrl), "utf8"),
]);
const migrationManifestUrl = new URL("migrations/manifest.json", moduleUrl);
const migrationManifestText = await readFile(migrationManifestUrl, "utf8");
const migrationManifest = JSON.parse(migrationManifestText) as {
  apiVersion: string;
  source: {
    kind: string;
    package: string;
    version: string;
    integrity: string;
    path: string;
  };
  entries: Array<{ name: string; sha256: string; sizeBytes: number }>;
};

const resourceTypes = Array.from(
  main.matchAll(/resource\s+"([^"]+)"\s+"[^"]+"\s*\{/g),
  (match) => match[1],
);

describe("portable Takoform Capsule", () => {
  test("owns the complete Yurucommu portable resource graph", () => {
    expect(resourceTypes.sort()).toEqual(
      [
        "takoform_http_service",
        "takoform_interface",
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
    expect(main).toContain('name          = "yurucommu.launcher"');
    expect(main).toContain('resource_kind = "HttpService"');
    expect(main).toContain('originInput = "origin"');
    expect(main).toContain('DELIVERY_QUEUE_NAME = "${local.prefix}-delivery"');
    expect(main).toContain(
      'DELIVERY_DLQ_NAME   = "${local.prefix}-delivery-dlq"',
    );
  });

  test("does not route first-party desired state through Cloudflare compatibility", () => {
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
    ]) {
      expect(main).not.toContain(forbidden);
    }
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

  test("pins the immutable app-owned migration bundle selected by the managed path", async () => {
    expect(migrationManifest.apiVersion).toBe(
      "takosumi.resource-migrations/v1",
    );
    expect(migrationManifest.source).toEqual({
      kind: "npm",
      package: "@takosjp/yurucommu-core",
      version: "3.4.1",
      integrity:
        "sha512-2OEiSmPnQuai+viQ9Og/xvqTgk6aITWCk/ZOfxjQkMgep8ejLB4rH9wYIuBjq3JYpqHXr05hSu6RlvnYLSxiZg==",
      path: "migrations",
    });
    expect(
      `sha256:${createHash("sha256").update(migrationManifestText).digest("hex")}`,
    ).toBe(
      "sha256:1d2181e213a086ae9e025d235ff5e267c43ec60cf4fc2f966977a21f2a95ef7b",
    );
    expect(migrationManifest.entries.length).toBe(21);
    for (const entry of migrationManifest.entries) {
      const bytes = await readFile(
        new URL(
          `../../node_modules/@takosjp/yurucommu-core/migrations/${entry.name}`,
          moduleUrl,
        ),
      );
      expect(bytes.byteLength).toBe(entry.sizeBytes);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
        entry.sha256,
      );
    }
  });
});
