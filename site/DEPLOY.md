# Publishing yurucommu.com

This document is for repository maintainers who publish the public
`yurucommu.com` website. It is not the procedure for installing a Yurucommu
server.

The contents of [`site/`](./) are static files:

- the product landing page;
- help pages;
- ActivityPub-related specifications;
- JSON-LD namespace documents under `ns/`.

There is no build step. The files are uploaded as they are. `_headers` serves
the JSON-LD documents with `application/ld+json` and allows other servers to
read them.

## Current destination

| Setting                  | Value                         |
| ------------------------ | ----------------------------- |
| Cloudflare Pages project | `yurucommu-website`           |
| Public URL               | <https://yurucommu.com>       |
| Pages hostname           | `yurucommu-website.pages.dev` |

The custom domain and its DNS record already exist. They are infrastructure
configuration, not something a normal website update should recreate.

## Release adapter

The owning repository has one website publication path:

```bash
# side-effect-free contract probe
bun run deploy -- --contract

# production publication; requires separate operator authorization
bun run deploy -- yurucommu-site
```

`yurucommu-site` accepts no flags or alternate phase. Do not replace it with an
ad-hoc `wrangler pages deploy`, dashboard upload, package script, or a command
from another repository.

The adapter refuses unless the worktree is clean and `HEAD` is exactly equal to
a freshly fetched `origin/main`. The local branch name and upstream are not
authority: a detached or differently named local branch is accepted at that
exact commit. It runs the complete owner gate, reads the committed `site/`
blobs from Git, and materializes only regular non-executable files into a
private read-only custody directory. Symlinks, special files, unsafe paths,
Pages Functions or `_worker.js`, credential-shaped material, broken internal
links, invalid JSON/JSONL, and a missing home-page Takosumi install CTA all stop
before publication. Every sealed file must have exactly one hard link at
creation and at each revalidation. Every bounded asset that is valid UTF-8 is
scanned regardless of its extension, including JavaScript, source maps, YAML,
and extensionless text. The worktree `site/` path is never passed to Wrangler.

No `CLOUDFLARE_*` environment credential is required or accepted. The adapter
uses the currently active owner Wrangler OAuth profile, strictly parses
`wrangler whoami --json` and `wrangler auth token --json`, and requires that
profile to resolve to exactly one account. Ambient Cloudflare token, key,
email, and account selectors are removed from every Wrangler child. The OAuth
token is kept only for the fixed project read and is never printed; sensitive
authentication-command output is discarded on failure.

### Check automatic production before pushing

Pushing `origin/main` is outside this adapter. If the Pages project has a Git
source with automatic production deployments enabled, that push can change
production before the adapter runs. Therefore, before pushing the reviewed
commit, a reviewer or operator must obtain a current, read-only owner-account
response from:

```text
GET /accounts/{account_id}/pages/projects/yurucommu-website
```

Do not push unless `result.source` is absent/`null` (Direct Upload), or
`result.source.config.production_deployments_enabled` is authoritatively
`false` with production branch `main`. A CLI list label is supporting
information, not this authority. If the API cannot identify the setting, stop
pre-touch. This evidence is time-sensitive and belongs in the operator record,
not in the repository. The adapter repeats the same API gate immediately before
its own upload, but cannot retroactively make an earlier push safe.

Immediately before upload, the adapter reads that project API's
`canonical_deployment`, Cloudflare's current production authority. It requires
the exact owner project, custom domain, `main`, production environment, and a
successful deploy. It then reads every representative URL from both the
canonical immutable URL and `yurucommu.com`, requires equal bytes, content
types, and required headers, records a pre-mutation binding digest, and rereads
the project API to prove the canonical identity did not change. Deployment-list
ordering is never used to select the previous deployment.

Wrangler receives the custody directory by an already opened directory
descriptor and is fixed to:

- project `yurucommu-website`;
- production branch `main`;
- the full reviewed commit hash;
- `--commit-dirty=false`, `--skip-caching`, and `--no-bundle`.

The result records the source commit, every-file manifest digest, complete site
tree SHA-256, canonical previous deployment and pre-mutation binding, new
deployment ID and immutable URL, final canonical identity, install CTA, and all
public readbacks. Keep that result outside the repository as the operator's
deploy record.

