import { expect, test } from "bun:test";
import {
  cleanupTakoformV1E2E,
  probeRuntime,
} from "../../scripts/takoform-v1-e2e-full.ts";
import {
  guardedFetch,
  HarnessError,
  preflightWorkerVersion,
  readConfig,
  runHarness,
  STAGING_ORIGINS,
  WORKER_FORM,
} from "./harness.ts";

const writer = "writer-secret-canary";
const evidence = "evidence-secret-canary";
const env = {
  YURUCOMMU_HOSTED_E2E_ENVIRONMENT: "staging",
  YURUCOMMU_HOSTED_E2E_WORKER_VERSION: WORKER_FORM.definitionVersion,
  TAKOFORM_ENDPOINT: STAGING_ORIGINS[0],
  TAKOFORM_SPACE: "yurucommu-e2e-local",
  TAKOFORM_TOKEN: writer,
  TAKOFORM_EVIDENCE_TOKEN: evidence,
  TAKOFORM_PROVIDER_BINARY: "/operator/private/provider",
  TAKOFORM_PROVIDER_SHA256: `sha256:${"a".repeat(64)}`,
  PATH: process.env.PATH,
};
const appOrigin = "https://yurucommu-e2e-abcdef123456.app-staging.takos.jp";
function availability(version = WORKER_FORM.definitionVersion) {
  return {
    forms: [
      {
        identity: {
          formRef: {
            apiVersion: "edge.forms.takoform.com",
            kind: "WorkerVersion",
            definitionVersion: version,
            schemaDigest: WORKER_FORM.schemaDigest,
          },
        },
        definitionKnown: true,
        installed: true,
        executable: true,
        activated: true,
        availableToPrincipal: true,
        operations: ["create", "update", "delete"],
      },
    ],
  };
}
function ownerProof() {
  console.log(
    JSON.stringify({
      kind: "yurucommu.takoform-v1-e2e@v3",
      status: "passed",
      phase: "full-lifecycle",
      resourceCount: 15,
      cleanupVerified: true,
      authoritativeAbsenceVerified: true,
    }),
  );
}

