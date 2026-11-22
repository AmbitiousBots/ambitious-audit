const allowedName = /^(?:\p{L}\p{M}*|[0-9 &',-])+$/u;
const credentialWord = /^(?:token|secret|password|passwd|pwd|bearer|otp|pin|key|code|apikey|privatekey|auth|authorization|credentials?|session|sk|pat|glpat)$/iu;

const displayName = (value: string): string | null => {
  const name = value.normalize("NFKC").replaceAll("’", "'");
  if ([...name].length > 40 || !allowedName.test(name) || !/\p{L}/u.test(name)) return null;
  if ((name.match(/[0-9]/gu)?.length ?? 0) > 2) return null;
  const words = name.match(/[\p{L}\p{M}0-9]+/gu) ?? [];
  if (words.length > 5 || words.some((word) => (word.match(/\p{L}/gu)?.length ?? 0) > 16)) return null;

  const labels = name.normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
  if (labels.match(/\p{L}+/gu)?.some((word) => credentialWord.test(word))) return null;
  for (const [index, word] of words.entries()) {
    if (/\d/u.test(word) && /\p{Lu}/u.test(word) && !/\p{Ll}/u.test(word)) return null;
    const next = words[index + 1];
    if (/^(?:basic|digest)$/iu.test(word) && next && !/^\p{Lu}\p{Ll}+$/u.test(next)) return null;
  }
  return name;
};

export const reportName = (value: string, kind: "Bot" | "Connector", index: number) => {
  const name = displayName(value);
  return name === null ? { name: `${kind} ${index + 1}`, nameWithheld: true as const } : { name };
};
