import type { Rng } from "@ambitious/kit/domain/clock";
import { isBaselineId, isFeedbackId, isReportId, isSnapshotId, type BaselineId, type FeedbackId, type ReportId, type Sha256Hex, type SnapshotId } from "./types.ts";

const HEX = "0123456789abcdef";

export const entropyHex = (rng: Rng): string => {
  let hex = "";
  for (let index = 0; index < 8; index += 1) {
    const bits = Math.floor(rng.next() * 4294967296);
    hex += bits.toString(16).padStart(8, "0");
  }
  return hex;
};

export const uuidV7 = (instantMs: number, entropy: Sha256Hex): string => {
  const time = Math.floor(instantMs).toString(16).padStart(12, "0").slice(-12);
  const variant = HEX[((Number.parseInt(entropy.slice(3, 4), 16) & 0x3) | 0x8) % 16] ?? "8";
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${entropy.slice(0, 3)}-${variant}${entropy.slice(4, 7)}-${entropy.slice(7, 19)}`;
};

const requireUuid = <T extends string>(value: string, accept: (raw: string) => raw is T, label: string): T => {
  if (!accept(value)) throw new Error(`The derived ${label} is not a version 7 UUID.`);
  return value;
};

export const reportIdFrom = (instantMs: number, entropy: Sha256Hex): ReportId => requireUuid(uuidV7(instantMs, entropy), isReportId, "report id");

export const snapshotIdFrom = (instantMs: number, entropy: Sha256Hex): SnapshotId =>
  requireUuid(uuidV7(instantMs, entropy), isSnapshotId, "snapshot id");

export const baselineIdFrom = (instantMs: number, entropy: Sha256Hex): BaselineId =>
  requireUuid(uuidV7(instantMs, entropy), isBaselineId, "baseline id");

export const feedbackIdFrom = (instantMs: number, entropy: Sha256Hex): FeedbackId =>
  requireUuid(uuidV7(instantMs, entropy), isFeedbackId, "feedback id");
