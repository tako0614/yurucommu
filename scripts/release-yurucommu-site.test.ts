import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  disposeSealedSite,
  parseCanonicalProductionProject,
  parseWranglerReleaseAuthority,
  parsePagesDeployIdentity,
  parseCommittedSiteTree,
  requireCanonicalPublishedDeployment,
  sanitizeProviderOutput,
  sealCommittedSite,
  validateSealedSiteContent,
  verifyCurrentProductionBinding,
  verifyRepresentativeReadbacks,
  verifySealedSite,
} from "./release-yurucommu-site.mjs";

const repo = resolve(import.meta.dir, "..");

function fixtureOid(path: string): string {
  return createHash("sha1").update(path).digest("hex");
}

function sealSiteFixture(
  baseDirectory: string,
  overrides: Record<string, string> = {},
) {
  const files = siteFixtureFiles(overrides);
  const blobs = new Map(
    Object.entries(files).map(([path, contents]) => [
      fixtureOid(path),
      Buffer.from(contents),
    ]),
  );
  return sealCommittedSite({
    baseDirectory,
    commit: "c".repeat(40),
    entries: Object.keys(files).map((path) => ({
      oid: fixtureOid(path),
      path,
    })),
    readBlob(oid) {
      const bytes = blobs.get(oid);
      if (!bytes) throw new Error(`missing fixture blob ${oid}`);
      return bytes;
    },
  });
}

function siteFixtureFiles(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    _headers: `
/ns/context.jsonld
  Content-Type: application/ld+json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=3600
`,
    "index.html": `<!doctype html><link rel="stylesheet" href="/styles.css"><a href="/help/">help</a><a href="/specs/">specs</a><a href="https://app.takosumi.com/install?kind=capsule-source-options&amp;git=https%3A%2F%2Fgithub.com%2Ftako0614%2Fyurucommu.git&amp;path=install-options.json">install</a>`,
    "help/index.html": `<!doctype html><a href="/help/getting-started.html">start</a>`,
    "help/getting-started.html": `<!doctype html><a href="/">home</a>`,
    "specs/index.html": `<!doctype html><a href="/specs/topic.html">topic</a>`,
    "specs/topic.html": `<!doctype html><a href="/ns/context.jsonld">context</a>`,
    "ns/context.jsonld": `{"@context":{"name":"https://example.test/name"}}\n`,
    "styles.css": "body { color: black; }\n",
    ...overrides,
  };
}

