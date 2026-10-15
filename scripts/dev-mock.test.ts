import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  createStoryIntentCoordinator,
  type StoryCreatePayload,
  type StoryIntentStorage,
} from "../src/lib/story-intent.ts";

class MemoryStorage implements StoryIntentStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("dev:mock keeps actor identity on Vite origin and acknowledges story writes", async () => {
  const appRoot = resolve(import.meta.dir, "..");
  const mockPort = await unusedPort();
  const env = { ...process.env };
  delete env.YURUCOMMU_MOCK_ORIGIN;
  env.YURUCOMMU_MOCK_HOST = "127.0.0.1";
  env.YURUCOMMU_MOCK_PORT = String(mockPort);

  const child = spawn("bun", ["scripts/dev-mock.ts"], {
    cwd: appRoot,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = childExit(child);

  try {
    const origin = await waitForViteOrigin(child, () => output);
    const session = await fetch(`${origin}/api/auth/me`);
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as {
      actor: { ap_id: string };
    };
    const principal = sessionBody.actor.ap_id;
    expect(new URL(principal).origin).toBe(origin);

    const form = new FormData();
    form.set(
      "file",
      new File(["story-image"], "media.jpg", { type: "image/jpeg" }),
    );
    const uploadResponse = await fetch(`${origin}/api/media/upload`, {
      method: "POST",
      body: form,
    });
    expect(uploadResponse.status).toBe(200);
    const upload = (await uploadResponse.json()) as {
      url: string;
      r2_key: string;
      content_type: string;
    };
    expect(upload.url).toBe(mediaPath(upload.r2_key));
    expect(upload.content_type).toBe("image/jpeg");
    const mediaResponse = await fetch(`${origin}${upload.url}`);
    expect(mediaResponse.status).toBe(200);
    expect(mediaResponse.headers.get("content-type")).toBe("image/jpeg");
    expect(await mediaResponse.text()).toBe("story-image");
    const mediaKeys = [upload.r2_key];
    // Race more requests than the remaining capacity; excess uploads must not
    // replace earlier media or over-admit entries after reading file bytes.
    const concurrent = await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        const nextForm = new FormData();
        nextForm.set(
          "file",
          new File([`small-${index}`], "media.jpg", { type: "image/jpeg" }),
        );
        const response = await fetch(`${origin}/api/media/upload`, {
          method: "POST",
          body: nextForm,
        });
        const body = (await response.json()) as { r2_key?: string };
        return { status: response.status, key: body.r2_key };
      }),
    );
    const accepted = concurrent.filter((result) => result.status === 200);
    expect(accepted.length).toBe(31);
    expect(concurrent.filter((result) => result.status === 413).length).toBe(9);
    for (const result of accepted) mediaKeys.push(result.key!);
    expect(new Set(mediaKeys).size).toBe(32);

    const overflowForm = new FormData();
    overflowForm.set(
      "file",
      new File(["overflow"], "media.jpg", { type: "image/jpeg" }),
    );
    const overflow = await fetch(`${origin}/api/media/upload`, {
      method: "POST",
      body: overflowForm,
    });
    expect(overflow.status).toBe(413);
    expect(await overflow.json()).toMatchObject({
      error: "mock media upload quota exceeded",
    });
    const preservedMedia = await fetch(`${origin}${upload.url}`);
    expect(preservedMedia.status).toBe(200);
    expect(preservedMedia.headers.get("content-type")).toBe("image/jpeg");
    expect(await preservedMedia.text()).toBe("story-image");

    const payload: StoryCreatePayload = {
      attachment: upload,
      caption: "  Story from the composer  ",
      displayDuration: "PT9S",
      overlays: [
        {
          type: "Note",
          name: "Meet here",
          position: { x: 0.5, y: 0.35, width: 0.6, height: 0.15 },
        },
      ],
    };
    const storage = new MemoryStorage();
    const coordinator = createStoryIntentCoordinator(
      { origin, principal, endpoint: `${origin}/api/stories` },
      storage,
    );
    expect(coordinator.stage(payload).failed).toBe(false);
    const outcome = await coordinator.submit(async (submitted) => {
      expect(submitted).toEqual(payload);
      const response = await fetch(`${origin}/api/stories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submitted),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { story: unknown };
      return body.story;
    });
    expect(outcome.kind).toBe("confirmed");
    const refreshedStories = await fetch(`${origin}/api/stories`);
    expect(refreshedStories.status).toBe(200);
    const storiesBody = (await refreshedStories.json()) as {
      actor_stories: Array<{
        actor: { ap_id: string };
        stories: Array<{
          ap_id: string;
          caption?: string;
          displayDuration: string;
          overlays: unknown[];
          attachment: { url: string; r2_key: string; mediaType: string };
        }>;
      }>;
    };
    const ownStories = storiesBody.actor_stories.find(
      (group) => group.actor.ap_id === principal,
    );
    const acceptedStory = ownStories?.stories.find(
      (story) => story.ap_id === outcome.record?.serverId,
    );
    expect(acceptedStory).toMatchObject({
      caption: payload.caption,
      displayDuration: payload.displayDuration,
      overlays: payload.overlays,
      attachment: {
        url: upload.url,
        r2_key: upload.r2_key,
        mediaType: upload.content_type,
      },
    });
  } finally {
    await killOwnedProcessGroup(child, exited);
  }
}, 40_000);

test("dev:mock honors an explicit Vite port and mock origin", async () => {
  const appRoot = resolve(import.meta.dir, "..");
  const mockPort = await unusedPort();
  const frontendPort = await unusedPort();
  const env = { ...process.env };
  env.YURUCOMMU_MOCK_ORIGIN = "https://mock-override.example";
  env.YURUCOMMU_MOCK_HOST = "127.0.0.1";
  env.YURUCOMMU_MOCK_PORT = String(mockPort);

  const child = spawn(
    "bun",
    ["scripts/dev-mock.ts", `--port=${frontendPort}`],
    {
      cwd: appRoot,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = childExit(child);

  try {
    const origin = await waitForViteOrigin(child, () => output);
    expect(new URL(origin).port).toBe(String(frontendPort));
    const response = await fetch(`${origin}/api/auth/me`);
    const body = (await response.json()) as { actor: { ap_id: string } };
    expect(new URL(body.actor.ap_id).origin).toBe(env.YURUCOMMU_MOCK_ORIGIN);
  } finally {
    await killOwnedProcessGroup(child, exited);
  }
}, 40_000);

function mediaPath(key: string) {
  return `/media/${key.startsWith("uploads/") ? key.slice(8) : key}`;
}

function childExit(child: ChildProcess) {
  return new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });
}

async function waitForViteOrigin(child: ChildProcess, getOutput: () => string) {
  const deadline = Date.now() + 30_000;
  let origin: string | undefined;
  while (Date.now() < deadline) {
    origin ??= getOutput().match(/Local:\s+(http:\/\/localhost:\d+)/)?.[1];
    if (origin) {
      try {
        const response = await fetch(`${origin}/api/auth/me`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.status === 200) return origin;
      } catch {
        // Vite may have printed its URL before the mock API is ready.
      }
    }
    if (child.exitCode !== null)
      throw new Error(`dev:mock exited before becoming ready: ${getOutput()}`);
    await Bun.sleep(100);
  }
  throw new Error(`dev:mock did not become ready: ${getOutput()}`);
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No port assigned");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function killOwnedProcessGroup(
  child: ChildProcess,
  exited: Promise<number | null>,
) {
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const timeout = Bun.sleep(3_000).then(() => "timeout" as const);
  const result = await Promise.race([exited, timeout]);
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (result === "timeout") await exited;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(-child.pid!, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await Bun.sleep(20);
  }
  throw new Error(`dev:mock process group ${child.pid} did not stop`);
}
