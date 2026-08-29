import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const [
  packageSource,
  moduleSource,
  takoformModuleSource,
  repositorySource,
  releaseLockSource,
  siteSource,
  ciSource,
  changelogSource,
] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
  readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
  readFile(new URL("../.well-known/takosumi.json", import.meta.url), "utf8"),
  readFile(new URL("../release.lock.json", import.meta.url), "utf8"),
  readFile(new URL("../site/index.html", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
]);

const packageJson = JSON.parse(packageSource) as {
  version: string;
  scripts: Record<string, string>;
};
const packageVersion = packageJson.version;
const packageTag = `v${packageVersion}`;
const repositoryManifest = JSON.parse(repositorySource) as {
  apiVersion: string;
  kind: string;
  install: {
    modules: Record<
      string,
      {
        inputs?: Array<{ name: string; source?: { kind?: string } }>;
        sourceBuild?: {
          commands?: Array<{ argv: string[] }>;
          outputs?: string[];
        };
      }
    >;
  };
};
const releaseLock = JSON.parse(releaseLockSource) as {
  releases: Record<
    string,
    {
      artifact: { filename: string; url: string; sha256: string };
      manifest: { url: string; sha256: string };
      commit: string;
      seededFrom: string;
    }
  >;
};

function deploymentDefault(
  source: string,
  variable: string,
): string | undefined {
  return source
    .match(
      new RegExp(`variable\\s+"${variable}"\\s*\\{([\\s\\S]*?)\\n\\}`, "u"),
    )?.[1]
    ?.match(/default\s+=\s+"([^"]*)"/u)?.[1];
}

const fakeCommit = "1111111111111111111111111111111111111111";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

type ReleaseScenario = {
  immutableSettings: string;
  readback: string;
  createFails?: boolean;
  manifestMutator?: (source: string) => string;
};

