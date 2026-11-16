import type {
  CollectorV1,
  CollectorV1VisibilityEntry,
  SendFeedbackV1,
  SendReportV1,
  SendReportV2,
  SendReportV3,
  SendReportV3Announcement,
  SendReportV3Finding,
  SendReportV3Recommendation,
} from "./wire.generated.js";

declare const brand: unique symbol;

type Brand<Base, Name extends string> = Base & { readonly [brand]: Name };

export type SnapshotId = Brand<string, "SnapshotId">;
export type BaselineId = Brand<string, "BaselineId">;
export type ReportId = Brand<string, "ReportId">;
export type FeedbackId = Brand<string, "FeedbackId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type RuleId = Brand<string, "RuleId">;
export type RecommendationId = Brand<string, "RecommendationId">;
export type Fingerprint = Brand<string, "Fingerprint">;
export type Sha256Hex = Brand<string, "Sha256Hex">;
export type Timestamp = Brand<string, "Timestamp">;
export type SemVer = Brand<string, "SemVer">;

export const WIRE_PATTERNS = {
  uuidV7: /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  evidenceId: /^ev-[1-9][0-9]{0,5}$/,
  ruleId: /^[a-z][a-z0-9-]*$/,
  recommendationId: /^[a-z0-9][a-z0-9-]*$/,
  announcementId: /^[a-z0-9][a-z0-9-]{0,63}$/,
  timestamp: /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?Z$/,
  semver: /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/,
} as const;

export const WIRE_LIMITS = {
  summaryCharacters: 1200,
  evidenceTextCharacters: 280,
  feedbackTextCharacters: 4000,
  recommendations: 3,
  announcements: 10,
  announcementTitleCharacters: 120,
} as const;

export const isReportId = (raw: string): raw is ReportId => WIRE_PATTERNS.uuidV7.test(raw);
export const isSnapshotId = (raw: string): raw is SnapshotId => WIRE_PATTERNS.uuidV7.test(raw);
export const isBaselineId = (raw: string): raw is BaselineId => WIRE_PATTERNS.uuidV7.test(raw);
export const isFingerprint = (raw: string): raw is Fingerprint => raw.length > 0 && raw.length <= 500;
export const isFeedbackId = (raw: string): raw is FeedbackId => WIRE_PATTERNS.uuidV7.test(raw);
export const isEvidenceId = (raw: string): raw is EvidenceId => WIRE_PATTERNS.evidenceId.test(raw);
export const isRuleId = (raw: string): raw is RuleId => raw.length <= 64 && WIRE_PATTERNS.ruleId.test(raw);
export const isRecommendationId = (raw: string): raw is RecommendationId =>
  raw.length <= 64 && WIRE_PATTERNS.recommendationId.test(raw);
export const isTimestamp = (raw: string): raw is Timestamp => WIRE_PATTERNS.timestamp.test(raw);
export const isSemVer = (raw: string): raw is SemVer => raw.length <= 64 && WIRE_PATTERNS.semver.test(raw);
export const isSha256Hex = (raw: string): raw is Sha256Hex => /^[0-9a-f]{64}$/.test(raw);

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type CollectorInput = CollectorV1;

export type VisibilitySignal = CollectorV1VisibilityEntry["signal"];
export type VisibilityEntry = CollectorV1VisibilityEntry;
export type VisibilityMap = readonly VisibilityEntry[];

export const VISIBILITY_SIGNALS = ["transcripts", "usage", "otherBots", "auditLog", "accountRole", "tasks", "pages", "botActivity", "routines"] as const satisfies readonly VisibilitySignal[];

export type AccountKind = CollectorV1["account"]["kind"];
export type AuditMode = "full" | "partial";

export const auditModeOf = (snapshot: CollectorInput): AuditMode => (snapshot.account.kind === "unknown" ? "partial" : "full");

export type Severity = SendReportV3Finding["severity"];
export type Priority = SendReportV3Finding["priority"];
export type Announcement = SendReportV3Announcement;
export type Effort = SendReportV3Recommendation["effort"];
export type FeedbackSender = SendFeedbackV1["from"];

export type EvidenceIds = readonly EvidenceId[];
export type CitedEvidenceIds = readonly [EvidenceId, ...EvidenceId[]];

export type Snapshot = {
  readonly id: SnapshotId;
  readonly collectedAt: Timestamp;
  readonly normalized: CollectorInput;
};

