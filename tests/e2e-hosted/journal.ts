import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import { check, type Role } from "./contracts.ts";
import { PRODUCT_ROOT } from "./inputs.ts";

export type Entry =
  | {
      kind: "origin-reservation-intent" | "origin-reservation-ack";
      reservationId: string;
      requestedSubdomain: string;
      canonicalPublicOrigin: string;
    }
  | {
      kind: "prepared";
      runId: string;
      hostOrigin: string;
      space: string;
      sourceCommit: string;
      fixtureSha256: string;
      hostCommit: string;
      qualificationSha256: string;
    }
  | {
      kind: "intent";
      action: "create" | "delete";
      role: Role;
      key: string;
      publicSpecSha256: string;
      uid?: string;
      generation?: number;
    }
  | {
      kind: "ack";
      action: "create" | "delete";
      role: Role;
      operationId: string;
      uid: string;
      generation: number;
    }
  | {
      kind: "settled";
      role: Role;
      operationId: string;
      uid: string;
      generation: number;
    }
  | { kind: "absent"; role: Role; uid: string }
  | { kind: "health"; passed: boolean }
  | { kind: "route-absent" }
  | { kind: "halted"; code: "UNKNOWN_ACK_OR_EFFECT" }
  | { kind: "complete"; passed: boolean };
export interface Journal {
  append(entry: Entry): Promise<void>;
  close(): Promise<void>;
}
export const JOURNAL_FILENAME = "hosted-e2e.jsonl";
async function metadata(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    // Permission or filesystem uncertainty cannot establish an external directory.
    throw error;
  }
}
async function outsideRepositories(
  directory: string,
  actual: string,
): Promise<void> {
  const checked = new Set<string>();
  // Check both names: following a parent symlink cannot enter a checkout or
  // escape a lexical checkout into an otherwise external directory.
  for (const start of [resolve(directory), actual]) {
    for (
      let ancestor = start;
      !checked.has(ancestor);
      ancestor = dirname(ancestor)
    ) {
      checked.add(ancestor);
      // Any .git entry is a boundary, including linked-worktree files and
      // dangling symlinks. Do not read its contents or follow its gitdir pointer.
      check(!(await metadata(join(ancestor, ".git"))), "JOURNAL_IN_REPOSITORY");
      const [head, objects, refs, packed] = await Promise.all([
        metadata(join(ancestor, "HEAD")),
        metadata(join(ancestor, "objects")),
        metadata(join(ancestor, "refs")),
        metadata(join(ancestor, "packed-refs")),
      ]);
      const file = (entry: Stats | undefined) =>
        Boolean(entry?.isFile() || entry?.isSymbolicLink());
      const folder = (entry: Stats | undefined) =>
        Boolean(entry?.isDirectory() || entry?.isSymbolicLink());
      // Bare/custom Git metadata has no .git marker. File/type metadata alone
      // recognizes its HEAD/object/ref layout without reading repository state.
      check(
        !(file(head) && folder(objects) && (folder(refs) || file(packed))),
        "JOURNAL_IN_REPOSITORY",
      );
      if (dirname(ancestor) === ancestor) break;
    }
  }
}
export async function openJournal(
  directory: string,
  runId: string,
): Promise<Journal> {
  check(
    /^staging-yuru-[0-9a-f]{12}$/.test(runId) && isAbsolute(directory),
    "JOURNAL_REFUSED",
  );
  const stat = await lstat(directory);
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === 0o700 &&
      stat.uid === process.getuid?.(),
    "JOURNAL_REFUSED",
  );
  const actual = await realpath(directory);
  const relation = relative(await realpath(PRODUCT_ROOT), actual);
  check(
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relation),
    "JOURNAL_IN_REPOSITORY",
  );
  await outsideRepositories(directory, actual);
  // One durable run per explicitly supplied directory. A restart with a new
  // randomly generated prefix still cannot conceal a prior uncertain run.
  const handle: FileHandle = await open(
    join(actual, JOURNAL_FILENAME),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  // Persist directory creation before any remotely acknowledged effect.
  const parent = await open(actual, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await parent.sync();
  } catch (error) {
    await handle.close();
    throw error;
  } finally {
    await parent.close();
  }
  return {
    async append(entry) {
      await handle.writeFile(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    },
    async close() {
      await handle.close();
    },
  };
}