## Automatic publication verification

Publication is successful only after all of these paths return the exact bytes
from the sealed candidate at both the new immutable deployment URL and the
custom domain:

```text
GET https://yurucommu.com/
GET https://yurucommu.com/help/
GET https://yurucommu.com/specs/
GET https://yurucommu.com/ns/context.jsonld
```

The JSON-LD response must have an `application/ld+json` content type and the
expected CORS and cache headers. The custom-domain home-page bytes must include
the repository-owned `app.takosumi.com/install` CTA. Internal help,
specification, asset, and namespace references are resolved against the full
candidate before upload.

Wrangler's human-readable URL is not sufficient evidence. The adapter requires
the structured Wrangler deployment ID, full commit, production environment and
branch to become the project API's `canonical_deployment` before HTTP readback.
After exact immutable/apex readback it reads the project again and requires the
same canonical deployment. A different concurrent deployment is a post-touch
failure, not a reason to guess or retry.

## Failure boundary and retry rule

The adapter never retries a publication and never rolls one back automatically.
Its failure result names one phase:

- `PRE_TOUCH_FAILURE`: Wrangler upload was not invoked. Production was not
  touched by this adapter. Fix the failed precondition and start a fresh
  invocation.
- `AMBIGUOUS_AFTER_TOUCH`: Wrangler upload was invoked but no complete,
  matching deployment identity was recovered. Read the Pages project and its
  `canonical_deployment`, then compare it with the recorded previous deployment
  before deciding anything. Do not retry on the error text alone.
- `POST_TOUCH_FAILURE`: the new deployment identity exists, but custody
  revalidation, canonical project readback, exact content, headers, or CTA did
  not pass. Compare the immutable deployment URL, `yurucommu.com`, and the
  recorded previous deployment before choosing rollback or repair.

Provider diagnostics are bounded and redact generic Authorization/Bearer
credentials, Cloudflare token/key assignments, and private keys. Authentication
probe output is never forwarded at all.

## Domain recovery

Only use these details when the existing domain configuration was removed and
a maintainer has explicitly approved recreating it.

```text
Type: CNAME
Name: @
Target: yurucommu-website.pages.dev
Proxy: enabled
```

Cloudflare flattens the apex CNAME. A `www` alias can use the same target.
Changing DNS requires separate approval and is outside a normal site
publication.

## Reversal and forward repair

The pre-touch log and failure/success evidence name the authoritative
`previousDeployment.deploymentId` and its public-byte binding digest.
Cloudflare Pages supports rollback to a successful production deployment.
Use the Pages project's **Deployments** view and choose **Rollback to this
deployment** for that exact ID, or use the Pages rollback API endpoint for the
same project and ID:

```text
POST /accounts/{account_id}/pages/projects/yurucommu-website/deployments/{previous_deployment_id}/rollback
```

Rollback is a deliberate production mutation and requires its own operator
decision after authoritative readback. Do not delete deployments, change DNS,
or retry the failed upload as a substitute for reconciliation. After rollback,
the restored deployment can be older than the first item in deployment-list
order, so reread the project API's `canonical_deployment`; never infer current
production from list position.

If the recorded deployment is unavailable or rollback is inappropriate, make
the smallest corrective change as a new reviewed commit, push that exact commit
to `origin/main`, and publish it through `bun run deploy -- yurucommu-site`.
That higher commit is the forward-repair path; never edit or overwrite an
existing deployment identity.

## Troubleshooting

### The contract has no website target

Stop. You are in an older or wrong checkout. Do not substitute a raw Wrangler
or dashboard upload; update to a reviewed commit whose side-effect-free
contract declares `yurucommu-site`.

### The home page works but JSON-LD consumers fail

Read the response headers for `/ns/context.jsonld`. Verify that `_headers` was
included in the sealed manifest and that the response uses
`application/ld+json`. Treat the recorded deployment as post-touch and follow
the failure boundary above rather than publishing again.

### `yurucommu.com` no longer reaches the Pages deployment

Check the Pages custom-domain status and the proxied CNAME separately. Do not
change both at once: first identify whether the failure is in Pages domain
attachment, DNS resolution, or the deployed site.
