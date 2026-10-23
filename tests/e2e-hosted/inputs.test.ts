import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scenarios = [
  "raw",
  "empty",
  "maximum",
  "oversize",
  "invalid-limits",
  "json-whitespace",
  "invalid-utf8",
  "directory",
  "symlink",
  "fifo",
  "growth",
  "shrink",
  "same-size-write",
  "replacement",
  "symlink-replacement",
  "deletion",
] as const;
type Scenario = (typeof scenarios)[number];

// All FileHandle observation lives in this separate process. Every method
// delegates to the real filesystem; no bytes, metadata or fd result is faked.
const childBody = String.raw`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, fstatSync } from "node:fs";
import {
  appendFile, lstat, mkdir, open, rename, symlink, truncate, unlink,
  utimes, writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const { readBoundedFile, parseJson } = await import(readerModule);
const file = join(root, "input");
const retained = join(root, "retained");
let payload = new Uint8Array([0, 255, 65, 10]);
let maximum = 64;
if (scenario === "empty") { payload = new Uint8Array(); maximum = 0; }
if (scenario === "maximum") payload = Uint8Array.from({ length: 64 }, (_, i) => i);
if (scenario === "oversize") payload = new Uint8Array(65);
if (scenario === "json-whitespace")
  payload = new TextEncoder().encode(' \r\n{"ok":true}\t\n');
if (scenario === "invalid-utf8") payload = new Uint8Array([255]);
await writeFile(file, payload, { flag: "wx", mode: 0o600 });

// Obtain the real owning runtime's FileHandle prototype before installing
// pass-through observers, then close this setup handle before the probe.
const setup = await open(file, constants.O_RDONLY);
const prototype = Object.getPrototypeOf(setup);
await setup.close();
let selected = file;
if (scenario === "directory") {
  await unlink(file);
  await mkdir(file, { mode: 0o700 });
}
if (scenario === "fifo") {
  await unlink(file);
  execFileSync("mkfifo", ["-m", "600", file], {
    env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 1000,
    killSignal: "SIGKILL",
  });
  assert.equal((await lstat(file)).isFIFO(), true);
}
if (scenario === "symlink") {
  selected = join(root, "input-link");
  await symlink(file, selected);
}
const initial = await lstat(file, { bigint: true });
const names = ["stat", "read", "readFile", "close"];
const descriptors = new Map(names.map((name) => [
  name, Object.getOwnPropertyDescriptor(prototype, name),
]));
const originals = new Map(names.map((name) => [name, prototype[name]]));
for (const method of originals.values()) assert.equal(typeof method, "function");
const held = new Set();
const seen = new Set();
let initialStatSeen = false;
let mutationDone = false;
let totalRead = 0;
let readFileDepth = 0;

async function mutateAfterStat() {
  if (scenario === "growth") {
    mutationDone = true;
    await appendFile(file, new Uint8Array(65_536));
  } else if (scenario === "shrink") {
    mutationDone = true;
    await truncate(file, 0);
  }
}
async function mutateAfterRead() {
  if (mutationDone) return;
  if (scenario === "same-size-write") {
    mutationDone = true;
    const changed = payload.slice();
    changed[0] ^= 1;
    await writeFile(file, changed);
    // An actual timestamp update makes this deterministic on coarse filesystems.
    const changedTime = new Date(Number(initial.mtimeMs) + 1000);
    await utimes(file, changedTime, changedTime);
  } else if (scenario === "replacement" || scenario === "symlink-replacement") {
    mutationDone = true;
    await rename(file, retained);
    if (scenario === "replacement") await writeFile(file, payload);
    else await symlink(retained, file);
  } else if (scenario === "deletion") {
    mutationDone = true;
    await unlink(file);
  }
}
for (const name of names) {
  const original = originals.get(name);
  Object.defineProperty(prototype, name, {
    configurable: true,
    writable: true,
    value: async function (...args) {
      const fd = this.fd;
      if (name === "stat") {
        const value = await Reflect.apply(original, this, args);
        if (BigInt(value.dev) === initial.dev && BigInt(value.ino) === initial.ino) {
          held.add(fd);
          seen.add(fd);
          if (!initialStatSeen) {
            initialStatSeen = true;
            await mutateAfterStat();
          }
        }
        return value;
      }
      if (name === "close") {
        const value = await Reflect.apply(original, this, args);
        held.delete(fd);
        return value;
      }
      const watched = held.has(fd);
      if (name === "readFile") readFileDepth++;
      let value;
      try { value = await Reflect.apply(original, this, args); }
      finally { if (name === "readFile") readFileDepth--; }
      if (watched && readFileDepth === 0) {
        const size = name === "readFile" ? value.byteLength : value.bytesRead;
        totalRead += size;
        if (size > 0) await mutateAfterRead();
      }
      return value;
    },
  });
}

let bytes;
let failure;
try {
  if (scenario === "invalid-limits") {
    for (const value of [-1, 0.5, NaN, Infinity, 16_777_217])
      await assert.rejects(readBoundedFile(selected, value), { code: "FILE_REFUSED" });
  } else {
    try { bytes = await readBoundedFile(selected, maximum); }
    catch (error) { failure = error; }
  }
} finally {
  for (const name of names) {
    const descriptor = descriptors.get(name);
    if (descriptor) Object.defineProperty(prototype, name, descriptor);
    else delete prototype[name];
  }
}
assert.equal(held.size, 0, "held descriptor must close on every outcome");
for (const fd of seen)
  assert.throws(() => fstatSync(fd), { code: "EBADF" });
assert.ok(totalRead <= maximum + 1, "actual filesystem read exceeded its finite bound");
const refusals = [
  "oversize", "directory", "fifo", "growth", "shrink", "same-size-write",
  "replacement", "symlink-replacement", "deletion",
];
if (scenario === "symlink") {
  assert.equal(bytes, undefined);
  assert.equal(failure?.code, "ELOOP");
  assert.equal(totalRead, 0);
} else if (refusals.includes(scenario)) {
  assert.equal(bytes, undefined);
  assert.equal(failure?.code, "FILE_REFUSED");
  assert.equal(initialStatSeen, true, "observer must see the real held-fd stat");
} else if (scenario !== "invalid-limits") {
  assert.equal(failure, undefined);
  assert.deepEqual(Array.from(bytes), Array.from(payload));
  assert.equal(initialStatSeen, true);
  if (scenario === "json-whitespace") assert.deepEqual(parseJson(bytes), { ok: true });
  if (scenario === "invalid-utf8")
    assert.throws(() => parseJson(bytes), { message: "INVALID_JSON" });
}
if (["growth", "shrink", "same-size-write", "replacement", "symlink-replacement", "deletion"].includes(scenario))
  assert.equal(mutationDone, true, "the actual filesystem mutation must occur");
console.log(JSON.stringify({ scenario, heldClosed: true, totalRead, maximum, mutationDone }));
`;

async function isolated(scenario: Scenario): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "yuru-input-reader-"));
  try {
    await chmod(root, 0o700);
    const source = [
      `const scenario = ${JSON.stringify(scenario)};`,
      `const root = ${JSON.stringify(root)};`,
      `const readerModule = ${JSON.stringify(new URL("./inputs.ts", import.meta.url).href)};`,
      childBody,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
      env: { PATH: "/usr/bin:/bin", TMPDIR: root, TMP: root, TEMP: root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    let settled = false;
    const exit = child.exited.then((code) => {
      settled = true;
      return code;
    });
    // This is an explicit process watchdog, including startup and imports.
    // It does not alter production input deadlines or canonical test budgets.
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        child.kill("SIGKILL");
      }
    }, 3000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        exit,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(timedOut).toBe(false);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ scenario, heldClosed: true });
    } finally {
      clearTimeout(timer);
      if (!settled) {
        child.kill("SIGKILL");
        await exit;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const scenario of scenarios) {
  const posix = ["fifo", "symlink", "symlink-replacement"].includes(scenario);
  test.skipIf(posix && process.platform === "win32")(
    `bounded input reader: ${scenario} uses real isolated filesystem effects`,
    () => isolated(scenario),
  );
}
