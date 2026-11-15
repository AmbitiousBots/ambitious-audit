import { Ajv2020 } from "ajv/dist/2020.js";
import { isRecord } from "@ambitious/kit/domain/json";
import collectorSchema from "../../schemas/collector.v1.json" with { type: "json" };
import feedbackSchema from "../../schemas/send_feedback.v1.json" with { type: "json" };
import reportSchema from "../../schemas/send_report.v1.json" with { type: "json" };
import type { CollectorInput, SendFeedbackPayload, SendReportPayload } from "./types.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });

const problemsOf = (validate: { (data: unknown): boolean; errors?: { instancePath?: string; message?: string }[] | null }, raw: unknown): readonly string[] => {
  if (validate(raw)) return [];
  const errors = validate.errors ?? [];
  if (errors.length === 0) return ["The document does not match its schema."];
  return errors.map((error) => {
    const place = error.instancePath === undefined || error.instancePath === "" ? "the document" : error.instancePath;
    return `The value at ${place} ${error.message ?? "is not valid"}.`;
  });
};

const compile = (schema: unknown, name: string) => {
  if (!isRecord(schema)) throw new Error(`The ${name} schema is not a JSON object.`);
  return ajv.compile(schema);
};

const collectorValidate = compile(collectorSchema, "collector");
const reportValidate = compile(reportSchema, "send_report");
const feedbackValidate = compile(feedbackSchema, "send_feedback");

export const collectorProblems = (raw: unknown): readonly string[] => problemsOf(collectorValidate, raw);

export const reportProblems = (raw: unknown): readonly string[] => problemsOf(reportValidate, raw);

export const feedbackProblems = (raw: unknown): readonly string[] => problemsOf(feedbackValidate, raw);

export const isCollectorDocument = (raw: unknown): raw is CollectorInput => collectorProblems(raw).length === 0;

export const isReportPayload = (raw: unknown): raw is SendReportPayload => reportProblems(raw).length === 0;

export const isFeedbackPayload = (raw: unknown): raw is SendFeedbackPayload => feedbackProblems(raw).length === 0;
