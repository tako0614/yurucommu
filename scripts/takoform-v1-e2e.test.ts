import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertFetchProbeResponse,
  prepareProviderDevOverride,
  readTakoformV1E2EConfig,
} from "./takoform-v1-e2e.ts";

describe("Takoform stable-v1 fetch tracer", () => {
  test("fails closed before tofu when Host authority is absent", () => {
    expect(() => readTakoformV1E2EConfig({})).toThrow(
      "TAKOFORM_ENDPOINT, TAKOFORM_SPACE, and TAKOFORM_TOKEN are required",
    );
  });

  test("accepts HTTPS and loopback Host endpoints without exposing the token", () => {
    const config = readTakoformV1E2EConfig({
      TAKOFORM_ENDPOINT: "https://forms.example.test/v1/",
      TAKOFORM_SPACE: "probe-space",
      TAKOFORM_TOKEN: "sealed-token",
      TAKOFORM_PROVIDER_BINARY: "/tmp/terraform-provider-takoform",
      TAKOFORM_PROVIDER_SHA256:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(config.endpoint).toBe("https://forms.example.test/v1");
    expect(config.space).toBe("probe-space");
    expect(config.token).toBe("sealed-token");
    const local = readTakoformV1E2EConfig({
      TAKOFORM_ENDPOINT: "http://127.0.0.1:8787",
      TAKOFORM_SPACE: "probe-space",
      TAKOFORM_TOKEN: "sealed-token",
      TAKOFORM_PROVIDER_BINARY: "/tmp/terraform-provider-takoform",
      TAKOFORM_PROVIDER_SHA256:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      TAKOFORM_DIAGNOSTIC_RUNTIME_ENDPOINT: "http://127.0.0.1:9797/",
    });
    expect(local.diagnosticRuntimeEndpoint).toBe("http://127.0.0.1:9797");
    expect(() =>
      readTakoformV1E2EConfig({
        TAKOFORM_ENDPOINT: "http://127.0.0.1:8787",
        TAKOFORM_SPACE: "probe-space",
        TAKOFORM_TOKEN: "sealed-token",
        TAKOFORM_PROVIDER_BINARY: "/tmp/terraform-provider-takoform",
        TAKOFORM_PROVIDER_SHA256:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        TAKOFORM_DIAGNOSTIC_RUNTIME_ENDPOINT: "https://runtime.example.test",
      }),
    ).toThrow("test-only and must be loopback");
    expect(() =>
      readTakoformV1E2EConfig({
        TAKOFORM_ENDPOINT: "http://forms.example.test/v1",
        TAKOFORM_SPACE: "probe-space",
        TAKOFORM_TOKEN: "do-not-print-me",
        TAKOFORM_PROVIDER_BINARY: "/tmp/terraform-provider-takoform",
        TAKOFORM_PROVIDER_SHA256:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow("must use HTTPS unless it is loopback");
  });

  test("requires exact local Provider 3 bytes before any mutation", () => {
    expect(() =>
      readTakoformV1E2EConfig({
        TAKOFORM_ENDPOINT: "https://forms.example.test/v1",
        TAKOFORM_SPACE: "probe-space",
        TAKOFORM_TOKEN: "do-not-print-me",
      }),
    ).toThrow(
      "TAKOFORM_PROVIDER_BINARY and TAKOFORM_PROVIDER_SHA256 are required",
    );
  });

  test("rejects a missing Provider executable without leaking Host authority", async () => {
    const token = "never-print-this-token";
    const config = readTakoformV1E2EConfig({
      TAKOFORM_ENDPOINT: "https://forms.example.test/v1",
      TAKOFORM_SPACE: "probe-space",
      TAKOFORM_TOKEN: token,
      TAKOFORM_PROVIDER_BINARY:
        "/definitely/missing/terraform-provider-takoform",
      TAKOFORM_PROVIDER_SHA256:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    try {
      await prepareProviderDevOverride(config, "/tmp/provider-missing-test");
      throw new Error("expected missing Provider authority to fail");
    } catch (error) {
      expect(String(error)).toContain(
        "TAKOFORM_PROVIDER_BINARY does not exist",
      );
      expect(String(error)).not.toContain(token);
    }
  });

  test("verifies the local Provider digest and writes a token-free dev override", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "yurucommu-provider-test-"));
    const binary = join(workdir, "candidate-provider");
    const bytes = new TextEncoder().encode("provider-3-candidate");
    await writeFile(binary, bytes);
    await chmod(binary, 0o755);
    const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    const config = readTakoformV1E2EConfig({
      TAKOFORM_ENDPOINT: "https://forms.example.test/v1",
      TAKOFORM_SPACE: "probe-space",
      TAKOFORM_TOKEN: "do-not-print-me",
      TAKOFORM_PROVIDER_BINARY: binary,
      TAKOFORM_PROVIDER_SHA256: digest,
    });

    try {
      const override = await prepareProviderDevOverride(config, workdir);
      expect(await readFile(override.cliConfigPath, "utf8")).toContain(
        '"registry.terraform.io/tako0614/takoform"',
      );
      expect(await readFile(override.cliConfigPath, "utf8")).not.toContain(
        "do-not-print-me",
      );
      try {
        await prepareProviderDevOverride(
          {
            ...config,
            providerSha256:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
          join(workdir, "mismatch"),
        );
        throw new Error("expected mismatched Provider authority to fail");
      } catch (error) {
        expect(String(error)).toContain("Provider binary digest mismatch");
        expect(String(error)).not.toContain(config.token);
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("the deploy fixture is fetch-only and uses the Provider 3 worker chain", async () => {
    const fixture = new URL(
      "../deploy/takoform/e2e/fetch-only/main.tf.fixture",
      import.meta.url,
    );
    const main = await readFile(fixture, "utf8");
    const resourceTypes = Array.from(
      main.matchAll(/resource\s+"([^"]+)"\s+"[^"]+"\s*\{/g),
      (match) => match[1],
    );

    expect(main).toContain('version = "= 3.0.0"');
    expect(main).not.toContain('version = ">= 3.0.0"');
    expect(resourceTypes).toEqual([
      "takoform_module_worker",
      "takoform_worker_bundle",
      "takoform_worker_version",
      "takoform_worker_deployment",
      "takoform_worker_endpoint",
    ]);
    expect(main).toMatch(/handlers\s*=\s*\["fetch"\]/);
    const endpoint = main.match(
      /resource "takoform_worker_endpoint" "probe" \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(endpoint).toMatch(
      /depends_on\s*=\s*\[takoform_worker_deployment\.probe\]/,
    );
    for (const forbidden of [
      "sqlite_",
      "kv_",
      "queue",
      "cron",
      "external_services",
    ]) {
      expect(main).not.toContain(forbidden);
    }
  });

  test("uses a local dev override without pretending registry init succeeded", async () => {
    const source = await readFile(
      new URL("takoform-v1-e2e.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("TF_CLI_CONFIG_FILE");
    expect(source).not.toMatch(/runTofu\(\["init"/);
  });

  test("requires an actual matching HTTP response", async () => {
    await expect(
      assertFetchProbeResponse(
        new Response(
          JSON.stringify({
            kind: "yurucommu.takoform-v1-fetch-probe@v1",
            nonce: "expected-nonce",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
        "expected-nonce",
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertFetchProbeResponse(
        new Response(
          JSON.stringify({
            kind: "yurucommu.takoform-v1-fetch-probe@v1",
            nonce: "wrong-nonce",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
        "expected-nonce",
      ),
    ).rejects.toThrow("did not echo this run's nonce");
  });
});
