terraform {
  required_version = ">= 1.5"

  required_providers {
    takoform = {
      source  = "registry.terraform.io/tako0614/takoform"
      version = ">= 3.0.0"
    }
  }
}

variable "name" {
  description = "Unique resource name for this destructive fetch tracer run."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,62}$", var.name))
    error_message = "name must be 3-63 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "probe_nonce" {
  description = "Non-secret per-run value that proves the deployed Worker answered."
  type        = string
}

resource "takoform_module_worker" "probe" {
  name = var.name
}

resource "takoform_worker_bundle" "probe" {
  revision_owner = takoform_module_worker.probe.name
  main_module    = "worker.mjs"

  modules = [
    {
      name         = "worker.mjs"
      content_type = "application/javascript+module"
      content_file = "${path.module}/worker.mjs"
    },
  ]
}

resource "takoform_worker_version" "probe" {
  revision_owner = takoform_module_worker.probe.name
  worker         = takoform_module_worker.probe.name
  bundle         = takoform_worker_bundle.probe.name
  handlers       = ["fetch"]
  vars_json      = jsonencode({ PROBE_NONCE = var.probe_nonce })
}

resource "takoform_worker_deployment" "probe" {
  name   = "${var.name}-deployment"
  worker = takoform_module_worker.probe.name

  versions = [
    {
      worker_version = takoform_worker_version.probe.name
      weight         = 10000
    },
  ]
}

resource "takoform_worker_endpoint" "probe" {
  name   = "${var.name}-endpoint"
  worker = takoform_module_worker.probe.name

  depends_on = [takoform_worker_deployment.probe]
}

output "endpoint_url" {
  description = "Ordinary HTTP URL allocated for the fetch-only probe."
  value       = takoform_worker_endpoint.probe.url
}
