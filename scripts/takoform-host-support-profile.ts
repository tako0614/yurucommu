#!/usr/bin/env bun

/**
 * The Takoform Host support profile this module is installed into.
 *
 * A `deploy/takoform` graph can only plan where the Host declares every
 * FormRef the pinned Provider release emits. The Host owns that declaration:
 * Takoserver generates `src/generated/takoform-stable-v1-catalog.ts` from a
 * published publisher set and serves it at
 * `/apis/forms.takoform.com/v1/support/forms`. This module records the
 * projection so the repository can refuse an install identity the Host cannot
 * plan, without copying the Host's authority or re-deriving it at run time.
 *
 * The record is derived, never hand-edited:
 *
 *   bun scripts/takoform-host-support-profile.ts --print
 *   bun scripts/takoform-host-support-profile.ts --write
 *   bun scripts/takoform-host-support-profile.ts --check
 *
 * `--check` re-derives from the published sources and fails when the recorded
 * projection has drifted. `scripts/takosumi-install-identity.test.ts`
 * re-derives the same facts from the recorded revisions, so a stale record
 * fails `bun run check` as well.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const HOST_SUPPORT_PROFILE_PATH =
  "deploy/takoform/host-support-profile.json";
export const HOST_SUPPORT_PROFILE_FORMAT =
  "yurucommu.takoform-host-support-profile@v1";

export const TAKOSERVER_REPOSITORY =
  "https://github.com/tako0614/takoserver.git";
export const TAKOSERVER_HOST_SOURCE_PATH =
  "src/generated/takoform-stable-v1-catalog.ts";
export const TAKOSERVER_SUPPORT_ROUTE_PATH =
  "/apis/forms.takoform.com/v1/support/forms";
export const TAKOSERVER_REFUSAL_CODE =
  "takoform.provider/host-does-not-support-form";

export const TAKOFORM_PROVIDER_REPOSITORY =
  "https://github.com/tako0614/terraform-provider-takoform.git";
export const TAKOFORM_PROVIDER_ADDRESS =
  "registry.terraform.io/tako0614/takoform";
export const TAKOFORM_PROVIDER_LEDGER_PATH =
  "release/provider-form-identities.json";
export const TAKOFORM_PROVIDER_RELEASE_PATH = "release/version.json";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const NETWORK_TIMEOUT_MS = 30_000;

export interface DeclaredHostForm {
  readonly resourceType: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

export interface DeclaredHostBinding {
  readonly apiVersion: string;
  readonly name: string;
  readonly version: string;
  readonly schemaDigest: string;
}

export interface ProviderReleaseRecord {
  readonly version: string;
  readonly tag: string;
  readonly tagCommit: string | null;
  readonly address: string;
  readonly portableApiVersion: string;
  readonly publicationStatus: string;
  readonly formPublisherCommit: string | null;
  readonly formSetTag: string | null;
  readonly emittedFormCount: number;
  readonly supported: boolean;
  readonly unsupportedFormRefs?: readonly string[];
}

export interface HostSupportProfile {
  readonly format: string;
  readonly host: {
    readonly product: string;
    readonly repository: string;
    readonly commit: string;
    readonly sourcePath: string;
    readonly sourceSha256: string;
    readonly supportRoutePath: string;
    readonly refusalCode: string;
    readonly publisherSet: {
      readonly repository: string;
      readonly repositoryCommit: string;
      readonly setId: string;
      readonly setTag: string;
      readonly publicationStatus: string;
      readonly verificationReceiptDigest: string;
      readonly formCount: number;
      readonly interfaceCount: number;
      readonly bindingCount: number;
    };
    readonly declaredForms: readonly DeclaredHostForm[];
    readonly declaredBindings: readonly DeclaredHostBinding[];
  };
  readonly providerReleases: readonly ProviderReleaseRecord[];
  readonly providerLedger: {
    readonly repository: string;
    readonly commit: string;
    readonly path: string;
  };
}

export function sha256Digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Read the object literal that starts at `openIndex` (`{`), honouring nested
 * braces and string literals. The generated Host catalog is a TypeScript
 * object literal with no interpolation, so this is exact for this input.
 */
function objectLiteralAt(source: string, openIndex: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  throw new Error("unbalanced object literal in the Host catalog source");
}

