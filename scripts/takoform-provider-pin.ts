/**
 * The exact Takoform Provider release `deploy/takoform` is pinned to.
 *
 * Declared once so that moving the pin is a two-line change — this constant and
 * the `version` line in `deploy/takoform/main.tf` — rather than a literal that
 * has to be found again in every gate that checks it.
 *
 * `MEDIA` is a portable `ObjectBucket` bound through `bucket_bindings`, and
 * neither exists before Provider `4.0.0`. Provider `4.1.0` adds an optional
 * token-file authentication mode; the module's Forms and resource graph stay
 * unchanged. See deploy/takoform/README.md.
 */
export const TAKOFORM_PROVIDER_VERSION = "4.1.0";

/** The exact `required_providers` line the module must carry. */
export const TAKOFORM_PROVIDER_PIN = `version = "= ${TAKOFORM_PROVIDER_VERSION}"`;
