import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  HOST_SUPPORT_PROFILE_PATH,
  REPO_ROOT,
  deriveHostSupportProfileFromRemotes,
  readHostSupportProfile,
  serializeHostSupportProfile,
} from "./takoform-host-support-profile.ts";
import {
  TCS_PATH,
  YURUCOMMU_REPOSITORY,
  evaluateInstallIdentity,
  readInstallTarget,
  readRepositoryIdentity,
  readSiteInstallLinks,
  resolveRemoteReleaseTags,
  type InstallIdentityFacts,
} from "./takosumi-install-identity.ts";

// The guard resolves the declared release tag and reads the pinned revision
// over the public repository, so a shallow CI checkout cannot hide a stale
// pin. `YURUCOMMU_INSTALL_IDENTITY_OFFLINE=1` skips those two lookups for a
// network-less shell; the local surface agreement is still checked.
const offline = process.env.YURUCOMMU_INSTALL_IDENTITY_OFFLINE === "1";

if (offline) {
  console.warn(
    "YURUCOMMU_INSTALL_IDENTITY_OFFLINE=1: skipping the published Host profile and the website revision lookup",
  );
}

/** The pre-fix website pin: v2.1.10, whose module pinned the superseded Provider 3.0.0. */
const SUPERSEDED_SITE_REF = "a17e4f883cb9ba79e6d0650b497d8d97453c698f";

/** One network probe per process: the tests below differ only in local facts. */
const NETWORK_TEST_TIMEOUT_MS = 60_000;
let remoteTags: ReturnType<typeof resolveRemoteReleaseTags> | undefined;
const installTargets = new Map<
  string,
  Awaited<ReturnType<typeof readInstallTarget>>
>();

function releaseTags(): ReturnType<typeof resolveRemoteReleaseTags> {
  remoteTags ??= resolveRemoteReleaseTags();
  return remoteTags;
}

async function installTargetAt(
  ref: string,
  modulePath: string,
): Promise<Awaited<ReturnType<typeof readInstallTarget>>> {
  const key = `${ref}:${modulePath}`;
  if (!installTargets.has(key)) {
    installTargets.set(key, await readInstallTarget({ ref, modulePath }));
  }
  return installTargets.get(key) ?? null;
}

async function collectFacts(
  overrides: { readonly siteHtml?: string } = {},
): Promise<InstallIdentityFacts> {
  const repository = readRepositoryIdentity();
  const siteHtml = overrides.siteHtml ?? repository.siteHtml;
  const links = readSiteInstallLinks(siteHtml);
  const installRef =
    links.length > 0 ? links[0]!.url.searchParams.get("ref") : null;
  const installTarget =
    installRef === null
      ? null
      : await installTargetAt(installRef, repository.tcs.modulePath ?? "");
  return {
    repositoryUrl: YURUCOMMU_REPOSITORY,
    repository: { ...repository, siteHtml },
    remote: {
      releaseTags: releaseTags(),
      tagCommit:
        releaseTags().find((tag) => tag.tag === repository.tag)?.commit ?? null,
      installTarget,
    },
    hostProfile: readHostSupportProfile(),
  };
}

describe("recorded Takoform Host support profile", () => {
  test(
    "projects the published Takoserver declaration it is derived from",
    async () => {
      const recorded = readFileSync(
        resolve(REPO_ROOT, HOST_SUPPORT_PROFILE_PATH),
        "utf8",
      );
      const profile = readHostSupportProfile();
      const failures = await evaluateHostProfileAgainstSources(profile);
      expect(failures).toEqual([]);
      expect(serializeHostSupportProfile(profile)).toBe(recorded);
    },
    NETWORK_TEST_TIMEOUT_MS,
  );

  test("refuses a release that does not carry the Host publisher set", () => {
    const profile = readHostSupportProfile();
    const superseded = profile.providerReleases.find(
      (release) => release.version === "3.0.0",
    );
    expect(superseded?.supported).toBe(false);
    expect(superseded?.unsupportedFormRefs).toContain(
      "edge.forms.takoform.com WorkerVersion@0.2.0",
    );
    const supported = profile.providerReleases.filter(
      (release) => release.supported,
    );
    expect(supported.map((release) => release.version)).toEqual([
      "4.1.0",
      "4.0.1",
      "4.0.0",
    ]);
  });
});

