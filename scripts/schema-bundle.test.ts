import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUNDLE_RELATIVE_PATH,
  CORE_PACKAGE_NAME,
  buildSchemaBundle,
  generateSchemaBundle,
  readSchemaBundleProvenance,
  TAKOFORM_MIGRATION_OVERRIDES,
} from "./generate-schema-bundle";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const bundlePath = join(repositoryRoot, BUNDLE_RELATIVE_PATH);
const moduleMigrationRoot = join(
  repositoryRoot,
  "deploy/takoform/migrations/sql",
);
const bundleText = await readFile(bundlePath, "utf8");
const bundle = JSON.parse(bundleText) as {
  apiVersion: "takosumi.resource-migrations/v1";
  engine: "sqlite";
  entries: Array<{ name: string; sha256: string; sql: string }>;
};

describe("Takosumi relational schema bundle", () => {
  test("uses the exact installed and locked core package provenance", async () => {
    const provenance = await readSchemaBundleProvenance(repositoryRoot);
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
    };

    expect(provenance.packageName).toBe(CORE_PACKAGE_NAME);
    expect(provenance.declaredVersionSpec).toBe(
      packageJson.dependencies[CORE_PACKAGE_NAME],
    );
    expect(provenance.lockedVersionSpec).toBe(provenance.declaredVersionSpec);
    expect(provenance.lockedVersion).toBe(provenance.installedVersion);
    expect(provenance.lockIntegrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/u);

    const lockText = await readFile(join(repositoryRoot, "bun.lock"), "utf8");
    expect(lockText).toContain(
      '"' +
        CORE_PACKAGE_NAME +
        '": ["' +
        CORE_PACKAGE_NAME +
        "@" +
        provenance.lockedVersion +
        '"',
    );
    expect(provenance.migrationDirectory).toBe(
      join(
        repositoryRoot,
        "node_modules",
        ...CORE_PACKAGE_NAME.split("/"),
        "migrations",
      ),
    );
  });

  test("has the closed inline schema-bundle shape", () => {
    expect(Object.keys(bundle).sort()).toEqual([
      "apiVersion",
      "engine",
      "entries",
    ]);
    expect(bundle.apiVersion).toBe("takosumi.resource-migrations/v1");
    expect(bundle.engine).toBe("sqlite");
    expect(bundle.entries.length).toBeGreaterThan(0);
    for (const entry of bundle.entries) {
      expect(Object.keys(entry).sort()).toEqual(["name", "sha256", "sql"]);
      expect(entry.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(entry.sql).toBeString();
    }
    expect(bundleText).not.toContain('"source"');
    expect(bundleText).not.toContain('"package"');
    expect(bundleText).not.toContain('"files"');
    expect(bundleText).not.toContain('"sizeBytes"');
  });

  test("bundles every migration shipped by the locked core 4.1.2 release", async () => {
    const provenance = await readSchemaBundleProvenance(repositoryRoot);
    expect(provenance.lockedVersion).toBe("4.1.2");
    expect(bundle.entries).toHaveLength(28);
    expect(bundle.entries.at(-1)?.name).toBe(
      "0029_delivery_endpoint_recipients.sql",
    );

    const sourceNames = (await readdir(provenance.migrationDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(sourceNames).toHaveLength(28);
    expect(bundle.entries.map((entry) => entry.name)).toEqual(sourceNames);
  });

  test("keeps migration names ascending and unique", async () => {
    const provenance = await readSchemaBundleProvenance(repositoryRoot);
    const sourceNames = (
      await readdir(provenance.migrationDirectory, {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const bundleNames = bundle.entries.map((entry) => entry.name);

    expect(bundleNames).toEqual(sourceNames);
    expect(new Set(bundleNames).size).toBe(bundleNames.length);
    expect(bundleNames).toEqual(
      [...bundleNames].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });

  test("binds each hash to its exact inline SQL bytes", async () => {
    const provenance = await readSchemaBundleProvenance(repositoryRoot);
    for (const entry of bundle.entries) {
      const override =
        TAKOFORM_MIGRATION_OVERRIDES[
          entry.name as keyof typeof TAKOFORM_MIGRATION_OVERRIDES
        ];
      const bytes = await readFile(
        override
          ? join(repositoryRoot, override.relativePath)
          : join(provenance.migrationDirectory, entry.name),
      );
      const sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      expect(entry.sql).toBe(sql);
      expect(entry.sha256).toBe(
        "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      );
    }
  });

  test("ships the exact bundle entries as repository-owned OpenTofu inputs", async () => {
    const moduleNames = (await readdir(moduleMigrationRoot)).sort();
    expect(moduleNames).toEqual(bundle.entries.map((entry) => entry.name));
    for (const entry of bundle.entries) {
      const bytes = await readFile(join(moduleMigrationRoot, entry.name));
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(
        entry.sql,
      );
      expect("sha256:" + createHash("sha256").update(bytes).digest("hex")).toBe(
        entry.sha256,
      );
    }
  });

  test("uses a D1-safe atomic override that preserves existing inbox rows", async () => {
    const migration = bundle.entries.find(
      (entry) => entry.name === "0003_activity_remote_object_edges.sql",
    );
    expect(migration).toBeDefined();
    expect(migration!.sql).not.toMatch(/PRAGMA\s+foreign_keys\s*=/iu);
    expect(migration!.sql).toContain("PRAGMA defer_foreign_keys = TRUE");

    const database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    const provenance = await readSchemaBundleProvenance(repositoryRoot);
    database.exec(
      await readFile(
        join(provenance.migrationDirectory, "0001_init.sql"),
        "utf8",
      ),
    );
    database.exec(
      "INSERT INTO actors (ap_id,type,preferred_username,inbox,outbox,followers_url,following_url,public_key_pem,private_key_pem) VALUES ('actor','Person','actor','i','o','f','g','pk','sk')",
    );
    database.exec(
      "INSERT INTO activities (ap_id,type,actor_ap_id,raw_json) VALUES ('activity','Create','actor','{}')",
    );
    database.exec(
      "INSERT INTO inbox (actor_ap_id,activity_ap_id,read) VALUES ('actor','activity',1)",
    );

    database.transaction(() => database.exec(migration!.sql)).immediate();

    expect(
      database
        .query("SELECT actor_ap_id, activity_ap_id, read FROM inbox")
        .all(),
    ).toEqual([{ actor_ap_id: "actor", activity_ap_id: "activity", read: 1 }]);
    expect(
      String(
        (
          database
            .query("SELECT sql FROM sqlite_master WHERE name = 'activities'")
            .get() as { readonly sql: string }
        ).sql,
      ),
    ).not.toContain("REFERENCES");
  });

  test("is reproducible from the locked package and explicit overrides", async () => {
    expect(await generateSchemaBundle(repositoryRoot)).toBe(bundleText);
    expect(await generateSchemaBundle(repositoryRoot)).toBe(
      await generateSchemaBundle(repositoryRoot),
    );
    expect(await buildSchemaBundle(repositoryRoot)).toEqual(bundle);
  });
});
