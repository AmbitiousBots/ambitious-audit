import { WIRE_LIMITS } from "./types.ts";

const allowedCharacters = /^[\p{L}0-9 &'().,-]+$/u;
const credentialWord = /^(?:token|secret|password|passwd|pwd|bearer|otp|apikey|privatekey|auth|authorization|credentials?|session|sk|pat)$/iu;

const allowedText = (value: string, field: "name" | "observation"): string | null => {
  const text = value.normalize("NFKC");
  if ([...text].length > (field === "name" ? WIRE_LIMITS.reportNameCharacters : WIRE_LIMITS.reportObservationCharacters) || !allowedCharacters.test(text) || !/[\p{L}0-9]/u.test(text)) return null;
  const words = text.match(/[\p{L}0-9]+/gu) ?? [];
  const labels = text.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
  if (labels.match(/\p{L}+/gu)?.some((word) => credentialWord.test(word)) ||
      /(?:^|[^\p{L}])(?:api|private)[ -]+key(?!\p{L})|(?:^|[^\p{L}])key[ ().,'-]*\d/iu.test(labels)) return null;

  for (const [index, word] of words.entries()) {
    const next = words[index + 1];
    if (/^(?:basic|digest)$/iu.test(word) && next && !/^\p{Lu}\p{Ll}+$/u.test(next)) return null;
  }
  if (field === "name") {
    if ((text.match(/\d/gu)?.length ?? 0) > 4 || /\d{3}/u.test(text)) return null;
    if (words.some((word) => /\d/u.test(word) && /\p{Lu}/u.test(word) && !/\p{Ll}/u.test(word))) return null;
  } else if (/\d{5}|\d[ ().,'-]+\d|[\p{L}-]\d|\d[\p{L}-]/u.test(text)) return null;
  return text;
};

export const reportObservation = (value: string): string | null => allowedText(value, "observation");

export const reportName = (value: string, kind: "Bot" | "Connector", index: number) => {
  const name = allowedText(value, "name");
  return name === null ? { name: `${kind} ${index + 1}`, nameWithheld: true as const } : { name };
};
