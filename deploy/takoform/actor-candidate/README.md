# Source-only Actor/OpenTofu candidate

This directory contains unpublished, opt-in Actor/OpenTofu templates, not
an executable root module in the tracked Git source. Its `main.tf.template`
and `outputs.tf.template` deliberately do not match OpenTofu source suffixes,
so Takosumi's tracked-file scan does not offer this candidate in the ordinary
module chooser. It is not the default Yurucommu Capsule or a Store source
option, and does not claim that the released Takoform Provider supports Actor
resources. Validate it only with the exact local Provider candidate bytes and
digest described below. The `required_providers` uses the local-only
`0.0.0-dev` experimental pin. No registry release is expected to satisfy it,
and the qualification script also requires the exact local executable and
digest before it creates a development override.

The candidate composes:

- C, the Yurucommu product Worker, its existing database/migrations, KV, media,
  queues, endpoint, consumers, and retention trigger;
- N1/N2, `CallSignalingActor` and `RealtimeStreamActor` namespaces owned by C;
- D, a private call-dispatcher Worker bound to N1 and to C's product database,
  with no endpoint. Core's call-signaling Actor reads local signing keys and
  peer records and persists call sessions through that database, so a separate
  empty dispatcher database would make RTC signaling fail;
- optional RTC configuration projected only to D. All settings default to
  unset/false, so TURN, SFU, and custom ICE servers remain optional and add no
  RTC-specific required inputs to the default candidate;
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
YURUCOMMU_CORE_CANDIDATE_TARBALL=/absolute/path/to/takosjp-yurucommu-core-4.1.11.tgz \
YURUCOMMU_CORE_CANDIDATE_SHA256=sha256:52a0bad44879a7a376379fd289ebe79697bf13c823962dfb4b302a867f568a56 \
bun run build:actor-opentofu-candidate
```

The expected packed Core version is 4.1.11. Its npm SHA-512 integrity is
`sha512-s6lwT7LC8MeMwAbMR3p5tKai13oI1IVgWgWS+2CjcJbINLIu4PXcRMTxT563I5IYqXGx1cUcF307PNeEVUOfEQ==`, and the SHA-256 above was computed from that exact published
tarball. The package tarball SHA and the two generated bundle SHAs are printed
after a successful build. No ambient source checkout or lockfile-installed
dependency can silently replace this input.

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
development override. The validator copies the two templates byte-for-byte
as `main.tf` and `outputs.tf` into a fresh temporary module, alongside the
generated bundles and sibling migrations; the repository test checks both
templates with `tofu fmt -`. It does not run `tofu init`, so it never resolves
the published Provider pin. Its loopback fixture serves v1 discovery and
refuses all mutation/read routes; support-profile reads return undecided
warnings. The local development plan checks Provider schema, HCL references,
and computed dependency wiring only—not Host capability, Actor readiness, or
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

## Optional RTC configuration

The candidate's `rtc_turn_uris`, `rtc_turn_ttl`, `rtc_sfu_adapter`,
`rtc_sfu_url`, and `rtc_sfu_app_id` variables are optional non-secret settings
for the private dispatcher. Unset values are omitted from its `vars_json`; they
do not alter the public product Worker or Host/Form schemas. The default
remains Core's STUN-only / P2P behavior.

`rtc_ice_servers_enabled` defaults to false. When selected, the WorkerVersion
declares only the name `YURUCOMMU_RTC_ICE_SERVERS` as a required sensitive
input, because Core accepts credential fields as well as public URLs in that
JSON. This protects the mixed payload without treating every RTC setting as
secret. Never place the JSON payload or TURN credentials in ordinary Terraform
variables. When `rtc_turn_uris` selects TURN, the WorkerVersion also declares
only the name `YURUCOMMU_RTC_TURN_SECRET`. Selecting an SFU adapter and URL
conditionally declares `YURUCOMMU_RTC_SFU_TOKEN`; adding `rtc_sfu_app_id` to
that selected SFU configuration conditionally declares
`YURUCOMMU_RTC_SFU_APP_SECRET` for a future adapter that uses it. The candidate
stores no secret literal in HCL, Terraform variables, or `vars_json`; supply
those values through Takoform's separate sensitive-input path. The SFU app
ID/secret pair is currently passed through only for adapter compatibility and
Core 4.1.11 does not consume it.
