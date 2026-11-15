import { Ajv2020 } from "ajv/dist/2020.js";
import { isRecord } from "@ambitious/kit/domain/json";
import collectorSchema from "../../schemas/collector.v1.json" with { type: "json" };
import feedbackSchema from "../../schemas/send_feedback.v1.json" with { type: "json" };
import reportV1Schema from "../../schemas/send_report.v1.json" with { type: "json" };
import reportSchema from "../../schemas/send_report.v2.json" with { type: "json" };
import { pointerOf, type FieldProblem } from "./field-problems.ts";
import type { CollectorInput, SendFeedbackPayload, SendReportPayload } from "./types.ts";
import type { SendReportV1 } from "./wire.generated.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true, verbose: true });

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
  const validate: Validate = ajv.compile(schema);
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

const collector = validatorOf(collectorSchema, "collector");
const report = validatorOf(reportSchema, "send_report");
const reportV1 = validatorOf(reportV1Schema, "send_report version 1");
const feedback = validatorOf(feedbackSchema, "send_feedback");

export const collectorProblems = (raw: unknown): readonly FieldProblem[] => collector.problems(raw);

export const isCollectorDocument = (raw: unknown): raw is CollectorInput => collector.problems(raw).length === 0;

export const isReportPayload = (raw: unknown): raw is SendReportPayload => report.problems(raw).length === 0;

export const isReportV1Payload = (raw: unknown): raw is SendReportV1 => reportV1.problems(raw).length === 0;

export const isFeedbackPayload = (raw: unknown): raw is SendFeedbackPayload => feedback.problems(raw).length === 0;
