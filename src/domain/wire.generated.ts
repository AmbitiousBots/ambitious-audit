export type CollectorV1Timestamp = string;

export type CollectorV1LastSeen = string | null;

export type CollectorV1Id = string;

export type CollectorV1Usage = { readonly unit: "credits" | "percent"; readonly amount7d: number } | null;

export type CollectorV1BotUsage = { readonly unit: "credits" | "percent"; readonly amount7d: number } | { readonly unit: "share"; readonly period: "this_week" | "last_7_days" | "last_30_days"; readonly periodStart?: CollectorV1Timestamp; readonly periodEnd?: CollectorV1Timestamp; readonly share: number } | null;

export type CollectorV1Bot = { readonly id: CollectorV1Id; readonly name: string; readonly lastActiveAt: CollectorV1LastSeen; readonly routineCount: number | null; readonly usage: CollectorV1BotUsage };

export type CollectorV1Routine = { readonly id: CollectorV1Id; readonly botId: CollectorV1Id; readonly schedule: string; readonly state: "active" | "paused" | "failing"; readonly lastRunAt: CollectorV1LastSeen; readonly pausedAt?: CollectorV1Timestamp; readonly createdAt?: CollectorV1Timestamp; readonly usage: CollectorV1Usage; readonly lastError?: string };

export type CollectorV1Connector = { readonly name: string; readonly status: "ok" | "needsAuth" | "needsGrant" | "initializing" | "error" };

export type CollectorV1VisibilityEntry = { readonly signal: "transcripts" | "usage" | "otherBots" | "auditLog" | "accountRole" | "tasks" | "pages" | "botActivity" | "routines"; readonly seen: boolean; readonly why: string };

export type CollectorV1Visibility = readonly CollectorV1VisibilityEntry[];

export type CollectorV1Evidence = { readonly id: CollectorV1EvidenceId; readonly kind: "excerpt" | "count"; readonly text: string; readonly source: string };

export type CollectorV1EvidenceId = string;

export type CollectorV1 = { readonly schemaVersion: 1; readonly collectedAt: CollectorV1Timestamp; readonly account: { readonly kind: "owner" | "guest" | "team" | "unknown"; readonly label: string }; readonly bots: readonly CollectorV1Bot[]; readonly routines: readonly CollectorV1Routine[]; readonly connectors: readonly CollectorV1Connector[]; readonly tasks: { readonly open: number | null; readonly stale7d: number | null; readonly blocked: number | null }; readonly pages: { readonly count: number | null; readonly updated7d: number | null }; readonly usageOther?: { readonly share: number; readonly botCount?: number }; readonly weeklyLimitUsed?: { readonly percent: number; readonly asOf: CollectorV1Timestamp }; readonly visibility: CollectorV1Visibility; readonly evidence: readonly CollectorV1Evidence[] };

export type CollectorV2Timestamp = string;

export type CollectorV2LastSeen = string | null;

export type CollectorV2Id = string;

export type CollectorV2Usage = { readonly unit: "credits" | "percent"; readonly amount7d: number } | null;

export type CollectorV2BotUsage = { readonly unit: "credits" | "percent"; readonly amount7d: number; readonly period?: never; readonly periodStart?: never; readonly periodEnd?: never; readonly share?: never; readonly shareBelow?: never } | { readonly unit: "share"; readonly amount7d?: never; readonly period: "this_week" | "last_7_days" | "last_30_days"; readonly periodStart?: CollectorV2Timestamp; readonly periodEnd?: CollectorV2Timestamp; readonly share: number; readonly shareBelow?: never } | { readonly unit: "share"; readonly amount7d?: never; readonly period: "this_week" | "last_7_days" | "last_30_days"; readonly periodStart?: CollectorV2Timestamp; readonly periodEnd?: CollectorV2Timestamp; readonly share?: never; readonly shareBelow: number } | null;

export type CollectorV2Bot = { readonly id: CollectorV2Id; readonly name: string; readonly lastActiveAt: CollectorV2LastSeen; readonly routineCount: number | null; readonly usage: CollectorV2BotUsage };

