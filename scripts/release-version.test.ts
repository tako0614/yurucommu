import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [
  packageSource,
  moduleSource,
  takoformModuleSource,
  releaseLockSource,
  siteSource,
] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
  readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
  readFile(new URL("../release.lock.json", import.meta.url), "utf8"),
  readFile(new URL("../site/index.html", import.meta.url), "utf8"),
]);

const packageJson = JSON.parse(packageSource) as {
  version: string;
  scripts: Record<string, string>;
};
const packageVersion = packageJson.version;
const packageTag = `v${packageVersion}`;
const releaseLock = JSON.parse(releaseLockSource) as {
  releases: Record<
    string,
    {
      artifact: { url: string; sha256: string };
      manifest: { url: string; sha256: string };
      commit: string;
    }
  >;
};

const pinnedTags = Object.keys(releaseLock.releases).sort(compareSemverTags);
const latestPinnedTag = pinnedTags.at(-1);
const latestPinnedRelease = latestPinnedTag
  ? releaseLock.releases[latestPinnedTag]
  : undefined;

function compareSemverTags(left: string, right: string): number {
  const parse = (tag: string): readonly number[] =>
    tag
      .replace(/^v/u, "")
      .split(".")
      .map((value) => Number.parseInt(value, 10));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

function deploymentDefaultTag(source: string): string | undefined {
  return source
    .match(/variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/u)?.[1]
    ?.match(/default\s+=\s+"(v[^"]+)"/u)?.[1];
}

describe("release version", () => {
  test("keeps deployment defaults on an immutable published release", () => {
    const currentPin = releaseLock.releases[packageTag];
    const deployedTag = currentPin ? packageTag : latestPinnedTag;
    const deployedPin = currentPin ?? latestPinnedRelease;

    expect(deployedTag).toBeDefined();
    expect(deployedPin).toBeDefined();
    if (!currentPin) {
      // Publication is two-phase. A clean candidate may advance package.json,
      // but deploy defaults stay on the last immutable release until the owner
      // entrypoint publishes the new bytes and the follow-up pin records their
      // read-back digests. This avoids the impossible cycle
      // commit -> manifest digest -> lock contents -> commit.
      expect(compareSemverTags(packageTag, deployedTag!)).toBeGreaterThan(0);
    }

    expect(deploymentDefaultTag(moduleSource)).toBe(deployedTag);
    // Provider 3 bundles are assembled from this checkout and sent to the
    // host's WorkerBundle resource; the portable module must not retain the
    // retired release-url/sha input surface.
    expect(takoformModuleSource).not.toContain("worker_release_tag");
    expect(takoformModuleSource).not.toContain("worker_bundle_url");
    expect(takoformModuleSource).not.toContain("worker_bundle_sha256");
  });

  test("pins the current Worker release after publication", () => {
    const pin = releaseLock.releases[packageTag];
    if (!pin) {
      // Candidate phase is safe only because the previous test proves every
      // deployment default still consumes the latest published pin.
      expect(packageTag).not.toBe(latestPinnedTag);
      return;
    }

    expect(pin.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(pin.artifact.url).toBe(
      `https://github.com/tako0614/yurucommu/releases/download/${packageTag}/yurucommu-worker.js`,
    );
    expect(pin.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(pin.manifest.url).toBe(
      `https://github.com/tako0614/yurucommu/releases/download/${packageTag}/takosumi-artifact.json`,
    );
    expect(pin.manifest.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(moduleSource).toContain(pin.artifact.url);
    expect(moduleSource).toContain(pin.artifact.sha256);
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
        covers?: string[];
        obligations: Record<string, string>;
      }>;
    };
    const worker = contract.surfaces.find(
      (surface) => surface.surface === "yurucommu-worker",
    );
    expect(worker?.covers).toEqual(
      expect.arrayContaining([
        "package.json",
        "bun.lock",
        "scripts/build-yurucommu-worker.ts",
        "scripts/runtime-ports.ts",
        "dist/yurucommu-worker.js",
        "wrangler.jsonc",
      ]),
    );
    const release = contract.surfaces.find(
      (surface) => surface.surface === "yurucommu-worker-release",
    );

    expect(release?.triggers).toEqual(["published-identity"]);
    expect(release?.covers).toEqual(
      expect.arrayContaining([
        "package.json",
        "bun.lock",
        "scripts/build-yurucommu-worker.ts",
        "scripts/runtime-ports.ts",
        "dist/yurucommu-worker.js",
      ]),
    );
    expect(release?.obligations["no-overwrite"]).toContain("create-only");
    expect(release?.obligations.provenance).toContain("unpushed");
    expect(release?.obligations["post-conditions"]).toContain("downloads");
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
    expect(Object.values(packageJson.scripts).join("\n")).not.toContain(
      "scripts/release-safety/",
    );
  });

  test("does not advertise a selectable Takosumi Cloud install before its gates pass", () => {
    expect(siteSource).not.toContain("app.takosumi.com/install");
    expect(siteSource).toContain("Takosumi Cloud での追加は準備中");
  });
});
