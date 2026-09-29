#!/usr/bin/env bun

/**
 * The one install identity this repository declares.
 *
 * Three surfaces have to agree, and nothing in the release flow rewrites two of
 * them:

 * - the release identity: `package.json` version, `main.tf`
 *   `worker_release_tag` / `worker_bundle_url` / `worker_bundle_sha256`,
 *   `release.lock.json`, and the `CHANGELOG.md` section;
 * - the install identity: `.well-known/tcs.json` `modulePath` / `provider`,
 *   `.well-known/takosumi.json` `install.modules`, and the scanned OpenTofu
 *   roots that actually exist in the tree;
 * - the revision the website hands to Takosumi, which has to be a revision of
 *   this repository that declares the same app release and installs a module
 *   whose pinned Provider Release the Host support profile declares.

 * The historical defect this exists for: the website CTA pinned a revision
 * (`v2.1.10`) whose `deploy/takoform` module pinned the superseded Provider
 * `3.0.0`. No gate noticed, because the only guard compared a literal to the
 * same literal in the page. `evaluateInstallIdentity` compares the surfaces to
 * each other and to the recorded Host profile instead.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REPO_ROOT,
  findProviderRelease,
  inspectHostSupportProfile,
  repositoryFileUrl,
  resolveRemoteTags,
  type HostSupportProfile,
} from "./takoform-host-support-profile.ts";

export const YURUCOMMU_REPOSITORY = "https://github.com/tako0614/yurucommu.git";
export const YURUCOMMU_RELEASE_ASSET = "yurucommu-worker.js";
export const YURUCOMMU_RELEASE_MANIFEST = "takosumi-artifact.json";
export const TCS_PATH = ".well-known/tcs.json";
export const TAKOSUMI_MANIFEST_PATH = ".well-known/takosumi.json";
export const SITE_INDEX_PATH = "site/index.html";
export const RELEASE_LOCK_PATH = "release.lock.json";
export const ROOT_MODULE_PATH = ".";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const RELEASE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;
const TIMEOUT_MS = 30_000;

export interface TerraformProviderRequirement {
  readonly localName: string;
  readonly source: string;
  readonly version: string;
}

export interface TerraformVariable {
  readonly name: string;
  readonly hasDefault: boolean;
}

export interface TerraformModuleFacts {
  readonly path: string;
  readonly source: string;
  readonly resourceTypes: readonly string[];
  readonly variables: readonly TerraformVariable[];
  readonly providerRequirements: readonly TerraformProviderRequirement[];
}

export interface RemoteReleaseTag {
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
}

export interface InstallTargetFacts {
  readonly ref: string;
  readonly modulePath: string;
  readonly module: TerraformModuleFacts;
  readonly appVersion: string | null;
}

export interface ReleaseLockEntry {
  readonly artifact: {
    readonly filename: string;
    readonly url: string;
    readonly sha256: string;
  };
  readonly manifest: { readonly url: string; readonly sha256: string };
  readonly commit: string;
  readonly seededFrom: string;
}

export interface TcsDocument {
  readonly schemaVersion?: string;
  readonly modulePath?: string;
  readonly provider?: string;
}

export interface TakosumiDocument {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly install?: {
    readonly defaultModule?: unknown;
    readonly modules?: Record<
      string,
      {
        readonly inputs?: readonly {
          readonly name?: string;
          readonly source?: { readonly kind?: string };
        }[];
      }
    >;
  };
}

export interface InstallIdentityFacts {
  readonly repositoryUrl: string;
  readonly repository: {
    readonly version: string;
    readonly tag: string;
    readonly bundleUrl: string;
    readonly bundleSha256: string;
    readonly changelog: string;
    readonly releaseLock: {
      readonly releases: Record<string, ReleaseLockEntry>;
    };
    readonly tcs: TcsDocument;
    readonly takosumi: TakosumiDocument;
    readonly siteHtml: string;
    readonly modules: readonly TerraformModuleFacts[];
  };
  readonly remote: {
    readonly releaseTags: readonly RemoteReleaseTag[];
    readonly tagCommit: string | null;
    readonly installTarget: InstallTargetFacts | null;
  };
  readonly hostProfile: HostSupportProfile;
}

const CHANGELOG_HEADING_PATTERN_CACHE = new Map<string, RegExp>();

/** The `{ ... }` block that starts at `openIndex`, honouring nesting and strings. */
function balancedBraces(source: string, openIndex: number): string {
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
  throw new Error("unbalanced block in the OpenTofu source");
}

