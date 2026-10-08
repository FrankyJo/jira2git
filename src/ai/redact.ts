/**
 * Removes credentials from untrusted text before it reaches the model: diffs, commit
 * subjects, Jira descriptions, user context, and test output. Files that usually hold
 * secrets are excluded from the diff entirely (`isSensitivePath`); this catches secrets
 * that were pasted into ordinary source files.
 *
 * Redaction is best effort and errs towards removing too much. It is a second line of
 * defence: the first is that Git2Jira never reads environment variables, credential
 * stores, or excluded files into model context at all.
 */

export const REDACTED = '[REDACTED]';

interface Rule {
  name: string;
  pattern: RegExp;
  /** Replaces the match; defaults to the whole match → REDACTED. */
  replace?: (match: string, ...groups: string[]) => string;
}

const RULES: readonly Rule[] = [
  {
    name: 'private-key',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
  },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'atlassian-token', pattern: /\bATATT[A-Za-z0-9_=-]{20,}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g },
  { name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe-key', pattern: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@'"`]+):([^\s@/'"`]+)@/gi,
    replace: (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
  },
  {
    name: 'authorization-header',
    pattern: /\b(Authorization\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
  {
    // key = "value", key: 'value', KEY=value, "key": "value"
    name: 'secret-assignment',
    pattern:
      /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["'`]?)([^\s"'`,;]{6,})\2/gi,
    replace: (match: string, prefix: string, quote: string, value: string) =>
      secretValue(prefix, quote, value) ? `${prefix}${quote}${REDACTED}${quote}` : match,
  },
];

/**
 * Whether the value of a `secret = value` assignment is a literal secret rather than
 * code. Quoted literals and `.env`-style lines count; unquoted values only when they
 * look random (letters and digits, long), because they are usually identifiers.
 */
function secretValue(prefix: string, quote: string, value: string): boolean {
  if (
    value.startsWith(REDACTED) ||
    /^(?:process\.env|import\.meta\.env|env\.|\$\{|\$[A-Z_]|<|\{\{|%\()/.test(value) ||
    /^(?:x{3,}|\*{3,}|changeme|example|placeholder|your[-_]?\w*|null|undefined|none|true|false|string|number|required|optional)$/i.test(
      value,
    )
  ) {
    return false;
  }
  if (quote !== '') return true;
  if (/^[A-Z][A-Z0-9_]*\s*=\s*$/.test(prefix.trim().replace(/\s+/g, ''))) return true;
  if (/[().[\]]/.test(value)) return false;
  return value.length >= 12 && /\d/.test(value) && /[A-Za-z]/.test(value);
}

export interface RedactionResult {
  text: string;
  /** Rule names that matched, with counts. Never the secret values. */
  findings: Record<string, number>;
}

export function redactSecrets(text: string): RedactionResult {
  const findings: Record<string, number> = {};
  let result = text;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const replaced = rule.replace ? rule.replace(match, ...groups) : REDACTED;
      if (replaced !== match) findings[rule.name] = (findings[rule.name] ?? 0) + 1;
      return replaced;
    });
  }
  return { text: result, findings };
}

/**
 * Paths whose content must never reach the model, even if committed. Matches the
 * diff engine's secret exclusions plus common credential stores.
 */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|asc)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/]*)?$/i,
  /(?:^|\/)\.(?:npmrc|netrc|pypirc|pgpass|git-credentials|htpasswd)$/i,
  /(?:^|\/)\.aws\/credentials$/i,
  /(?:^|\/)\.docker\/config\.json$/i,
  /(?:^|\/)credentials(?:\.[^/]*)?\.(?:json|ya?ml|xml|ini)$/i,
  /(?:^|\/)secrets?(?:\.[^/]*)?\.(?:json|ya?ml|toml|ini|env)$/i,
  /(?:^|\/)service[-_]?account[^/]*\.json$/i,
  /(?:^|\/)terraform\.tfstate(?:\.backup)?$/i,
  /(?:^|\/)\.terraform\/[^/]+$/i,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** Lock files and generated output: excluded as noise, not because they are secret. */
const NOISE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/,
  /\.min\.(?:js|css)$/,
  /\.map$/,
];

export function isNoisePath(path: string): boolean {
  return NOISE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}
