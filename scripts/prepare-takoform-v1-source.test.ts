import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIGRATION_OUTPUT_RELATIVE_PATH,
  prepareTakoformV1Source,
  SCHEMA_BUNDLE_RELATIVE_PATH,
  WORKER_OUTPUT_RELATIVE_PATH,
} from "./prepare-takoform-v1-source.ts";

function digest(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

async function preparedFixture(
  work: (root: string, names: string[]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "yurucommu-source-check-"));
  try {
    const schema = await readFile(
      new URL(
        "../deploy/takoform/migrations/schema-bundle.json",
        import.meta.url,
      ),
      "utf8",
    );
    const entries = JSON.parse(schema).entries as { name: string }[];
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "deploy/takoform/migrations"), { recursive: true });
    await writeFile(join(root, SCHEMA_BUNDLE_RELATIVE_PATH), schema);
    await writeFile(join(root, "dist/yurucommu-worker.js"), "old-local-module");
    await prepareTakoformV1Source({ repositoryRoot: root });
    await writeFile(join(root, "dist/yurucommu-worker.js"), "new-local-module");
    await work(
      root,
      entries.map((entry) => entry.name),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function migrationSnapshot(directory: string) {
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return {
    directory: await lstat(directory, { bigint: true }),
    entries: await Promise.all(
      names.map(async (name) => {
        const path = join(directory, name);
        const status = await lstat(path, { bigint: true });
        return {
          name,
          ino: status.ino,
          mode: status.mode,
          mtimeNs: status.mtimeNs,
          ctimeNs: status.ctimeNs,
          bytes: status.isSymbolicLink()
            ? await readlink(path)
            : await readFile(path, "utf8"),
        };
      }),
    ),
  };
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

  test("check mode preserves all 35 SQL bytes and file identities while preparing the untracked module", async () => {
    await preparedFixture(async (root, names) => {
      expect(names).toHaveLength(35);
      const directory = join(root, MIGRATION_OUTPUT_RELATIVE_PATH);
      for (const name of names) await chmod(join(directory, name), 0o444);
      const before = await migrationSnapshot(directory);
      const result = await prepareTakoformV1Source({
        repositoryRoot: root,
        checkMigrations: true,
      });
      const after = await migrationSnapshot(directory);
      // Reads may update atime; no inode, mode, mtime, ctime or contents may change.
      expect(after?.directory.ino).toBe(before?.directory.ino);
      expect(after?.directory.mtimeNs).toBe(before?.directory.mtimeNs);
      expect(after?.directory.ctimeNs).toBe(before?.directory.ctimeNs);
      expect(after?.entries).toEqual(before?.entries);
      expect(result.migrationCount).toBe(35);
      expect(
        await readFile(join(root, WORKER_OUTPUT_RELATIVE_PATH), "utf8"),
      ).toBe("new-local-module");
    });
  });

  for (const fault of [
    "missing",
    "extra",
    "changed",
    "symlink",
    "directory",
  ] as const)
    test(`check mode refuses ${fault} SQL without fixing source or preparing output`, async () => {
      await preparedFixture(async (root, names) => {
        const directory = join(root, MIGRATION_OUTPUT_RELATIVE_PATH);
        const first = join(directory, names[0]!);
        if (fault === "missing") await rm(first);
        if (fault === "extra")
          await writeFile(join(directory, "9999_extra.sql"), "SELECT 1;");
        if (fault === "changed") await writeFile(first, "SELECT 'changed';\n");
        if (fault === "symlink") {
          const other = join(root, "same-sql-outside-output.sql");
          await writeFile(other, await readFile(first));
          await rm(first);
          await symlink(other, first);
        }
        if (fault === "directory") await rm(directory, { recursive: true });
        const before = await migrationSnapshot(directory);
        await expect(
          prepareTakoformV1Source({
            repositoryRoot: root,
            checkMigrations: true,
          }),
        ).rejects.toThrow();
        const after = await migrationSnapshot(directory);
        expect(after?.directory.ino).toBe(before?.directory.ino);
        expect(after?.directory.mtimeNs).toBe(before?.directory.mtimeNs);
        expect(after?.directory.ctimeNs).toBe(before?.directory.ctimeNs);
        expect(after?.entries).toEqual(before?.entries);
        expect(
          await readFile(join(root, WORKER_OUTPUT_RELATIVE_PATH), "utf8"),
        ).toBe("old-local-module");
      });
    });

  test("the explicit writer still replaces drifted SQL and removes unexpected files", async () => {
    await preparedFixture(async (root, names) => {
      const directory = join(root, MIGRATION_OUTPUT_RELATIVE_PATH);
      const original = await readFile(join(directory, names[0]!), "utf8");
      await writeFile(join(directory, names[0]!), "SELECT 'drift';");
      await writeFile(join(directory, "9999_extra.sql"), "SELECT 1;");
      await prepareTakoformV1Source({ repositoryRoot: root });
      expect((await readdir(directory)).sort()).toEqual(names);
      expect(await readFile(join(directory, names[0]!), "utf8")).toBe(original);
      expect(
        await readFile(join(root, WORKER_OUTPUT_RELATIVE_PATH), "utf8"),
      ).toBe("new-local-module");
    });
  });
});