export type CollectorV2Routine = { readonly id: CollectorV2Id; readonly botId: CollectorV2Id; readonly schedule: string; readonly state: "active" | "paused" | "failing"; readonly lastRunAt: CollectorV2LastSeen; readonly pausedAt?: CollectorV2Timestamp; readonly createdAt?: CollectorV2Timestamp; readonly usage: CollectorV2Usage; readonly lastError?: string; readonly runs7d?: number | null; readonly failedRuns7d?: number | null };

export type CollectorV2Connector = { readonly name: string; readonly status: "ok" | "needsAuth" | "needsGrant" | "initializing" | "error" };

export type CollectorV2VisibilityEntry = { readonly signal: "transcripts" | "usage" | "otherBots" | "auditLog" | "accountRole" | "tasks" | "pages" | "botActivity" | "routines"; readonly seen: true | false | "partial"; readonly why?: string; readonly scope?: "all" | "shared_only" | "limited" };

export type CollectorV2Visibility = readonly CollectorV2VisibilityEntry[];

export type CollectorV2Evidence = { readonly id: CollectorV2EvidenceId; readonly kind: "excerpt" | "count"; readonly text?: string; readonly source: string; readonly sourceKind?: "bot" | "routine" | "connector" | "tasks" };

export type CollectorV2EvidenceId = string;

export type CollectorV2 = { readonly schemaVersion: 2; readonly collectedAt: CollectorV2Timestamp; readonly account: { readonly kind: "owner" | "guest" | "team" | "unknown"; readonly label: string }; readonly bots: readonly CollectorV2Bot[]; readonly routines: readonly CollectorV2Routine[]; readonly connectors: readonly CollectorV2Connector[]; readonly tasks: { readonly open: number | null; readonly stale7d: number | null; readonly blocked: number | null; readonly closed7d?: number | null }; readonly pages: { readonly count: number | null; readonly updated7d: number | null }; readonly usageOther?: { readonly share: number; readonly botCount?: number }; readonly weeklyLimitUsed?: { readonly percent: number; readonly asOf: CollectorV2Timestamp }; readonly visibility: CollectorV2Visibility; readonly evidence: readonly CollectorV2Evidence[]; readonly planUsage?: { readonly weeklyLimitUsedPercent: number | null; readonly extraCreditsLeftUsdCents: number | null; readonly observedAt: string | null; readonly period: "this_week" | "last_7_days" | "last_30_days" | null } };

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

export type SendReportV2Timestamp = string;

export type SendReportV2UuidV7 = string;

export type SendReportV2Semver = string;

export type SendReportV2EvidenceId = string;

export type SendReportV2EvidenceIds = readonly SendReportV2EvidenceId[];

export type SendReportV2Finding = { readonly kind: "rule" | "visibility"; readonly ruleId: string; readonly severity: "low" | "medium" | "high"; readonly evidenceIds: SendReportV2EvidenceIds; readonly summary: string; readonly withheld?: "roleUnknown" };

export type SendReportV2Recommendation = { readonly id: string; readonly title: string; readonly why: string; readonly evidenceIds: readonly SendReportV2EvidenceId[]; readonly effort: "small" | "medium" | "large" };

export type SendReportV2Evidence = { readonly id: SendReportV2EvidenceId; readonly text: string; readonly source?: string };

export type SendReportV2VisibilityEntry = { readonly signal: "transcripts" | "usage" | "otherBots" | "auditLog" | "accountRole" | "tasks" | "pages" | "botActivity" | "routines"; readonly seen: boolean; readonly why: string };

export type SendReportV2Visibility = readonly SendReportV2VisibilityEntry[];

