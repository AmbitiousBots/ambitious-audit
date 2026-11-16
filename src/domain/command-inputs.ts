import collectorSchema from "../../schemas/collector.v1.json" with { type: "json" };
import reportSchema from "../../schemas/send_report.v3.json" with { type: "json" };
import { MARKABLE_STATES, WIRE_LIMITS, WIRE_PATTERNS } from "./types.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

const uuid = (description: string) => ({ type: "string", maxLength: 36, pattern: WIRE_PATTERNS.uuidV7.source, description }) as const;

const snapshotId = uuid("The snapshotId that snapshot returned: a lower-case version 7 UUID.");
const reportId = uuid("The reportId that report build returned: a lower-case version 7 UUID.");

const document = <Properties extends Readonly<Record<string, unknown>>>(name: string, description: string, required: readonly (keyof Properties & string)[], properties: Properties) =>
  ({
    $schema: DRAFT,
    $id: `urn:ambitious:audit:schema:input:${name.replaceAll(" ", "-")}`,
    title: `Input of the ${name} command`,
    description,
    type: "object",
    additionalProperties: false,
    required,
    properties,
  }) as const;

const bySnapshot = (name: string, description: string) => document(name, description, ["snapshotId"], { snapshotId });

export const COMMAND_INPUT_SCHEMAS = {
  snapshot: collectorSchema,
  "baseline set": bySnapshot("baseline set", "Names the snapshot that later diffs are compared with."),
  diff: document("diff", "Names the two sides of a comparison.", ["to"], {
    from: uuid("The baselineId that baseline set returned. Leave it out to use the latest baseline."),
    to: uuid("The snapshotId to compare with the baseline."),
  }),
  findings: bySnapshot("findings", "Names the snapshot to apply the rules to."),
  recommend: bySnapshot("recommend", "Names the snapshot to recommend from."),
  "report build": document("report build", "Names the snapshot to report on and says whether a person must review the report before it is sent.", ["snapshotId", "reviewRequired"], {
    snapshotId,
    reviewRequired: { type: "boolean", description: "true when a person must review the report before it is sent." },
    announcements: {
      type: "array",
      maxItems: WIRE_LIMITS.announcements,
      items: reportSchema.$defs.announcement,
      description: "Saved check_updates announcements. Before applying this schema, validate every item's id, priority and title, ignore its other fields, keep the first occurrence of each id, sort high before low (preserving order within each priority), and retain at most 10. Leave out for none. Never write or rewrite announcement text.",
    },
  }),
  "report mark": document("report mark", "Records one step in a report's delivery.", ["reportId", "state", "at"], {
    reportId,
    state: { enum: MARKABLE_STATES, description: "The step that happened." },
    at: { type: "string", maxLength: 24, pattern: WIRE_PATTERNS.timestamp.source, description: "When the step happened, in UTC, written as YYYY-MM-DDTHH:MM:SSZ with optional milliseconds." },
  }),
  "feedback build": document("feedback build", "Feedback from the customer or their bot, optionally about one report.", ["text", "from"], {
    reportId,
    text: { type: "string", minLength: 1, maxLength: WIRE_LIMITS.feedbackTextCharacters, description: `The feedback, 1 to ${WIRE_LIMITS.feedbackTextCharacters} characters.` },
    from: { enum: ["customer", "bot"], description: "Who wrote the feedback." },
  }),
} as const;

export type InputCommand = keyof typeof COMMAND_INPUT_SCHEMAS;

export const INPUT_COMMANDS: readonly InputCommand[] = ["snapshot", "baseline set", "diff", "findings", "recommend", "report build", "report mark", "feedback build"];
