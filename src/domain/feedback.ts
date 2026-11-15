import type { Rng } from "@ambitious/kit/domain/clock";
import type { FeedbackBuildOutput, ReportId, Sha256Hex } from "./types.ts";
import { isFeedbackPayload } from "./schema.ts";
import { entropyHex, feedbackIdFrom } from "./uuid.ts";

export const assembleFeedback = (
  input: { readonly reportId?: ReportId; readonly text: string; readonly from: "customer" | "bot" },
  rng: Rng,
  instantMs: number,
  digest: (text: string) => Sha256Hex,
): FeedbackBuildOutput => {
  const payload = {
    schemaVersion: 1 as const,
    feedbackId: feedbackIdFrom(instantMs, digest(`${input.from}\n${input.reportId ?? ""}\n${input.text}:${entropyHex(rng)}`)),
    from: input.from,
    text: input.text,
    ...(input.reportId === undefined ? {} : { reportId: input.reportId }),
  };
  if (!isFeedbackPayload(payload)) throw new Error("The feedback payload does not match send_feedback.");
  return { payload };
};
