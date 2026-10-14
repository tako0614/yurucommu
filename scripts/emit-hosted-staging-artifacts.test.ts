// Prepared source tests only. They never run install, compile, native or provider I/O.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOSTED_STAGING_BUILD_COMMANDS,
  HOSTED_STAGING_BUN_VERSION,
  assertHostedStagingOutputParent,
  assertOwnedHostedStagingBuild,
  emitHostedStagingArtifacts,
  hostedStagingManifest,
  parseHostedStagingEmitterInput,
} from "./emit-hosted-staging-artifacts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0).reverse())
    rmSync(root, { recursive: true, force: true });
});
function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "yuru-owning-emitter-guard-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
const selection = () => ({
  commit: "a".repeat(40),
  outputParent: fresh(),
  artifactBaseUrl:
    "https://existing-held-supply.invalid/exact-selected-namespace/",
});
describe("owning emitter selection before side effects", () => {
  test("pins only the existing owning sequence and Bun 1.4.0", () => {
    expect(HOSTED_STAGING_BUN_VERSION).toBe("1.4.0");
    expect(HOSTED_STAGING_BUILD_COMMANDS).toEqual([
      ["install", "--frozen-lockfile"],
      ["run", "build:worker"],
      ["scripts/prepare-takoform-v1-source.ts"],
    ]);
    expect(Object.isFrozen(HOSTED_STAGING_BUILD_COMMANDS)).toBe(true);
    expect(HOSTED_STAGING_BUILD_COMMANDS.every(Object.isFrozen)).toBe(true);
  });
  test("no arbitrary bytes, repository, runner, commands or assertion callback", () => {
    const value = selection();
    expect(parseHostedStagingEmitterInput(value)).toEqual(value);
    for (const entry of [
      { bytes: new Uint8Array([1]) },
      { sourceRoot: "/some/other/repository" },
      { run: () => ({ exitCode: 0 }) },
      { commands: [["printf", "fake"]] },
      { assertBuiltFromSource: async () => {} },
    ])
      expect(() =>
        parseHostedStagingEmitterInput({ ...value, ...entry }),
      ).toThrow("INVALID_INPUT");
    expect(readdirSync(value.outputParent)).toEqual([]);
  });
  test("refuses getter-based selection without invoking it", () => {
    const value = selection();
    let invoked = false;
    Object.defineProperty(value, "commit", {
      enumerable: true,
      get() {
        invoked = true;
        return "a".repeat(40);
      },
    });
    expect(() => parseHostedStagingEmitterInput(value)).toThrow(
      "INVALID_INPUT",
    );
    expect(invoked).toBe(false);
  });
  test("invalid selection rejects before any fresh checkout or output directory", async () => {
    const value = selection();
    await expect(
      emitHostedStagingArtifacts({ ...value, commit: "HEAD" }),
    ).rejects.toThrow("INVALID_INPUT");
    expect(readdirSync(value.outputParent)).toEqual([]);
  });
  test("rejects credential/query/fragment/noncanonical URL namespaces", () => {
    const value = selection();
    for (const url of [
      "http://held.invalid/",
      "https://token@held.invalid/",
      "https://held.invalid/?token=canary",
      "https://held.invalid/#x",
      "https://held.invalid/no-trailing-slash",
    ])
      expect(() =>
        parseHostedStagingEmitterInput({ ...value, artifactBaseUrl: url }),
      ).toThrow("INVALID_ARTIFACT_NAMESPACE");
  });
  test("JSON and structural fixture objects cannot reconstruct source authority", () => {
    const fake = {
      appRepository: "/temporary/fake",
      appCommit: "a".repeat(40),
      output: {
        root: "/temporary/fake",
        digest: "sha256:" + "b".repeat(64),
        files: 38,
        bytes: 1,
        assertUnchanged() {},
      },
      inventory: [],
      async assertBuiltFromSource() {},
    };
    expect(() => assertOwnedHostedStagingBuild(fake)).toThrow(
      "OWNING_BUILD_WITNESS_REQUIRED",
    );
    expect(() =>
      assertOwnedHostedStagingBuild(JSON.parse(JSON.stringify(fake))),
    ).toThrow("OWNING_BUILD_WITNESS_REQUIRED");
    expect(() => assertOwnedHostedStagingBuild(null)).toThrow(
      "OWNING_BUILD_WITNESS_REQUIRED",
    );
  });
});
describe("operator-private external output guard", () => {
  test("accepts private external directory without writing", () => {
    const parent = fresh();
    expect(assertHostedStagingOutputParent(parent)).toBe(parent);
    expect(readdirSync(parent)).toEqual([]);
  });
  for (const marker of ["directory", "linked-file", "bare"] as const)
    test(`rejects ${marker} repository before output writes`, async () => {
      const root = fresh();
      if (marker === "directory") mkdirSync(join(root, ".git"));
      if (marker === "linked-file")
        writeFileSync(join(root, ".git"), "gitdir: /not-followed\n");
      if (marker === "bare") {
        writeFileSync(join(root, "HEAD"), "ref: refs/heads/main\n");
        mkdirSync(join(root, "objects"));
        mkdirSync(join(root, "refs"));
      }
      const parent = join(root, "evidence");
      mkdirSync(parent, { mode: 0o700 });
      expect(() => assertHostedStagingOutputParent(parent)).toThrow(
        "OUTPUT_PARENT_IN_GIT",
      );
      await expect(
        emitHostedStagingArtifacts({ ...selection(), outputParent: parent }),
      ).rejects.toThrow("OUTPUT_PARENT_IN_GIT");
      expect(readdirSync(parent)).toEqual([]);
    });
  test("rejects symlink ancestors and non-private parents", () => {
    const root = fresh();
    const actual = fresh();
    const leaf = join(actual, "evidence");
    mkdirSync(leaf, { mode: 0o700 });
    symlinkSync(actual, join(root, "alias"), "dir");
    expect(() =>
      assertHostedStagingOutputParent(join(root, "alias", "evidence")),
    ).toThrow("OUTPUT_PARENT_SYMLINK_REFUSED");
    chmodSync(leaf, 0o755);
    expect(() => assertHostedStagingOutputParent(leaf)).toThrow(
      "OUTPUT_PARENT_REFUSED",
    );
    expect(lstatSync(leaf).isDirectory()).toBe(true);
  });
});
describe("deterministic artifact manifests have no build authority", () => {
  const module = {
    path: "yurucommu-worker.js",
    url: "https://existing-held-supply.invalid/namespace/worker/a/yurucommu-worker.js",
    sha256: "a".repeat(64),
    mediaType: "application/javascript+module" as const,
  };
  const migrations = [
    {
      path: "0001_first.sql",
      url: "https://existing-held-supply.invalid/namespace/sqlite/first.sql",
      sha256: "b".repeat(64),
      mediaType: "application/sql" as const,
    },
    {
      path: "0002_second.sql",
      url: "https://existing-held-supply.invalid/namespace/sqlite/second.sql",
      sha256: "c".repeat(64),
      mediaType: "application/sql" as const,
    },
  ];
  test("same ordered metadata produces identical canonical bytes", () => {
    const first = hostedStagingManifest("WorkerBundle", [module]);
    expect(first).toEqual(hostedStagingManifest("WorkerBundle", [module]));
    expect(new TextDecoder().decode(first)).toBe(
      JSON.stringify({ entrypoint: "yurucommu-worker.js", files: [module] }) +
        "\n",
    );
    expect(
      JSON.parse(
        new TextDecoder().decode(
          hostedStagingManifest("SQLiteMigrationSet", migrations),
        ),
      ),
    ).toEqual({ files: migrations });
    expect(() =>
      assertOwnedHostedStagingBuild({ manifestBytes: first }),
    ).toThrow("OWNING_BUILD_WITNESS_REQUIRED");
  });
  test("rejects hello replacement, duplicate/reordered SQL, and signed references", () => {
    expect(() =>
      hostedStagingManifest("WorkerBundle", [{ ...module, path: "hello.mjs" }]),
    ).toThrow("MANIFEST_REFUSED");
    expect(() =>
      hostedStagingManifest("SQLiteMigrationSet", [...migrations].reverse()),
    ).toThrow("MANIFEST_REFUSED");
    expect(() =>
      hostedStagingManifest("SQLiteMigrationSet", [
        migrations[0]!,
        migrations[0]!,
      ]),
    ).toThrow("MANIFEST_REFUSED");
    expect(() =>
      hostedStagingManifest("WorkerBundle", [
        { ...module, url: module.url + "?secret=canary" },
      ]),
    ).toThrow("MANIFEST_REFUSED");
  });
});
