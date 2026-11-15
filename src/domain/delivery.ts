import type { DeliveryPolicy, DeliveryStep, MarkError, Report, ReportMark, Result } from "./types.ts";
import { err, ok } from "./types.ts";

export const DELIVERY_POLICY: DeliveryPolicy = { maxAttempts: 3 };

const transition = (from: Report["state"], to: ReportMark["state"]): MarkError => ({ code: "E_TRANSITION", from, to });

const reviewBlocked = (report: Report): boolean => report.reviewRequired && report.state === "built";

export const nextDeliveryStep = (report: Report, policy: DeliveryPolicy): DeliveryStep => {
  if (report.state === "built" && report.reviewRequired) return { kind: "waitForReview", reportId: report.reportId };
  if (report.state === "built" || report.state === "reviewed") return { kind: "send", reportId: report.reportId, attempt: report.failures + 1 };
  if (report.state === "failed" && report.failures < policy.maxAttempts) return { kind: "send", reportId: report.reportId, attempt: report.failures + 1 };
  if (report.state === "failed") return { kind: "gaveUp", reportId: report.reportId, failures: report.failures };
  if (report.state === "sent") return { kind: "confirm", reportId: report.reportId };
  return { kind: "delivered", reportId: report.reportId };
};

export const applyMark = (report: Report, mark: ReportMark, policy: DeliveryPolicy): Result<Report, MarkError> => {
  if (mark.reportId !== report.reportId) return err({ code: "E_REPORT_NOT_FOUND", reportId: mark.reportId });
  const from = report.state;
  const to = mark.state;
  if (to === "reviewed") {
    if (from !== "built") return err(transition(from, to));
    return ok({ ...report, state: "reviewed", updatedAt: mark.at });
  }
  if (to === "acked") {
    if (from !== "sent") return err(transition(from, to));
    return ok({ ...report, state: "acked", updatedAt: mark.at });
  }
  if (reviewBlocked(report)) return err({ code: "E_REVIEW_REQUIRED", reportId: report.reportId });
  if (to === "sent") {
    if (from !== "built" && from !== "reviewed" && from !== "failed") return err(transition(from, to));
    if (from === "failed" && report.failures >= policy.maxAttempts) return err({ code: "E_ATTEMPTS_EXHAUSTED", failures: report.failures, maxAttempts: policy.maxAttempts });
    return ok({ ...report, state: "sent", updatedAt: mark.at });
  }
  if (from !== "built" && from !== "reviewed" && from !== "failed") return err(transition(from, to));
  if (report.failures >= policy.maxAttempts) return err({ code: "E_ATTEMPTS_EXHAUSTED", failures: report.failures, maxAttempts: policy.maxAttempts });
  return ok({ ...report, state: "failed", failures: report.failures + 1, updatedAt: mark.at });
};
