# Changelog

## 2.2.0-rc.2 - 2026-09-06

- Prepare the next fresh-install conformance candidate with Takoform Provider
  `4.0.0` and Yurucommu core/API `4.1.6`. The portable lane carries the
  published edge.sql transaction-envelope fix, and the exact source was
  verified through the full local OIDC application lifecycle.
- This prerelease is for explicitly selected new test installations only. It
  makes no staging or production qualification claim. Stable Store selection
  and the website's `v2.1.10` source remain unchanged.
- Existing installations retain their selected release. This candidate adds no
  existing-media adoption/copy, backlog migration, in-place upgrade, or state
  migration support.
- Publish an immutable prerelease tag without advancing latest; keep the prior
  `v2.2.0-rc.1` release notes and identity historical and untouched.

## 2.2.0-rc.1 - 2026-09-05

- Publish a fresh-install conformance candidate with Takoform Provider `4.0.0`,
  Yurucommu core/API `4.1.5`, and the complete 15-resource module. MEDIA uses
  the exact Edge ObjectBucket contract, and both delivery queues have consumers.
- Use the explicit `portable` runtime lane and the source-built Worker with its
  unchanged, tracked 28-file SQLite migration bundle.
- This prerelease is for explicitly selected new test installations. Full live
  Store install/plan/apply/runtime/destroy/recovery qualification is not yet
  complete. Stable Store selection and the website's `v2.1.10` source stay
  unchanged until a separately published stable release is qualified.
- Existing `v2.1.x` installations must retain their selected release. This
  candidate provides no existing-media adoption/copy or backlog migration:
  changing an existing source to it would create a different MEDIA bucket and
  enable a DLQ consumer. No in-place upgrade or state migration is authorized.
- Publish immutable prerelease tags as GitHub prereleases without advancing
  latest; project these checked-in release notes into the GitHub Release.

## 2.1.10 - 2026-08-29

- Ship the Takoform SQLite migration inputs as tracked release source so a
  fresh Takosumi install cannot evaluate an empty `SQLiteMigrationSet`.
- Keep the source-built Worker and the repository-owned migration bundle on
  the same immutable Git release selected by the install flow.

## 2.1.9 - 2026-08-29

- Consume the registry-published Yurucommu core/API `3.4.4` owner-subject
  compatibility fix, preserving the configured owner pin for namespaced
  provider identities.
- Carry the locked core migration bundle into the Takoform source build while
  preparing the `v2.1.9` Worker release identity.

## 2.1.8 - 2026-08-25

- Validate the independently published Takoform Provider `3.0.0` from its
  signed registry release and pin both portable modules to that exact contract.
- Rebuild the Takoform source module from the frozen Yurucommu dependency lock,
  with temporary provider state isolated from ambient OpenTofu authority.
- Advance both install source choices and the direct Cloudflare artifact
  defaults together while retaining the verified `v2.1.7` rollback identity.

## 2.1.7 - 2026-08-25

- Present Takoform and Cloudflare as provider adapters, with Takoserver and a
  connected Cloudflare account selected as destinations underneath them.
- Keep the Takosumi Cloudflare install on Accounts OIDC and remove unsealed
  password and authenticated push-token inputs from its repository UX.

## 2.1.6 - 2026-08-14

- Pin the Takoform adapter to provider `1.0.4` and request the explicit
  RelationalDatabase v2-to-v3 Form transition for existing installations.
- Keep EdgeWorker updates on the recorded Form3 identity while advancing the
  immutable Worker release reference.

## 2.1.1 - 2026-07-19

- Publish the optional Capsule Source Options chooser for the existing
  Cloudflare OpenTofu module.

## 2.1.0 - 2026-07-16

- Add browser notification push registration and delivery support from `@takosjp/yurucommu-core` 3.1.
- Improve timeline, post detail, search, direct messages, stories, settings, and notification interactions.
- Ship a self-contained direct Cloudflare deployment path and post-deploy functional probe.
- Align the OpenTofu Capsule and optional TCS presentation metadata with Takosumi's current plain-module contract.
- Refresh the Yurucommu landing page, help, protocol references, and product screenshots.
