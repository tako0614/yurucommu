# Deploying the yurucommu.com website

`site/` is a static site (landing + `help/` docs + `specs/` ActivityPub specs +
`ns/` JSON-LD namespaces). It is published as the Cloudflare Pages project
**`yurucommu-website`** and served at **https://yurucommu.com**.

There is no build step — the directory is uploaded as-is. `_headers` sets the
`application/ld+json` content type (and CORS) on the `/ns/*` JSON-LD contexts so
strict JSON-LD processors accept them.

## Official release

The ecosystem currently has no runnable `yurucommu-site` adapter. Official
publication remains fail-closed until a fixed adapter with authoritative Pages
readback is registered. Do not substitute a raw Pages upload.

```sh
# from the sibling takos-control repository, once the adapter exists
bun run deploy
```

`prepare` is read-only. Only authenticated `promote` may change the official
Pages target, and success requires authoritative remote readback.

## Custom domain (already configured)

`yurucommu.com` is attached to the Pages project and live (TLS via Google CA).
The apex resolves through a **proxied** CNAME in the `yurucommu.com` zone:

```
CNAME  yurucommu.com (@)  ->  yurucommu-website.pages.dev   (Proxied / orange cloud)
```

Cloudflare flattens the apex CNAME automatically. To re-create it if ever
removed: DNS → Add record → CNAME, name `@`, target `yurucommu-website.pages.dev`,
Proxied. Add `www.yurucommu.com` the same way for a `www` alias.

The existing custom-domain and DNS configuration is provisioning state, not a
deploy step. Recreating or changing it is an operator-owned action outside this
repository and outside its deploy entrypoint.
