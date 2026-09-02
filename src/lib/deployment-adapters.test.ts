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
  standardServices: Array<{
    name: string;
    protocol: string;
    required: boolean;
  }>;
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
  // Every runtime connection now resolves to a resource the product's own graph
  // owns. Asking a Host for a standard service it is not obliged to supply is
  // what an ObjectBucket Form replaces.
  expect(contract.standardServices).toEqual([]);
  expect(contract.resources.some(({ shape }) => shape === "ObjectBucket")).toBe(
    true,
  );
  expect(
    contract.runtimeConnections.find(({ name }) => name === "MEDIA")?.resource,
  ).toBe("media");
});

test("Cloudflare direct and Takoform adapt the same runtime connections", () => {
  for (const connection of [
    ...contract.runtimeConnections,
    ...contract.standardServices,
  ]) {
    expect(cloudflare).toContain(connection.name);
    expect(takoform).toContain(connection.name);
  }
  expect(cloudflare).toContain('source  = "cloudflare/cloudflare"');
  expect(takoform).toContain(
    'source  = "registry.terraform.io/tako0614/takoform"',
  );
  expect(takoform).not.toContain("cloudflare_");
  expect(takoform).not.toContain("CLOUDFLARE_");
  // Both adapters bind MEDIA to a bucket they create: an R2 bucket on the
  // direct root, a portable ObjectBucket in the Takoform module.
  expect(cloudflare).toContain('type        = "r2_bucket"');
  expect(takoform).toContain("takoform_edge_object_bucket");
  expect(takoform).not.toContain("com.amazonaws.s3");
});
