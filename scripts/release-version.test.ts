import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [
  packageSource,
  installOptionsSource,
  moduleSource,
  takoformModuleSource,
  releaseLockSource,
  siteSource,
] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../install-options.json", import.meta.url), "utf8"),
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
const installOptions = JSON.parse(installOptionsSource) as {
  options: Array<{
    source: { url: string; ref?: string; path: string };
  }>;
};
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

describe("release version", () => {
  test("binds Store sources and deployment defaults to one package release", () => {
    const artifactUrl = `https://github.com/tako0614/yurucommu/releases/download/${packageTag}/yurucommu-worker.js`;
    const artifactDigests = new Set<string>();

    for (const option of installOptions.options) {
      expect(option.source.ref).toBe(packageTag);
    }
    for (const source of [moduleSource, takoformModuleSource]) {
      expect(deploymentDefault(source, "worker_release_tag")).toBe(packageTag);
      expect(deploymentDefault(source, "worker_bundle_url")).toBe(artifactUrl);
      const artifactDigest = deploymentDefault(source, "worker_bundle_sha256");
      expect(artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      artifactDigests.add(artifactDigest!);
    }
    expect(artifactDigests.size).toBe(1);
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
        "install-options.json",
        "main.tf",
        "deploy/takoform/main.tf",
      ]),
    );
    expect(release?.obligations.provenance).toContain("unpushed");
    expect(release?.obligations.provenance).toContain(
      "Store sources and module defaults",
    );
    expect(release?.requiresScripts).toContain("smoke:release-artifact");
    expect(release?.obligations["post-conditions"]).toContain(
      "downloaded Worker in workerd",
    );
    expect(release?.obligations["post-conditions"]).toContain(
      "Takosumi managed-runtime",
    );
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

  test("does not advertise a selectable Takosumi Cloud install before its gates pass", () => {
    expect(siteSource).not.toContain("app.takosumi.com/install");
    expect(siteSource).toContain("Takosumi Cloud での追加は準備中");
  });
});
