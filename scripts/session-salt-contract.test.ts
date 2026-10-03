import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const saltName = "YURUCOMMU_SESSION_HASH_SALT";
const manifest = JSON.parse(
  await readFile(
    new URL("../.well-known/takosumi.json", import.meta.url),
    "utf8",
  ),
);
const portable = await readFile(
  new URL("../deploy/takoform/main.tf", import.meta.url),
  "utf8",
);

test("portable required secret names equal the manifest delivery slots", () => {
  const requirements = manifest.install.modules["deploy/takoform"]
    .requires as Array<{
    kind: string;
    bytes?: number;
    encoding?: string;
    deliver: { bindings?: Record<string, string> };
  }>;
  const declared = portable
    .match(/required_sensitive_vars\s*=\s*\[([^\]]+)\]/)?.[1]
    ?.match(/"([A-Z_]+)"/g)
    ?.map((name) => name.slice(1, -1))
    .sort();
  expect(declared).toBeDefined();
  const delivered = requirements
    .flatMap((requirement) => Object.values(requirement.deliver.bindings ?? {}))
    .sort();
  expect(delivered).toContain(saltName);
  expect(new Set(delivered).size).toBe(delivered.length);
  expect(declared).toEqual(delivered);
  expect(
    requirements.filter(
      (requirement) => requirement.deliver.bindings?.value === saltName,
    ),
  ).toEqual([
    {
      kind: "secret.generated",
      bytes: 32,
      encoding: "hex",
      deliver: { bindings: { value: saltName } },
    },
  ]);
});

test("salt is not collected as an unsealed direct install form value", () => {
  const inputs = manifest.install.modules["."].inputs as Array<{
    name: string;
  }>;
  expect(inputs.some((input) => input.name === "session_hash_salt")).toBe(
    false,
  );
});
