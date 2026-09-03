import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAuthoritativeAbsence,
  assertCurrentResourceOutputIds,
  assertResourceIdentity,
  assertReadyResource,
  assertLifecycleNotTerminated,
  buildSafeChildEnvironment,
  buildResourceReadUrl,
  buildTofuCommand,
  buildTofuPlanCommand,
  cleanupTakoformV1E2E,
  collectSourceProvenanceSnapshot,
  createRuntimeInputMaterial,
  copyCapsuleToWorkdir,
  CURRENT_RESOURCE_GRAPH,
  CURRENT_RESOURCE_TYPES,
  extractAppliedResourceIdentities,
  parseProviderSchemaProof,
  parseStableHostDiscovery,
  formatTofuDiagnostics,
  prepareRuntimeInputVariableFile,
  prepareProviderDevOverride,
  PROVIDER_SCHEMA_OUTPUT_MAX_BYTES,
  readProviderVersion,
  readTakoformV1E2EConfig,
  requireReadyType,
  responseJson,
  renderRuntimeInputProviderConfig,
  renderRuntimeInputVariableFileBody,
  RUNTIME_INPUT_NAMES,
  RUNTIME_INPUT_VARIABLE,
  runTofu,
  runBoundedChild,
  installLifecycleSignalHandlers,
} from "./takoform-v1-e2e-full.ts";
import { TAKOFORM_PROVIDER_VERSION } from "./takoform-provider-pin.ts";

const provider = {
  TAKOFORM_PROVIDER_BINARY: "/tmp/terraform-provider-takoform",
  TAKOFORM_PROVIDER_SHA256:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const discoveryFeatures = {
  service_forms: true,
  exact_form_ref: true,
  optimistic_concurrency: true,
  idempotent_lifecycle: true,
  operations: true,
  artifact_upload: true,
  support_profiles: true,
};

const takoformModuleMain = await readFile(
  new URL("../deploy/takoform/main.tf", import.meta.url),
  "utf8",
);
const takoformModuleOutputs = await readFile(
  new URL("../deploy/takoform/outputs.tf", import.meta.url),
  "utf8",
);

interface HclBlock {
  readonly keyword: string;
  readonly labels: readonly string[];
  readonly body: string;
}

function stripHclComments(source: string): string {
  let result = "";
  let state: "code" | "string" | "line" | "block" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (state === "string") {
      result += character;
      if (character === "\\" && next !== undefined) {
        result += next;
        index += 1;
      } else if (character === '"') {
        state = "code";
      }
      continue;
    }
    if (state === "line") {
      if (character === "\n") {
        result += "\n";
        state = "code";
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else if (character === "\n") {
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }
    if (character === '"') {
      result += character;
      state = "string";
    } else if (character === "#") {
      result += " ";
      state = "line";
    } else if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block";
    } else {
      result += character;
    }
  }
  return result;
}

function skipHclWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/u.test(source[index]!)) index += 1;
  return index;
}

function readHclIdentifier(
  source: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  if (!/[A-Za-z_]/u.test(source[start] ?? "")) return undefined;
  let end = start + 1;
  while (end < source.length && /[A-Za-z0-9_-]/u.test(source[end]!)) end += 1;
  return { value: source.slice(start, end), end };
}

function readHclString(
  source: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  if (source[start] !== '"') return undefined;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\" && source[index + 1] !== undefined) {
      value += source[index + 1];
      index += 1;
    } else if (character === '"') {
      return { value, end: index + 1 };
    } else {
      value += character;
    }
  }
  return undefined;
}

function skipHclString(source: string, start: number): number {
  return readHclString(source, start)?.end ?? source.length;
}

