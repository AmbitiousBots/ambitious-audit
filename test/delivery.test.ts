import assert from "node:assert/strict";
import { test } from "node:test";
import { seededRng } from "@ambitious/kit/domain/clock";
import { applyMark, DELIVERY_POLICY, nextDeliveryStep } from "../src/domain/delivery.ts";
import type { Report, Timestamp } from "../src/domain/types.ts";
import { isReportId, isSha256Hex, isSnapshotId, isTimestamp } from "../src/domain/types.ts";

const take = <T extends string>(value: string, accept: (raw: string) => raw is T, label: string): T => {
  if (!accept(value)) throw new Error(label);
  return value;
};

const reportId = take("018f0000-0000-7000-8000-000000000001", isReportId, "report id");
const snapshotId = take("018f0000-0000-7000-8000-000000000002", isSnapshotId, "snapshot id");
const updatedAt = take("2026-11-15T00:00:00.000Z", isTimestamp, "time");
const payloadSha256 = take("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", isSha256Hex, "sha");

const fresh = (reviewRequired: boolean): Report => ({
  reportId,
  snapshotId,
  state: "built",
  reviewRequired,
  failures: 0,
  payloadSha256,
  updatedAt,
});

const at = (stamp: Timestamp) => ({ reportId, at: stamp });

test("a required review blocks sending until the report is reviewed", () => {
  const built = fresh(true);
  assert.equal(nextDeliveryStep(built, DELIVERY_POLICY).kind, "waitForReview");
  assert.equal(applyMark(built, { ...at(updatedAt), state: "sent" }, DELIVERY_POLICY).ok, false);
  const reviewed = applyMark(built, { ...at(updatedAt), state: "reviewed" }, DELIVERY_POLICY);
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  assert.equal(nextDeliveryStep(reviewed.value, DELIVERY_POLICY).kind, "send");
  const sent = applyMark(reviewed.value, { ...at(updatedAt), state: "sent" }, DELIVERY_POLICY);
  assert.equal(sent.ok && sent.value.state, "sent");
});

test("a report that does not need review can be sent once, and a failed report stops at the attempt limit", () => {
  const sent = applyMark(fresh(false), { ...at(updatedAt), state: "sent" }, DELIVERY_POLICY);
  assert.equal(sent.ok && sent.value.state, "sent");
  if (!sent.ok) return;
  assert.equal(applyMark(sent.value, { ...at(updatedAt), state: "sent" }, DELIVERY_POLICY).ok, false);
  let report = fresh(false);
  for (let attempt = 0; attempt < DELIVERY_POLICY.maxAttempts; attempt += 1) {
    const failed = applyMark(report, { ...at(updatedAt), state: "failed" }, DELIVERY_POLICY);
    assert.equal(failed.ok, true);
    if (!failed.ok) return;
    report = failed.value;
  }
  assert.deepEqual(nextDeliveryStep(report, DELIVERY_POLICY), { kind: "gaveUp", reportId, failures: DELIVERY_POLICY.maxAttempts });
  assert.equal(applyMark(report, { ...at(updatedAt), state: "failed" }, DELIVERY_POLICY).ok, false);
  assert.equal(applyMark(report, { ...at(updatedAt), state: "sent" }, DELIVERY_POLICY).ok, false);
});

test("random send and fail orders still store one id, wait for a required review, and finish", () => {
  for (let seed = 0; seed < 40; seed += 1) {
    for (const reviewRequired of [true, false]) {
      const rng = seededRng(seed);
      let report = fresh(reviewRequired);
      let stored = false;
      for (let step = 0; step < 12; step += 1) {
        const next = nextDeliveryStep(report, DELIVERY_POLICY);
        assert.equal(report.reportId, reportId);
        assert.ok(report.failures <= DELIVERY_POLICY.maxAttempts);
        if (next.kind === "waitForReview") {
          assert.equal(stored, false);
          const reviewed = applyMark(report, { ...at(updatedAt), state: "reviewed" }, DELIVERY_POLICY);
          assert.equal(reviewed.ok, true);
          if (!reviewed.ok) return;
          report = reviewed.value;
        } else if (next.kind === "send") {
          assert.equal(reviewRequired && report.state === "built", false);
          if (rng.int(2) === 0) {
            const failed = applyMark(report, { ...at(updatedAt), state: "failed" }, DELIVERY_POLICY);
            assert.equal(failed.ok, true);
            if (!failed.ok) return;
            report = failed.value;
          } else {
            stored = true;
            const marked = applyMark(report, { ...at(updatedAt), state: "sent" }, DELIVERY_POLICY);
            assert.equal(marked.ok, true);
            if (!marked.ok) return;
            report = marked.value;
          }
        } else if (next.kind === "confirm") {
          assert.equal(stored, true);
          const acked = applyMark(report, { ...at(updatedAt), state: "acked" }, DELIVERY_POLICY);
          assert.equal(acked.ok, true);
          if (!acked.ok) return;
          report = acked.value;
        } else {
          if (next.kind === "gaveUp") assert.equal(report.failures, DELIVERY_POLICY.maxAttempts);
          if (report.state === "acked") assert.equal(stored, true);
          break;
        }
      }
      assert.ok(report.state === "acked" || (report.state === "failed" && report.failures === DELIVERY_POLICY.maxAttempts));
    }
  }
});
