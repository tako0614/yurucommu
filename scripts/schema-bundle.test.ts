import { describe, expect, test } from "bun:test";
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
} from "./generate-schema-bundle";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const bundlePath = join(repositoryRoot, BUNDLE_RELATIVE_PATH);
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
      const bytes = await readFile(
        join(provenance.migrationDirectory, entry.name),
      );
      const sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      expect(entry.sql).toBe(sql);
      expect(entry.sha256).toBe(
        "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      );
    }
  });

  test("is reproducible from the installed package without rewriting bytes", async () => {
    expect(await generateSchemaBundle(repositoryRoot)).toBe(bundleText);
    expect(await generateSchemaBundle(repositoryRoot)).toBe(
      await generateSchemaBundle(repositoryRoot),
    );
    expect(await buildSchemaBundle(repositoryRoot)).toEqual(bundle);
  });
});
