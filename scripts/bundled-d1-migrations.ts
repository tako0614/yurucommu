import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BundledD1Migration } from "./yurucommu-d1-migrations.ts";

/**
 * Build-time half of Worker-applied schema (see yurucommu-d1-migrations.ts).
 *
 * The source is the product's one locked schema bundle — the same bytes the
 * Takoform module ships and the release smoke applies — so the direct
 * Cloudflare lane cannot drift from the Takoform lane. A native D1 prepared
 * statement holds one statement, so each file is split here, where a test can
 * prove the split against SQLite itself, never inside the Worker.
 */
export const SCHEMA_BUNDLE_RELATIVE_PATH =
  "deploy/takoform/migrations/schema-bundle.json";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const MIGRATION_NAME_RE = /^[0-9]{4}_[A-Za-z0-9_-]+\.sql$/u;
const WORD_RE = /[A-Za-z0-9_$]/u;

type SchemaBundleEntry = {
  readonly name: unknown;
  readonly sha256: unknown;
  readonly sql: unknown;
};

function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

/** Index just past a quoted token that opens at `start` with `quote`. */
function skipQuoted(sql: string, start: number, close: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === close) {
      // A doubled quote is an escaped quote, except for [bracketed] names.
      if (close !== "]" && sql[index + 1] === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  throw new Error("unterminated quoted token in migration SQL");
}

/**
 * Split one migration file into single statements.
 *
 * A `;` ends a statement unless it is inside a string, a quoted name, a
 * comment, or the BEGIN … END body of a CREATE TRIGGER. Inside that body,
 * CASE … END nests, so a `CASE … END` in a trigger statement cannot be taken
 * for the trigger's own END. (wrangler's splitter makes exactly that mistake
 * on 0034 and returns nineteen statements as one.) Text between statements —
 * whitespace and comments — is dropped; text inside a statement is kept
 * byte-for-byte, so a trigger is stored exactly as whole-file execution would
 * store it.
 */
export function splitMigrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = -1;
  let words: string[] = [];
  let bodyDepth = 0;
  let bodySeen = false;
  let index = 0;

  const isTrigger = () =>
    words[0] === "CREATE" &&
    (words[1] === "TRIGGER" ||
      ((words[1] === "TEMP" || words[1] === "TEMPORARY") &&
        words[2] === "TRIGGER"));
  const open = (at: number) => {
    if (start < 0) start = at;
  };
  const close = (end: number) => {
    if (start >= 0) statements.push(sql.slice(start, end).trim());
    start = -1;
    words = [];
    bodyDepth = 0;
    bodySeen = false;
  };

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated comment in migration SQL");
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      open(index);
      index = skipQuoted(sql, index, char === "[" ? "]" : char);
      continue;
    }
    if (char === ";") {
      if (start >= 0 && bodyDepth === 0) {
        close(index + 1);
      }
      index += 1;
      continue;
    }
    if (WORD_RE.test(char)) {
      open(index);
      let end = index + 1;
      while (end < sql.length && WORD_RE.test(sql[end]!)) end += 1;
      const word = sql.slice(index, end).toUpperCase();
      if (words.length < 3) words.push(word);
      if (isTrigger()) {
        if (bodyDepth === 0 && !bodySeen && word === "BEGIN") {
          bodyDepth = 1;
          bodySeen = true;
        } else if (bodyDepth > 0 && word === "CASE") {
          bodyDepth += 1;
        } else if (bodyDepth > 0 && word === "END") {
          bodyDepth -= 1;
        }
      }
      index = end;
      continue;
    }
    if (!/\s/u.test(char)) open(index);
    index += 1;
  }
  if (bodyDepth > 0) {
    throw new Error("unterminated CREATE TRIGGER body in migration SQL");
  }
  close(sql.length);
  return statements.filter((statement) => statement.length > 0);
}

/** Verify a parsed schema bundle and split every entry. */
export function bundledMigrationsFromSchemaBundle(
  bundle: unknown,
): BundledD1Migration[] {
  const candidate = bundle as {
    apiVersion?: unknown;
    engine?: unknown;
    entries?: unknown;
  };
  if (
    !candidate ||
    candidate.apiVersion !== "takosumi.resource-migrations/v1" ||
    candidate.engine !== "sqlite" ||
    !Array.isArray(candidate.entries) ||
    candidate.entries.length === 0
  ) {
    throw new Error("schema bundle identity is invalid");
  }
  const migrations: BundledD1Migration[] = [];
  let previous = "";
  for (const entry of candidate.entries as SchemaBundleEntry[]) {
    if (
      typeof entry?.name !== "string" ||
      !MIGRATION_NAME_RE.test(entry.name) ||
      entry.name <= previous ||
      typeof entry.sql !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error("schema bundle contains an invalid migration entry");
    }
    if (sha256(entry.sql) !== entry.sha256) {
      throw new Error("schema bundle migration digest mismatch: " + entry.name);
    }
    const statements = splitMigrationStatements(entry.sql);
    if (statements.length === 0) {
      throw new Error(
        "schema bundle migration has no statements: " + entry.name,
      );
    }
    migrations.push({ name: entry.name, sha256: entry.sha256, statements });
    previous = entry.name;
  }
  return migrations;
}

/** Read the repository's schema bundle as embeddable migrations. */
export async function readBundledD1Migrations(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<BundledD1Migration[]> {
  return bundledMigrationsFromSchemaBundle(
    JSON.parse(
      await readFile(
        resolve(repositoryRoot, SCHEMA_BUNDLE_RELATIVE_PATH),
        "utf8",
      ),
    ),
  );
}
