import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  decodeReleaseSourceBytes,
  reportPublishedReleaseSourceFollowup,
  type ReleaseFollowupSource,
  type ReleaseSourceFollowup,
} from "./release-source-followup.mjs";

// Synthetic metadata fixtures: these controls do not perform or prove a release.
const commit = "2".repeat(40);
const sourceCommit = "3".repeat(40);
const oldRef = "1".repeat(40);
const tag = "v9.8.7";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const assetDigests = {
  "yurucommu-worker.js": hash("synthetic worker"),
  "takosumi-artifact.json": hash("synthetic manifest"),
  "yurucommu-worker.js.sha256": hash("synthetic checksum"),
};
const published = {
  kind: "takos.deploy-result@v1",
  surface: "yurucommu-worker-release",
  target: `github-release:tako0614/yurucommu/${tag}`,
  commit,
  tag,
  sourceIdentity: "PACKAGE_REPOSITORY_MODULE_ARTIFACT_ALIGNED",
  releaseUrl: `https://github.com/tako0614/yurucommu/releases/tag/${tag}`,
  assetDigests,
  postConditions: "EXACT_RELEASE_READBACK_AND_RUNTIME_NATIVE_SMOKE",
  status: "PUBLISHED",
};
const href = (ref: string) =>
  `https://app.takosumi.com/install?git=https%3A%2F%2Fgithub.com%2Ftako0614%2Fyurucommu.git&ref=${ref}&path=deploy%2Ftakoform`;
const ledger = JSON.stringify({
  format: "synthetic fixture",
  releases: { "v1.0.0": { commit: oldRef, preserved: "old row" } },
});
const source = (): ReleaseFollowupSource => ({
  commit: sourceCommit,
  version: tag.slice(1),
  workerReleaseTag: tag,
  workerBundleUrl: `https://github.com/tako0614/yurucommu/releases/download/${tag}/yurucommu-worker.js`,
  workerBundleSha256: `sha256:${assetDigests["yurucommu-worker.js"]}`,
  modulePath: "deploy/takoform",
  ledger,
  site: `<a href="${href(oldRef)}">one</a><a href="${href(oldRef)}">two</a>\n`,
  siteSource: `<a href="${href(oldRef)}">one</a><a href="${href(oldRef)}">two</a>\n`,
});
function report(
  input: unknown = published,
  current: ReleaseFollowupSource = source(),
) {
  let reads = 0;
  const emitted: ReleaseSourceFollowup[] = [];
  const result = reportPublishedReleaseSourceFollowup(
    input,
    () => {
      reads += 1;
      return current;
    },
    (value) => emitted.push(value),
  );
  return { result, emitted, reads };
}

