import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "./contracts.ts";
import { JOURNAL_FILENAME, openJournal, type Journal } from "./journal.ts";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});
async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yuru-journal-boundary-"));
  await chmod(directory, 0o700);
  temporaryRoots.push(directory);
  return directory;
}
async function evidence(parent: string): Promise<string> {
  const directory = join(parent, "operator", "evidence");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
async function refused(directory: string): Promise<void> {
  let journal: Journal | undefined;
  let failure: unknown;
  try {
    journal = await openJournal(directory, "yurucommu-e2e-123456789abc");
  } catch (error) {
    failure = error;
  } finally {
    await journal?.close();
  }
  expect(failure).toBeInstanceOf(HarnessError);
  expect((failure as HarnessError).code).toBe("JOURNAL_IN_REPOSITORY");
  const file = join(await realpath(directory), JOURNAL_FILENAME);
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}
test("journal refuses another checkout before writing a file", async () => {
  const checkout = await root();
  await mkdir(join(checkout, ".git"));
  await refused(await evidence(checkout));
});
test("journal refuses a linked worktree's .git file before writing a file", async () => {
  const checkout = await root();
  // No Git subprocess or metadata contents need to be read to enforce this boundary.
  await writeFile(
    join(checkout, ".git"),
    "gitdir: /unused/local/git-metadata\n",
  );
  await refused(await evidence(checkout));
});
for (const packed of [false, true])
  test(`journal refuses bare Git metadata (${packed ? "packed refs" : "refs directory"})`, async () => {
    const bare = await root();
    await mkdir(join(bare, "objects"));
    await writeFile(join(bare, "HEAD"), "ref: refs/heads/main\n");
    if (packed) await writeFile(join(bare, "packed-refs"), "# local fixture\n");
    else await mkdir(join(bare, "refs"));
    await refused(await evidence(bare));
  });
test("an external symlink ancestor cannot enter a checkout", async () => {
  const checkout = await root();
  await mkdir(join(checkout, ".git"));
  await evidence(checkout);
  const outside = await root();
  await symlink(checkout, join(outside, "linked-checkout"), "dir");
  await refused(join(outside, "linked-checkout", "operator", "evidence"));
});
test("a checkout symlink ancestor cannot escape to an external journal directory", async () => {
  const checkout = await root();
  await mkdir(join(checkout, ".git"));
  const outside = await root();
  await evidence(outside);
  await symlink(outside, join(checkout, "linked-outside"), "dir");
  await refused(join(checkout, "linked-outside", "operator", "evidence"));
});
test("normal external directory retains exclusive 0600 append and sync", async () => {
  const directory = await evidence(await root());
  const journal = await openJournal(directory, "yurucommu-e2e-123456789abc");
  try {
    await journal.append({ kind: "health", passed: true });
  } finally {
    await journal.close();
  }
  const file = join(directory, JOURNAL_FILENAME);
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
  expect(await Bun.file(file).text()).toBe('{"kind":"health","passed":true}\n');
  await expect(
    openJournal(directory, "yurucommu-e2e-abcdefabcdef"),
  ).rejects.toMatchObject({ code: "EEXIST" });
});
