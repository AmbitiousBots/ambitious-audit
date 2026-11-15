import { normalizeCollector } from "./canonical.ts";
import { COMMAND_INPUT_SCHEMAS, type InputCommand } from "./command-inputs.ts";
import { inputFailure, type FieldProblem } from "./field-problems.ts";
import { validatorOf } from "./schema.ts";
import type { BaselineSetInput, CollectorInput, DiffInput, FeedbackBuildInput, FindingsInput, RecommendInput, ReportBuildInput, ReportMarkInput } from "./types.ts";

type Inputs = {
  readonly snapshot: CollectorInput;
  readonly "baseline set": BaselineSetInput;
  readonly diff: DiffInput;
  readonly findings: FindingsInput;
  readonly recommend: RecommendInput;
  readonly "report build": ReportBuildInput;
  readonly "report mark": ReportMarkInput;
  readonly "feedback build": FeedbackBuildInput;
};

const schemaCommand = (command: InputCommand): string => `schema ${command}`;

const parserOf = <Command extends InputCommand>(command: Command): ((raw: unknown) => Inputs[Command]) => {
  const validator = validatorOf(COMMAND_INPUT_SCHEMAS[command], command);
  const accepted = (_raw: unknown, problems: readonly FieldProblem[]): _raw is Inputs[Command] => problems.length === 0;
  return (raw) => {
    const problems = validator.problems(raw);
    if (accepted(raw, problems)) return raw;
    throw inputFailure(schemaCommand(command), problems);
  };
};

const collectorDocument = parserOf("snapshot");

export const parseCollector = (raw: unknown): CollectorInput => normalizeCollector(collectorDocument(raw), schemaCommand("snapshot"));

export const parseBaselineSet = parserOf("baseline set");
export const parseDiff = parserOf("diff");
export const parseFindings = parserOf("findings");
export const parseRecommend = parserOf("recommend");
export const parseReportBuild = parserOf("report build");
export const parseReportMark = parserOf("report mark");

const feedbackDocument = parserOf("feedback build");

export const parseFeedback = (raw: unknown): FeedbackBuildInput => {
  const input = feedbackDocument(raw);
  const text = input.text.trim();
  if (text.length === 0) {
    throw inputFailure(schemaCommand("feedback build"), [{ pointer: "/text", rule: "minLength", must: "must hold at least 1 character that is not a space", help: "Send the feedback as text." }]);
  }
  return { ...input, text };
};

export const unparsed = (raw: unknown): unknown => raw;
