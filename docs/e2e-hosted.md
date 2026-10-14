# Hosted staging E2E skeleton

After loading the environment below, one command performs the existing
Yurucommu portable install lifecycle: deploy the temporary 15-resource graph,
check migration-backed health, destroy, and verify authoritative absence.

```bash
bun tests/e2e-hosted/run.ts --execute
```

The default invocation and `--dry-run` only print the intended phases. They do
not make HTTP requests, start a Provider, build, provision, or delete resources.

```bash
bun tests/e2e-hosted/run.ts --dry-run
bun test tests/e2e-hosted
```

This change was verified with dry-run and local HTTP/process mocks only. No
staging or production deployment was performed. The mocks exercise deploy,
the existing `/healthz`, `/readyz`, social-server and NodeInfo checks, destroy,
absence verification, failed health, and recovery-state retention after failed
cleanup. They do not establish hosted platform qualification or production
isolation evidence.

## Environment

Load credentials from the operator's environment. Do not put credentials in
shell history, command arguments, files in this repository, or CI logs.

| Variable                              | Required value                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `YURUCOMMU_HOSTED_E2E_ENVIRONMENT`    | `staging`                                                                         |
| `TAKOFORM_ENDPOINT`                   | An exact selector in `STAGING_ORIGINS` in the harness                             |
| `YURUCOMMU_HOSTED_E2E_WORKER_VERSION` | The module's current pinned WorkerVersion Form version, currently `0.3.0`         |
| `TAKOFORM_SPACE`                      | A separately provisioned disposable space matching `yurucommu-e2e-[a-z0-9]{1,16}` |
| `TAKOFORM_TOKEN`                      | Writer credential scoped only to this staging space                               |
| `TAKOFORM_EVIDENCE_TOKEN`             | A distinct read-only credential for the same space                                |
| `TAKOFORM_PROVIDER_BINARY`            | Absolute path to the operator-selected Provider binary                            |
| `TAKOFORM_PROVIDER_SHA256`            | Exact `sha256:` digest of that binary                                             |
| `TAKOFORM_E2E_TIMEOUT_SECONDS`        | Optional existing owner command timeout                                           |

The initial staging selectors are `https://api-staging.takoserver.com` and
`https://takoserver-staging.takos.jp`. They are an explicit allowlist for this
skeleton, **not a claim that either origin currently serves a qualified Host**.
An operator must verify the actual staging origin before a live run; a
different origin requires a reviewed source change to this allowlist and its
negative tests. A hostname supplied through another environment variable is
never added automatically. The assigned app must be
`https://yurucommu-e2e-<12 lowercase hex characters>.app-staging.takos.jp`.

The hosted **Form** version is 0.x. The Yurucommu package and Provider versions
are separate identities: the current module pins Provider `4.1.0` through
`scripts/takoform-provider-pin.ts`. The harness reads the complete
WorkerVersion FormRef, including its published schema digest, from
[`deploy/takoform/host-support-profile.json`](../deploy/takoform/host-support-profile.json).
It does not use the old `0.1.0` example identities in generic lifecycle tests.
Before any apply, it GETs the exact `/apis/forms.takoform.com/v1/forms`
availability query with space, group, kind, definitionVersion and schemaDigest,
requiring one identical installed/executable/activated entry that supports
create, update and delete. A changed digest, unavailable Form, 1.x Form,
redirect, or denied request fails before the owner lifecycle starts.

## Reused owner lifecycle and guards

The implementation calls the existing
[`scripts/takoform-v1-e2e-full.ts`](../scripts/takoform-v1-e2e-full.ts) `main()`;
its source preparation, binary/digest/version handshake, exact Provider schema,
fresh project name, private temporary state, runtime-input handling, resource
readback, and teardown remain owned there. This is the documented disposable
operator install path, not publication of an official Worker surface. It does
not call Wrangler, Cloudflare deploy, the GA integration Worker publisher, or
an alternate raw Provider implementation.

The selected origin and space are passed unchanged to the pinned Provider.
Its stable-v1 client refuses HTTP redirects and cross-origin discovery; the
owner verifies the selected Provider bytes and version. The wrapper also
guards all owner JavaScript HTTP reads: only the exact staging Host and space,
or the fresh staging app's four public health paths, are accepted. App requests
carry no cookie or authorization header and follow no redirects. Runtime
diagnostic endpoints, alternate OIDC journeys, arbitrary endpoints, production
environment selectors, unpinned Form versions, and debug/TF logging are refused.
Canonical origins are not rewritten through a proxy, preserving the Provider's
private runtime-input apply commitment.

Only a small environment allowlist enters the owner and its subprocesses.
Cloudflare credentials, `TF_VAR_*`, `TF_CLI_CONFIG_FILE`, proxy settings, and
unrelated inherited secrets are omitted. All owner stdout/stderr and console
channels are suppressed, including error output. The wrapper returns only its
fixed result projection or a fixed error code; provider responses, exceptions,
causes, generated runtime inputs and credentials are never printed.

After apply, the existing owner always attempts destroy and exact FormRef
absence readback, including after a failed health check. The wrapper reports
success only after the owner acknowledges all 15 resources and both cleanup
and authoritative absence. If destroy or absence verification fails, the owner
retains its private temporary state for operator recovery. A wrapper error
does not authorize a manual deletion of another space, a blind retry, or an
automatic production rollback. Inspect the retained `yurucommu-takoform-v1-*`
directory under the operator's private `TMPDIR`; the wrapper deliberately does
not expose that path or raw diagnostics. The disposable space itself belongs
to the operator and is not destroyed by the resource lifecycle.

## Portable checks

The new directory is intentionally outside the existing package test list and
format/type globs because the carve-out allows only new test/docs files. Run
these focused checks explicitly alongside the repository's unchanged full gate:

```bash
bun test tests/e2e-hosted
bunx prettier --check tests/e2e-hosted docs/e2e-hosted.md
bunx tsc --noEmit --strict --target ESNext --module Preserve \
  --moduleResolution bundler --allowImportingTsExtensions \
  --types bun,node,@cloudflare/workers-types --skipLibCheck tests/e2e-hosted/*.ts
bun run check
```

Keep live execution separate from these portable checks. The CLI's default is
dry-run, and the tests contact only ephemeral loopback HTTP servers and local
child processes with sentinel credentials.
