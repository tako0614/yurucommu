import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const KIND = "yurucommu.release-source-followup@v1";
const REPOSITORY = "tako0614/yurucommu";
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const ASSETS = [
  "yurucommu-worker.js",
  "takosumi-artifact.json",
  "yurucommu-worker.js.sha256",
];
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Hash only losslessly decoded Git blob bytes, retaining BOM and whitespace.
export function decodeReleaseSourceBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_SOURCE_BYTES) {
    throw new Error("invalid source bytes");
  }
  const bytes = Buffer.from(value);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("source bytes are not lossless UTF-8");
  }
  return text;
}

function completedPublisherResult(value) {
  return (
    record(value) &&
    value.kind === "takos.deploy-result@v1" &&
    value.surface === "yurucommu-worker-release" &&
    value.status === "PUBLISHED" &&
    value.sourceIdentity === "PACKAGE_REPOSITORY_MODULE_ARTIFACT_ALIGNED" &&
    value.postConditions ===
      "EXACT_RELEASE_READBACK_AND_RUNTIME_NATIVE_SMOKE" &&
    typeof value.tag === "string" &&
    TAG.test(value.tag) &&
    typeof value.commit === "string" &&
    COMMIT.test(value.commit) &&
    value.target === `github-release:${REPOSITORY}/${value.tag}` &&
    value.releaseUrl ===
      `https://github.com/${REPOSITORY}/releases/tag/${value.tag}` &&
    record(value.assetDigests) &&
    Object.keys(value.assetDigests).length === ASSETS.length &&
    ASSETS.every(
      (name) =>
        Object.hasOwn(value.assetDigests, name) &&
        typeof value.assetDigests[name] === "string" &&
        SHA256.test(value.assetDigests[name]),
    )
  );
}

function unavailable(reason) {
  return { kind: KIND, status: "SOURCE_FOLLOWUP_UNAVAILABLE", reason };
}

function sourceText(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAX_SOURCE_BYTES
  ) {
    throw new Error("source");
  }
  return value;
}

