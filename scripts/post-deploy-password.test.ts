import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const PASSWORD_ENV = "YURUCOMMU_E2E_PASSWORD";
const repo = resolve(import.meta.dir, "..");

async function runCli(password: string | undefined) {
  const directory = await mkdtemp(resolve(tmpdir(), "post-deploy-password-"));
  const requests: { method: string; path: string }[] = [];
  let observedPassword: unknown;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    requests.push({ method: request.method ?? "GET", path });
    response.setHeader("content-type", "application/json");
    if (path === "/api/auth/login" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observedPassword = JSON.parse(Buffer.concat(chunks).toString()).password;
      // Stop before session issuance, readback, CRUD or cleanup. This fixture
      // records CLI serialization; it does not impersonate a successful login.
      response.writeHead(401);
      response.end(JSON.stringify({ error: "fixture login stop" }));
      return;
    }
    const fixtures: Record<string, unknown> = {
      "/": {},
      "/healthz": { status: "ok", missingBindings: [] },
      "/readyz": { status: "ok" },
      "/.well-known/social-server": {
        product: "yurucommu",
        capabilities: [],
      },
      "/api/auth/providers": { providers: [], password_enabled: true },
    };
    if (request.method !== "GET" || !(path in fixtures)) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: "unexpected fixture request" }));
      return;
    }
    response.end(JSON.stringify(fixtures[path]));
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await new Promise<void>((ready, reject) =>
      server.once("error", reject).listen(0, "127.0.0.1", ready),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const outputsPath = resolve(directory, "outputs.json");
    await writeFile(
      outputsPath,
      JSON.stringify({ launch_url: `http://127.0.0.1:${address.port}` }),
    );
    const env: NodeJS.ProcessEnv = {
      TAKOSUMI_CAPSULE_OUTPUTS_FILE: ` ${outputsPath} `,
    };
    if (password === undefined) delete env[PASSWORD_ENV];
    else env[PASSWORD_ENV] = password;
    const subprocess = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(repo, "scripts/post-deploy-smoke.ts"),
      ],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
    );
    child = subprocess;
    const timeout = setTimeout(() => subprocess.kill(), 5000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      return { exit, stdout, stderr, requests, observedPassword };
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (server.listening) {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
    await rm(directory, { recursive: true, force: true });
  }
}

describe("post-deploy CLI opaque password", () => {
  for (const [label, password] of [
    ["surrounding spaces", "  cli-password-fixture  "],
    ["whitespace only", "   "],
    ["boundary tabs", "\tcli-password-fixture\t"],
    ["internal CRLF", "cli-password\r\nfixture"],
    ["Unicode whitespace", "\u00a0cli-password-fixture\u3000"],
    ["ordinary control", "cli-password-fixture"],
  ]) {
    test(`submits ${label} verbatim and stops at login refusal`, async () => {
      const result = await runCli(password);
      // Boolean comparison avoids printing even fixture credentials on failure.
      expect(result.observedPassword === password).toBe(true);
      expect(result.exit).not.toBe(0);
      expect(result.stderr).toContain("POST /api/auth/login returned 401");
      expect(result.stdout).not.toContain('"status":"passed"');
      expect(result.requests.filter(({ method }) => method !== "GET")).toEqual([
        { method: "POST", path: "/api/auth/login" },
      ]);
      expect(result.requests.at(-1)?.path).toBe("/api/auth/login");
    });
  }

  for (const [label, password] of [
    ["missing", undefined],
    ["empty", ""],
  ] as const) {
    test(`refuses ${label} password without a login request`, async () => {
      const result = await runCli(password);
      expect(result.exit).not.toBe(0);
      expect(result.stderr).toContain(`${PASSWORD_ENV} is required`);
      expect(result.observedPassword).toBeUndefined();
      expect(result.requests.every(({ method }) => method === "GET")).toBe(
        true,
      );
      expect(result.stdout).not.toContain('"status":"passed"');
    });
  }
});
