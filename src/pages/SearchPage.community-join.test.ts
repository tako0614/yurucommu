import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Run the actual SearchPage registry and refresh callback in an isolated
// process so the synthetic plugin and transport cannot affect other tests.
test("community joins retain their original request and read scope", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const script = fileURLToPath(
    new URL(
      "../../scripts/ux-search-community-join-scope-regression.mjs",
      import.meta.url,
    ),
  );
  const child = Bun.spawn([process.execPath, "--conditions=browser", script], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => child.kill(), 20_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stdout, stderr, exit }).toMatchObject({ exit: 0 });
    const result = JSON.parse(stdout) as {
      checks: { name: string; pass: boolean }[];
    };
    expect(result.checks.filter((item) => !item.pass)).toEqual([]);
    expect(result.checks.map((item) => item.name)).toContain(
      "GET change during connection selection cannot publish the old list",
    );
    expect(result.checks.map((item) => item.name)).toContain(
      "stale read failure cannot affect the new connection",
    );
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 30_000);