function objectLiteralsNamed(source: string, name: string): string[] {
  const literals: string[] = [];
  const pattern = new RegExp(`${name}:\\s*\\{`, "gu");
  let match = pattern.exec(source);
  while (match !== null) {
    const open = source.indexOf("{", match.index);
    const literal = objectLiteralAt(source, open);
    literals.push(literal);
    pattern.lastIndex = open + literal.length;
    match = pattern.exec(source);
  }
  return literals;
}

function stringMember(literal: string, name: string): string | undefined {
  return new RegExp(`${name}:\\s*"([^"]*)"`, "u").exec(literal)?.[1];
}

function numberMember(literal: string, name: string): number | undefined {
  const value = new RegExp(`${name}:\\s*(\\d+)`, "u").exec(literal)?.[1];
  return value === undefined ? undefined : Number(value);
}

function requiredString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`the Host catalog source does not declare ${label}`);
  }
  return value;
}

function requiredNumber(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isInteger(value)) {
    throw new Error(`the Host catalog source does not declare ${label}`);
  }
  return value;
}

export interface ParsedHostCatalog {
  readonly provenance: HostSupportProfile["host"]["publisherSet"];
  readonly forms: readonly Omit<DeclaredHostForm, "resourceType">[];
  readonly bindings: readonly DeclaredHostBinding[];
}

/** Read the generated Host catalog: its publisher-set provenance and members. */
export function parseDeclaredHostCatalog(source: string): ParsedHostCatalog {
  const provenanceLiteral = objectLiteralsNamed(source, "provenance")[0];
  if (provenanceLiteral === undefined) {
    throw new Error("the Host catalog source has no provenance object");
  }
  const provenance = Object.freeze({
    repository: requiredString(
      stringMember(provenanceLiteral, "repository"),
      "provenance.repository",
    ),
    repositoryCommit: requiredString(
      stringMember(provenanceLiteral, "repositoryCommit"),
      "provenance.repositoryCommit",
    ),
    setId: requiredString(
      stringMember(provenanceLiteral, "setId"),
      "provenance.setId",
    ),
    setTag: requiredString(
      stringMember(provenanceLiteral, "setTag"),
      "provenance.setTag",
    ),
    publicationStatus: requiredString(
      stringMember(provenanceLiteral, "publicationStatus"),
      "provenance.publicationStatus",
    ),
    verificationReceiptDigest: requiredString(
      stringMember(provenanceLiteral, "verificationReceiptDigest"),
      "provenance.verificationReceiptDigest",
    ),
    formCount: requiredNumber(
      numberMember(provenanceLiteral, "formCount"),
      "provenance.formCount",
    ),
    interfaceCount: requiredNumber(
      numberMember(provenanceLiteral, "interfaceCount"),
      "provenance.interfaceCount",
    ),
    bindingCount: requiredNumber(
      numberMember(provenanceLiteral, "bindingCount"),
      "provenance.bindingCount",
    ),
  });

  const forms = objectLiteralsNamed(source, "formRef").map((literal) => ({
    apiVersion: requiredString(
      stringMember(literal, "apiVersion"),
      "formRef.apiVersion",
    ),
    kind: requiredString(stringMember(literal, "kind"), "formRef.kind"),
    definitionVersion: requiredString(
      stringMember(literal, "definitionVersion"),
      "formRef.definitionVersion",
    ),
    schemaDigest: requiredString(
      stringMember(literal, "schemaDigest"),
      "formRef.schemaDigest",
    ),
  }));
  const bindings = objectLiteralsNamed(source, "bindingRef").map((literal) => ({
    apiVersion: requiredString(
      stringMember(literal, "apiVersion"),
      "bindingRef.apiVersion",
    ),
    name: requiredString(stringMember(literal, "name"), "bindingRef.name"),
    version: requiredString(
      stringMember(literal, "version"),
      "bindingRef.version",
    ),
    schemaDigest: requiredString(
      stringMember(literal, "schemaDigest"),
      "bindingRef.schemaDigest",
    ),
  }));

  if (forms.length !== provenance.formCount) {
    throw new Error(
      `the Host catalog declares ${provenance.formCount} forms but carries ${forms.length} formRef entries`,
    );
  }
  if (bindings.length !== provenance.bindingCount) {
    throw new Error(
      `the Host catalog declares ${provenance.bindingCount} bindings but carries ${bindings.length} bindingRef entries`,
    );
  }
  return { provenance, forms, bindings };
}

