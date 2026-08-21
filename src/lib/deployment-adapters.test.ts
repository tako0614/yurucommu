import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const contract = JSON.parse(
  await readFile(new URL("deploy/product-resources.json", root), "utf8"),
) as {
  apiVersion: string;
  product: string;
  resources: Array<{ name: string; shape: string }>;
  runtimeConnections: Array<{ name: string; resource: string }>;
};
const cloudflare = await readFile(new URL("main.tf", root), "utf8");
const takoform = await readFile(
  new URL("deploy/takoform/main.tf", root),
  "utf8",
);

test("Yurucommu resource requirements are provider-neutral", () => {
  expect(contract.apiVersion).toBe("yurucommu.com/product-resources/v1");
  expect(contract.product).toBe("yurucommu");
  expect(JSON.stringify(contract)).not.toMatch(
    /cloudflare|takoform|account_id|api_token/i,
  );
  const resources = new Set(
    contract.resources.map((resource) => resource.name),
  );
  expect(resources.size).toBe(contract.resources.length);
  for (const connection of contract.runtimeConnections) {
    expect(resources.has(connection.resource)).toBe(true);
  }
});

test("Cloudflare direct and Takoform adapt the same runtime connections", () => {
  for (const connection of contract.runtimeConnections) {
    expect(cloudflare).toContain(connection.name);
    expect(takoform).toContain(connection.name);
  }
  expect(cloudflare).toContain('source  = "cloudflare/cloudflare"');
  expect(takoform).toContain(
    'source  = "registry.terraform.io/tako0614/takoform"',
  );
  expect(takoform).not.toContain("cloudflare_");
  expect(takoform).not.toContain("CLOUDFLARE_");
});
