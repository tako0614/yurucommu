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

## Release status

The ecosystem does not currently have a runnable `yurucommu-site` release
adapter. Website publication therefore remains blocked by the release policy:
there is no approved command in this repository that uploads `site/` and then
verifies the exact remote files.

Do not replace that missing release path with an ad-hoc `wrangler pages deploy`
or a dashboard upload. A future adapter must:

1. record the reviewed source commit and the bytes being uploaded;
2. publish only those bytes to `yurucommu-website`;
3. read the public site back and verify representative pages and headers;
4. record the previous deployment so it can be restored;
5. stop and report whether a failure happened before or after publication.

Once that adapter exists, the ecosystem release entrypoint is:

```bash
# from the sibling takos-control repository
bun run deploy
```

The command's prepare phase is read-only. Publication happens only in its
authenticated promote phase.

## Verify a published deployment

The post-publication check must cover more than the home page:

```text
GET https://yurucommu.com/
GET https://yurucommu.com/help/
GET https://yurucommu.com/specs/
GET https://yurucommu.com/ns/context.jsonld
```

The JSON-LD response must have an `application/ld+json` content type and the
expected CORS header. Also check that internal help and specification links do
not return an error.

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

## Troubleshooting

### The release command has no website target

Publication is intentionally blocked while the `yurucommu-site` adapter is
missing. Add and review the adapter before attempting publication.

### The home page works but JSON-LD consumers fail

Read the response headers for `/ns/context.jsonld`. Verify that `_headers` was
included in the deployed files and that the response uses
`application/ld+json`.

### `yurucommu.com` no longer reaches the Pages deployment

Check the Pages custom-domain status and the proxied CNAME separately. Do not
change both at once: first identify whether the failure is in Pages domain
attachment, DNS resolution, or the deployed site.