for (const origin of [
  "https://api.takoserver.com",
  "https://api-staging.takoserver.com.evil.test",
  "https://api-staging.takoserver.com/",
  "https://user:password@api-staging.takoserver.com",
  "https://api-staging.takoserver.com:444",
  "http://api-staging.takoserver.com",
  "https://api-staging.takoserver.com?token=secret",
]) {
  test(`rejects target ${origin}`, () => {
    expect(() =>
      readConfig(["--execute"], { ...env, TAKOFORM_ENDPOINT: origin }),
    ).toThrow("STAGING_ORIGIN_REQUIRED");
  });
}
for (const version of ["1.0.0", "0.1.0", "0.3.0-rc.1", "0.3.0+prod"]) {
  test(`rejects unpinned WorkerVersion ${version}`, () => {
    expect(() =>
      readConfig(["--execute"], {
        ...env,
        YURUCOMMU_HOSTED_E2E_WORKER_VERSION: version,
      }),
    ).toThrow("PINNED_WORKER_VERSION_0_X_REQUIRED");
  });
}
test("explicit production and an existing space fail before any I/O", () => {
  expect(() =>
    readConfig(["--execute"], {
      ...env,
      YURUCOMMU_HOSTED_E2E_ENVIRONMENT: "production",
    }),
  ).toThrow("PRODUCTION_FORBIDDEN");
  expect(() =>
    readConfig(["--execute"], { ...env, TAKOFORM_SPACE: "ordinary-space" }),
  ).toThrow("DISPOSABLE_SPACE_REQUIRED");
});
test("credentials are env only and distinct", () => {
  expect(() => readConfig([`--token=${writer}`], env)).toThrow(
    "INVALID_ARGUMENTS",
  );
  expect(() =>
    readConfig(["--execute"], { ...env, TAKOFORM_TOKEN: evidence }),
  ).toThrow("DISTINCT_ENV_CREDENTIALS_REQUIRED");
  expect(() =>
    readConfig(["--execute"], { ...env, TAKOFORM_TOKEN: "" }),
  ).toThrow("DISTINCT_ENV_CREDENTIALS_REQUIRED");
});
for (const key of [
  "DEBUG",
  "TF_LOG",
  "TF_LOG_PATH",
  "PWDEBUG",
  "TAKOFORM_DIAGNOSTIC_RUNTIME_ENDPOINT",
  "TAKOFORM_USER_JOURNEY",
  "YURU_OIDC_ISSUER_URL",
  "YURU_OIDC_HANDOFF_FILE",
]) {
  test(`rejects ${key} override`, () => {
    expect(() =>
      readConfig(["--execute"], { ...env, [key]: "unsafe" }),
    ).toThrow("UNSAFE_OVERRIDE_FORBIDDEN");
  });
}
test("default and explicit dry-run perform no HTTP or lifecycle work", async () => {
  for (const argv of [[], ["--dry-run"]]) {
    let calls = 0;
    const result = await runHarness(readConfig(argv, {}), {
      transport: async () => {
        calls++;
        throw new Error("unexpected network");
      },
      lifecycle: async () => {
        calls++;
      },
    });
    expect(result.status).toBe("dry-run");
    expect(calls).toBe(0);
    expect(result).toMatchObject({ mutation: false });
  }
});
test("0.x availability rejects production, missing and inactive Forms", async () => {
  const config = readConfig(["--execute"], env);
  for (const body of [
    availability("1.0.0"),
    { forms: [] },
    { forms: [...availability().forms, ...availability().forms] },
    { forms: [{ ...availability().forms[0], activated: false }] },
  ]) {
    await expect(
      preflightWorkerVersion(config, async () => Response.json(body)),
    ).rejects.toBeInstanceOf(HarnessError);
  }
});
test("preflight refuses redirect before owner or credential-bearing replay", async () => {
  let ownerCalls = 0;
  await expect(
    runHarness(readConfig(["--execute"], env), {
      transport: async (_url, init) => {
        expect(init?.redirect).toBe("error");
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.takoserver.com" },
        });
      },
      lifecycle: async () => {
        ownerCalls++;
      },
    }),
  ).rejects.toThrow("WORKER_PREFLIGHT_FAILED");
  expect(ownerCalls).toBe(0);
});
test("runtime and host guards block production, foreign credentials and other spaces", async () => {
  let calls = 0;
  const config = readConfig(["--execute"], env);
  const guarded = guardedFetch(config, async () => {
    calls++;
    return Response.json({});
  });
  for (const url of [
    "https://yurucommu-e2e-abcdef123456.app.takos.jp/healthz",
    "https://ordinary.app-staging.takos.jp/healthz",
    `${appOrigin}/api/auth/me`,
    `${appOrigin}/healthz?secret=${writer}`,
    "https://api.takoserver.com/healthz",
  ]) {
    await expect(guarded(url)).rejects.toBeInstanceOf(HarnessError);
  }
  await expect(
    guarded(`${appOrigin}/healthz`, {
      headers: { authorization: `Bearer ${writer}` },
    }),
  ).rejects.toBeInstanceOf(HarnessError);
  await expect(
    guarded(
      `${config.origin}/apis/forms.takoform.com/v1/resources/edge.forms.takoform.com/WorkerVersion/e2e?space=production&definitionVersion=0.1.0`,
      { headers: { authorization: `Bearer ${evidence}` } },
    ),
  ).rejects.toBeInstanceOf(HarnessError);
  expect(calls).toBe(0);
});
test("runtime redirects never follow a production location", async () => {
  const guarded = guardedFetch(
    readConfig(["--execute"], env),
    async (_url, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, {
        status: 307,
        headers: { location: "https://yurucommu.com/healthz" },
      });
    },
  );
  await expect(guarded(`${appOrigin}/healthz`)).rejects.toThrow(
    "REDIRECT_FORBIDDEN",
  );
});

