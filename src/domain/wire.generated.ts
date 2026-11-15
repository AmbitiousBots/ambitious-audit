export type CollectorV1Timestamp = string;

export type CollectorV1Id = string;

export type CollectorV1Bot = { readonly id: CollectorV1Id; readonly name: string; readonly lastActiveAt: string | null; readonly routineCount: number; readonly usage: { readonly credits7d: number | null } };

export type CollectorV1Routine = { readonly id: CollectorV1Id; readonly botId: CollectorV1Id; readonly schedule: string; readonly state: "active" | "paused" | "failing"; readonly lastRunAt: string | null; readonly lastError?: string };

export type CollectorV1Connector = { readonly name: string; readonly status: "ok" | "needsAuth" | "error" };

export type CollectorV1VisibilityEntry = { readonly signal: "transcripts" | "usage" | "otherBots" | "auditLog"; readonly seen: boolean; readonly why: string };

export type CollectorV1Visibility = readonly CollectorV1VisibilityEntry[];

export type CollectorV1Evidence = { readonly id: CollectorV1EvidenceId; readonly kind: "excerpt" | "count"; readonly text: string; readonly source: string };

export type CollectorV1EvidenceId = string;

export type CollectorV1 = { readonly schemaVersion: 1; readonly collectedAt: CollectorV1Timestamp; readonly account: { readonly kind: "owner" | "guest" | "team"; readonly label: string }; readonly bots: readonly CollectorV1Bot[]; readonly routines: readonly CollectorV1Routine[]; readonly connectors: readonly CollectorV1Connector[]; readonly tasks: { readonly open: number; readonly stale7d: number; readonly blocked: number }; readonly pages: { readonly count: number; readonly updated7d: number }; readonly visibility: CollectorV1Visibility; readonly evidence: readonly CollectorV1Evidence[] };

export type SendReportV1Timestamp = string;

export type SendReportV1UuidV7 = string;

export type SendReportV1Semver = string;

export type SendReportV1EvidenceId = string;

export type SendReportV1EvidenceIds = readonly SendReportV1EvidenceId[];

export type SendReportV1Finding = { readonly ruleId: string; readonly severity: "low" | "medium" | "high"; readonly evidenceIds: SendReportV1EvidenceIds; readonly summary: string };

export type SendReportV1Recommendation = { readonly id: string; readonly title: string; readonly why: string; readonly evidenceIds: readonly SendReportV1EvidenceId[]; readonly effort: "small" | "medium" | "large" };

export type SendReportV1Evidence = { readonly id: SendReportV1EvidenceId; readonly text: string };

export type SendReportV1VisibilityEntry = { readonly signal: "transcripts" | "usage" | "otherBots" | "auditLog"; readonly seen: boolean; readonly why: string };

export type SendReportV1Visibility = readonly SendReportV1VisibilityEntry[];

export type SendReportV1 = { readonly schemaVersion: 1; readonly reportId: SendReportV1UuidV7; readonly period: { readonly from: SendReportV1Timestamp; readonly to: SendReportV1Timestamp }; readonly summary: string; readonly counts: { readonly bots: number; readonly routines: { readonly active: number; readonly paused: number; readonly failing: number }; readonly connectors: { readonly ok: number; readonly needsAuth: number; readonly error: number }; readonly tasks: { readonly open: number; readonly stale7d: number; readonly blocked: number }; readonly pages: { readonly count: number; readonly updated7d: number } }; readonly findings: readonly SendReportV1Finding[]; readonly recommendations: readonly SendReportV1Recommendation[]; readonly evidence: readonly SendReportV1Evidence[]; readonly visibility: SendReportV1Visibility; readonly moduleVersions: { readonly audit: SendReportV1Semver; readonly [name: string]: SendReportV1Semver } };

export type SendFeedbackV1UuidV7 = string;

export type SendFeedbackV1 = { readonly schemaVersion: 1; readonly feedbackId: SendFeedbackV1UuidV7; readonly reportId?: SendFeedbackV1UuidV7; readonly from: "customer" | "bot"; readonly text: string };
