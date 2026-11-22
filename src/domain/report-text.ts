const allowedName = /^(?:\p{L}\p{M}*|[0-9 &',-])+$/u;
const credentialWord = /^(?:token|secret|password|passwd|pwd|bearer|otp|pin|key|code|apikey|privatekey|auth|authorization|credentials?|session|sk|pat|glpat)$/iu;
const authScheme = /^(?:basic|bearer|digest|token)$/iu;

const encodedCredential = (word: string, afterScheme: boolean): boolean => {
  // WHY: The display-name alphabet already excludes base64 padding, plus and slash.
  if (word.length < (afterScheme ? 2 : 8) || word.length % 4 === 1 || !/^[A-Za-z0-9]+$/u.test(word)) return false;
  const decoded = atob(word);
  return decoded.includes(":") && !/[^\x20-\x7e]/u.test(decoded);
};

const spellsAddress = (words: readonly string[]): boolean => {
  const at = words.findIndex((word) => /^at$/iu.test(word));
  const dot = words.findIndex((word) => /^dot$/iu.test(word));
  if (at < 0 || dot < 0) return false;
  return Math.abs(at - dot) > 1 || Math.max(at, dot) < words.length - 1;
};

const displayName = (value: string): string | null => {
  const name = value.normalize("NFKC").replaceAll("’", "'");
  if ([...name].length > 40 || !allowedName.test(name) || !/\p{L}/u.test(name)) return null;
  if ((name.match(/[0-9]/gu)?.length ?? 0) > 2) return null;
  const words = name.match(/[\p{L}\p{M}0-9]+/gu) ?? [];
  if (words.length > 5 || words.some((word) => (word.match(/\p{L}/gu)?.length ?? 0) > 16)) return null;
  if (words.some((word, i) => encodedCredential(word, authScheme.test(words[i - 1] ?? ""))) || spellsAddress(words)) return null;

  const nameWithoutSchemes = name.replace(/(^| )(?:bearer|token)(?= +[\p{L}0-9])/giu, "$1");
  const labels = nameWithoutSchemes.normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
  if (labels.match(/\p{L}+/gu)?.some((word) => credentialWord.test(word))) return null;
  for (const [index, word] of words.entries()) {
    if (/\d/u.test(word) && /\p{Lu}/u.test(word) && !/\p{Ll}/u.test(word)) {
      if (index !== 0 || word.length > 3 || !/^[A-Z]*[0-9][A-Z]*$/u.test(word)) return null;
    }
  }
  return name;
};

export const reportName = (value: string, kind: "Bot" | "Connector", index: number) => {
  const name = displayName(value);
  return name === null ? { name: `${kind} ${index + 1}`, nameWithheld: true as const } : { name };
};
