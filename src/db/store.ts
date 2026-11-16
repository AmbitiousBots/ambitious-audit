import type { Db } from "@ambitious/kit/db/open-db";
import type { Clock, Rng } from "@ambitious/kit/domain/clock";
import { failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import { canonicalJson } from "../domain/canonical.ts";
import { applyMark, DELIVERY_POLICY, nextDeliveryStep } from "../domain/delivery.ts";
import { diffJson } from "../domain/diff.ts";
import { asJsonValue } from "../domain/json-value.ts";
import { assembleReport, capRecommendations, deriveReportId, findingsFrom, payloadSha256, recommendationsFrom, ruleFinding, withheldRules } from "../domain/report.ts";
import { RULES, SUPPRESSION_DAYS } from "../domain/rule-pack.ts";
import { evaluateRules } from "../domain/rules.ts";
import { collectorProblems, isCollectorDocument, isReportPayload, isReportV1Payload, isReportV2Payload } from "../domain/schema.ts";
import { addDays, formatTimestamp, parseTimestamp } from "../domain/time.ts";
import type {
  BaselineId,
  BaselineSetInput,
  CollectorInput,
  DeliveryStep,
  DiffInput,
  Fingerprint,
  FindingsInput,
  FindingsOutput,
  MarkError,
  RecommendInput,
  RecommendOutput,
  Report,
  ReportBuildInput,
  ReportId,
  ReportMarkInput,
  StoredReportPayload,
  Sha256Hex,
  SnapshotId,
  Timestamp,
} from "../domain/types.ts";
import { auditModeOf, isFingerprint, isReportId, isSha256Hex, isSnapshotId, isTimestamp, REPORT_STATES, type ReportState } from "../domain/types.ts";
import { baselineIdFrom, entropyHex, snapshotIdFrom } from "../domain/uuid.ts";

type Digest = (text: string) => Sha256Hex;

type StoredReport = Report & { readonly fingerprints: readonly Fingerprint[]; readonly payloadJson: string };

const rowOf = (value: unknown): Readonly<Record<string, unknown>> | null => (isRecord(value) ? value : null);

const parseStored = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw failure("E_DB", "A stored JSON value could not be read.", "Run selfcheck and read data.problems.");
  }
};

const isState = (value: string): value is ReportState => REPORT_STATES.some((state) => state === value);

const storedTime = (value: string): Timestamp => {
  if (!isTimestamp(value)) throw failure("E_DB", "A stored timestamp is not UTC.", "Run selfcheck and read data.problems.");
  return value;
};

const notFoundSnapshot = (id: string): never => {
  throw failure("E_NOT_FOUND", `No snapshot has id ${id}.`, "Run snapshot and use the snapshotId it returns.", { snapshotId: id });
};

const readSnapshot = (db: Db, id: SnapshotId): CollectorInput => {
  const row = rowOf(db.prepare("SELECT json FROM snapshots WHERE id = ?").get(id));
  const json = row === null ? undefined : row.json;
  if (typeof json !== "string") return notFoundSnapshot(id);
  const parsed = parseStored(json);
  if (!isCollectorDocument(parsed)) {
    throw failure(
      "E_SNAPSHOT_FORMAT",
      `The snapshot ${id} was stored in a form this version does not read.`,
      "Collect the account again, run snapshot, and use the new snapshotId. Set a new baseline if this snapshot was the baseline.",
      { snapshotId: id, fields: collectorProblems(parsed).slice(0, 50).map((problem) => ({ pointer: problem.pointer, rule: problem.rule })) },
    );
  }
  return parsed;
};

const readBaselineSnapshot = (db: Db, id: BaselineId): SnapshotId => {
  const row = rowOf(db.prepare("SELECT snapshot_id FROM baselines WHERE id = ?").get(id));
  const snapshotId = row === null ? undefined : row.snapshot_id;
  if (typeof snapshotId !== "string" || !isSnapshotId(snapshotId)) {
    throw failure("E_NOT_FOUND", `No baseline has id ${id}.`, "Run baseline set and use the baselineId it returns.", { baselineId: id });
  }
  return snapshotId;
};

const latestBaselineSnapshot = (db: Db): SnapshotId | null => {
  const row = rowOf(db.prepare("SELECT snapshot_id FROM baselines ORDER BY set_at DESC, id DESC LIMIT 1").get());
  const snapshotId = row === null ? undefined : row.snapshot_id;
  if (typeof snapshotId !== "string") return null;
  if (!isSnapshotId(snapshotId)) throw failure("E_DB", "The latest baseline does not point at a snapshot id.", "Run selfcheck and read data.problems.");
  return snapshotId;
};

