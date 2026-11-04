import { HarnessError, type SharedOriginSelection } from "./contracts.ts";
import {
  loadFixture,
  parseJson,
  parseTarget,
  readBoundedFile,
  type Config,
} from "./inputs.ts";
import { openJournal } from "./journal.ts";
import { runLifecycle } from "./lifecycle.ts";
import { HttpV2Port, type HostedArtifactBytePort } from "./v2-port.ts";

export { HarnessError };
export { readConfig } from "./inputs.ts";
export async function runHarness(
  config: Config,
  options: {
    artifactBytes?: HostedArtifactBytePort;
    sharedOrigin?: SharedOriginSelection;
  } = {},
) {
  if (config.mode === "dry-run")
    return {
      kind: "yurucommu.hosted-e2e@v2",
      status: "dry-run",
      phases: [
        "artifact-publication-and-host-preflight",
        "deploy-v2-graph",
        "migration-backed-health",
        "teardown-owned-graph",
        "host-and-route-absence",
      ],
      prerequisites: [
        "qualified-owner-staging-target",
        "immutable-yurucommu-artifact-receipt",
        "distinct-scoped-writer-and-evidence-credentials",
        "six-application-private-inputs",
        "owned-external-0700-journal-directory",
      ],
    };
  const target = parseTarget(
    parseJson(await readBoundedFile(config.targetFile)),
  );
  const fixture = await loadFixture(config.fixtureFile);
  const journal = await openJournal(config.journalDirectory, config.runId);
  try {
    return await runLifecycle({
      target,
      fixture,
      runId: config.runId,
      privateInputs: config.privateInputs,
      sharedOrigin: options.sharedOrigin,
      port: new HttpV2Port(
        target,
        config.writer,
        config.evidence,
        undefined,
        options.artifactBytes,
      ),
      journal,
    });
  } finally {
    await journal.close();
  }
}
