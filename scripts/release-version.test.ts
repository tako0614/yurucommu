import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [packageSource, moduleSource, outputsSource] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
  readFile(new URL("../outputs.tf", import.meta.url), "utf8"),
]);

const packageVersion = (JSON.parse(packageSource) as { version: string })
  .version;

describe("release version", () => {
  test("keeps the OpenTofu artifact default and app declaration aligned", () => {
    const releaseVariable = moduleSource.match(
      /variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/,
    )?.[1];

    expect(releaseVariable).toBeDefined();
    expect(releaseVariable).toContain(`default     = "v${packageVersion}"`);
    expect(outputsSource).toContain(`version         = "${packageVersion}"`);
  });

  test("matches the Git tag when the release workflow runs", () => {
    const gitRef = process.env.GITHUB_REF_NAME;
    if (!gitRef?.startsWith("v")) return;

    expect(gitRef).toBe(`v${packageVersion}`);
  });
});
