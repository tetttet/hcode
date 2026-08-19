const GITHUB_TOKEN_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
] as const;

export function redactGithubSecrets(value: string, secrets: Array<string | undefined> = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  for (const pattern of GITHUB_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted
    .replace(
      /(GITHUB_(?:PERSONAL_ACCESS_)?TOKEN\s*[:=]\s*)[^\s,"']+/gi,
      "$1[REDACTED]",
    );
}

export function containsGithubToken(value: string): boolean {
  return GITHUB_TOKEN_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }) || /GITHUB_(?:PERSONAL_ACCESS_)?TOKEN\s*[:=]\s*[^\s,"']+/i.test(value);
}
