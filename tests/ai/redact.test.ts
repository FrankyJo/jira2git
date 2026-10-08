import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitivePath, redactSecrets } from '../../src/ai/redact';

// Fake credentials are assembled at runtime so no secret-shaped literal sits in the repo.
const j = (...parts: string[]) => parts.join('');
const FAKE = {
  aws: j('AKIA', 'IOSFODNN7', 'EXAMPLE'),
  github: j('ghp', '_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
  atlassian: j('ATA', 'TT3xFfGF0', 'abcdefghijklmnopqrstuvwxyz0123'),
  anthropic: j('sk-', 'ant-', 'api03-abcdefghijklmnop'),
  slack: j('xo', 'xb-', '1234567890-abcdefghij'),
  password: j('hunter2', 'hunter2'),
  envValue: j('Sup3r', 'S3cret', 'Value'),
  urlPass: j('s3cr3t', 'pass'),
  bearer: j('abcdef', '1234567890', 'abcdef'),
};

describe('secret redaction', () => {
  it.each([
    ['AWS key', `const id = "${FAKE.aws}";`, FAKE.aws],
    ['GitHub token', `token: ${FAKE.github}`, FAKE.github],
    ['Atlassian token', FAKE.atlassian, FAKE.atlassian],
    ['Anthropic key', `ANTHROPIC_API_KEY=${FAKE.anthropic}`, FAKE.anthropic],
    ['Slack token', FAKE.slack, FAKE.slack],
    ['quoted password', `const password = '${FAKE.password}';`, FAKE.password],
    ['env line', `DB_PASSWORD=${FAKE.envValue}`, FAKE.envValue],
    ['URL credentials', `postgres://admin:${FAKE.urlPass}@db.internal:5432/app`, FAKE.urlPass],
    ['bearer header', `Authorization: Bearer ${FAKE.bearer}`, FAKE.bearer],
  ])('removes a %s', (_name, input, secret) => {
    const { text, findings } = redactSecrets(input);
    expect(text).toContain(REDACTED);
    expect(text).not.toContain(secret);
    expect(Object.keys(findings).length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it('removes private key blocks entirely', () => {
    const begin = j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----');
    const end = j('-----END OPENSSH ', 'PRIVATE KEY-----');
    expect(redactSecrets(`before\n${begin}\nAAAAB3Nza\n${end}\nafter`).text).toBe(
      `before\n${REDACTED}\nafter`,
    );
  });

  it('keeps code that only refers to secrets', () => {
    const code = [
      'const token = process.env.API_TOKEN;',
      'const password = form.values.password;',
      'apiKey: config.apiKey,',
      'const secretName = getSecretName(user);',
      "password: 'changeme'",
    ].join('\n');
    expect(redactSecrets(code).text).toBe(code);
  });

  it('recognizes files that must never be analyzed', () => {
    for (const p of [
      '.env',
      'config/.env.production',
      'certs/server.key',
      'deploy/id_rsa',
      '.npmrc',
      'k8s/secrets.yaml',
      'gcp/service-account-prod.json',
      'terraform.tfstate',
    ]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
    for (const p of ['src/env.ts', 'src/keyboard.ts', 'docs/secrets-handling.md']) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});