function checkedSpawn(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed: ${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.toString().trim();
}

type ReleaseHarnessScenario =
  | "success"
  | "pre-touch-failure"
  | "credential-output-failure"
  | "ambiguous-after-touch"
  | "post-touch-readback"
  | "post-touch-custody-mutation";

async function runOwnerReleaseHarness(scenario: ReleaseHarnessScenario) {
  const base = await mkdtemp(join(tmpdir(), "yurucommu-site-owner-release-"));
  const root = join(base, "repo");
  const origin = join(base, "origin.git");
  const logPath = join(base, "wrangler-log.jsonl");
  const statePath = join(base, "published");
  const preloadPath = join(base, "fake-readback.ts");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "node_modules", "wrangler", "wrangler-dist"), {
    recursive: true,
  });

  const files = siteFixtureFiles();
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, "site", path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "yurucommu-site-release-harness",
          private: true,
          type: "module",
          scripts: {
            deploy: "bun scripts/deploy.mjs",
            check: "true",
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(root, "scripts", "deploy.mjs"),
      await readFile(resolve(repo, "scripts/deploy.mjs"), "utf8"),
    ),
    writeFile(
      join(root, "scripts", "release-yurucommu-site.mjs"),
      await readFile(
        resolve(repo, "scripts/release-yurucommu-site.mjs"),
        "utf8",
      ),
    ),
  ]);

  const fakeWrangler = `
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args }) + "\\n");
const current = {
  Id: "12345678-1234-4abc-8def-1234567890ab",
  Deployment: "https://12345678.yurucommu-website.pages.dev",
};
if (args[0] === "whoami" && args[1] === "--json") {
  if (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY) {
    console.error("ambient Cloudflare credentials reached the owner auth probe");
    process.exit(1);
  }
  console.log(JSON.stringify({
    loggedIn: true,
    authType: "OAuth Token",
    email: "release@example.test",
    accounts: [{ id: "a".repeat(32), name: "Yurucommu owner" }],
    tokenPermissions: ["account:read", "pages:write"],
  }));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token" && args[2] === "--json") {
  if (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY) {
    console.error("ambient Cloudflare credentials reached token acquisition");
    process.exit(1);
  }
  if (process.env.FAKE_SCENARIO === "credential-output-failure") {
    console.log(JSON.stringify({ type: "oauth", token: "fake-cloudflare-api-token-for-tests" }));
    console.error("Authorization: Bearer fake-cloudflare-api-token-for-tests");
    process.exit(1);
  }
  console.log(JSON.stringify({ type: "oauth", token: "fake-cloudflare-api-token-for-tests" }));
  process.exit(0);
}
if (args[0] === "pages" && args[1] === "deploy") {
  const directory = args[2];
  const index = readFileSync(directory + "/index.html");
  appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ uploadedIndex: index.toString("base64"), directory }) + "\\n");
  if (process.env.FAKE_SCENARIO === "ambiguous-after-touch") {
    console.error("simulated lost acknowledgement after upload began");
    process.exit(1);
  }
  writeFileSync(process.env.FAKE_STATE, "published\\n");
  const summary = {
    type: "pages-deploy",
    version: 1,
    pages_project: "yurucommu-website",
    deployment_id: current.Id,
    url: current.Deployment,
  };
  const detail = {
    type: "pages-deploy-detailed",
    version: 1,
    pages_project: "yurucommu-website",
    deployment_id: current.Id,
    url: current.Deployment,
    alias: "https://main.yurucommu-website.pages.dev",
    environment: "production",
    production_branch: "main",
    deployment_trigger: { metadata: { commit_hash: process.env.FAKE_COMMIT } },
  };
  appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify(summary) + "\\n" + JSON.stringify(detail) + "\\n");
  if (process.env.FAKE_SCENARIO === "post-touch-custody-mutation") {
    chmodSync(directory + "/index.html", 0o600);
    writeFileSync(directory + "/index.html", "mutated after upload\\n");
  }
  console.log("simulated Pages deployment complete");
  process.exit(0);
}
console.error("unexpected fake Wrangler command: " + args.join(" "));
process.exit(1);
`;
  await writeFile(
    join(root, "node_modules", "wrangler", "wrangler-dist", "cli.js"),
    fakeWrangler,
  );

  await writeFile(
    preloadPath,
    `
import { Buffer } from "node:buffer";
import { appendFileSync, existsSync } from "node:fs";
const files = new Map(Object.entries(JSON.parse(process.env.FAKE_SITE_FILES)).map(([path, value]) => [path, Buffer.from(value, "base64")]));
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin === "https://api.cloudflare.com") {
    appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ api: "canonical-project", path: url.pathname }) + "\\n");
    if (process.env.FAKE_SCENARIO === "pre-touch-failure") {
      return new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } });
    }
    if (url.pathname !== "/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pages/projects/yurucommu-website" || init.headers?.authorization !== "Bearer fake-cloudflare-api-token-for-tests") {
      return new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
    }
    const published = existsSync(process.env.FAKE_STATE);
    const id = published ? "12345678-1234-4abc-8def-1234567890ab" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const deploymentUrl = published ? "https://12345678.yurucommu-website.pages.dev" : "https://aaaaaaaa.yurucommu-website.pages.dev";
    const commit = published ? process.env.FAKE_COMMIT : "7654321098765432109876543210987654321098";
    return Response.json({
      success: true,
      errors: [],
      result: {
        id: "11111111-2222-4333-8444-555555555555",
        name: "yurucommu-website",
        production_branch: "main",
        domains: ["yurucommu-website.pages.dev", "yurucommu.com"],
        source: null,
        canonical_deployment: {
          id,
          project_id: "11111111-2222-4333-8444-555555555555",
          project_name: "yurucommu-website",
          environment: "production",
          url: deploymentUrl,
          aliases: ["https://main.yurucommu-website.pages.dev"],
          deployment_trigger: { metadata: { branch: "main", commit_hash: commit } },
          latest_stage: { name: "deploy", status: "success" },
          is_skipped: false,
        },
      },
    });
  }
  const body = files.get(url.pathname);
  if (!body) return new Response("missing", { status: 404 });
  if (process.env.FAKE_SCENARIO === "post-touch-readback" && existsSync(process.env.FAKE_STATE) && url.origin === "https://yurucommu.com" && url.pathname === "/specs/") {
    return new Response("stale\\n", { status: 200, headers: { "content-type": "text/html" } });
  }
  const jsonld = url.pathname.endsWith(".jsonld");
  const headers = { "content-type": jsonld ? "application/ld+json" : "text/html; charset=utf-8" };
  if (jsonld) {
    headers["access-control-allow-origin"] = "*";
    headers["cache-control"] = "public, max-age=3600";
  }
  return new Response(body, { status: 200, headers });
};
globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 0; };
`,
  );

  checkedSpawn(["git", "init", "--bare", origin], base);
  checkedSpawn(["git", "init", "-b", "main"], root);
  checkedSpawn(["git", "config", "user.name", "Release Test"], root);
  checkedSpawn(["git", "config", "user.email", "release@example.test"], root);
  checkedSpawn(["git", "add", "."], root);
  checkedSpawn(["git", "commit", "-m", "reviewed site fixture"], root);
  checkedSpawn(["git", "remote", "add", "origin", origin], root);
  checkedSpawn(["git", "push", "-u", "origin", "main"], root);
  const commit = checkedSpawn(["git", "rev-parse", "HEAD"], root);
  checkedSpawn(["git", "checkout", "--detach", commit], root);
  const publicFiles = Object.fromEntries(
    [
      ["/", files["index.html"]],
      ["/help/", files["help/index.html"]],
      ["/specs/", files["specs/index.html"]],
      ["/ns/context.jsonld", files["ns/context.jsonld"]],
    ].map(([path, contents]) => [
      path,
      Buffer.from(contents as string).toString("base64"),
    ]),
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--preload",
      preloadPath,
      join(root, "scripts", "deploy.mjs"),
      "yurucommu-site",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        FAKE_COMMIT: commit,
        FAKE_SCENARIO: scenario,
        FAKE_SITE_FILES: JSON.stringify(publicFiles),
        FAKE_STATE: statePath,
        FAKE_WRANGLER_LOG: logPath,
        CLOUDFLARE_API_TOKEN: "ambient-token-must-not-be-used",
        CF_API_KEY: "ambient-key-must-not-be-used",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    log: existsSync(logPath) ? await readFile(logPath, "utf8") : "",
  };
  await rm(base, { recursive: true, force: true });
  return output;
}