function keywordBlock(source: string, keyword: string): string | undefined {
  const match = new RegExp(`${keyword}\\s*\\{`, "u").exec(source);
  if (match === null) return undefined;
  return balancedBraces(source, source.indexOf("{", match.index));
}

function changelogHeading(version: string): RegExp {
  const cached = CHANGELOG_HEADING_PATTERN_CACHE.get(version);
  if (cached !== undefined) return cached;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^## ${escaped}(?: - |$)`, "mu");
  CHANGELOG_HEADING_PATTERN_CACHE.set(version, pattern);
  return pattern;
}

/** Terraform OpenTofu string variable default, exactly as the module declares it. */
export function terraformStringDefault(
  source: string,
  variable: string,
): string | undefined {
  return source
    .match(
      new RegExp(`variable\\s+"${variable}"\\s*\\{([\\s\\S]*?)\\n\\}`, "u"),
    )?.[1]
    ?.match(/default\s+=\s+"([^"]*)"/u)?.[1];
}

export function parseTerraformModuleFacts(
  path: string,
  source: string,
): TerraformModuleFacts {
  const resourceTypes = [
    ...source.matchAll(/^resource\s+"(takoform_[a-z0-9_]+)"/gmu),
  ].map((match) => match[1]!);
  const variables: TerraformVariable[] = [];
  for (const match of source.matchAll(
    /^variable\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/gmu,
  )) {
    variables.push({
      name: match[1]!,
      hasDefault: /(?:^|\n)\s*default\s*=/u.test(match[2]!),
    });
  }
  const providerBlock = keywordBlock(source, "required_providers") ?? "";
  const providerRequirements: TerraformProviderRequirement[] = [];
  for (const match of providerBlock.matchAll(/(\w+)\s*=\s*\{/gu)) {
    const body = balancedBraces(
      providerBlock,
      providerBlock.indexOf("{", match.index),
    );
    providerRequirements.push({
      localName: match[1]!,
      source: /source\s*=\s*"([^"]*)"/u.exec(body)?.[1] ?? "",
      version: /version\s*=\s*"([^"]*)"/u.exec(body)?.[1] ?? "",
    });
  }
  return {
    path,
    source,
    resourceTypes: [...new Set(resourceTypes)].sort(),
    variables,
    providerRequirements,
  };
}

function git(repoRoot: string, arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
  });
}

/** Every tracked OpenTofu root in the working tree, keyed by repository-relative path. */
export function readScannedModules(
  repoRoot: string = REPO_ROOT,
): readonly TerraformModuleFacts[] {
  const tracked = git(repoRoot, ["ls-files", "--", "*.tf"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tf"));
  const byDirectory = new Map<string, string[]>();
  for (const path of tracked) {
    const directory = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : ROOT_MODULE_PATH;
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), path]);
  }
  const modules: TerraformModuleFacts[] = [];
  for (const [directory, paths] of byDirectory) {
    const sources = paths.map((path) =>
      readFileSync(resolve(repoRoot, path), "utf8"),
    );
    if (!sources.some((source) => /^terraform\s*\{/mu.test(source))) continue;
    const facts = parseTerraformModuleFacts(directory, sources.join("\n"));
    modules.push({
      ...facts,
      variables: facts.variables,
      providerRequirements: facts.providerRequirements,
    });
  }
  return modules.sort((left, right) => left.path.localeCompare(right.path));
}

