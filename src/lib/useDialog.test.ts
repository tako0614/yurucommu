import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./__fixtures__/useDialog.fixture.ts", import.meta.url),
);

for (const scenario of ["ime-escape", "stacked-ime-escape"]) {
  test(`useDialog Escape & IME handling: ${scenario}`, () => {
    const child = Bun.spawnSync(
      [process.execPath, "--conditions=browser", fixture, scenario],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(JSON.parse(child.stdout.toString())).toEqual({
      scenario,
      passed: true,
    });
  }, 15_000);
}