export interface ProviderLedgerRelease {
  readonly providerVersion: string;
  readonly portableApiVersion: string;
  readonly forms: readonly {
    readonly resourceType: string;
    readonly apiVersion: string;
    readonly kind: string;
    readonly definitionVersion: string;
    readonly schemaDigest: string;
  }[];
}

/** The exact Form identity: `apiVersion` family plus the immutable definition version. */
export function formRefKey(formRef: {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
}): string {
  return `${formRef.apiVersion} ${formRef.kind}@${formRef.definitionVersion}`;
}

/** Read the released Provider's FormRef ledger for every release it carries. */
export function parseProviderLedger(
  source: string,
): readonly ProviderLedgerRelease[] {
  const document = JSON.parse(source) as {
    format?: unknown;
    releases?: unknown;
  };
  if (
    document.format !== "takoform.provider-form-identities@v1" ||
    !Array.isArray(document.releases)
  ) {
    throw new Error(
      "the Provider ledger is not a takoform.provider-form-identities@v1 document",
    );
  }
  return (document.releases as readonly Record<string, any>[]).map(
    (release) => ({
      providerVersion: requiredString(
        release.providerVersion,
        "releases[].providerVersion",
      ),
      portableApiVersion: requiredString(
        release.portableApiVersion,
        "releases[].portableApiVersion",
      ),
      forms: (Array.isArray(release.forms) ? release.forms : []).map(
        (form: Record<string, any>) => ({
          resourceType: requiredString(
            form.resourceType,
            "releases[].forms[].resourceType",
          ),
          apiVersion: requiredString(
            form.formRef?.apiVersion,
            "releases[].forms[].formRef.apiVersion",
          ),
          kind: requiredString(
            form.formRef?.kind,
            "releases[].forms[].formRef.kind",
          ),
          definitionVersion: requiredString(
            form.formRef?.definitionVersion,
            "releases[].forms[].formRef.definitionVersion",
          ),
          schemaDigest: requiredString(
            form.formRef?.schemaDigest,
            "releases[].forms[].formRef.schemaDigest",
          ),
        }),
      ),
    }),
  );
}

export interface ProviderReleaseSource {
  readonly version: string;
  readonly tagCommit: string | null;
  readonly release: Record<string, unknown> | null;
}

