// Builds the static yurucommu.com pages in site/ from site-src/.
//
// Every served .html page is generated: page sources live in site-src/ and
// shared chrome (head meta, nav header, docs sidebar, footer) lives in
// site-src/_partials/. A page pulls in a partial with a marker comment:
//
//     <!-- @include header.html -->
//
// The partial is inserted at the marker's indentation. Tokens expand per
// page, in two shapes:
//
//   {{ifActive:/help/api.html}}        ' class="active"' on an exact match
//   {{ifActiveUnder:/help/}}           ' class="active"' under the prefix
//   {{activeSuffix:/help/api.html}}    " active" inside a class value
//   {{activeSuffixUnder:/help/}}       " active" under the prefix
//
// _partials/ is exempt from Prettier (see .prettierignore): the attribute
// level {{ifActive:...}} token is not valid HTML until rendered.
//   {{root}}                           relative prefix to site root ("../" ...)
//   {{pageTitle}}                      escaped page <title> text
//   {{pageDescription}}                escaped page description text
//   {{pageUrl}}                        canonical page URL
//
// Output is formatted with Prettier so generated files stay check-clean.
// "bun scripts/build-site.mjs" rewrites site/; "--check" verifies the
// checked-in output matches a fresh render, so site/ never drifts from
// site-src/.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { format } from "prettier";

const SRC = "site-src";
const OUT = "site";
const PARTIALS = join(SRC, "_partials");
const SITE_ORIGIN = "https://yurucommu.com";
const checkMode = process.argv.includes("--check");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".html")) yield path;
  }
}

/** URL route for a generated page: help/api.html -> /help/api.html, help/index.html -> /help/. */
function routeOf(relPath) {
  const p = "/" + relPath.split("\\").join("/");
  return p.endsWith("/index.html") ? p.slice(0, -"index.html".length) : p;
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function pageMetadata(text, relPath, route) {
  const title = text.match(/<title>\s*([\s\S]*?)\s*<\/title>/i)?.[1];
  const description = text.match(
    /<meta\b(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["']([^"']*)["'])[^>]*>/i,
  )?.[1];
  if (title === undefined || description === undefined) {
    throw new Error(relPath + ": page metadata is required for head tokens");
  }
  return {
    pageTitle: escapeAttribute(title.trim()),
    pageDescription: escapeAttribute(description.trim()),
    pageUrl: escapeAttribute(SITE_ORIGIN + route),
  };
}

async function render(relPath, partials) {
  const route = routeOf(relPath);
  const depth = relPath.split("/").length - 1;
  const root = depth === 0 ? "" : "../".repeat(depth);
  let text = readFileSync(join(SRC, relPath), "utf8");
  text = text.replace(
    /^([ \t]*)<!-- @include ([\w.-]+) -->$/gm,
    (_, indent, name) => {
      const partial = partials.get(name);
      if (partial === undefined) {
        throw new Error(relPath + ": unknown partial " + name);
      }
      return partial
        .trimEnd()
        .split("\n")
        .map((line) => (line.trim() === "" ? "" : indent + line))
        .join("\n");
    },
  );
  text = text
    .replaceAll("{{root}}", root)
    .replace(/\{\{ifActive(Under)?:([^}]+)\}\}/g, (_, under, p) =>
      (under ? route.startsWith(p) : route === p) ? ' class="active"' : "",
    )
    .replace(/\{\{activeSuffix(Under)?:([^}]+)\}\}/g, (_, under, p) =>
      (under ? route.startsWith(p) : route === p) ? " active" : "",
    );

  if (
    text.includes("{{pageTitle}}") ||
    text.includes("{{pageDescription}}") ||
    text.includes("{{pageUrl}}")
  ) {
    const metadata = pageMetadata(text, relPath, route);
    text = text
      .replaceAll("{{pageTitle}}", metadata.pageTitle)
      .replaceAll("{{pageDescription}}", metadata.pageDescription)
      .replaceAll("{{pageUrl}}", metadata.pageUrl);
  }

  return format(text, { parser: "html" });
}

const partials = new Map();
for (const file of walk(PARTIALS)) {
  partials.set(relative(PARTIALS, file), readFileSync(file, "utf8"));
}

const failures = [];
const rendered = new Map();
for (const file of walk(SRC)) {
  const relPath = relative(SRC, file).split("\\").join("/");
  if (relPath.startsWith("_partials/")) continue;
  rendered.set(relPath, await render(relPath, partials));
}

for (const [relPath, text] of rendered) {
  const outPath = join(OUT, relPath);
  if (checkMode) {
    if (!existsSync(outPath) || readFileSync(outPath, "utf8") !== text) {
      failures.push(
        "site/" + relPath + " is stale - run bun scripts/build-site.mjs",
      );
    }
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text);
  }
}

// A served page with no source is either an asset (img/) or a leftover.
if (checkMode) {
  for (const file of walk(OUT)) {
    const relPath = relative(OUT, file).split("\\").join("/");
    if (!rendered.has(relPath) && !relPath.startsWith("img/")) {
      failures.push("site/" + relPath + " has no source in site-src/");
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(
  (checkMode ? "checked" : "built") + " " + rendered.size + " pages -> site/",
);
