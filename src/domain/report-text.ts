const privateText = [
  /[^\s@]+@[^\s@]+/u,
  /(?:[a-z][a-z0-9+.-]*:\/\/|\b[\w.-]+\.[a-z]{2,}|\/)\S*\?\S+/iu,
  /(?:^|[^\w])(?:sk[-_]|(?:pk|rk)_(?:live|test)_|(?:tok|token|pat)[_-]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|eyJ)[\w./+=-]{6,}/u,
  /(?:^|[^\w])[a-f\d]{20,}(?!\w)/iu,
  /(?=[\w+/=-]*\d)(?=[\w+/=-]*[a-z])[\w+/=-]{20,}/iu,
  /[a-zA-Z0-9_+=]{32,}/u,
];

const isCredentialKey = (name: string): boolean =>
  /secret|token|password|passwd|pwd|auth|credential|apikey|session|cookie|bearer|privatekey/iu.test(name.replace(/[ _-]/gu, ""));
const authScheme = /^(?:basic|bearer|digest|token)$/iu;
const base64Credential = (value: string): boolean => {
  if (!/^[a-z\d+/]+={0,2}$/iu.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  const unpadded = (encoded: string) => encoded.replace(/=+$/u, "");
  return unpadded(decoded.toString("base64")) === unpadded(value) &&
    (/[+/=]/u.test(value) || /^[\x20-\x7e]+$/u.test(decoded.toString("latin1")));
};

const credentialShaped = (value: string): boolean =>
  value.length >= 16 || (/\d/u.test(value) && /[a-z]/u.test(value) && /[A-Z]/u.test(value)) ||
  /^(?:[\da-f]{8,}|[\da-f]*\d[\da-f]+)$/iu.test(value) ||
  base64Credential(value) || /^[\w-]+\.[\w-]+\.[\w-]+$/u.test(value);

const hasCredential = (text: string): boolean => {
  const joined = text.replace(/(api|private)[ _-]+key/giu, "$1key");
  for (const [, quoted, bare] of joined.matchAll(/(?:"([^"]+)"|([^\s"=:,;?&{}]+))\s*[:=]\s*(?=\S)/gu)) {
    if (isCredentialKey(quoted ?? bare ?? "")) return true;
  }
  for (const { 0: word, index } of joined.matchAll(/[\p{L}\p{N}_.\[\]-]+/gu)) {
    const scheme = authScheme.test(word);
    const key = isCredentialKey(word);
    if (!key && !scheme) continue;
    const tail = joined.slice(index + word.length);
    const value = /^"*\s+"*(\S+)/u.exec(tail)?.[1];
    if (!value) continue;
    if (key && (!scheme || tail.startsWith('"'))) return true;
    const token = value.split(/[",;}&\]]/u, 1)[0];
    if (token && credentialShaped(token)) return true;
  }
  return false;
};

const hasPhone = (text: string): boolean => {
  for (const { 0: run } of text.matchAll(/\p{Nd}[\p{Nd} ()./+⁄∕·-]*/gu)) {
    const digits = [...run.matchAll(/\p{Nd}/gu)];
    if (digits.some((digit, i) => {
      const first = digits[i - 6];
      return first !== undefined && digit.index - first.index < 40;
    })) return true;
  }
  return false;
};

// WHY: Replacing the whole field also removes identifying fragments beside the match.
export const reportText = (value: string): string => {
  const normalized = value.normalize("NFKC")
    .replace(/[\p{Dash}\u00ad\u2027\u2043\u30fb]/gu, "-")
    .replace(/[\p{White_Space}\u200b\ufeff]/gu, " ")
    .replace(/[\p{Quotation_Mark}\x60]/gu, '"');
  return hasCredential(normalized) || hasPhone(normalized) || privateText.some((pattern) => pattern.test(normalized)) ? "[redacted]" : value;
};
