import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIGRATION_OUTPUT_RELATIVE_PATH,
  prepareTakoformV1Source,
  WORKER_OUTPUT_RELATIVE_PATH,
} from "./prepare-takoform-v1-source.ts";

function digest(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

describe("Takoform v1 source preparation", () => {
  test("copies the current worktree Worker bytes and verifies every migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "yurucommu-source-test-"));
    const worker =
      "export default { fetch() { return new Response('ok') } };\n";
    const migration = "CREATE TABLE probe (id TEXT PRIMARY KEY);\n";
    await Promise.all([
      mkdir(join(root, "dist"), { recursive: true }),
      mkdir(join(root, "deploy/takoform/migrations"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "dist/yurucommu-worker.js"), worker),
      writeFile(
        join(root, "deploy/takoform/migrations/schema-bundle.json"),
        JSON.stringify({
          apiVersion: "takosumi.resource-migrations/v1",
          engine: "sqlite",
          entries: [
            {
              name: "0001_probe.sql",
              sha256: digest(migration),
              sql: migration,
            },
          ],
        }),
      ),
    ]);

    try {
      const result = await prepareTakoformV1Source({ repositoryRoot: root });
      expect(result).toEqual({
        workerBytes: Buffer.byteLength(worker),
        workerSha256: digest(worker),
        migrationCount: 1,
      });
      expect(
        await readFile(join(root, WORKER_OUTPUT_RELATIVE_PATH), "utf8"),
      ).toBe(worker);
      expect(
        await readFile(
          join(root, MIGRATION_OUTPUT_RELATIVE_PATH, "0001_probe.sql"),
          "utf8",
        ),
      ).toBe(migration);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a migration whose declared digest does not match its SQL", async () => {
    const root = await mkdtemp(join(tmpdir(), "yurucommu-source-test-"));
    await Promise.all([
      mkdir(join(root, "dist"), { recursive: true }),
      mkdir(join(root, "deploy/takoform/migrations"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "dist/yurucommu-worker.js"), "worker"),
      writeFile(
        join(root, "deploy/takoform/migrations/schema-bundle.json"),
        JSON.stringify({
          apiVersion: "takosumi.resource-migrations/v1",
          engine: "sqlite",
          entries: [
            {
              name: "0001_probe.sql",
              sha256:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              sql: "SELECT 1;\n",
            },
          ],
        }),
      ),
    ]);

    try {
      await expect(
        prepareTakoformV1Source({ repositoryRoot: root }),
      ).rejects.toThrow("schema bundle migration digest mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
