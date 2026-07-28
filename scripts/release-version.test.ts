import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [packageSource, moduleSource, takoformModuleSource, siteSource] =
  await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../main.tf", import.meta.url), "utf8"),
    readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
    readFile(new URL("../site/index.html", import.meta.url), "utf8"),
  ]);

const packageJson = JSON.parse(packageSource) as {
  version: string;
  scripts: Record<string, string>;
};
const packageVersion = packageJson.version;

describe("release version", () => {
  test("keeps the OpenTofu artifact default aligned", () => {
    for (const source of [moduleSource, takoformModuleSource]) {
      const releaseVariable = source.match(
        /variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/,
      )?.[1];

      expect(releaseVariable).toBeDefined();
      expect(releaseVariable).toContain(`default     = "v${packageVersion}"`);
      if (source === takoformModuleSource) {
        expect(source).toContain(
          `/releases/download/v${packageVersion}/yurucommu-worker.js`,
        );
        expect(source).toMatch(/default\s+=\s+"sha256:[a-f0-9]{64}"/);
      }
    }
  });

  test("matches the Git tag when the release workflow runs", () => {
    const gitRef = process.env.GITHUB_REF_NAME;
    if (!gitRef?.startsWith("v")) return;

    expect(gitRef).toBe(`v${packageVersion}`);
  });
});

describe("release surface status", () => {
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