describe("publisher source follow-up", () => {
  test("authoritative site source remains proposed when generated HTML already followed", () => {
    const original = source();
    const row = report(published, original).result!.changes!.find(
      (change) => change.path === "release.lock.json",
    )!.value;
    const current = {
      ...original,
      ledger: JSON.stringify({
        ...JSON.parse(original.ledger),
        releases: {
          ...JSON.parse(original.ledger).releases,
          [tag]: { ...(row as object), seededFrom: "preserved provenance" },
        },
      }),
      site: original.site.replaceAll(oldRef, commit),
    };
    const before = JSON.stringify({ published, current });
    const { result } = report(published, current);
    expect(result?.status).toBe("SOURCE_CHANGES_PROPOSED");
    expect(result?.changes).toEqual([
      {
        path: "site-src/index.html",
        preimageSha256: hash(current.siteSource),
        operation: "replace-install-link-refs",
        replacements: [
          { before: href(oldRef), after: href(commit), occurrences: 2 },
        ],
      },
    ]);
    expect(JSON.stringify({ published, current })).toBe(before);
    const followed = report(published, {
      ...current,
      siteSource: current.siteSource.replaceAll(oldRef, commit),
    }).result;
    expect(followed?.status).toBe("ALREADY_FOLLOWED");
    expect(followed?.changes).toEqual([]);
  });

  test("authoritative HTML retains exact bytes and the same identity and cap refusals", () => {
    const original = JSON.stringify(published);
    const bytes = Buffer.from(
      `\uFEFF<!-- 日本語 🐙 \uFFFD -->\n${source().siteSource} \t\n`,
    );
    const input = { ...source(), siteSource: decodeReleaseSourceBytes(bytes) };
    expect(
      report(published, input).result?.changes?.find(
        (change) => change.path === "site-src/index.html",
      )?.preimageSha256,
    ).toBe(createHash("sha256").update(bytes).digest("hex"));
    const reverse = report(published, {
      ...source(),
      siteSource: source().siteSource.replaceAll(oldRef, commit),
    }).result!;
    expect(reverse.changes?.map((change) => change.path)).toEqual([
      "release.lock.json",
      "site/index.html",
    ]);
    const missing: Omit<ReleaseFollowupSource, "siteSource"> & {
      siteSource?: string;
    } = { ...source() };
    delete missing.siteSource;
    for (const current of [
      missing as ReleaseFollowupSource,
      { ...source(), siteSource: "no install link" },
      {
        ...source(),
        siteSource: source().siteSource.replace("deploy%2Ftakoform", "."),
      },
      { ...source(), siteSource: "x".repeat(1024 * 1024 + 1) },
      // Both HTML files share the existing total 64-link ceiling.
      { ...source(), siteSource: source().siteSource.repeat(32) },
    ]) {
      const { result } = report(published, current);
      expect(result?.status).toBe("SOURCE_FOLLOWUP_UNAVAILABLE");
      expect(result?.changes).toBeUndefined();
    }
    const invalid = Buffer.concat([
      Buffer.from("<!--"),
      Buffer.from([0xff]),
      Buffer.from(`-->${source().siteSource}`),
    ]);
    const emitted: ReleaseSourceFollowup[] = [];
    const failed = reportPublishedReleaseSourceFollowup(
      published,
      () => ({ ...source(), siteSource: decodeReleaseSourceBytes(invalid) }),
      (value) => emitted.push(value),
    );
    expect(failed?.status).toBe("SOURCE_FOLLOWUP_UNAVAILABLE");
    expect(failed?.reason).toBe("SOURCE_READ_OR_PARSE_FAILED");
    expect(failed?.changes).toBeUndefined();
    expect(emitted).toEqual([failed!]);
    expect(JSON.stringify(published)).toBe(original);
  });

  test("source decoder retains valid UTF-8 BOM and whitespace bytes in the proposal preimage", () => {
    for (const site of [
      source().site,
      `\uFEFF<!-- 日本語 🐙 \uFFFD -->\n${source().site} \t\n`,
      ` \r\n${source().site}\r\n`,
    ]) {
      const bytes = Buffer.from(site, "utf8");
      const text = decodeReleaseSourceBytes(bytes);
      expect(Buffer.from(text, "utf8").equals(bytes)).toBe(true);
      expect(text).toBe(site);
      const { result } = report(published, { ...source(), site: text });
      expect(result?.status).toBe("SOURCE_CHANGES_PROPOSED");
      expect(
        result?.changes?.find((change) => change.path === "site/index.html")
          ?.preimageSha256,
      ).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  test("invalid source bytes become only a post-PUBLISHED follow-up failure", () => {
    const oldReceipt = JSON.stringify(published);
    const invalid = [
      {
        path: "site" as const,
        bytes: Buffer.concat([
          Buffer.from("<!--"),
          Buffer.from([0xff]),
          Buffer.from(`-->\n${source().site}`),
        ]),
      },
      {
        path: "ledger" as const,
        bytes: Buffer.concat([
          Buffer.from('{"releases":{"v1.0.0":{"note":"'),
          Buffer.from([0xc0, 0xaf]),
          Buffer.from('"}}}'),
        ]),
      },
    ];
    for (const input of invalid) {
      // Reproduce the old Node UTF-8 conversion loss, not a publication.
      expect(hash(input.bytes.toString("utf8"))).not.toBe(
        createHash("sha256").update(input.bytes).digest("hex"),
      );
      expect(() => decodeReleaseSourceBytes(input.bytes)).toThrow();
      const emitted: ReleaseSourceFollowup[] = [];
      const result = reportPublishedReleaseSourceFollowup(
        published,
        () => ({
          ...source(),
          [input.path]: decodeReleaseSourceBytes(input.bytes),
        }),
        (value) => emitted.push(value),
      );
      expect(result).toEqual({
        kind: "yurucommu.release-source-followup@v1",
        status: "SOURCE_FOLLOWUP_UNAVAILABLE",
        reason: "SOURCE_READ_OR_PARSE_FAILED",
      });
      expect(emitted).toEqual([result!]);
      expect(result?.changes).toBeUndefined();
    }
    expect(JSON.stringify(published)).toBe(oldReceipt);
  });

  test("prepublication, failed, indeterminate and incomplete receipts produce no proposal", () => {
    for (const input of [
      true,
      null,
      { status: "PUBLISHED" },
      { ...published, status: "DRY_RUN_VERIFIED" },
      { ...published, status: "FAILED" },
      { ...published, status: "POST_PUBLICATION_INDETERMINATE" },
      { ...published, surface: "cloudflare-pages" },
      { ...published, assetDigests: { "yurucommu-worker.js": "true" } },
      { ...published, commit: oldRef, target: "arbitrary receipt" },
    ]) {
      expect(report(input)).toEqual({ result: null, emitted: [], reads: 0 });
    }
  });

  test("returns only review edits with exact source preimages and same-call release fields", () => {
    const input = source();
    const before = JSON.stringify({ published, input });
    const { result, reads } = report(published, input);
    expect(result?.status).toBe("SOURCE_CHANGES_PROPOSED");
    expect(reads).toBe(1);
    expect(result?.sourceCommit).toBe(sourceCommit);
    expect(result?.published).toEqual({ tag, commit, assetDigests });
    expect(result?.qualification).toContain("not a publication receipt");
    expect(result?.changes).toEqual([
      {
        path: "release.lock.json",
        preimageSha256: hash(input.ledger),
        operation: "append-release-row",
        key: tag,
        value: {
          artifact: {
            filename: "yurucommu-worker.js",
            url: input.workerBundleUrl,
            sha256: input.workerBundleSha256,
          },
          manifest: {
            url: `https://github.com/tako0614/yurucommu/releases/download/${tag}/takosumi-artifact.json`,
            sha256: `sha256:${assetDigests["takosumi-artifact.json"]}`,
          },
          commit,
          seededFrom:
            "owning publisher exact tag and three-asset readback; review-only source follow-up",
        },
      },
      {
        path: "site-src/index.html",
        preimageSha256: hash(input.siteSource),
        operation: "replace-install-link-refs",
        replacements: [
          { before: href(oldRef), after: href(commit), occurrences: 2 },
        ],
      },
      {
        path: "site/index.html",
        preimageSha256: hash(input.site),
        operation: "replace-install-link-refs",
        replacements: [
          { before: href(oldRef), after: href(commit), occurrences: 2 },
        ],
      },
    ]);
    expect(JSON.stringify({ published, input })).toBe(before);
  });

  test("already-followed rows and references are harmless and preserve old provenance", () => {
    const original = source();
    const first = report(published, original).result!;
    const row = first.changes![0].value;
    const current = {
      ...original,
      ledger: JSON.stringify({
        ...JSON.parse(original.ledger),
        releases: {
          ...JSON.parse(original.ledger).releases,
          [tag]: { ...(row as object), seededFrom: "keep existing provenance" },
        },
      }),
      site: original.site.replaceAll(oldRef, commit),
      siteSource: original.siteSource.replaceAll(oldRef, commit),
    };
    const before = JSON.stringify(current);
    const { result } = report(published, current);
    expect(result?.status).toBe("ALREADY_FOLLOWED");
    expect(result?.changes).toEqual([]);
    expect(JSON.stringify(current)).toBe(before);
  });

  test("identity mismatches or a conflicting old row never propose an overwrite", () => {
    for (const current of [
      { ...source(), version: "1.0.0" },
      { ...source(), workerBundleSha256: `sha256:${"0".repeat(64)}` },
      { ...source(), site: source().site.replace("deploy%2Ftakoform", ".") },
      {
        ...source(),
        ledger: JSON.stringify({ releases: { [tag]: { commit: oldRef } } }),
      },
    ]) {
      const { result, emitted } = report(published, current);
      expect(result?.status).toBe("SOURCE_FOLLOWUP_UNAVAILABLE");
      expect(result?.changes).toBeUndefined();
      expect(emitted).toHaveLength(1);
    }
  });

  test("post-success source failure cannot replace the old PUBLISHED result", () => {
    const oldReceipt = JSON.stringify(published);
    const emitted: ReleaseSourceFollowup[] = [];
    const result = reportPublishedReleaseSourceFollowup(
      published,
      () => {
        throw new Error("secret path and credential must not be printed");
      },
      (value) => emitted.push(value),
    );
    expect(result).toEqual({
      kind: "yurucommu.release-source-followup@v1",
      status: "SOURCE_FOLLOWUP_UNAVAILABLE",
      reason: "SOURCE_READ_OR_PARSE_FAILED",
    });
    expect(JSON.stringify(emitted)).not.toContain("credential");
    expect(JSON.stringify(published)).toBe(oldReceipt);
  });

  test("diagnostic sink failure and poisoned input remain isolated after success", () => {
    const oldReceipt = JSON.stringify(published);
    let writes = 0;
    const result = reportPublishedReleaseSourceFollowup(
      published,
      source,
      () => {
        writes += 1;
        throw new Error("private diagnostic error");
      },
    );
    expect(result?.status).toBe("SOURCE_FOLLOWUP_UNAVAILABLE");
    expect(result?.reason).toBe("DIAGNOSTIC_OUTPUT_FAILED");
    expect(writes).toBe(2);
    expect(JSON.stringify(published)).toBe(oldReceipt);
    const poisoned = Object.defineProperty({ ...published }, "assetDigests", {
      get() {
        throw new Error("private getter");
      },
    });
    const observed = report(poisoned);
    expect(observed.reads).toBe(0);
    expect(observed.result?.status).toBe("SOURCE_FOLLOWUP_UNAVAILABLE");
    expect(JSON.stringify(observed.emitted)).not.toContain("private getter");
  });

  test("bounded source and install-link output failures stay follow-up diagnostics", () => {
    for (const current of [
      { ...source(), ledger: "x".repeat(1024 * 1024 + 1) },
      { ...source(), site: "no install link" },
      { ...source(), site: source().site.repeat(33) },
    ]) {
      const { result } = report(published, current);
      expect(result?.status).toBe("SOURCE_FOLLOWUP_UNAVAILABLE");
      expect(result?.changes).toBeUndefined();
    }
    const longModule = "a".repeat(16 * 1024);
    const { result } = report(published, {
      ...source(),
      modulePath: longModule,
      site: source().site.replaceAll("deploy%2Ftakoform", longModule),
      siteSource: source().siteSource.replaceAll(
        "deploy%2Ftakoform",
        longModule,
      ),
    });
    expect(result?.status).toBe("SOURCE_FOLLOWUP_UNAVAILABLE");
    expect(result?.reason).toBe("OUTPUT_LIMIT");
  });
});
