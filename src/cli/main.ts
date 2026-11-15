import { pureCommand, readCommand, writeCommand } from "@ambitious/kit/cli/command";
import { embedded } from "@ambitious/kit/cli/embedded";
import { runCli } from "@ambitious/kit/cli/run-cli";
import { sha256Hex } from "../db/hash.ts";
import { buildStoredReport, markStoredReport, putBaseline, putSnapshot, readDiff, readFindings, readRecommendations } from "../db/store.ts";
import { assembleFeedback } from "../domain/feedback.ts";
import { parseCollector, parseFeedback, parseLooseId, parseReportBuild, parseReportMark, requireFeedback } from "../domain/input.ts";
import { asJsonObject } from "../domain/json-value.ts";

const identity = embedded();

await runCli({
  module: identity.module,
  version: identity.version,
  migrations: identity.migrations,
  schemaVersion: 1,
  commands: {
    snapshot: writeCommand({
      input: parseCollector,
      run: ({ input, clock, rng, db }) => asJsonObject(putSnapshot(db, input, clock, rng, sha256Hex)),
    }),
    "baseline set": writeCommand({
      input: parseLooseId,
      run: ({ input, clock, rng, db }) => asJsonObject(putBaseline(db, input, clock, rng, sha256Hex)),
    }),
    diff: readCommand({
      input: parseLooseId,
      run: ({ input, db }) => asJsonObject(readDiff(db, input)),
    }),
    findings: readCommand({
      input: parseLooseId,
      run: ({ input, db }) => asJsonObject(readFindings(db, input)),
    }),
    recommend: readCommand({
      input: parseLooseId,
      run: ({ input, clock, db }) => asJsonObject(readRecommendations(db, input, clock)),
    }),
    "report build": writeCommand({
      input: parseReportBuild,
      run: ({ input, clock, rng, db }) => asJsonObject(buildStoredReport(db, input, clock, rng, sha256Hex, identity.version)),
    }),
    "report mark": writeCommand({
      input: parseReportMark,
      run: ({ input, db }) => asJsonObject(markStoredReport(db, input)),
    }),
    "feedback build": pureCommand({
      input: parseFeedback,
      run: ({ input, clock, rng }) => asJsonObject(assembleFeedback(requireFeedback(input), rng, clock.now().getTime(), sha256Hex)),
    }),
  },
});
