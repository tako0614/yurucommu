import { afterEach, expect, test } from "bun:test";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACTOR_CANDIDATE_CORE_SHA256_ENV,
  ACTOR_CANDIDATE_CORE_TARBALL_ENV,
  actorCandidateCorePlugin,
  readActorCandidateCoreInput,
  stageActorCandidateCore,
} from "./actor-candidate-core.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "actor-candidate-core-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createCoreArchive(
  root: string,
  options: { version?: string; symlink?: boolean } = {},
): Promise<string> {
  const packageRoot = join(root, "package");
  await mkdir(join(packageRoot, "src/backend"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@takosjp/yurucommu-core",
      version: options.version ?? "4.1.9",
      exports: { "./server": "./src/backend/public.ts" },
    }),
  );
  await writeFile(
    join(packageRoot, "src/backend/public.ts"),
    'export const bundledCore = "packed-core-4.1.9";\n',
  );
  if (options.symlink) {
    await Bun.spawnSync([
      "ln",
      "-s",
      "../../../../outside",
      join(packageRoot, "src/backend/escape.ts"),
    ]);
  }
  const archive = join(root, "core.tgz");
  const result = Bun.spawnSync(["tar", "-czf", archive, "package"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return archive;
}

test("requires the explicit absolute archive and SHA input", () => {
  expect(() => readActorCandidateCoreInput({})).toThrow(
    ACTOR_CANDIDATE_CORE_TARBALL_ENV,
  );
  expect(() =>
    readActorCandidateCoreInput({
      [ACTOR_CANDIDATE_CORE_TARBALL_ENV]: "/tmp/core.tgz",
    }),
  ).toThrow(ACTOR_CANDIDATE_CORE_SHA256_ENV);
  expect(() =>
    readActorCandidateCoreInput({
      [ACTOR_CANDIDATE_CORE_TARBALL_ENV]: "relative/core.tgz",
      [ACTOR_CANDIDATE_CORE_SHA256_ENV]: "a".repeat(64),
    }),
  ).toThrow("must be absolute");
});

test("rejects a wrong archive digest and package version", async () => {
  const root = await temporaryDirectory();
  const archive = await createCoreArchive(root);
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await expect(
    stageActorCandidateCore({ tarballPath: archive, sha256: "0".repeat(64) }),
  ).rejects.toThrow("SHA-256 mismatch");

  const wrongVersionRoot = await temporaryDirectory();
  const wrongVersionArchive = await createCoreArchive(wrongVersionRoot, {
    version: "4.1.8",
  });
  const wrongVersionDigest = createHash("sha256")
    .update(await readFile(wrongVersionArchive))
    .digest("hex");
  await expect(
    stageActorCandidateCore({
      tarballPath: wrongVersionArchive,
      sha256: wrongVersionDigest,
    }),
  ).rejects.toThrow("must be @takosjp/yurucommu-core 4.1.9");
  expect(digest).toMatch(/^[a-f0-9]{64}$/u);
});

test("rejects archive links before extraction", async () => {
  const root = await temporaryDirectory();
  const archive = await createCoreArchive(root, { symlink: true });
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await expect(
    stageActorCandidateCore({ tarballPath: archive, sha256: digest }),
  ).rejects.toThrow("non-regular entry");
});

test("rejects traversal paths before extraction", async () => {
  const root = await temporaryDirectory();
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@takosjp/yurucommu-core",
      version: "4.1.9",
    }),
  );
  const archive = join(root, "traversal.tgz");
  const result = Bun.spawnSync(
    [
      "tar",
      "--transform=s,^package/package.json$,package/../../escape,",
      "-czf",
      archive,
      "package",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await expect(
    stageActorCandidateCore({ tarballPath: archive, sha256: digest }),
  ).rejects.toThrow("Unsafe candidate Core archive path");
});

test("packed-core resolution wins over an ambient package and rejects fallbacks", async () => {
  const root = await temporaryDirectory();
  const ambient = join(root, "node_modules/@takosjp/yurucommu-core");
  const packed = join(root, "staged/package");
  await mkdir(join(ambient, "src/backend"), { recursive: true });
  await mkdir(join(packed, "src/backend"), { recursive: true });
  await writeFile(
    join(ambient, "src/backend/public.ts"),
    'export const source = "ambient-source-fallback";\n',
  );
  await writeFile(
    join(packed, "src/backend/public.ts"),
    'export const source = "exact-packed-candidate";\n',
  );
  const entry = join(root, "entry.ts");
  const outfile = join(root, "bundle.js");
  await writeFile(
    entry,
    'import { source } from "@takosjp/yurucommu-core/server"; console.log(source);\n',
  );
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    plugins: [actorCandidateCorePlugin(packed)],
  });
  const bundle = await Bun.file(outfile).text();
  expect(bundle).toContain("exact-packed-candidate");
  expect(bundle).not.toContain("ambient-source-fallback");
  const unsupportedEntry = join(root, "unsupported.ts");
  await writeFile(
    unsupportedEntry,
    'import "@takosjp/yurucommu-core/unknown";\n',
  );
  await expect(
    build({
      entryPoints: [unsupportedEntry],
      outfile: join(root, "unsupported.js"),
      bundle: true,
      plugins: [actorCandidateCorePlugin(packed)],
    }),
  ).rejects.toThrow("Unsupported @takosjp/yurucommu-core import");
});