export type SendReportV2 = { readonly schemaVersion: 2; readonly reportId: SendReportV2UuidV7; readonly period: { readonly from: SendReportV2Timestamp; readonly to: SendReportV2Timestamp }; readonly accountKind: "owner" | "guest" | "team" | "unknown"; readonly summary: string; readonly counts: { readonly bots: number; readonly routines: { readonly active: number; readonly paused: number; readonly failing: number }; readonly connectors: { readonly ok: number; readonly needsAuth: number; readonly needsGrant: number; readonly initializing: number; readonly error: number }; readonly tasks: { readonly open: number | null; readonly stale7d: number | null; readonly blocked: number | null }; readonly pages: { readonly count: number | null; readonly updated7d: number | null } }; readonly findings: readonly SendReportV2Finding[]; readonly recommendations: readonly SendReportV2Recommendation[]; readonly evidence: readonly SendReportV2Evidence[]; readonly visibility: SendReportV2Visibility; readonly moduleVersions: { readonly audit: SendReportV2Semver; readonly [name: string]: SendReportV2Semver } };

export type SendReportV3Timestamp = string;

export type SendReportV3UuidV7 = string;

export type SendReportV3Semver = string;

export type SendReportV3EvidenceId = string;

export type SendReportV3EvidenceIds = readonly SendReportV3EvidenceId[];

export type SendReportV3Finding = { readonly kind: "rule" | "visibility"; readonly ruleId: string; readonly severity: "low" | "medium" | "high"; readonly evidenceIds: SendReportV3EvidenceIds; readonly summary: string; readonly withheld?: "roleUnknown"; readonly priority: "high" | "low" };

export type SendReportV3Recommendation = { readonly id: string; readonly title: string; readonly why: string; readonly evidenceIds: readonly SendReportV3EvidenceId[]; readonly effort: "small" | "medium" | "large"; readonly priority: "high" | "low" };

export type SendReportV3Evidence = { readonly id: SendReportV3EvidenceId; readonly text: string; readonly source?: string };

export type SendReportV3VisibilityEntry = { readonly signal: "transcripts" | "usage" | "otherBots" | "auditLog" | "accountRole" | "tasks" | "pages" | "botActivity" | "routines"; readonly seen: boolean; readonly why: string };

export type SendReportV3Visibility = readonly SendReportV3VisibilityEntry[];

export type SendReportV3Announcement = { readonly id: string; readonly priority: "high" | "low"; readonly title: string };

export type SendReportV3 = { readonly schemaVersion: 3; readonly reportId: SendReportV3UuidV7; readonly period: { readonly from: SendReportV3Timestamp; readonly to: SendReportV3Timestamp }; readonly accountKind: "owner" | "guest" | "team" | "unknown"; readonly summary: string; readonly counts: { readonly bots: number; readonly routines: { readonly active: number; readonly paused: number; readonly failing: number }; readonly connectors: { readonly ok: number; readonly needsAuth: number; readonly needsGrant: number; readonly initializing: number; readonly error: number }; readonly tasks: { readonly open: number | null; readonly stale7d: number | null; readonly blocked: number | null }; readonly pages: { readonly count: number | null; readonly updated7d: number | null } }; readonly findings: readonly SendReportV3Finding[]; readonly recommendations: readonly SendReportV3Recommendation[]; readonly announcements: readonly SendReportV3Announcement[]; readonly evidence: readonly SendReportV3Evidence[]; readonly visibility: SendReportV3Visibility; readonly moduleVersions: { readonly audit: SendReportV3Semver; readonly [name: string]: SendReportV3Semver } };

export type SendReportV4Timestamp = string;

export type SendReportV4UuidV7 = string;

export type SendReportV4Semver = string;

export type SendReportV4EvidenceId = string;

export type SendReportV4EvidenceIds = readonly SendReportV4EvidenceId[];

export type SendReportV4Finding = { readonly kind: "rule" | "visibility"; readonly ruleId: string; readonly severity: "low" | "medium" | "high"; readonly evidenceIds: SendReportV4EvidenceIds; readonly summary: string; readonly withheld?: "roleUnknown"; readonly priority: "high" | "low" };