const suppressedFingerprints = (db: Db, nowMs: number): ReadonlySet<string> => {
  const active = new Set<string>();
  for (const value of db.prepare("SELECT fingerprint, until FROM suppressions").all()) {
    const row = rowOf(value);
    const fingerprint = row === null ? undefined : row.fingerprint;
    const until = row === null ? undefined : row.until;
    if (typeof fingerprint !== "string" || typeof until !== "string") continue;
    const untilMs = parseTimestamp(until);
    if (untilMs !== null && nowMs < untilMs) active.add(fingerprint);
  }
  return active;
};

const fingerprintsOf = (text: string): readonly Fingerprint[] => {
  const parsed = parseStored(text);
  if (!Array.isArray(parsed)) throw failure("E_DB", "A report's recommendation fingerprints could not be read.", "Run selfcheck and read data.problems.");
  const fingerprints: Fingerprint[] = [];
  for (const item of parsed) {
    if (typeof item !== "string" || !isFingerprint(item)) {
      throw failure("E_DB", "A report's recommendation fingerprints could not be read.", "Run selfcheck and read data.problems.");
    }
    fingerprints.push(item);
  }
  return fingerprints;
};

const reportFrom = (row: Readonly<Record<string, unknown>>): StoredReport => {
  const reportId = row.report_id;
  const snapshotId = row.snapshot_id;
  const state = row.state;
  const reviewRequired = row.review_required;
  const failures = row.failures;
  const payloadJson = row.payload_json;
  const payloadSha256 = row.payload_sha256;
  const fingerprintsJson = row.fingerprints_json;
  const updatedAt = row.updated_at;
  if (typeof reportId !== "string" || !isReportId(reportId) || typeof snapshotId !== "string" || !isSnapshotId(snapshotId) || typeof state !== "string" || !isState(state)) {
    throw failure("E_DB", "A stored report is missing its id or state.", "Run selfcheck and read data.problems.");
  }
  if (typeof payloadJson !== "string" || typeof payloadSha256 !== "string" || !isSha256Hex(payloadSha256) || typeof fingerprintsJson !== "string" || typeof updatedAt !== "string") {
    throw failure("E_DB", "A stored report is missing its payload.", "Run selfcheck and read data.problems.");
  }
  if ((reviewRequired !== 0 && reviewRequired !== 1) || typeof failures !== "number" || !Number.isInteger(failures) || failures < 0) {
    throw failure("E_DB", "A stored report has a review flag or failure count that is not valid.", "Run selfcheck and read data.problems.");
  }
  return {
    reportId,
    snapshotId,
    state,
    reviewRequired: reviewRequired === 1,
    failures,
    payloadSha256,
    updatedAt: storedTime(updatedAt),
    fingerprints: fingerprintsOf(fingerprintsJson),
    payloadJson,
  };
};

const readReport = (db: Db, id: ReportId): StoredReport | null => {
  const row = rowOf(
    db.prepare("SELECT report_id, snapshot_id, state, review_required, failures, payload_json, payload_sha256, fingerprints_json, updated_at FROM reports WHERE report_id = ?").get(id),
  );
  return row === null ? null : reportFrom(row);
};

const payloadOf = (text: string): StoredReportPayload => {
  const parsed = parseStored(text);
  if (!isReportPayload(parsed) && !isReportV2Payload(parsed) && !isReportV1Payload(parsed)) throw failure("E_DB", "A stored report payload does not match the report schema.", "Run selfcheck and read data.problems.");
  return parsed;
};

const shown = (report: Report): Report => ({
  reportId: report.reportId,
  snapshotId: report.snapshotId,
  state: report.state,
  reviewRequired: report.reviewRequired,
  failures: report.failures,
  payloadSha256: report.payloadSha256,
  updatedAt: report.updatedAt,
});

const rememberRows = (db: Db, snapshotId: SnapshotId, hits: ReturnType<typeof evaluateRules>, ranked: ReturnType<typeof recommendationsFrom>): void => {
  db.prepare("DELETE FROM findings WHERE snapshot_id = ?").run(snapshotId);
  db.prepare("DELETE FROM recommendations WHERE snapshot_id = ?").run(snapshotId);
  const insertFinding = db.prepare("INSERT INTO findings (snapshot_id, rule_id, json) VALUES (?, ?, ?)");
  const insertRecommendation = db.prepare("INSERT INTO recommendations (id, snapshot_id, json, fingerprint) VALUES (?, ?, ?, ?)");
  for (const item of hits) insertFinding.run(snapshotId, item.rule.id, JSON.stringify(ruleFinding(item)));
  for (const item of ranked) insertRecommendation.run(item.recommendation.id, snapshotId, JSON.stringify(item.recommendation), item.fingerprint);
};