async function createReleaseHarness(scenario: ReleaseScenario) {
  const root = await mkdtemp(join(process.cwd(), ".yurucommu-release-guard-"));
  const fakeBin = join(root, "bin");
  const scripts = join(root, "scripts");
  const takoform = join(root, "deploy", "takoform");
  const wellKnown = join(root, ".well-known");
  const dist = join(root, "dist");
  const temp = join(root, "tmp");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(scripts, { recursive: true });
  await mkdir(takoform, { recursive: true });
  await mkdir(wellKnown, { recursive: true });
  await mkdir(dist, { recursive: true });
  await mkdir(temp, { recursive: true });

  const artifact = Buffer.from("test release worker artifact\n");
  const artifactDigest = sha256(artifact);
  const tag = `v${packageVersion}`;
  const artifactUrl = `https://github.com/tako0614/yurucommu/releases/download/${tag}/yurucommu-worker.js`;
  const manifestUrl = `https://github.com/tako0614/yurucommu/releases/download/${tag}/takosumi-artifact.json`;
  const manifest = {
    kind: "takosumi.worker-artifact@v1",
    app: "yurucommu",
    commit: fakeCommit,
    ref: tag,
    releaseTag: tag,
    artifact: {
      filename: "yurucommu-worker.js",
      url: artifactUrl,
      sha256: artifactDigest,
      sha256Prefixed: `sha256:${artifactDigest}`,
      contentType: "application/javascript",
    },
    manifestUrl,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const checksumText = `${artifactDigest}  yurucommu-worker.js\n`;
  const artifactPath = join(dist, "yurucommu-worker.js");
  const manifestPath = join(root, "takosumi-artifact.json");
  const checksumPath = join(root, "yurucommu-worker.js.sha256");
  const ghLogPath = join(root, "gh.log");
  const tagStatePath = join(root, "tag-created");

  const [
    deploySource,
    packageText,
    repositoryText,
    rootModule,
    takoformModule,
  ] = await Promise.all([
    readFile(new URL("./deploy.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.well-known/takosumi.json", import.meta.url), "utf8"),
    readFile(new URL("../main.tf", import.meta.url), "utf8"),
    readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
  ]);
  const replaceDigest = (source: string) =>
    source.replace(
      /(variable\s+"worker_bundle_sha256"[\s\S]*?default\s+=\s+")sha256:[^"]+/u,
      `$1sha256:${artifactDigest}`,
    );
  await Promise.all([
    writeFile(join(scripts, "deploy.mjs"), deploySource),
    writeFile(join(root, "package.json"), packageText),
    writeFile(
      join(wellKnown, "takosumi.json"),
      scenario.manifestMutator?.(repositoryText) ?? repositoryText,
    ),
    writeFile(join(root, "main.tf"), replaceDigest(rootModule)),
    writeFile(join(takoform, "main.tf"), replaceDigest(takoformModule)),
    writeFile(artifactPath, artifact),
    writeFile(manifestPath, manifestText),
    writeFile(checksumPath, checksumText),
    writeFile(ghLogPath, ""),
    writeFile(tagStatePath, ""),
  ]);

  await writeFile(
    join(fakeBin, "git"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
case "$*" in
  "status --porcelain") exit 0 ;;
  "rev-parse --abbrev-ref HEAD") printf 'main\\n' ;;
  "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") printf 'origin/main\\n' ;;
  "rev-parse HEAD"|"rev-parse origin/main") printf '%s\\n' '${fakeCommit}' ;;
  "tag --list"*) exit 0 ;;
  "ls-remote --tags"*)
    if [ -s "$FAKE_TAG_STATE" ]; then printf '%s\\trefs/tags/${tag}\\n' '${fakeCommit}'; fi
    exit 0
    ;;
  "fetch"*) exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  await writeFile(
    join(fakeBin, "bun"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_BUN_LOG"
exit 0
`,
  );
  await writeFile(
    join(fakeBin, "gh"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "repos/tako0614/yurucommu/immutable-releases" ]; then
  printf '%s' "$FAKE_GH_IMMUTABLE_SETTINGS"
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  case " $* " in
    *" --json "*) printf '%s' "$FAKE_GH_READBACK"; exit 0 ;;
    *) printf '%s\\n' 'release not found' >&2; exit 1 ;;
  esac
fi
if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  if [ "\${FAKE_GH_CREATE_FAIL:-0}" = "1" ]; then
    printf '%s\\n' 'simulated release create lost acknowledgement' >&2
    exit 1
  fi
  printf '%s\\n' 'created'
  printf '%s' 'created' > "$FAKE_TAG_STATE"
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  directory=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--dir" ]; then directory="$argument"; fi
    previous="$argument"
  done
  mkdir -p "$directory"
  cp "$FAKE_ARTIFACT_PATH" "$directory/yurucommu-worker.js"
  cp "$FAKE_MANIFEST_PATH" "$directory/takosumi-artifact.json"
  cp "$FAKE_CHECKSUM_PATH" "$directory/yurucommu-worker.js.sha256"
  exit 0
fi
printf '%s\\n' "unexpected gh command: $*" >&2
exit 1
`,
  );
  await Promise.all(
    ["git", "bun", "gh"].map((name) => chmod(join(fakeBin, name), 0o755)),
  );

  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    TMPDIR: temp,
    FAKE_GIT_LOG: ghLogPath,
    FAKE_BUN_LOG: ghLogPath,
    FAKE_GH_LOG: ghLogPath,
    FAKE_GH_IMMUTABLE_SETTINGS: scenario.immutableSettings,
    FAKE_GH_READBACK: scenario.readback,
    FAKE_GH_CREATE_FAIL: scenario.createFails ? "1" : "0",
    FAKE_TAG_STATE: tagStatePath,
    FAKE_ARTIFACT_PATH: artifactPath,
    FAKE_MANIFEST_PATH: manifestPath,
    FAKE_CHECKSUM_PATH: checksumPath,
  };
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(scripts, "deploy.mjs"),
      "yurucommu-worker-release",
      "--execute",
    ],
    { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" },
  );
  const output = {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    ghLog: await readFile(ghLogPath, "utf8"),
  };
  await rm(root, { recursive: true, force: true });
  return output;
}

