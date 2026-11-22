const phoneNumber = /(?:\p{Decimal_Number}[ ().-]*){6,}\p{Decimal_Number}/u;
const calendarDate = /\b\d{4}-\d{2}-\d{2}(?=T\d{2}:|\b)/gu;
const privateText = [
  /[^\s@]+@[^\s@]+/u,
  /(?:[a-z][a-z0-9+.-]*:\/\/|\b[\w.-]+\.[a-z]{2,}|\/)\S*\?\S+/iu,
  /\b(?:bearer|basic)\s+\S+/iu,
  /\b(?:api[ _-]?key|access[ _-]?token|token|password|secret)\b["'”’]?(?:\s*[:=]\s*|\s+)\S+/iu,
  /(?:^|[^\w])(?:sk[-_]|(?:pk|rk)_(?:live|test)_|(?:tok|token|pat)[_-]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|eyJ)[\w./+=-]{6,}/u,
  /(?:^|[^\w])[a-f\d]{20,}(?!\w)/iu,
  /(?=[\w+/=-]*\d)(?=[\w+/=-]*[a-z])[\w+/=-]{20,}/iu,
  /[a-zA-Z0-9_+=]{32,}/u,
];

// WHY: Replacing the whole field also removes identifying fragments beside the match.
export const reportText = (value: string): string => {
  const normalized = value.normalize("NFKC")
    .replace(/[\p{Dash}\u00ad\u2027\u2043\u30fb]/gu, "-")
    .replace(/[\p{White_Space}\u200b\ufeff]/gu, " ");
  return phoneNumber.test(normalized.replace(calendarDate, " ")) || privateText.some((pattern) => pattern.test(normalized)) ? "[redacted]" : value;
};
