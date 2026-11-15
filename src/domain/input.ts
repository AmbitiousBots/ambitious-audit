import { failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import { normalizeCollector } from "./canonical.ts";
import { isCollectorDocument } from "./schema.ts";
import { parseTimestamp } from "./time.ts";
import type { BaselineId, CollectorInput, FeedbackSender, MarkableState, ReportId, SnapshotId } from "./types.ts";
import { isBaselineId, isReportId, isSnapshotId, MARKABLE_STATES, WIRE_LIMITS } from "./types.ts";

const stringField = (raw: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const value = raw[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw failure("E_INPUT_SCHEMA", `The input field "${name}" must be a string.`, `Send "${name}" as a string.`);
  }
  return value;
};

const onlyFields = (raw: Readonly<Record<string, unknown>>, names: readonly string[]): void => {
  const extra = Object.keys(raw).filter((name) => !names.includes(name));
  const first = extra[0];
  if (first !== undefined) {
    throw failure("E_INPUT_SCHEMA", `The input field "${first}" is not used.`, `Send only these fields: ${names.join(", ")}.`);
  }
};

const objectInput = (raw: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(raw)) throw failure("E_INPUT_SCHEMA", "The input must be a JSON object.", "Send one JSON object on stdin or with --in.");
  return raw;
};

export type LooseId = { readonly snapshotId?: string; readonly from?: string; readonly to?: string };

export const parseLooseId = (raw: unknown): LooseId => {
  const record = objectInput(raw);
  onlyFields(record, ["snapshotId", "from", "to"]);
  const snapshotId = stringField(record, "snapshotId");
  const from = stringField(record, "from");
  const to = stringField(record, "to");
  return {
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
};

export const requireSnapshotId = (value: string | undefined): SnapshotId => {
  if (value === undefined || !isSnapshotId(value)) {
    throw failure("E_INPUT_SCHEMA", 'The input field "snapshotId" must be a version 7 UUID.', "Send the snapshotId returned by snapshot.");
  }
  return value;
};

export const requireTargetId = (value: string | undefined): SnapshotId => {
  if (value === undefined || !isSnapshotId(value)) {
    throw failure("E_INPUT_SCHEMA", 'The input field "to" must be a snapshot id.', "Send the snapshotId returned by snapshot.");
  }
  return value;
};

export const requireBaselineId = (value: string): BaselineId => {
  if (!isBaselineId(value)) {
    throw failure("E_INPUT_SCHEMA", 'The input field "from" must be a baseline id.', "Pass the baselineId returned by baseline set, or omit from to use the latest baseline.");
  }
  return value;
};

export const parseCollector = (raw: unknown): CollectorInput => {
  if (!isCollectorDocument(raw)) {
    throw failure(
      "E_INPUT_SCHEMA",
      "The input does not match the collector document.",
      "Send schemaVersion 1 with account, bots, routines, connectors, tasks, pages, visibility and evidence.",
    );
  }
  return normalizeCollector(raw);
};

export type ReportBuildFields = { readonly snapshotId?: string; readonly reviewRequired?: boolean };

export const parseReportBuild = (raw: unknown): ReportBuildFields => {
  const record = objectInput(raw);
  onlyFields(record, ["snapshotId", "reviewRequired"]);
  const snapshotId = stringField(record, "snapshotId");
  const reviewRequired = record.reviewRequired;
  if (reviewRequired !== undefined && typeof reviewRequired !== "boolean") {
    throw failure("E_INPUT_SCHEMA", 'The input field "reviewRequired" must be true or false.', "Say whether a person must review the report before it is sent.");
  }
  return {
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(reviewRequired === undefined ? {} : { reviewRequired }),
  };
};

export const requireReviewRequired = (value: boolean | undefined): boolean => {
  if (value === undefined) {
    throw failure("E_INPUT_SCHEMA", 'The input field "reviewRequired" must be true or false.', "Say whether a person must review the report before it is sent.");
  }
  return value;
};

const isMarkable = (value: string): value is MarkableState => MARKABLE_STATES.some((state) => state === value);

export type ReportMarkFields = { readonly reportId?: string; readonly state?: string; readonly at?: string };

export const parseReportMark = (raw: unknown): ReportMarkFields => {
  const record = objectInput(raw);
  onlyFields(record, ["reportId", "state", "at"]);
  const reportId = stringField(record, "reportId");
  const state = stringField(record, "state");
  const at = stringField(record, "at");
  return {
    ...(reportId === undefined ? {} : { reportId }),
    ...(state === undefined ? {} : { state }),
    ...(at === undefined ? {} : { at }),
  };
};

export const requireReportId = (value: string | undefined): ReportId => {
  if (value === undefined || !isReportId(value)) {
    throw failure("E_INPUT_SCHEMA", 'The input field "reportId" must be a version 7 UUID.', "Send the reportId returned by report build.");
  }
  return value;
};

export const requireMark = (fields: ReportMarkFields): { readonly reportId: ReportId; readonly state: MarkableState; readonly at: string } => {
  const reportId = requireReportId(fields.reportId);
  const state = fields.state;
  if (state === undefined || !isMarkable(state)) {
    throw failure("E_INPUT_SCHEMA", 'The input field "state" must be reviewed, sent, acked or failed.', "Send one of those four states.");
  }
  const at = fields.at;
  if (at === undefined || parseTimestamp(at) === null) {
    throw failure("E_INPUT_SCHEMA", 'The input field "at" must be a UTC timestamp.', "Use YYYY-MM-DDTHH:MM:SSZ, with optional milliseconds.");
  }
  return { reportId, state, at };
};

export type FeedbackFields = { readonly reportId?: string; readonly text?: string; readonly from?: string };

export const parseFeedback = (raw: unknown): FeedbackFields => {
  const record = objectInput(raw);
  onlyFields(record, ["reportId", "text", "from"]);
  const reportId = stringField(record, "reportId");
  const text = stringField(record, "text");
  const from = stringField(record, "from");
  return {
    ...(reportId === undefined ? {} : { reportId }),
    ...(text === undefined ? {} : { text }),
    ...(from === undefined ? {} : { from }),
  };
};

const isSender = (value: string): value is FeedbackSender => value === "customer" || value === "bot";

export const requireFeedback = (fields: FeedbackFields): { readonly reportId?: ReportId; readonly text: string; readonly from: FeedbackSender } => {
  const text = fields.text?.trim() ?? "";
  if (text.length < 1 || text.length > WIRE_LIMITS.feedbackTextCharacters) {
    throw failure(
      "E_INPUT_SCHEMA",
      `The input field "text" must be 1 to ${WIRE_LIMITS.feedbackTextCharacters} characters.`,
      "Send the feedback as text.",
    );
  }
  const from = fields.from;
  if (from === undefined || !isSender(from)) {
    throw failure("E_INPUT_SCHEMA", 'The input field "from" must be "customer" or "bot".', "Say who wrote the feedback.");
  }
  if (fields.reportId === undefined) return { text, from };
  return { text, from, reportId: requireReportId(fields.reportId) };
};
