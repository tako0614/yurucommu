# Source-only Actor/OpenTofu candidate

This directory is an unpublished, opt-in candidate module. It is not the
default Yurucommu Capsule, Store source option, or a claim that released
Takoform Provider 4.0.0 supports Actor resources. Validate it only with the
exact local Provider candidate bytes and digest described below. The
`required_providers` uses the local-only `0.0.0-dev` experimental pin. No
registry release is expected to satisfy it, and the qualification script also
requires the exact local executable and digest before it creates a development
override.

The candidate composes:

- C, the Yurucommu product Worker, its existing database/migrations, KV, media,
  queues, endpoint, consumers, and retention trigger;
- N1/N2, `CallSignalingActor` and `RealtimeStreamActor` namespaces owned by C;
- D, a private call-dispatcher Worker bound to N1 and to C's product database,
  with no endpoint. Core's call-signaling Actor reads local signing keys and
  peer records and persists call sessions through that database, so a separate
  empty dispatcher database would make RTC signaling fail;
- C's private `CALL_DISPATCHER` service binding to D, plus C's bindings to N1
  and N2. D has no service binding back to C.

The dependency order is identity allocation for C and N1/N2, D bundle/version
and deployment, C bundle/version and deployment, then C endpoint/consumers. The
Provider candidate returns the allocated namespace's name/UID while its
`ready` value may still be false; class readiness is observed separately after
C's deployment exports the named classes. HCL references `.name`/`.uid`, not
`.ready`, for WorkerVersion bindings.

## Build and local qualification

Build the two bundles directly into this candidate's ignored `.generated/`
directory. The Actor candidate build requires an explicit packed Core input; it
does not resolve `@takosjp/yurucommu-core` from the checkout's `node_modules`.
The helper checks the archive digest, package identity/version, and tar entry
paths/types before extraction, then bundles both C and D against only that
staged package:

```bash
YURUCOMMU_CORE_CANDIDATE_TARBALL=/absolute/path/to/takosjp-yurucommu-core-4.1.9.tgz \
YURUCOMMU_CORE_CANDIDATE_SHA256=sha256:<64-lowercase-hex-digest> \
bun run build:actor-opentofu-candidate
```

The expected packed Core version is 4.1.9. The package tarball SHA and the two
generated bundle SHAs are printed after a successful build. No ambient source
checkout or default 4.1.8 dependency can silently replace this input.

The candidate module uses `${path.module}/.generated` for both bundles and
`${path.module}/../migrations/sql` for the checked-in migration set. C owns the
database and applies that migration set once; D's `DB` binding references the
same SQLiteDatabase resource. Keep the candidate directory under
`deploy/takoform/actor-candidate`; moving it changes that layout. Build output
is ignored and must not be committed.

Use an executable built from exact Provider source commit
`cc712958e3c3a3011627fa0d39e679b7048c88cc` (candidate mapping selected for
Forms source commit `43b31a73e9255974b2bd06f0907d8cb5be17c3da`). Supply both its
absolute path and SHA-256 to the candidate validator. It rejects missing or
mismatched local-provider authority and installs a temporary OpenTofu
development override. It does not run `tofu init`, so it never resolves the
published Provider pin. Its loopback fixture serves v1 discovery and refuses
all mutation/read routes; support-profile reads return undecided warnings.
The full graph plan therefore checks Provider schema, HCL references, and
computed dependency wiring only—not Host capability, Actor readiness, or
runtime behavior:

```bash
TAKOFORM_PROVIDER_BINARY=/absolute/path/to/terraform-provider-takoform \
TAKOFORM_PROVIDER_SHA256=sha256:<64-lowercase-hex-digest> \
bun scripts/validate-takoform-actor-candidate.ts
```

This source candidate does not enable live installation, provider publication,
Host admission, Store selection, or production readiness. Do not add it to the
default module, source options, catalog, or release manifest without those
separate owner decisions and evidence. No `APP_URL` or guessed endpoint is
declared; only the product Worker receives the ordinary Host-allocated
endpoint.