const markError = (error: MarkError): never => {
  if (error.code === "E_TRANSITION") {
    throw failure("E_TRANSITION", `A report in state ${error.from} cannot be marked ${error.to}.`, "Mark it with a state this report can move to.", { from: error.from, to: error.to });
  }
  if (error.code === "E_REVIEW_REQUIRED") {
    throw failure("E_REVIEW_REQUIRED", "This report has to be reviewed before it can be sent.", "Mark it reviewed, then mark it sent.", { reportId: error.reportId });
  }
  if (error.code === "E_ATTEMPTS_EXHAUSTED") {
    throw failure(
      "E_ATTEMPTS_EXHAUSTED",
      `This report has already failed ${error.failures} times, which is the limit of ${error.maxAttempts}.`,
      "Leave it failed. Build a new report when there is something new to send.",
      { failures: error.failures, maxAttempts: error.maxAttempts },
    );
  }
  throw failure("E_REPORT_NOT_FOUND", `No report has id ${error.reportId}.`, "Build the report first, then mark that report id.", { reportId: error.reportId });
};

const suppress = (db: Db, fingerprints: readonly Fingerprint[], at: Timestamp): void => {
  const atMs = parseTimestamp(at);
  if (atMs === null) throw failure("E_INPUT_SCHEMA", 'The input field "at" must be a UTC timestamp.', "Use YYYY-MM-DDTHH:MM:SSZ, with optional milliseconds.");
  const until = formatTimestamp(addDays(atMs, SUPPRESSION_DAYS));
  const upsert = db.prepare(
    "INSERT INTO suppressions (fingerprint, until) VALUES (?, ?) ON CONFLICT(fingerprint) DO UPDATE SET until = excluded.until WHERE excluded.until > suppressions.until",
  );
  for (const fingerprint of fingerprints) upsert.run(fingerprint, until);
};

export const putSnapshot = (db: Db, input: CollectorInput, clock: Clock, rng: Rng, digest: Digest): { readonly snapshotId: SnapshotId; readonly normalized: CollectorInput } => {
  const id = snapshotIdFrom(clock.now().getTime(), digest(`${canonicalJson(input)}:${entropyHex(rng)}`));
  const existing = rowOf(db.prepare("SELECT json FROM snapshots WHERE id = ?").get(id));
  const stored = existing === null ? undefined : existing.json;
  if (typeof stored === "string") {
    if (stored !== canonicalJson(input)) throw failure("E_INTERNAL", "The same snapshot id was stored with different contents.", "Report it with the stderr log.");
    return { snapshotId: id, normalized: readSnapshot(db, id) };
  }
  db.prepare("INSERT INTO snapshots (id, collected_at, json) VALUES (?, ?, ?)").run(id, input.collectedAt, canonicalJson(input));
  return { snapshotId: id, normalized: input };
};

export const putBaseline = (db: Db, input: BaselineSetInput, clock: Clock, rng: Rng, digest: Digest): { readonly baselineId: BaselineId } => {
  const snapshotId = input.snapshotId;
  readSnapshot(db, snapshotId);
  const id = baselineIdFrom(clock.now().getTime(), digest(`${snapshotId}:${entropyHex(rng)}`));
  if (rowOf(db.prepare("SELECT id FROM baselines WHERE id = ?").get(id)) === null) {
    db.prepare("INSERT INTO baselines (id, snapshot_id, set_at) VALUES (?, ?, ?)").run(id, snapshotId, formatTimestamp(clock.now().getTime()));
  }
  return { baselineId: id };
};

export const readDiff = (db: Db, input: DiffInput): { readonly changes: ReturnType<typeof diffJson> } => {
  const to = input.to;
  const fromSnapshot = input.from === undefined ? latestBaselineSnapshot(db) : readBaselineSnapshot(db, input.from);
  if (fromSnapshot === null) throw failure("E_NO_BASELINE", "No baseline is set, and diff was not given a from id.", "Run baseline set, or pass from.", {});
  return { changes: diffJson(asJsonValue(readSnapshot(db, fromSnapshot)), asJsonValue(readSnapshot(db, to))) };
};

