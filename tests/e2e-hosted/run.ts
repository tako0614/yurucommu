import { HarnessError, readConfig, runHarness } from "./harness.ts";

try {
  console.log(
    JSON.stringify(
      await runHarness(readConfig(process.argv.slice(2), process.env)),
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      kind: "yurucommu.hosted-e2e@v1",
      status: "failed",
      code: error instanceof HarnessError ? error.code : "HARNESS_FAILED",
    }),
  );
  process.exitCode = 1;
}
