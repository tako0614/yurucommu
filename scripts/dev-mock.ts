import { dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = (await Bun.file(
  resolve(appRoot, "package.json"),
).json()) as {
  name?: string;
};

const isYurumeet = packageJson.name?.includes("yurumeet") ?? false;
const proxyEnvName = isYurumeet
  ? "YURUME_DEV_PROXY_TARGET"
  : "YURUCOMMU_DEV_PROXY_TARGET";
const { port: frontendPort, forwardedArgs } = await pickFrontendPort(
  process.argv.slice(2),
);
const mockHost =
  process.env.YURUCOMMU_MOCK_HOST ?? process.env.MOCK_HOST ?? "0.0.0.0";
const mockPort = await pickMockPort();
const mockTarget = `http://127.0.0.1:${mockPort}`;

const env = {
  ...process.env,
  YURUCOMMU_MOCK_ORIGIN:
    process.env.YURUCOMMU_MOCK_ORIGIN ?? `http://localhost:${frontendPort}`,
  YURUCOMMU_MOCK_PORT: mockPort,
  YURUCOMMU_MOCK_HOST: mockHost,
  [proxyEnvName]: mockTarget,
};

const mockApi = Bun.spawn(["bun", "scripts/dev-mock-server.ts"], {
  cwd: appRoot,
  env,
  stdout: "inherit",
  stderr: "inherit",
});

const vite = Bun.spawn(
  [
    "bun",
    "run",
    "dev",
    "--",
    ...forwardedArgs,
    "--port",
    frontendPort,
    "--strictPort",
  ],
  {
    cwd: appRoot,
    env,
    stdout: "inherit",
    stderr: "inherit",
  },
);

const children = [mockApi, vite];
let shuttingDown = false;

function shutdown(exitCode: number): never {
  if (!shuttingDown) {
    shuttingDown = true;
    for (const child of children) {
      child.kill();
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

const firstExit = await Promise.race([
  mockApi.exited.then((code) => ({ name: "mock API", code })),
  vite.exited.then((code) => ({ name: "Vite", code })),
]);

if (!shuttingDown) {
  console.error(`${firstExit.name} exited with code ${firstExit.code}`);
  shutdown(firstExit.code === 0 ? 0 : firstExit.code);
}

async function pickMockPort(): Promise<string> {
  const explicitPort = process.env.YURUCOMMU_MOCK_PORT ?? process.env.MOCK_PORT;
  if (explicitPort) return explicitPort;

  for (let port = 8787; port <= 8797; port += 1) {
    if (await isPortAvailable(port)) return String(port);
  }

  throw new Error(
    "No free mock API port found in 8787-8797. Set YURUCOMMU_MOCK_PORT to override.",
  );
}

async function pickFrontendPort(args: string[]) {
  let explicitPort: string | undefined;
  const forwardedArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--port") {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("Expected a value after --port.");
      explicitPort = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--port=")) {
      explicitPort = argument.slice("--port=".length);
      continue;
    }
    forwardedArgs.push(argument);
  }

  if (explicitPort !== undefined) {
    const port = Number(explicitPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`Invalid frontend --port: ${explicitPort}`);
    return { port: String(port), forwardedArgs };
  }

  for (let port = 5173; port <= 5183; port += 1) {
    if (await isPortAvailable(port))
      return { port: String(port), forwardedArgs };
  }

  throw new Error(
    "No free frontend port found in 5173-5183. Pass --port to select one.",
  );
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.once("listening", () => {
      server.close(() => resolveAvailable(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