export const readFindings = (db: Db, input: FindingsInput): FindingsOutput => {
  const snapshot = readSnapshot(db, input.snapshotId);
  return { mode: auditModeOf(snapshot), findings: findingsFrom(snapshot, evaluateRules(snapshot, RULES)) };
};

export const readRecommendations = (db: Db, input: RecommendInput, clock: Clock): RecommendOutput => {
  const snapshot = readSnapshot(db, input.snapshotId);
  const hits = evaluateRules(snapshot, RULES);
  const ranked = recommendationsFrom(hits, suppressedFingerprints(db, clock.now().getTime()));
  return { mode: auditModeOf(snapshot), recommendations: capRecommendations(ranked.map((item) => item.recommendation)), withheld: withheldRules(hits) };
};

export const buildStoredReport = (
  db: Db,
  input: ReportBuildInput,
  clock: Clock,
  rng: Rng,
  digest: Digest,
  version: string,
): { readonly reportId: ReportId; readonly payload: StoredReportPayload; readonly next: DeliveryStep } => {
  const { snapshotId, reviewRequired } = input;
  const snapshot = readSnapshot(db, snapshotId);
  const nowMs = clock.now().getTime();
  const reportId = deriveReportId(snapshotId, rng, nowMs, digest);
  const existing = readReport(db, reportId);
  if (existing !== null) {
    if (existing.reviewRequired === reviewRequired) return { reportId, payload: payloadOf(existing.payloadJson), next: nextDeliveryStep(existing, DELIVERY_POLICY) };
    if (existing.state === "built" && reviewRequired && !existing.reviewRequired) {
      db.prepare("UPDATE reports SET review_required = 1 WHERE report_id = ?").run(existing.reportId);
      const upgraded = { ...existing, reviewRequired: true };
      return { reportId, payload: payloadOf(existing.payloadJson), next: nextDeliveryStep(upgraded, DELIVERY_POLICY) };
    }
    throw failure(
      "E_REVIEW_REQUIRED",
      "This report was already built with a different review requirement.",
      "Use the same reviewRequired, or ask for a review while the report is still built.",
      { reportId, reviewRequired: existing.reviewRequired },
    );
  }
  const hits = evaluateRules(snapshot, RULES);
  const assembled = assembleReport(snapshot, hits, suppressedFingerprints(db, nowMs), reportId, version, input.announcements);
  const payloadJson = canonicalJson(assembled.payload);
  const report: Report = {
    reportId,
    snapshotId,
    state: "built",
    reviewRequired,
    failures: 0,
    payloadSha256: payloadSha256(assembled.payload, digest),
    updatedAt: formatTimestamp(nowMs),
  };
  rememberRows(db, snapshotId, hits, assembled.ranked);
  db.prepare(
    "INSERT INTO reports (report_id, snapshot_id, state, review_required, failures, payload_json, payload_sha256, fingerprints_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(report.reportId, report.snapshotId, report.state, reviewRequired ? 1 : 0, report.failures, payloadJson, report.payloadSha256, JSON.stringify(assembled.ranked.map((item) => item.fingerprint)), report.updatedAt);
  db.prepare("INSERT INTO report_events (report_id, state, at) VALUES (?, ?, ?)").run(report.reportId, report.state, report.updatedAt);
  return { reportId, payload: payloadOf(payloadJson), next: nextDeliveryStep(report, DELIVERY_POLICY) };
};

export const markStoredReport = (db: Db, mark: ReportMarkInput): { readonly report: Report; readonly next: DeliveryStep } => {
  const existing = readReport(db, mark.reportId);
  if (existing === null) throw failure("E_REPORT_NOT_FOUND", `No report has id ${mark.reportId}.`, "Build the report first, then mark that report id.", { reportId: mark.reportId });
  const applied = applyMark(existing, mark, DELIVERY_POLICY);
  if (!applied.ok) return markError(applied.error);
  const next = applied.value;
  db.prepare("UPDATE reports SET state = ?, failures = ?, updated_at = ? WHERE report_id = ?").run(next.state, next.failures, next.updatedAt, next.reportId);
  db.prepare("INSERT INTO report_events (report_id, state, at) VALUES (?, ?, ?)").run(next.reportId, next.state, next.updatedAt);
  if (next.state === "sent" && existing.state !== "sent") suppress(db, existing.fingerprints, next.updatedAt);
  return { report: shown(next), next: nextDeliveryStep(next, DELIVERY_POLICY) };
};