function proposal(published, source) {
  const base = `https://github.com/${REPOSITORY}/releases/download/${published.tag}`;
  if (
    !record(source) ||
    typeof source.commit !== "string" ||
    !COMMIT.test(source.commit) ||
    source.version !== published.tag.slice(1) ||
    source.workerReleaseTag !== published.tag ||
    source.workerBundleUrl !== `${base}/yurucommu-worker.js` ||
    source.workerBundleSha256 !==
      `sha256:${published.assetDigests[ASSETS[0]]}` ||
    typeof source.modulePath !== "string" ||
    (source.modulePath !== "." &&
      !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/u.test(source.modulePath))
  ) {
    return unavailable("SOURCE_IDENTITY_MISMATCH");
  }
  const ledgerText = sourceText(source.ledger);
  const generatedSiteText = sourceText(source.site);
  const siteSourceText = sourceText(source.siteSource);
  const ledger = JSON.parse(ledgerText);
  if (!record(ledger) || !record(ledger.releases)) {
    return unavailable("INVALID_SOURCE_METADATA");
  }
  const row = {
    artifact: {
      filename: ASSETS[0],
      url: `${base}/${ASSETS[0]}`,
      sha256: `sha256:${published.assetDigests[ASSETS[0]]}`,
    },
    manifest: {
      url: `${base}/${ASSETS[1]}`,
      sha256: `sha256:${published.assetDigests[ASSETS[1]]}`,
    },
    commit: published.commit,
    seededFrom:
      "owning publisher exact tag and three-asset readback; review-only source follow-up",
  };
  const changes = [];
  if (Object.hasOwn(ledger.releases, published.tag)) {
    const previous = ledger.releases[published.tag];
    if (
      !record(previous) ||
      previous.commit !== row.commit ||
      !record(previous.artifact) ||
      !record(previous.manifest) ||
      Object.entries(row.artifact).some(
        ([key, value]) => previous.artifact[key] !== value,
      ) ||
      Object.entries(row.manifest).some(
        ([key, value]) => previous.manifest[key] !== value,
      )
    ) {
      return unavailable("CONFLICTING_RELEASE_ROW");
    }
  } else {
    changes.push({
      path: "release.lock.json",
      preimageSha256: hash(ledgerText),
      operation: "append-release-row",
      key: published.tag,
      value: row,
    });
  }

  let totalLinks = 0;
  for (const [path, siteText] of [
    ["site-src/index.html", siteSourceText],
    ["site/index.html", generatedSiteText],
  ]) {
    const replacements = new Map();
    let links = 0;
    for (const match of siteText.matchAll(
      /href="([^"]*app\.takosumi\.com\/install[^"]*)"/gu,
    )) {
      links += 1;
      totalLinks += 1;
      const before = match[1];
      const url = new URL(before.replaceAll("&amp;", "&"));
      const keys = [...url.searchParams.keys()];
      const ref = url.searchParams.get("ref");
      if (
        totalLinks > 64 ||
        url.origin !== "https://app.takosumi.com" ||
        url.pathname !== "/install" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== "" ||
        keys.length !== 3 ||
        new Set(keys).size !== 3 ||
        keys.some((key) => !["git", "ref", "path"].includes(key)) ||
        ![
          `https://github.com/${REPOSITORY}`,
          `https://github.com/${REPOSITORY}.git`,
        ].includes(url.searchParams.get("git")) ||
        url.searchParams.get("path") !== source.modulePath ||
        ref === null ||
        !COMMIT.test(ref)
      ) {
        return unavailable("INSTALL_LINK_IDENTITY_MISMATCH");
      }
      if (ref === published.commit) continue;
      const field = /([?&](?:amp;)?ref=)[0-9a-f]{40}(?=&|$)/gu;
      if ([...before.matchAll(field)].length !== 1) {
        return unavailable("INSTALL_LINK_IDENTITY_MISMATCH");
      }
      const after = before.replace(
        field,
        (_match, prefix) => prefix + published.commit,
      );
      const previous = replacements.get(before);
      replacements.set(before, {
        before,
        after,
        occurrences: (previous?.occurrences ?? 0) + 1,
      });
    }
    if (links === 0) return unavailable("INSTALL_LINK_IDENTITY_MISMATCH");
    if (replacements.size > 0) {
      changes.push({
        path,
        preimageSha256: hash(siteText),
        operation: "replace-install-link-refs",
        replacements: [...replacements.values()],
      });
    }
  }
  return {
    kind: KIND,
    status:
      changes.length === 0 ? "ALREADY_FOLLOWED" : "SOURCE_CHANGES_PROPOSED",
    qualification:
      "review-only; not a publication receipt or permission to apply",
    sourceCommit: source.commit,
    published: {
      tag: published.tag,
      commit: published.commit,
      assetDigests: { ...published.assetDigests },
    },
    changes,
  };
}

/**
 * Internal publisher post-success hook, not a receipt import/verification API.
 * Its caller runs only after exact readbacks/native smoke and the old stdout
 * PUBLISHED receipt. Pure fixtures can exercise proposal logic, not certify a
 * publication. Nothing here writes a source file or changes publication status.
 */
export function reportPublishedReleaseSourceFollowup(
  published,
  readSource,
  emit,
) {
  let result;
  try {
    if (!completedPublisherResult(published)) return null;
    result = proposal(published, readSource());
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) {
      result = unavailable("OUTPUT_LIMIT");
    }
  } catch {
    result = unavailable("SOURCE_READ_OR_PARSE_FAILED");
  }
  try {
    emit(result);
  } catch {
    result = unavailable("DIAGNOSTIC_OUTPUT_FAILED");
    try {
      emit(result);
    } catch {
      // Diagnostic loss cannot turn the completed publication into a retry.
    }
  }
  return result;
}
