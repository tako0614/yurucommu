import { expect, test } from "bun:test";

import packageJson from "../package.json";

test("portable owner gate cannot omit dependency security", () => {
  const scripts = packageJson.scripts;

  expect(scripts["audit:dependencies"]).toBe("bun audit --audit-level=low");
  expect(scripts.check).toContain("bun run audit:dependencies");
});
