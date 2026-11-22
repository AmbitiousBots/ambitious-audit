import { wireValidator } from "./wire-validator.ts";
import { isRecord } from "@ambitious/kit/domain/json";
import collectorV1Schema from "../../schemas/collector.v1.json" with { type: "json" };
import collectorSchema from "../../schemas/collector.v2.json" with { type: "json" };
import feedbackSchema from "../../schemas/send_feedback.v1.json" with { type: "json" };
import reportV1Schema from "../../schemas/send_report.v1.json" with { type: "json" };
import reportV2Schema from "../../schemas/send_report.v2.json" with { type: "json" };
import reportV3Schema from "../../schemas/send_report.v3.json" with { type: "json" };
import reportSchema from "../../schemas/send_report.v4.json" with { type: "json" };
import { pointerOf, type FieldProblem } from "./field-problems.ts";
import type { CollectorInput, SendFeedbackPayload, SendReportPayload } from "./types.ts";
import type { SendReportV1, SendReportV2, SendReportV3 } from "./wire.generated.ts";

type SchemaError = {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly message?: string;
  readonly schema?: unknown;
  readonly parentSchema?: unknown;
};

type Validate = { (data: unknown): boolean; errors?: readonly SchemaError[] | null };

const childPointer = (path: string, name: unknown): string => (typeof name === "string" ? `${path}${pointerOf([name])}` : path);

const quoted = (values: unknown): string => (Array.isArray(values) ? values.map((value) => JSON.stringify(value)).join(", ") : JSON.stringify(values));

const containedSignal = (schema: unknown): string | null => {
  const properties = isRecord(schema) ? schema.properties : undefined;
  const signal = isRecord(properties) ? properties.signal : undefined;
  const value = isRecord(signal) ? signal.const : undefined;
  return typeof value === "string" ? value : null;
};

const problemOf = (error: SchemaError): FieldProblem => {
  const description = isRecord(error.parentSchema) && typeof error.parentSchema.description === "string" ? error.parentSchema.description : "";
  const at = (pointer: string, must: string): FieldProblem => ({ pointer, rule: error.keyword, must, help: description });
  if (error.keyword === "required") return { pointer: childPointer(error.instancePath, error.params.missingProperty), rule: "required", must: "is required and is missing", help: "" };
  if (error.keyword === "additionalProperties") {
    return { pointer: childPointer(error.instancePath, error.params.additionalProperty), rule: "additionalProperties", must: "is not a field of this input", help: description };
  }
  if (error.keyword === "type") return at(error.instancePath, `must be ${[error.params.type].flat().join(" or ")}`);
  if (error.keyword === "enum") return at(error.instancePath, `must be one of ${quoted(error.params.allowedValues)}`);
  if (error.keyword === "const") return at(error.instancePath, `must be ${quoted(error.params.allowedValue)}`);
  if (error.keyword === "multipleOf") return at(error.instancePath, "must use whole cents");
  if (error.keyword === "pattern") return at(error.instancePath, "is not written in the required form");
  if (error.keyword === "false schema") return at(error.instancePath, "must be left out, because it does not go with the other fields of this value");
  if (error.keyword === "contains") {
    const signal = containedSignal(error.schema);
    return at(error.instancePath, signal === null ? "is missing a required entry" : `must have one entry whose signal is "${signal}"`);
  }
  return at(error.instancePath, error.message ?? "is not valid");
};

export type Validator = { readonly problems: (raw: unknown) => readonly FieldProblem[] };

export const validatorOf = (schema: unknown, name: string): Validator => {
  if (!isRecord(schema)) throw new Error(`The ${name} schema is not a JSON object.`);
  const validate: Validate = wireValidator.compile(schema);
  return {
    problems: (raw) => {
      if (validate(raw)) return [];
      const seen = new Set<string>();
      const problems: FieldProblem[] = [];
      for (const error of validate.errors ?? []) {
        if (error.schemaPath.includes("/contains/") || error.keyword === "if") continue;
        const problem = problemOf(error);
        const key = `${problem.pointer}\t${problem.rule}\t${problem.must}`;
        if (seen.has(key)) continue;
        seen.add(key);
        problems.push(problem);
      }
      return problems.length > 0 ? problems : [{ pointer: "", rule: "schema", must: "does not match its schema", help: "" }];
    },
  };
};

const collectorV1 = validatorOf(collectorV1Schema, "collector version 1");
const collector = validatorOf(collectorSchema, "collector");
const report = validatorOf(reportSchema, "send_report");
const reportV1 = validatorOf(reportV1Schema, "send_report version 1");
const reportV2 = validatorOf(reportV2Schema, "send_report version 2");
const reportV3 = validatorOf(reportV3Schema, "send_report version 3");
const feedback = validatorOf(feedbackSchema, "send_feedback");

export const collectorProblems = (raw: unknown): readonly FieldProblem[] =>
  (isRecord(raw) && raw.schemaVersion === 1 ? collectorV1 : collector).problems(raw);

export const isCollectorDocument = (raw: unknown): raw is CollectorInput => collectorProblems(raw).length === 0;

export const isReportPayload = (raw: unknown): raw is SendReportPayload => {
  const matches = (value: unknown): value is SendReportPayload => report.problems(value).length === 0;
  return matches(raw) && new Set(raw.announcements.map((item) => item.id)).size === raw.announcements.length;
};

export const isReportV1Payload = (raw: unknown): raw is SendReportV1 => reportV1.problems(raw).length === 0;

export const isReportV2Payload = (raw: unknown): raw is SendReportV2 => reportV2.problems(raw).length === 0;

export const isReportV3Payload = (raw: unknown): raw is SendReportV3 => {
  const matches = (value: unknown): value is SendReportV3 => reportV3.problems(value).length === 0;
  return matches(raw) && new Set(raw.announcements.map((item) => item.id)).size === raw.announcements.length;
};

export const isFeedbackPayload = (raw: unknown): raw is SendFeedbackPayload => feedback.problems(raw).length === 0;