async function localLifecycle(failHealth: boolean) {
  const phases: string[] = [];
  let exists = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/forms")) return Response.json(availability());
      if (url.pathname === "/mock-deploy") {
        phases.push("deploy");
        exists = true;
        return Response.json({});
      }
      if (url.pathname === "/mock-teardown") {
        phases.push("teardown");
        exists = false;
        return Response.json({});
      }
      if (url.pathname === "/mock-absence") {
        phases.push("absence");
        return Response.json({ exists });
      }
      if (url.pathname === "/healthz") {
        phases.push("health");
        return Response.json({
          service: "yurucommu",
          status: failHealth ? "degraded" : "ok",
          missingBindings: failHealth ? ["DB"] : [],
        });
      }
      if (url.pathname === "/readyz")
        return Response.json({ status: "ok", missingBindings: [] });
      if (url.pathname === "/.well-known/social-server")
        return Response.json({
          product: "yurucommu",
          server: { canonicalOrigin: appOrigin },
        });
      if (url.pathname === "/nodeinfo/2.0")
        return Response.json({
          software: { name: "yurucommu" },
          usage: { users: { total: 0 }, localPosts: 0 },
        });
      return new Response(null, { status: 404 });
    },
  });
  const realFetch = globalThis.fetch.bind(globalThis);
  const local = `http://127.0.0.1:${server.port}`;
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const source = new URL(req.url);
    return realFetch(new URL(source.pathname + source.search, local), {
      method: req.method,
      headers: req.headers,
      redirect: "error",
    });
  };
  try {
    return {
      result: await runHarness(readConfig(["--execute"], env), {
        transport,
        lifecycle: async () => {
          const child = Bun.spawn(
            [
              process.execPath,
              new URL("./child-env.ts", import.meta.url).pathname,
            ],
            { env: process.env, stdout: "pipe", stderr: "pipe" },
          );
          const childText = await new Response(child.stdout).text();
          expect(await child.exited).toBe(0);
          expect(
            Object.values(JSON.parse(childText)).every(
              (value) => value === true,
            ),
          ).toBe(true);
          await realFetch(`${local}/mock-deploy`, { method: "POST" });
          let primary: unknown;
          try {
            await probeRuntime(appOrigin);
          } catch (error) {
            primary = error;
          }
          const cleanup = await cleanupTakoformV1E2E({
            mutationAttempted: true,
            workdir: "/mock/private/state",
            destroy: async () => {
              await realFetch(`${local}/mock-teardown`, { method: "DELETE" });
            },
            verifyAbsence: async () => {
              const value = await (
                await realFetch(`${local}/mock-absence`)
              ).json();
              expect(value).toMatchObject({ exists: false });
            },
            removeWorkdir: async () => {
              phases.push("state-removed");
            },
          });
          if (primary) throw primary;
          if (cleanup.error) throw cleanup.error;
          ownerProof();
        },
      }),
      phases,
      exists,
    };
  } catch (error) {
    return { error, phases, exists };
  } finally {
    await server.stop(true);
  }
}
test("local HTTP/process lifecycle deploys, checks health and verifies teardown", async () => {
  const result = await localLifecycle(false);
  expect(result.result?.status).toBe("passed");
  expect(result.phases).toEqual([
    "deploy",
    "health",
    "teardown",
    "absence",
    "state-removed",
  ]);
  expect(result.exists).toBe(false);
});
test("failed health still tears down through the owner's cleanup helper", async () => {
  const result = await localLifecycle(true);
  expect(result.error).toBeInstanceOf(HarnessError);
  expect(result.phases).toEqual([
    "deploy",
    "health",
    "teardown",
    "absence",
    "state-removed",
  ]);
  expect(result.exists).toBe(false);
});
test("failed teardown preserves state and still checks authoritative absence", async () => {
  const phases: string[] = [];
  const result = await cleanupTakoformV1E2E({
    mutationAttempted: true,
    workdir: "/mock/private/state",
    destroy: async () => {
      phases.push("destroy");
      throw new Error(writer);
    },
    verifyAbsence: async () => {
      phases.push("absence");
      throw new Error(evidence);
    },
    removeWorkdir: async () => {
      phases.push("remove");
    },
  });
  expect(result.preservedWorkdir).toBe(true);
  expect(result.cleanupVerified).toBe(false);
  expect(phases).toEqual(["destroy", "absence"]);
});
test("owner errors and every output channel suppress secret values", async () => {
  const priorLog = console.log;
  const priorFetch = globalThis.fetch;
  const priorEnvironment = process.env;
  const priorOut = process.stdout.write;
  const priorErr = process.stderr.write;
  let leaked = "";
  const capture = (...args: any[]) => {
    leaked += args.join("");
    return true;
  };
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    const result = runHarness(readConfig(["--execute"], env), {
      transport: async () => Response.json(availability()),
      lifecycle: async () => {
        for (const method of [
          "log",
          "error",
          "warn",
          "info",
          "debug",
          "trace",
        ] as const)
          console[method](writer, evidence);
        process.stdout.write(writer);
        process.stderr.write(evidence);
        throw new Error(`${writer} ${evidence}`);
      },
    });
    await expect(result).rejects.toThrow(
      "OWNER_LIFECYCLE_FAILED_RECOVERY_STATE_RETAINED",
    );
    expect(leaked).toBe("");
    expect(console.log).toBe(priorLog);
    expect(globalThis.fetch).toBe(priorFetch);
    expect(process.env).toBe(priorEnvironment);
  } finally {
    process.stdout.write = priorOut;
    process.stderr.write = priorErr;
  }
});
test("incomplete owner teardown proof cannot report success", async () => {
  await expect(
    runHarness(readConfig(["--execute"], env), {
      transport: async () => Response.json(availability()),
      lifecycle: async () => {
        console.log(
          JSON.stringify({ status: "passed", cleanupVerified: false }),
        );
      },
    }),
  ).rejects.toThrow("OWNER_LIFECYCLE_PROOF_MISSING");
});
test("actual default CLI dry-run and production rejection redact env secrets", async () => {
  for (const [argv, extra, exit] of [
    [[], {}, 0],
    [["--dry-run"], {}, 0],
    [["--execute"], { YURUCOMMU_HOSTED_E2E_ENVIRONMENT: "production" }, 1],
  ] as const) {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./run.ts", import.meta.url).pathname,
        ...argv,
      ],
      {
        env: {
          PATH: process.env.PATH,
          TAKOFORM_TOKEN: writer,
          TAKOFORM_EVIDENCE_TOKEN: evidence,
          ...extra,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(status).toBe(exit);
    expect(stdout + stderr).not.toContain(writer);
    expect(stdout + stderr).not.toContain(evidence);
    if (exit === 0)
      expect(JSON.parse(stdout)).toMatchObject({
        status: "dry-run",
        mutation: false,
      });
    else
      expect(JSON.parse(stderr)).toMatchObject({
        code: "PRODUCTION_FORBIDDEN",
      });
  }
});