export type SendReportV4Recommendation = { readonly id: string; readonly title: string; readonly why: string; readonly evidenceIds: readonly SendReportV4EvidenceId[]; readonly effort: "small" | "medium" | "large"; readonly priority: "high" | "low" };

export type SendReportV4Evidence = { readonly id: SendReportV4EvidenceId; readonly text: string; readonly source?: string };

export type SendReportV4VisibilityEntry = { readonly signal: "transcripts" | "usage" | "otherBots" | "auditLog" | "accountRole" | "tasks" | "pages" | "botActivity" | "routines"; readonly seen: true | false | "partial"; readonly why: string };

export type SendReportV4Visibility = readonly SendReportV4VisibilityEntry[];

export type SendReportV4Announcement = { readonly id: string; readonly priority: "high" | "low"; readonly title: string };

export type SendReportV4Bot = { readonly name: string; readonly usageShare: number; readonly usageShareBelow: null; readonly usagePeriod: "this_week" | "last_7_days" | "last_30_days"; readonly lastActiveAt: string | null; readonly routineCount: number | null; readonly usagePeriodStart?: SendReportV4Timestamp; readonly usagePeriodEnd?: SendReportV4Timestamp; readonly nameWithheld?: true } | { readonly name: string; readonly usageShare: null; readonly usageShareBelow: number; readonly usagePeriod: "this_week" | "last_7_days" | "last_30_days"; readonly lastActiveAt: string | null; readonly routineCount: number | null; readonly usagePeriodStart?: SendReportV4Timestamp; readonly usagePeriodEnd?: SendReportV4Timestamp; readonly nameWithheld?: true } | { readonly name: string; readonly usageShare: null; readonly usageShareBelow: null; readonly usagePeriod: null; readonly lastActiveAt: string | null; readonly routineCount: number | null; readonly usagePeriodStart?: never; readonly usagePeriodEnd?: never; readonly nameWithheld?: true };

export type SendReportV4Connector = { readonly name: string; readonly status: "ok" | "needsAuth" | "needsGrant" | "initializing" | "error"; readonly nameWithheld?: true };

export type SendReportV4 = { readonly schemaVersion: 4; readonly reportId: SendReportV4UuidV7; readonly period: { readonly from: SendReportV4Timestamp; readonly to: SendReportV4Timestamp }; readonly accountKind: "owner" | "guest" | "team" | "unknown"; readonly summary: string; readonly counts: { readonly bots: number; readonly routines: { readonly active: number | null; readonly paused: number | null; readonly failing: number | null; readonly runs7d: number | null; readonly failedRuns7d: number | null }; readonly connectors: { readonly ok: number; readonly needsAuth: number; readonly needsGrant: number; readonly initializing: number; readonly error: number }; readonly tasks: { readonly open: number | null; readonly stale7d: number | null; readonly blocked: number | null; readonly closed7d: number | null }; readonly pages: { readonly count: number | null; readonly updated7d: number | null } }; readonly findings: readonly SendReportV4Finding[]; readonly recommendations: readonly SendReportV4Recommendation[]; readonly announcements: readonly SendReportV4Announcement[]; readonly evidence: readonly SendReportV4Evidence[]; readonly visibility: SendReportV4Visibility; readonly moduleVersions: { readonly audit: SendReportV4Semver; readonly [name: string]: SendReportV4Semver }; readonly bots: readonly SendReportV4Bot[]; readonly connectors: readonly SendReportV4Connector[]; readonly truncated?: true; readonly planUsage: { readonly weeklyLimitUsedPercent: number | null; readonly extraCreditsLeftUsd: number | null; readonly observedAt: string | null; readonly period: "this_week" | "last_7_days" | "last_30_days" | null } | null };

export type SendFeedbackV1UuidV7 = string;

export type SendFeedbackV1 = { readonly schemaVersion: 1; readonly feedbackId: SendFeedbackV1UuidV7; readonly reportId?: SendFeedbackV1UuidV7; readonly from: "customer" | "bot"; readonly text: string };