export type Baseline = {
  readonly id: BaselineId;
  readonly snapshotId: SnapshotId;
  readonly setAt: Timestamp;
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type Change = {
  readonly path: string;
  readonly before: JsonValue | null;
  readonly after: JsonValue | null;
};

export type Finding = {
  readonly kind: SendReportV3Finding["kind"];
  readonly ruleId: RuleId;
  readonly severity: Severity;
  readonly priority: Priority;
  readonly evidenceIds: EvidenceIds;
  readonly summary: string;
  readonly withheld?: "roleUnknown";
};

export type Recommendation = {
  readonly id: RecommendationId;
  readonly priority: Priority;
  readonly title: string;
  readonly why: string;
  readonly evidenceIds: CitedEvidenceIds;
  readonly effort: Effort;
};

export type StoredRecommendation = {
  readonly snapshotId: SnapshotId;
  readonly recommendation: Recommendation;
  readonly fingerprint: Fingerprint;
};

export type Recommendations =
  | readonly []
  | readonly [Recommendation]
  | readonly [Recommendation, Recommendation]
  | readonly [Recommendation, Recommendation, Recommendation];

export type Suppression = {
  readonly fingerprint: Fingerprint;
  readonly until: Timestamp;
};

export type ReportEvidence = {
  readonly id: EvidenceId;
  readonly text: string;
  readonly source?: string;
};

export type SendReportPayload = {
  readonly schemaVersion: 3;
  readonly reportId: ReportId;
  readonly period: { readonly from: Timestamp; readonly to: Timestamp };
  readonly accountKind: AccountKind;
  readonly summary: string;
  readonly counts: SendReportV3["counts"];
  readonly findings: readonly Finding[];
  readonly recommendations: Recommendations;
  readonly announcements: readonly Announcement[];
  readonly evidence: readonly ReportEvidence[];
  readonly visibility: VisibilityMap;
  readonly moduleVersions: { readonly audit: SemVer; readonly [module: string]: SemVer };
};

export type SendFeedbackPayload = {
  readonly schemaVersion: 1;
  readonly feedbackId: FeedbackId;
  readonly reportId?: ReportId;
  readonly from: FeedbackSender;
  readonly text: string;
};

export type StoredReportPayload = SendReportPayload | SendReportV1 | SendReportV2;

export const sendReportWire = (payload: SendReportPayload): SendReportV3 => payload;

export const sendFeedbackWire = (payload: SendFeedbackPayload): SendFeedbackV1 => payload;

export const REPORT_STATES = ["built", "reviewed", "sent", "acked", "failed"] as const;
export const MARKABLE_STATES = ["reviewed", "sent", "acked", "failed"] as const;

export type ReportState = (typeof REPORT_STATES)[number];
export type MarkableState = (typeof MARKABLE_STATES)[number];

export type MarkAllowedFrom = {
  readonly reviewed: "built";
  readonly sent: "built" | "reviewed" | "failed";
  readonly failed: "built" | "reviewed" | "failed";
  readonly acked: "sent";
};

export type ReportTransition = {
  readonly [To in MarkableState]: { readonly from: MarkAllowedFrom[To]; readonly to: To };
}[MarkableState];

export type Report = {
  readonly reportId: ReportId;
  readonly snapshotId: SnapshotId;
  readonly state: ReportState;
  readonly reviewRequired: boolean;
  readonly failures: number;
  readonly payloadSha256: Sha256Hex;
  readonly updatedAt: Timestamp;
};

export type ReportEvent = {
  readonly seq: number;
  readonly reportId: ReportId;
  readonly state: ReportState;
  readonly at: Timestamp;
};

export type ReportMark = {
  readonly reportId: ReportId;
  readonly state: MarkableState;
  readonly at: Timestamp;
};

export type DeliveryPolicy = {
  readonly maxAttempts: number;
};

export type DeliveryStep =
  | { readonly kind: "waitForReview"; readonly reportId: ReportId }
  | { readonly kind: "send"; readonly reportId: ReportId; readonly attempt: number }
  | { readonly kind: "confirm"; readonly reportId: ReportId }
  | { readonly kind: "delivered"; readonly reportId: ReportId }
  | { readonly kind: "gaveUp"; readonly reportId: ReportId; readonly failures: number };

export type MarkError =
  | { readonly code: "E_REPORT_NOT_FOUND"; readonly reportId: ReportId }
  | { readonly code: "E_TRANSITION"; readonly from: ReportState; readonly to: MarkableState }
  | { readonly code: "E_REVIEW_REQUIRED"; readonly reportId: ReportId }
  | { readonly code: "E_ATTEMPTS_EXHAUSTED"; readonly failures: number; readonly maxAttempts: number };

export type NextDeliveryStep = (report: Report, policy: DeliveryPolicy) => DeliveryStep;

export type ApplyMark = (report: Report, mark: ReportMark, policy: DeliveryPolicy) => Result<Report, MarkError>;

export type DeriveReportId = (snapshotId: SnapshotId, seed: number) => ReportId;

export type SnapshotOutput = { readonly snapshotId: SnapshotId; readonly normalized: CollectorInput };
export type BaselineSetInput = { readonly snapshotId: SnapshotId };
export type BaselineSetOutput = { readonly baselineId: BaselineId };
export type DiffInput = { readonly from?: BaselineId; readonly to: SnapshotId };
export type DiffOutput = { readonly changes: readonly Change[] };
export type FindingsInput = { readonly snapshotId: SnapshotId };
export type FindingsOutput = { readonly mode: AuditMode; readonly findings: readonly Finding[] };
export type RecommendInput = { readonly snapshotId: SnapshotId };
export type RecommendOutput = { readonly mode: AuditMode; readonly recommendations: Recommendations; readonly withheld: readonly RuleId[] };
export type ReportBuildInput = { readonly snapshotId: SnapshotId; readonly reviewRequired: boolean; readonly announcements?: readonly Announcement[] };
export type ReportBuildOutput = { readonly reportId: ReportId; readonly payload: StoredReportPayload };
export type ReportMarkOutput = { readonly report: Report };
export type ReportMarkInput = { readonly reportId: ReportId; readonly state: MarkableState; readonly at: Timestamp };
export type FeedbackBuildInput = { readonly reportId?: ReportId; readonly text: string; readonly from: FeedbackSender };
export type FeedbackBuildOutput = { readonly payload: SendFeedbackPayload };
