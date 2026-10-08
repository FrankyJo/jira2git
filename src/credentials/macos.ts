import { SpawnProcessRunner, type ProcessRunner } from '../core/process';
import {
  CredentialStoreError,
  CredentialStoreUnavailableError,
  assertSecretFormat,
  type CredentialReference,
  type CredentialStore,
} from './types';

const SECURITY = '/usr/bin/security';
/** `security` exit status for "item not found". */
const NOT_FOUND = 44;

/**
 * macOS Keychain through `/usr/bin/security`. The secret is never passed on
 * the command line, where other processes could read it: it is written in
 * hex (`-X`) to `security -i` over stdin. Lookups and deletions carry only the
 * service and account names.
 */
export class MacKeychainStore implements CredentialStore {
  readonly backend = 'macos-keychain' as const;

  constructor(
    private readonly runner: ProcessRunner = new SpawnProcessRunner(),
    /** Keychain file; the user's default keychain when omitted. Used by tests. */
    private readonly keychain?: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    const result = await this.runner.run(SECURITY, ['default-keychain'], { timeoutMs: 10_000 });
    return result.exitCode === 0;
  }

  async get(reference: CredentialReference): Promise<string | undefined> {
    const result = await this.security([
      'find-generic-password',
      '-s',
      reference.service,
      '-a',
      reference.account,
      '-w',
      ...this.keychainArgs(),
    ]);
    if (result.exitCode === NOT_FOUND) return undefined;
    if (result.exitCode !== 0) throw this.failure('read', result.stderr);
    return result.stdout.replace(/\n$/, '');
  }

  async set(reference: CredentialReference, secret: string): Promise<void> {
    assertSecretFormat(secret);
    const hex = Buffer.from(secret, 'utf8').toString('hex');
    // Names are restricted to quote-free characters (ACCOUNT_PATTERN), so this line is unambiguous.
    const keychain = this.keychain === undefined ? '' : ` "${this.keychain}"`;
    const command =
      `add-generic-password -U -s "${reference.service}" -a "${reference.account}" ` +
      `-l "Git2Jira (${reference.account})" -X ${hex}${keychain}\n`;
    const result = await this.runner.run(SECURITY, ['-i'], { input: command, timeoutMs: 30_000 });
    if (result.notFound)
      throw new CredentialStoreUnavailableError(this.backend, 'security not found');
    // `security -i` exits 0 even when a command fails, so read the value back.
    if ((await this.get(reference)) !== secret) throw this.failure('store', result.stderr);
  }

  async delete(reference: CredentialReference): Promise<boolean> {
    const result = await this.security([
      'delete-generic-password',
      '-s',
      reference.service,
      '-a',
      reference.account,
      ...this.keychainArgs(),
    ]);
    if (result.exitCode === NOT_FOUND) return false;
    if (result.exitCode !== 0) throw this.failure('delete', result.stderr);
    return true;
  }

  private keychainArgs(): string[] {
    return this.keychain === undefined ? [] : [this.keychain];
  }

  private async security(args: string[]) {
    const result = await this.runner.run(SECURITY, args, { timeoutMs: 30_000 });
    if (result.notFound)
      throw new CredentialStoreUnavailableError(this.backend, 'security not found');
    return result;
  }

  private failure(action: string, stderr: string): CredentialStoreError {
    const detail = stderr.trim().split('\n')[0] ?? '';
    return new CredentialStoreError(
      `Could not ${action} the credential in the macOS Keychain${detail ? ` (${detail})` : ''}.`,
    );
  }
}