describe("yurucommu.com owner release surface", () => {
  test("is exposed only through the repository deploy entrypoint", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repo, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts.deploy).toBe("bun scripts/deploy.mjs");
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (name === "deploy") continue;
      expect(command).not.toMatch(
        /wrangler\s+pages\s+(?:deploy|deployment create)/u,
      );
    }

    const probe = Bun.spawnSync(
      [process.execPath, resolve(repo, "scripts/deploy.mjs"), "--contract"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );
    expect(probe.exitCode, probe.stderr.toString()).toBe(0);
    const contract = JSON.parse(probe.stdout.toString()) as {
      kind: string;
      surfaces: Array<{
        surface: string;
        target: string;
        triggers: string[];
        requiresEnv: string[];
        obligations: Record<string, string>;
      }>;
    };
    expect(contract.kind).toBe("takos.deploy-contract@v2");
    const site = contract.surfaces.find(
      (surface) => surface.surface === "yurucommu-site",
    );
    expect(site).toMatchObject({
      target: "cloudflare-pages:yurucommu-website",
      triggers: [],
      requiresEnv: [],
    });
    expect(site?.obligations.provenance).toContain(
      "clean reviewed commit equal to its freshly fetched origin/main",
    );
    expect(site?.obligations.provenance).not.toContain(
      "clean reviewed main commit",
    );
    expect(site?.obligations.provenance).toContain("owner Wrangler OAuth");
    expect(site?.obligations.provenance).toContain("canonical_deployment");
    expect(site?.obligations.provenance).toContain("single-link");
    expect(site?.obligations.provenance).toContain("decodable UTF-8");
    expect(site?.obligations["post-conditions"]).toContain(
      "canonical_deployment",
    );
    expect(site?.obligations["post-conditions"]).not.toContain(
      "deployment list",
    );
    for (const obligation of [
      "provenance",
      "post-conditions",
      "reversal",
      "failure-handling",
    ]) {
      expect(site?.obligations[obligation]).toBeTruthy();
    }
  });

  test("accepts only regular committed site blobs with confined paths", () => {
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    const parsed = parseCommittedSiteTree(
      Buffer.from(
        `100644 blob ${first}\tsite/index.html\0` +
          `100644 blob ${second}\tsite/ns/context.jsonld\0`,
      ),
    );
    expect(parsed).toEqual([
      { oid: first, path: "index.html" },
      { oid: second, path: "ns/context.jsonld" },
    ]);

    for (const tree of [
      `120000 blob ${first}\tsite/index.html\0`,
      `100755 blob ${first}\tsite/index.html\0`,
      `100644 blob ${first}\tsite/../escape.html\0`,
      `100644 blob ${first}\tsite/nested\\escape.html\0`,
      `100644 blob ${first}\tsite/index.html\0` +
        `100644 blob ${second}\tsite/index.html\0`,
    ]) {
      expect(() => parseCommittedSiteTree(Buffer.from(tree))).toThrow();
    }
  });

  test("seals exact committed blobs and detects post-seal mutation", async () => {
    const base = await mkdtemp(join(tmpdir(), "yurucommu-site-test-"));
    const indexOid = "a".repeat(40);
    const assetOid = "b".repeat(40);
    const blobs = new Map([
      [indexOid, Buffer.from("<!doctype html><title>fixture</title>\n")],
      [assetOid, Buffer.from([0, 1, 2, 3])],
    ]);
    const candidate = sealCommittedSite({
      baseDirectory: base,
      commit: "c".repeat(40),
      entries: [
        { oid: indexOid, path: "index.html" },
        { oid: assetOid, path: "assets/pixel.bin" },
      ],
      readBlob(oid) {
        const bytes = blobs.get(oid);
        if (!bytes) throw new Error(`missing fixture blob ${oid}`);
        return bytes;
      },
    });

    try {
      expect(
        await readFile(join(candidate.siteRoot, "index.html"), "utf8"),
      ).toBe("<!doctype html><title>fixture</title>\n");
      expect(
        (await lstat(join(candidate.siteRoot, "index.html"))).mode & 0o777,
      ).toBe(0o400);
      expect(
        (await lstat(join(candidate.siteRoot, "assets"))).mode & 0o777,
      ).toBe(0o500);
      expect(candidate.manifest.files).toHaveLength(2);
      expect(candidate.treeDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(() => verifySealedSite(candidate)).not.toThrow();

      const outsideLink = join(base, "outside-index-hardlink");
      await link(join(candidate.siteRoot, "index.html"), outsideLink);
      expect(() => verifySealedSite(candidate)).toThrow("multiple hard links");
      await rm(outsideLink);
      expect(() => verifySealedSite(candidate)).not.toThrow();

      await chmod(join(candidate.siteRoot, "index.html"), 0o600);
      await writeFile(join(candidate.siteRoot, "index.html"), "changed\n");
      expect(() => verifySealedSite(candidate)).toThrow(
        "sealed candidate changed",
      );
    } finally {
      disposeSealedSite(candidate);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("binds Wrangler structured output to one full source commit", () => {
    const commit = "d".repeat(40);
    const deploymentId = "12345678-1234-4abc-8def-1234567890ab";
    const url = "https://12345678.yurucommu-website.pages.dev";
    const output = [
      {
        type: "wrangler-session",
        version: 1,
        wrangler_version: "4.107.0",
      },
      {
        type: "pages-deploy",
        version: 1,
        pages_project: "yurucommu-website",
        deployment_id: deploymentId,
        url,
      },
      {
        type: "pages-deploy-detailed",
        version: 1,
        pages_project: "yurucommu-website",
        deployment_id: deploymentId,
        url,
        alias: "https://main.yurucommu-website.pages.dev",
        environment: "production",
        production_branch: "main",
        deployment_trigger: { metadata: { commit_hash: commit } },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    expect(parsePagesDeployIdentity(output, { commit })).toEqual({
      deploymentId,
      deploymentUrl: url,
      commit,
      environment: "production",
      productionBranch: "main",
    });
    expect(() =>
      parsePagesDeployIdentity(output.replace(commit, "e".repeat(40)), {
        commit,
      }),
    ).toThrow("commit identity");
    expect(() =>
      parsePagesDeployIdentity(output.replace(deploymentId, "not-a-uuid"), {
        commit,
      }),
    ).toThrow();
  });

  test("uses the Pages canonical deployment rather than deployment-list order", () => {
    const canonicalId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const canonical = {
      id: canonicalId,
      project_id: "11111111-2222-4333-8444-555555555555",
      project_name: "yurucommu-website",
      environment: "production",
      url: "https://aaaaaaaa.yurucommu-website.pages.dev",
      aliases: ["https://main.yurucommu-website.pages.dev"],
      deployment_trigger: {
        metadata: {
          branch: "main",
          commit_hash: "0123456789abcdef0123456789abcdef01234567",
        },
      },
      latest_stage: { name: "deploy", status: "success" },
      is_skipped: false,
    };
    const response = JSON.stringify({
      success: true,
      errors: [],
      result: {
        id: canonical.project_id,
        name: "yurucommu-website",
        production_branch: "main",
        domains: ["yurucommu-website.pages.dev", "yurucommu.com"],
        canonical_deployment: canonical,
        latest_deployment: {
          ...canonical,
          id: "99999999-8888-4777-8666-555555555555",
          environment: "preview",
          url: "https://99999999.yurucommu-website.pages.dev",
        },
      },
    });
    expect(parseCanonicalProductionProject(response)).toEqual({
      authority: "cloudflare-pages-project.canonical_deployment",
      project: "yurucommu-website",
      projectId: canonical.project_id,
      deploymentId: canonicalId,
      deploymentUrl: canonical.url,
      branch: "main",
      source: "0123456789abcdef0123456789abcdef01234567",
      publicOrigin: "https://yurucommu.com",
      automaticProductionDeployments: "not-configured",
    });
    expect(() =>
      parseCanonicalProductionProject(
        response.replace('"status":"success"', '"status":"active"'),
      ),
    ).toThrow("successful production deployment");
    expect(() =>
      parseCanonicalProductionProject(
        response.replace('"canonical_deployment":', '"not_canonical":'),
      ),
    ).toThrow("canonical_deployment");

    const automatic = JSON.parse(response) as {
      result: Record<string, unknown>;
    };
    automatic.result.source = {
      type: "github",
      config: {
        production_deployments_enabled: true,
        production_branch: "main",
      },
    };
    expect(() =>
      parseCanonicalProductionProject(JSON.stringify(automatic)),
    ).toThrow("automatic production deployments");

    const disabled = structuredClone(automatic);
    (
      disabled.result.source as {
        config: { production_deployments_enabled: boolean };
      }
    ).config.production_deployments_enabled = false;
    expect(parseCanonicalProductionProject(JSON.stringify(disabled))).toEqual(
      expect.objectContaining({ deploymentId: canonicalId }),
    );

    const unknownPriorSource = structuredClone(
      JSON.parse(response) as {
        result: { canonical_deployment: typeof canonical };
      },
    );
    unknownPriorSource.result.canonical_deployment.deployment_trigger.metadata.commit_hash =
      "unresolved-direct-upload-source";
    expect(
      parseCanonicalProductionProject(JSON.stringify(unknownPriorSource)),
    ).toEqual(expect.objectContaining({ source: null }));
  });

  test("strictly binds one Wrangler OAuth account without exposing the token", () => {
    const token = "opaque-wrangler-oauth-token-for-tests";
    const whoami = JSON.stringify({
      loggedIn: true,
      authType: "OAuth Token",
      email: "release@example.test",
      accounts: [{ id: "a".repeat(32), name: "Yurucommu owner" }],
      tokenPermissions: ["account:read", "pages:write"],
    });
    expect(
      parseWranglerReleaseAuthority(
        whoami,
        JSON.stringify({ type: "oauth", token }),
      ),
    ).toEqual({ accountId: "a".repeat(32), token });
    expect(() =>
      parseWranglerReleaseAuthority(
        whoami.replace(
          '"accounts":[',
          `"accounts":[{"id":"${"b".repeat(32)}","name":"Other"},`,
        ),
        JSON.stringify({ type: "oauth", token }),
      ),
    ).toThrow("exactly one account");
    expect(() =>
      parseWranglerReleaseAuthority(
        whoami,
        JSON.stringify({ type: "api_key", key: token, email: "x@test" }),
      ),
    ).toThrow("OAuth token");
    expect(() =>
      parseWranglerReleaseAuthority(
        whoami,
        JSON.stringify({ type: "oauth", token, extra: token }),
      ),
    ).toThrow("unexpected fields");
  });

  test("redacts opaque authorization and Cloudflare credentials from diagnostics", () => {
    const secrets = [
      "opaque-bearer-without-a-provider-prefix",
      "QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
      "generic-token-sent-by-an-upstream",
      "random_cloudflare_token_value",
      "random-cloudflare-global-key",
      "header-key-with-no-recognizable-prefix",
      "query-token-value",
    ];
    const diagnostic = [
      `Authorization: Bearer ${secrets[0]}`,
      `authorization = Basic ${secrets[1]}`,
      `Bearer ${secrets[2]}`,
      `CLOUDFLARE_API_TOKEN=${secrets[3]}`,
      `"CF_API_KEY": "${secrets[4]}"`,
      `X-Auth-Key: ${secrets[5]}`,
      `https://api.cloudflare.test/resource?api_token=${secrets[6]}&page=1`,
      "safe deployment identity 12345678-1234-4abc-8def-1234567890ab",
    ].join("\n");
    const sanitized = sanitizeProviderOutput(diagnostic);
    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain(
      "safe deployment identity 12345678-1234-4abc-8def-1234567890ab",
    );
  });

  test("redacts complete or truncated accepted PEM diagnostics without consuming unrelated text", () => {
    const diagnostic = [
      "safe prefix",
      "-----BEGIN CERTIFICATE-----",
      "public-but-provider-controlled-material",
      "-----END CERTIFICATE-----",
      "safe middle",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "first-secret-line",
      "second-secret-line",
      "-----END OPENSSH PRIVATE KEY-----",
      "-----BEGIN RELEASE NOTES-----",
      "ordinary diagnostic text",
      "-----END RELEASE NOTES-----",
      "safe before truncated block",
      "-----BEGIN PRIVATE KEY-----",
      "partial-secret-material",
    ].join("\n");

    expect(sanitizeProviderOutput(diagnostic)).toBe(
      [
        "safe prefix",
        "[REDACTED PEM]",
        "safe middle",
        "[REDACTED PEM]",
        "-----BEGIN RELEASE NOTES-----",
        "ordinary diagnostic text",
        "-----END RELEASE NOTES-----",
        "safe before truncated block",
        "[REDACTED PEM]",
      ].join("\n"),
    );

    const bounded = sanitizeProviderOutput(
      `${"safe diagnostic line\n".repeat(3_000)}-----BEGIN RSA PRIVATE KEY-----\n${"secret\n".repeat(3_200)}`,
    );
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(64 * 1024);
    expect(bounded).not.toContain("secret");

    const expandingRedactions = sanitizeProviderOutput(
      "Bearer x\n".repeat(8_000),
    );
    expect(Buffer.byteLength(expandingRedactions)).toBeLessThanOrEqual(
      64 * 1024,
    );
  });

  test("validates required pages, headers, JSON, and every internal link in custody", async () => {
    const base = await mkdtemp(join(tmpdir(), "yurucommu-site-content-test-"));
    const candidate = sealSiteFixture(base);
    try {
      const checked = validateSealedSiteContent(candidate);
      expect(checked.representatives.map((entry) => entry.urlPath)).toEqual([
        "/",
        "/help/",
        "/specs/",
        "/ns/context.jsonld",
      ]);
      expect(checked.internalReferences).toBe(7);
      expect(checked.representatives[3]?.headers).toEqual({
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=3600",
        "content-type": "application/ld+json",
      });
      expect(checked.installCta).toEqual({
        href: "https://app.takosumi.com/install?kind=capsule-source-options&git=https%3A%2F%2Fgithub.com%2Ftako0614%2Fyurucommu.git&path=install-options.json",
        occurrences: 1,
      });
    } finally {
      disposeSealedSite(candidate);
      await rm(base, { recursive: true, force: true });
    }

    const brokenBase = await mkdtemp(
      join(tmpdir(), "yurucommu-site-content-broken-test-"),
    );
    const broken = sealSiteFixture(brokenBase, {
      "help/index.html": `<!doctype html><a href="/help/missing.html">missing</a>`,
    });
    try {
      expect(() => validateSealedSiteContent(broken)).toThrow(
        "missing internal reference",
      );
    } finally {
      disposeSealedSite(broken);
      await rm(brokenBase, { recursive: true, force: true });
    }

    const misplacedCtaBase = await mkdtemp(
      join(tmpdir(), "yurucommu-site-cta-location-test-"),
    );
    const installHref =
      "https://app.takosumi.com/install?kind=capsule-source-options&amp;git=https%3A%2F%2Fgithub.com%2Ftako0614%2Fyurucommu.git&amp;path=install-options.json";
    const misplacedCta = sealSiteFixture(misplacedCtaBase, {
      "index.html": `<!doctype html><link rel="stylesheet" href="/styles.css"><a href="/help/">help</a><a href="/specs/">specs</a>`,
      "help/index.html": `<!doctype html><a href="${installHref}">install</a><a href="/help/getting-started.html">start</a>`,
    });
    try {
      expect(() => validateSealedSiteContent(misplacedCta)).toThrow(
        "home page is missing",
      );
    } finally {
      disposeSealedSite(misplacedCta);
      await rm(misplacedCtaBase, { recursive: true, force: true });
    }
  });

  test("scans every UTF-8 publishable asset for credential-shaped content", async () => {
    for (const [path, contents] of [
      ["assets/app.js", `const CLOUDFLARE_API_TOKEN = "js-test-secret";`],
      ["assets/chunk.mjs", `export const CF_API_KEY = "mjs-test-secret";`],
      [
        "assets/app.js.map",
        JSON.stringify({
          version: 3,
          sourcesContent: ["CLOUDFLARE_API_TOKEN=map-test-secret"],
        }),
      ],
      ["config.yaml", "CLOUDFLARE_API_KEY: yaml-test-secret\n"],
      ["assets/extensionless", "CF_API_TOKEN=extensionless-test-secret\n"],
    ] as const) {
      const base = await mkdtemp(join(tmpdir(), "yurucommu-site-text-scan-"));
      const candidate = sealSiteFixture(base, { [path]: contents });
      try {
        expect(() => validateSealedSiteContent(candidate), path).toThrow(
          `credential-shaped content is not publishable: ${path}`,
        );
      } finally {
        disposeSealedSite(candidate);
        await rm(base, { recursive: true, force: true });
      }
    }
  });

  test("the complete owner test covers the current site/ byte inventory", async () => {
    const siteRoot = resolve(repo, "site");
    const paths: string[] = [];
    const walk = async (directory: string, prefix = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          throw new Error(`site fixture contains a symlink: ${path}`);
        }
        if (entry.isDirectory()) await walk(join(directory, entry.name), path);
        else if (entry.isFile()) paths.push(path);
        else throw new Error(`site fixture contains a special entry: ${path}`);
      }
    };
    await walk(siteRoot);
    const blobs = new Map<string, Buffer>();
    const entries = [];
    for (const path of paths.sort()) {
      const bytes = await readFile(join(siteRoot, ...path.split("/")));
      const oid = createHash("sha1").update(path).update(bytes).digest("hex");
      blobs.set(oid, bytes);
      entries.push({ path, oid });
    }
    const base = await mkdtemp(join(tmpdir(), "yurucommu-current-site-test-"));
    const candidate = sealCommittedSite({
      baseDirectory: base,
      commit: "c".repeat(40),
      entries,
      readBlob(oid) {
        const bytes = blobs.get(oid);
        if (!bytes) throw new Error(`missing current-site blob ${oid}`);
        return bytes;
      },
    });
    try {
      const checked = validateSealedSiteContent(candidate);
      expect(candidate.manifest.files.length).toBe(paths.length);
      expect(checked.installCta.occurrences).toBe(2);
      expect(checked.internalReferences).toBeGreaterThan(50);
    } finally {
      disposeSealedSite(candidate);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("requires the published identity to become canonical after upload", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const identity = {
      deploymentId: "12345678-1234-4abc-8def-1234567890ab",
      deploymentUrl: "https://12345678.yurucommu-website.pages.dev",
      commit,
      environment: "production",
      productionBranch: "main",
    } as const;
    const authority = {
      authority: "cloudflare-pages-project.canonical_deployment",
      project: "yurucommu-website",
      projectId: "11111111-2222-4333-8444-555555555555",
      deploymentId: identity.deploymentId,
      deploymentUrl: identity.deploymentUrl,
      branch: "main",
      source: commit,
      publicOrigin: "https://yurucommu.com",
      automaticProductionDeployments: "not-configured",
    } as const;
    expect(requireCanonicalPublishedDeployment(authority, identity)).toEqual(
      authority,
    );
    expect(() =>
      requireCanonicalPublishedDeployment(
        { ...authority, source: "f".repeat(40) },
        identity,
      ),
    ).toThrow("not the canonical production deployment");
  });

  test("reads exact representative bytes and headers from both public origins", async () => {
    const contents = new Map([
      ["/", Buffer.from("home\n")],
      ["/help/", Buffer.from("help\n")],
      ["/specs/", Buffer.from("specs\n")],
      ["/ns/context.jsonld", Buffer.from('{"@context":{}}\n')],
    ]);
    const representatives = [...contents].map(([urlPath, bytes]) => ({
      urlPath,
      file:
        urlPath === "/"
          ? "index.html"
          : urlPath.endsWith("/")
            ? `${urlPath.slice(1)}index.html`
            : urlPath.slice(1),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: urlPath.endsWith(".jsonld")
        ? "application/ld+json"
        : "text/html",
      ...(urlPath.endsWith(".jsonld")
        ? {
            headers: {
              "access-control-allow-origin": "*",
              "cache-control": "public, max-age=3600",
              "content-type": "application/ld+json",
            },
          }
        : {}),
    }));
    const origins = [
      "https://12345678.yurucommu-website.pages.dev",
      "https://yurucommu.com",
    ];
    const fetched: string[] = [];
    const fetchExact = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      fetched.push(`${url.origin}${url.pathname}`);
      const body = contents.get(url.pathname);
      if (!body) return new Response("missing", { status: 404 });
      const headers: Record<string, string> = {
        "content-type": url.pathname.endsWith(".jsonld")
          ? "application/ld+json"
          : "text/html; charset=utf-8",
      };
      if (url.pathname.endsWith(".jsonld")) {
        headers["access-control-allow-origin"] = "*";
        headers["cache-control"] = "public, max-age=3600";
      }
      return new Response(body, { status: 200, headers });
    };
    const result = await verifyRepresentativeReadbacks({
      origins,
      representatives,
      treeDigest: "a".repeat(64),
      fetchImpl: fetchExact,
      attempts: 1,
      sleep: async () => {},
    });
    expect(result).toHaveLength(8);
    expect(new Set(fetched)).toEqual(
      new Set(
        origins.flatMap((origin) =>
          [...contents.keys()].map((path) => `${origin}${path}`),
        ),
      ),
    );

    await expect(
      verifyRepresentativeReadbacks({
        origins,
        representatives,
        treeDigest: "a".repeat(64),
        fetchImpl: async (input) => {
          const response = await fetchExact(input);
          const url = new URL(String(input));
          if (
            url.origin === "https://yurucommu.com" &&
            url.pathname === "/specs/"
          ) {
            return new Response("stale\n", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          return response;
        },
        attempts: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow("representative readback did not converge");
  });

  test("binds current custom-domain bytes to the canonical production URL", async () => {
    const home = Buffer.from("current home\n");
    const context = Buffer.from('{"@context":{}}\n');
    const contents = new Map([
      ["/", home],
      ["/ns/context.jsonld", context],
    ]);
    const representatives = [
      {
        urlPath: "/",
        file: "index.html",
        bytes: 1,
        sha256: "candidate-not-used-for-prestate",
        contentType: "text/html",
      },
      {
        urlPath: "/ns/context.jsonld",
        file: "ns/context.jsonld",
        bytes: 1,
        sha256: "candidate-not-used-for-prestate",
        contentType: "application/ld+json",
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=3600",
          "content-type": "application/ld+json",
        },
      },
    ];
    const authority = {
      authority: "cloudflare-pages-project.canonical_deployment",
      project: "yurucommu-website",
      projectId: "11111111-2222-4333-8444-555555555555",
      deploymentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      deploymentUrl: "https://aaaaaaaa.yurucommu-website.pages.dev",
      branch: "main",
      source: null,
      publicOrigin: "https://yurucommu.com",
      automaticProductionDeployments: "not-configured",
    } as const;
    const exactFetch = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const body = contents.get(url.pathname);
      if (!body) return new Response("missing", { status: 404 });
      const jsonld = url.pathname.endsWith(".jsonld");
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": jsonld
            ? "application/ld+json"
            : "text/html; charset=utf-8",
          ...(jsonld
            ? {
                "access-control-allow-origin": "*",
                "cache-control": "public, max-age=3600",
              }
            : {}),
        },
      });
    };
    const binding = await verifyCurrentProductionBinding({
      authority,
      representatives,
      fetchImpl: exactFetch,
      attempts: 1,
      sleep: async () => {},
    });
    expect(binding.readbacks).toHaveLength(2);
    expect(binding.readbacks[0]).toMatchObject({
      urlPath: "/",
      status: "CURRENT_CANONICAL_BYTES",
      bytes: home.length,
    });
    expect(binding.bindingDigest).toMatch(/^[0-9a-f]{64}$/u);

    await expect(
      verifyCurrentProductionBinding({
        authority,
        representatives,
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.origin === "https://yurucommu.com" && url.pathname === "/") {
            return new Response("stale custom domain\n", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          return exactFetch(input);
        },
        attempts: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow("does not match canonical_deployment");
  });

  test("publishes once and classifies every failure side of the touch boundary", async () => {
    const deployCalls = (log: string) =>
      log
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args?: string[] })
        .filter(
          (entry) =>
            entry.args?.[0] === "pages" && entry.args?.[1] === "deploy",
        );
    const canonicalReads = (log: string) =>
      log
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { api?: string })
        .filter((entry) => entry.api === "canonical-project");
    const wranglerCalls = (log: string, expected: string[]) =>
      log
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args?: string[] })
        .filter((entry) =>
          expected.every((argument, index) => entry.args?.[index] === argument),
        );

    const success = await runOwnerReleaseHarness("success");
    expect(success.exitCode, `${success.stdout}\n${success.stderr}`).toBe(0);
    expect(deployCalls(success.log)).toHaveLength(1);
    expect(deployCalls(success.log)[0]?.args?.[2]).toBe("/proc/self/fd/3");
    expect(success.stdout).toContain('"status": "PUBLISHED"');
    expect(success.stdout).toContain('"siteTreeDigest"');
    expect(success.stdout).toContain('"previousDeployment"');
    expect(success.stdout).toContain(
      '"authority": "cloudflare-pages-project.canonical_deployment"',
    );
    expect(success.stdout).toContain('"preMutationBindingDigest"');
    expect(success.stdout).toContain('"deploymentId"');
    expect(success.stdout).toContain('"sourceRef": "detached HEAD"');
    expect(success.stdout).toContain('"branch": "main"');
    expect(success.stdout).toContain('"ctaReadback"');
    expect(success.stdout).toContain('"status": "EXPECTED_CTA_BYTES"');
    expect(canonicalReads(success.log).length).toBeGreaterThanOrEqual(3);
    expect(wranglerCalls(success.log, ["whoami", "--json"])).toHaveLength(1);
    expect(
      wranglerCalls(success.log, ["auth", "token", "--json"]),
    ).toHaveLength(1);
    expect(`${success.stdout}\n${success.stderr}`).not.toContain(
      "fake-cloudflare-api-token-for-tests",
    );
    expect(`${success.stdout}\n${success.stderr}`).not.toContain(
      "ambient-token-must-not-be-used",
    );

    const preTouch = await runOwnerReleaseHarness("pre-touch-failure");
    expect(preTouch.exitCode).toBe(1);
    expect(deployCalls(preTouch.log)).toHaveLength(0);
    expect(`${preTouch.stdout}\n${preTouch.stderr}`).toContain(
      "PRE_TOUCH_FAILURE",
    );

    const credentialFailure = await runOwnerReleaseHarness(
      "credential-output-failure",
    );
    expect(credentialFailure.exitCode).toBe(1);
    expect(deployCalls(credentialFailure.log)).toHaveLength(0);
    expect(
      `${credentialFailure.stdout}\n${credentialFailure.stderr}`,
    ).toContain("PRE_TOUCH_FAILURE");
    expect(
      `${credentialFailure.stdout}\n${credentialFailure.stderr}`,
    ).not.toContain("fake-cloudflare-api-token-for-tests");

    const ambiguous = await runOwnerReleaseHarness("ambiguous-after-touch");
    expect(ambiguous.exitCode).toBe(1);
    expect(deployCalls(ambiguous.log)).toHaveLength(1);
    expect(`${ambiguous.stdout}\n${ambiguous.stderr}`).toContain(
      "AMBIGUOUS_AFTER_TOUCH",
    );
    expect(`${ambiguous.stdout}\n${ambiguous.stderr}`).toContain(
      "Do not retry",
    );

    const readback = await runOwnerReleaseHarness("post-touch-readback");
    expect(readback.exitCode).toBe(1);
    expect(deployCalls(readback.log)).toHaveLength(1);
    expect(`${readback.stdout}\n${readback.stderr}`).toContain(
      "POST_TOUCH_FAILURE",
    );

    const custody = await runOwnerReleaseHarness("post-touch-custody-mutation");
    expect(custody.exitCode).toBe(1);
    expect(deployCalls(custody.log)).toHaveLength(1);
    expect(`${custody.stdout}\n${custody.stderr}`).toContain(
      "POST_TOUCH_FAILURE",
    );
  }, 30_000);
});
