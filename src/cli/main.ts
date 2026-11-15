import { pureCommand, readCommand, writeCommand } from "@ambitious/kit/cli/command";
import { embedded } from "@ambitious/kit/cli/embedded";
import { runCli } from "@ambitious/kit/cli/run-cli";
import { sha256Hex } from "../db/hash.ts";
import { buildStoredReport, markStoredReport, putBaseline, putSnapshot, readDiff, readFindings, readRecommendations } from "../db/store.ts";
import { assembleFeedback } from "../domain/feedback.ts";
import { COMMAND_INPUT_SCHEMAS, INPUT_COMMANDS, type InputCommand } from "../domain/command-inputs.ts";
import { parseBaselineSet, parseCollector, parseDiff, parseFeedback, parseFindings, parseRecommend, parseReportBuild, parseReportMark, unparsed } from "../domain/input.ts";
import { asJsonObject } from "../domain/json-value.ts";

const identity = embedded();

const schemaCommand = (command: InputCommand) =>
  pureCommand({ run: () => asJsonObject({ input: command, commands: INPUT_COMMANDS, schema: COMMAND_INPUT_SCHEMAS[command] }) });

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
      input: parseBaselineSet,
      run: ({ input, clock, rng, db }) => asJsonObject(putBaseline(db, input, clock, rng, sha256Hex)),
    }),
    diff: readCommand({
      input: unparsed,
      run: ({ input, db }) => asJsonObject(readDiff(db, parseDiff(input))),
    }),
    findings: readCommand({
      input: unparsed,
      run: ({ input, db }) => asJsonObject(readFindings(db, parseFindings(input))),
    }),
    recommend: readCommand({
      input: unparsed,
      run: ({ input, clock, db }) => asJsonObject(readRecommendations(db, parseRecommend(input), clock)),
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
      run: ({ input, clock, rng }) => asJsonObject(assembleFeedback(input, rng, clock.now().getTime(), sha256Hex)),
    }),
    schema: schemaCommand("snapshot"),
    "schema snapshot": schemaCommand("snapshot"),
    "schema baseline set": schemaCommand("baseline set"),
    "schema diff": schemaCommand("diff"),
    "schema findings": schemaCommand("findings"),
    "schema recommend": schemaCommand("recommend"),
    "schema report build": schemaCommand("report build"),
    "schema report mark": schemaCommand("report mark"),
    "schema feedback build": schemaCommand("feedback build"),
  },
});