export function readSiteInstallLinks(
  html: string,
): readonly { readonly href: string; readonly url: URL }[] {
  return [
    ...html.matchAll(/href="([^"]*app\.takosumi\.com\/install[^"]*)"/gu),
  ].map((match) => {
    const href = match[1]!.replaceAll("&amp;", "&");
    return { href, url: new URL(href) };
  });
}

export function parseReleaseVersion(
  tag: string,
): { readonly version: string } | undefined {
  return RELEASE_TAG_PATTERN.test(tag) ? { version: tag.slice(1) } : undefined;
}

export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = RELEASE_TAG_PATTERN.exec(`v${value}`);
    if (match === null) throw new Error(`${value} is not a release version`);
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] === undefined ? undefined : match[4].split("."),
    };
  };
  const leftParsed = parse(left);
  const rightParsed = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParsed.core[index]! - rightParsed.core[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (leftParsed.prerelease === rightParsed.prerelease) return 0;
  if (leftParsed.prerelease === undefined) return 1;
  if (rightParsed.prerelease === undefined) return -1;
  const length = Math.max(
    leftParsed.prerelease.length,
    rightParsed.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParsed.prerelease[index];
    const rightPart = rightParsed.prerelease[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function resolveRemoteReleaseTags(
  repository: string = YURUCOMMU_REPOSITORY,
): readonly RemoteReleaseTag[] {
  const tags: RemoteReleaseTag[] = [];
  for (const [tag, commit] of resolveRemoteTags(repository)) {
    const parsed = parseReleaseVersion(tag);
    if (parsed === undefined) continue;
    tags.push({ tag, version: parsed.version, commit });
  }
  return tags.sort((left, right) =>
    compareReleaseVersions(right.version, left.version),
  );
}

export function readFileAtRef(
  ref: string,
  path: string,
  options: {
    readonly repoRoot?: string;
    readonly repository?: string;
  } = {},
): Promise<string | null> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  try {
    return Promise.resolve(git(repoRoot, ["show", `${ref}:${path}`]));
  } catch {
    // A shallow CI checkout has no object for a released revision.
  }
  return fetch(
    repositoryFileUrl(options.repository ?? YURUCOMMU_REPOSITORY, ref, path),
    {
      headers: { "user-agent": "yurucommu-install-identity" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  ).then(async (response) => (response.ok ? await response.text() : null));
}

export async function readInstallTarget(options: {
  readonly ref: string;
  readonly modulePath: string;
  readonly repoRoot?: string;
  readonly repository?: string;
}): Promise<InstallTargetFacts | null> {
  const [moduleSource, packageSource] = await Promise.all([
    readFileAtRef(options.ref, `${options.modulePath}/main.tf`, options),
    readFileAtRef(options.ref, "package.json", options),
  ]);
  if (moduleSource === null) return null;
  const appVersion =
    packageSource === null
      ? null
      : ((JSON.parse(packageSource) as { version?: string }).version ?? null);
  return {
    ref: options.ref,
    modulePath: options.modulePath,
    module: parseTerraformModuleFacts(options.modulePath, moduleSource),
    appVersion,
  };
}

/**
 * Compare the three surfaces against each other and against the recorded Host
 * support profile. Returns one message per disagreement; an empty list means
 * every surface names the same release, module, and Provider Release.
 */
export function evaluateInstallIdentity(
  facts: InstallIdentityFacts,
): readonly string[] {
  const failures: string[] = [];
  const { repository, remote, hostProfile } = facts;
  const release = repository.releaseLock.releases[repository.tag];
  const modulePaths = repository.modules.map((module) => module.path);
  const tcsModulePath = repository.tcs.modulePath;
  const declaredModule = repository.modules.find(
    (module) => module.path === tcsModulePath,
  );

  // Release identity: one version, one tag, one artifact, one lock entry.
  if (repository.tag !== `v${repository.version}`) {
    failures.push(
      `release identity: main.tf worker_release_tag is ${repository.tag} but package.json is ${repository.version}`,
    );
  }
  const releaseAssetUrl = `${facts.repositoryUrl.replace(/\.git$/u, "")}/releases/download/${repository.tag}/${YURUCOMMU_RELEASE_ASSET}`;
  if (repository.bundleUrl !== releaseAssetUrl) {
    failures.push(
      `release identity: main.tf worker_bundle_url is ${repository.bundleUrl || "<empty>"}, expected ${releaseAssetUrl}`,
    );
  }
  if (!changelogHeading(repository.version).test(repository.changelog)) {
    failures.push(
      `release identity: CHANGELOG.md carries no "## ${repository.version}" release notes`,
    );
  }
  if (release === undefined) {
    failures.push(
      `release identity: release.lock.json carries no ${repository.tag} pin, so the declared tag cannot select an append-only artifact`,
    );
  } else {
    if (release.artifact.sha256 !== repository.bundleSha256) {
      failures.push(
        `release identity: release.lock.json ${repository.tag} artifact sha256 is ${release.artifact.sha256} but main.tf worker_bundle_sha256 is ${repository.bundleSha256}`,
      );
    }
    if (release.artifact.url !== releaseAssetUrl) {
      failures.push(
        `release identity: release.lock.json ${repository.tag} artifact url is ${release.artifact.url}`,
      );
    }
    if (!COMMIT_PATTERN.test(release.commit)) {
      failures.push(
        `release identity: release.lock.json ${repository.tag} commit is not a 40-hex commit`,
      );
    }
    if (
      remote.tagCommit !== null &&
      COMMIT_PATTERN.test(release.commit) &&
      remote.tagCommit !== release.commit
    ) {
      failures.push(
        `release identity: tag ${repository.tag} resolves to ${remote.tagCommit} but release.lock.json pins ${release.commit}`,
      );
    }
  }

  // Install identity: the repository's own declaration.
  if (tcsModulePath === undefined || !modulePaths.includes(tcsModulePath)) {
    failures.push(
      `install identity: ${TCS_PATH} modulePath ${tcsModulePath ?? "<missing>"} is not a scanned OpenTofu root (${modulePaths.join(", ")})`,
    );
  } else if (
    !(declaredModule?.providerRequirements ?? []).some(
      (requirement) => requirement.localName === repository.tcs.provider,
    )
  ) {
    failures.push(
      `install identity: ${TCS_PATH} provider ${repository.tcs.provider ?? "<missing>"} is not a provider requirement of ${tcsModulePath}`,
    );
  }
  const manifest = repository.takosumi;
  if (
    manifest.apiVersion !== "takosumi.com/v2.4" ||
    manifest.kind !== "Repository"
  ) {
    failures.push(
      `install identity: ${TAKOSUMI_MANIFEST_PATH} must be a takosumi.com/v2.4 Repository document`,
    );
  }
  if (manifest.install?.defaultModule !== undefined) {
    failures.push(
      `install identity: ${TAKOSUMI_MANIFEST_PATH} carries install.defaultModule, which the closed takosumi.com/v2.4 object does not accept`,
    );
  }
  const declaredModulePaths = Object.keys(manifest.install?.modules ?? {});
  const missingModules = modulePaths.filter(
    (path) => !declaredModulePaths.includes(path),
  );
  const extraModules = declaredModulePaths.filter(
    (path) => !modulePaths.includes(path),
  );
  if (missingModules.length > 0 || extraModules.length > 0) {
    failures.push(
      `install identity: ${TAKOSUMI_MANIFEST_PATH} declares [${declaredModulePaths.join(", ")}] but the tree scans [${modulePaths.join(", ")}]`,
    );
  }
  if (
    tcsModulePath !== undefined &&
    !declaredModulePaths.includes(tcsModulePath)
  ) {
    failures.push(
      `install identity: ${TCS_PATH} installs ${tcsModulePath} but ${TAKOSUMI_MANIFEST_PATH} does not declare it`,
    );
  }
  for (const [path, module] of Object.entries(
    manifest.install?.modules ?? {},
  )) {
    const scanned = repository.modules.find(
      (candidate) => candidate.path === path,
    );
    if (scanned === undefined) continue;
    for (const input of module.inputs ?? []) {
      const variable = scanned.variables.find(
        (candidate) => candidate.name === input.name,
      );
      if (variable === undefined) {
        failures.push(
          `install identity: ${TAKOSUMI_MANIFEST_PATH} declares input ${input.name} for ${path}, which does not declare that variable`,
        );
        continue;
      }
      if (input.source?.kind === "module_default" && !variable.hasDefault) {
        failures.push(
          `install identity: ${TAKOSUMI_MANIFEST_PATH} reads ${path}.${input.name} as a module_default, but the variable has no default`,
        );
      }
    }
  }

  // Install identity: the revision the website hands to Takosumi.
  const links = readSiteInstallLinks(repository.siteHtml);
  if (links.length === 0) {
    failures.push(
      `install identity: ${SITE_INDEX_PATH} carries no Takosumi install link`,
    );
  }
  const refs = new Set<string>();
  for (const { url } of links) {
    const git = url.searchParams.get("git");
    const path = url.searchParams.get("path");
    const ref = url.searchParams.get("ref");
    if (git !== facts.repositoryUrl) {
      failures.push(
        `install identity: ${SITE_INDEX_PATH} install link points at ${git ?? "<missing git>"} instead of ${facts.repositoryUrl}`,
      );
    }
    if (path !== tcsModulePath) {
      failures.push(
        `install identity: ${SITE_INDEX_PATH} install link selects module ${path ?? "<missing path>"} instead of ${TCS_PATH} modulePath ${tcsModulePath ?? "<missing>"}`,
      );
    }
    if (ref === null || !COMMIT_PATTERN.test(ref)) {
      failures.push(
        `install identity: ${SITE_INDEX_PATH} install link needs a 40-hex commit ref, found ${ref ?? "<missing>"}`,
      );
      continue;
    }
    refs.add(ref);
  }
  if (refs.size > 1) {
    failures.push(
      `install identity: ${SITE_INDEX_PATH} install links select ${refs.size} different revisions`,
    );
  }

  const installRef = [...refs][0];
  const installTarget = remote.installTarget;
  if (installRef !== undefined && installTarget === null) {
    failures.push(
      `install identity: cannot read ${tcsModulePath ?? "<missing>"} at the revision ${installRef} the website hands to Takosumi`,
    );
  }
  if (installTarget !== null) {
    if (installTarget.ref !== installRef) {
      failures.push(
        `install identity: evaluated install target ${installTarget.ref} is not the website ref ${installRef ?? "<missing>"}`,
      );
    }
    if (
      installTarget.ref !== tcsModulePath &&
      installTarget.modulePath !== tcsModulePath
    ) {
      failures.push(
        `install identity: install target module is ${installTarget.modulePath}, expected ${tcsModulePath ?? "<missing>"}`,
      );
    }
    failures.push(
      ...evaluateModuleAgainstHost({
        label: `install target ${installTarget.ref}`,
        module: installTarget.module,
        hostProfile,
      }),
    );

    // The website may hand out the declared release revision, or - between
    // cutting a release and moving the pin - the release it supersedes.
    const publishedVersions = remote.releaseTags.map((tag) => tag.version);
    const declaredPublished = publishedVersions.includes(repository.version);
    const previousVersion = publishedVersions
      .filter(
        (version) => compareReleaseVersions(version, repository.version) < 0,
      )
      .sort((left, right) => compareReleaseVersions(right, left))[0];
    const allowedVersions = declaredPublished
      ? [repository.version]
      : [
          repository.version,
          ...(previousVersion === undefined ? [] : [previousVersion]),
        ];
    if (
      installTarget.appVersion === null ||
      !allowedVersions.includes(installTarget.appVersion)
    ) {
      failures.push(
        `install identity: the website installs revision ${installTarget.ref}, which declares app version ${installTarget.appVersion ?? "<missing>"}; this repository declares ${repository.version}` +
          (declaredPublished
            ? " and that release is published"
            : ` (${previousVersion ?? "no previous release"} is the newest published release)`),
      );
    }
  }

  failures.push(
    ...evaluateModuleAgainstHost({
      label: "declared module",
      module: declaredModule,
      hostProfile,
    }),
  );

  for (const failure of inspectHostSupportProfile(hostProfile)) {
    failures.push(`host support profile: ${failure}`);
  }

  return failures;
}

function providerPinOf(module: TerraformModuleFacts):
  | {
      readonly localName: string;
      readonly version: string;
      readonly source: string;
    }
  | undefined {
  const requirement = module.providerRequirements.find((candidate) =>
    candidate.source.includes("takoform"),
  );
  if (requirement === undefined) return undefined;
  const exact = /^=\s*(\d+\.\d+\.\d+)$/u.exec(requirement.version.trim());
  if (exact === null) return undefined;
  return {
    localName: requirement.localName,
    source: requirement.source,
    version: exact[1]!,
  };
}

function evaluateModuleAgainstHost(input: {
  readonly label: string;
  readonly module: TerraformModuleFacts | undefined;
  readonly hostProfile: HostSupportProfile;
}): readonly string[] {
  const failures: string[] = [];
  const module = input.module;
  if (module === undefined) {
    failures.push(`${input.label}: no OpenTofu module at that path`);
    return failures;
  }
  const pin = providerPinOf(module);
  if (pin === undefined) {
    failures.push(
      `${input.label}: ${module.path} does not pin the Takoform Provider to an exact release version`,
    );
    return failures;
  }
  const release = findProviderRelease(input.hostProfile, pin.version);
  if (release === undefined) {
    failures.push(
      `${input.label}: ${module.path} pins Takoform Provider ${pin.version}, which the recorded Host support profile does not carry`,
    );
    return failures;
  }
  if (!release.supported) {
    failures.push(
      `${input.label}: ${module.path} pins Takoform Provider ${pin.version}, which does not carry the Host's publisher set ${input.hostProfile.host.publisherSet.setTag}: ${input.hostProfile.host.refusalCode} for ${(release.unsupportedFormRefs ?? []).join(", ")}`,
    );
  }
  const declaredByResourceType = new Map(
    input.hostProfile.host.declaredForms.map((form) => [
      form.resourceType,
      form,
    ]),
  );
  for (const resourceType of module.resourceTypes) {
    const form = declaredByResourceType.get(resourceType);
    if (form === undefined) {
      failures.push(
        `${input.label}: ${module.path} uses ${resourceType}, which the Host support profile does not declare`,
      );
      continue;
    }
    if (
      release.supported &&
      !release.portableApiVersion.startsWith("forms.takoform.com/v1")
    ) {
      failures.push(
        `${input.label}: Takoform Provider ${release.version} serves ${release.portableApiVersion}, not the stable forms.takoform.com/v1 lane`,
      );
    }
  }
  return failures;
}

export function readRepositoryIdentity(
  options: {
    readonly repoRoot?: string;
    readonly repositoryUrl?: string;
  } = {},
): InstallIdentityFacts["repository"] {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");
  const packageJson = JSON.parse(read("package.json")) as { version: string };
  const rootModule = read("main.tf");
  return {
    version: packageJson.version,
    tag: terraformStringDefault(rootModule, "worker_release_tag") ?? "",
    bundleUrl: terraformStringDefault(rootModule, "worker_bundle_url") ?? "",
    bundleSha256:
      terraformStringDefault(rootModule, "worker_bundle_sha256") ?? "",
    changelog: read("CHANGELOG.md"),
    releaseLock: JSON.parse(read(RELEASE_LOCK_PATH)),
    tcs: JSON.parse(read(TCS_PATH)),
    takosumi: JSON.parse(read(TAKOSUMI_MANIFEST_PATH)),
    siteHtml: read(SITE_INDEX_PATH),
    modules: readScannedModules(repoRoot),
  };
}
