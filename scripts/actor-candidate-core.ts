import { createHash } from "node:crypto";
import type { Plugin, PluginBuild } from "esbuild";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, resolve } from "node:path";

export const ACTOR_CANDIDATE_CORE_VERSION = "4.1.11";
export const ACTOR_CANDIDATE_CORE_TARBALL_ENV =
  "YURUCOMMU_CORE_CANDIDATE_TARBALL";
export const ACTOR_CANDIDATE_CORE_SHA256_ENV =
  "YURUCOMMU_CORE_CANDIDATE_SHA256";

export type ActorCandidateCoreInput = {
  tarballPath: string;
  sha256: string;
};

export type StagedActorCandidateCore = {
  root: string;
  version: string;
  sha256: string;
  dispose(): Promise<void>;
};

function requiredEnvironmentValue(
  value: string | undefined,
  name: string,
): string {
  if (!value) {
    throw new Error(`${name} is required for the Actor candidate build.`);
  }
  return value;
}

export function readActorCandidateCoreInput(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ActorCandidateCoreInput {
  const tarballPath = requiredEnvironmentValue(
    environment[ACTOR_CANDIDATE_CORE_TARBALL_ENV],
    ACTOR_CANDIDATE_CORE_TARBALL_ENV,
  );
  const sha256 = requiredEnvironmentValue(
    environment[ACTOR_CANDIDATE_CORE_SHA256_ENV],
    ACTOR_CANDIDATE_CORE_SHA256_ENV,
  ).replace(/^sha256:/u, "");
  if (!isAbsolute(tarballPath)) {
    throw new Error(`${ACTOR_CANDIDATE_CORE_TARBALL_ENV} must be absolute.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error(
      `${ACTOR_CANDIDATE_CORE_SHA256_ENV} must be a SHA-256 hex digest.`,
    );
  }
  return { tarballPath, sha256 };
}

async function listAndValidateTarEntries(tarball: string): Promise<void> {
  const result = Bun.spawnSync(["tar", "-tzf", tarball], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not list candidate Core archive: ${result.stderr.toString().trim()}`,
    );
  }
  const names = result.stdout.toString().split("\n").filter(Boolean);
  const verbose = Bun.spawnSync(["tar", "-tvzf", tarball], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (verbose.exitCode !== 0) {
    throw new Error(
      `Could not inspect candidate Core archive: ${verbose.stderr.toString().trim()}`,
    );
  }
  const entries = verbose.stdout.toString().split("\n").filter(Boolean);
  if (names.length === 0 || names.length !== entries.length) {
    throw new Error("Candidate Core archive contains malformed tar entries.");
  }
  const seen = new Set<string>();
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const type = entries[index]?.[0];
    if (type !== "-" && type !== "d") {
      throw new Error(
        `Candidate Core archive contains a non-regular entry: ${name}`,
      );
    }
    if (
      name.includes("\r") ||
      name.includes("\\") ||
      name.startsWith("/") ||
      posix.normalize(name.replace(/\/$/u, "")) !== name.replace(/\/$/u, "") ||
      name.split("/").some((part) => part === ".." || part === ".") ||
      !(name === "package" || name.startsWith("package/"))
    ) {
      throw new Error(`Unsafe candidate Core archive path: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`Candidate Core archive repeats path: ${name}`);
    }
    seen.add(name);
  }
}

export async function stageActorCandidateCore(
  input: ActorCandidateCoreInput,
): Promise<StagedActorCandidateCore> {
  const absoluteTarball = resolve(input.tarballPath);
  const bytes = await readFile(absoluteTarball);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== input.sha256) {
    throw new Error(
      `Candidate Core archive SHA-256 mismatch: expected ${input.sha256}, got ${actualSha256}.`,
    );
  }

  const stagingDirectory = await mkdtemp(
    join(tmpdir(), "yurucommu-actor-candidate-core-"),
  );
  const verifiedTarball = join(stagingDirectory, basename(absoluteTarball));
  const extractDirectory = join(stagingDirectory, "unpacked");
  try {
    await writeFile(verifiedTarball, bytes, { flag: "wx", mode: 0o600 });
    await listAndValidateTarEntries(verifiedTarball);
    await mkdir(extractDirectory);
    const extraction = Bun.spawnSync(
      [
        "tar",
        "--extract",
        "--gzip",
        "--file",
        verifiedTarball,
        "--directory",
        extractDirectory,
        "--no-same-owner",
        "--no-same-permissions",
        "--no-overwrite-dir",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (extraction.exitCode !== 0) {
      throw new Error(
        `Could not stage candidate Core archive: ${extraction.stderr.toString().trim()}`,
      );
    }
    const root = join(extractDirectory, "package");
    const packageStat = await lstat(root);
    if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
      throw new Error("Candidate Core archive did not contain a package root.");
    }
    const packageJson = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (
      packageJson.name !== "@takosjp/yurucommu-core" ||
      packageJson.version !== ACTOR_CANDIDATE_CORE_VERSION
    ) {
      throw new Error(
        `Candidate Core archive must be @takosjp/yurucommu-core ${ACTOR_CANDIDATE_CORE_VERSION}.`,
      );
    }
    const canonicalRoot = await realpath(root);
    return {
      root: canonicalRoot,
      version: packageJson.version,
      sha256: actualSha256,
      async dispose() {
        await rm(stagingDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function actorCandidateCorePlugin(coreRoot: string): Plugin {
  const exports = new Map([
    ["@takosjp/yurucommu-core", "src/backend/public.ts"],
    ["@takosjp/yurucommu-core/server", "src/backend/public.ts"],
  ]);
  return {
    name: "actor-candidate-packed-yurucommu-core",
    setup(build: PluginBuild) {
      build.onResolve(
        { filter: /^@takosjp[/]yurucommu-core([/].*)?$/ },
        ({ path }) => {
          const relative = exports.get(path);
          if (!relative) {
            throw new Error(
              `Unsupported @takosjp/yurucommu-core import in Actor candidate: ${path}`,
            );
          }
          return { path: join(coreRoot, relative) };
        },
      );
    },
  };
}
