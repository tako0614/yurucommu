import { HarnessError, readConfig, runHarness } from "./harness.ts";

try {
  const report = await runHarness(
    readConfig(process.argv.slice(2), process.env),
  );
  console.log(JSON.stringify(report));
  if (report.status === "failed" || report.status === "halted")
    process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      kind: "yurucommu.hosted-e2e@v2",
      status: "failed",
      code: error instanceof HarnessError ? error.code : "HARNESS_FAILED",
    }),
  );
  process.exitCode = 1;
}
