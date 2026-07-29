# Yurucommu portable Takoform Capsule

This directory is the canonical managed desired-resource definition for a
Yurucommu install on any conforming Takoform host, including Takosumi. It uses
only typed Takoform Service Forms:

- one JavaScript `HttpService`;
- one SQLite `RelationalDatabase`;
- one media `ObjectBucket`;
- one `KeyValueStore`;
- delivery and dead-letter `Queue` resources;
- one hourly `Schedule` targeting the Worker;
- explicit non-secret runtime connections.
- one app-owned opaque launcher Interface declaration.

The selected Worker release URL and SHA-256 are pinned in this Capsule. A
product release updates the tag, URL, and digest together.

The repository-root OpenTofu module and `wrangler.jsonc` remain the direct
Cloudflare deployment path. They are not imported by this module and the
Takoform provider is never pointed at a Cloudflare compatibility endpoint.

The launcher document is ordinary app-owned JSON in `takoform_interface`.
Takoform does not define a UI-specific resource type. The host resolves the
service origin from the `HttpService` output; a runtime consumer discovers the
Interface from the host and calls the resolved application endpoint directly.

## Host-owned configuration

This Capsule deliberately does not place application secrets or host policy in
Takoform state. Before making it selectable, a host must materialize the
Yurucommu encryption/bootstrap or OIDC configuration, optional notification
push configuration, the public hostname, queue consumers, the hourly scheduled
handler, and D1 migration activation through reviewed host-owned seams.

Takosumi Cloud does not yet satisfy all of those gates. The candidate must
therefore stay outside the selectable Store path until the exact provider/Form
Package release, target capability, lifecycle, and rollback evidence is
complete.
