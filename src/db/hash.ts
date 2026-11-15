import { createHash } from "node:crypto";
import { isSha256Hex, type Sha256Hex } from "../domain/types.ts";

export const sha256Hex = (text: string): Sha256Hex => {
  const hex = createHash("sha256").update(text).digest("hex");
  if (!isSha256Hex(hex)) throw new Error("SHA-256 did not return 64 hex characters.");
  return hex;
};