async function evaluateHostProfileAgainstSources(
  profile: ReturnType<typeof readHostSupportProfile>,
): Promise<readonly string[]> {
  if (offline) return [];
  const derived = await deriveHostSupportProfileFromRemotes({
    hostCommit: profile.host.commit,
    providerLedgerCommit: profile.providerLedger.commit,
  });
  return serializeHostSupportProfile(derived) ===
    serializeHostSupportProfile(profile)
    ? []
    : ["the recorded Host support profile no longer matches its sources"];
}

describe("install identity", () => {
  test(
    "the release identity, declared module, and website pin name one install",
    async () => {
      const failures = evaluateInstallIdentity(await collectFacts());
      expect(failures).toEqual([]);
    },
    NETWORK_TEST_TIMEOUT_MS,
  );

  test(
    "refuses the superseded website pin that shipped a Provider 3.0.0 module",
    async () => {
      if (offline) return;
      const repository = readRepositoryIdentity();
      const currentHtml = repository.siteHtml;
      const currentRef =
        readSiteInstallLinks(currentHtml)[0]!.url.searchParams.get("ref")!;
      const failures = evaluateInstallIdentity(
        await collectFacts({
          siteHtml: currentHtml.replaceAll(currentRef, SUPERSEDED_SITE_REF),
        }),
      );
      const report = failures.join("\n");
      expect(report).toContain("pins Takoform Provider 3.0.0");
      expect(report).toContain("does not carry the Host's publisher set");
      expect(report).toContain("WorkerVersion@0.2.0");
      expect(report).toContain("declares app version 2.1.10");
    },
    NETWORK_TEST_TIMEOUT_MS,
  );

  test(
    "refuses a release.lock.json commit that is not the released tag commit",
    async () => {
      const facts = await collectFacts();
      const pinned =
        facts.repository.releaseLock.releases[facts.repository.tag]!;
      const releaseLock = {
        ...facts.repository.releaseLock,
        releases: {
          ...facts.repository.releaseLock.releases,
          [facts.repository.tag]: { ...pinned, commit: "0".repeat(40) },
        },
      };
      const failures = evaluateInstallIdentity({
        ...facts,
        repository: { ...facts.repository, releaseLock },
      });
      expect(failures.join("\n")).toContain(
        `tag ${facts.repository.tag} resolves to`,
      );
    },
    NETWORK_TEST_TIMEOUT_MS,
  );

  test(
    "refuses a manifest input that names no module variable",
    async () => {
      const facts = await collectFacts();
      const modules = facts.repository.takosumi.install!.modules!;
      const manifest = {
        ...facts.repository.takosumi,
        install: {
          ...facts.repository.takosumi.install,
          modules: {
            ...modules,
            "deploy/takoform": {
              ...modules["deploy/takoform"]!,
              inputs: [
                {
                  name: "worker_release_tag",
                  source: { kind: "module_default" },
                },
              ],
            },
          },
        },
      };
      const failures = evaluateInstallIdentity({
        ...facts,
        repository: { ...facts.repository, takosumi: manifest },
      });
      expect(failures.join("\n")).toContain(
        "declares input worker_release_tag for deploy/takoform",
      );
    },
    NETWORK_TEST_TIMEOUT_MS,
  );

  test(
    "refuses a website pin that is not the declared install module",
    async () => {
      const facts = await collectFacts();
      const failures = evaluateInstallIdentity({
        ...facts,
        repository: {
          ...facts.repository,
          siteHtml: facts.repository.siteHtml.replaceAll(
            "path=deploy%2Ftakoform",
            "path=.",
          ),
        },
        remote: {
          ...facts.remote,
          installTarget: await readInstallTarget({
            ref: facts.remote.installTarget!.ref,
            modulePath: ".",
          }),
        },
      });
      const report = failures.join("\n");
      expect(report).toContain(
        `install link selects module . instead of ${TCS_PATH} modulePath deploy/takoform`,
      );
    },
    NETWORK_TEST_TIMEOUT_MS,
  );
});

describe("release identity", () => {
  test("pins the declared tag to the release the website hands out", () => {
    const repository = readRepositoryIdentity();
    const link = readSiteInstallLinks(repository.siteHtml)[0]!;
    expect(link.url.searchParams.get("git")).toBe(YURUCOMMU_REPOSITORY);
    expect(link.url.searchParams.get("path")).toBe("deploy/takoform");
    expect(repository.tcs.modulePath).toBe("deploy/takoform");
    expect(repository.tcs.provider).toBe("takoform");
    const pinnedCommit =
      repository.releaseLock.releases[repository.tag]?.commit ?? "";
    const siteRef = link.url.searchParams.get("ref") ?? "";
    expect(pinnedCommit).not.toBe("");
    expect(pinnedCommit).toBe(siteRef);
  });
});
