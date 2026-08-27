# Publishing yurucommu.com

This document covers the static Yurucommu brand site in [`site/`](./). It is
not the procedure for installing or operating a Yurucommu server.

The Pages project is `yurucommu-website`; its public origin is
`https://yurucommu.com`. The site is already static, so the scoped site gate
checks the files in `site/` and the upload publishes that directory directly.

## The one entrypoint

Inspect the owner contract without side effects:

```bash
bun run deploy -- --contract
```

Choose the environment explicitly:

```bash
# preview/rehearsal: the current worktree is the source
bun run deploy -- yurucommu-site --environment=integration

# production: only the reviewed main commit may publish
bun run deploy -- yurucommu-site --environment=production
```

There is no website plan command, API client, snapshot, or alternate Wrangler
entrypoint. Do not replace this command with a dashboard upload or an ad-hoc
`wrangler pages deploy` invocation.

## Integration

Integration accepts a dirty worktree and a branch other than `main`. It runs
`bun run check:site` once, uploads `site/` once to `yurucommu-website` with the
current branch (or `integration` when the checkout is detached), and performs a
`GET` against the immutable Pages deployment URL returned by Wrangler. The
home page must return HTTP 200 and the same bytes that were checked locally.

This lane is useful for checking a change before it is committed. Its result is
not production evidence and does not update `yurucommu.com`.

## Production

Production has the same scoped check and one upload, with two additional source
guards:

1. the worktree must be clean and the current branch must be `main`;
2. after fetching `origin/main`, `HEAD` must equal that fresh remote ref.

After the upload, the adapter reads both the immutable deployment URL and
`https://yurucommu.com/`. Each response must be HTTP 200 and contain the exact
checked `site/index.html` bytes. A failed readback does not trigger a retry.

The landing page keeps a Takosumi `/install?git=<repository-url>` CTA. Takosumi
reads the repository's own install manifest after the link opens; this page
does not select an options document. Updating the CTA is a normal site change
and is covered by the same scoped check.

## Failure boundary

The result names one of two phases:

- `PRE_UPLOAD_FAILURE`: source guards, the scoped check, or local site
  preparation failed. Wrangler was not invoked by this adapter.
- `POST_UPLOAD_INDETERMINATE`: upload was invoked but its URL or readback could
  not be confirmed. Treat the provider state as unknown and reconcile the
  immutable deployment before deciding whether to retry.

The adapter never retries or rolls back automatically. Use the Pages deployment
history for an intentional rollback, or publish a corrected higher commit
through the same production command.

## Domain recovery

Only use these details when the existing domain configuration was removed and a
maintainer has explicitly approved recreating it:

```text
Type: CNAME
Name: @
Target: yurucommu-website.pages.dev
Proxy: enabled
```

DNS changes are separate infrastructure work and are not part of a site
publication.
