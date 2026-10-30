import { afterAll, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBundledD1Migrations } from "./bundled-d1-migrations.ts";
import {
  WORKER_OUTPUT_RELATIVE_PATH,
  prepareCloudflareSource,
} from "./prepare-cloudflare-source.ts";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(worker: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yurucommu-cloudflare-source-"));
  roots.push(root);
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "deploy/takoform/migrations"), { recursive: true });
  await copyFile(
    new URL(
      "../deploy/takoform/migrations/schema-bundle.json",
      import.meta.url,
    ),
    join(root, "deploy/takoform/migrations/schema-bundle.json"),
  );
  await writeFile(join(root, "dist/yurucommu-worker.js"), worker);
  return root;
}

test("stages a Worker that embeds every bundled migration", async () => {
  const migrations = await readBundledD1Migrations();
  const worker =
    "const flag = 'YURUCOMMU_APPLY_BUNDLED_MIGRATIONS';\n" +
    `const m = ${JSON.stringify(migrations)};\n`;
  const root = await fixtureRoot(worker);
  const result = await prepareCloudflareSource({ repositoryRoot: root });
  expect(result.migrationCount).toBe(migrations.length);
  expect(await readFile(join(root, WORKER_OUTPUT_RELATIVE_PATH), "utf8")).toBe(
    worker,
  );
});

test("refuses a Worker that would leave the D1 database without a schema", async () => {
  const migrations = await readBundledD1Migrations();
  const withoutLast = await fixtureRoot(
    "const flag = 'YURUCOMMU_APPLY_BUNDLED_MIGRATIONS';\n" +
      `const m = ${JSON.stringify(migrations.slice(0, -1))};\n`,
  );
  await expect(
    prepareCloudflareSource({ repositoryRoot: withoutLast }),
  ).rejects.toThrow(migrations.at(-1)!.name);

  const withoutGate = await fixtureRoot(
    `const m = ${JSON.stringify(migrations)};\n`,
  );
  await expect(
    prepareCloudflareSource({ repositoryRoot: withoutGate }),
  ).rejects.toThrow(/schema gate/);
});