function findHclClosingBrace(source: string, openingBrace: number): number {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"') {
      index = skipHclString(source, index) - 1;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseTopLevelHclBlocks(source: string): readonly HclBlock[] {
  const uncommented = stripHclComments(source);
  const blocks: HclBlock[] = [];
  let depth = 0;
  for (let index = 0; index < uncommented.length;) {
    const character = uncommented[index]!;
    if (character === '"') {
      index = skipHclString(uncommented, index);
      continue;
    }
    if (character === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth !== 0 || !/[A-Za-z_]/u.test(character)) {
      index += 1;
      continue;
    }
    const identifier = readHclIdentifier(uncommented, index);
    if (!identifier || !["resource", "output"].includes(identifier.value)) {
      index = identifier?.end ?? index + 1;
      continue;
    }
    let cursor = skipHclWhitespace(uncommented, identifier.end);
    const labels: string[] = [];
    while (uncommented[cursor] === '"') {
      const label = readHclString(uncommented, cursor);
      if (!label) break;
      labels.push(label.value);
      cursor = skipHclWhitespace(uncommented, label.end);
    }
    if (uncommented[cursor] !== "{") {
      index = identifier.end;
      continue;
    }
    const closingBrace = findHclClosingBrace(uncommented, cursor);
    if (closingBrace < 0) {
      index = identifier.end;
      continue;
    }
    blocks.push({
      keyword: identifier.value,
      labels,
      body: uncommented.slice(cursor + 1, closingBrace),
    });
    index = closingBrace + 1;
  }
  return blocks;
}

function parseResourceAddresses(source: string): readonly string[] {
  return parseTopLevelHclBlocks(source)
    .filter(
      (block) => block.keyword === "resource" && block.labels.length === 2,
    )
    .map((block) => `${block.labels[0]}.${block.labels[1]}`);
}

function parseCanonicalResourceOutputIds(
  source: string,
): readonly { readonly key: string; readonly address: string }[] {
  const output = parseTopLevelHclBlocks(source).find(
    (block) =>
      block.keyword === "output" &&
      block.labels.length === 1 &&
      block.labels[0] === "takoform_resource_ids",
  );
  if (!output) return [];
  const valueMatch = /(?:^|\n)\s*value\s*=\s*\{/mu.exec(output.body);
  if (!valueMatch || valueMatch.index === undefined) return [];
  const openingBrace = output.body.indexOf("{", valueMatch.index);
  const closingBrace = findHclClosingBrace(output.body, openingBrace);
  if (closingBrace < 0) return [];
  return Array.from(
    output.body
      .slice(openingBrace + 1, closingBrace)
      .matchAll(
        /^\s+([a-z0-9_]+)\s*=\s*(takoform_[a-z0-9_]+\.[a-z0-9_]+)\.uid\s*$/gmu,
      ),
    (match) => ({ key: match[1]!, address: match[2]! }),
  );
}

const declaredResourceAddresses = parseResourceAddresses(takoformModuleMain);
const declaredOutputResourceAddresses = parseCanonicalResourceOutputIds(
  takoformModuleOutputs,
);

describe("Takoform stable-v1 full lifecycle E2E helpers", () => {
  test("requires a bare caller-supplied Host origin", () => {
    const config = readTakoformV1E2EConfig({
      ...provider,
      TAKOFORM_ENDPOINT: "https://forms.example.test/",
      TAKOFORM_SPACE: "e2e-space",
      TAKOFORM_TOKEN: "operator-token",
      TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
    });
    expect(config.endpoint).toBe("https://forms.example.test");
    expect(() =>
      readTakoformV1E2EConfig({
        ...provider,
        TAKOFORM_ENDPOINT: "https://forms.example.test/v1",
        TAKOFORM_SPACE: "e2e-space",
        TAKOFORM_TOKEN: "operator-token",
        TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
      }),
    ).toThrow("must be a bare origin");
  });

  test("separates the Provider writer token from direct evidence readback", () => {
    const config = readTakoformV1E2EConfig({
      ...provider,
      TAKOFORM_ENDPOINT: "https://forms.example.test",
      TAKOFORM_SPACE: "e2e-space",
      TAKOFORM_TOKEN: "writer-token",
      TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
    });
    expect(config.writerToken).toBe("writer-token");
    expect(config.evidenceToken).toBe("evidence-token");
    const child = buildSafeChildEnvironment(
      {
        PATH: "/safe/bin",
        TAKOFORM_TOKEN: "inherited-writer-token",
        TAKOFORM_EVIDENCE_TOKEN: "inherited-evidence-token",
      },
      config,
    );
    expect(child.TAKOFORM_TOKEN).toBe("writer-token");
    expect(child).not.toHaveProperty("TAKOFORM_EVIDENCE_TOKEN");
    expect(() =>
      readTakoformV1E2EConfig({
        ...provider,
        TAKOFORM_ENDPOINT: "https://forms.example.test",
        TAKOFORM_SPACE: "e2e-space",
        TAKOFORM_TOKEN: "writer-token",
      }),
    ).toThrow("TAKOFORM_EVIDENCE_TOKEN");
  });

  test("bounds child commands with an operator-selected hard timeout", () => {
    const config = readTakoformV1E2EConfig({
      ...provider,
      TAKOFORM_ENDPOINT: "https://forms.example.test",
      TAKOFORM_SPACE: "e2e-space",
      TAKOFORM_TOKEN: "operator-token",
      TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
      TAKOFORM_E2E_TIMEOUT_SECONDS: "7",
    });
    expect(config.commandTimeoutMs).toBe(7_000);
    expect(() =>
      readTakoformV1E2EConfig({
        ...provider,
        TAKOFORM_ENDPOINT: "https://forms.example.test",
        TAKOFORM_SPACE: "e2e-space",
        TAKOFORM_TOKEN: "operator-token",
        TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
        TAKOFORM_E2E_TIMEOUT_SECONDS: "0",
      }),
    ).toThrow("must be between");
    expect(() =>
      readTakoformV1E2EConfig({
        ...provider,
        TAKOFORM_ENDPOINT: "https://forms.example.test",
        TAKOFORM_SPACE: "e2e-space",
        TAKOFORM_TOKEN: "operator-token",
        TAKOFORM_EVIDENCE_TOKEN: "evidence-token",
        TAKOFORM_E2E_TIMEOUT_SECONDS: "1.5",
      }),
    ).toThrow("integer");
  });

  test("passes only the allowlisted child environment", () => {
    const child = buildSafeChildEnvironment(
      {
        PATH: "/safe/bin",
        HOME: "/safe/home",
        TAKOFORM_TOKEN: "canary-token",
        TAKOFORM_ENDPOINT: "https://attacker.invalid",
        TF_LOG: "TRACE",
        TF_LOG_PATH: "/tmp/canary.log",
        TF_CLI_ARGS: "-plugin-dir=/tmp/canary",
        AWS_SECRET_ACCESS_KEY: "canary-secret",
        GITHUB_TOKEN: "canary-github-token",
      },
      {
        endpoint: "https://forms.example.test",
        space: "e2e-space",
        writerToken: "operator-token",
      },
      "/tmp/e2e-workdir",
    );
    expect(child).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      TAKOFORM_ENDPOINT: "https://forms.example.test",
      TAKOFORM_SPACE: "e2e-space",
      TAKOFORM_TOKEN: "operator-token",
      TF_DATA_DIR: "/tmp/e2e-workdir/.tofu-data",
      TF_IN_AUTOMATION: "1",
    });
    expect(child).not.toHaveProperty("TF_LOG");
    expect(child).not.toHaveProperty("TF_LOG_PATH");
    expect(child).not.toHaveProperty("TF_CLI_ARGS");
    expect(child).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(child).not.toHaveProperty("GITHUB_TOKEN");
  });

  test("builds apply and destroy without secret or fixture arguments", () => {
    expect(buildTofuCommand("apply", "yurucommu-e2e-abc")).toEqual([
      "apply",
      "-auto-approve",
      "-input=false",
      "-no-color",
      "-var=project_name=yurucommu-e2e-abc",
    ]);
    expect(buildTofuCommand("destroy", "yurucommu-e2e-abc")[0]).toBe("destroy");
    expect(() => buildTofuCommand("apply", "bad_name")).toThrow(
      "projectName is not a valid",
    );
  });

  test("builds a value-free plan command for the saved-plan Apply", () => {
    expect(
      buildTofuPlanCommand("yurucommu-e2e-abc", "/tmp/e2e.tfplan"),
    ).toEqual([
      "plan",
      "-input=false",
      "-no-color",
      "-out",
      "/tmp/e2e.tfplan",
      "-var=project_name=yurucommu-e2e-abc",
    ]);
    expect(() =>
      buildTofuPlanCommand("yurucommu-e2e-abc", "relative.tfplan"),
    ).toThrow("planPath must be an absolute path");
  });

  test("wires Provider 4 runtime inputs without rendering their values", () => {
    const material = createRuntimeInputMaterial("yurucommu-e2e-test");
    expect(material.nonce).toMatch(/^[A-Za-z0-9_-]{22,128}$/u);
    expect(Object.keys(material.values).sort()).toEqual([
      ...RUNTIME_INPUT_NAMES,
    ]);
    expect(material.values.ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/u);
    const providerConfig = renderRuntimeInputProviderConfig(material.nonce);
    expect(providerConfig).toContain("ephemeral = true");
    expect(providerConfig).toContain(
      `runtime_input_nonce = \"${material.nonce}\"`,
    );
    expect(providerConfig).toContain(
      `runtime_inputs = var.${RUNTIME_INPUT_VARIABLE}`,
    );
    for (const value of Object.values(material.values)) {
      expect(providerConfig).not.toContain(value);
    }
    expect(() => renderRuntimeInputProviderConfig("too-short")).toThrow(
      "22..128",
    );
  });

  test("renders empty plan/destroy and exact apply runtime maps", () => {
    const material = createRuntimeInputMaterial("yurucommu-e2e-test");
    const empty = new TextDecoder().decode(
      renderRuntimeInputVariableFileBody(),
    );
    expect(empty).toBe(`${RUNTIME_INPUT_VARIABLE} = {\n}\n`);
    const exact = new TextDecoder().decode(
      renderRuntimeInputVariableFileBody(material.values),
    );
    expect(exact).toContain(`${RUNTIME_INPUT_VARIABLE} = {`);
    expect(exact).toContain(
      `\"ENCRYPTION_KEY\" = \"${material.values.ENCRYPTION_KEY}\"`,
    );
    expect(exact).toContain(
      `\"TAKOSUMI_ACCOUNTS_OWNER_SUB\" = \"${material.values.TAKOSUMI_ACCOUNTS_OWNER_SUB}\"`,
    );
    expect(() =>
      renderRuntimeInputVariableFileBody({
        ENCRYPTION_KEY: material.values.ENCRYPTION_KEY,
      }),
    ).toThrow("did not match required_sensitive_vars");
  });

  test("delivers runtime values through a FIFO and removes it afterwards", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "takoform-runtime-inputs-"));
    const material = createRuntimeInputMaterial("yurucommu-e2e-test");
    const variableFile = await prepareRuntimeInputVariableFile(
      workdir,
      material.values,
    );
    const fifoPath = variableFile.args[0]!.slice("-var-file=".length);
    try {
      const metadata = await lstat(fifoPath);
      expect(metadata.isFIFO()).toBe(true);
      expect(JSON.stringify(variableFile.args)).not.toContain(
        material.values.ENCRYPTION_KEY,
      );
      const expectedBytes = renderRuntimeInputVariableFileBody(
        material.values,
      ).byteLength;
      const result = await runBoundedChild(
        [
          "sh",
          "-c",
          'path="${1#-var-file=}"; test -p "$path"; test "$(wc -c < "$path")" -eq "$2"',
          "sh",
          variableFile.args[0]!,
          String(expectedBytes),
        ],
        {
          cwd: workdir,
          environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
          timeoutMs: 5_000,
          onSpawn: variableFile.onSpawn,
        },
      );
      expect(result.exitCode).toBe(0);
      await variableFile.delivered();
    } finally {
      await variableFile.dispose();
      await expect(lstat(fifoPath)).rejects.toThrow();
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("preserves bounded redacted OpenTofu diagnostics", () => {
    const canary = "runtime-secret-canary-value";
    const diagnostics = formatTofuDiagnostics(
      {
        stdout: "",
        stderr: `provider rejected ${canary}`,
        outputTruncated: false,
      },
      [canary],
    );
    expect(diagnostics).toContain("provider rejected [REDACTED]");
    expect(diagnostics).not.toContain(canary);
    const truncated = formatTofuDiagnostics(
      {
        stdout: "x".repeat(100_000),
        stderr: "",
        outputTruncated: true,
      },
      [],
    );
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThan(20_000);
    expect(truncated).toContain("diagnostics truncated");
  });

  test("does not expose a runtime value fragment at the exact diagnostic cap", () => {
    const marker = "\n[OpenTofu diagnostics truncated]";
    const maxBytes = 16 * 1024;
    const header = "\nstderr:\n";
    const room =
      maxBytes -
      new TextEncoder().encode(marker).byteLength -
      new TextEncoder().encode(header).byteLength;
    for (const [secret, partialPrefix] of [
      ["runtime-secret-boundary-canary", "runtime-secret-boundary-canar"],
      [
        "${runtime-secret-boundary-canary}",
        '"$${runtime-secret-boundary-canar',
      ],
    ] as const) {
      const body = "x".repeat(room - partialPrefix.length) + partialPrefix;
      const diagnostics = formatTofuDiagnostics(
        { stdout: "", stderr: body, outputTruncated: true },
        [secret],
      );
      expect(diagnostics).not.toContain(partialPrefix);
      expect(diagnostics).not.toContain(secret.slice(1));
      expect(
        new TextEncoder().encode(diagnostics).byteLength,
      ).toBeLessThanOrEqual(maxBytes);
    }
  });

  test("includes bounded redacted stderr on OpenTofu command failure", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "takoform-tofu-diagnostic-"));
    const bin = join(fixture, "tofu");
    const canary = "provider-runtime-secret-canary";
    try {
      await writeFile(
        bin,
        `#!/bin/sh\nprintf 'diagnostic %s\\n' '${canary}' >&2\nexit 17\n`,
        { mode: 0o755 },
      );
      await chmod(bin, 0o755);
      await expect(
        runTofu(["plan"], {
          workdir: fixture,
          environment: buildSafeChildEnvironment({ PATH: fixture }),
          timeoutMs: 5_000,
          redactionValues: [canary],
        }),
      ).rejects.toThrow("diagnostic [REDACTED]");
      try {
        await runTofu(["plan"], {
          workdir: fixture,
          environment: buildSafeChildEnvironment({ PATH: fixture }),
          timeoutMs: 5_000,
          redactionValues: [canary],
        });
      } catch (error) {
        expect(String(error)).not.toContain(canary);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("negotiates only the stable same-origin Host API", () => {
    const result = parseStableHostDiscovery("https://forms.example.test", {
      api_versions: ["forms.takoform.com/v1"],
      features: discoveryFeatures,
      endpoints: {
        api: "https://forms.example.test/apis/forms.takoform.com/v1",
      },
    });
    expect(result.apiBase).toBe(
      "https://forms.example.test/apis/forms.takoform.com/v1",
    );
    expect(() =>
      parseStableHostDiscovery("https://forms.example.test", {
        api_versions: ["forms.takoform.com/v1"],
        features: discoveryFeatures,
        endpoints: {
          api: "https://other.example.test/apis/forms.takoform.com/v1",
        },
      }),
    ).toThrow("same-origin");
  });

  test("uses every exact FormRef member for resource readback", () => {
    const url = new URL(
      buildResourceReadUrl(
        "https://forms.example.test/apis/forms.takoform.com/v1",
        {
          name: "yurucommu-e2e-abc-db",
          space: "space-a",
          form: {
            apiVersion: "edge.forms.takoform.com",
            kind: "SQLiteDatabase",
            definitionVersion: "0.1.0",
            schemaDigest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        },
      ),
    );
    expect(url.pathname).toBe(
      "/apis/forms.takoform.com/v1/resources/edge.forms.takoform.com/SQLiteDatabase/yurucommu-e2e-abc-db",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      space: "space-a",
      group: "edge.forms.takoform.com",
      kind: "SQLiteDatabase",
      definitionVersion: "0.1.0",
      schemaDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  test("models every declared resource identity, including the DLQ consumer", () => {
    expect(CURRENT_RESOURCE_GRAPH).toHaveLength(15);
    expect(declaredResourceAddresses).toEqual(
      CURRENT_RESOURCE_GRAPH.map((resource) => resource.address),
    );
    expect([...CURRENT_RESOURCE_TYPES].sort()).toEqual(
      CURRENT_RESOURCE_GRAPH.map((resource) => resource.type).sort(),
    );
    expect(
      [...declaredOutputResourceAddresses].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    ).toEqual(
      [...CURRENT_RESOURCE_GRAPH]
        .map((resource) => ({
          key: resource.outputKey,
          address: resource.address,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
    expect(CURRENT_RESOURCE_GRAPH).toContainEqual({
      address: "takoform_queue_consumer.delivery_dlq",
      type: "takoform_queue_consumer",
      outputKey: "delivery_dlq_consumer",
    });
  });

  test("requires every declared QueueConsumer readback to be ready", () => {
    const queueConsumers = CURRENT_RESOURCE_GRAPH.filter(
      (resource) => resource.type === "takoform_queue_consumer",
    );
    const identities = queueConsumers.map((resource, index) => ({
      address: resource.address,
      type: resource.type,
      name: `e2e-${index === 0 ? "delivery" : "delivery-dlq"}-consumer`,
      space: "e2e-space",
      uid: `uid-${index}`,
      generation: "1",
      form: {
        apiVersion: "edge.forms.takoform.com",
        kind: "QueueConsumer",
        definitionVersion: "0.1.0",
        schemaDigest: "sha256:" + "a".repeat(64),
      },
    }));
    const hostResources = identities.map((identity) => ({
      apiVersion: identity.form.apiVersion,
      kind: identity.form.kind,
      metadata: {
        name: identity.name,
        space: identity.space,
        uid: identity.uid,
        generation: identity.generation,
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    }));
    expect(() =>
      requireReadyType(
        hostResources,
        "takoform_queue_consumer",
        "queue consumer",
        identities,
      ),
    ).not.toThrow();
  });

  test("ignores block-commented resources and UID assignments outside the canonical output", () => {
    const commentedResourceSource = `/* resource "takoform_fake" "commented" {\n  name = "not-real"\n} */\n${takoformModuleMain}`;
    expect(parseResourceAddresses(commentedResourceSource)).toEqual(
      declaredResourceAddresses,
    );

    const renamedOutputSource = takoformModuleOutputs.replace(
      'output "takoform_resource_ids"',
      'output "renamed_resource_ids"',
    );
    expect(parseCanonicalResourceOutputIds(renamedOutputSource)).toEqual([]);
  });

  test("extracts and requires the current 15 managed resources", () => {
    const kinds: Record<string, string> = {
      takoform_module_worker: "ModuleWorker",
      takoform_sqlite_database: "SQLiteDatabase",
      takoform_sqlite_migration_set: "SQLiteMigrationSet",
      takoform_sqlite_migration_application: "SQLiteMigrationApplication",
      takoform_edge_kv_namespace: "EdgeKVNamespace",
      takoform_edge_object_bucket: "ObjectBucket",
      takoform_at_least_once_queue: "AtLeastOnceQueue",
      takoform_worker_bundle: "WorkerBundle",
      takoform_worker_version: "WorkerVersion",
      takoform_worker_deployment: "WorkerDeployment",
      takoform_worker_endpoint: "WorkerEndpoint",
      takoform_queue_consumer: "QueueConsumer",
      takoform_worker_cron_trigger: "WorkerCronTrigger",
    };
    const resources = CURRENT_RESOURCE_GRAPH.map((resource, index) => ({
      address: resource.address,
      mode: "managed",
      type: resource.type,
      name: `e2e-resource-${index}`,
      values: {
        name: `e2e-resource-${index}`,
        space: "e2e-space",
        uid: `uid-${index}`,
        generation: "1",
        form_api_version: "edge.forms.takoform.com",
        form_kind: kinds[resource.type],
        form_definition_version: "0.1.0",
        form_schema_digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }));
    const identities = extractAppliedResourceIdentities({
      values: { root_module: { resources } },
    });
    expect(identities).toHaveLength(CURRENT_RESOURCE_GRAPH.length);
    expect(identities[3]?.form.kind).toBe("SQLiteMigrationApplication");
    expect(identities[5]?.form.kind).toBe("ObjectBucket");
    expect(
      identities.find(
        (identity) =>
          identity.address === "takoform_queue_consumer.delivery_dlq",
      ),
    ).toMatchObject({
      type: "takoform_queue_consumer",
      name: "e2e-resource-13",
    });
    expect(() =>
      extractAppliedResourceIdentities({
        values: {
          root_module: {
            resources: resources.slice(0, CURRENT_RESOURCE_GRAPH.length - 1),
          },
        },
      }),
    ).toThrow("current 15-resource graph");
  });

  test("prepares migrations from a fresh source archive before tofu", async () => {
    const archiveRoot = await mkdtemp(
      join(tmpdir(), "yurucommu-archive-test-"),
    );
    const archivePath = join(archiveRoot, "source.tar");
    const sourceRoot = join(archiveRoot, "source");
    const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
    try {
      const archive = Bun.spawnSync({
        cmd: ["git", "archive", "--format=tar", "HEAD"],
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(archive.exitCode).toBe(0);
      await writeFile(archivePath, archive.stdout);
      await mkdir(sourceRoot, { recursive: true });
      const extraction = Bun.spawnSync({
        cmd: ["tar", "-xf", archivePath, "-C", sourceRoot],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(extraction.exitCode).toBe(0);

      const manifest = JSON.parse(
        await readFile(join(sourceRoot, ".well-known/takosumi.json"), "utf8"),
      ) as {
        install: {
          modules: {
            "deploy/takoform": {
              sourceBuild: {
                commands: Array<{ argv: string[] }>;
                outputs: string[];
              };
            };
          };
        };
      };
      const sourceBuild =
        manifest.install.modules["deploy/takoform"].sourceBuild;
      expect(sourceBuild.commands.map((command) => command.argv)).toEqual([
        ["bun", "install", "--frozen-lockfile"],
        ["bun", "run", "build:worker"],
        ["bun", "scripts/prepare-takoform-v1-source.ts"],
      ]);
      expect(sourceBuild.outputs).toEqual([
        "deploy/takoform/.generated/yurucommu-worker.js",
        "deploy/takoform/migrations/sql",
      ]);
      const releaseLock = JSON.parse(
        await readFile(join(sourceRoot, "release.lock.json"), "utf8"),
      ) as { releases?: Record<string, { commit?: string }> };
      expect(releaseLock.releases?.["v2.1.8"]?.commit).toBe(
        "c2f6e50747f8bc2a3c4e80305c04b78aea1b505b",
      );
      await access(join(sourceRoot, "deploy/takoform/migrations/sql"));

      // The runner's build command supplies the Worker. The migration inputs
      // are already in the archive, while the final sourceBuild command
      // verifies and refreshes them from the repository bundle.
      await mkdir(join(sourceRoot, "dist"), { recursive: true });
      await writeFile(
        join(sourceRoot, "dist/yurucommu-worker.js"),
        "export default { fetch() { return new Response('ok') } };\n",
      );
      const preparation = Bun.spawnSync({
        cmd: sourceBuild.commands[2]?.argv ?? [],
        cwd: sourceRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(preparation.exitCode).toBe(0);

      const migrationRoot = join(sourceRoot, "deploy/takoform/migrations/sql");
      const migrations = (await readdir(migrationRoot)).sort();
      const schemaBundle = JSON.parse(
        await readFile(
          join(sourceRoot, "deploy/takoform/migrations/schema-bundle.json"),
          "utf8",
        ),
      ) as { entries?: Array<{ name: string }> };
      expect(migrations.length).toBeGreaterThanOrEqual(1);
      expect(migrations).toEqual(
        (schemaBundle.entries ?? []).map((entry) => entry.name).sort(),
      );
      await access(
        join(sourceRoot, "deploy/takoform/.generated/yurucommu-worker.js"),
      );
    } finally {
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });

  test("requires Ready=True status and the exact absence error", async () => {
    const ready = {
      metadata: { name: "resource", space: "space", uid: "uid" },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
      },
    };
    expect(() => assertReadyResource(ready, "resource")).not.toThrow();
    expect(() =>
      assertReadyResource(
        {
          ...ready,
          status: { conditions: [{ type: "Ready", status: "False" }] },
        },
        "resource",
      ),
    ).toThrow("Ready=True");
    await expect(
      assertAuthoritativeAbsence(
        Response.json(
          { error: { code: "resource_not_found" } },
          { status: 404 },
        ),
        "resource",
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertAuthoritativeAbsence(
        Response.json({}, { status: 404 }),
        "resource",
      ),
    ).rejects.toThrow("resource_not_found");
  });

  test("never copies a Host body into protocol errors", async () => {
    const canary = "host-secret-canary-token";
    await expect(
      responseJson(
        Response.json({ error: canary }, { status: 502 }),
        "Host readback",
        200,
      ),
    ).rejects.toThrow("HTTP 502");
    try {
      await responseJson(
        Response.json({ error: canary }, { status: 502 }),
        "Host readback",
        200,
      );
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  });

  test("requires every exact state identity on Host readback", () => {
    const identity = {
      address: "takoform_sqlite_database.database",
      type: "takoform_sqlite_database",
      name: "e2e-db",
      space: "e2e-space",
      uid: "uid-db",
      generation: "4",
      form: {
        apiVersion: "edge.forms.takoform.com",
        kind: "SQLiteDatabase",
        definitionVersion: "0.1.0",
        schemaDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    } as const;
    const body = {
      apiVersion: identity.form.apiVersion,
      kind: identity.form.kind,
      form: { formRef: identity.form },
      metadata: {
        name: identity.name,
        space: identity.space,
        uid: identity.uid,
        generation: identity.generation,
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    };
    expect(() => assertResourceIdentity(body, identity)).not.toThrow();
    expect(() =>
      assertResourceIdentity(
        { ...body, metadata: { ...body.metadata, uid: "other-uid" } },
        identity,
      ),
    ).toThrow("exact identity");
  });

  test("runs destroy and absence readback even when destroy fails", async () => {
    const calls: string[] = [];
    const result = await cleanupTakoformV1E2E({
      mutationAttempted: true,
      destroy: async () => {
        calls.push("destroy");
        throw new Error("destroy failed");
      },
      verifyAbsence: async () => {
        calls.push("absence");
      },
      removeWorkdir: async () => {
        calls.push("remove");
      },
      workdir: "/tmp/e2e-recovery",
    });
    expect(calls).toEqual(["destroy", "absence"]);
    expect(result.cleanupVerified).toBe(false);
    expect(result.preservedWorkdir).toBe(true);
    expect(result.error).toBeInstanceOf(AggregateError);

    const successCalls: string[] = [];
    const success = await cleanupTakoformV1E2E({
      mutationAttempted: true,
      destroy: async () => {
        successCalls.push("destroy");
      },
      verifyAbsence: async () => {
        successCalls.push("absence");
      },
      removeWorkdir: async () => {
        successCalls.push("remove");
      },
      workdir: "/tmp/e2e-recovery",
    });
    expect(successCalls).toEqual(["destroy", "absence", "remove"]);
    expect(success.cleanupVerified).toBe(true);
    expect(success.preservedWorkdir).toBe(false);
  });

  test("does not allow termination during cleanup to look like a pass", async () => {
    const removeSignalHandlers = installLifecycleSignalHandlers();
    const calls: string[] = [];
    try {
      const result = await cleanupTakoformV1E2E({
        mutationAttempted: true,
        destroy: async () => {
          calls.push("destroy");
        },
        verifyAbsence: async () => {
          calls.push("absence");
          process.emit("SIGTERM");
        },
        removeWorkdir: async () => {
          calls.push("remove");
        },
        workdir: "/tmp/e2e-recovery",
      });
      expect(calls).toEqual(["destroy", "absence", "remove"]);
      expect(result.cleanupVerified).toBe(true);
      expect(() => assertLifecycleNotTerminated()).toThrow(
        "received SIGTERM; cleanup requested",
      );
    } finally {
      removeSignalHandlers();
    }
  });

  test("removes a pre-mutation workdir without claiming lifecycle cleanup", async () => {
    let removed = false;
    const result = await cleanupTakoformV1E2E({
      mutationAttempted: false,
      destroy: async () => {
        throw new Error("must not run");
      },
      verifyAbsence: async () => {
        throw new Error("must not run");
      },
      removeWorkdir: async () => {
        removed = true;
      },
      workdir: "/tmp/e2e-recovery",
    });
    expect(removed).toBe(true);
    expect(result.cleanupVerified).toBe(false);
    expect(result.preservedWorkdir).toBe(false);
  });

  test("checks all 15 output identity keys", () => {
    const ids = Object.fromEntries(
      CURRENT_RESOURCE_GRAPH.map(({ outputKey }) => [
        outputKey,
        `uid-${outputKey}`,
      ]),
    );
    expect(() => assertCurrentResourceOutputIds(ids)).not.toThrow();
    expect(ids).toHaveProperty(
      "delivery_dlq_consumer",
      "uid-delivery_dlq_consumer",
    );
    expect(() =>
      assertCurrentResourceOutputIds({ ...ids, unexpected: "uid" }),
    ).toThrow("all 15 current resources");
  });

  test("binds output UID map to the corresponding tofu state UID", () => {
    const identities = CURRENT_RESOURCE_GRAPH.map((resource) => ({
      address: resource.address,
      type: resource.type,
      name: resource.outputKey,
      space: "e2e-space",
      uid: `uid-${resource.outputKey}`,
      generation: "1",
      form: {
        apiVersion: "edge.forms.takoform.com",
        kind: "Resource",
        definitionVersion: "0.1.0",
        schemaDigest: "sha256:" + "a".repeat(64),
      },
    }));
    const outputIds = Object.fromEntries(
      CURRENT_RESOURCE_GRAPH.map(({ outputKey }) => [
        outputKey,
        `uid-${outputKey}`,
      ]),
    );
    expect(() =>
      assertCurrentResourceOutputIds(outputIds, identities),
    ).not.toThrow();
    expect(() =>
      assertCurrentResourceOutputIds(
        { ...outputIds, worker: "wrong-uid" },
        identities,
      ),
    ).toThrow("state UID");
  });

  test("copies only tracked module inputs and generated artifacts", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "takoform-source-test-"));
    const destination = await mkdtemp(join(tmpdir(), "takoform-copy-test-"));
    try {
      await mkdir(join(sourceRoot, ".generated"), { recursive: true });
      await mkdir(join(sourceRoot, "migrations", "sql"), {
        recursive: true,
      });
      await mkdir(join(sourceRoot, "migrations", "takoform-overrides"));
      await mkdir(join(sourceRoot, "e2e"));
      await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
      await writeFile(join(sourceRoot, "outputs.tf"), 'output "x" {}\n');
      await writeFile(join(sourceRoot, "README.md"), "docs\n");
      await writeFile(
        join(sourceRoot, "migrations", "schema-bundle.json"),
        JSON.stringify({
          apiVersion: "takosumi.resource-migrations/v1",
          engine: "sqlite",
          entries: [
            {
              name: "0001_init.sql",
              sha256:
                "sha256:073a6add660a8ce214203964d294bb3600d53c35984babcde6e721adae3da911",
              sql: "create table test (id integer);\n",
            },
          ],
        }),
      );
      await writeFile(
        join(sourceRoot, ".generated", "yurucommu-worker.js"),
        "export default {}\n",
      );
      await writeFile(
        join(sourceRoot, "migrations", "sql", "0001_init.sql"),
        "create table test (id integer);\n",
      );
      await writeFile(join(sourceRoot, "unexpected-secret.txt"), "canary\n");
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow("unexpected Takoform module source entry");
      await rm(join(sourceRoot, "unexpected-secret.txt"));
      await copyCapsuleToWorkdir(sourceRoot, destination);
      expect(await readFile(join(destination, "main.tf"), "utf8")).toContain(
        "terraform",
      );
      expect(
        await readFile(
          join(destination, "migrations", "sql", "0001_init.sql"),
          "utf8",
        ),
      ).toContain("create table");
      expect(await readdir(destination)).not.toContain("README.md");

      await mkdir(join(sourceRoot, ".generated", "migrations"));
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow(
        "unexpected generated Takoform source entry: migrations",
      );
      await rm(join(sourceRoot, ".generated", "migrations"), {
        recursive: true,
        force: true,
      });

      await writeFile(
        join(sourceRoot, "migrations", "unexpected-entry.txt"),
        "canary\n",
      );
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow(
        "unexpected Takoform migration source entry: unexpected-entry.txt",
      );
      await rm(join(sourceRoot, "migrations", "unexpected-entry.txt"));

      const migrationPath = join(
        sourceRoot,
        "migrations",
        "sql",
        "0001_init.sql",
      );
      await rm(migrationPath);
      await symlink(join(sourceRoot, "outputs.tf"), migrationPath);
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow(
        "tracked migration 0001_init.sql must be a regular file",
      );
      await rm(migrationPath);
      await writeFile(migrationPath, "create table test (id integer);\n");

      const migrationsDirectory = join(sourceRoot, "migrations", "sql");
      await rm(migrationsDirectory, { recursive: true, force: true });
      await symlink(
        join(sourceRoot, "migrations", "takoform-overrides"),
        migrationsDirectory,
      );
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow("tracked migration source must be a regular directory");
      await rm(migrationsDirectory, { force: true });
      await mkdir(migrationsDirectory);
      await writeFile(migrationPath, "create table test (id integer);\n");

      await rm(migrationPath);
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow("tracked migration source is empty");
      await writeFile(migrationPath, "create table test (id integer);\n");

      await writeFile(migrationPath, "create table changed (id integer);\n");
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow("tracked migration 0001_init.sql digest mismatch");
      await writeFile(migrationPath, "create table test (id integer);\n");

      await rm(join(sourceRoot, "main.tf"));
      await symlink(
        join(sourceRoot, "outputs.tf"),
        join(sourceRoot, "main.tf"),
      );
      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination),
      ).rejects.toThrow("must be a regular file");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("rejects an untracked migration SQL file when repositoryRoot is supplied", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "takoform-source-test-"));
    const destination = await mkdtemp(join(tmpdir(), "takoform-copy-test-"));
    const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
    const untrackedMigration = join(
      sourceRoot,
      "migrations",
      "sql",
      "9999_untracked.sql",
    );
    try {
      await mkdir(join(sourceRoot, ".generated"), { recursive: true });
      await mkdir(join(sourceRoot, "migrations", "sql"), {
        recursive: true,
      });
      await mkdir(join(sourceRoot, "migrations", "takoform-overrides"));
      await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
      await writeFile(join(sourceRoot, "outputs.tf"), 'output "x" {}\n');
      await writeFile(
        join(sourceRoot, "migrations", "schema-bundle.json"),
        JSON.stringify({
          apiVersion: "takosumi.resource-migrations/v1",
          engine: "sqlite",
          entries: [
            {
              name: "9999_untracked.sql",
              sha256:
                "sha256:073a6add660a8ce214203964d294bb3600d53c35984babcde6e721adae3da911",
              sql: "create table test (id integer);\n",
            },
          ],
        }),
      );
      await writeFile(
        join(sourceRoot, ".generated", "yurucommu-worker.js"),
        "export default {}\n",
      );
      await writeFile(untrackedMigration, "create table test (id integer);\n");

      await expect(
        copyCapsuleToWorkdir(sourceRoot, destination, {
          repositoryRoot,
          environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("git ls-files failed with exit 1");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("uses one migration snapshot for report and workdir despite valid source changes", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "takoform-source-test-"),
    );
    const sourceRoot = join(repositoryRoot, "deploy", "takoform");
    const destination = await mkdtemp(join(tmpdir(), "takoform-copy-test-"));
    const migrationPath = join(
      sourceRoot,
      "migrations",
      "sql",
      "0001_init.sql",
    );
    const schemaBundlePath = join(
      sourceRoot,
      "migrations",
      "schema-bundle.json",
    );
    const original = "create table test (id integer);\n";
    const changed = "create table changed (id integer);\n";
    const originalDigest =
      "sha256:073a6add660a8ce214203964d294bb3600d53c35984babcde6e721adae3da911";
    const changedDigest = `sha256:${createHash("sha256")
      .update(changed)
      .digest("hex")}`;
    try {
      const runGit = (args: readonly string[]): void => {
        const result = Bun.spawnSync(["git", ...args], {
          cwd: repositoryRoot,
          env: buildSafeChildEnvironment({ PATH: process.env.PATH }),
          stdout: "ignore",
          stderr: "pipe",
        });
        if (result.exitCode !== 0) {
          throw new Error(`git fixture command failed: ${args.join(" ")}`);
        }
      };
      runGit(["init", "-q"]);
      await mkdir(join(sourceRoot, ".generated"), { recursive: true });
      await mkdir(join(sourceRoot, "migrations", "sql"), {
        recursive: true,
      });
      await mkdir(join(sourceRoot, "migrations", "takoform-overrides"));
      await writeFile(join(sourceRoot, "main.tf"), takoformModuleMain);
      await writeFile(join(sourceRoot, "outputs.tf"), takoformModuleOutputs);
      await writeFile(
        schemaBundlePath,
        JSON.stringify({
          apiVersion: "takosumi.resource-migrations/v1",
          engine: "sqlite",
          entries: [
            {
              name: "0001_init.sql",
              sha256: originalDigest,
              sql: original,
            },
          ],
        }),
      );
      await writeFile(
        join(sourceRoot, ".generated", "yurucommu-worker.js"),
        "export default {}\n",
      );
      await writeFile(migrationPath, original);
      runGit(["add", "."]);
      runGit([
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ]);

      const snapshot = await collectSourceProvenanceSnapshot(
        repositoryRoot,
        sourceRoot,
        buildSafeChildEnvironment({ PATH: process.env.PATH }),
        5_000,
      );
      const reportMigrations = snapshot.migrations.map(
        ({ path, bytes, sha256 }) => ({ path, bytes, sha256 }),
      );
      await writeFile(
        schemaBundlePath,
        JSON.stringify({
          apiVersion: "takosumi.resource-migrations/v1",
          engine: "sqlite",
          entries: [
            { name: "0001_init.sql", sha256: changedDigest, sql: changed },
          ],
        }),
      );
      await writeFile(migrationPath, changed);

      await copyCapsuleToWorkdir(sourceRoot, destination, {
        repositoryRoot,
        environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
        timeoutMs: 5_000,
        migrationInventory: snapshot.migrations,
      });
      expect(
        await readFile(
          join(destination, "migrations/sql/0001_init.sql"),
          "utf8",
        ),
      ).toBe(original);
      expect(await readFile(migrationPath, "utf8")).toBe(changed);
      expect(snapshot.provenance.migrations).toEqual(reportMigrations);
      expect(snapshot.provenance.migrations).toEqual([
        {
          path: "migrations/sql/0001_init.sql",
          bytes: new TextEncoder().encode(original).byteLength,
          sha256: originalDigest,
        },
      ]);
      expect(
        `sha256:${createHash("sha256")
          .update(
            await readFile(join(destination, "migrations/sql/0001_init.sql")),
          )
          .digest("hex")}`,
      ).toBe(snapshot.provenance.migrations[0]!.sha256);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("terminates a child that ignores TERM within the hard timeout", async () => {
    await expect(
      runBoundedChild(
        [
          "bun",
          "-e",
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
        ],
        {
          cwd: process.cwd(),
          environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
          timeoutMs: 30,
          termGraceMs: 20,
          label: "hang-child",
        },
      ),
    ).rejects.toThrow("hang-child exceeded 30ms and was terminated");
  });

  test("bounds a descendant that keeps inherited pipes open and still permits cleanup", async () => {
    const startedAt = performance.now();
    await expect(
      runBoundedChild(["sh", "-c", "sleep 2 & exit 0"], {
        cwd: process.cwd(),
        environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
        timeoutMs: 100,
        termGraceMs: 50,
        label: "descendant-held-pipe",
      }),
    ).rejects.toThrow("descendant-held-pipe exceeded 100ms and was terminated");
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    const calls: string[] = [];
    const cleanup = await cleanupTakoformV1E2E({
      mutationAttempted: true,
      destroy: async () => {
        calls.push("destroy");
      },
      verifyAbsence: async () => {
        calls.push("absence");
      },
      removeWorkdir: async () => {
        calls.push("remove");
      },
      workdir: "/tmp/e2e-recovery",
    });
    expect(cleanup.cleanupVerified).toBe(true);
    expect(calls).toEqual(["destroy", "absence", "remove"]);
  });

  test("drains bounded child output after the capture cap without canceling pipes", async () => {
    const result = await runBoundedChild(
      [
        "bun",
        "-e",
        'const value = "x".repeat(300000); process.stdout.write(value); process.stderr.write(value);',
      ],
      {
        cwd: process.cwd(),
        environment: buildSafeChildEnvironment({ PATH: process.env.PATH }),
        timeoutMs: 5_000,
        maxOutputBytes: 64,
        label: "large-output-child",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputTruncated).toBe(true);
    expect(new TextEncoder().encode(result.stdout).byteLength).toBe(64);
    expect(new TextEncoder().encode(result.stderr).byteLength).toBe(64);
  });

  test("keeps the provider schema cap above the real v3 schema size", () => {
    const resourceSchemas = Object.fromEntries(
      [...new Set(CURRENT_RESOURCE_TYPES)].map((kind) => [kind, {}]),
    );
    const value = {
      provider_schemas: {
        "registry.terraform.io/tako0614/takoform": {
          version: 1,
          resource_schemas: resourceSchemas,
          filler: "x".repeat(232_998),
        },
      },
    };
    const payload = JSON.stringify(value);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(
      232_998,
    );
    expect(PROVIDER_SCHEMA_OUTPUT_MAX_BYTES).toBeGreaterThan(
      new TextEncoder().encode(payload).byteLength,
    );
    expect(
      parseProviderSchemaProof(JSON.parse(payload), TAKOFORM_PROVIDER_VERSION)
        .resourceKinds,
    ).toEqual([...new Set(CURRENT_RESOURCE_TYPES)].sort());
  });

  test("uses the verified Provider copy for the -version handshake", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "takoform-provider-source-"),
    );
    const workdir = await mkdtemp(join(tmpdir(), "takoform-provider-copy-"));
    const providerPath = join(sourceRoot, "terraform-provider-takoform");
    const original = `#!/bin/sh\nif [ "$1" = "-version" ]; then printf "${TAKOFORM_PROVIDER_VERSION}\\n"; else exit 9; fi\n`;
    try {
      await writeFile(providerPath, original, { mode: 0o755 });
      await chmod(providerPath, 0o755);
      const providerSha256 = `sha256:${createHash("sha256").update(original).digest("hex")}`;
      const override = await prepareProviderDevOverride(
        { providerBinary: providerPath, providerSha256 },
        workdir,
      );
      expect(override.providerBinary).not.toBe(providerPath);
      expect(override.providerBinary).toContain("provider-dev-override");

      await writeFile(providerPath, '#!/bin/sh\nprintf "9.9.9\\n"\n', {
        mode: 0o755,
      });
      await chmod(providerPath, 0o755);
      await expect(
        readProviderVersion(
          override.providerBinary,
          buildSafeChildEnvironment({ PATH: process.env.PATH }),
          workdir,
          2_000,
        ),
      ).resolves.toBe(TAKOFORM_PROVIDER_VERSION);
      await expect(
        readProviderVersion(
          providerPath,
          buildSafeChildEnvironment({ PATH: process.env.PATH }),
          workdir,
          2_000,
        ),
      ).rejects.toThrow(`did not report version ${TAKOFORM_PROVIDER_VERSION}`);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
