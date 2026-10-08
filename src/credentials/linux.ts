import { SpawnProcessRunner, type ProcessRunner } from '../core/process';
import {
  CredentialStoreError,
  CredentialStoreUnavailableError,
  assertSecretFormat,
  type CredentialReference,
  type CredentialStore,
} from './types';

const SECRET_TOOL = 'secret-tool';

/**
 * Secret Service API (GNOME Keyring, KWallet, KeePassXC) through libsecret's
 * `secret-tool`. `store` reads the secret from stdin, so it never appears in
 * the process list. Without a D-Bus session or `secret-tool`, the store is
 * unavailable: there is no plaintext fallback.
 */
export class SecretServiceStore implements CredentialStore {
  readonly backend = 'secret-service' as const;

  constructor(
    private readonly runner: ProcessRunner = new SpawnProcessRunner(),
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  async isAvailable(): Promise<boolean> {
    if (!this.env.DBUS_SESSION_BUS_ADDRESS) return false;
    // A lookup of a key that does not exist exits 1 when the service works.
    const result = await this.runner.run(
      SECRET_TOOL,
      ['lookup', 'service', 'git2jira-ai', 'account', '__probe__'],
      { timeoutMs: 10_000 },
    );
    return !result.notFound && !result.timedOut && (result.exitCode === 0 || result.exitCode === 1);
  }

  async get(reference: CredentialReference): Promise<string | undefined> {
    const result = await this.tool(['lookup', ...attributes(reference)]);
    if (result.exitCode === 0) return result.stdout.replace(/\n$/, '') || undefined;
    // secret-tool exits 1 with empty stderr when nothing matches.
    if (result.exitCode === 1 && result.stderr.trim() === '') return undefined;
    throw this.failure('read', result.stderr);
  }

  async set(reference: CredentialReference, secret: string): Promise<void> {
    assertSecretFormat(secret);
    const result = await this.tool(
      ['store', `--label=Git2Jira (${reference.account})`, ...attributes(reference)],
      secret,
    );
    if (result.exitCode !== 0) throw this.failure('store', result.stderr);
    if ((await this.get(reference)) !== secret) throw this.failure('verify', '');
  }

  async delete(reference: CredentialReference): Promise<boolean> {
    if ((await this.get(reference)) === undefined) return false;
    const result = await this.tool(['clear', ...attributes(reference)]);
    if (result.exitCode !== 0) throw this.failure('delete', result.stderr);
    return true;
  }

  private async tool(args: string[], input?: string) {
    if (!this.env.DBUS_SESSION_BUS_ADDRESS) {
      throw new CredentialStoreUnavailableError(this.backend, 'no D-Bus session');
    }
    const result = await this.runner.run(SECRET_TOOL, args, {
      timeoutMs: 30_000,
      ...(input === undefined ? {} : { input }),
    });
    if (result.notFound) {
      throw new CredentialStoreUnavailableError(
        this.backend,
        'secret-tool (libsecret-tools) is not installed',
      );
    }
    if (result.timedOut)
      throw new CredentialStoreUnavailableError(this.backend, 'secret-tool timed out');
    return result;
  }

  private failure(action: string, stderr: string): CredentialStoreError {
    const detail = stderr.trim().split('\n')[0] ?? '';
    return new CredentialStoreError(
      `Could not ${action} the credential in the Secret Service${detail ? ` (${detail})` : ''}.`,
    );
  }
}

function attributes(reference: CredentialReference): string[] {
  return ['service', reference.service, 'account', reference.account];
}