export function deriveHostSupportProfile(input: {
  readonly hostCommit: string;
  readonly hostSource: string;
  readonly providerLedgerCommit: string;
  readonly providerLedger: readonly ProviderLedgerRelease[];
  readonly providerReleases: readonly ProviderReleaseSource[];
}): HostSupportProfile {
  const catalog = parseDeclaredHostCatalog(input.hostSource);
  const declared = new Map(
    catalog.forms.map((form) => [formRefKey(form), form]),
  );

  const resourceTypes = new Map<string, string>();
  for (const release of input.providerLedger) {
    for (const form of release.forms) {
      const key = formRefKey(form);
      const existing = resourceTypes.get(key);
      if (existing !== undefined && existing !== form.resourceType) {
        throw new Error(
          `the Provider ledger maps ${key} to both ${existing} and ${form.resourceType}`,
        );
      }
      resourceTypes.set(key, form.resourceType);
    }
  }

  const declaredForms: DeclaredHostForm[] = catalog.forms.map((form) => {
    const key = formRefKey(form);
    const resourceType = resourceTypes.get(key);
    if (resourceType === undefined) {
      throw new Error(
        `the Provider ledger does not carry the resource type for ${key}`,
      );
    }
    return { resourceType, ...form };
  });

  const providerReleases: ProviderReleaseRecord[] = input.providerReleases
    .map((source) => {
      const ledgerRelease = input.providerLedger.find(
        (release) => release.providerVersion === source.version,
      );
      if (ledgerRelease === undefined) {
        throw new Error(
          `the Provider ledger does not carry release ${source.version}`,
        );
      }
      const formPublisherCommit =
        (source.release?.formPublisherCommit as string | undefined) ?? null;
      const formSetTag =
        (source.release?.formSetTag as string | undefined) ?? null;
      const missing = ledgerRelease.forms.filter((form) => {
        const hostForm = declared.get(formRefKey(form));
        return hostForm?.schemaDigest !== form.schemaDigest;
      });
      const supported =
        formSetTag === catalog.provenance.setTag &&
        formPublisherCommit === catalog.provenance.repositoryCommit &&
        missing.length === 0;
      return {
        version: source.version,
        tag: `v${source.version}`,
        tagCommit: source.tagCommit,
        address: TAKOFORM_PROVIDER_ADDRESS,
        portableApiVersion: ledgerRelease.portableApiVersion,
        publicationStatus:
          (source.release?.publicationStatus as string | undefined) ??
          "unknown",
        formPublisherCommit,
        formSetTag,
        emittedFormCount: ledgerRelease.forms.length,
        supported,
        ...(supported
          ? {}
          : {
              unsupportedFormRefs: missing.map((form) => formRefKey(form)),
            }),
      };
    })
    .sort((left, right) => compareVersions(right.version, left.version));

  if (!providerReleases.some((release) => release.supported)) {
    throw new Error(
      `no released Provider carries the Host publisher set ${catalog.provenance.setTag}`,
    );
  }

  return {
    format: HOST_SUPPORT_PROFILE_FORMAT,
    host: {
      product: "Takoserver",
      repository: TAKOSERVER_REPOSITORY,
      commit: input.hostCommit,
      sourcePath: TAKOSERVER_HOST_SOURCE_PATH,
      sourceSha256: sha256Digest(input.hostSource),
      supportRoutePath: TAKOSERVER_SUPPORT_ROUTE_PATH,
      refusalCode: TAKOSERVER_REFUSAL_CODE,
      publisherSet: {
        repository: catalog.provenance.repository,
        repositoryCommit: catalog.provenance.repositoryCommit,
        setId: catalog.provenance.setId,
        setTag: catalog.provenance.setTag,
        publicationStatus: catalog.provenance.publicationStatus,
        verificationReceiptDigest: catalog.provenance.verificationReceiptDigest,
        formCount: catalog.provenance.formCount,
        interfaceCount: catalog.provenance.interfaceCount,
        bindingCount: catalog.provenance.bindingCount,
      },
      declaredForms,
      declaredBindings: catalog.bindings,
    },
    providerLedger: {
      repository: TAKOFORM_PROVIDER_REPOSITORY,
      commit: input.providerLedgerCommit,
      path: TAKOFORM_PROVIDER_LEDGER_PATH,
    },
    providerReleases,
  };
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value.split(".").map((part) => Number.parseInt(part, 10));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function serializeHostSupportProfile(
  profile: HostSupportProfile,
): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

export function repositoryFileUrl(
  repository: string,
  ref: string,
  path: string,
): string {
  const slug = repository
    .replace(/^https:\/\/github\.com\//u, "")
    .replace(/\.git$/u, "");
  return `https://raw.githubusercontent.com/${slug}/${ref}/${path}`;
}

export async function fetchRepositoryFile(
  repository: string,
  ref: string,
  path: string,
): Promise<string> {
  const url = repositoryFileUrl(repository, ref, path);
  const response = await fetch(url, {
    headers: { "user-agent": "yurucommu-install-identity" },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return await response.text();
}

export function resolveRemoteRef(
  repository: string,
  ref: string,
): string | null {
  const output = execFileSync("git", ["ls-remote", repository, ref], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: NETWORK_TIMEOUT_MS,
  });
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  // An annotated tag lists both the tag object and its peeled commit last.
  return lines[lines.length - 1]!.split("\t")[0] ?? null;
}

export function resolveRemoteTags(
  repository: string,
): ReadonlyMap<string, string> {
  const output = execFileSync("git", ["ls-remote", "--tags", repository], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: NETWORK_TIMEOUT_MS,
  });
  const tags = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [commit, ref] = line.trim().split("\t");
    if (commit === undefined || ref === undefined) continue;
    if (!ref.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length);
    if (name.endsWith("^{}")) {
      tags.set(name.slice(0, -3), commit);
      continue;
    }
    if (!tags.has(name)) tags.set(name, commit);
  }
  return tags;
}

export async function deriveHostSupportProfileFromRemotes(
  options: {
    readonly hostCommit?: string;
    readonly providerLedgerCommit?: string;
  } = {},
): Promise<HostSupportProfile> {
  const hostCommit =
    options.hostCommit ??
    resolveRemoteRef(TAKOSERVER_REPOSITORY, "refs/heads/main");
  if (hostCommit === null) {
    throw new Error(`cannot resolve ${TAKOSERVER_REPOSITORY} main`);
  }
  const providerLedgerCommit =
    options.providerLedgerCommit ??
    resolveRemoteRef(TAKOFORM_PROVIDER_REPOSITORY, "refs/heads/main");
  if (providerLedgerCommit === null) {
    throw new Error(`cannot resolve ${TAKOFORM_PROVIDER_REPOSITORY} main`);
  }

  const [hostSource, providerLedgerSource] = await Promise.all([
    fetchRepositoryFile(
      TAKOSERVER_REPOSITORY,
      hostCommit,
      TAKOSERVER_HOST_SOURCE_PATH,
    ),
    fetchRepositoryFile(
      TAKOFORM_PROVIDER_REPOSITORY,
      providerLedgerCommit,
      TAKOFORM_PROVIDER_LEDGER_PATH,
    ),
  ]);
  const providerLedger = parseProviderLedger(providerLedgerSource);
  const providerTags = resolveRemoteTags(TAKOFORM_PROVIDER_REPOSITORY);

  const providerReleases: ProviderReleaseSource[] = [];
  for (const release of providerLedger) {
    if (!VERSION_PATTERN.test(release.providerVersion)) {
      throw new Error(
        `the Provider ledger carries a non-release version ${release.providerVersion}`,
      );
    }
    const tag = `v${release.providerVersion}`;
    const tagCommit = providerTags.get(tag) ?? null;
    const releaseSource =
      tagCommit === null
        ? null
        : (JSON.parse(
            await fetchRepositoryFile(
              TAKOFORM_PROVIDER_REPOSITORY,
              tag,
              TAKOFORM_PROVIDER_RELEASE_PATH,
            ),
          ) as Record<string, unknown>);
    providerReleases.push({
      version: release.providerVersion,
      tagCommit,
      release: releaseSource,
    });
  }

  return deriveHostSupportProfile({
    hostCommit,
    hostSource,
    providerLedgerCommit,
    providerLedger,
    providerReleases,
  });
}

export function readHostSupportProfile(
  repoRoot: string = REPO_ROOT,
): HostSupportProfile {
  const source = readFileSync(
    resolve(repoRoot, HOST_SUPPORT_PROFILE_PATH),
    "utf8",
  );
  const profile = JSON.parse(source) as HostSupportProfile;
  const failures = inspectHostSupportProfile(profile);
  if (failures.length > 0) {
    throw new Error(
      `${HOST_SUPPORT_PROFILE_PATH} is not a valid recorded profile:\n${failures
        .map((failure) => `- ${failure}`)
        .join("\n")}`,
    );
  }
  return profile;
}

/** Structural checks on the recorded projection, without touching the network. */
export function inspectHostSupportProfile(
  profile: HostSupportProfile,
): readonly string[] {
  const failures: string[] = [];
  if (profile?.format !== HOST_SUPPORT_PROFILE_FORMAT) {
    failures.push(`format must be ${HOST_SUPPORT_PROFILE_FORMAT}`);
    return failures;
  }
  const host = profile.host;
  if (!COMMIT_PATTERN.test(host?.commit ?? "")) {
    failures.push("host.commit must be a 40-hex commit");
  }
  if (host?.sourcePath !== TAKOSERVER_HOST_SOURCE_PATH) {
    failures.push(`host.sourcePath must be ${TAKOSERVER_HOST_SOURCE_PATH}`);
  }
  if (!SHA256_PATTERN.test(host?.sourceSha256 ?? "")) {
    failures.push("host.sourceSha256 must be a sha256 digest");
  }
  if (!COMMIT_PATTERN.test(host?.publisherSet?.repositoryCommit ?? "")) {
    failures.push("host.publisherSet.repositoryCommit must be a 40-hex commit");
  }
  if ((host?.publisherSet?.publicationStatus ?? "") !== "published") {
    failures.push(
      "host.publisherSet.publicationStatus must be published: an unpublished set cannot be a Host declaration",
    );
  }
  if (host?.declaredForms?.length !== host?.publisherSet?.formCount) {
    failures.push(
      "host.declaredForms must carry exactly host.publisherSet.formCount forms",
    );
  }
  if (host?.declaredBindings?.length !== host?.publisherSet?.bindingCount) {
    failures.push(
      "host.declaredBindings must carry exactly host.publisherSet.bindingCount bindings",
    );
  }
  for (const form of host?.declaredForms ?? []) {
    if (!SHA256_PATTERN.test(form.schemaDigest ?? "")) {
      failures.push(
        `host.declaredForms ${formRefKey(form)} needs a sha256 schemaDigest`,
      );
    }
    if ((form.apiVersion ?? "").length === 0) {
      failures.push(
        `host.declaredForms ${form.resourceType} needs its FormRef apiVersion`,
      );
    }
    if (!(form.resourceType ?? "").startsWith("takoform_")) {
      failures.push(
        `host.declaredForms ${formRefKey(form)} needs its Provider resource type`,
      );
    }
  }
  const versions = new Set<string>();
  for (const release of profile.providerReleases ?? []) {
    if (versions.has(release.version)) {
      failures.push(`providerReleases lists ${release.version} twice`);
    }
    versions.add(release.version);
    if (release.address !== TAKOFORM_PROVIDER_ADDRESS) {
      failures.push(
        `providerReleases ${release.version} address must be ${TAKOFORM_PROVIDER_ADDRESS}`,
      );
    }
    if (release.tagCommit !== null && !COMMIT_PATTERN.test(release.tagCommit)) {
      failures.push(
        `providerReleases ${release.version} tagCommit must be a 40-hex commit or null`,
      );
    }
    const carriesSet =
      release.formSetTag === host.publisherSet.setTag &&
      release.formPublisherCommit === host.publisherSet.repositoryCommit;
    if (release.supported && !carriesSet) {
      failures.push(
        `providerReleases ${release.version} is recorded as supported without the Host publisher set`,
      );
    }
    if (!release.supported && carriesSet && release.tagCommit !== null) {
      failures.push(
        `providerReleases ${release.version} carries the Host publisher set and cannot be recorded as unsupported`,
      );
    }
    if (
      !release.supported &&
      (release.unsupportedFormRefs ?? []).length === 0
    ) {
      failures.push(
        `providerReleases ${release.version} must name the FormRefs the Host does not declare`,
      );
    }
  }
  if (!(profile.providerReleases ?? []).some((release) => release.supported)) {
    failures.push("providerReleases must carry at least one supported release");
  }
  if (!COMMIT_PATTERN.test(profile.providerLedger?.commit ?? "")) {
    failures.push("providerLedger.commit must be a 40-hex commit");
  }
  if (profile.providerLedger?.path !== TAKOFORM_PROVIDER_LEDGER_PATH) {
    failures.push(
      `providerLedger.path must be ${TAKOFORM_PROVIDER_LEDGER_PATH}`,
    );
  }
  return failures;
}

export function supportedProviderReleases(
  profile: HostSupportProfile,
): readonly ProviderReleaseRecord[] {
  return profile.providerReleases.filter((release) => release.supported);
}

export function findProviderRelease(
  profile: HostSupportProfile,
  version: string,
): ProviderReleaseRecord | undefined {
  return profile.providerReleases.find(
    (release) => release.version === version,
  );
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const profile = await deriveHostSupportProfileFromRemotes();
  const serialized = serializeHostSupportProfile(profile);
  if (arguments_.includes("--write")) {
    writeFileSync(resolve(REPO_ROOT, HOST_SUPPORT_PROFILE_PATH), serialized);
    console.log(
      `wrote ${HOST_SUPPORT_PROFILE_PATH} from ${profile.host.repository}@${profile.host.commit}`,
    );
    return;
  }
  if (arguments_.includes("--check")) {
    const recorded = readFileSync(
      resolve(REPO_ROOT, HOST_SUPPORT_PROFILE_PATH),
      "utf8",
    );
    if (recorded !== serialized) {
      console.error(
        `${HOST_SUPPORT_PROFILE_PATH} no longer matches the published Host declaration`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`${HOST_SUPPORT_PROFILE_PATH} matches the published sources`);
    return;
  }
  process.stdout.write(serialized);
}

if (import.meta.main) {
  await main();
}