describe("release version", () => {
  test("records v2.1.9 while retaining the authoritative v2.1.8 rollback pin", () => {
    expect(packageVersion).toBe("2.1.9");
    expect(changelogSource).toContain("## 2.1.9 - 2026-08-29");
    expect(changelogSource).toContain("## 2.1.8 - 2026-08-25");
    expect(changelogSource).not.toContain("## 2.1.8 - Unreleased");
    expect(releaseLock.releases["v2.1.7"]).toEqual({
      artifact: {
        filename: "yurucommu-worker.js",
        url: "https://github.com/tako0614/yurucommu/releases/download/v2.1.7/yurucommu-worker.js",
        sha256:
          "sha256:303704a5cee9d4c8705787c44dec3b54042f5b6624a0bb615342c57c36c77d37",
      },
      manifest: {
        url: "https://github.com/tako0614/yurucommu/releases/download/v2.1.7/takosumi-artifact.json",
        sha256:
          "sha256:4349048af67bdcb3d0492042f22119dff629e08f874f1e6298a3d0a58ca94467",
      },
      commit: "421417c7f32cf31b58b71dc5413ddaa7ef7df4cc",
      seededFrom:
        "owner deploy exact immutable GitHub Release/tag/downloaded asset readback on 2026-08-25",
    });
    expect(releaseLock.releases["v2.1.8"]).toEqual({
      artifact: {
        filename: "yurucommu-worker.js",
        url: "https://github.com/tako0614/yurucommu/releases/download/v2.1.8/yurucommu-worker.js",
        sha256:
          "sha256:303704a5cee9d4c8705787c44dec3b54042f5b6624a0bb615342c57c36c77d37",
      },
      manifest: {
        url: "https://github.com/tako0614/yurucommu/releases/download/v2.1.8/takosumi-artifact.json",
        sha256:
          "sha256:abba56714934fb23cd1b9017718118644380bc2e0c02a32ac9fd25810a433764",
      },
      commit: "c2f6e50747f8bc2a3c4e80305c04b78aea1b505b",
      seededFrom:
        "owner deploy exact immutable GitHub Release/tag/downloaded asset and checksum readback on 2026-08-25",
    });
    expect(releaseLock.releases["v2.1.9"]).toEqual({
      artifact: {
        filename: "yurucommu-worker.js",
        url: "https://github.com/tako0614/yurucommu/releases/download/v2.1.9/yurucommu-worker.js",
        sha256:
          "sha256:bb8d110be44c8d89fae28375ab32ec19833df18e3824fcc505c8b0d2615acb3f",
      },
      manifest: {
        url: "https://github.com/tako0614/yurucommu/releases/download/v2.1.9/takosumi-artifact.json",
        sha256:
          "sha256:cfb97ce40341d0f89a97d1b0231821f291b27b6991748fce9308a0d3b00d655c",
      },
      commit: "a09496f214a8579593b5b99b570fd3ed1d1cdb01",
      seededFrom:
        "owner deploy exact immutable GitHub Release/tag/downloaded asset and checksum readback on 2026-08-29",
    });
  });

  test("CI validates the published Provider without building or injecting a stale candidate", () => {
    expect(ciSource).not.toContain("actions/setup-go@");
    expect(ciSource).not.toContain("TAKOFORM_SOURCE_COMMIT");
    expect(ciSource).not.toContain("TAKOFORM_PROVIDER_BINARY");
    expect(ciSource).not.toContain("TAKOFORM_PROVIDER_SHA256");
    expect(ciSource).not.toContain("c08651d9b39d1be34e4b803c3d32fdca82e3653e");
    expect(ciSource).toContain("- run: bun run check");
  });

  test("binds the repository manifest module and asset pins to one package release", () => {
    const artifactUrl = `https://github.com/tako0614/yurucommu/releases/download/${packageTag}/yurucommu-worker.js`;
    expect(repositoryManifest.apiVersion).toBe("takosumi.com/v2.4");
    expect(repositoryManifest.kind).toBe("Repository");
    const rootModule = repositoryManifest.install.modules["."];
    const managedModule = repositoryManifest.install.modules["deploy/takoform"];
    const pinInputs = new Map(
      rootModule?.inputs?.map((input) => [input.name, input]) ?? [],
    );
    for (const name of [
      "worker_release_tag",
      "worker_bundle_url",
      "worker_bundle_sha256",
    ]) {
      expect(pinInputs.get(name)?.source?.kind).toBe("module_default");
    }
    expect(managedModule?.sourceBuild?.commands).toEqual([
      { argv: ["bun", "install", "--frozen-lockfile"] },
      { argv: ["bun", "run", "build:worker"] },
      { argv: ["bun", "scripts/prepare-takoform-v1-source.ts"] },
    ]);
    expect(managedModule?.sourceBuild?.outputs).toEqual([
      "deploy/takoform/.generated/yurucommu-worker.js",
      "deploy/takoform/migrations/sql",
    ]);
    expect(deploymentDefault(moduleSource, "worker_release_tag")).toBe(
      packageTag,
    );
    expect(deploymentDefault(moduleSource, "worker_bundle_url")).toBe(
      artifactUrl,
    );
    expect(deploymentDefault(moduleSource, "worker_bundle_sha256")).toBe(
      "sha256:bb8d110be44c8d89fae28375ab32ec19833df18e3824fcc505c8b0d2615acb3f",
    );
    expect(takoformModuleSource).not.toContain('variable "worker_release_tag"');
    expect(takoformModuleSource).not.toContain('variable "worker_bundle_url"');
    expect(takoformModuleSource).toContain(
      'worker_bundle_path = "${path.module}/.generated/yurucommu-worker.js"',
    );
  });

  test("keeps every published release lock entry internally consistent", () => {
    for (const [tag, pin] of Object.entries(releaseLock.releases)) {
      expect(pin.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(pin.artifact.url).toBe(
        `https://github.com/tako0614/yurucommu/releases/download/${tag}/yurucommu-worker.js`,
      );
      expect(pin.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(pin.manifest.url).toBe(
        `https://github.com/tako0614/yurucommu/releases/download/${tag}/takosumi-artifact.json`,
      );
      expect(pin.manifest.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
  });

  test("matches the Git tag when the release workflow runs", () => {
    const gitRef = process.env.GITHUB_REF_NAME;
    if (!gitRef?.startsWith("v")) return;

    expect(gitRef).toBe(packageTag);
  });
});

describe("release surface status", () => {
  test("declares create-only publication for the managed Worker artifact", () => {
    const result = Bun.spawnSync(["bun", "scripts/deploy.mjs", "--contract"], {
      cwd: new URL("../", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const contract = JSON.parse(result.stdout.toString()) as {
      surfaces: Array<{
        surface: string;
        triggers: string[];
        covers: string[];
        requiresScripts: string[];
        obligations: Record<string, string>;
      }>;
    };
    const release = contract.surfaces.find(
      (surface) => surface.surface === "yurucommu-worker-release",
    );

    expect(release?.triggers).toEqual(["published-identity"]);
    expect(release?.obligations["no-overwrite"]).toContain("create-only");
    expect(release?.covers).toEqual(
      expect.arrayContaining([
        "bun.lock",
        ".well-known/takosumi.json",
        "main.tf",
        "deploy/takoform/main.tf",
      ]),
    );
    expect(release?.obligations.provenance).toContain("unpushed");
    expect(release?.obligations.provenance).toContain(
      "repository manifest's default deploy/takoform module",
    );
    expect(release?.obligations.provenance).toContain("sourceBuild");
    expect(release?.requiresScripts).toContain("smoke:release-artifact");
    expect(release?.obligations["post-conditions"]).toContain(
      "downloaded Worker in workerd",
    );
    expect(release?.obligations["post-conditions"]).toContain("runtime-native");
    expect(release?.obligations["post-conditions"]).toContain(
      "isImmutable:true",
    );
    expect(release?.obligations["no-overwrite"]).toContain(
      "immutable-releases",
    );
    expect(release?.obligations["no-overwrite"]).toContain("enabled:true");
    expect(release?.obligations["no-overwrite"]).toContain("isImmutable:true");
  });

  test("does not expose legacy release or deployment aliases", () => {
    for (const script of [
      "release:plan",
      "release:site:plan",
      "deploy:cloudflare",
      "db:migrate:cloudflare",
      "takosumi:release",
    ]) {
      expect(packageJson.scripts[script]).toBeUndefined();
    }
    expect(packageJson.scripts.deploy).toBe("bun scripts/deploy.mjs");
    expect(packageJson.scripts.test).toContain(
      "scripts/release-worker-smoke.test.ts",
    );
    expect(packageJson.scripts.check).toContain(
      "bun run smoke:release-artifact",
    );
    expect(packageJson.scripts["smoke:release-artifact"]).toBe(
      "bun scripts/smoke-release-worker.mjs",
    );
    expect(Object.values(packageJson.scripts).join("\n")).not.toContain(
      "scripts/release-safety/",
    );
  });

  test("routes both website CTAs through the Git repository install entrypoint", () => {
    const repositoryHref =
      "https://app.takosumi.com/install?git=https%3A%2F%2Fgithub.com%2Ftako0614%2Fyurucommu.git";
    const installHrefs = [
      ...siteSource.matchAll(
        /href="([^"]*app\.takosumi\.com\/install[^"]*)"/gu,
      ),
    ].map((match) => match[1]);
    expect(installHrefs).toEqual([repositoryHref, repositoryHref]);
    for (const href of installHrefs) {
      const parsed = new URL(href.replaceAll("&amp;", "&"));
      expect(parsed.searchParams.get("git")).toBe(
        "https://github.com/tako0614/yurucommu.git",
      );
      expect(parsed.searchParams.has("kind")).toBe(false);
      expect(parsed.searchParams.has("path")).toBe(false);
      expect(parsed.searchParams.has("ref")).toBe(false);
    }
    expect(siteSource).not.toContain("path=.");
    expect(siteSource).not.toContain(
      "Takosumi から Takoserver への追加は準備中",
    );
  });
});

function readbackPayload(isImmutable: boolean | undefined): string {
  const artifact = Buffer.from("test release worker artifact\n");
  const artifactDigest = sha256(artifact);
  const tag = `v${packageVersion}`;
  const artifactUrl = `https://github.com/tako0614/yurucommu/releases/download/${tag}/yurucommu-worker.js`;
  const manifestUrl = `https://github.com/tako0614/yurucommu/releases/download/${tag}/takosumi-artifact.json`;
  const manifest = {
    kind: "takosumi.worker-artifact@v1",
    app: "yurucommu",
    commit: fakeCommit,
    ref: tag,
    releaseTag: tag,
    artifact: {
      filename: "yurucommu-worker.js",
      url: artifactUrl,
      sha256: artifactDigest,
      sha256Prefixed: `sha256:${artifactDigest}`,
      contentType: "application/javascript",
    },
    manifestUrl,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const checksumText = `${artifactDigest}  yurucommu-worker.js\n`;
  const payload: Record<string, unknown> = {
    isDraft: false,
    isPrerelease: false,
    isImmutable,
    tagName: tag,
    url: `https://github.com/tako0614/yurucommu/releases/tag/${tag}`,
    assets: [
      { name: "yurucommu-worker.js", digest: `sha256:${artifactDigest}` },
      {
        name: "takosumi-artifact.json",
        digest: `sha256:${sha256(manifestText)}`,
      },
      {
        name: "yurucommu-worker.js.sha256",
        digest: `sha256:${sha256(checksumText)}`,
      },
    ],
  };
  if (isImmutable === undefined) delete payload.isImmutable;
  return JSON.stringify(payload);
}

describe("immutable GitHub release guard", () => {
  test("does not call release create when the repository setting is disabled", async () => {
    const result = await createReleaseHarness({
      immutableSettings: JSON.stringify({ enabled: false }),
      readback: readbackPayload(true),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.ghLog).not.toContain("release create");
    expect(result.stderr).toContain("immutable");
  });

  test("does not call release create when the managed module metadata is missing", async () => {
    const result = await createReleaseHarness({
      immutableSettings: JSON.stringify({ enabled: true }),
      readback: readbackPayload(true),
      manifestMutator: (source) =>
        source.replace('"deploy/takoform": {', '"deploy/renamed": {'),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.ghLog).not.toContain("release create");
    expect(result.stderr).toContain("deploy/takoform sourceBuild");
  });

  test("does not call release create when the manifest asset output pin drifts", async () => {
    const result = await createReleaseHarness({
      immutableSettings: JSON.stringify({ enabled: true }),
      readback: readbackPayload(true),
      manifestMutator: (source) =>
        source.replace(
          '"deploy/takoform/.generated/yurucommu-worker.js"',
          '"deploy/takoform/.generated/unexpected.js"',
        ),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.ghLog).not.toContain("release create");
    expect(result.stderr).toContain("generated Worker and migration assets");
  });

  test.each([
    ["false", readbackPayload(false)],
    ["missing", readbackPayload(undefined)],
  ])(
    "rejects a post-create Release whose isImmutable is %s without emitting PUBLISHED",
    async (_label, readback) => {
      const result = await createReleaseHarness({
        immutableSettings: JSON.stringify({ enabled: true }),
        readback,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.ghLog).toContain("release create");
      expect(result.stdout).not.toContain('"status": "PUBLISHED"');
      expect(result.stderr).toContain("isImmutable");
    },
  );

  test("reads the enabled setting immediately before create and preserves immutable create-only publication", async () => {
    const result = await createReleaseHarness({
      immutableSettings: JSON.stringify({ enabled: true }),
      readback: readbackPayload(true),
    });

    const commands = result.ghLog.trim().split("\n");
    const settingRead = commands.findIndex(
      (command) =>
        command === "api repos/tako0614/yurucommu/immutable-releases",
    );
    const create = commands.findIndex((command) =>
      command.startsWith("release create "),
    );
    expect(result.exitCode).toBe(0);
    expect(settingRead).toBeGreaterThanOrEqual(0);
    expect(create).toBe(settingRead + 1);
    expect(result.stdout).toContain('"status": "PUBLISHED"');
  });

  test("retains lost-ack behavior when create fails after the setting read", async () => {
    const result = await createReleaseHarness({
      immutableSettings: JSON.stringify({ enabled: true }),
      readback: readbackPayload(true),
      createFails: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.ghLog).toContain(
      "api repos/tako0614/yurucommu/immutable-releases",
    );
    expect(result.ghLog).toContain("release create");
    expect(result.stdout).not.toContain('"status": "PUBLISHED"');
    expect(result.stderr).toContain(
      `publication of ${packageTag} started but did not complete cleanly`,
    );
  });
});
