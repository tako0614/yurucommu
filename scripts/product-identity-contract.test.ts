import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { createEntrySource } from "./build-yurucommu-worker.ts";
import {
  PRODUCT_CLIENT_KEY,
  PRODUCT_WIRE_IDENTITY,
} from "../src/product-identity.ts";

const rootDir = new URL("../", import.meta.url);

// The two producers of the discovery document: the generated Worker entry and
// the dev mock every local client is pointed at. They are the pair that drifted
// apart in the sibling product, so they are the pair this test binds together.
const PRODUCERS = [
  "scripts/build-yurucommu-worker.ts",
  "scripts/dev-mock-server.ts",
] as const;

describe("product wire identity", () => {
  // `product` names the family engine (@takosjp/yurucommu-core), which is what
  // mobile clients compare against before making any other call.
  test("advertises the yurucommu family engine token", () => {
    expect(PRODUCT_WIRE_IDENTITY.product).toBe("yurucommu");
    expect(PRODUCT_WIRE_IDENTITY.clients.map((client) => client.id)).toContain(
      PRODUCT_CLIENT_KEY,
    );
  });

  test("the built Worker bakes in exactly this document", () => {
    const entrySource = createEntrySource({});
    expect(entrySource).toContain(
      JSON.stringify(PRODUCT_WIRE_IDENTITY, null, 2),
    );
    expect(entrySource).toContain('"product": "yurucommu"');
  });
});

describe("wire identity has one home", () => {
  // Scoped to the discovery producers on purpose: "yurucommu" is also a valid
  // notification-pusher product key elsewhere in the mock, and a repo-wide
  // string ban would be namespace-blind.
  test("no discovery producer re-declares the tokens", async () => {
    const offenders: string[] = [];
    for (const producer of PRODUCERS) {
      const text = await readFile(new URL(producer, rootDir), "utf8");
      const discoveryBlock = extractDiscoveryDocument(text);
      for (const match of discoveryBlock.matchAll(
        /\b(?:product|serverId|id):\s*"(yurucommu|yurume|yurucommu-server)"/g,
      )) {
        offenders.push(`${producer}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Returns the region of a producer that builds the discovery document: the
 * `const discovery = ...` initialiser in the build script, or the body of
 * `function discovery(...)` in the mock.
 */
function extractDiscoveryDocument(text: string): string {
  const start = text.search(/const discovery = |function discovery\(/);
  if (start < 0) {
    throw new Error("producer no longer builds a discovery document");
  }
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end < 0 ? undefined : end);
}
